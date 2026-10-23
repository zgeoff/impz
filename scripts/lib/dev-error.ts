export class DevError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);

    this.name = 'DevError';
    this.detail = detail;
  }
}
