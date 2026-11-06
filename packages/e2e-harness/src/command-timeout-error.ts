export class CommandTimeoutError extends Error {
  constructor(argv: readonly string[], timeoutMs: number) {
    super(`${argv.join(' ')} ran past its limit of ${String(timeoutMs)} ms and was killed`);

    this.name = 'CommandTimeoutError';
  }
}
