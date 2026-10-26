import { join } from 'node:path';
import {
  SystemInfoSchema as ApiSystemInfoSchema,
  CheckpointSchema,
  ImageSchema,
  ImpSchema,
} from '@impz/api';
import type { ImpState } from '@impz/api';
import { createImpClient } from '@impz/client';
import type { ImpClient } from '@impz/client';
import * as z from 'zod';
import type { CommandResult, DevInstance } from './instance';
import { REPO_ROOT, instance, readToken, runCommand } from './instance';

const IMP_SCRIPT = join(REPO_ROOT, 'scripts', 'impz');
const ApiResourcesSchema = ImpSchema.shape.resources.unwrap();
const ApiDiskUsageSchema = ImpSchema.shape.diskUsage.unwrap();

// `impz --json` prints each Date as its ISO string, so the row takes the API's fields and gives
// each date its JSON shape.
const ImpRowSchema = ImpSchema.pick({
  id: true,
  name: true,
  image: true,
  state: true,
  vcpus: true,
  memoryMib: true,
  maxMemoryMib: true,
  pluggedMib: true,
  backup: true,
  slot: true,
  ip: true,
  port: true,
  url: true,
  ramMib: true,
  error: true,
  sessions: true,
  cpu: true,
  coldBootReason: true,
}).extend({
  lastActiveAt: z.iso.datetime(),
  sleptAt: z.iso.datetime().optional(),
  diskUsage: ApiDiskUsageSchema.extend({ measuredAt: z.coerce.date() }).optional(),
  resources: ApiResourcesSchema.extend({
    sample: ApiResourcesSchema.shape.sample.unwrap().pick({ cpuThrottledMs: true }).optional(),
  }).optional(),
});

const SystemInfoSchema = ApiSystemInfoSchema.pick({
  ramBudgetMib: true,
  ramUsedMib: true,
  ramReservedMib: true,
  awakeCount: true,
  impCount: true,
  storage: true,
  cpu: true,
  ksm: true,
  tailscale: true,
});

const CheckpointRowSchema = CheckpointSchema.pick({ id: true, label: true });
const ImageRowSchema = ImageSchema.pick({ name: true, ref: true, source: true });

export type ImpRow = z.infer<typeof ImpRowSchema>;

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export type CheckpointRow = z.infer<typeof CheckpointRowSchema>;

export type ImageRow = z.infer<typeof ImageRowSchema>;

const tokens = new Map<string, Promise<string>>();

// Read from the dev container when the runner passed no token, so a suite
// file also runs on its own.
function readImpToken(target: DevInstance): Promise<string> {
  if (target.token !== null) {
    return Promise.resolve(target.token);
  }

  let token = tokens.get(target.container);

  if (token === undefined) {
    token = readToken(target);

    tokens.set(target.container, token);
  }

  return token;
}

export async function readImpEnv(target: DevInstance = instance): Promise<Record<string, string>> {
  const impToken = await readImpToken(target);

  return { IMP_URL: target.apiUrl, IMP_TOKEN: impToken };
}

export async function createInstanceClient(target: DevInstance = instance): Promise<ImpClient> {
  const token = await readImpToken(target);

  return createImpClient({ url: target.apiUrl, token });
}

export interface ImpRunOptions {
  readonly stdin?: string;

  readonly token?: string;

  readonly target?: DevInstance;

  readonly env?: Readonly<Record<string, string>>;
}

export async function tryImp(
  args: readonly string[],
  options: ImpRunOptions = {},
): Promise<CommandResult> {
  const env = await readImpEnv(options.target);

  const runAs = options.token ?? env['IMP_TOKEN'] ?? '';

  return runCommand([IMP_SCRIPT, ...args], {
    ...(options.stdin !== undefined && { stdin: options.stdin }),
    env: { ...env, ...options.env, IMP_TOKEN: runAs },
  });
}

export async function startImp(args: readonly string[]) {
  const env = await readImpEnv();

  return Bun.spawn([IMP_SCRIPT, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
}

export function runImp(...args: readonly string[]): Promise<string> {
  return runImpWith({}, ...args);
}

export async function runImpWith(
  options: ImpRunOptions,
  ...args: readonly string[]
): Promise<string> {
  const result = await tryImp(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `imp ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}

export async function runInImp(name: string, ...argv: readonly string[]): Promise<string> {
  const stdout = await runImp('exec', name, '--', ...argv);

  return stdout.replace(/\n$/u, '');
}

export function runShellInImp(name: string, script: string): Promise<string> {
  return runInImp(name, 'sh', '-c', script);
}

export interface ImpUrls {
  readonly https: string | null;

  readonly service: string | null;
  readonly local: string;
  readonly tailnet: string | null;
}

// Read by the shape of each line, not its place: the https suite's settings
// stay for the whole run, so its line may come first.
export async function readImpUrls(name: string): Promise<ImpUrls> {
  const stdout = await runImp('url', name);

  const lines = stdout.split('\n').filter((line) => line !== '');
  const local = lines.find((line) => /^http:\/\/\S+\.imp\.localhost:\d+$/v.test(line));

  if (local === undefined) {
    throw new Error(`impz url ${name} printed no local URL: ${stdout}`);
  }

  const service = lines.find((line) => /^https:\/\/[\w\-]+\.[\w\-]+\.ts\.net$/v.test(line)) ?? null;
  const https = lines.find((line) => line !== service && line.startsWith('https://')) ?? null;
  const tailnet = lines.find((line) => line !== local && line.startsWith('http://')) ?? null;

  return { https, service, local, tailnet };
}

export async function listImps(target: DevInstance = instance): Promise<readonly ImpRow[]> {
  const stdout = await runImpWith({ target }, 'ls', '--json');

  return z.array(ImpRowSchema).parse(JSON.parse(stdout));
}

export async function readImp(
  name: string,
  target: DevInstance = instance,
): Promise<ImpRow | undefined> {
  const rows = await listImps(target);

  return rows.find((row) => row.name === name);
}

export async function requireImp(name: string, target: DevInstance = instance): Promise<ImpRow> {
  const row = await readImp(name, target);

  if (row === undefined) {
    throw new Error(`${name} is not in impz ls on ${target.container}`);
  }

  return row;
}

export async function readState(name: string, target: DevInstance = instance): Promise<ImpState> {
  const row = await requireImp(name, target);

  return row.state;
}

export async function assertState(
  name: string,
  state: ImpState,
  target: DevInstance = instance,
): Promise<void> {
  const actual = await readState(name, target);

  if (actual !== state) {
    throw new Error(`${name} is ${actual}, not ${state}`);
  }
}

export async function readInfo(target: DevInstance = instance): Promise<SystemInfo> {
  const stdout = await runImpWith({ target }, 'info', '--json');

  return parseSystemInfo(stdout);
}

export function parseSystemInfo(stdout: string): SystemInfo {
  return SystemInfoSchema.parse(JSON.parse(stdout));
}

export async function listCheckpoints(name: string): Promise<readonly CheckpointRow[]> {
  const stdout = await runImp('checkpoints', name, '--json');

  return z.array(CheckpointRowSchema).parse(JSON.parse(stdout));
}

export function parseImp(stdout: string): ImpRow {
  return ImpRowSchema.parse(JSON.parse(stdout));
}

export function parseImages(stdout: string): ImageRow[] {
  return z.array(ImageRowSchema).parse(JSON.parse(stdout));
}

export async function listImages(target: DevInstance = instance): Promise<readonly ImageRow[]> {
  const stdout = await runImpWith({ target }, 'image', 'ls', '--json');

  return parseImages(stdout);
}

export async function listImageNames(target: DevInstance = instance): Promise<readonly string[]> {
  const images = await listImages(target);

  return images.map((image) => image.name);
}
