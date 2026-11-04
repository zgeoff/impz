export function readImpEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith('IMP_') && entry[1] !== undefined,
    ),
  );
}
