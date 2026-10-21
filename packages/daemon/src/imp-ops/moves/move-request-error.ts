export class MoveRequestError extends Error {
  override name = 'MoveRequestError';

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);

    this.status = status;
  }
}
