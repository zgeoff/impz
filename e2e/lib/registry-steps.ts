import { lookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import { instance, runChecked, runCommand } from './instance';

// On the host's loopback under a name, since the proxy refuses an IP or
// localhost; CI puts the name in /etc/hosts.

export interface Registry {
  readonly address: string;
  readonly container: string;

  readonly certPath: string;
}

export interface MovedTag {
  readonly tag: string;
  readonly kept: string;
  readonly pinned: string;
}

const RepoDigestsSchema = z.array(z.string());

export function parsePublishedPort(published: string): string {
  const port = published.trim().split('\n')[0]?.split(':').at(-1) ?? '';

  if (!/^\d+$/v.test(port)) {
    throw new Error(`no published port in "${published}"`);
  }

  return port;
}

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

// The engine may use the host's copy and ask nothing, or ask for the pin, but
// never for the tag.
export function collectUnpinnedRequests(pinned: string, seen: readonly string[]): string[] {
  const digest = pinned.slice(pinned.indexOf('@') + 1);

  return seen.filter((reference) => reference !== digest);
}

export async function checkRegistryReady(name: string): Promise<boolean> {
  const resolved = await lookup(name).catch(() => null);
  const sudo = await runCommand(['sudo', '--non-interactive', 'true']);

  // The engine asks a registry by name for HTTPS, so a journey trusts its own
  // certificate in certs.d, which needs sudo. A name that resolves elsewhere
  // would send the pushes there.
  if (resolved?.address === '127.0.0.1' && sudo.exitCode === 0) {
    return true;
  }

  if (process.env['CI'] !== undefined) {
    throw new Error(
      `CI is set, but ${name} does not resolve to 127.0.0.1 or sudo needs a password`,
    );
  }

  console.log(
    `    skipped: the suite needs ${name} to resolve to 127.0.0.1 and sudo with no password, as CI has; E2E_REGISTRY_NAME=imp-e2e.127.0.0.1.nip.io names one through DNS`,
  );

  return false;
}

const REGISTRY_OWNER_LABEL = 'imp-e2e-instance';

export async function startRegistry(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  name: string,
  container: string,
  directory: string,
): Promise<Registry> {
  const taken = await runCommand(['docker', 'container', 'inspect', container]);

  if (taken.exitCode === 0) {
    throw new Error(`a container named ${container} is already there`);
  }

  const certs = join(directory, 'certs');

  mkdirSync(certs, { recursive: true });

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
    '--publish',
    '127.0.0.1::5000',
    '--volume',
    `${certs}:/certs:ro`,
    '--env',
    'REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem',
    '--env',
    'REGISTRY_HTTP_TLS_KEY=/certs/key.pem',
    'registry:2',
  ]);

  stack.defer(async () => {
    await runCommand(['docker', 'rm', '--force', '--volumes', container]);
  });

  const published = await runChecked(['docker', 'port', container, '5000/tcp']);

  return {
    address: `${name}:${parsePublishedPort(published)}`,
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
): Promise<void> {
  const platformArgs = platform === undefined ? [] : ['--platform', platform];

  await runChecked([
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
}

export async function listManifestRequests(
  registry: Readonly<Registry>,
  repository: string,
): Promise<string[]> {
  const logs = await runCommand(['docker', 'logs', registry.container]);

  return parseManifestRequests(`${logs.stdout}${logs.stderr}`, repository);
}

export async function readFileInImage(name: string, path: string): Promise<string> {
  const output = await runChecked(['docker', 'run', '--rm', `imp/${name}:latest`, 'cat', path]);

  return output.trim();
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

  await createPushedImage(writeContext(directory, `${repository}-new`, from, 'new'), tag);
  await runChecked(['docker', 'tag', kept, tag]);

  return { tag, kept, pinned };
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
