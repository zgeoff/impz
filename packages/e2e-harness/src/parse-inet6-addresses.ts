export function parseInet6Addresses(shown: string): readonly string[] {
  return [...shown.matchAll(/ inet6 (?<address>[\da-f:]+)\/\d+ scope (?:global|link)/gv)].map(
    (match) => match.groups?.['address'] ?? '',
  );
}
