const NAT66_TABLE = 'ip6 imp_nat66';

export function buildNat66Ruleset(prefix: string, uplink: string): string {
  return [
    `table ${NAT66_TABLE} {}`,
    `delete table ${NAT66_TABLE}`,
    `table ${NAT66_TABLE} {`,
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname "${uplink}" ip6 saddr ${prefix} masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}

export function buildNat66Removal(): string {
  return `table ${NAT66_TABLE} {}\ndelete table ${NAT66_TABLE}\n`;
}
