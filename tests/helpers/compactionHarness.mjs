/**
 * Shared plumbing for the compaction characterisation tests
 * (compact-summary-pipeline, compact-distill-shell, compact-orchestrate).
 *
 * - `createGoldenFile(url)`: a stored transcript per scenario. Compare with
 *   `check(name, value)`; regenerate deliberately with
 *   `LOCOPILOT_TEST_WRITE_GOLDEN=1`. The diff of the fixture is then the review.
 * - `describeRequests(fake)`: what a test records about every request the fake
 *   provider saw (kind, limits, prompt hashes, the head of the user message).
 * - `runScenario(...)`: one scenario against a fresh fake provider; the
 *   thrown error, if any, is returned instead of thrown so a test can assert it.
 */

import { expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { classifyCompactionRequest, startFakeOllama } from './fakeOllama.mjs';

const WRITE_GOLDEN = process.env['LOCOPILOT_TEST_WRITE_GOLDEN'] === '1';

/** A short, stable fingerprint of a prompt (the golden prompt test pins the full text). */
export const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * A golden file of named transcripts.
 *
 * @param {URL} url - where the fixture lives.
 * @returns {{ load: () => void, check: (name: string, value: unknown) => void, save: () => void }}
 */
export function createGoldenFile(url) {
  let golden = {};
  const written = {};
  return {
    /** Call in `beforeAll`. */
    load() {
      if (WRITE_GOLDEN) return;
      if (!existsSync(url)) {
        throw new Error(
          `Missing golden file ${url.pathname}: run with LOCOPILOT_TEST_WRITE_GOLDEN=1 once.`
        );
      }
      golden = JSON.parse(readFileSync(url, 'utf8'));
    },
    /** Compare with the stored copy (or record it in write mode). */
    check(name, value) {
      if (WRITE_GOLDEN) {
        written[name] = value;
        return;
      }
      expect(golden[name]).toBeDefined();
      expect(value).toStrictEqual(golden[name]);
    },
    /** Call in `afterAll`. */
    save() {
      if (WRITE_GOLDEN) {
        writeFileSync(url, `${JSON.stringify(written, null, 2)}\n`);
      }
    },
  };
}

/**
 * What a test records about each request: enough to notice any change, small
 * enough to read in a diff.
 */
export function describeRequests(fake) {
  return fake.requests.map(({ index, kind, body }) => {
    const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
    const user = body.messages.findLast((message) => message.role === 'user')?.content ?? '';
    return {
      index,
      kind,
      stream: body.stream,
      options: body.options,
      tools: body.tools ?? null,
      systemSha: fingerprint(system),
      systemHead: system.slice(0, 60),
      userChars: user.length,
      userHead: user.slice(0, 80),
    };
  });
}

/**
 * Run one scenario against a fresh fake provider.
 *
 * @param {object} options
 * @param {string} options.distillSystemPrompt - `TOOL_DISTILL_SYSTEM_PROMPT`, so distil, summary and measure requests are told apart.
 * @param {(call: object) => object | Promise<object>} options.respond - scripted replies.
 * @param {(ctx: object, progress: string[], fake: object) => Promise<any>} options.run
 * @returns {Promise<{ fake: object, progress: string[], value?: any, error?: any }>}
 */
export async function runScenario({ distillSystemPrompt, respond, run }) {
  const fake = await startFakeOllama(respond, {
    classify: (body) => classifyCompactionRequest(body, distillSystemPrompt),
  });
  const progress = [];
  try {
    const outcome = await run({ baseUrl: fake.baseUrl }, progress, fake).then(
      (value) => ({ value }),
      (err) => ({ error: err })
    );
    return { fake, progress, ...outcome };
  } finally {
    await fake.close();
  }
}
