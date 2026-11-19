/**
 * A web page the model reads says what was done to it.
 *
 * A page longer than the user's per-page limit is replaced by a model-written
 * summary, which reads exactly like the page, and the result carried no note
 * for it (a cut page and a cached page already had one). The note is chosen
 * by `annotateCompactedText` from the real compactor's outcome, so the
 * compactor itself is driven here with a scripted model; the descriptions of
 * both web tools state the rule.
 */
import { beforeAll, describe, expect, jest, test } from '@jest/globals';

import {
  annotateCompactedText,
  buildSummaryNote,
  ContentCompactor,
} from '../src/tools/impl/contentCompactor.ts';

let fetchUrlToolSchema;
let webSearchToolSchema;
beforeAll(async () => {
  // The web tools reach jsdom through the HTML extractor, which these tests never
  // call; its ESM-only dependency cannot be required on Node < 24.9 (the same stub
  // as tests/chat-route-pair-gates.test.mjs, registered before the import).
  jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
  ({ fetchUrlToolSchema } = await import('../src/tools/impl/fetchUrlTool.ts'));
  ({ webSearchToolSchema } = await import('../src/tools/impl/webSearchTool.ts'));
}, 60_000);
import { ConcurrencyLimiter } from '../src/util/concurrencyLimiter.ts';

const result = (outcome, extra = {}) => ({
  text: 'PAGE TEXT',
  outcome,
  originalLength: 12_345,
  limit: 5000,
  ...extra,
});

describe('annotateCompactedText', () => {
  test('a page that fitted is returned as it is, with no note', () => {
    expect(annotateCompactedText(result('unchanged'))).toBe('PAGE TEXT');
  });

  test('a summarised page carries the summary note, with both lengths and the way to the exact text', () => {
    const text = annotateCompactedText(result('compacted'));
    expect(text.startsWith('PAGE TEXT\n\n')).toBe(true);
    expect(text).toContain('a summary written by a model, not the page itself');
    expect(text).toContain("page's 12345 characters were over the 5000-character limit");
    expect(text).toContain('fetch_url');
    expect(text).toContain('full_content=true');
    expect(text).not.toContain('NOT summarised');
  });

  test('a cut page still carries the truncation note, and not the summary note', () => {
    const text = annotateCompactedText(result('truncated', { reason: 'the model call failed' }));
    expect(text).toContain('NOT summarised');
    expect(text).toContain('the model call failed');
    expect(text).not.toContain('written by a model');
  });

  test('the summary note names the real numbers it is given', () => {
    expect(buildSummaryNote({ ...result('compacted'), originalLength: 99, limit: 7 })).toContain(
      '99 characters were over the 7-character limit'
    );
  });
});

describe('with the real compactor', () => {
  const settings = {
    perPageCharLimit: 100,
    requestTimeoutMs: 1000,
    baseUrl: 'http://ollama.test',
    compactionModel: 'test-model',
  };
  const context = { baseUrl: 'http://ollama.test', provider: 'ollama' };
  const longPage = 'word '.repeat(200);

  const compactorFor = (streamChat) =>
    ContentCompactor.create(settings, context, {
      streamChat,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => false,
      limiter: new ConcurrencyLimiter(4),
    });

  const answering = (text) =>
    async function* answer() {
      yield { message: { role: 'assistant', content: text }, done: true };
    };

  test('a page the model summarised is annotated, a short page is not', async () => {
    const compactor = compactorFor(answering('SHORT SUMMARY'));
    const long = await compactor.compact(longPage);
    expect(long.outcome).toBe('compacted');
    const text = annotateCompactedText(long);
    expect(text).toContain('SHORT SUMMARY');
    expect(text).toContain('a summary written by a model');
    const short = await compactor.compact('tiny page');
    expect(short.outcome).toBe('unchanged');
    expect(annotateCompactedText(short)).toBe('tiny page');
  });

  test('a page cut because the model call failed carries the truncation note instead', async () => {
    const failing = async function* fail() {
      yield* [];
      throw new Error('model unavailable');
    };
    const cut = await compactorFor(failing).compact(longPage);
    expect(cut.outcome).toBe('truncated');
    const text = annotateCompactedText(cut);
    expect(text).toContain('NOT summarised');
    expect(text).not.toContain('a summary written by a model');
  });
});

describe('the descriptions of the web tools', () => {
  test('web_search says long pages are summarised or cut, that a note says which, and that a cache is used', () => {
    const { description } = webSearchToolSchema;
    expect(description).toContain('replaced by a summary written by a model');
    expect(description).toContain('cut to its first characters');
    expect(description).toContain('a note under the page says which');
    expect(description).toMatch(/last 15 minutes may come from a cache/);
    expect(description).toContain('fetch_url with full_content=true');
  });

  test('fetch_url says the same about summaries, and that it never uses the cache', () => {
    const { description } = fetchUrlToolSchema;
    expect(description).toContain('replaced by a summary written by a model');
    expect(description).toContain('unless full_content is true');
    expect(description).toContain('never from the web_search cache');
  });
});
