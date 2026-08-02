/**
 * Standalone provider-name constants for Locopilot.
 *
 * Lives in its own module so consumers (and `capabilityUnions.ts`) can import
 * the union + named constants without pulling in the larger `chatConfig`
 * types barrel. The `LlmProvider` type itself is still imported from
 * `@/types/chatConfig` — this module only owns the runtime constants.
 */

import type { LlmProvider } from '@/types/chatConfig';

/** `as const` tuple of every provider name. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ['ollama', 'openai-compatible'];

/** Named constants for the two providers so validation messages don't drift. */
export const PROVIDER_OLLAMA = 'ollama' as const satisfies LlmProvider;
export const PROVIDER_OPENAI_COMPATIBLE = 'openai-compatible' as const satisfies LlmProvider;
