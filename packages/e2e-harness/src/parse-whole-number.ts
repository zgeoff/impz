export function parseWholeNumber(text: string, what: string): number {
  const trimmed = text.trim();

  if (!/^\d+$/v.test(trimmed)) {
    throw new Error(`${what}: not a whole number: ${JSON.stringify(text)}`);
  }

  return Number(trimmed);
}
