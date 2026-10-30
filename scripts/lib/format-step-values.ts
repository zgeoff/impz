export function formatStepValues(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}
