import { expect, test } from 'bun:test';
import { probeUnshare } from '../../../testing/host-net/probe-unshare';
import { runInNetns } from '../../../testing/host-net/run-in-netns';
import { buildNat66Removal, buildNat66Ruleset } from './nat66-ruleset';

test('#buildNat66Removal deletes the NAT66 table whether or not it exists', () => {
  expect(buildNat66Removal()).toBe('table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n');
});

test('#buildNat66Ruleset masquerades the prefix out of the uplink in a table of its own', () => {
  expect(buildNat66Ruleset('fd12:3456:789a::/64', 'eth0')).toBe(
    [
      'table ip6 imp_nat66 {}',
      'delete table ip6 imp_nat66',
      'table ip6 imp_nat66 {',
      '  chain postrouting {',
      '    type nat hook postrouting priority srcnat; policy accept;',
      '    oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
});

test.skipIf(!probeUnshare(['nft', 'list', 'ruleset']))(
  "#buildNat66Ruleset masquerades the guests' prefix out the uplink, applied twice",
  () => {
    const nat66 = buildNat66Ruleset('fd12:3456:789a::/64', 'eth0');

    const run = runInNetns({
      script: `
printf '%s' "$NAT66" | nft -f -
printf '%s' "$NAT66" | nft -f -
nft list chain ip6 imp_nat66 postrouting | grep masquerade | sed 's/^[[:space:]]*//'
`,
      env: { NAT66: nat66 },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: 'oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!probeUnshare(['nft', 'list', 'ruleset']))(
  '#buildNat66Removal applies where there is no NAT66 table',
  () => {
    const removal = buildNat66Removal();

    const run = runInNetns({
      script: `
printf '%s' "$REMOVAL" | nft -f -
nft list tables
`,
      env: { REMOVAL: removal },
      mount: false,
    });

    expect(run).toStrictEqual({ stdout: '', stderr: '', exitCode: 0 });
  },
);

test.skipIf(!probeUnshare(['nft', 'list', 'ruleset']))(
  '#buildNat66Removal removes the NAT66 table',
  () => {
    const nat66 = buildNat66Ruleset('fd12:3456:789a::/64', 'eth0');
    const removal = buildNat66Removal();

    const run = runInNetns({
      script: `
printf '%s' "$NAT66" | nft -f -
nft list tables
printf '%s' "$REMOVAL" | nft -f -
nft list tables
`,
      env: { NAT66: nat66, REMOVAL: removal },
      mount: false,
    });

    expect(run).toStrictEqual({ stdout: 'table ip6 imp_nat66\n', stderr: '', exitCode: 0 });
  },
);
