import type { DevInstance } from './instance';
import { checkHostRunsKsm } from './ksm-host';
import { buildMoveSettings, readMoveOptions } from './move-hosts';
import type { HostBFixtureName } from './move-hosts';
import { buildRouteOrigin } from './oauth-route';

export type FixtureImage = 'base' | 'e2e-tiny' | 'e2e-bare' | 'e2e-ws' | 'e2e-git' | 'e2e-ra';

export interface Suite {
  readonly name: string;

  readonly prefix: string;
  readonly images: readonly FixtureImage[];

  readonly journeys?: readonly string[];

  readonly settings?: (target: Readonly<DevInstance>) => Readonly<Record<string, string>> | null;

  readonly fixtures?: readonly HostBFixtureName[];
}

// The order is the acceptance numbering (results.json `section1` is
// lifecycle), and restart runs after scale so it re-adopts a full house.
export const SUITES: readonly Suite[] = [
  {
    name: 'lifecycle',
    prefix: 'e2e-life-',
    images: [],
    journeys: ['lifecycle', 'lifecycle-events'],
  },
  { name: 'docker', prefix: 'e2e-dock-', images: ['base'] },
  {
    name: 'images',
    prefix: 'e2e-img-',
    images: ['base'],
    journeys: ['images-build', 'images-refusals', 'images-isolation'],
  },

  {
    name: 'registry',
    prefix: 'e2e-reg-',
    images: [],
    journeys: ['registry-moved-tag', 'registry-copy-from', 'registry-multi-platform'],

    // A builder imp may not reach the host's loopback, by design, so it cannot
    // reach this registry either.
    settings: () => ({ IMP_BUILD_ISOLATION: 'host' }),
  },
  { name: 'checkpoints', prefix: 'e2e-cp-', images: ['e2e-tiny'] },
  { name: 'disks', prefix: 'e2e-disk-', images: ['e2e-tiny'] },
  {
    name: 'sleep',
    prefix: 'e2e-slp-',
    images: ['e2e-bare', 'e2e-ws'],
    journeys: ['sleep-memory', 'sleep-proxy-answers', 'sleep-websocket'],

    // Its journeys wait out the idle timeout again and again, so a short one cuts the suite.
    settings: () => ({ IMP_IDLE_TIMEOUT_S: '5' }),
  },
  {
    name: 'scale',
    prefix: 'e2e-scale-',
    images: ['e2e-tiny'],

    // Long enough that only the governor sleeps imps, or the budget never fills.
    settings: () => ({ IMP_IDLE_TIMEOUT_S: '600' }),
  },
  { name: 'restart', prefix: 'e2e-rs-', images: ['e2e-tiny', 'e2e-bare'] },
  {
    name: 'tailscale',
    prefix: 'e2e-ts-',
    images: ['e2e-tiny'],
    journeys: ['tailscale-reach', 'tailscale-identities', 'tailscale-names'],

    // impd reads this rule at start, and the reboot keeps the node.
    settings: () => ({
      IMP_TAILNET_IDENTITIES: JSON.stringify([{ match: '*', scope: 'read' }]),
    }),
  },
  { name: 'mcp', prefix: 'e2e-mcp-', images: ['e2e-tiny'] },
  {
    name: 'mcp-oauth',
    prefix: 'e2e-oa-',
    images: ['e2e-tiny'],
    settings: (target) => ({ IMP_MCP_PUBLIC_URL: buildRouteOrigin(target) }),
  },
  { name: 'sessions', prefix: 'e2e-ses-', images: ['e2e-bare'] },
  { name: 'offsets', prefix: 'e2e-off-', images: ['e2e-bare'] },
  { name: 'session-logs', prefix: 'e2e-slog-', images: ['e2e-bare'] },
  { name: 'services', prefix: 'e2e-svc-', images: ['e2e-bare'] },
  { name: 'ssh', prefix: 'e2e-ssh-', images: ['e2e-tiny'] },
  { name: 'ssh-wake', prefix: 'e2e-sshw-', images: ['e2e-tiny'] },
  { name: 'ssh-agent', prefix: 'e2e-ssha-', images: ['e2e-git'] },
  { name: 'reverse', prefix: 'e2e-rev-', images: ['e2e-git'] },
  {
    name: 'proxy',
    prefix: 'e2e-px-',
    images: ['e2e-tiny'],
    journeys: ['proxy-refusals', 'proxy-forwards', 'proxy-agent-outdated', 'proxy-tunnel-limit'],
  },
  { name: 'proxy-wake', prefix: 'e2e-pxw-', images: ['e2e-tiny'] },
  { name: 'cp', prefix: 'e2e-copy-', images: ['e2e-git'] },
  {
    name: 'connectors',
    prefix: 'e2e-conn-',
    images: ['base'],
    journeys: ['connectors-github', 'connectors-custom'],
  },
  { name: 'dashboard', prefix: 'e2e-dash-', images: ['e2e-tiny'] },
  { name: 'https', prefix: 'e2e-tls-', images: ['e2e-tiny'] },
  { name: 'tokens', prefix: 'e2e-tok-', images: ['e2e-tiny'] },
  { name: 'leases', prefix: 'e2e-lease-', images: ['e2e-tiny'] },
  {
    name: 'egress',
    prefix: 'e2e-eg-',
    images: ['e2e-tiny'],
    journeys: ['egress-box', 'egress-public'],
  },
  {
    name: 'ipv6',
    prefix: 'e2e-v6-',
    images: ['e2e-tiny', 'e2e-ra'],
    journeys: [
      'ipv6-nat66',
      'ipv6-policy',
      'ipv6-isolation',
      'ipv6-spoof',
      'ipv6-router-advert',
      'ipv6-routed',
    ],
  },
  { name: 'networks', prefix: 'e2e-net-', images: ['e2e-tiny'] },
  { name: 'cpu', prefix: 'e2e-cpu-', images: ['e2e-tiny'] },
  { name: 'templates', prefix: 'e2e-tpl-', images: ['e2e-git'] },
  { name: 'boot-templates', prefix: 'e2e-bt-', images: ['e2e-ws'] },
  {
    name: 'inner',
    prefix: 'e2e-in-',
    images: ['e2e-tiny'],
    journeys: ['inner-isolation', 'inner-restart', 'inner-agent', 'inner-wipe', 'inner-files'],
  },

  {
    name: 'socket',
    prefix: 'e2e-sock-',
    images: ['e2e-tiny'],
    journeys: ['socket-refusals', 'socket-builds', 'socket-proxy-stopped'],
  },

  {
    name: 'moves',
    prefix: 'e2e-mv-',
    images: ['e2e-tiny', 'base'],
    journeys: [
      'moves-backend',
      'moves-cold',
      'moves-leases',
      'moves-abort',
      'moves-place',
      'moves-list',
      'moves-warm-open',
      'moves-warm-box',
      'moves-warm-pair',
    ],
    fixtures: ['host-b'],
    settings: (target) => buildMoveSettings(readMoveOptions('host-b'), target.portOffset),
  },
  {
    name: 'moves-tailnet',
    prefix: 'e2e-mvt-',
    images: ['e2e-tiny'],
    journeys: ['moves-tailnet-peer', 'moves-tailnet-names'],
    fixtures: ['host-b-tailnet'],
    settings: (target) => buildMoveSettings(readMoveOptions('host-b-tailnet'), target.portOffset),
  },

  {
    name: 'chaos',
    prefix: 'e2e-chaos-',
    images: ['e2e-bare'],
    journeys: ['chaos', 'chaos-watchdog', 'chaos-disk-full'],
  },

  {
    name: 'jail',
    prefix: 'e2e-jail-',
    images: ['e2e-bare'],
    journeys: ['jail', 'jail-rollback', 'jail-oom', 'jail-remove'],
  },
  { name: 'memory', prefix: 'e2e-mem-', images: ['e2e-tiny'] },

  // Skips unless KSM runs on this host, as CI turns it on: elsewhere impd cannot
  // start with IMP_KSM, so the run's settings stay.
  {
    name: 'ksm',
    prefix: 'e2e-ksm-',
    images: ['e2e-tiny'],
    settings: () => buildKsmSettings(checkHostRunsKsm()),
  },

  // Last, because they reboot the instance with backups on, then off again.
  { name: 'backups', prefix: 'e2e-bk-', images: ['e2e-tiny'] },
  { name: 'backups-repo', prefix: 'e2e-bkr-', images: ['e2e-tiny'] },
];

// One list per CI runner and instance; each held about 225 s of suite work in
// CI. Rebalance by the times in .cache/e2e/results.json.
export const FAST_GROUPS: readonly (readonly string[])[] = [
  [
    'lifecycle',
    'registry',
    'checkpoints',
    'disks',
    'restart',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-agent',
    'proxy',
    'dashboard',
    'tokens',
    'leases',
    'cpu',
    'templates',
    'boot-templates',
    'socket',
  ],
  ['sleep', 'reverse', 'jail'],
  ['mcp', 'mcp-oauth', 'inner', 'memory', 'ksm'],
];

export const SUITE_SETS: Readonly<Record<string, readonly string[]>> = {
  acceptance: SUITES.map((suite) => suite.name),
  fast: SUITES.map((suite) => suite.name).filter((name) =>
    FAST_GROUPS.some((group) => group.includes(name)),
  ),
};

export const HOST_TESTS_GROUP = 2;

export function listJourneys(suite: Readonly<Suite>): readonly string[] {
  return suite.journeys ?? [suite.name];
}

export function getSuitePrefix(name: string): string {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.prefix;
}

export function readSuiteSettings(
  name: string,
  target: Readonly<DevInstance>,
): Readonly<Record<string, string>> | null {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.settings?.(target) ?? null;
}

export function buildJourneyEnv(
  settings: Readonly<Record<string, string>> | null,
): Readonly<Record<string, string>> {
  const idleTimeoutS = settings?.['IMP_IDLE_TIMEOUT_S'];

  return idleTimeoutS === undefined ? {} : { E2E_IDLE_TIMEOUT_S: idleTimeoutS };
}

export function buildKsmSettings(isKsmRunning: boolean): Readonly<Record<string, string>> | null {
  if (!isKsmRunning) {
    return null;
  }

  return {
    IMP_KSM: '1',
    IMP_RAM_BUDGET_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '20',
    IMP_IDLE_TIMEOUT_S: '600',
  };
}

const JOURNEY_TIMEOUT_MS = 3_600_000;

// Plain `bun test` skips *.e2e.ts; a ./ path runs one anyway, where a bare
// path is a name filter.
export function buildJourneyArgv(bunPath: string, journey: string): readonly string[] {
  return [
    bunPath,
    'test',
    '--config=e2e/bunfig.toml',
    '--bail',
    '--timeout',
    String(JOURNEY_TIMEOUT_MS),
    `./e2e/suites/${journey}.e2e.ts`,
  ];
}
