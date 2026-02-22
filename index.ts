import fs from 'fs';
import path from 'path';
import { select, input, search } from '@inquirer/prompts';
import chalk from 'chalk';
import { TOOLS, handleToolCall, getToolSystemPrompt, shouldNudgeForToolCall, getToolUseNudge } from './tools.js';
import {
    validateOllamaConnection,
    fetchOllamaModels,
    sendOllamaChat,
    getOllamaApiErrorMessage,
} from './ollamaApi.js';
import type { ChatMessage, OllamaModel } from './ollamaApi.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const DEFAULT_NUM_CTX = 65536;

// --- TypeScript Interfaces ---

interface Config {
    baseUrl: string;
    lastModel?: string;
    numCtx?: number;
}

interface SlashCommand {
    name: string;
    value: string;
}

// moved to tools.ts

// --- Functions ---

async function loadConfig(): Promise<Config | null> {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) {
            console.error(chalk.red('Error parsing config file.'));
            return null;
        }
    }
    return null;
}

async function saveConfig(config: Config): Promise<void> {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function setupOllama(): Promise<Config> {
    let config = await loadConfig();

    while (true) {
        if (!config) {
            console.log(chalk.blue('Initial Configuration Required'));
            const host = await input({ message: 'Enter Ollama host (e.g., localhost):', default: 'localhost' });
            const port = await input({ message: 'Enter Ollama port:', default: '11434' });
            config = {
                baseUrl: `http://${host}:${port}`
            };
        }

        try {
            // Validate connection
            await validateOllamaConnection(config.baseUrl, 2000);
            await saveConfig(config);
            return config;
        } catch (error) {
            console.error(chalk.red('\nCould not connect to Ollama at ' + config.baseUrl));
            console.error(chalk.yellow('Please check if Ollama is running and the address is correct.\n'));
            
            const action = await select({
                message: 'What would you like to do?',
                choices: [
                    { name: 'Retry connection', value: 'retry' },
                    { name: 'Edit configuration', value: 'edit' },
                    { name: 'Exit', value: 'exit' }
                ]
            });
            if (action === 'exit') process.exit(0);
            if (action === 'edit') config = null;
            // if retry, loop will continue with existing config
        }
    }
}

async function getModels(baseUrl: string): Promise<string[]> {
    try {
        const models = await fetchOllamaModels(baseUrl);
        return models.map((m: OllamaModel) => m.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), getOllamaApiErrorMessage(error));
        return [];
    }
}

async function startChat(baseUrl: string, model: string, numCtx: number): Promise<void> {
    let currentModel = model;
    let config = await loadConfig() || { baseUrl };
    const models = await getModels(baseUrl);
    console.log(chalk.green(`\nChatting with ${currentModel}. Type 'exit' or '/exit' to quit. Type '/' for commands.`));
    console.log(chalk.dim(`(Using context length num_ctx=${numCtx})`));
    console.log(chalk.dim('(Tool calling enabled — the AI may request to run terminal commands.)\n'));

    const slashCommands: SlashCommand[] = [
        { name: chalk.blue('/model') + ' - Switch LLM model', value: '/model' },
        { name: chalk.blue('/exit') + '  - Exit chat', value: '/exit' },
        { name: chalk.blue('/help') + '  - Show help', value: '/help' }
    ];

    // Persistent message history for the /api/chat endpoint.
    // The system prompt is built from a general section (defined here) combined with
    // the tool-awareness section provided by the tools module.
    const systemPrompt =
        'You are Locopilot, a helpful AI assistant running inside a terminal application.\n\n' +
        getToolSystemPrompt();

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
    ];

    while (true) {
        let prompt: string;
        try {
            prompt = await search({
                message: chalk.cyan('You >'),
                theme: { prefix: '' },
                source: async (inputArg: string | undefined) => {
                    if (!inputArg) {
                        return [{ name: chalk.dim('Type a message or / for commands...'), value: '' }];
                    }

                    if (inputArg.startsWith('/')) {
                        const matches = slashCommands.filter(c => c.value.startsWith(inputArg));
                        if (matches.length > 0) return matches;
                    }

                    return [{ name: inputArg, value: inputArg }];
                },
            });
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') break;
            throw e;
        }

        if (!prompt || prompt.trim() === '') continue;
        if (prompt.toLowerCase() === '/exit' || prompt.toLowerCase() === 'exit') break;

        if (prompt.trim().startsWith('/help')) {
            console.log(chalk.blue('\nAvailable Commands:'));
            slashCommands.forEach(cmd => console.log(`  ${cmd.name}`));
            console.log('');
            continue;
        }

        if (prompt.trim().startsWith('/model')) {
            console.log(chalk.green('\nAvailable models:'));
            models.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

            let selectedModel: string | null = null;
            try {
                selectedModel = await select({
                    message: 'Select a model to chat with:',
                    choices: models.map((m: string) => ({ name: m, value: m })),
                    pageSize: 10
                });
            } catch (e: unknown) {
                if (e instanceof Error && e.name === 'ExitPromptError') {
                    console.log(chalk.yellow('Model selection cancelled.'));
                    continue;
                }
                throw e;
            }

            if (selectedModel) {
                currentModel = selectedModel;
                config.lastModel = currentModel;
                config.numCtx = numCtx;
                await saveConfig(config);
                console.log(chalk.green(`\nSwitched to model: ${currentModel}`));
            }
            continue;
        }

        // Add the user message to history and send to /api/chat
        messages.push({ role: 'user', content: prompt });
        let sentToolRetryNudge = false;
        let emptyResponseRecoveryAttempts = 0;
        const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2;

        try {
            // Tool-call loop: keep sending results back until the LLM has no more tool calls
            while (true) {
                const response = await sendOllamaChat(baseUrl, {
                    model: currentModel,
                    messages,
                    tools: TOOLS,
                    numCtx,
                });

                const assistantMessage = response.message;
                messages.push(assistantMessage);

                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Execute each tool call sequentially then feed results back
                    for (const tc of assistantMessage.tool_calls) {
                        const toolResult = await handleToolCall(
                            tc.function.name,
                            tc.function.arguments,
                        );
                        messages.push({ role: 'tool', content: toolResult });
                    }
                    // Loop again so the LLM can see the tool results and respond
                } else {
                    const assistantContent = assistantMessage.content?.trim() ?? '';

                    if (assistantContent.length === 0 && emptyResponseRecoveryAttempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS) {
                        emptyResponseRecoveryAttempts += 1;
                        messages.push({
                            role: 'user',
                            content:
                                'Your last response was empty. Provide a direct answer now. ' +
                                'If commands are needed, call run_command. If commands already ran, summarize their output and errors.'
                        });
                        continue;
                    }

                    if (!sentToolRetryNudge && assistantContent.length > 0 && shouldNudgeForToolCall(assistantMessage.content)) {
                        sentToolRetryNudge = true;
                        messages.push({ role: 'user', content: getToolUseNudge() });
                        continue;
                    }

                    // No tool calls — this is the final reply
                    const finalContent = assistantContent.length > 0
                        ? assistantMessage.content
                        : '[No response content was returned by the model after tool execution.]';
                    console.log(chalk.yellow('\nAI > ') + finalContent + '\n');
                    config.lastModel = currentModel;
                    config.numCtx = numCtx;
                    await saveConfig(config);
                    break;
                }
            }
        } catch (error) {
            console.error(chalk.red('Error communicating with Ollama:'), getOllamaApiErrorMessage(error));
            // Remove the failed user message so conversation stays consistent
            messages.pop();
        }
    }
}

async function main(): Promise<void> {
    const config = await setupOllama();
    if (!config) {
        // User chose to exit or connection setup failed
        console.log(chalk.yellow('Exiting Locopilot.'));
        process.exit(0);
    }
    console.log(chalk.blue('Fetching models from ' + config.baseUrl + '...'));
    const models = await getModels(config.baseUrl);

    if (!models || models.length === 0) {
        console.log(chalk.red('No models found in Ollama. Please pull a model first (e.g., ollama pull llama3).'));
        return;
    }

    console.log(chalk.green(`Found ${models.length} models:`));
    models.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

    let configData = await loadConfig();
    let selectedModel = configData && configData.lastModel && models.includes(configData.lastModel)
        ? configData.lastModel
        : null;
    const savedNumCtx = configData?.numCtx ?? DEFAULT_NUM_CTX;

    const numCtxInput = await input({
        message: 'Enter context length (num_ctx):',
        default: String(savedNumCtx),
        validate: (value: string) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0
                ? true
                : 'Please enter a positive integer.';
        },
    });
    const selectedNumCtx = Number.parseInt(numCtxInput, 10);

    if (!selectedModel) {
        selectedModel = await select({
            message: 'Select a model to chat with:',
            choices: models.map((m: string) => ({ name: m, value: m })),
            pageSize: 10
        });
        // Save selected model as default
        configData = configData || { baseUrl: config.baseUrl };
        configData.lastModel = selectedModel;
        configData.numCtx = selectedNumCtx;
        await saveConfig(configData);
    } else {
        configData = configData || { baseUrl: config.baseUrl };
        configData.lastModel = selectedModel;
        configData.numCtx = selectedNumCtx;
        await saveConfig(configData);
    }

    await startChat(config.baseUrl, selectedModel, selectedNumCtx);
}

process.on('SIGINT', () => {
    console.log('\nExiting Locopilot.');
    process.exit(0);
});

main().catch(err => {
    if (err && err.name === 'ExitPromptError') {
        // Graceful exit for Ctrl+C
        console.log('\nExiting Locopilot.');
        process.exit(0);
    }
    console.error(chalk.red('An unexpected error occurred:'), err);
});
