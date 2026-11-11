// Every value of every header that the Imp-Identity name stands for after a
// server folds an underscore into a hyphen, one entry per line received.
export function collectIdentityLines(headers: Headers): string[] {
  return headers
    .entries()
    .filter(([name]) => name.replaceAll('_', '-') === 'imp-identity')
    .map(([, value]) => value)
    .toArray();
}
