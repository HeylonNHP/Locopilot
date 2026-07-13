export function resolveCompactionModel(
  compactionModel: string | undefined,
  fallbackModel: string
): string {
  const trimmedModel = compactionModel?.trim();
  return trimmedModel && trimmedModel.length > 0 ? trimmedModel : fallbackModel;
}
