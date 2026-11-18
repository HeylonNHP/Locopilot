/**
 * A manual `/compact` can be cancelled from the composer.
 *
 * The hooks and components involved are React code with no test renderer in
 * this project, so these are source pins on the three facts the feature rests
 * on (the same approach `tests/slash-command-routing.test.mjs` takes):
 *
 *  1. the compaction registers its AbortController under ITS OWN conversation's
 *     stream key — the key `handleStop` aborts for the conversation on screen —
 *     and not under the reserved key `handleStop` deliberately skips;
 *  2. the compacting state of the composer has a Stop button wired to `onStop`;
 *  3. a cancel reloads the conversation from the database BEFORE adding the
 *     "cancelled" notice (a reload would otherwise erase the notice), and is
 *     worded as a cancel rather than as a lost connection.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const slash = read('src/app/hooks/useSlashCommands.ts');
const compactCase = slash.slice(
  slash.indexOf("case 'compact': {"),
  slash.indexOf("case 'title': {")
);

describe('/compact is cancellable', () => {
  test('registers under the conversation stream key, not the reserved key', () => {
    expect(compactCase).toContain('streamKeyFor(compactSessionId)');
    expect(compactCase).toContain('abortControllersRef.current.set(abortKey, abortController)');
    expect(compactCase).not.toContain('COMPACTION_ABORT_KEY');
  });

  test('only removes its own controller on the way out', () => {
    expect(compactCase).toContain(
      'if (abortControllersRef.current.get(abortKey) === abortController)'
    );
  });

  test('handleStop still skips the reserved key used by /title and /dump', () => {
    const handlers = read('src/app/hooks/useActionHandlers.ts');
    expect(handlers).toContain('if (reservedKeys.has(key)) return;');
    expect(handlers).toContain('streamKeyFor(visibleSessionId)');
  });

  test('the compacting composer has a Stop button wired to onStop', () => {
    const input = read('src/components/InputArea/InputArea.tsx');
    const compacting = input.slice(
      input.indexOf('if (isCompacting) {'),
      input.indexOf('if (isDeletingPrompt)')
    );
    expect(compacting).toContain('onClick={onStop}');
    expect(compacting).toContain('Stop');
  });

  test('a cancel reloads from the database first, then says it was cancelled', () => {
    const abortedAt = compactCase.indexOf('abortController.signal.aborted');
    const reloadAt = compactCase.indexOf('loadSessionMessages(compactSessionId', abortedAt);
    const noticeAt = compactCase.indexOf("'Compaction cancelled.'", abortedAt);
    const lostAt = compactCase.indexOf('isConnectionLossError(err)', abortedAt);
    expect(abortedAt).toBeGreaterThan(-1);
    expect(reloadAt).toBeGreaterThan(abortedAt);
    expect(noticeAt).toBeGreaterThan(reloadAt);
    // The cancel branch is checked before the "connection lost" wording.
    expect(lostAt).toBeGreaterThan(noticeAt);
  });

  test('the reload stays in the background (never switches the view)', () => {
    expect(compactCase).toContain('keepCurrentSession: true');
  });

  test('a Stop that lands after the result arrived is not reported as a cancel', () => {
    expect(compactCase).toContain('abortController.signal.aborted && !resultReceived');
    expect(compactCase).toContain('if (resultReceived) break;');
  });

  test('retry refuses to start while a compaction owns the conversation abort slot', () => {
    const stream = read('src/app/hooks/useChatStream.ts');
    const retry = stream.slice(stream.indexOf('const retry = useCallback'));
    expect(retry.slice(0, 900)).toContain('abortControllersRef.current.has(sessionKey)');
  });
});
