// impd answers a path no procedure matches with a plain-text 404, which
// oRPC cannot parse.
export class UnknownProcedureError extends Error {
  readonly procedure: string;

  constructor(procedure: string) {
    super(`impd has no procedure ${procedure}`);

    this.name = 'UnknownProcedureError';
    this.procedure = procedure;
  }
}
