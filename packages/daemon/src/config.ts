import { join } from 'node:path';
import * as z from 'zod';
import { countSlots, formatCidr4, isTailnetOverlap, parseSubnet } from './host-net/net/addressing';
import { formatCidr6 } from './host-net/net/addressing6';
import { parseIpv6Setting } from './host-net/net/ipv6-plan';
import { buildRangeMatcher } from './host-net/net/range-matcher';
import { parseTailnetRules } from './identity/auth/parse-tailnet-rules';
import { PublicMcpEnvSchema, parsePublicMcpConfig } from './identity/oauth/public-mcp-config';
import { loadBackupConfig } from './imp-ops/backup/backup-config';
import { buildPeerRanges, parsePeerUrlAddress } from './imp-ops/moves/peer-address';
import { BUILD_IMAGE_PATTERN, DEFAULT_BUILD_IMAGE } from './imps/docker-contract/build-image';
import type { ImageEvictionConfig, TestRegistryConfig } from './imps/imps-config';
import { checkPublicPorts } from './network/https/check-public-ports';
import { HttpsEnvSchema, listHttpsWarnings, readHttpsConfig } from './network/https/https-config';
import {
  TailnetNamesEnvSchema,
  parseTailnetNamesConfig,
} from './network/tailnet-names/tailnet-names-config';
import type { SurfaceConfig } from './surface/surface-config';
import type { KsmConfig } from './vm/vm-config';

const PortSchema = z.coerce.number().pipe(z.int().min(1).max(65_535));
const CountSchema = z.coerce.number().pipe(z.int().positive());
const DnsServersSchema = z.array(z.ipv4()).min(1);
const PercentSchema = z.coerce.number().pipe(z.int().min(0).max(100));
const MarkSchema = z.coerce.number().pipe(z.int().min(1).max(99));

const EnvSchema = z.object({
  IMP_DATA_DIR: z.string().default('/var/lib/imp'),
  IMP_API_PORT: PortSchema.default(7070),
  IMP_PROXY_PORT: PortSchema.default(7080),
  IMP_PORT_BASE: PortSchema.default(20_000),
  IMP_SSH_PORT: z.coerce.number().pipe(z.int().min(0).max(65_535)).default(22),
  IMP_SSH_AUTHORIZED_KEYS: z.enum(['true', 'false']).default('true'),
  IMP_BROKER_PORT: PortSchema.default(7081),
  IMP_BROKER_TEST_UPSTREAMS: z.string().optional(),
  IMP_EGRESS_DNS_PORT: PortSchema.default(7053),
  IMP_EGRESS_DENY: z.string().default(''),

  // The unit and the NixOS module fill this at each start from `ip -o addr`, because the
  // Docker host's networks are invisible from impd's container.
  IMP_HOST_ADDRESSES: z.string().default(''),
  IMP_RAM_BUDGET_MIB: CountSchema.default(16_384),
  IMP_IDLE_TIMEOUT_S: CountSchema.default(60),
  IMP_IDLE_CPU_PERCENT: z.coerce.number().nonnegative().default(10),
  IMP_MEMORY_SHRINK_AFTER_S: CountSchema.default(60),
  IMP_BOOT_RESERVE_PERCENT: CountSchema.pipe(z.int().max(100)).default(50),
  IMP_WAKE_RESERVE_MIB: CountSchema.default(256),
  IMP_SLEEP_MIN_GUEST_UPTIME_MS: z.coerce.number().pipe(z.int().nonnegative()).default(1500),
  IMP_BOOT_TEMPLATES: z.enum(['true', 'false']).default('true'),
  IMP_WATCHDOG_TIMEOUT_S: CountSchema.default(60),
  IMP_WATCHDOG_ACTION: z.enum(['report', 'restart', 'snapshot']).default('report'),
  IMP_DEFAULT_VCPUS: CountSchema.default(2),
  IMP_DEFAULT_MEMORY_MIB: CountSchema.default(2048),
  IMP_DEFAULT_DISK_GIB: CountSchema.default(32),
  IMP_DISK_RESERVE_GIB: CountSchema.optional(),
  IMP_BUILD_CONTEXT_MAX_MIB: CountSchema.default(1024),
  IMP_BUILD_MEMORY_MIB: CountSchema.default(2048),
  IMP_BUILD_DISK_GIB: CountSchema.default(20),
  IMP_BUILD_IMAGE_MAX_MIB: CountSchema.default(8192),
  IMP_BUILD_IMAGE_MAX_FILES: CountSchema.default(1_000_000),
  IMP_BUILD_IMAGE: z
    .string()
    .regex(BUILD_IMAGE_PATTERN, 'must name an image by digest, <ref>@sha256:<hex>')
    .default(DEFAULT_BUILD_IMAGE),
  IMP_BUILD_TEST_REGISTRY: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.\-]*:\d+$/v, 'must be <name>:<port>')
    .optional(),
  IMP_BUILD_TEST_REGISTRY_CA: z.string().optional(),
  IMP_IMAGE_EVICT_HIGH_PERCENT: MarkSchema.optional(),
  IMP_IMAGE_EVICT_LOW_PERCENT: MarkSchema.optional(),
  IMP_SESSION_LOG_MAX_MIB: CountSchema.default(16),
  IMP_SESSION_LOG_IMP_MAX_MIB: CountSchema.default(64),
  IMP_SESSION_LOG_IMP_MAX_LIVE: CountSchema.default(8),
  IMP_SESSION_LOG_MAX_AGE_DAYS: CountSchema.default(7),
  IMP_KSM: z.enum(['0', '1']).default('0'),
  IMP_KSM_EXEC: z.string().default('ksm-exec'),
  IMP_KSM_HEADROOM_PERCENT: z.string().default('100'),
  IMP_HUGE_PAGES: z.enum(['off', '2M']).default('off'),
  IMP_UFFD_HANDLER: z.string().default('uffd-handler'),
  IMP_DNS: z.string().default('1.1.1.1,8.8.8.8').transform(splitList).pipe(DnsServersSchema),
  IMP_SUBNET: z.cidrv4().default('10.66.0.0/16'),
  IMP_SUBNET6: z.string().default('auto'),
  IMP_FIRECRACKER_BIN: z.string().default('firecracker'),
  IMP_JAILER: z.enum(['true', 'false']).default('true'),
  IMP_JAILER_BIN: z.string().default('jailer'),
  IMP_KERNEL: z.string().optional(),
  IMP_SYSTEM_DRIVE: z.string().optional(),
  IMP_DEFAULT_IMAGE: z.string().default('base'),
  IMP_STORAGE_BACKEND: z.enum(['xfs', 'zfs']).default('xfs'),
  IMP_ZFS_ROOT: z.string().optional(),
  IMP_ZFS_ALLOW_UIOMOVE_BUG: z.enum(['0', '1']).default('0'),
  TAILSCALE_AUTHKEY: z.string().optional(),
  IMP_TAILSCALE_NODE: z.literal('1').optional(),
  IMP_TAILSCALE_HOSTNAME: z.string().default('imp'),
  IMP_DASHBOARD_DIR: z.string().optional(),
  IMP_TAILNET_IDENTITIES: z.string().optional(),
  IMP_PEER_URL: z.url().optional(),
  IMP_MOVE_TEST_CIDR: z.cidrv4().optional(),
  ...HttpsEnvSchema.shape,
  ...TailnetNamesEnvSchema.shape,
  ...PublicMcpEnvSchema.shape,
});

// `impd --network-env` runs before the host joins the tailnet, so it parses only these
// settings: the rest may need the tailnet.
export const NetworkEnvSchema = EnvSchema.pick({
  IMP_SUBNET: true,
  IMP_BROKER_PORT: true,
  IMP_EGRESS_DNS_PORT: true,
});

export interface Config extends SurfaceConfig {
  readonly brokerTestUpstreams: string | null;
  readonly warnings: readonly string[];
}

// A host address keeps its prefix: the host's LAN (a global /64, a VPS's public subnet)
// is in none of imp-host's own netns's connected prefixes.
function parseCidrList(value: string): string[] {
  return splitList(value)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const cidr = formatCidr4(entry) ?? formatCidr6(entry);

      if (cidr === null) {
        throw new Error(
          `IMP_EGRESS_DENY or IMP_HOST_ADDRESSES: ${entry} is not an IPv4 or IPv6 address or CIDR`,
        );
      }

      return cidr;
    });
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim());
}

const isPrivate4 = buildRangeMatcher(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);

// The peer URL is checked against the ranges a source sends to here, so a source never
// refuses it late.
function checkMoveSettings(
  testCidr: string | undefined,
  peerUrl: string | undefined,
  isE2e: boolean,
): void {
  if (testCidr !== undefined) {
    if (!isE2e) {
      throw new Error(
        'IMP_MOVE_TEST_CIDR opens moves off the tailnet, and only an e2e host may set it',
      );
    }

    const [address = '', prefix = ''] = testCidr.split('/');

    if (Number(prefix) < 16 || !isPrivate4(address)) {
      throw new Error(`IMP_MOVE_TEST_CIDR must be a private range of /16 or narrower: ${testCidr}`);
    }
  }

  if (peerUrl === undefined) {
    return;
  }

  const address = parsePeerUrlAddress(peerUrl);

  if (address === null) {
    throw new Error(`IMP_PEER_URL must name a literal address, not a name: ${peerUrl}`);
  }

  if (!buildPeerRanges(testCidr ?? null).isAllowed(address)) {
    throw new Error(
      `IMP_PEER_URL must name a tailnet address${isE2e ? ' or one in IMP_MOVE_TEST_CIDR' : ''}: ${peerUrl}`,
    );
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  // an empty variable (`TAILSCALE_AUTHKEY=` in an env file) means unset
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.parse(present);
  const subnet = parseSubnet(parsed.IMP_SUBNET);
  const lastPort = parsed.IMP_PORT_BASE + countSlots(subnet) - 1;

  if (lastPort > 65_535) {
    throw new Error(
      `IMP_PORT_BASE ${String(parsed.IMP_PORT_BASE)} leaves no port for every slot of ${parsed.IMP_SUBNET}`,
    );
  }

  if (isTailnetOverlap(subnet)) {
    throw new Error(`IMP_SUBNET ${parsed.IMP_SUBNET} overlaps Tailscale's 100.64.0.0/10`);
  }

  for (const [name, port] of [
    ['IMP_API_PORT', parsed.IMP_API_PORT],
    ['IMP_PROXY_PORT', parsed.IMP_PROXY_PORT],
  ] as const) {
    if (port >= parsed.IMP_PORT_BASE && port <= lastPort) {
      throw new Error(
        `${name} ${String(port)} falls in the imp ports ${String(parsed.IMP_PORT_BASE)}-${String(lastPort)}`,
      );
    }
  }

  if (parsed.IMP_STORAGE_BACKEND === 'zfs' && parsed.IMP_ZFS_ROOT === undefined) {
    throw new Error(
      'IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset mounted on IMP_DATA_DIR',
    );
  }

  const hostAddresses = [...new Set(parseCidrList(parsed.IMP_HOST_ADDRESSES))];
  const isTailnetNode = parsed.TAILSCALE_AUTHKEY !== undefined || parsed.IMP_TAILSCALE_NODE === '1';
  const https = readHttpsConfig(parsed);

  if (https !== null && https.public !== null) {
    checkPublicPorts(
      https.public,
      [
        ['IMP_API_PORT', parsed.IMP_API_PORT],
        ['IMP_PROXY_PORT', parsed.IMP_PROXY_PORT],
        ['IMP_BROKER_PORT', parsed.IMP_BROKER_PORT],
        ['IMP_EGRESS_DNS_PORT', parsed.IMP_EGRESS_DNS_PORT],
        ['IMP_SSH_PORT', parsed.IMP_SSH_PORT],
        ['IMP_HTTPS_PORT', https.httpsPort],
        ['IMP_HTTP_PORT', https.httpPort],
      ],
      [parsed.IMP_PORT_BASE, lastPort],
    );
  }

  const takenPorts: (readonly [string, number])[] = [
    ['IMP_API_PORT', parsed.IMP_API_PORT],
    ['IMP_PROXY_PORT', parsed.IMP_PROXY_PORT],
    ['IMP_BROKER_PORT', parsed.IMP_BROKER_PORT],
    ['IMP_EGRESS_DNS_PORT', parsed.IMP_EGRESS_DNS_PORT],
    ['IMP_SSH_PORT', parsed.IMP_SSH_PORT],
  ];

  if (https !== null) {
    takenPorts.push(['IMP_HTTPS_PORT', https.httpsPort], ['IMP_HTTP_PORT', https.httpPort]);

    if (https.public !== null) {
      takenPorts.push(
        ['IMP_PUBLIC_HTTPS_PORT', https.public.httpsPort],
        ['IMP_PUBLIC_HTTP_PORT', https.public.httpPort],
      );
    }
  }

  const publicMcp = parsePublicMcpConfig(parsed, takenPorts, [parsed.IMP_PORT_BASE, lastPort]);

  checkMoveSettings(parsed.IMP_MOVE_TEST_CIDR, parsed.IMP_PEER_URL, parsed.IMP_E2E === '1');

  return {
    dataDir: parsed.IMP_DATA_DIR,
    apiPort: parsed.IMP_API_PORT,
    proxyPort: parsed.IMP_PROXY_PORT,
    portBase: parsed.IMP_PORT_BASE,
    sshPort: parsed.IMP_SSH_PORT === 0 ? null : parsed.IMP_SSH_PORT,
    sshAuthorizedKeys: parsed.IMP_SSH_AUTHORIZED_KEYS === 'true',
    brokerPort: parsed.IMP_BROKER_PORT,
    egressDnsPort: parsed.IMP_EGRESS_DNS_PORT,
    egressDeny: [
      ...new Set([
        ...parseCidrList(parsed.IMP_EGRESS_DENY),
        ...hostAddresses,
        ...parseCidrList(https?.public?.ip ?? ''),
      ]),
    ],
    hostAddresses,
    brokerTestUpstreams: parsed.IMP_BROKER_TEST_UPSTREAMS ?? null,
    ramBudgetMib: parsed.IMP_RAM_BUDGET_MIB,
    idleTimeoutS: parsed.IMP_IDLE_TIMEOUT_S,
    idleCpuPercent: parsed.IMP_IDLE_CPU_PERCENT,
    memoryShrinkAfterMs: parsed.IMP_MEMORY_SHRINK_AFTER_S * 1000,
    bootReservePercent: parsed.IMP_BOOT_RESERVE_PERCENT,
    wakeReserveMib: parsed.IMP_WAKE_RESERVE_MIB,
    sleepMinGuestUptimeMs: parsed.IMP_SLEEP_MIN_GUEST_UPTIME_MS,
    bootTemplates: parsed.IMP_BOOT_TEMPLATES === 'true',
    watchdogTimeoutS: parsed.IMP_WATCHDOG_TIMEOUT_S,
    watchdogAction: parsed.IMP_WATCHDOG_ACTION,
    defaultVcpus: parsed.IMP_DEFAULT_VCPUS,
    defaultMemoryMib: parsed.IMP_DEFAULT_MEMORY_MIB,
    defaultDiskBytes: parsed.IMP_DEFAULT_DISK_GIB * 1024 ** 3,
    diskReserveBytes:
      parsed.IMP_DISK_RESERVE_GIB === undefined ? null : parsed.IMP_DISK_RESERVE_GIB * 1024 ** 3,
    buildContextMaxBytes: parsed.IMP_BUILD_CONTEXT_MAX_MIB * 1024 ** 2,
    build: {
      memoryMib: parsed.IMP_BUILD_MEMORY_MIB,
      diskBytes: parsed.IMP_BUILD_DISK_GIB * 1024 ** 3,
      imageMaxBytes: parsed.IMP_BUILD_IMAGE_MAX_MIB * 1024 ** 2,
      imageMaxFiles: parsed.IMP_BUILD_IMAGE_MAX_FILES,
      image: parsed.IMP_BUILD_IMAGE,
      testRegistry: parseTestRegistry(parsed),
    },
    imageEviction: parseImageEvictionConfig(
      parsed.IMP_IMAGE_EVICT_HIGH_PERCENT,
      parsed.IMP_IMAGE_EVICT_LOW_PERCENT,
    ),
    sessionLog: {
      generationMaxBytes: parsed.IMP_SESSION_LOG_MAX_MIB * 1024 ** 2,
      impMaxBytes: parsed.IMP_SESSION_LOG_IMP_MAX_MIB * 1024 ** 2,
      impMaxLive: parsed.IMP_SESSION_LOG_IMP_MAX_LIVE,
      maxAgeMs: parsed.IMP_SESSION_LOG_MAX_AGE_DAYS * 86_400_000,
    },
    dns: parsed.IMP_DNS,
    subnet,
    ipv6: parseIpv6Setting(parsed.IMP_SUBNET6),
    firecrackerBin: parsed.IMP_FIRECRACKER_BIN,
    jailerBin: parsed.IMP_JAILER === 'true' ? parsed.IMP_JAILER_BIN : null,
    jailDir: join(parsed.IMP_DATA_DIR, 'jail'),
    ksm: parseKsmConfig(parsed),
    hugePages: parsed.IMP_HUGE_PAGES === '2M' ? { handlerBin: parsed.IMP_UFFD_HANDLER } : null,
    kernelPath: join(parsed.IMP_DATA_DIR, 'system', 'vmlinux'),
    kernelSource: parsed.IMP_KERNEL ?? null,
    systemDriveSource:
      parsed.IMP_SYSTEM_DRIVE ?? join(parsed.IMP_DATA_DIR, 'system', 'imp-system.squashfs'),
    defaultImage: parsed.IMP_DEFAULT_IMAGE,
    storageBackend: parsed.IMP_STORAGE_BACKEND,
    zfsRoot: parsed.IMP_ZFS_ROOT ?? null,
    isUiomoveBugAllowed: parsed.IMP_ZFS_ALLOW_UIOMOVE_BUG === '1',
    tailscaleEnabled: isTailnetNode,
    tailscaleHostname: parsed.IMP_TAILSCALE_HOSTNAME,
    tailnetRules: parseTailnetRules(parsed.IMP_TAILNET_IDENTITIES),
    dashboardDir: parsed.IMP_DASHBOARD_DIR ?? null,
    backup: loadBackupConfig(present),
    https,
    publicMcp,
    tailnetNames: parseTailnetNamesConfig(parsed, parsed.IMP_DATA_DIR, isTailnetNode),
    moves: { peerUrl: parsed.IMP_PEER_URL ?? null, testCidr: parsed.IMP_MOVE_TEST_CIDR ?? null },
    warnings: listHttpsWarnings(parsed),
  };
}

function parseTestRegistry(parsed: z.infer<typeof EnvSchema>): TestRegistryConfig | null {
  const registry = parsed.IMP_BUILD_TEST_REGISTRY;
  const caPath = parsed.IMP_BUILD_TEST_REGISTRY_CA;

  if (registry === undefined && caPath === undefined) {
    return null;
  }

  if (parsed.IMP_E2E !== '1') {
    throw new Error(
      'IMP_BUILD_TEST_REGISTRY opens a private address to builders, and only an e2e host may set it',
    );
  }

  if (registry === undefined || caPath === undefined) {
    throw new Error(
      'IMP_BUILD_TEST_REGISTRY and IMP_BUILD_TEST_REGISTRY_CA go together; set both or neither',
    );
  }

  const colon = registry.lastIndexOf(':');
  const port = Number(registry.slice(colon + 1));

  if (port < 1 || port > 65_535) {
    throw new Error(`IMP_BUILD_TEST_REGISTRY has no valid port: ${registry}`);
  }

  return { name: registry.slice(0, colon), port, caPath };
}

function parseImageEvictionConfig(
  highPercent: number | undefined,
  lowPercent: number | undefined,
): ImageEvictionConfig | null {
  if (highPercent === undefined && lowPercent === undefined) {
    return null;
  }

  if (highPercent === undefined || lowPercent === undefined) {
    throw new Error(
      'IMP_IMAGE_EVICT_HIGH_PERCENT and IMP_IMAGE_EVICT_LOW_PERCENT go together; set both or neither',
    );
  }

  if (lowPercent >= highPercent) {
    throw new Error(
      `IMP_IMAGE_EVICT_LOW_PERCENT ${String(lowPercent)} must be below IMP_IMAGE_EVICT_HIGH_PERCENT ${String(highPercent)}`,
    );
  }

  return { highPercent, lowPercent };
}

function parseKsmConfig(
  parsed: Readonly<
    Pick<z.infer<typeof EnvSchema>, 'IMP_KSM' | 'IMP_KSM_EXEC' | 'IMP_KSM_HEADROOM_PERCENT'>
  >,
): KsmConfig | null {
  if (parsed.IMP_KSM === '0') {
    return null;
  }

  const headroom = PercentSchema.safeParse(parsed.IMP_KSM_HEADROOM_PERCENT);

  if (!headroom.success) {
    throw new Error(
      `IMP_KSM_HEADROOM_PERCENT ${parsed.IMP_KSM_HEADROOM_PERCENT} is not a whole number from 0 to 100`,
    );
  }

  return { execBin: parsed.IMP_KSM_EXEC, headroomPercent: headroom.data };
}
