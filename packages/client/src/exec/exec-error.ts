export type ExecClientErrorCode =
  | 'UNAUTHORIZED'
  | 'UNREACHABLE'
  | 'RESTARTING'
  | 'CONNECTION_CLOSED'
  | 'DETACHED'
  | 'BAD_MESSAGE'
  | 'CLOSED'
  | 'OUTPUT_OVERFLOW'
  | 'LOCAL_ERROR';

export class ExecError extends Error {
  readonly code: string;

  readonly data: unknown;

  constructor(
    code: string,
    message: string,
    options: Readonly<{ data?: unknown; cause?: unknown }> = {},
  ) {
    const errorOptions = options.cause === undefined ? {} : { cause: options.cause };

    super(message, errorOptions);

    this.name = 'ExecError';
    this.code = code;
    this.data = options.data;
  }
}
