/**
 * web_search: what becomes of the queries a call asks for.
 *
 * Identical queries were run once and queries beyond the limit were dropped,
 * both without a word, and the limit itself came from a config value the
 * model could not see. The result now reports the limit used, the duplicates
 * removed and the queries not run, and the descriptions state the rules.
 * The two I/O seams are replaced as in tests/web-search-parallel.test.mjs;
 * there is no network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

let describeQueryPlan;
let WebSearchTool;
let webSearchToolSchema;
beforeAll(async () => {
  // The tool reaches jsdom through the HTML extractor, which these tests never
  // call; jsdom's ESM-only dependency cannot be required on Node < 24.9 (the
  // same stub as tests/chat-route-pair-gates.test.mjs, before the import).
  jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
  ({ describeQueryPlan, WebSearchTool, webSearchToolSchema } =
    await import('../src/tools/impl/webSearchTool.ts'));
}, 60_000);

const settings = {
  maxQueries: 3,
  resultsPerQuery: 2,
  requestTimeoutMs: 1000,
  perPageCharLimit: 5000,
  baseUrl: 'http://ollama.test',
  compactionModel: 'test-model',
};

beforeEach(() => {
  jest.spyOn(WebSearchTool.prototype, 'fetchSearchResults').mockResolvedValue([]);
  jest.spyOn(WebSearchTool.prototype, 'fetchAndExtractText').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const run = (args) => new WebSearchTool({ settings }).run(args);
const header = (result) => result.split('\n\n')[0];

describe('the descriptions', () => {
  const props = () => webSearchToolSchema.parameters.properties;

  test('max_queries says where its default comes from and where the limit is reported', () => {
    expect(props().max_queries.description).toContain('1 to 10');
    expect(props().max_queries.description).toContain("user's configured limit");
    expect(props().max_queries.description).toContain('query_limit');
  });

  test('queries says duplicates run once and extras are listed, not silently dropped', () => {
    expect(props().queries.description).toContain('Identical queries are run once');
    expect(props().queries.description).toContain('queries_not_run');
  });

  test('prompt says how it is turned into queries', () => {
    expect(props().prompt.description).toContain('searched as one query');
    expect(props().prompt.description).toContain('"and" and "or"');
  });
});

describe('the result header', () => {
  test('reports the limit used when max_queries is left out (the configured one)', async () => {
    const result = await run({ queries: ['a', 'b'] });
    expect(header(result)).toContain('queries_used: 2');
    expect(header(result)).toContain('query_limit: 3');
    expect(header(result)).not.toContain('queries_not_run');
  });

  test('reports the limit used when max_queries is given', async () => {
    const result = await run({ queries: ['a', 'b', 'c'], max_queries: 2 });
    expect(header(result)).toContain('queries_used: 2');
    expect(header(result)).toContain('query_limit: 2');
  });

  test('lists the queries that were over the limit, and says how to run them', async () => {
    const result = await run({ queries: ['one', 'two', 'three', 'four', 'five'] });
    expect(header(result)).toContain('queries_used: 3');
    expect(header(result)).toContain('queries_not_run (over the limit of 3): ["four","five"]');
    expect(header(result)).toContain('search again with just these, or raise max_queries');
  });

  test('lists duplicates removed, and a duplicate does not use up the limit', async () => {
    const result = await run({ queries: ['a', 'a', 'b', 'c'], max_queries: 3 });
    expect(header(result)).toContain('duplicate_queries_removed: ["a"]');
    expect(header(result)).toContain('queries_used: 3');
    expect(header(result)).not.toContain('queries_not_run');
  });

  test('says queries came from the prompt when no explicit queries were given', async () => {
    const result = await run({ prompt: 'rust async runtimes and tokio internals' });
    expect(header(result)).toContain('queries_derived_from_prompt: true');
    expect(header(result)).not.toContain('duplicate_queries_removed');
  });

  test('explicit queries do not claim to be derived', async () => {
    const result = await run({ queries: ['a'] });
    expect(header(result)).not.toContain('queries_derived_from_prompt');
  });
});

describe('describeQueryPlan', () => {
  test('says nothing when nothing was dropped', () => {
    expect(
      describeQueryPlan(
        { queries: ['a'], source: 'explicit', duplicatesRemoved: [], notRun: [] },
        3
      )
    ).toEqual([]);
  });
});
