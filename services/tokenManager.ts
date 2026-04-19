import chalk from 'chalk';
import { clearLiveStatus, updatePhase } from '../statusLine';
import { countMessagesTokens } from '../services/tokenizer';
import { compactHistory, printCompactStats } from '../services/compact';
import { resolveCompactionModel } from '../services/modelManager';
import type { ChatMessage } from '../services/llm';
import type { Config } from '../slashCommands';
import type { SessionTokenStats } from '../history';
import { AUTO_COMPACT_THRESHOLD_PCT, COMPACT_WARNING_THRESHOLD_PCT, COMPACT_WARNING_TOKEN_INTERVAL } from '../constants';

/**
 * Creates a token manager instance with its own state.
 * @returns Object containing token management functions
 */
export function createTokenManager() {
    let lastCompactWarningTokens = 0;
    let lastAuthoritativeTokens = 0;
    let estimatedTokensAtAuthoritative = 0;

    /**
     * Gets the current token estimate, using Ollama's authoritative count when available.
     * @param messages - Array of chat messages
     * @param currentModel - The currently selected model name
     * @returns Estimated token count
     */
    function getCurrentTokenEstimate(messages: ChatMessage[], currentModel: string): number {
        const rawEstimate = countMessagesTokens(messages, currentModel);
        if (lastAuthoritativeTokens > 0 && estimatedTokensAtAuthoritative > 0) {
            // Apply the delta of recent messages to our last known exact count
            return Math.max(0, lastAuthoritativeTokens + (rawEstimate - estimatedTokensAtAuthoritative));
        }
        return rawEstimate;
    }

    /**
     * Refreshes the token status display.
     * @param phase - Current phase description
     * @param tokensUsedOverride - Optional token count override
     * @param tokenSource - Source of token count ('estimated' or 'ollama')
     * @param modelOverride - Optional model name override
     * @param numCtx - Current context limit
     * @param currentModel - Current model name
     */
    function refreshTokenStatus(
        phase: string,
        tokensUsedOverride?: number,
        tokenSource: 'estimated' | 'ollama' = 'estimated',
        modelOverride?: string,
        numCtx: number = 0,
        currentModel: string = '',
    ) {
        // Create a dummy messages array for the estimation - in reality this would come from context
        const dummyMessages: ChatMessage[] = [];
        const tokensUsed = tokensUsedOverride ?? getCurrentTokenEstimate(dummyMessages, currentModel);
        
        updatePhase(phase, {
            tokensUsed,
            tokenLimit: numCtx,
            model: modelOverride ?? currentModel,
            tokenSource,
        });

        // ── Suggestion #7: Auto-compact warning (once every 500 tokens after 85%) 
        if (numCtx > 0) {
            const percentage = (tokensUsed / numCtx) * 100;
            // Only warn if >85% full and we haven't warned in the last 500 tokens
            if (percentage >= COMPACT_WARNING_THRESHOLD_PCT && (tokensUsed - lastCompactWarningTokens) > COMPACT_WARNING_TOKEN_INTERVAL) {
                lastCompactWarningTokens = tokensUsed;
                clearLiveStatus();
                console.log(
                    chalk.yellow.bold(`\n⚠️  Context is ${percentage.toFixed(0)}% full. `) +
                    chalk.yellow(`Consider running `) + chalk.cyan(`/compact`) + chalk.yellow(` to save tokens.\n`)
                );
            }
        }
        // ─────────────────────────────────────────────────────────────
    }

    /**
     * Prints the final token snapshot after an AI turn.
     * @param tokensUsed - Number of tokens used
     * @param numCtx - Context limit
     * @param currentModel - Current model name
     */
    function printFinalTokenSnapshot(tokensUsed: number, numCtx: number, currentModel: string): void {
        const percentage = numCtx > 0
            ? Math.min(100, Math.round((tokensUsed / numCtx) * 100))
            : 0;
        const pctColor = percentage >= 90
            ? chalk.red
            : percentage >= 75
                ? chalk.yellow
                : chalk.green;

        console.log(
            chalk.dim(`[${currentModel}] `) +
            pctColor(`${tokensUsed}/${numCtx} tokens`) +
            chalk.dim(` (${percentage}%)`) +
            chalk.cyan.dim(' (ollama)') +
            chalk.dim(` (Used ${tokensUsed} ${tokensUsed === 1 ? 'token' : 'tokens'})`),
        );
    }

    /**
     * Updates the authoritative token count from Ollama.
     * @param promptEvalCount - Ollama's prompt eval count
     * @param evalCount - Ollama's eval count
     * @param messages - Current messages (for estimating)
     * @param currentModel - Current model name
     */
    function updateAuthoritativeTokens(
        promptEvalCount: number,
        evalCount: number,
        messages: ChatMessage[],
        currentModel: string
    ): void {
        lastAuthoritativeTokens = promptEvalCount + evalCount;
        estimatedTokensAtAuthoritative = countMessagesTokens(messages, currentModel);
    }

    return {
        getCurrentTokenEstimate,
        refreshTokenStatus,
        printFinalTokenSnapshot,
        updateAuthoritativeTokens
    };
}