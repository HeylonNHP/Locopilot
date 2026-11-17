/**
 * Regression checks for model/provider persistence payloads and refresh recovery.
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';

import {
  saveDefaultsPatch,
  saveFailureMessage,
  saveSelectionChanges,
  saveSessionPatch,
} from '../src/app/lib/sessionSelectionClient.ts';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

const dataLoaders = await read('../src/app/hooks/useDataLoaders.ts');
const modelSelector = await read('../src/components/ModelSelector/ModelSelector.tsx');
const completionSelector = await read(
  '../src/components/CompletionModeSelector/CompletionModeSelector.tsx'
);
const reasoningEffortSelector = await read(
  '../src/components/ReasoningEffortSelector/ReasoningEffortSelector.tsx'
);

/**
 * Runs a writer against a stubbed `fetch` and returns what it wrote.
 *
 * Every control writes through one of these two functions: a field-preserving
 * patch to the conversation's row and a field-preserving patch to the global
 * defaults. The point of the separation is that a pick of one field cannot
 * carry — or erase — another.
 */
async function captureWrites(run) {
  const writes = [];
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    writes.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({}) };
  });
  try {
    await run();
  } finally {
    fetchSpy.mockRestore();
  }
  return {
    sessionRow: writes.find((w) => w.url.startsWith('/api/sessions/'))?.body,
    config: writes.find((w) => w.url === '/api/config')?.body,
  };
}

describe('provider persistence', () => {
  describe('the /model command', () => {
    test('the provider of the picked model travels with the model', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(
          7,
          { model: 'qwen3-coder:30b', providerId: 'openrouter' },
          { model: 'qwen3-coder:30b', providerId: 'openrouter' }
        )
      );

      // The row carries exactly the fields the picker changed. The reasoning
      // pins, the compaction model and its provider are untouched, so an
      // older tab cannot erase them.
      expect(writes.sessionRow).toStrictEqual({
        model: 'qwen3-coder:30b',
        providerId: 'openrouter',
      });
      expect(writes.config).toStrictEqual({
        model: 'qwen3-coder:30b',
        activeProviderId: 'openrouter',
      });
    });

    test('a pick of the main model does not move the compaction defaults', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(
          7,
          { model: 'qwen3-coder:30b', providerId: 'openrouter' },
          { model: 'qwen3-coder:30b', providerId: 'openrouter' }
        )
      );

      expect(writes.config).not.toHaveProperty('compactionModel');
      expect(writes.config).not.toHaveProperty('reasoningEffort');
      expect(writes.config).not.toHaveProperty('compactionReasoningEffort');
    });

    test('a conversation that inherits the global compaction model keeps inheriting it', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(7, { compaction: { kind: 'inherit-default' } }, {})
      );

      // "Use the default" is one value that names no model of its own, and
      // the default itself is not re-written.
      expect(writes.sessionRow).toStrictEqual({ compaction: { kind: 'inherit-default' } });
      expect(writes.config).toStrictEqual({});
    });

    test('the compaction selection travels as ONE value, never as two fields', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(
          7,
          { compaction: { kind: 'explicit', model: 'cheap-compactor', providerId: 'openai' } },
          {}
        )
      );

      expect(writes.sessionRow).toStrictEqual({
        compaction: { kind: 'explicit', model: 'cheap-compactor', providerId: 'openai' },
      });
      expect(writes.sessionRow).not.toHaveProperty('compactionModel');
      expect(writes.sessionRow).not.toHaveProperty('compactionProviderId');
    });

    test('a reasoning pick writes only that level', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(7, { reasoningEffort: 'high' }, { reasoningEffort: 'high' })
      );

      expect(writes.sessionRow).toStrictEqual({ reasoningEffort: 'high' });
      expect(writes.config).toStrictEqual({ reasoningEffort: 'high' });
    });

    test('a failed row save is reported instead of swallowed', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false });
      try {
        const saved = await saveSelectionChanges(
          7,
          { model: 'qwen3-coder:30b', providerId: 'openrouter' },
          { model: 'qwen3-coder:30b', providerId: 'openrouter' }
        );
        expect(saved.ok).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('a failed defaults save is reported too', async () => {
      // The row write succeeds; the config write does not. The UI must not
      // dispatch the new default as saved — that was how a failed settings
      // write used to look successful until the next reload.
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
        ok: !String(url).startsWith('/api/config'),
      }));
      try {
        const saved = await saveSelectionChanges(
          7,
          { reasoningEffort: 'high' },
          { reasoningEffort: 'high' }
        );
        expect(saved.ok).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test("the server's own refusal reaches the caller, from the row write and from the defaults write", async () => {
      // BUG 7: both writes returned `res.ok` and threw the body away, so every
      // refusal reached the user as the same generic sentence.
      const refusal = (message) => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: message }),
      });
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(refusal('The compaction provider "ghost" is not configured.'));
      try {
        const row = await saveSessionPatch(7, { reasoningEffort: 'high' });
        expect(row).toStrictEqual({
          ok: false,
          message: 'The compaction provider "ghost" is not configured.',
        });
        const defaults = await saveDefaultsPatch({ reasoningEffort: 'high' });
        expect(defaults).toStrictEqual({
          ok: false,
          message: 'The compaction provider "ghost" is not configured.',
        });
        // and a failed row write stops the pair: the defaults are not written
        fetchSpy.mockClear();
        const both = await saveSelectionChanges(7, { reasoningEffort: 'high' }, {});
        expect(both.ok).toBe(false);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('a request that never got an answer has no message to add', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
      try {
        expect(await saveSessionPatch(7, { reasoningEffort: 'high' })).toStrictEqual({
          ok: false,
          message: null,
        });
        expect(await saveDefaultsPatch({ reasoningEffort: 'high' })).toStrictEqual({
          ok: false,
          message: null,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('a successful write is ok, and a new chat has no row to write', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
      try {
        expect(await saveSessionPatch(7, { reasoningEffort: 'high' })).toStrictEqual({ ok: true });
        expect(await saveSessionPatch(null, { reasoningEffort: 'high' })).toStrictEqual({
          ok: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('the failure message carries the cause in its FIRST line, the banner headline', () => {
      const generic = 'The model could not be saved for this conversation.';
      const message = saveFailureMessage(generic, {
        ok: false,
        message: 'ghost is not configured',
      });
      expect(message.split('\n')[0]).toBe(
        'The model could not be saved for this conversation: ghost is not configured'
      );
      // nothing to add: the generic sentence is kept as it was
      expect(saveFailureMessage(generic, { ok: false, message: null })).toBe(generic);
      expect(saveFailureMessage(generic, { ok: true })).toBe(generic);
    });

    test('a new chat has no row to write', async () => {
      const writes = await captureWrites(() =>
        saveSelectionChanges(null, { reasoningEffort: 'low' }, { reasoningEffort: 'low' })
      );

      expect(writes.sessionRow).toBeUndefined();
      expect(writes.config).toStrictEqual({ reasoningEffort: 'low' });
    });

    test('the defaults alone can be saved, without a conversation to pin', async () => {
      const writes = await captureWrites(() =>
        saveDefaultsPatch({
          model: 'qwen3-coder:30b',
          providerId: 'openrouter',
          compactionModel: 'cheap-compactor',
        })
      );

      // No conversation's row is written: there is none to write.
      expect(writes.sessionRow).toBeUndefined();
      expect(writes.config).toStrictEqual({
        model: 'qwen3-coder:30b',
        activeProviderId: 'openrouter',
        compactionModel: 'cheap-compactor',
      });
    });

    test('the selector writers are the only thing a control uses', async () => {
      // A control must not build a /api/config body of its own: it would
      // either send a whole settings object (re-asserting values another tab
      // changed) or carry the conversation's selection into the defaults.
      for (const source of [completionSelector, reasoningEffortSelector]) {
        expect(source).not.toMatch(/body: JSON\.stringify\({[^}]*\bmodel,/);
        expect(source).not.toMatch(/body: JSON\.stringify\({[^}]*\bcompactionModel,/);
      }
    });
  });

  describe('refresh reconciliation', () => {
    test('checks that the restored provider owns the selected model', () => {
      expect(dataLoaders).toContain(
        'm.name === state.model && m.providerId === state.activeProviderId'
      );
    });

    test('repairs a mismatched provider instead of only a missing provider', () => {
      expect(dataLoaders).toContain('if (!selectedModelMatchesProvider)');
    });
  });

  describe('the strict /api/config contract', () => {
    test('the main and compaction model selector payloads do not send a top-level baseUrl', () => {
      expect(modelSelector).not.toContain('body: JSON.stringify({\n              baseUrl,');
    });

    test('the completion selector payload does not send a top-level baseUrl', () => {
      expect(completionSelector).not.toContain('body: JSON.stringify({\n              baseUrl,');
    });

    test('the model selector persists the selected provider ID', async () => {
      const writes = await captureWrites(() =>
        saveSessionPatch(7, { model: 'qwen3-coder:30b', providerId: 'openrouter' })
      );
      expect(writes.sessionRow.providerId).toBe('openrouter');
    });
  });
});
