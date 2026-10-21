export class ImpClashError extends Error {
  override name = 'ImpClashError';

  readonly column: string;

  constructor(column: string) {
    super(`another imp has this ${column}`);

    this.column = column;
  }
}
