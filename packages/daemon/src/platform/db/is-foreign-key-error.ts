// a foreign key stopped a delete of an image row; the message names the table, not the cause
export function isForeignKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
  );
}
