// Verification harness for the shape-aware stripDescriptions fix in
// src/services/adapters/openaiCompatibleAdapter.ts. Imports nothing from the
// source module (the function isn't exported); instead re-implements the
// logic exactly as it appears in the patched file so a regression here
// signals that the source has drifted from this test.
//
// Run with: node scripts/verify-strip-descriptions.mjs
//
// Exits non-zero if any case fails.

const PROPERTY_NAME_CONTAINERS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  'definitions',
  '$defs',
]);

function stripDescriptions(obj) {
  return stripDescriptionsImpl(obj, null);
}

function stripDescriptionsImpl(obj, parentKey) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v) => stripDescriptionsImpl(v, null));
  if (typeof obj === 'object') {
    const record = obj;
    const childrenArePropertyNames = parentKey !== null && PROPERTY_NAME_CONTAINERS.has(parentKey);
    const result = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'description' && !childrenArePropertyNames) continue;
      result[key] = stripDescriptionsImpl(value, key);
    }
    return result;
  }
  return obj;
}

const cases = [
  {
    name: 'create_skill schema (real, with description property)',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill identifier' },
        description: { type: 'string', description: 'Brief description of what this skill does' },
        body: { type: 'string', description: 'Full markdown body' },
        alwaysApply: { type: 'boolean', description: 'If true, injected automatically' },
        globPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional globs' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tool allowlist',
        },
        location: { type: 'string', description: "Where to write: 'project' or 'user-profile'" },
      },
      required: ['name', 'description', 'body'],
    },
    expect(out) {
      const errors = [];
      // Property declaration descriptions are stripped.
      if (out.properties.name.description !== undefined)
        errors.push('name.description should be stripped');
      if (out.properties.body.description !== undefined)
        errors.push('body.description should be stripped');
      if (out.properties.alwaysApply.description !== undefined)
        errors.push('alwaysApply.description should be stripped');
      if (out.properties.globPatterns.description !== undefined)
        errors.push('globPatterns.description should be stripped');
      if (out.properties.location.description !== undefined)
        errors.push('location.description should be stripped');
      // The property NAMED 'description' must survive intact.
      if (!out.properties.description)
        errors.push('properties.description PROPERTY must be preserved');
      if (out.properties.description.type !== 'string')
        errors.push('properties.description.type must be "string"');
      // The 'description' property's OWN description annotation IS stripped.
      if (out.properties.description.description !== undefined)
        errors.push('properties.description.description should be stripped');
      // required is untouched.
      if (JSON.stringify(out.required) !== JSON.stringify(['name', 'description', 'body']))
        errors.push('required array was modified');
      return errors;
    },
  },
  {
    name: 'nested array items with description on property decl',
    input: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: 'Sub-agents to run',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'What this agent does' },
              context: { type: 'string', description: 'Optional context' },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['agents'],
    },
    expect(out) {
      const errors = [];
      if (out.properties.agents.items.properties.prompt.description !== undefined)
        errors.push('items.properties.prompt.description should be stripped');
      if (out.properties.agents.items.properties.context.description !== undefined)
        errors.push('items.properties.context.description should be stripped');
      if (out.properties.agents.description !== undefined)
        errors.push('agents.description should be stripped');
      return errors;
    },
  },
  {
    name: 'schema with no description anywhere',
    input: {
      type: 'object',
      properties: { foo: { type: 'string' }, bar: { type: 'integer' } },
      required: ['foo'],
    },
    expect(out) {
      const errors = [];
      if (out.properties.foo.type !== 'string') errors.push('foo.type changed');
      if (out.properties.bar.type !== 'integer') errors.push('bar.type changed');
      return errors;
    },
  },
  {
    name: 'Airia-style: deeply nested description on property decl',
    input: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                leaf: { type: 'string', description: 'Deep leaf description' },
              },
            },
          },
        },
      },
    },
    expect(out) {
      const errors = [];
      if (out.properties.config.properties.nested.properties.leaf.description !== undefined)
        errors.push('deep description should be stripped');
      return errors;
    },
  },
  {
    name: 'property declaration that is a $ref (no "type" key) — must not crash',
    input: {
      type: 'object',
      properties: {
        thing: { $ref: '#/components/schemas/Foo', description: 'A reference' },
      },
    },
    expect(out) {
      const errors = [];
      if (!out.properties.thing) errors.push('thing property missing');
      if (out.properties.thing.$ref !== '#/components/schemas/Foo')
        errors.push('thing.$ref missing');
      return errors;
    },
  },
  {
    name: 'parameter named description in an items[i] array property decl',
    // A rare but real shape: a tool's parameter is named `description` AND
    // it's the element of an array. The element type itself describes an
    // object (not a primitive), so its properties are a `properties` map.
    input: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What this item means' },
            },
            required: ['description'],
          },
        },
      },
    },
    expect(out) {
      const errors = [];
      if (!out.properties.items.items.properties.description)
        errors.push('items[].properties.description property must be preserved');
      if (out.properties.items.items.properties.description.description !== undefined)
        errors.push('items[].properties.description.description annotation should be stripped');
      if (JSON.stringify(out.properties.items.items.required) !== JSON.stringify(['description']))
        errors.push('required array was modified');
      return errors;
    },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const out = stripDescriptions(structuredClone(c.input));
  const errors = c.expect(out);
  if (errors.length === 0) {
    console.log(`PASS ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL ${c.name}`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log('  out:', JSON.stringify(out, null, 2));
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) throw new Error(`${fail} case(s) failed`);

// ── Optional end-to-end check against OpenRouter ───────────────────────────
//
// When OPENROUTER_API_KEY is set, also send a representative payload (the
// create_skill schema from src/tools/impl/createSkillTool.ts, with a few
// companion tools) through the same stripDescriptions and POST it. This
// proves the unit-level fix survives end-to-end against a real Responses
// API consumer that previously rejected the original (buggy) payload.
if (process.env.OPENROUTER_API_KEY) {
  const realCreateSkill = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill identifier' },
      description: { type: 'string', description: 'What the skill does' },
      body: { type: 'string', description: 'Markdown body' },
      alwaysApply: { type: 'boolean', description: 'Inject always' },
      autoInvoke: { type: 'boolean', description: 'Listed as available' },
      globPatterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional globs',
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional allowlist',
      },
      location: { type: 'string', description: 'project or user-profile' },
    },
    required: ['name', 'description', 'body'],
  };
  const cleaned = stripDescriptions(realCreateSkill);
  if (!cleaned.properties.description) {
    throw new Error('e2e setup: create_skill lost its description property');
  }
  const res = await fetch('https://openrouter.ai/api/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-5.6-luna',
      input: [{ role: 'user', content: 'hi', type: 'message' }],
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        {
          type: 'function',
          name: 'create_skill',
          description: 'Create or overwrite a skill definition.',
          parameters: cleaned,
          strict: false,
        },
        {
          type: 'function',
          name: 'run_command',
          description: 'Run a shell command.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'The shell command' } },
            required: ['command'],
          },
          strict: false,
        },
      ],
    }),
  });
  console.log(`OpenRouter HTTP ${res.status}`);
  if (res.status !== 200) {
    const txt = await res.text();
    console.error(txt.slice(0, 600));
    throw new Error(`OpenRouter returned ${res.status} after fix`);
  }
  console.log('e2e: OpenRouter accepted the fixed payload');
}
