import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import type { BuildOutput } from './create-build-steps';
import { decodeBuildTrace } from './decode-build-trace';
import type { BuildTrace } from './decode-build-trace';
import { makeTraceLines } from './make-trace-lines';
import { readRefusalError } from './run-docker';

const FAILURE_MAX_CHARS = 4000;

export interface DockerBuildOptions {
  readonly dockerHost: string | null;

  readonly tarPath: string;
  readonly tag: string;

  readonly dockerfile: string | undefined;

  readonly signal: AbortSignal;

  readonly output?: BuildOutput | undefined;
}

export class DockerBuildError extends Error {
  override readonly name = 'DockerBuildError';
}

// Docker's POST /build stream carries BuildKit's trace as base64 protobuf under `aux`.
const BuildMessageSchema = z.object({
  id: z.string().optional(),
  aux: z.unknown().optional(),
  error: z.string().optional(),
  errorDetail: z.object({ message: z.string().optional() }).optional(),
});

const ImageIdSchema = z.object({ ID: z.string().regex(/^sha256:[a-f0-9]{64}$/v) });
const RefusalSchema = z.object({ message: z.string() });
const LINE_MAX_CHARS = 8 * 1024 ** 2;

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`docker build: the engine sent a line that is not JSON: ${line.slice(0, 200)}`);
  }
}

async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder();

  let pending = '';

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });

    const lines = pending.split('\n');

    pending = lines.pop() ?? '';

    if (pending.length > LINE_MAX_CHARS) {
      throw new Error(
        `docker build: the engine sent a line longer than ${String(LINE_MAX_CHARS)} characters`,
      );
    }

    for (const line of lines) {
      if (line.trim() !== '') {
        yield parseLine(line);
      }
    }
  }

  pending += decoder.decode();

  if (pending.trim() !== '') {
    yield parseLine(pending);
  }
}

// The Docker engine answers 200 for a build that fails, and reports the failure in the
// message stream.
/* @internal */
export async function readBuiltImageId(
  messages: Readonly<AsyncIterable<unknown> | Iterable<unknown>>,
  onTrace?: (trace: BuildTrace) => void,
): Promise<string> {
  let imageId: string | null = null;

  for await (const raw of messages) {
    const message = BuildMessageSchema.parse(raw);
    const failure = message.errorDetail?.message ?? message.error;

    if (failure !== undefined) {
      throw new DockerBuildError(`docker build failed: ${failure.slice(-FAILURE_MAX_CHARS)}`);
    }

    if (message.id === 'moby.image.id') {
      imageId = ImageIdSchema.parse(message.aux).ID;
    }

    if (message.id === 'moby.buildkit.trace' && onTrace !== undefined) {
      const trace = findBuildTrace(message.aux);

      if (trace !== null) {
        onTrace(trace);
      }
    }
  }

  if (imageId === null) {
    throw new Error('docker build: the engine sent no image ID');
  }

  return imageId;
}

function findBuildTrace(aux: unknown): BuildTrace | null {
  if (typeof aux !== 'string') {
    return null;
  }

  try {
    return decodeBuildTrace(Buffer.from(aux, 'base64'));
  } catch {
    return null;
  }
}

async function readRefusal(response: Response): Promise<Error> {
  const text = await response.text();

  const refused = response.status === 403 ? readRefusalError('docker build', text) : null;

  if (refused !== null) {
    return refused;
  }

  let message = text.trim();

  try {
    const parsed = RefusalSchema.safeParse(JSON.parse(text));

    message = parsed.success ? parsed.data.message : message;
  } catch {}

  const status = String(response.status);

  if (response.status === 413) {
    return new DockerBuildError(message);
  }

  return new Error(`docker build: the engine answered ${status}: ${message}`);
}

/* @internal */
export function readDockerSocket(dockerHost: string | null): string {
  if (dockerHost === null) {
    return '/var/run/docker.sock';
  }

  if (!dockerHost.startsWith('unix:///')) {
    throw new Error(
      `DOCKER_HOST is ${dockerHost}; impd builds images only through a unix socket, unix:///<path>`,
    );
  }

  return dockerHost.slice('unix://'.length);
}

export async function runDockerBuild(options: Readonly<DockerBuildOptions>): Promise<string> {
  const query = new URLSearchParams([
    ['t', options.tag],
    ['version', '2'],
    ['buildargs', JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })],
  ]);

  if (options.dockerfile !== undefined) {
    query.set('dockerfile', options.dockerfile);
  }

  // Bun sends the request to the unix socket and ignores the URL's host. timeout: false
  // lifts Bun's 360 s limit on a silent response, which a RUN step with no output outlasts.
  const response = await fetch(`http://docker/build?${query.toString()}`, {
    method: 'POST',
    timeout: false,
    headers: { 'content-type': 'application/x-tar' },
    body: Bun.file(options.tarPath),
    unix: readDockerSocket(options.dockerHost),
    signal: options.signal,
  });

  if (!response.ok || response.body === null) {
    throw await readRefusal(response);
  }

  const output = options.output;
  const onTrace = output === undefined ? undefined : makeTraceLines(output);

  return readBuiltImageId(readJsonLines(response.body), onTrace);
}
