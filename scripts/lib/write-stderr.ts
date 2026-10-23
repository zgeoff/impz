export function writeStderr(text: string): void {
  process.stderr.write(text);
}
