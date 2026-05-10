/**
 * titleUtils.ts
 *
 * Shared helpers for generating session fallback titles.
 */

/**
 * Generates a fallback session title from a text snippet.
 * Trims whitespace, truncates to 60 characters, and falls back to 'Chat'.
 */
export function generateFallbackTitle(sourceText: string): string {
    return sourceText.trim().slice(0, 60) || 'Chat';
}
