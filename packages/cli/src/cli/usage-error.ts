export class UsageError extends Error {
  override name = 'UsageError';
}

export class CommandExitError extends Error {
  override name = 'CommandExitError';

  readonly code: number;

  // the command left handles open, such as a terminal in raw mode, so the
  // process exits at once instead of when they close
  readonly mustExit: boolean;

  constructor(code: number, mustExit = false) {
    super(`exit ${String(code)}`);

    this.code = code;
    this.mustExit = mustExit;
  }
}

export class CommandLineError extends Error {
  override name = 'CommandLineError';

  readonly command: string;

  readonly refusal: AggregateError;

  constructor(command: string, refusal: AggregateError) {
    super(refusal.message, { cause: refusal });

    this.command = command;
    this.refusal = refusal;
  }
}
