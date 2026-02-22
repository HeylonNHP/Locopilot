import fs from 'fs';
import path from 'path';
import { select, input, search } from '@inquirer/prompts';
import axios, { AxiosError } from 'axios';
import chalk from 'chalk';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// --- TypeScript Interfaces ---

interface Config {
    baseUrl: string;
    lastModel?: string;
}

interface OllamaModelDetails {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
}

interface OllamaModel {
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
    details: OllamaModelDetails;
}

interface TagsResponse {
    models: OllamaModel[];
}

interface GenerateResponse {
    model: string;
    created_at: string;
    response: string;
    done: boolean;
    context?: number[];
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}

interface SlashCommand {
    name: string;
    value: string;
}

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
            await axios.get<TagsResponse>(`${config.baseUrl}/api/tags`, { timeout: 2000 });
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
        const response = await axios.get<TagsResponse>(`${baseUrl}/api/tags`);
        const data = response.data;
        
        const models = data.models || [];
        return models.map((m: OllamaModel) => m.name).sort();
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(chalk.red('Error fetching models:'), error.message);
        } else {
            console.error(chalk.red('An unexpected error occurred:'), error);
        }
        return [];
    }
}

async function startChat(baseUrl: string, model: string): Promise<void> {
    let currentModel = model;
    let config = await loadConfig() || { baseUrl };
    const models = await getModels(baseUrl);
    console.log(chalk.green(`\nChatting with ${currentModel}. Type 'exit' or '/exit' to quit. Type '/' for commands.\n`));

    const slashCommands: SlashCommand[] = [
        { name: chalk.blue('/model') + ' - Switch LLM model', value: '/model' },
        { name: chalk.blue('/exit') + '  - Exit chat', value: '/exit' },
        { name: chalk.blue('/help') + '  - Show help', value: '/help' }
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
        } catch (e: any) {
            if (e.name === 'ExitPromptError') break;
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
            // Print available models
            console.log(chalk.green(`\nAvailable models:`));
            models.forEach((m: string, i: number) => console.log(`  ${i + 1}. ${m}`));

            // Trigger model selector
            let selectedModel: string | null = null;
            try {
                selectedModel = await select({
                    message: 'Select a model to chat with:',
                    choices: models.map((m: string) => ({ name: m, value: m })),
                    pageSize: 10
                });
            } catch (e: any) {
                if (e.name === 'ExitPromptError') {
                    console.log(chalk.yellow('Model selection cancelled.'));
                    continue; // Stay with current model
                }
                throw e;
            }

            if (selectedModel) {
                currentModel = selectedModel;
                config.lastModel = currentModel;
                await saveConfig(config);
                console.log(chalk.green(`\nSwitched to model: ${currentModel}`));
            }
            continue;
        }

        try {
            const response = await axios.post<GenerateResponse>(`${baseUrl}/api/generate`, {
                model: currentModel,
                prompt: prompt,
                stream: false
            });

            console.log(chalk.yellow('\nAI > ') + response.data.response + '\n');
            // Save last used model after successful chat
            config.lastModel = currentModel;
            await saveConfig(config);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(chalk.red('Error during generation:'), error.message);
            } else {
                console.error(chalk.red('An unexpected error occurred:'), error);
            }
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

    if (!selectedModel) {
        selectedModel = await select({
            message: 'Select a model to chat with:',
            choices: models.map((m: string) => ({ name: m, value: m })),
            pageSize: 10
        });
        // Save selected model as default
        configData = configData || { baseUrl: config.baseUrl };
        configData.lastModel = selectedModel;
        await saveConfig(configData);
    }

    await startChat(config.baseUrl, selectedModel);
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
