import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubIpCommand } from '../../../testing/host-net/build-stub-ip-command';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { parsePrefix64 } from './addressing6';
import {
  checkHostRules6,
  parseIpv6Setting,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './ipv6-plan';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-ipv6-plan-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test.each(['auto', 'off'] as const)(
  '#parseIpv6Setting reads IMP_SUBNET6=%s as that setting',
  (text) => {
    expect(parseIpv6Setting(text)).toStrictEqual({ kind: text });
  },
);

test('#parseIpv6Setting reads a /64 IMP_SUBNET6 as a routed prefix', () => {
  expect(parseIpv6Setting('2001:db8:c::/64')).toStrictEqual({
    kind: 'routed',
    prefix: { network: 0x20_01_0d_b8_00_0c_00_00n << 64n, text: '2001:db8:c::/64' },
  });
});

test('#parseIpv6Setting rejects an IMP_SUBNET6 that is not auto, off or a /64', () => {
  expect(() => parseIpv6Setting('2001:db8:c::/56')).toThrowWithMessage(
    Error,
    'IMP_SUBNET6 must be auto, off or an IPv6 /64, got 2001:db8:c::/56',
  );
});

test('#resolveIpv6Plan gives auto a NAT66 unique local prefix out of the IPv6 default route', async () => {
  const ula = parsePrefix64('fd12:3456:789a::/64');

  invariant(ula);

  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => ula,
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toStrictEqual({ prefix: ula, nat66: true, uplink: 'eth0' });

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
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

  expect(logs).toStrictEqual(['INFO impd.ipv6 fd12:3456:789a::/64, NAT66 out of eth0']);
});

test('#resolveIpv6Plan turns auto off, and removes NAT66, without an IPv6 default route', async () => {
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve(null),
    readUlaPrefix: () => {
      throw new Error('auto with no route makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(logs).toStrictEqual([
    'INFO impd.ipv6 off (IMP_SUBNET6=auto, and the container has no IPv6 default route)',
  ]);
});

test('#resolveIpv6Plan uses a routed /64 as it is, without NAT, via the IPv6 default route', async () => {
  const setting = parseIpv6Setting('2001:db8:c::/64');
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('a routed /64 makes no unique local prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan(setting, deps);

  expect(plan).toStrictEqual({
    prefix: { network: 0x20_01_0d_b8_00_0c_00_00n << 64n, text: '2001:db8:c::/64' },
    nat66: false,
    uplink: 'eth0',
  });

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(logs).toStrictEqual(['INFO impd.ipv6 2001:db8:c::/64, routed via eth0']);
});

test('#resolveIpv6Plan uses a routed /64 with no IPv6 default route, and says so', async () => {
  const setting = parseIpv6Setting('2001:db8:c::/64');
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve(null),
    readUlaPrefix: () => {
      throw new Error('a routed /64 makes no unique local prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan(setting, deps);

  expect(plan?.uplink).toBeNull();

  expect(logs).toStrictEqual([
    'INFO impd.ipv6 2001:db8:c::/64, routed; the container has no IPv6 default route',
  ]);
});

test('#resolveIpv6Plan turns IPv6 off, and removes NAT66, when the setting is off', async () => {
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: mock(() => Promise.resolve('eth0')),
    readUlaPrefix: () => {
      throw new Error('off makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan({ kind: 'off' }, deps);

  expect(plan).toBeNull();
  expect(deps.readDefaultRoute).not.toHaveBeenCalled();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(logs).toStrictEqual(['INFO impd.ipv6 off (IMP_SUBNET6=off)']);
});

test('#resolveIpv6Plan turns IPv6 off when nft cannot remove a NAT66 table, as on a host without nftables', async () => {
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('off makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.reject(new Error('nft: No such file or directory'))),
  };

  const plan = await resolveIpv6Plan({ kind: 'off' }, deps);

  expect(plan).toBeNull();
  expect(deps.runNft).toHaveBeenCalledOnce();
  expect(logs).toStrictEqual(['INFO impd.ipv6 off (IMP_SUBNET6=off)']);
});

test('#resolveIpv6Plan turns IPv6 off, and removes NAT66, when the host lacks its IPv6 rules', async () => {
  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('a host without its rules makes no prefix');
    },
    checkHostRules: () => Promise.resolve('no ip6tables -t filter -A INPUT -i imp+ -j DROP'),
    runNft: mock(() => Promise.resolve()),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(logs).toStrictEqual([
    "INFO impd.ipv6 off (the host's IPv6 rules are not in place: no ip6tables -t filter -A INPUT -i imp+ -j DROP)",
  ]);
});

test('#resolveIpv6Plan turns IPv6 off when the NAT66 table cannot be written', async () => {
  const ula = parsePrefix64('fd12:3456:789a::/64');

  invariant(ula);

  const logs = captureImpdLogs();

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => ula,
    checkHostRules: () => Promise.resolve(null),
    runNft: mock<(script: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Operation not supported'))
      .mockResolvedValue(undefined),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft.mock.calls).toStrictEqual([
    [
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
    ],
    ['table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n'],
  ]);

  expect(logs).toStrictEqual(['INFO impd.ipv6 off (NAT66: Operation not supported)']);
});

test("#checkHostRules6 finds every one of setup-net's IPv6 rules and settings in place", async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-P INPUT ACCEPT',
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
        '',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.directoryPath, 'default'));
  await mkdir(join(ctx.directoryPath, 'all'));
  await writeFile(join(ctx.directoryPath, 'default', 'accept_ra'), '0\n');
  await writeFile(join(ctx.directoryPath, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.directoryPath, 'all', 'forwarding'), '1\n');

  const missing = await checkHostRules6(ctx.directoryPath, ip.run);

  expect(missing).toBeNull();
});

test('#checkHostRules6 names the first missing filter rule', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': '-A INPUT -i imp+ -j DROP\n-A FORWARD -o imp+ -j DROP\n',
    },
  });

  const missing = await checkHostRules6(ctx.directoryPath, ip.run);

  expect(missing).toBe('no ip6tables -t filter -A FORWARD -i imp+ -o imp+ -j DROP');
});

test('#checkHostRules6 names the missing raw rule once the filter rules are in place', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),

      'ip6tables -w -t raw -S': '-P PREROUTING ACCEPT\n-P OUTPUT ACCEPT\n',
    },
  });

  const missing = await checkHostRules6(ctx.directoryPath, ip.run);

  expect(missing).toBe('no ip6tables -t raw -A PREROUTING -i imp+ -m rpfilter --invert -j DROP');
});

test.each(['filter', 'raw'])(
  '#checkHostRules6 reports an ip6tables -t %s that fails',
  async (table) => {
    const ctx = await setupTest();

    const ip = buildStubIpCommand({
      outputs: {
        'ip6tables -w -t filter -S': [
          '-A INPUT -i imp+ -j DROP',
          '-A FORWARD -i imp+ -o imp+ -j DROP',
          '-A FORWARD -o imp+ -j DROP',
          '-A FORWARD -i imp+ -j DROP',
        ].join('\n'),
      },
      failures: {
        [`ip6tables -w -t ${table}`]: `ip6tables v1.8.10 (nf_tables): table '${table}' does not exist`,
      },
    });

    const missing = await checkHostRules6(ctx.directoryPath, ip.run);

    expect(missing).toBe(
      `ip6tables -t ${table}: ip6tables v1.8.10 (nf_tables): table '${table}' does not exist`,
    );
  },
);

test('#checkHostRules6 names an IPv6 sysctl the kernel does not have', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.directoryPath, 'default'));
  await mkdir(join(ctx.directoryPath, 'all'));
  await writeFile(join(ctx.directoryPath, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.directoryPath, 'all', 'forwarding'), '1\n');

  const missing = await checkHostRules6(ctx.directoryPath, ip.run);

  expect(missing).toBe('net.ipv6.conf.default.accept_ra is missing, not 0');
});

test('#checkHostRules6 names an IPv6 sysctl that holds the wrong value', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.directoryPath, 'default'));
  await mkdir(join(ctx.directoryPath, 'all'));
  await writeFile(join(ctx.directoryPath, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.directoryPath, 'default', 'accept_ra'), '0\n');
  await writeFile(join(ctx.directoryPath, 'all', 'forwarding'), '0\n');

  const missing = await checkHostRules6(ctx.directoryPath, ip.run);

  expect(missing).toBe('net.ipv6.conf.all.forwarding is 0, not 1');
});

test('#readOrCreateUlaPrefix makes a unique local prefix on first need and writes it under the data dir', async () => {
  const ctx = await setupTest();

  const prefix = readOrCreateUlaPrefix(join(ctx.directoryPath, 'net', 'ipv6-ula'));

  const written = await readFile(join(ctx.directoryPath, 'net', 'ipv6-ula'), 'utf8');

  expect(parsePrefix64(prefix.text)).toStrictEqual(prefix);
  expect(prefix.text).toStartWith('fd');
  expect(written).toBe(`${prefix.text}\n`);
});

test('#readOrCreateUlaPrefix keeps the unique local prefix it wrote before', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'net'));
  await writeFile(join(ctx.directoryPath, 'net', 'ipv6-ula'), 'fd12:3456:789a::/64\n');

  expect(readOrCreateUlaPrefix(join(ctx.directoryPath, 'net', 'ipv6-ula'))).toStrictEqual({
    network: 0xfd_12_34_56_78_9an << 80n,
    text: 'fd12:3456:789a::/64',
  });
});

test('#readOrCreateUlaPrefix replaces a prefix file it cannot read with a new unique local prefix', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'net'));
  await writeFile(join(ctx.directoryPath, 'net', 'ipv6-ula'), 'junk\n');

  const prefix = readOrCreateUlaPrefix(join(ctx.directoryPath, 'net', 'ipv6-ula'));

  const written = await readFile(join(ctx.directoryPath, 'net', 'ipv6-ula'), 'utf8');

  expect(prefix.text).toStartWith('fd');
  expect(written).toBe(`${prefix.text}\n`);
});
