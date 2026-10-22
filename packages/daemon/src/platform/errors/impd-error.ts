export interface ImpdErrorOptions {
  readonly message: string;
  readonly status?: number | undefined;
  readonly data?: unknown;
  readonly cause?: unknown;
}

export class ImpdError<TCode extends string = string> extends Error {
  override name = 'ImpdError';

  readonly code: TCode;

  readonly status: number | undefined;

  readonly data: unknown;

  constructor(code: TCode, options: ImpdErrorOptions) {
    super(options.message, buildErrorOptions(options.cause));

    this.code = code;
    this.status = options.status;
    this.data = options.data;
  }
}

export function isImpdError<TCode extends string>(
  error: unknown,
  code: TCode,
): error is ImpdError<TCode> {
  return error instanceof ImpdError && error.code === code;
}

function buildErrorOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}
