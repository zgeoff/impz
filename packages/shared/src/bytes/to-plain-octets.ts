const DOTTED_ENTRY = /^(?<octets>\d{1,3}(?:\.\d{1,3}){3})(?<prefix>\/\d{1,2})?$/u;

export function toPlainOctets(entry: string): string {
  const groups = DOTTED_ENTRY.exec(entry)?.groups;

  if (groups === undefined) {
    return entry;
  }

  const octets = (groups['octets'] ?? '').split('.').map((octet) => String(Number(octet)));

  return `${octets.join('.')}${groups['prefix'] ?? ''}`;
}
