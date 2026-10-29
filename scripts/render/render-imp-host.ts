import { readFileSync, writeFileSync } from 'node:fs';
import * as z from 'zod';
import { ZFS_POOL_FILE, parseZfsPoolProperties } from '../lib/parse-zfs-pool-properties.ts';
import { PLAIN_WORD } from '../lib/plain-word.ts';

const ARGS_FILE = 'deploy/imp-host.args.json';
const UNIT_FILE = 'deploy/imp-host.service';
const BOOTSTRAP_FILE = 'deploy/bootstrap.sh';
const ENV_EXAMPLE_FILE = 'deploy/imp-host.env.example';
const HOST_ENV_FILE = 'deploy/lib/host-env.sh';
const STORAGE_FILE = 'deploy/bootstrap/storage.sh';

export const BOOTSTRAP_PARTS = [
  'deploy/bootstrap/start.sh',
  'deploy/lib/host-env.sh',
  'deploy/bootstrap/checks.sh',
  'deploy/bootstrap/packages.sh',
  'deploy/bootstrap/storage.sh',
  'deploy/bootstrap/kernel.sh',
  'deploy/bootstrap/network.sh',
  'deploy/bootstrap/units.sh',
  'deploy/bootstrap/imp.sh',
  'deploy/bootstrap/main.sh',
] as const;

const UNITS_PART = 'deploy/bootstrap/units.sh';

// systemd splits an unbraced $NAME into words, so one variable of the env file can hold zero or
// more words.
const ENV_WORDS = /^\$[A-Z][A-Z0-9_]*$/u;
const EXEC_START = /^ExecStart=\/usr\/bin\/podman run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\}$/mu;
const PROBE = /^ExecStartPre=\/bin\/sh -c 'a=; .*'$/mu;
const NETWORK_START = /^ExecStartPre=\/bin\/sh -c 'case "\$\$IMP_HOST_NETWORK" in .*'$/mu;
const PROBED_FILE = '/run/imp-host/probed.env';
const HOST_ENV_NETWORK = /^readonly HOST_NETWORK=.*$/mu;
const HOST_ENV_BRIDGE = /^readonly HOST_BRIDGE=.*$/mu;
const HOST_ENV_ADDRESSES = /^host_addresses\(\) \{ .* \}$/mu;
const STORAGE_POOL_PROPERTIES = /^readonly ZPOOL_CREATE_PROPERTIES=.*$/mu;

type Lines = readonly (readonly string[])[];

interface ProbedSetting {
  readonly name: string;
  readonly value: string;
}

interface Probed {
  readonly path: string;
  readonly args: readonly string[];

  // the env file setting that must hold this value too, for a device only one feature needs
  readonly setting?: ProbedSetting | undefined;
}

interface HostNetwork {
  readonly name: string;
  readonly bridge: string;
}

export interface HostArgs {
  readonly privileges: Lines;

  readonly probed: readonly Probed[];
  readonly lines: Lines;
  readonly network: HostNetwork;
  readonly addresses: string;
}

const WordSchema = z.string().regex(PLAIN_WORD, { error: 'is not a plain word' });

const LineWordSchema = z.string().refine((word) => PLAIN_WORD.test(word) || ENV_WORDS.test(word), {
  error: 'is not a plain word or $NAME',
});

const PrivilegeLinesSchema = z
  .array(z.array(WordSchema).nonempty({ error: 'must be non-empty' }))
  .nonempty({ error: 'must be non-empty' });

const LinesSchema = z
  .array(z.array(LineWordSchema).nonempty({ error: 'must be non-empty' }))
  .nonempty({ error: 'must be non-empty' });

const ProbedSettingSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u, { error: 'is not a setting name' }),
  value: WordSchema,
});

const ProbedSchema = z.object({
  path: WordSchema,
  args: z.array(WordSchema).nonempty(),
  setting: ProbedSettingSchema.optional(),
});

// Linux limits an interface name, such as a bridge's, to 15 bytes.
const HostNetworkSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/u, { error: 'is not a network name' }),
  bridge: z.string().regex(/^[a-z][a-z0-9-]{0,14}$/u, { error: 'is not a bridge name' }),
});

// The pipeline goes on one line into the unit's sh -c '...' and into a shell function.
const AddressesSchema = z
  .string()
  .regex(/^[^'\n$]+$/u, { error: 'must be one line without a quote or a $' });

const HostArgsSchema = z.object({
  privileges: PrivilegeLinesSchema,
  probed: z.array(ProbedSchema),
  lines: LinesSchema,
  network: HostNetworkSchema,
  addresses: AddressesSchema,
});

export function parseHostArgs(json: string): HostArgs {
  const parsed = HostArgsSchema.safeParse(JSON.parse(json));

  if (!parsed.success) {
    throw new Error(`${ARGS_FILE}: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
}

export function renderStorage(storage: string, create: readonly string[]): string {
  if (!STORAGE_POOL_PROPERTIES.test(storage)) {
    throw new Error(`${STORAGE_FILE}: no line for ZPOOL_CREATE_PROPERTIES`);
  }

  return storage.replace(
    STORAGE_POOL_PROPERTIES,
    () => `readonly ZPOOL_CREATE_PROPERTIES="${create.join(' ')}"`,
  );
}

export function renderExecStart(args: HostArgs): string {
  const [first = [], ...rest] = args.lines;
  const tail = [...args.privileges, ...rest].map((line) => `  ${line.join(' ')} \\`);

  return [
    `ExecStart=/usr/bin/podman run ${first.join(' ')} \\`,
    ...tail,
    '  $IMP_HOST_PROBED \\',
    `  \${IMP_HOST_IMAGE}`,
  ].join('\n');
}

// The unit reads the host's addresses at each start, because a new DHCP lease can change them.
export function renderProbe(probed: readonly Probed[], addresses: string): string {
  const tests = probed.map(
    (entry) =>
      `[ -e ${entry.path} ] && ${renderSettingTest(entry.setting)}a="$$a ${entry.args.join(' ')}"; `,
  );

  return `ExecStartPre=/bin/sh -c 'a=; ${tests.join('')}{ echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(${addresses})"; } >${PROBED_FILE}'`;
}

// The unit reads the env file before its ExecStartPre, so the shell sees the setting.
function renderSettingTest(setting: Readonly<ProbedSetting> | undefined): string {
  return setting === undefined ? '' : `[ "$$${setting.name}" = ${setting.value} ] && `;
}

export function renderNetworkStart(network: HostNetwork): string {
  const create = `/usr/bin/podman network create --ipv6 --subnet "$$IMP_HOST_SUBNET6" --disable-dns --interface-name ${network.bridge} ${network.name} >/dev/null`;

  return `ExecStartPre=/bin/sh -c 'case "$$IMP_HOST_NETWORK" in *${network.name}*) /usr/bin/podman network exists ${network.name} || ${create} ;; esac'`;
}

export function renderUnit(unit: string, args: HostArgs): string {
  if (!EXEC_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no podman run ExecStart that ends in \${IMP_HOST_IMAGE}`);
  }

  if (!PROBE.test(unit)) {
    throw new Error(`${UNIT_FILE}: no ExecStartPre=/bin/sh -c '...' for the probed args`);
  }

  if (!NETWORK_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no ExecStartPre=/bin/sh -c 'case ...' for the IPv6 network`);
  }

  // A replacement string reads $$ as one $, so each replacement is a function.
  return unit
    .replace(EXEC_START, () => renderExecStart(args))
    .replace(PROBE, () => renderProbe(args.probed, args.addresses))
    .replace(NETWORK_START, () => renderNetworkStart(args.network));
}

export function renderHostEnv(hostEnv: string, args: HostArgs): string {
  const lines = [
    ['HOST_NETWORK', HOST_ENV_NETWORK, `readonly HOST_NETWORK=${args.network.name}`],
    ['HOST_BRIDGE', HOST_ENV_BRIDGE, `readonly HOST_BRIDGE=${args.network.bridge}`],
    ['host_addresses', HOST_ENV_ADDRESSES, `host_addresses() { ${args.addresses}; }`],
  ] as const;

  return lines.reduce((text, [name, pattern, line]) => {
    if (!pattern.test(text)) {
      throw new Error(`${HOST_ENV_FILE}: no line for ${name}`);
    }

    return text.replace(pattern, () => line);
  }, hostEnv);
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface DeployFile extends SourceFile {
  readonly function: string;
}

const GENERATED_HEAD =
  '#!/bin/bash\n' +
  '# Generated by bun run render:deploy (scripts/render/render-imp-host.ts) from the parts in\n' +
  '# deploy/bootstrap/ and deploy/lib/host-env.sh: edit those, then run it again.\n';

const PART_DIRECTIVE = /^# shellcheck shell=bash\n/u;

export function renderBootstrap(
  parts: readonly SourceFile[],
  deployFiles: readonly DeployFile[],
): string {
  if (!parts.some((part) => part.path === UNITS_PART)) {
    throw new Error(`${BOOTSTRAP_FILE}: no part ${UNITS_PART} for the deploy files to follow`);
  }

  const sections = parts.flatMap((part) => {
    const section = `# --- ${part.path} ---\n\n${part.text.replace(PART_DIRECTIVE, '')}`;

    return part.path === UNITS_PART ? [section, renderDeployFiles(deployFiles)] : [section];
  });

  return `${GENERATED_HEAD}\n${sections.join('\n')}`;
}

function renderDeployFiles(deployFiles: readonly DeployFile[]): string {
  const functions = deployFiles.map((file) => {
    if (/^EOF$/mu.test(file.text)) {
      throw new Error(`${file.path}: a line EOF would end its heredoc in ${BOOTSTRAP_FILE}`);
    }

    return `${file.function}() {\n  cat << 'EOF'\n${file.text.replace(/\n+$/u, '')}\nEOF\n}\n`;
  });

  const paths = deployFiles.map((file) => file.path).join(', ');

  return `# --- ${paths} ---\n\n${functions.join('\n')}`;
}

export interface Rendered {
  readonly unit: string;
  readonly hostEnv: string;
  readonly storage: string;
  readonly bootstrap: string;
}

export interface BootstrapSources {
  readonly parts: readonly SourceFile[];
  readonly envExample: string;
  readonly zfsPoolJson: string;
}

export function render(argsJson: string, current: Rendered, sources: BootstrapSources): Rendered {
  const args = parseHostArgs(argsJson);
  const unit = renderUnit(current.unit, args);
  const hostEnv = renderHostEnv(current.hostEnv, args);
  const storage = renderStorage(current.storage, parseZfsPoolProperties(sources.zfsPoolJson));

  const rendered: Readonly<Record<string, string>> = {
    [HOST_ENV_FILE]: hostEnv,
    [STORAGE_FILE]: storage,
  };

  const parts = sources.parts.map((part) => ({
    path: part.path,
    text: rendered[part.path] ?? part.text,
  }));

  return {
    unit,
    hostEnv,
    storage,
    bootstrap: renderBootstrap(parts, [
      { path: UNIT_FILE, function: 'unit_imp_host', text: unit },
      { path: ENV_EXAMPLE_FILE, function: 'env_template', text: sources.envExample },
    ]),
  };
}

const FILES = {
  unit: UNIT_FILE,
  hostEnv: HOST_ENV_FILE,
  storage: STORAGE_FILE,
  bootstrap: BOOTSTRAP_FILE,
} as const;

const KEYS = ['unit', 'hostEnv', 'storage', 'bootstrap'] as const;

function main(): void {
  const current: Rendered = {
    unit: readFileSync(UNIT_FILE, 'utf8'),
    hostEnv: readFileSync(HOST_ENV_FILE, 'utf8'),
    storage: readFileSync(STORAGE_FILE, 'utf8'),
    bootstrap: readFileSync(BOOTSTRAP_FILE, 'utf8'),
  };

  const sources: BootstrapSources = {
    parts: BOOTSTRAP_PARTS.map((path) => ({ path, text: readFileSync(path, 'utf8') })),
    envExample: readFileSync(ENV_EXAMPLE_FILE, 'utf8'),
    zfsPoolJson: readFileSync(ZFS_POOL_FILE, 'utf8'),
  };

  const next = render(readFileSync(ARGS_FILE, 'utf8'), current, sources);
  const stale = KEYS.filter((key) => next[key] !== current[key]).map((key) => FILES[key]);

  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      console.error(
        `render-imp-host: ${stale.join(', ')} differ from their sources; run bun run render:deploy`,
      );

      process.exit(1);
    }

    console.log(`render-imp-host: ${Object.values(FILES).join(', ')} match their sources`);

    return;
  }

  for (const key of KEYS) {
    writeFileSync(FILES[key], next[key]);
  }

  console.log(`render-imp-host: wrote ${stale.length > 0 ? stale.join(', ') : 'nothing new'}`);
}

if (import.meta.main) {
  main();
}
