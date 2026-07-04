export const fts5QueryForText = (query: string): string | undefined => {
  const tokens = query.match(/[\p{L}\p{N}]+/gu)?.map((token) => token.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
};

export const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
