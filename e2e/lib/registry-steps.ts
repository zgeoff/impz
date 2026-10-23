import { lookup } from 'node:dns/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImpClient } from '@impz/client';
import * as z from 'zod';
import { config } from './config';
import { runImp } from './imp-cli';
import { waitForExec } from './imps';
import { instance, runChecked, runCommand } from './instance';
import { registerRemoval } from './register-removal';
import type { RegistryPlan } from './registry-plan';
import { removeImpIfPresent } from './reset-baseline';

// The registry listens on its network's gateway under a name, which this
// machine resolves to the gateway and impd's container learns from dev.sh, so
// both the host engine and a builder reach it. CI puts the name in /etc/hosts.

export interface Registry {
  readonly address: string;
  readonly container: string;

  readonly certPath: string;
}

export interface MovedTag {
  readonly tag: string;
  readonly kept: string;
  readonly pinned: string;
  readonly current: string;
}

const RepoDigestsSchema = z.array(z.string());

export function parseManifestRequests(logs: string, repository: string): string[] {
  const pattern = new RegExp(`uri="/v2/${repository}/manifests/(?<reference>[^"]+)"`, 'gv');

  return [...logs.matchAll(pattern)].map((match) => match.groups?.['reference'] ?? '');
}

export function getRepoDigest(digests: string, repository: string): string {
  const own = RepoDigestsSchema.parse(JSON.parse(digests)).find((digest) =>
    digest.startsWith(`${repository}@`),
  );

  if (own === undefined) {
    throw new Error(`no RepoDigest under ${repository} in ${digests}`);
  }

  return own;
}

export function getDigest(reference: string): string {
  const at = reference.indexOf('@');

  if (at === -1) {
    throw new Error(`no digest in ${reference}`);
  }

  return reference.slice(at + 1);
}

export function collectUnpinnedRequests(pinned: string, seen: readonly string[]): string[] {
  const digest = getDigest(pinned);

  return seen.filter((reference) => reference !== digest);
}

export async function checkRegistryReady(plan: Readonly<RegistryPlan>): Promise<boolean> {
  const name = plan.name;

  const resolved = await lookup(name).catch(() => null);
  const sudo = await runCommand(['sudo', '--non-interactive', 'true']);

  // The engine asks a registry by name for HTTPS, so a journey trusts its own
  // certificate in certs.d, which needs sudo. A name that resolves elsewhere
  // would send the pushes there.
  if (resolved?.address === plan.gateway && sudo.exitCode === 0) {
    return true;
  }

  if (process.env['CI'] !== undefined) {
    throw new Error(
      `CI is set, but ${name} does not resolve to ${plan.gateway} or sudo needs a password`,
    );
  }

  console.log(
    `    skipped: the suite needs ${name} to resolve to ${plan.gateway} and sudo with no password, as CI has; E2E_REGISTRY_NAME=imp-e2e.${plan.gateway}.nip.io names one through DNS`,
  );

  return false;
}

const REGISTRY_OWNER_LABEL = 'imp-e2e-instance';

// The stack removes the plan's network and its certificate directory, which
// impd reads for each builder, with the registry.
export async function startRegistry(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  plan: Readonly<RegistryPlan>,
  container: string,
): Promise<Registry> {
  const taken = await runCommand(['docker', 'container', 'inspect', container]);

  if (taken.exitCode === 0) {
    throw new Error(`a container named ${container} is already there`);
  }

  const name = plan.name;
  const certs = plan.certDirectory;

  const left = await runCommand([
    'docker',
    'network',
    'inspect',
    plan.network,
    '--format',
    `{{index .Labels "${REGISTRY_OWNER_LABEL}"}}`,
  ]);

  if (left.exitCode === 0) {
    if (left.stdout.trim() !== instance.container) {
      throw new Error(
        `a network named ${plan.network} is there, and this instance did not label it`,
      );
    }

    await runChecked(['docker', 'network', 'rm', plan.network]);
  }

  await runChecked([
    'docker',
    'network',
    'create',
    '--label',
    `${REGISTRY_OWNER_LABEL}=${instance.container}`,
    '--subnet',
    plan.subnet,
    '--gateway',
    plan.gateway,
    plan.network,
  ]);

  stack.defer(async () => {
    await runCommand(['docker', 'network', 'rm', plan.network]);
  });

  mkdirSync(certs, { recursive: true });

  stack.defer(() => {
    rmSync(certs, { recursive: true, force: true });
  });

  await runChecked([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${name}`,
    '-addext',
    `subjectAltName=DNS:${name}`,
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ]);

  await runChecked([
    'docker',
    'run',
    '--detach',
    '--name',
    container,
    '--label',
    `${REGISTRY_OWNER_LABEL}=${instance.container}`,
    '--network',
    'host',
    '--volume',
    `${certs}:/certs:ro`,
    '--env',
    `REGISTRY_HTTP_ADDR=${plan.gateway}:${String(plan.port)}`,
    '--env',
    'REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem',
    '--env',
    'REGISTRY_HTTP_TLS_KEY=/certs/key.pem',
    'registry:2',
  ]);

  stack.defer(async () => {
    await runCommand(['docker', 'rm', '--force', '--volumes', container]);
  });

  return {
    address: `${name}:${String(plan.port)}`,
    container,
    certPath: join(certs, 'cert.pem'),
  };
}

export interface StaleRegistries {
  readonly removed: readonly string[];

  readonly left: readonly string[];
}

async function listRegistryContainers(filters: readonly string[]): Promise<string[]> {
  const listed = await runChecked([
    'docker',
    'ps',
    '--all',
    '--format',
    '{{.Names}}',
    ...filters.flatMap((filter) => ['--filter', filter]),
  ]);

  return listed.split('\n').filter((line) => line !== '');
}

export async function removeStaleRegistries(prefix: string): Promise<StaleRegistries> {
  const named = `name=^${prefix}registry-`;

  const all = await listRegistryContainers([named]);

  const own = await listRegistryContainers([
    named,
    `label=${REGISTRY_OWNER_LABEL}=${instance.container}`,
  ]);

  for (const container of own) {
    await runCommand(['docker', 'rm', '--force', '--volumes', container]);
  }

  const left = all.filter((container) => !own.includes(container));

  if (left.length > 0) {
    console.log(`    left registry containers this instance did not label: ${left.join(', ')}`);
  }

  return { removed: own, left };
}

export function writeContext(
  directory: string,
  name: string,
  dockerfile: string,
  value: string,
): string {
  const context = join(directory, name);

  mkdirSync(context, { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), dockerfile);
  writeFileSync(join(context, 'v'), `${value}\n`);

  return context;
}

export async function readBusyboxDigest(): Promise<string> {
  await runChecked(['docker', 'pull', '--quiet', 'busybox:1.37']);

  const digests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    'busybox:1.37',
  ]);

  return getRepoDigest(digests, 'busybox');
}

export async function createPushedImage(
  context: string,
  tag: string,
  platform?: string,
): Promise<string> {
  const platformArgs = platform === undefined ? [] : ['--platform', platform];

  const built = await runChecked([
    'docker',
    'build',
    '--quiet',
    ...platformArgs,
    '--provenance=false',
    '--sbom=false',
    '--tag',
    tag,
    context,
  ]);

  await runChecked(['docker', 'push', '--quiet', tag]);

  return built.trim();
}

export async function listManifestRequests(
  registry: Readonly<Registry>,
  repository: string,
): Promise<string[]> {
  const logs = await runCommand(['docker', 'logs', registry.container]);

  return parseManifestRequests(`${logs.stdout}${logs.stderr}`, repository);
}

// impd keeps a built image in its own store, so a journey reads it from an imp.
export async function createImageImp(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  client: ImpClient,
  name: string,
): Promise<void> {
  await runImp('new', name, '--image', name, '--memory', '512');

  registerRemoval(stack, config.keep, () => removeImpIfPresent(client, name));

  await waitForExec(name);
}

export async function readHostArch(): Promise<string> {
  const arch = await runChecked(['docker', 'version', '--format', '{{.Server.Arch}}']);

  return arch.trim();
}

export async function createMovedTag(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  registry: Readonly<Registry>,
  directory: string,
  repository: string,
): Promise<MovedTag> {
  const busybox = await readBusyboxDigest();

  const tag = `${registry.address}/${repository}:1`;
  const from = `FROM ${busybox}\nCOPY v /v\n`;

  await createPushedImage(writeContext(directory, `${repository}-old`, from, 'old'), tag);

  stack.defer(async () => {
    await runCommand(['docker', 'rmi', tag]);
  });

  // The containerd store drops an image whose last tag moves.
  const kept = `${registry.address}/${repository}:kept`;

  await runChecked(['docker', 'tag', tag, kept]);

  stack.defer(async () => {
    await runCommand(['docker', 'rmi', kept]);
  });

  const repoDigests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    tag,
  ]);

  const pinned = getRepoDigest(repoDigests, `${registry.address}/${repository}`);

  const moved = await createPushedImage(
    writeContext(directory, `${repository}-new`, from, 'new'),
    tag,
  );

  const currentDigests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    moved,
  ]);

  const current = getRepoDigest(currentDigests, `${registry.address}/${repository}`);

  await runChecked(['docker', 'tag', kept, tag]);

  return { tag, kept, pinned, current };
}

interface RunBuildAndListRequestsOptions {
  readonly registry: Readonly<Registry>;
  readonly directory: string;
  readonly repository: string;
  readonly dockerfile: string;
  readonly name: string;
}

export async function runBuildAndListRequests(
  options: RunBuildAndListRequestsOptions,
): Promise<string[]> {
  const name = options.name;

  const before = await listManifestRequests(options.registry, options.repository);

  await runImp(
    'image',
    'build',
    writeContext(options.directory, `build-${name}`, options.dockerfile, ''),
    '--name',
    name,
  );

  const after = await listManifestRequests(options.registry, options.repository);

  const seen = after.slice(before.length);

  console.log(
    `    the registry saw ${String(seen.length)} manifest requests during the build: ${seen.join(', ')}`,
  );

  return seen;
}
