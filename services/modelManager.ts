import chalk from 'chalk';

import { fetchLlmModels, getLlmApiErrorMessage } from './llm.js';

export async function getModels(baseUrl: string): Promise<string[]> {
    try {
        const models = await fetchLlmModels(baseUrl);
        return models.map((model) => model.name).sort();
    } catch (error) {
        console.error(chalk.red('Error fetching models:'), await getLlmApiErrorMessage(error));
        return [];
    }
}