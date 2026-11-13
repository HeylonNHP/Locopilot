/**
 * Regression checks for model/provider persistence payloads and refresh recovery.
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';

import {
  saveSessionDefaults,
  saveSessionSelection,
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
 * The model picker and the `/model` command both save through
 * `saveSessionSelection`, so this is where the provider of the picked model
 * is decided: a model name alone does not say which endpoint serves it.
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
        saveSessionSelection(
          7,
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: null,
            compactionProviderId: null,
          },
          { model: 'qwen3-coder:30b', providerId: 'openrouter', compactionModel: '' }
        )
      );

      expect(writes.sessionRow).toStrictEqual({
        model: 'qwen3-coder:30b',
        providerId: 'openrouter',
        compactionModel: null,
        compactionProviderId: null,
      });
      expect(writes.config).toStrictEqual({
        model: 'qwen3-coder:30b',
        activeProviderId: 'openrouter',
        compactionModel: '',
      });
    });

    test('the global defaults are written, not the conversation’s selection', async () => {
      // A pick of the main model must not move the default compaction model,
      // and a pick of the compaction model must not move the default main
      // model: the two pickers are separate controls.
      const writes = await captureWrites(() =>
        saveSessionSelection(
          7,
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: 'cheap-compactor',
            compactionProviderId: 'openrouter',
          },
          { model: 'qwen3-coder:30b', providerId: 'openrouter', compactionModel: 'cheap-compactor' }
        )
      );

      expect(writes.config).toStrictEqual({
        model: 'qwen3-coder:30b',
        activeProviderId: 'openrouter',
        compactionModel: 'cheap-compactor',
      });
    });

    test('a conversation that inherits the global compaction model keeps inheriting it', async () => {
      const writes = await captureWrites(() =>
        saveSessionSelection(
          7,
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: null,
            compactionProviderId: null,
          },
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: 'global-compactor',
          }
        )
      );

      // The conversation's own row keeps "inherit"; the global it inherits
      // is written as the global it is, so the two cannot drift apart.
      expect(writes.sessionRow.compactionModel).toBeNull();
      expect(writes.config.compactionModel).toBe('global-compactor');
    });

    test('a failed save is reported instead of swallowed', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false });
      try {
        const saved = await saveSessionSelection(
          7,
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: null,
            compactionProviderId: null,
          },
          { model: 'qwen3-coder:30b', providerId: 'openrouter', compactionModel: '' }
        );
        expect(saved).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('the defaults alone can be saved, without a conversation to pin', async () => {
      const writes = await captureWrites(() =>
        saveSessionDefaults({
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

    test('the completion and reasoning-effort payloads do not send the model selection', () => {
      // The model selection belongs to the conversation now, and the config's
      // `model` is the default a NEW conversation starts with. Sending the
      // conversation's value here repoints that default - and a conversation
      // that inherits the default compaction model sends a null, which the
      // config route rejects with a 400, losing the setting the user chose.
      for (const source of [completionSelector, reasoningEffortSelector]) {
        expect(source).not.toMatch(/body: JSON\.stringify\({[^}]*\bmodel,/);
        expect(source).not.toMatch(/body: JSON\.stringify\({[^}]*\bcompactionModel,/);
      }
    });

    test('the model selector persists the selected provider ID', async () => {
      const writes = await captureWrites(() =>
        saveSessionSelection(
          7,
          {
            model: 'qwen3-coder:30b',
            providerId: 'openrouter',
            compactionModel: null,
            compactionProviderId: null,
          },
          { model: 'qwen3-coder:30b', providerId: 'openrouter', compactionModel: '' }
        )
      );
      expect(writes.config.activeProviderId).toBe('openrouter');
    });
  });
});
