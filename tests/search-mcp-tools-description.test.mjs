/**
 * search_mcp_tools: a description it cuts says so, and says how to get the rest.
 *
 * Each description in the result was cut to 240 characters with only a `…` to
 * show it, and nothing said how to see the rest. The cut is now marked with
 * the real lengths and the way to ask for the full text (`full_description`),
 * and the tool's description states the rule. A connected server is faked on
 * the real client manager; nothing is started.
 */
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

let runSearchMCPTools;
let searchMcpToolsToolSchema;
let getToolPrompt;
let MCP_DESCRIPTION_CUT_CHARS;
let getClientManager;

beforeAll(async () => {
  // The MCP layer is reached through code that imports jsdom, which these tests
  // never call; its ESM-only dependency cannot be required on Node < 24.9 (the
  // same stub as tests/chat-route-pair-gates.test.mjs, before the import).
  jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
  ({ runSearchMCPTools, searchMcpToolsToolSchema, getToolPrompt, MCP_DESCRIPTION_CUT_CHARS } =
    await import('../src/tools/impl/searchMcpToolsTool.ts'));
  ({ getClientManager } = await import('../src/mcp/index.ts'));
}, 60_000);

afterEach(() => {
  jest.restoreAllMocks();
});

const LONG = 'Lists things. '.repeat(40); // 560 characters
const SHORT = 'Lists things.';

function fakeServer() {
  const handle = {
    name: 'demo',
    status: 'connected',
    tools: [
      { name: 'long_tool', description: LONG, inputSchema: { type: 'object', properties: {} } },
      { name: 'short_tool', description: SHORT, inputSchema: { type: 'object', properties: {} } },
    ],
  };
  jest
    .spyOn(getClientManager(), 'get')
    .mockImplementation((name) => (name === 'demo' ? handle : undefined));
}

const descriptionLine = (result) => /^Description: (.*)$/m.exec(result)?.[1] ?? '';

describe('the tool description', () => {
  test('states the cut, that it is marked, and how to get full descriptions', () => {
    const { description, parameters } = searchMcpToolsToolSchema;
    expect(description).toContain(`cut to ${MCP_DESCRIPTION_CUT_CHARS} characters`);
    expect(description).toContain('a cut is marked in the result');
    expect(description).toContain('set full_description to true');
    expect(parameters.properties.full_description.type).toBe('boolean');
    expect(parameters.properties.full_description.description).toContain('default false');
    expect(parameters.required).toEqual([]);
  });

  test('the system-prompt section lists the argument', () => {
    const prompt = getToolPrompt();
    expect(prompt).toContain('search_mcp_tools(name?, server?, full_description?)');
    expect(prompt).toContain('- full_description:');
  });
});

describe('a single tool', () => {
  test('a long description is cut, and the cut says its length and how to get the rest', async () => {
    fakeServer();
    const { content } = await runSearchMCPTools({ name: 'mcp__demo__long_tool' });
    const line = descriptionLine(content);
    expect(line).toContain(LONG.slice(0, MCP_DESCRIPTION_CUT_CHARS));
    expect(line).not.toContain(LONG.slice(0, MCP_DESCRIPTION_CUT_CHARS + 20));
    expect(line).toContain(
      `description cut at ${MCP_DESCRIPTION_CUT_CHARS} of ${LONG.length} characters`
    );
    expect(line).toContain('full_description=true');
  });

  test('with full_description the whole text comes back and nothing says it was cut', async () => {
    fakeServer();
    const { content } = await runSearchMCPTools({
      name: 'mcp__demo__long_tool',
      full_description: true,
    });
    expect(descriptionLine(content)).toBe(LONG);
    expect(content).not.toContain('description cut');
  });

  test('a short description is returned as it is, with or without full_description', async () => {
    fakeServer();
    for (const full of [undefined, true, false]) {
      const { content } = await runSearchMCPTools({
        name: 'mcp__demo__short_tool',
        ...(full === undefined ? {} : { full_description: full }),
      });
      expect(descriptionLine(content)).toBe(SHORT);
      expect(content).not.toContain('description cut');
    }
  });
});

describe('a whole server', () => {
  test('marks the long tool’s cut and leaves the short one alone', async () => {
    fakeServer();
    const { content } = await runSearchMCPTools({ server: 'demo' });
    expect(content.match(/description cut at/g)).toHaveLength(1);
  });

  test('full_description applies to every tool of the server', async () => {
    fakeServer();
    const { content } = await runSearchMCPTools({ server: 'demo', full_description: true });
    expect(content).not.toContain('description cut');
    expect(content).toContain(LONG);
  });
});

describe('a bad full_description', () => {
  test.each(['yes', 1, null, {}])('%j is refused by name', async (value) => {
    fakeServer();
    const { content } = await runSearchMCPTools({
      name: 'mcp__demo__long_tool',
      full_description: value,
    });
    // null is "not given" for the other arguments, but a boolean is expected here.
    expect(content).toContain('"full_description" must be true or false');
  });
});

describe('the stub in the tool list', () => {
  let mcpToolStubToOllamaTool;
  let MAX_STUB_DESCRIPTION_CHARS;
  beforeAll(async () => {
    ({ mcpToolStubToOllamaTool, MAX_STUB_DESCRIPTION_CHARS } =
      await import('../src/mcp/schemaAdapter.ts'));
  });

  const stub = (description) => ({
    name: 'long_tool',
    server: 'demo',
    description,
    namespacedName: 'mcp__demo__long_tool',
  });

  test('a long description is cut with a mark, and the hint names full_description', () => {
    const text = mcpToolStubToOllamaTool(stub(LONG)).function.description;
    expect(text).toContain(`${LONG.slice(0, MAX_STUB_DESCRIPTION_CHARS)}…`);
    expect(text).not.toContain(LONG.slice(0, MAX_STUB_DESCRIPTION_CHARS + 10));
    expect(text).toContain('search_mcp_tools(name="mcp__demo__long_tool")');
    expect(text).toContain('full_description=true');
  });

  test('a short description is not marked as cut', () => {
    const text = mcpToolStubToOllamaTool(stub(SHORT)).function.description;
    expect(text).toContain(`[MCP:demo] ${SHORT} —`);
    expect(text).not.toContain('…');
  });
});
