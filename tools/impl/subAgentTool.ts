import chalk from 'chalk';

import { AUTO_COMPACT_THRESHOLD_PCT } from '../../constants';
import { compactHistory } from '../../services/compact';
import { sendLlmChat, type ChatMessage, type ToolCall, type ToolDefinition } from '../../services/llm';
import { sanitizeChatMessage } from '../../services/textUtils';
import { countMessagesTokens } from '../../services/tokenizer';
import { isInterruptRequested } from '../interruptManager';
import {
    toolRegistry,
    type IToolCommand,
    type RequestContext,
    type SubAgentConfig,
    type ToolCallArguments,
    type ToolCallResult,
} from '../toolRegistry';
import { terminalToolOutputSink, type ToolOutputSink } from '../toolOutput';

interface SubAgentSpec {
    id?: string;
    prompt?: string;
}

interface SubAgentToolArgs extends ToolCallArguments {
    agents?: SubAgentSpec[];
}

interface CompletedSubAgent {
    id: string;
    content: string;
}

const SUB_AGENT_AUTO_COMPACT_NOTICE =
    'The conversation history was automatically compacted due to context length. ' +
    'The original orchestrator request has been preserved verbatim above. ' +
    'Please continue working on that request without asking for confirmation.';

function buildSubAgentSystemPrompt(): string {
    const dateTimeStr = new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
    });

    return (
        'You are a focused sub-agent running inside Locopilot.\n' +
        `Current date and time: ${dateTimeStr}\n\n` +
        'You are isolated from the parent conversation. The parent agent will provide all required context in the user message.\n' +
        'Use the available tools when they materially help complete the task.\n' +
        'Work autonomously until the task is complete.\n' +
        'When you are done, return one final concise, self-contained summary for the parent agent.\n' +
        'Do not ask the parent agent for missing context; instead, explain briefly what is missing if the task is blocked.\n' +
        'Do not mention internal chain-of-thought.\n'
    );
}

function prefixLines(message: string, prefix: string): string[] {
    return message
        .split(/\r?\n/)
        .map((line) => `${prefix}${line}`);
}

function makeLabeledSink(baseSink: ToolOutputSink, id: string): ToolOutputSink {
    const prefix = `${chalk.dim(`[sub-agent: ${id}]`)} `;

    return {
        writeLine(message: string): void {
            for (const line of prefixLines(message, prefix)) {
                baseSink.writeLine(line);
            }
        },
        writeInline(): void {
            // Suppress nested live updates to avoid noisy overlapping spinners.
        },
        clearInline(): void {
            // Suppress nested live updates to avoid noisy overlapping spinners.
        },
    };
}

async function autoCompactSubAgentIfNeeded(
    messages: ChatMessage[],
    config: SubAgentConfig,
    output: ToolOutputSink,
    agentId: string,
    orchestratorPrompt: ChatMessage,
): Promise<boolean> {
    if (config.numCtx <= 0) {
        return false;
    }

    // ── Guard: don't compact until there is enough history ───────────────────
    // When a sub-agent has only system + orchestrator prompt + a single
    // assistant response (or fewer), splitHistoryForCompaction can produce an
    // empty messagesToSummarise array because the sliding-window preservation
    // logic consumes everything after the latest user message (which sits at
    // index 0 of historyMessages).  The anchor-rescue fallback then has nothing
    // to put into messagesToSummarise, so countMessagesTokens([], model) returns
    // exactly 2 — the tokenizer's +2 overhead — yielding the cryptic error:
    //   "The conversation history is too short to compact (~2 tokens)."
    //
    // MIN_SUMMARISE_TOKENS is 200, so a short sub-agent history (which is
    // structurally different from the main chat because it starts with a single
    // user prompt and builds assistant/tool turns from there) will always trip
    // the guard and abort.  Rather than letting it reach compactHistory and
    // crash, we bail early here.  A sub-agent needs at least system + user +
    // assistant + one tool result (4 messages total) before compaction is
    // meaningful and the split logic has enough material to work with.
    //
    // See also the matching guard in app/api/chat/route.ts and the fallback
    // in services/compact.ts (anchorIndex === 0 branch).
    // ──────────────────────────────────────────────────────────────────────────
    if (messages.length < 4) {
        return false;
    }

    const tokensUsed = countMessagesTokens(messages, config.model);
    const pct = (tokensUsed / config.numCtx) * 100;
    if (pct < AUTO_COMPACT_THRESHOLD_PCT) {
        return false;
    }

    const labeledOutput = makeLabeledSink(output, agentId);
    labeledOutput.writeLine(
        chalk.yellow(`⚡ Context at ${pct.toFixed(0)}% — auto-compacting before continuing...`),
    );

    try {
        const result = await compactHistory(
            config.baseUrl,
            config.compactionModel,
            messages,
            config.numCtx,
        );

        const orchestratorPromptIndex = result.newMessages.findIndex(
            (message, index) =>
                index > 0 &&
                message.role === 'user' &&
                message.content === orchestratorPrompt.content,
        );

        if (orchestratorPromptIndex > 1) {
            result.newMessages.splice(orchestratorPromptIndex, 1);
            result.newMessages.splice(1, 0, orchestratorPrompt);
        } else if (orchestratorPromptIndex < 0) {
            result.newMessages.splice(1, 0, orchestratorPrompt);
        }

        messages.splice(0, messages.length, ...result.newMessages);
        messages.push({
            role: 'user',
            content: SUB_AGENT_AUTO_COMPACT_NOTICE,
        });

        if (result.stats.newTokenCount > config.numCtx) {
            labeledOutput.writeLine(
                chalk.red(
                    `⚠ Compaction reduced context but history is still over the model limit ` +
                    `(${result.stats.newTokenCount}/${config.numCtx} tokens). The next turn may fail.`,
                ),
            );
        }

        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        labeledOutput.writeLine(chalk.red(`⚠ Auto-compaction failed: ${message}`));
        return false;
    }
}

function validateAgentSpecs(agents: SubAgentSpec[] | undefined): string | null {
    if (!Array.isArray(agents) || agents.length === 0) {
        return '[Error: missing required argument "agents"]';
    }

    for (const [index, agent] of agents.entries()) {
        if (!agent || typeof agent !== 'object') {
            return `[Error: invalid agent at index ${index} (expected an object)]`;
        }
        if (typeof agent.id !== 'string' || agent.id.trim().length === 0) {
            return `[Error: invalid agent at index ${index} (missing non-empty string "id")]`;
        }
        if (typeof agent.prompt !== 'string' || agent.prompt.trim().length === 0) {
            return `[Error: invalid agent at index ${index} (missing non-empty string "prompt")]`;
        }
    }

    return null;
}

function formatCombinedResults(results: CompletedSubAgent[], interrupted: boolean): string {
    const sections = results.map((result) => {
        const content = result.content.trim().length > 0
            ? result.content.trim()
            : '[Sub-agent completed without a final text response.]';

        return [
            `sub_agent: ${result.id}`,
            'final_response:',
            content,
        ].join('\n');
    });

    if (sections.length === 0) {
        sections.push('[run_subagents completed without any sub-agent results.]');
    }

    if (interrupted) {
        sections.push('[run_subagents interrupted by user.]');
    }

    return sections.join('\n\n---\n\n');
}

async function executeNestedToolCall(
    agentId: string,
    toolCall: ToolCall,
    output: ToolOutputSink,
    onProgress?: (message: string) => void,
    context?: RequestContext,
): Promise<ToolCallResult> {
    const toolName = toolCall.function.name;
    const nestedProgress = onProgress
        ? (message: string) => onProgress(`Sub-agent ${agentId}: ${message}`)
        : undefined;

    if (toolName === 'run_subagents') {
        return { content: '[Error: run_subagents is unavailable inside sub-agents.]' };
    }

    const command = toolRegistry.get(toolName);
    if (!command) {
        return { content: `[Unknown tool: ${toolName}]` };
    }

    if (toolName === 'run_command') {
        output.writeLine(chalk.yellow(`\n[Sub-agent: ${agentId}] is requesting a command:`));
        return command.execute(
            toolCall.function.arguments,
            nestedProgress,
            output,
            context,
        );
    }

    return command.execute(toolCall.function.arguments, nestedProgress, output, context);
}

async function runSingleAgent(
    agent: Required<SubAgentSpec>,
    config: SubAgentConfig,
    tools: ToolDefinition[],
    output: ToolOutputSink,
    onProgress?: (message: string) => void,
    context?: RequestContext,
): Promise<string> {
    const orcPrompt: ChatMessage = { role: 'user', content: agent.prompt };
    const labeledOutput = makeLabeledSink(output, agent.id);
    const messages: ChatMessage[] = [
        { role: 'system', content: buildSubAgentSystemPrompt() },
        orcPrompt,
    ];

    let finalContent = '';

    while (!isInterruptRequested()) {
        await autoCompactSubAgentIfNeeded(messages, config, labeledOutput, agent.id, orcPrompt);
        if (isInterruptRequested()) {
            break;
        }

        onProgress?.(`Sub-agent ${agent.id}: thinking`);

        const response = await sendLlmChat(config.baseUrl, {
            model: config.model,
            messages,
            tools,
            numCtx: config.numCtx,
        }, (chunk) => {
            // Route live thinking/content tokens to the output sink so web
            // callers can stream them into the subagent bubble in real time.
            // A newline is prepended the first time each type appears in this
            // chunk sequence so thinking and content are visually separated.
            if (chunk.message?.thinking) {
                output.writeAgentChunk?.(agent.id, 'thinking', chunk.message.thinking);
            }
            if (chunk.message?.content) {
                output.writeAgentChunk?.(agent.id, 'content', chunk.message.content);
            }
        });

        // Emit a trailing newline so successive tool outputs and the next LLM
        // turn are visually separated from the streamed response text.
        output.writeAgentChunk?.(agent.id, 'content', '\n');

        const assistantMessage = sanitizeChatMessage(response.message);
        messages.push(assistantMessage);

        if (assistantMessage.content.trim().length > 0) {
            finalContent = assistantMessage.content.trim();
        }

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
            onProgress?.(`Sub-agent ${agent.id}: completed`);
            break;
        }

        for (const toolCall of assistantMessage.tool_calls) {
            if (isInterruptRequested()) {
                break;
            }

            onProgress?.(`Sub-agent ${agent.id}: ${toolCall.function.name}`);

            const toolResult = await executeNestedToolCall(agent.id, toolCall, labeledOutput, onProgress, context);
            messages.push(sanitizeChatMessage({
                role: 'tool',
                content: toolResult.content,
                ...(toolResult.images ? { images: toolResult.images } : {}),
            }));
        }
    }

    return finalContent;
}

export class SubAgentTool implements IToolCommand {
    async execute(
        args: ToolCallArguments,
        onProgress?: (message: string) => void,
        output: ToolOutputSink = terminalToolOutputSink,
        context?: RequestContext,
    ): Promise<ToolCallResult> {
        const subAgentArgs = args as SubAgentToolArgs;
        const validationError = validateAgentSpecs(subAgentArgs.agents);
        if (validationError) {
            return { content: validationError };
        }

        const config = context?.subAgent;
        if (!config || !config.baseUrl || !config.model || config.numCtx <= 0 || config.tools.length === 0) {
            return {
                content:
                    '[run_subagents error: sub-agent runtime is not configured. ' +
                    'Ensure a valid RequestContext with subAgent config is provided.]',
            };
        }

        const results: CompletedSubAgent[] = [];

        for (const agent of subAgentArgs.agents as Required<SubAgentSpec>[]) {
            if (isInterruptRequested()) {
                break;
            }

            try {
                const content = await runSingleAgent(agent, config, config.tools, output, onProgress, context);
                results.push({ id: agent.id, content });
            } catch (error) {
                results.push({
                    id: agent.id,
                    content: `[Sub-agent error: ${error instanceof Error ? error.message : String(error)}]`,
                });
            }
        }

        return {
            content: formatCombinedResults(results, isInterruptRequested()),
        };
    }
}

export function getToolPrompt(): string {
    return (
        '8. run_subagents(agents)\n' +
        '   Delegate independent subtasks to isolated workers that each run their own full tool-calling loop.\n' +
        '   USE THIS TOOL when a task can be broken into separate, bounded units of work — for example:\n' +
        '     • Researching multiple topics independently\n' +
        '     • Editing several unrelated files without cross-contaminating context\n' +
        '     • Running multi-step investigations in parallel logical streams\n' +
        '     • Performing comparisons, audits, or summaries across independent sources\n' +
        '   Each sub-agent has access to all normal tools (run_command, web_search, read_file, patch_file, etc.)\n' +
        '   and iterates autonomously until its task is complete — you get only the final answer back.\n' +
        '   This keeps the parent conversation concise and focused while sub-agents do the heavy lifting.\n' +
        '   Constraints: sub-agents are sequential; each sees only its own prompt (include all context inline);\n' +
        '   sub-agents cannot spawn further sub-agents.\n\n'
    );
}
