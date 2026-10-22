// Single quotes keep every byte literal in bash, and a quote inside closes the word, adds an
// escaped quote and opens it again.
export function formatShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
