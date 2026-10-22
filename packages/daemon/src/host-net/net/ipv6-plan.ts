import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { buildUlaPrefix, parsePrefix64 } from './addressing6';
import type { Prefix64 } from './addressing6';
import { buildNat66Removal, buildNat66Ruleset } from './nat66-ruleset';

export type Ipv6Setting =
  | { readonly kind: 'auto' }
  | { readonly kind: 'off' }
  | { readonly kind: 'routed'; readonly prefix: Prefix64 };

export interface Ipv6Plan {
  readonly prefix: Prefix64;

  readonly nat66: boolean;
  readonly uplink: string | null;
}

export function parseIpv6Setting(text: string): Ipv6Setting {
  if (text === 'auto' || text === 'off') {
    return { kind: text };
  }

  const prefix = parsePrefix64(text);

  if (prefix === null) {
    throw new Error(`IMP_SUBNET6 must be auto, off or an IPv6 /64, got ${text}`);
  }

  return { kind: 'routed', prefix };
}

export interface Ipv6PlanDeps {
  readonly readDefaultRoute: () => Promise<string | null>;

  readonly readUlaPrefix: () => Prefix64;

  readonly checkHostRules: () => Promise<string | null>;
  readonly runNft: (script: string) => Promise<void>;
  readonly log: (message: string) => void;
}

export async function resolveIpv6Plan(
  setting: Ipv6Setting,
  deps: Ipv6PlanDeps,
): Promise<Ipv6Plan | null> {
  const stopIpv6 = async (reason: string): Promise<null> => {
    await removeNat66(deps);

    deps.log(`impd: ipv6: off (${reason})`);

    return null;
  };

  if (setting.kind === 'off') {
    return stopIpv6('IMP_SUBNET6=off');
  }

  const uplink = await deps.readDefaultRoute();

  if (setting.kind === 'auto' && uplink === null) {
    return stopIpv6('IMP_SUBNET6=auto, and the container has no IPv6 default route');
  }

  const missing = await deps.checkHostRules();

  if (missing !== null) {
    return stopIpv6(`the host's IPv6 rules are not in place: ${missing}`);
  }

  if (setting.kind === 'routed') {
    await removeNat66(deps);

    deps.log(
      `impd: ipv6: ${setting.prefix.text}, routed${uplink === null ? '; the container has no IPv6 default route' : ` via ${uplink}`}`,
    );

    return { prefix: setting.prefix, nat66: false, uplink };
  }

  const prefix = deps.readUlaPrefix();

  try {
    await deps.runNft(buildNat66Ruleset(prefix.text, uplink ?? ''));
  } catch (error) {
    return stopIpv6(`NAT66: ${getErrorMessage(error)}`);
  }

  deps.log(`impd: ipv6: ${prefix.text}, NAT66 out of ${uplink ?? ''}`);

  return { prefix, nat66: true, uplink };
}

async function removeNat66(deps: Readonly<Pick<Ipv6PlanDeps, 'runNft'>>): Promise<void> {
  try {
    await deps.runNft(buildNat66Removal());
  } catch {}
}

const HOST_RULES6: readonly (readonly [string, string])[] = [
  ['filter', '-A INPUT -i imp+ -j DROP'],
  ['filter', '-A FORWARD -i imp+ -o imp+ -j DROP'],
  ['filter', '-A FORWARD -o imp+ -j DROP'],
  ['filter', '-A FORWARD -i imp+ -j DROP'],
  ['raw', '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP'],
];

const HOST_SYSCTLS6: readonly (readonly [string, string])[] = [
  ['default/accept_ra', '0'],
  ['default/accept_redirects', '0'],
  ['all/forwarding', '1'],
];

export async function checkHostRules6(
  procSys = '/proc/sys/net/ipv6/conf',
  run: CommandRunner = runCommand,
): Promise<string | null> {
  for (const table of ['filter', 'raw']) {
    const result = await run(['ip6tables', '-w', '-t', table, '-S']);

    const rules = new Set(result.stdout.split('\n').map((line) => line.trim()));

    const missing = HOST_RULES6.find(([inTable, rule]) => inTable === table && !rules.has(rule));

    if (result.exitCode !== 0) {
      return `ip6tables -t ${table}: ${result.stderr.trim()}`;
    }

    if (missing !== undefined) {
      return `no ip6tables -t ${table} ${missing[1]}`;
    }
  }

  for (const [key, wanted] of HOST_SYSCTLS6) {
    const value = readSysctl(join(procSys, key));

    if (value !== wanted) {
      return `net.ipv6.conf.${key.replace('/', '.')} is ${value ?? 'missing'}, not ${wanted}`;
    }
  }

  return null;
}

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

export function readOrCreateUlaPrefix(path: string): Prefix64 {
  if (existsSync(path)) {
    const prefix = parsePrefix64(readFileSync(path, 'utf8').trim());

    if (prefix !== null) {
      return prefix;
    }
  }

  const prefix = buildUlaPrefix(randomBytes(5));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${prefix.text}\n`);

  return prefix;
}
