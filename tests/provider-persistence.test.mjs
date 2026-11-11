/**
 * Regression checks for model/provider persistence payloads and refresh recovery.
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention.
 */

import { describe, expect, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

const slashCommands = await read('../src/app/hooks/useSlashCommands.ts');
const dataLoaders = await read('../src/app/hooks/useDataLoaders.ts');
const modelSelector = await read('../src/components/ModelSelector/ModelSelector.tsx');
const completionSelector = await read(
  '../src/components/CompletionModeSelector/CompletionModeSelector.tsx'
);

describe('provider persistence', () => {
  describe('the /model command', () => {
    test('reads providerId from the matched model', () => {
      expect(slashCommands).toContain(
        "const selectedProviderId =\n                typeof matched === 'string' ? undefined : matched.providerId;"
      );
    });

    test('updates the active provider when metadata is available', () => {
      expect(slashCommands).toContain(
        "dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: selectedProviderId });"
      );
    });

    test('persists activeProviderId with the model', () => {
      expect(slashCommands).toContain(
        '...(selectedProviderId ? { activeProviderId: selectedProviderId } : {}),'
      );
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

    test('the model selector persists the selected provider ID', () => {
      expect(modelSelector).toContain('activeProviderId: selectedProviderId,');
    });
  });
});
