// The last line for the key wins, as it does when systemd reads the env file.
export function findEnvValue(envText: string, key: string): string | null {
  const prefix = `${key}=`;
  const line = envText.split('\n').findLast((entry) => entry.startsWith(prefix));

  return line === undefined ? null : line.slice(prefix.length);
}
