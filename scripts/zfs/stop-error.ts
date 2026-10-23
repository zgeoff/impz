export class StopError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`stopped by a signal, exit ${String(exitCode)}`);

    this.name = 'StopError';
    this.exitCode = exitCode;
  }
}
