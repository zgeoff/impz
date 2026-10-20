import { expect, test } from 'bun:test';
import { isPeerAccept } from './is-peer-accept';

test.each([
  [
    'setup-net.sh’s rule',
    '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT',
    true,
  ],
  [
    'the rule without its mark',
    '-A FORWARD -i imp+ -o imp+ -m comment --comment imp-network -j ACCEPT',
    false,
  ],
  [
    'the rule without its comment',
    '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -j ACCEPT',
    false,
  ],
  [
    'the rule with another mask',
    '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x3000000 -m comment --comment imp-network -j ACCEPT',
    false,
  ],
  [
    'the rule that drops',
    '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j DROP',
    false,
  ],
  [
    'the rule with text after its jump',
    '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT ',
    false,
  ],
  ['an empty line', '', false],
])(
  'it counts only setup-net.sh’s exact rule as the peer accept, given %s',
  (_kind, rule, expected) => {
    const isAccept = isPeerAccept(rule);

    expect(isAccept).toBe(expected);
  },
);
