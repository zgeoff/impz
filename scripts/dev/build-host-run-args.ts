import { join } from 'node:path';
import { match } from 'ts-pattern';
import type { DevEnv, DevLayout } from '../lib/build-dev-layout.ts';
import { pickSetting } from '../lib/pick-setting.ts';
import type { DevCheckout } from '../lib/read-dev-checkout.ts';

// An allowlist: IMP_URL, IMP_TOKEN and IMP_DEV_* belong to this machine, not to impd.
const TUNING_VARIABLES = [
  'IMP_IDLE_TIMEOUT_S',
  'IMP_IDLE_CPU_PERCENT',
  'IMP_RAM_BUDGET_MIB',
  'IMP_MEMORY_SHRINK_AFTER_S',
  'IMP_BOOT_RESERVE_PERCENT',
  'IMP_WAKE_RESERVE_MIB',
  'IMP_SLEEP_MIN_GUEST_UPTIME_MS',
  'IMP_DEFAULT_VCPUS',
  'IMP_DEFAULT_MEMORY_MIB',
  'IMP_DEFAULT_DISK_GIB',
  'IMP_DISK_RESERVE_GIB',
  'IMP_TAILSCALE_HOSTNAME',
  'IMP_TAILSCALE_TAGS',
  'IMP_TAILSCALE_LOGIN_SERVER',
  'IMP_TAILSCALE_STATE_DIR',
  'IMP_TAILNET_IDENTITIES',
  'IMP_TAILNET_NAMES',
  'IMP_TAILNET_NAME_PREFIX',
  'IMP_BUILD_CONTEXT_MAX_MIB',
  'IMP_BUILD_MEMORY_MIB',
  'IMP_BUILD_DISK_GIB',
  'IMP_BUILD_IMAGE_MAX_MIB',
  'IMP_BUILD_IMAGE_MAX_FILES',
  'IMP_BUILD_IMAGE',
  'IMP_WATCHDOG_TIMEOUT_S',
  'IMP_WATCHDOG_ACTION',
  'IMP_KSM',
  'IMP_KSM_HEADROOM_PERCENT',
  'IMP_SSH_AUTHORIZED_KEYS',
  'IMP_STORAGE_BACKEND',
  'IMP_ZFS_ROOT',
  'IMP_ZFS_ALLOW_UIOMOVE_BUG',
  'IMP_SUBNET6',
  'IMP_DOMAIN',
  'IMP_DNS_PROVIDER',
  'IMP_DNS_API_URL',
  'IMP_ACME_DIRECTORY',
  'IMP_ACME_EMAIL',
  'IMP_HTTPS_PORT',
  'IMP_HTTP_PORT',
  'IMP_PUBLIC_IP',
  'IMP_PUBLIC_HTTPS_PORT',
  'IMP_PUBLIC_HTTP_PORT',
  'IMP_E2E',
  'IMP_BROKER_PORT',
  'IMP_BACKUP_REPOSITORY',
  'IMP_BACKUP_PASSWORD_FILE',
  'IMP_BACKUP_INTERVAL_S',
  'IMP_BACKUP_KEEP',
  'IMP_BACKUP_FORGET',
  'IMP_BACKUP_DATABASE',
  'IMP_BACKUP_CPUS',
  'IMP_BACKUP_MEMORY_MIB',
  'IMP_BOOT_TEMPLATES',
  'IMP_JAILER',
  'IMP_JAILER_BIN',
  'IMP_MOVE_TEST_CIDR',
  'IMP_PEER_URL',
  'IMP_MCP_PUBLIC_URL',
  'IMP_MCP_PUBLIC_PORT',
  'IMP_BUILD_TEST_REGISTRY',
  'IMP_HOST_ADDRESSES',
] as const;

export type TailscaleArg = 'off' | 'key' | 'none';

interface HostRunOptions {
  readonly layout: DevLayout;
  readonly checkout: DevCheckout;
  readonly env: DevEnv;
  readonly privileges: readonly string[];
  readonly hasEnvFile: boolean;
  readonly tailscale: TailscaleArg;
  readonly tailnetOAuthFile: string | null;
  readonly acmeCAFile: string | null;
  readonly registryCAFile: string | null;
  readonly registryHost: string | null;
  readonly kernel: string;
  readonly systemDrive: string;
  readonly uplinkMTU: string;
}

export function buildHostRunArgs(options: HostRunOptions): string[] {
  const layout = options.layout;
  const checkout = options.checkout;
  const env = options.env;

  return [
    'run',
    '-d',
    '--name',
    layout.name,
    '--hostname',
    layout.name,
    ...options.privileges,

    // The XFS lives in a loop file, so setup-storage.sh makes a loop device node.
    '--device',
    '/dev/loop-control',
    '--device-cgroup-rule',
    'b 7:* rmw',

    // The WSL host's 100.100.100.100 stops answering once the container's tailscaled starts.
    '--dns',
    '1.1.1.1',
    '--dns',
    '8.8.8.8',
    ...(options.hasEnvFile ? ['--env-file', join(checkout.root, '.env')] : []),
    ...buildSettingArgs(env, 'IMP_DEV_BACKUP_ENV_FILE', (value) => ['--env-file', value]),
    ...buildSettingArgs(env, 'IMP_DEV_NETWORK', (value) => ['--network', value]),
    ...buildSettingArgs(env, 'IMP_DEV_IP', (value) => ['--ip', value]),
    '-v',
    `${checkout.root}:/src`,

    // The paths that `impz image build <dir>` resolves on this machine exist in the container.
    '-v',
    `${checkout.root}:${checkout.root}`,
    '-v',
    `${layout.dataDir}:/data`,
    ...buildPortArgs(layout, env),
    '-e',
    `IMP_STORAGE_GIB=${pickSetting(env, 'IMP_STORAGE_GIB') ?? '200'}`,
    '-e',
    `IMP_UPLINK_MTU=${options.uplinkMTU}`,
    '-e',
    `IMP_KERNEL=${options.kernel}`,
    '-e',
    `IMP_SYSTEM_DRIVE=${options.systemDrive}`,
    '-e',
    `IMP_DEFAULT_IMAGE=${env['IMP_DEFAULT_IMAGE'] ?? ''}`,
    ...buildTailscaleArgs(options.tailscale),
    ...(options.tailnetOAuthFile === null
      ? []
      : ['-e', `IMP_TAILNET_OAUTH_FILE=${options.tailnetOAuthFile}`]),
    ...TUNING_VARIABLES.flatMap((variable) =>
      buildSettingArgs(env, variable, (value) => ['-e', `${variable}=${value}`]),
    ),
    ...(options.acmeCAFile === null ? [] : ['-e', `IMP_ACME_CA_FILE=${options.acmeCAFile}`]),
    ...(options.registryCAFile === null
      ? []
      : ['-e', `IMP_BUILD_TEST_REGISTRY_CA=${options.registryCAFile}`]),
    ...(options.registryHost === null ? [] : ['--add-host', options.registryHost]),
    '-e',
    'IMP_BROKER_TEST_UPSTREAMS=/data/broker-test-upstreams.json',
    '-e',
    'IMP_DASHBOARD_DIR=/src/packages/dashboard/dist',
    checkout.hostImage,
  ];
}

function buildSettingArgs(
  env: DevEnv,
  variable: string,
  build: (value: string) => string[],
): string[] {
  const value = env[variable] ?? '';

  return value === '' ? [] : build(value);
}

function buildPortArgs(layout: DevLayout, env: DevEnv): string[] {
  if (!layout.isPublished) {
    return [];
  }

  const ports = [
    '-p',
    `${String(layout.apiPort)}:7070`,
    '-p',
    `${String(layout.proxyPort)}:7080`,
    '-p',
    `${String(layout.impPortBase)}-${String(layout.impPortBase + 63)}:20000-20063`,
    '-p',
    `127.0.0.1:${String(layout.sshPort)}:22`,
  ];

  return (env['IMP_MCP_PUBLIC_URL'] ?? '') === ''
    ? ports
    : [
        ...ports,
        '-p',
        `127.0.0.1:${String(layout.mcpPort)}:${pickSetting(env, 'IMP_MCP_PUBLIC_PORT') ?? '7071'}`,
      ];
}

// -e with no value copies the key from docker's own environment, so it never lands in argv. An empty
// value overrides a key in .env, which impd reads as unset.
function buildTailscaleArgs(tailscale: TailscaleArg): string[] {
  return match(tailscale)
    .with('off', () => ['-e', 'TAILSCALE_AUTHKEY='])
    .with('key', () => ['-e', 'TAILSCALE_AUTHKEY'])
    .with('none', () => [])
    .exhaustive();
}
