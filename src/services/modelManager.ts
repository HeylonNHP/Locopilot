import chalk from 'chalk';

import { fetchLlmModels, getLlmApiErrorMessage } from './llm';

export async function getModels(baseUrl: string): Promise<string[]> {
  try {
    const models = await fetchLlmModels(baseUrl);
    return models.map((model) => model.name).sort();
  } catch (err) {
    console.error(chalk.red('Error fetching models:'), await getLlmApiErrorMessage(err));
    return [];
  }
}

export function resolveCompactionModel(
  compactionModel: string | undefined,
  fallbackModel: string
): string {
  const trimmedModel = compactionModel?.trim();
  return trimmedModel && trimmedModel.length > 0 ? trimmedModel : fallbackModel;
}
