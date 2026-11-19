/**
 * The glob dialect of `search_files`' `file_filter`, and nothing else.
 *
 * Small on purpose: every piece of syntax it accepts is listed in
 * {@link FILE_GLOB_SYNTAX_SENTENCE}, which the tool puts in its description,
 * and syntax it does NOT accept (`[abc]`, a leading `!`, a backslash) is
 * REFUSED by name instead of being read as literal text. A glob that quietly
 * meant something else would return "no matches" and the model would never
 * learn why.
 */

/** What the dialect accepts, for the tool description. */
export const FILE_GLOB_SYNTAX_SENTENCE =
  '* matches any characters except /, ** matches any characters including /, ? matches one character other than /, and {a,b} matches either alternative (no nesting). Anything else is a literal character. It is case-sensitive, always uses / as the separator, and does not support [abc] sets or a leading ! to exclude.';

export type FileGlobResult =
  | {
      ok: true;
      /** Anchored at both ends; test it against the text named by `target`. */
      regex: RegExp;
      /** `name`: the file name at any depth (no / in the glob). `path`: the path relative to the searched folder. */
      target: 'name' | 'path';
    }
  | { ok: false; error: string };

const REGEX_SPECIAL = /[$()*+.?[\\\]^{|}]/;

function escapeLiteral(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

/** One run of glob text with no braces in it. */
function translateRun(run: string): string {
  let out = '';
  for (let index = 0; index < run.length; index++) {
    const char = run[index]!;
    if (char === '*') {
      if (run[index + 1] === '*') {
        index++;
        if (run[index + 1] === '/') {
          index++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(char);
    }
  }
  return out;
}

export function compileFileGlob(glob: string): FileGlobResult {
  if (glob.includes('\\')) {
    return {
      ok: false,
      error:
        'file_filter must use / as the path separator; a backslash is not accepted (it would be ambiguous with an escape).',
    };
  }
  if (glob.startsWith('!')) {
    return {
      ok: false,
      error:
        'file_filter does not support a leading ! to exclude files. Search with a positive glob instead.',
    };
  }
  if (glob.includes('[') || glob.includes(']')) {
    return {
      ok: false,
      error: `file_filter does not support [ ] character sets. Supported syntax: ${FILE_GLOB_SYNTAX_SENTENCE}`,
    };
  }
  if (glob.startsWith('./') || glob.startsWith('/')) {
    return {
      ok: false,
      error:
        'file_filter is relative to the searched folder, so it must not start with "./" or "/".',
    };
  }

  let source = '';
  let cursor = 0;
  while (cursor < glob.length) {
    const open = glob.indexOf('{', cursor);
    const stray = glob.indexOf('}', cursor);
    if (open === -1) {
      if (stray !== -1) {
        return { ok: false, error: 'file_filter has a } with no matching {.' };
      }
      source += translateRun(glob.slice(cursor));
      break;
    }
    if (stray !== -1 && stray < open) {
      return { ok: false, error: 'file_filter has a } with no matching {.' };
    }
    const close = glob.indexOf('}', open);
    if (close === -1) {
      return { ok: false, error: 'file_filter has a { with no matching }.' };
    }
    const inside = glob.slice(open + 1, close);
    if (inside.includes('{')) {
      return { ok: false, error: 'file_filter does not support nested {braces}.' };
    }
    source += translateRun(glob.slice(cursor, open));
    source += `(?:${inside
      .split(',')
      .map((alternative) => translateRun(alternative))
      .join('|')})`;
    cursor = close + 1;
  }

  return {
    ok: true,
    regex: new RegExp(`^${source}$`),
    target: glob.includes('/') ? 'path' : 'name',
  };
}
