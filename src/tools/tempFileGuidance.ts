/**
 * tempFileGuidance.ts - the standing instruction that keeps scratch files out
 * of the places the user owns.
 *
 * WHY THIS EXISTS. Models routinely create scratch files - intermediate
 * output, a log they only need while solving the current task - and they
 * write them where the tools they were given point by default: the AGENT
 * WORKING DIRECTORY, which starts at the user's HOME DIRECTORY
 * (`src/tools/workingDirectory.ts`), or the project the user is working in.
 * Both of those places belong to the user, and a stray file there shows up
 * as an untracked entry in `git status`: the user then has to guess which of
 * the files in their tree are theirs and which are the agent's.
 *
 * WHY THE WORDING IS WHAT IT IS. The first draft of this paragraph was
 * reviewed and SEVEN WORDING DEFECTS were found in it; each is fixed below,
 * and each fix is a fact about the runtime, not a matter of taste.
 * (1) It says "the agent working directory or the user's project", because
 * "agent working directory" is Locopilot's own term
 * (`src/tools/workingDirectory.ts`) and its DEFAULT IS THE USER'S HOME
 * DIRECTORY (`workingDirectory.ts:24-25`), not a project - so a rule that
 * forbade only "the project directory" named a place that does not exist in
 * the model's world and would not cover where files actually land by
 * default.
 * (2) It gives `$TMPDIR`, or `/tmp` when it is UNSET. `TMPDIR` is commonly
 * unset, so `echo $TMPDIR` prints nothing and "usually `/tmp`" was a claim
 * about the majority case rather than about the host in front of the model.
 * (3) It gives `$env:TEMP` (PowerShell) OR `%TEMP%` (cmd). Locopilot's
 * default Windows shell is PowerShell (`defaultShell()`, defined in
 * `src/tools/impl/runCommandTool.ts` and re-exported from
 * `src/tools/tools.ts`), where `%TEMP%` is a bare literal; the repo already
 * teaches the platform-correct form elsewhere ("`Get-Date` on PowerShell,
 * `date` elsewhere" in the sub-agent prompt).
 * (4) It asks the model for NO shell command to discover the temp directory.
 * The earlier "ask the environment if you are unsure (`echo $TMPDIR` /
 * `echo %TEMP%`)" was shell-wrong on Locopilot's own shells; the variable
 * NAMES are now given directly instead.
 * (5) It contains NO literal Windows temp path. `<` and `>` are illegal in
 * Windows file names, and on Linux `path.resolve`
 * (`workingDirectory.ts:43-48`) would turn `C:\Users\<you>\...` into a
 * literal junk file INSIDE the working directory - littering the very place
 * the rule protects.
 * (6) It tells the model to create the subdirectory with `write_file`, not
 * with `mktemp -d`: `mktemp` is neither a PowerShell nor a cmd cmdlet, and
 * `run_command` is APPROVAL-GATED while `write_file` is not, so a shell
 * call would cost the user a click per scratch file.
 * (7) It no longer calls generated files "artifacts". "Generated artefact"
 * made a generated logo referenced by an HTML file look temporary, which
 * would move a DELIVERABLE into the temp directory. The rule is now about
 * what the file is FOR: a file the project must keep - anything that will be
 * referenced, imported or committed, or that the user asked for - stays put,
 * even if the model generated it.
 * The paragraph also forbids touching Locopilot's own command-output files,
 * because the `run_command` tool prompt already says that "a large output is
 * kept in a file under the temporary directory"
 * (`src/tools/impl/runCommandTool.ts:768`), so the model may believe the
 * temp directory is its own area to write in - it is swept after 24 hours -
 * and may move or delete Locopilot's artefacts. And it asks the model to
 * REPORT the absolute path of anything it leaves in the temp directory:
 * temp is ephemeral, and a file the user was never told about is a file the
 * user cannot find.
 *
 * WHAT THIS IS NOT. The guidance is ADVISORY. `write_file` is not confined
 * to the working directory - it writes wherever it is told - and
 * `run_command` can `cd` anywhere, so nothing here is enforced by the
 * tooling; a model that ignores the instruction can still litter. This
 * module deliberately does not attempt to enforce anything: it only makes
 * the instruction visible to both prompt surfaces, in one place, so the
 * wording cannot drift.
 *
 * WHY IT IS A SEPARATE LEAF MODULE. The main chat prompt (built by
 * `createSystemPrompt` in `src/services/chatSession.ts`) and the sub-agent
 * prompt (built by `buildSubAgentSystemPrompt` in
 * `src/tools/impl/subAgentTool.ts`) are SEPARATE prompt strings that must
 * carry the SAME instruction. Copying the paragraph into both would let the
 * two copies drift apart - and a drifted instruction means the main agent and
 * its sub-agents are told different rules about where scratch files go. This
 * module therefore exports ONE constant and both prompts interpolate it. It
 * imports NOTHING, so neither prompt builder can create an import cycle
 * through it (`src/tools/tools.ts` imports from `./impl/*`, and
 * `src/tools/impl/subAgentTool.ts` imports a TYPE from `@/tools/tools`).
 *
 * WHY IT IS STATIC. The wording names the environment variables (`$TMPDIR`,
 * `$env:TEMP`, `%TEMP%`) rather than the host's RESOLVED temp path. A
 * resolved path (`/tmp`, `C:\Users\me\AppData\Local\Temp`) is
 * host-specific, so baking it into the prompt would make the prompt differ
 * from machine to machine - and the system prompt is the most cache-
 * sensitive part of a request (see `tests/prompt-cache-stability.test.mjs`).
 * It would also be wrong on the next machine. Naming the variable keeps the
 * prompt byte-stable across hosts and lets the model discover the real value
 * for itself.
 */

/**
 * The instruction, verbatim, as a SINGLE paragraph.
 *
 * Keep it a single paragraph and keep it byte-stable: it is a static constant
 * and is interpolated into both prompts unchanged. The test script
 * `tests/temp-file-guidance.test.mjs` pins the exact bytes with a SHA-256
 * digest, so any edit to this string has to be a DELIBERATE one.
 */
export const TEMP_FILE_GUIDANCE =
  "Scratch files: put anything temporary you create — intermediate output, logs you only need for this task — in the operating system's temporary directory, never in the agent working directory or the user's project; stray files there pollute their git status. On Linux/macOS that is `$TMPDIR`, or `/tmp` when it is unset; on Windows it is `$env:TEMP` (PowerShell) or `%TEMP%` (cmd). Create one uniquely-named subdirectory inside it (write_file can create it — no shell command needed) and write everything there, using absolute paths. A file the project must keep — anything you will reference, import or commit, or the user asked for — stays put, even if you generated it. Never write into, move or delete Locopilot's own command-output files. If you leave anything in the temporary directory, give the user its absolute path and say it may be cleaned up.";
