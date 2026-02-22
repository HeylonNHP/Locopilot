import fs from 'fs';
import path from 'path';
import { select, input } from '@inquirer/prompts';
import axios from 'axios';
import chalk from 'chalk';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

async function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    return null;
}

async function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function setupOllama() {
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
            await axios.get(`${config.baseUrl}/api/tags`, { timeout: 2000 });
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

async function getModels(baseUrl) {
    try {
        const response = await axios.get(`${baseUrl}/api/tags`);
        let data = response.data;
        
        // If data is a string, try to parse it
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error(chalk.red('Failed to parse Ollama API response.'));
                return [];
            }
        }

        const models = data.models || [];
        return models.map(m => m.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), error.message);
        return [];
    }
}

async function startChat(baseUrl, model) {
    let currentModel = model;
    let config = await loadConfig();
    const models = await getModels(baseUrl);
    console.log(chalk.green(`\nChatting with ${currentModel}. Type 'exit' to quit.\n`));

    while (true) {
        const prompt = await input({ message: chalk.cyan('You >'), theme: { prefix: '' } });

        if (prompt.toLowerCase() === 'exit') break;

        if (prompt.trim().startsWith('/model')) {
            // Print available models
            console.log(chalk.green(`\nAvailable models:`));
            models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

            // Trigger model selector
            let selectedModel = null;
            try {
                selectedModel = await select({
                    message: 'Select a model to chat with:',
                    choices: models.map(m => ({ name: m, value: m })),
                    pageSize: 10
                });
            } catch (e) {
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
            const response = await axios.post(`${baseUrl}/api/generate`, {
                model: currentModel,
                prompt: prompt,
                stream: false
            });

            console.log(chalk.yellow('\nAI > ') + response.data.response + '\n');
            // Save last used model after successful chat
            config.lastModel = currentModel;
            await saveConfig(config);
        } catch (error) {
            console.error(chalk.red('Error during generation:'), error.message);
        }
    }
}

async function main() {
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
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

    let configData = await loadConfig();
    let selectedModel = configData && configData.lastModel && models.includes(configData.lastModel)
        ? configData.lastModel
        : null;

    if (!selectedModel) {
        selectedModel = await select({
            message: 'Select a model to chat with:',
            choices: models.map(m => ({ name: m, value: m })),
            pageSize: 10
        });
        // Save selected model as default
        configData = configData || {};
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
