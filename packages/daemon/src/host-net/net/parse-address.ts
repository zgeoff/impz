import { IPv4, IPv6 } from 'ipaddr.js';

export function parseAddress(text: string): IPv4 | IPv6 | null {
  // ipaddr.js also reads the short and hex IPv4 forms, such as 127.1, which
  // inet_aton accepts and ip, nft and the guests never write
  if (IPv4.isValidFourPartDecimal(text)) {
    return IPv4.parse(text);
  }

  // a zone names a link of this host, never a destination elsewhere
  if (text.includes('%')) {
    return null;
  }

  const hex = toHexGroups(text);

  return hex !== null && IPv6.isValid(hex) ? IPv6.parse(hex) : null;
}

// ipaddr.js reads ::a.b.c.d as the mapped ::ffff:a.b.c.d, and accepts hex and
// short forms in the embedded IPv4 part, so the part goes in as two hex groups
function toHexGroups(text: string): string | null {
  const split = text.lastIndexOf(':');
  const tail = text.slice(split + 1);

  if (!tail.includes('.')) {
    return text;
  }

  if (!IPv4.isValidFourPartDecimal(tail)) {
    return null;
  }

  const [first = 0, second = 0, third = 0, fourth = 0] = IPv4.parse(tail).octets;

  return `${text.slice(0, split + 1)}${toGroup(first, second)}:${toGroup(third, fourth)}`;
}

function toGroup(high: number, low: number): string {
  return (high * 256 + low).toString(16);
}
