import type { ToolSchema } from '../../tools/tools';

import { discoverSkills, getEnabledSkills, loadSkillState } from '../../services/skillManager';

export const subAgentToolSchema: ToolSchema = {
  name: 'run_subagents',
  description:
    'YOUR MOST POWERFUL TOOL. Sub-agents multiply what you can accomplish within a single context window. Every web search, file read, and command output burns tokens in your context. Sub-agents absorb that cost: they do the heavy work in isolation and return only the final answer — often saving thousands of tokens. USE SUB-AGENTS PROACTIVELY. You do NOT need the user to ask. They are your default tool for: • ANY task involving multiple tool calls (search → read → compare → decide) • Researching topics, comparing approaches, or auditing code • File edits and code changes (isolated from your thinking context) • Any information-dense work where intermediate results would clutter your reasoning • Breaking large requests into parallel research streams. Each sub-agent runs its own full tool-calling loop and returns only the final summary. Constraints: sequential; each sees only its own prompt (include ALL context inline); sub-agents cannot spawn further sub-agents. Write prompts as if the sub-agent has no prior context.',
  parameters: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'A short identifier for this sub-agent, used to label its output in logs and results (e.g. "research", "edit-auth", "summarise-logs").',
            },
            prompt: {
              type: 'string',
              description:
                'A fully self-contained task prompt for this sub-agent. Include all file paths, background context, goals, and constraints — the sub-agent cannot see the parent conversation history.',
            },
          },
          required: ['id', 'prompt'],
        },
        description:
          'One or more sub-agents to run sequentially. Each one needs a short id and a fully self-contained prompt.',
      },
    },
    required: ['agents'],
  },
};

import { AUTO_COMPACT_THRESHOLD_PCT } from '../../constants';
import { compactHistory } from '../../services/compact';
import {
  type ChatMessage,
  sendLlmChat,
  type ToolCall,
  type ToolDefinition,
} from '../../services/llm';
import { sanitizeChatMessage } from '../../services/textUtils';
import { countMessagesTokens, countTextTokens } from '../../services/tokenizer';
import { noopToolOutputSink, type ToolOutputSink } from '../toolOutput';
import {
  type IToolCommand,
  type RequestContext,
  type SubAgentConfig,
  type ToolCallArguments,
  type ToolCallResult,
  toolRegistry,
} from '../toolRegistry';
import { WorkingDirectoryScope } from '../workingDirectory';

function isInterruptOrAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

interface SubAgentSpec {
  id?: string;
  prompt?: string;
}

interface SubAgentToolArgs extends ToolCallArguments {
  agents?: SubAgentSpec[];
}

interface CompletedSubAgent {
  id: string;
  content: string;
}

const SUB_AGENT_AUTO_COMPACT_NOTICE =
  'The conversation history was automatically compacted due to context length. ' +
  'The original orchestrator request has been preserved verbatim above. ' +
  'Please continue working on that request without asking for confirmation.';

function buildSubAgentSystemPrompt(skillInfo?: string): string {
  const dateTimeStr = new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  let prompt =
    'You are a focused sub-agent running inside Locopilot.\n' +
    `Current date and time: ${dateTimeStr}\n\n` +
    'You are isolated from the parent conversation. The parent agent will provide all required context in the user message.\n' +
    'Use the available tools when they materially help complete the task.\n' +
    'Work autonomously until the task is complete.\n' +
    'When you are done, return one final concise, self-contained summary for the parent agent.\n' +
    'Do not ask the parent agent for missing context; instead, explain briefly what is missing if the task is blocked.\n' +
    'Do not mention internal chain-of-thought.\n';

  if (skillInfo) {
    prompt +=
      `\n## Inherited Skills\n` +
      `The following skills from the parent conversation are active:\n${ 
      skillInfo 
      }\n`;
  }

  return prompt;
}

function prefixLines(message: string, prefix: string): string[] {
  return message.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function makeLabeledSink(baseSink: ToolOutputSink, id: string): ToolOutputSink {
  const prefix = `[sub-agent: ${id}] `;

  return {
    writeLine(message: string): void {
      for (const line of prefixLines(message, prefix)) {
        baseSink.writeLine(line);
      }
    },
    writeInline(): void {
      // Suppress nested live updates to avoid noisy overlapping spinners.
    },
    clearInline(): void {
      // Suppress nested live updates to avoid noisy overlapping spinners.
    },
  };
}

async function autoCompactSubAgentIfNeeded(
  messages: ChatMessage[],
  config: SubAgentConfig,
  output: ToolOutputSink,
  agentId: string,
  orchestratorPrompt: ChatMessage,
  signal?: AbortSignal
): Promise<boolean> {
  if (config.numCtx <= 0) {
    return false;
  }

  // ── Guard: don't compact until there is enough history ───────────────────
  // When a sub-agent has only system + orchestrator prompt + a single
  // assistant response (or fewer), splitHistoryForCompaction can produce an
  // empty messagesToSummarise array because the sliding-window preservation
  // logic consumes everything after the latest user message (which sits at
  // index 0 of historyMessages).  The anchor-rescue fallback then has nothing
  // to put into messagesToSummarise, so the downstream estimate can collapse
  // to a tiny value and yield the cryptic error:
  //   "The conversation history is too short to compact (~0 tokens)."
  //
  // MIN_SUMMARISE_TOKENS is 200, so a short sub-agent history (which is
  // structurally different from the main chat because it starts with a single
  // user prompt and builds assistant/tool turns from there) will always trip
  // the guard and abort.  Rather than letting it reach compactHistory and
  // crash, we bail early here.  A sub-agent needs at least system + user +
  // assistant + one tool result (4 messages total) before compaction is
  // meaningful and the split logic has enough material to work with.
  //
  // See also the matching guard in app/api/chat/route.ts and the fallback
  // in services/compact.ts (anchorIndex === 0 branch).
  // ──────────────────────────────────────────────────────────────────────────
  if (messages.length < 4) {
    return false;
  }

  const tokensUsed = countMessagesTokens(messages, config.model);
  const pct = (tokensUsed / config.numCtx) * 100;
  if (pct < AUTO_COMPACT_THRESHOLD_PCT) {
    return false;
  }

  const labeledOutput = makeLabeledSink(output, agentId);
  labeledOutput.writeLine(
    `⚡ Context at ${pct.toFixed(0)}% — auto-compacting before continuing...`
  );

  try {
    const result = await compactHistory(
      config.baseUrl,
      config.compactionModel,
      messages,
      config.numCtx,
      undefined,
      1,
      2,
      undefined,
      signal
    );

    // After compaction, ensure the original orchestrator prompt is at position 1.
    // The compaction may have preserved/summarized it, but we want the EXACT
    // original prompt so the sub-agent doesn't lose its instructions.
    if (result.newMessages.length > 1 && result.newMessages[1]!.role === 'user') {
      result.newMessages[1] = orchestratorPrompt;
    } else {
      result.newMessages.splice(1, 0, orchestratorPrompt);
    }

    messages.splice(0, messages.length, ...result.newMessages);
    messages.push({
      role: 'user',
      content: SUB_AGENT_AUTO_COMPACT_NOTICE,
    });

    if (result.stats.newTokenCount > config.numCtx) {
      labeledOutput.writeLine(
        `⚠ Compaction reduced context but history is still over the model limit ` +
          `(${result.stats.newTokenCount}/${config.numCtx} tokens). The next turn may fail.`
      );
    }

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    labeledOutput.writeLine(`⚠ Auto-compaction failed: ${message}`);
    return false;
  }
}

function validateAgentSpecs(agents: SubAgentSpec[] | undefined): string | null {
  if (!Array.isArray(agents) || agents.length === 0) {
    return '[Error: missing required argument "agents"]';
  }

  for (const [index, agent] of agents.entries()) {
    if (!agent || typeof agent !== 'object') {
      return `[Error: invalid agent at index ${index} (expected an object)]`;
    }
    if (typeof agent.id !== 'string' || agent.id.trim().length === 0) {
      return `[Error: invalid agent at index ${index} (missing non-empty string "id")]`;
    }
    if (typeof agent.prompt !== 'string' || agent.prompt.trim().length === 0) {
      return `[Error: invalid agent at index ${index} (missing non-empty string "prompt")]`;
    }
  }

  return null;
}

function formatCombinedResults(results: CompletedSubAgent[], interrupted: boolean): string {
  const sections = results.map((result) => {
    const content =
      result.content.trim().length > 0
        ? result.content.trim()
        : '[Sub-agent completed without a final text response.]';

    return [`sub_agent: ${result.id}`, 'final_response:', content].join('\n');
  });

  if (sections.length === 0) {
    sections.push('[run_subagents completed without any sub-agent results.]');
  }

  if (interrupted) {
    sections.push('[run_subagents interrupted by user.]');
  }

  return sections.join('\n\n---\n\n');
}

async function executeNestedToolCall(
  agentId: string,
  toolCall: ToolCall,
  output: ToolOutputSink,
  onProgress?: (message: string) => void,
  context?: RequestContext,
  signal?: AbortSignal,
  /**
   * Phase 3.4 — sub-agent-local mcpApprovals ledger. Seeded from the
   * parent's `context.mcpApprovals` at the start of `runSingleAgent`
   * and mutated whenever the sub-agent's approval UX grants a
   * namespaced tool (via `decision.grantedTools`). Kept separate
   * from the parent's per-turn set so the sub-agent's pre-approvals
   * don't leak into the parent's `mcpApprovalsSet` and vice versa
   * (the parent still has its own per-turn ledger that other
   * sub-agents running later may pick up via the `RequestContext`
   * shared on the call to `run_subagents`).
   */
  subAgentMcpApprovals?: Set<string>
): Promise<ToolCallResult> {
  const toolName = toolCall.function.name;
  const nestedProgress = onProgress
    ? (message: string) => onProgress(`Sub-agent ${agentId}: ${message}`)
    : undefined;

  if (toolName === 'run_subagents') {
    return { content: '[Error: run_subagents is unavailable inside sub-agents.]' };
  }

  const command = toolRegistry.get(toolName);
  if (!command) {
    return { content: `[Unknown tool: ${toolName}]` };
  }

  // Phase 2 (sub-agent approval UX): if the sub-agent's parent route
  // provided an `approvalRequester` hook, surface the request to the
  // main agent's UI before the tool runs. This keeps sub-agents from
  // silently executing privileged tools like run_command when the
  // user is not in YOLO mode.
  //
  // YOLO mode is honoured at the request-context level: if the user
  // enabled YOLO, `context.yoloMode` is true and we skip the prompt.
  const requester = context?.subAgent?.approvalRequester;
  const needsApproval =
    (toolName === 'run_command' || toolName === 'mcp_call') &&
    !context?.yoloMode &&
    typeof requester === 'function';

  if (needsApproval && requester) {
    const risk = toolName === 'run_command' ? 'command' : 'mcp';
    let displayArgs: unknown = toolCall.function.arguments;
    if (toolName === 'mcp_call') {
      // Surface the namespaced target so the user can make an
      // informed decision (the raw `mcp_call` payload includes
      // `server` / `tool` / `arguments`).
      const a = toolCall.function.arguments as {
        server?: unknown;
        tool?: unknown;
        arguments?: unknown;
      };
      displayArgs = {
        server: typeof a?.server === 'string' ? a.server : '',
        tool: typeof a?.tool === 'string' ? a.tool : '',
        arguments: a?.arguments,
      };
    }
    output.writeLine(
      `\n[Sub-agent: ${agentId}] is requesting a ${risk === 'command' ? 'command' : 'MCP tool call'}: awaiting approval…`
    );
    const decision = await requester({
      toolName,
      risk,
      args: displayArgs,
    });
    if (!decision.approved) {
      const reason =
        toolName === 'run_command' ? '[Command rejected by user]' : '[MCP call rejected by user]';
      output.writeLine(`[Sub-agent: ${agentId}] request denied by user.`);
      return { content: reason };
    }
    output.writeLine(`[Sub-agent: ${agentId}] request approved.`);
    // Phase 3.4: persist any `grantedTools` the user also authorised
    // for this sub-agent. The dispatcher enforces an explicit
    // approval per call unless the namespaced target is in the
    // sub-agent's ledger (or the server's `autoApprove` list, which
    // is checked inside `dispatchMCPToolCall`). Adding to the
    // ledger here lets a single sub-agent loop call the same MCP
    // tool repeatedly without re-prompting.
    if (toolName === 'mcp_call' && subAgentMcpApprovals && Array.isArray(decision.grantedTools)) {
      for (const granted of decision.grantedTools) {
        subAgentMcpApprovals.add(granted);
      }
    }
  }

  if (toolName === 'run_command') {
    output.writeLine(`\n[Sub-agent: ${agentId}] is requesting a command:`);
    return command.execute(toolCall.function.arguments, nestedProgress, output, context, signal);
  }

  // Phase 3.4: derive a per-call context that exposes the
  // sub-agent's local mcpApprovals ledger. `runMCPCall` reads
  // `context.mcpApprovals` to build the dispatcher approval set, so
  // pointing it at the sub-agent's ledger (rather than the parent's
  // turn-scoped set) gives the sub-agent a stable, isolated
  // approval scope for the duration of its loop. We only override
  // `mcpApprovals` — every other field still points at the parent's
  // request context, so tool implementations see the same YOLO
  // mode, allowedTools, etc. they already do.
  if (toolName === 'mcp_call' && subAgentMcpApprovals) {
    const derivedContext: RequestContext = {
      ...(context ?? ({} as RequestContext)),
      mcpApprovals: [...subAgentMcpApprovals],
    };
    return command.execute(
      toolCall.function.arguments,
      nestedProgress,
      output,
      derivedContext,
      signal
    );
  }

  return command.execute(toolCall.function.arguments, nestedProgress, output, context, signal);
}

async function runSingleAgent(
  agent: Required<SubAgentSpec>,
  config: SubAgentConfig,
  tools: ToolDefinition[],
  output: ToolOutputSink,
  onProgress?: (message: string) => void,
  context?: RequestContext,
  signal?: AbortSignal,
  skillSummary?: string
): Promise<string> {
  const orcPrompt: ChatMessage = { role: 'user', content: agent.prompt };
  const labeledOutput = makeLabeledSink(output, agent.id);
  // Create a per-sub-agent working-directory scope so each agent's `cd`
  // commands and relative path resolutions are isolated from the parent
  // and from sibling sub-agents.
  const agentScope = new WorkingDirectoryScope();
  const agentContext: RequestContext = {
    ...(context ?? ({} as RequestContext)),
    workingDirectoryScope: agentScope,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSubAgentSystemPrompt(skillSummary) },
    orcPrompt,
  ];

  // Phase 3.4: per-sub-agent MCP approval ledger. Seeded from the
  // sub-agent config's `mcpApprovals` (the chat route copies the
  // parent's per-turn pre-approvals in here when the sub-agent's
  // loop starts). This set is passed to `executeNestedToolCall` so
  // (a) the sub-agent honours pre-approvals the parent collected,
  // and (b) a positive sub-agent approval that grants additional
  // namespaced targets (`grantedTools`) persists for the rest of
  // the sub-agent's loop without re-prompting. The set is local to
  // this sub-agent and never mutates the parent's per-turn ledger.
  const subAgentMcpApprovals = new Set<string>(config.mcpApprovals ?? context?.mcpApprovals ?? []);

  let finalContent = '';
  const toolCallFingerprints = new Set<string>();

  const CIRCUIT_BREAKER_NOTICE =
    '[System: You have already called this exact tool with the same arguments in a previous turn. ' +
    'You appear to be stuck in a loop. Try a fundamentally different approach. ' +
    'If the task is genuinely blocked, summarize what you have discovered so far and return that as your final answer.]';

  while (!isInterruptOrAbort(signal)) {
    await autoCompactSubAgentIfNeeded(messages, config, labeledOutput, agent.id, orcPrompt, signal);
    if (isInterruptOrAbort(signal)) {
      break;
    }

    onProgress?.(`Sub-agent ${agent.id}: thinking`);

    // Track rough tokens and wall-clock time so the web UI can show
    // live tokens-per-second while the sub-agent is generating.
    const subagentStartMs = Date.now();
    let subagentRoughTokens = 0;
    let subagentLastTpsStatusMs = 0;

    const response = await sendLlmChat(
      config.baseUrl,
      {
        model: config.model,
        messages,
        tools,
        numCtx: config.numCtx,
      },
      (chunk) => {
        // Route live thinking/content tokens to the output sink so web
        // callers can stream them into the subagent bubble in real time.
        // A newline is prepended the first time each type appears in this
        // chunk sequence so thinking and content are visually separated.
        if (chunk.message?.thinking) {
          output.writeAgentChunk?.(agent.id, 'thinking', chunk.message.thinking);
          subagentRoughTokens += Math.max(1, countTextTokens(chunk.message.thinking, config.model));
        }
        if (chunk.message?.content) {
          output.writeAgentChunk?.(agent.id, 'content', chunk.message.content);
          subagentRoughTokens += Math.max(1, countTextTokens(chunk.message.content, config.model));
        }

        const now = Date.now();
        if (now - subagentLastTpsStatusMs > 800) {
          const elapsedSec = (now - subagentStartMs) / 1000;
          if (elapsedSec > 0) {
            output.reportTps?.(+(subagentRoughTokens / elapsedSec).toFixed(2));
          }
          subagentLastTpsStatusMs = now;
        }
      },
      undefined,
      signal
    );

    // Clear the live TPS indicator now that generation has finished.
    output.reportTps?.(null);

    // Emit a trailing newline so successive tool outputs and the next LLM
    // turn are visually separated from the streamed response text.
    output.writeAgentChunk?.(agent.id, 'content', '\n');

    const assistantMessage = sanitizeChatMessage(response.message);

    if (assistantMessage.content.trim().length > 0) {
      finalContent = assistantMessage.content.trim();
    }

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      messages.push(assistantMessage);
      onProgress?.(`Sub-agent ${agent.id}: completed`);
      break;
    }

    // Collect every tool response before appending anything. This keeps the
    // assistant message and its matching tool messages contiguous in history,
    // satisfying the OpenAI message-ordering contract.
    const toolResults: ChatMessage[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (isInterruptOrAbort(signal)) {
        break;
      }

      onProgress?.(`Sub-agent ${agent.id}: ${toolCall.function.name}`);

      const fingerprint = `${toolCall.function.name}:${JSON.stringify(toolCall.function.arguments)}`;
      if (toolCallFingerprints.has(fingerprint)) {
        // The model is repeating an identical tool call. We must still emit a
        // tool response for this tool_call_id to keep the OpenAI message ordering
        // contract valid; use the circuit-breaker notice as the tool result.
        toolResults.push(
          sanitizeChatMessage({
            role: 'tool',
            content: CIRCUIT_BREAKER_NOTICE,
            tool_call_id: toolCall.id,
          })
        );
        continue;
      }
      toolCallFingerprints.add(fingerprint);

      let toolResult: ToolCallResult;
      try {
        toolResult = await executeNestedToolCall(
          agent.id,
          toolCall,
          labeledOutput,
          onProgress,
          agentContext,
          signal,
          subAgentMcpApprovals
        );
      } catch (err) {
        const errorContent = err instanceof Error ? err.message : String(err);
        toolResult = { content: `[Sub-agent tool error: ${errorContent}]` };
        labeledOutput.writeLine(`Sub-agent tool error: ${errorContent}`);
      }

      toolResults.push(
        sanitizeChatMessage({
          role: 'tool',
          content: toolResult.content,
          tool_call_id: toolCall.id,
          ...(toolResult.images ? { images: toolResult.images } : {}),
        })
      );
    }

    // Push the assistant message and all of its tool responses as an atomic
    // block so no other message can be inserted between them.
    // If the loop was interrupted (e.g. abort signal), some tool_calls may not
    // have a collected result. Synthesize error responses for any missing ids
    // so the OpenAI message-ordering contract is always satisfied.
    const respondedToolIds = new Set(toolResults.map((m) => m.tool_call_id));
    for (const tc of assistantMessage.tool_calls) {
      if (!respondedToolIds.has(tc.id)) {
        toolResults.push(
          sanitizeChatMessage({
            role: 'tool',
            content: '[Tool response missing: the tool call was interrupted before a result was produced.]',
            tool_call_id: tc.id,
          })
        );
      }
    }
    messages.push(assistantMessage, ...toolResults);
  }

  return finalContent;
}

export class SubAgentTool implements IToolCommand {
  async execute(
    args: ToolCallArguments,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = noopToolOutputSink,
    context?: RequestContext,
    signal?: AbortSignal
  ): Promise<ToolCallResult> {
    const subAgentArgs = args as SubAgentToolArgs;
    const validationError = validateAgentSpecs(subAgentArgs.agents);
    if (validationError) {
      return { content: validationError };
    }

    const config = context?.subAgent;
    if (
      !config ||
      !config.baseUrl ||
      !config.model ||
      config.numCtx <= 0 ||
      config.tools.length === 0
    ) {
      return {
        content:
          '[run_subagents error: sub-agent runtime is not configured. ' +
          'Ensure a valid RequestContext with subAgent config is provided.]',
      };
    }

    const results: CompletedSubAgent[] = [];

    // Compute skill summary for sub-agent inheritance
    let skillSummary: string | undefined;
    try {
      const allSkills = discoverSkills();
      const skillState = loadSkillState();
      const enabledSkills = getEnabledSkills(allSkills, skillState);
      if (enabledSkills.length > 0) {
        const alwaysApply = enabledSkills.filter((s) => s.alwaysApply);
        const autoInvoke = enabledSkills.filter((s) => s.autoInvoke && !s.alwaysApply);
        const parts: string[] = [];
        if (alwaysApply.length > 0) {
          parts.push(
            `Always active:\n${  alwaysApply.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
          );
        }
        if (autoInvoke.length > 0) {
          parts.push(
            `Available on demand:\n${ 
              autoInvoke.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
          );
        }
        if (parts.length > 0) skillSummary = parts.join('\n\n');
      }
    } catch {
      // Best-effort; leave skillSummary undefined
    }

    for (const agent of subAgentArgs.agents as Required<SubAgentSpec>[]) {
      if (isInterruptOrAbort(signal)) {
        break;
      }

      try {
        const content = await runSingleAgent(
          agent,
          config,
          config.tools,
          output,
          onProgress,
          context,
          signal,
          skillSummary
        );
        results.push({ id: agent.id, content });
      } catch (err) {
        results.push({
          id: agent.id,
          content: `[Sub-agent error: ${err instanceof Error ? err.message : String(err)}]`,
        });
      }
    }

    return {
      content: formatCombinedResults(results, isInterruptOrAbort(signal)),
    };
  }
}

export function getToolPrompt(): string {
  const schema = subAgentToolSchema;
  const agentItems = schema.parameters.properties.agents?.items as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  const agentProps = agentItems?.properties ?? {};
  const params = `agents: Array<{ id: string, prompt: string }>`;
  return (
    `3. ${schema.name}(${params})\n` +
    `   ${schema.description}\n\n` +
    `   - agents[].id: ${agentProps.id?.description ?? ''}\n` +
    `   - agents[].prompt: ${agentProps.prompt?.description ?? ''}\n`
  );
}
