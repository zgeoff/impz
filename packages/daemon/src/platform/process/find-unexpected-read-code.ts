// A kernel without PSI has no /proc/pressure, and one booted with psi=0 fails
// the read with EOPNOTSUPP.
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EOPNOTSUPP']);

export function findUnexpectedReadCode(error: unknown): string | null {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';

  return UNSUPPORTED_CODES.has(code) ? null : code;
}
