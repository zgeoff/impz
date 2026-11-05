export function buildBenchImpName(namePrefix: string, level: number, index: number): string {
  return `${namePrefix}${String(level)}-${String(index)}`;
}
