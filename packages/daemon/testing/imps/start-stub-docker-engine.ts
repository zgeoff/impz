import { onTestFinished } from 'bun:test';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { z } from 'zod';
import type { ContainerSchema as ProxyContainerSchema } from '../../src/imps/docker-proxy/proxy';
import type { PinInspectSchema } from '../../src/imps/images/pull/image-pin';

interface StubEngineContainer {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly exportBytes?: Uint8Array<ArrayBuffer>;
}

interface StubEngineRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly isBodyCut: boolean;
}

// The engine has read the request's body before it calls an answer.
export type StubEngineAnswer = (
  request: Request,
  seen: StubEngineRequest,
) => Response | null | Promise<Response | null>;

export interface StubDockerEngineOptions {
  readonly directoryPath: string;
  readonly builtImageId?: string;
}

// the API version a Docker 29 engine answers with
const API_VERSION = '1.55';
const CONTAINER_PATH = /^\/containers\/(?<id>[^\/]+)(?<rest>\/json|\/export)?$/v;
const IMAGE_PATH = /^\/images\/(?<name>.+)\/json$/v;
const CreateBodySchema = z.object({ Labels: z.record(z.string(), z.string()).nullish() });

const ContainerSchema = z.object({
  id: z.string().default(buildEngineId),
  labels: z.record(z.string(), z.string()).default({}),
  exportBytes: z.instanceof(Uint8Array).default(() => new Uint8Array()),
});

const ImageSchema = z.object({
  ref: z
    .string()
    .default(
      () => `docker.io/library/${faker.string.alpha({ length: 8, casing: 'lower' })}:latest`,
    ),
  id: z.string().default(() => `sha256:${buildEngineId()}`),
});

export function startStubDockerEngine(options: Readonly<StubDockerEngineOptions>) {
  const socket = join(options.directoryPath, 'engine.sock');
  const seen: StubEngineRequest[] = [];
  const unexpected: string[] = [];

  const containers = new Collection({ schema: ContainerSchema });
  const images = new Collection({ schema: ImageSchema });

  const state: { answer: StubEngineAnswer | null } = { answer: null };

  // the engine finds a container by its full ID or a unique prefix of it
  const findContainer = (id: string) =>
    containers.findFirst((query) => query.where({ id: (full: string) => full.startsWith(id) }));

  const buildUnmodelledAnswer = (method: string, path: string): Response => {
    unexpected.push(`${method} ${path}`);

    return buildError(500, `stub docker engine: ${method} ${path} is not modelled`);
  };

  const answerImage = async (method: string, path: string, query: string) => {
    if (path === '/images/create' && method === 'POST') {
      const params = new URLSearchParams(query);

      const fromImage = params.get('fromImage') ?? '';
      const tag = params.get('tag') ?? 'latest';
      const ref = tag.startsWith('sha256:') ? `${fromImage}@${tag}` : `${fromImage}:${tag}`;

      await images.create({ ref: normalizeImageRef(ref) });

      return new Response(`${JSON.stringify({ status: `Pulling from ${fromImage}` })}\n`);
    }

    const name = IMAGE_PATH.exec(path)?.groups?.['name'];

    if (name === undefined || method !== 'GET') {
      return null;
    }

    const image = images.findFirst((where) => where.where({ ref: normalizeImageRef(name) }));

    if (image === undefined) {
      return buildError(404, `No such image: ${name}`);
    }

    const familiar = toFamiliarRef(image.ref);
    const isDigest = familiar.includes('@');

    const inspect = {
      Id: image.id,
      RepoTags: isDigest ? [] : [familiar],
      RepoDigests: isDigest ? [familiar] : [],
      Os: 'linux',
      Architecture: 'amd64',
      Config: {},
      Size: 0,
    } satisfies z.input<typeof PinInspectSchema> & { RepoTags: string[]; Size: number };

    return Response.json(inspect);
  };

  const answerContainer = async (
    method: string,
    path: string,
    body: Uint8Array,
  ): Promise<Response | null> => {
    if (path === '/containers/create' && method === 'POST') {
      const parsed = CreateBodySchema.parse(JSON.parse(new TextDecoder().decode(body)));

      const container = await containers.create({ labels: parsed.Labels ?? {} });

      return Response.json({ Id: container.id, Warnings: [] }, { status: 201 });
    }

    const match = CONTAINER_PATH.exec(path)?.groups;
    const id = match?.['id'];
    const rest = match?.['rest'];

    const isModelled =
      (rest === '/json' && method === 'GET') ||
      (rest === '/export' && method === 'GET') ||
      (rest === undefined && method === 'DELETE');

    if (id === undefined || !isModelled) {
      return null;
    }

    const container = findContainer(id);

    if (container === undefined) {
      return buildError(404, `No such container: ${id}`);
    }

    if (rest === '/json') {
      const inspect = {
        Id: container.id,
        Config: { Labels: container.labels },
      } satisfies z.input<typeof ProxyContainerSchema>;

      return Response.json(inspect);
    }

    if (rest === '/export') {
      return new Response(container.exportBytes);
    }

    containers.delete((where) => where.where({ id: container.id }));

    return new Response(null, { status: 204 });
  };

  const answerDefault = async (
    method: string,
    path: string,
    query: string,
    body: Uint8Array,
  ): Promise<Response> => {
    if (path === '/_ping' && (method === 'GET' || method === 'HEAD')) {
      const pong = method === 'HEAD' ? null : 'OK';

      return new Response(pong, { headers: { 'api-version': API_VERSION } });
    }

    if (path === '/version' && method === 'GET') {
      return Response.json({ ApiVersion: API_VERSION, Os: 'linux', Arch: 'amd64' });
    }

    if (path === '/build' && method === 'POST') {
      const id = options.builtImageId ?? `sha256:${'e'.repeat(64)}`;

      return new Response(`${JSON.stringify({ id: 'moby.image.id', aux: { ID: id } })}\n`);
    }

    const image = await answerImage(method, path, query);
    const container = await answerContainer(method, path, body);

    return image ?? container ?? buildUnmodelledAnswer(method, path);
  };

  const handleRequest = async (request: Request) => {
    const url = new URL(request.url);

    const read = await readBody(request);

    const received: StubEngineRequest = {
      method: request.method,
      target: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...read,
    };

    seen.push(received);

    const answered = state.answer === null ? null : await state.answer(request, received);

    return (
      answered ?? answerDefault(request.method, readApiPath(url.pathname), url.search, read.body)
    );
  };

  const server = Bun.serve({
    unix: socket,
    fetch: handleRequest,
  });

  const stopping: { done: Promise<void> | null } = { done: null };

  const stop = (): Promise<void> => {
    stopping.done ??= server.stop(true);

    return stopping.done;
  };

  onTestFinished(stop);

  return {
    dockerHost: `unix://${socket}`,
    socket,
    seen,
    unexpected,
    addContainer: (container: Readonly<StubEngineContainer>) =>
      containers.create({
        id: container.id,
        labels: { ...container.labels },
        exportBytes: container.exportBytes ?? new Uint8Array(),
      }),
    addImage: (ref?: string) => {
      const record = ref === undefined ? {} : { ref: normalizeImageRef(ref) };

      return images.create(record);
    },
    hasContainer: (id: string) =>
      containers.findFirst((query) => query.where({ id })) !== undefined,
    hasImage: (ref: string) =>
      images.findFirst((query) => query.where({ ref: normalizeImageRef(ref) })) !== undefined,
    setAnswer: (answer: StubEngineAnswer | null) => {
      state.answer = answer;
    },
    stop,
  };
}

function buildEngineId(): string {
  return faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' });
}

function buildError(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

// Docker's reference parser puts a name with no registry on docker.io and a one-part
// docker.io name in library/, and gives a name with neither tag nor digest `latest`.
function normalizeImageRef(ref: string): string {
  const [named = '', digest] = ref.split('@');
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const repository = colon > slash ? named.slice(0, colon) : named;
  const tag = colon > slash ? named.slice(colon + 1) : 'latest';
  const [first = '', ...rest] = repository.split('/');

  const hasRegistry =
    rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');

  const path = hasRegistry ? rest.join('/') : repository;
  const registry = hasRegistry && first !== 'index.docker.io' ? first : 'docker.io';
  const libraryPath = registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  const full = `${registry}/${libraryPath}`;

  return digest === undefined ? `${full}:${tag}` : `${full}@${digest}`;
}

// the engine leaves docker.io/library/ and docker.io/ off RepoTags and RepoDigests
function toFamiliarRef(ref: string): string {
  return ref.replace(/^docker\.io\/(?:library\/)?/v, '');
}

async function readBody(request: Request): Promise<{ body: Uint8Array; isBodyCut: boolean }> {
  const chunks: Uint8Array[] = [];

  if (request.body === null) {
    return { body: new Uint8Array(), isBodyCut: false };
  }

  try {
    for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
  } catch {
    return { body: Bun.concatArrayBuffers(chunks, Infinity, true), isBodyCut: true };
  }

  return { body: Bun.concatArrayBuffers(chunks, Infinity, true), isBodyCut: false };
}

function readApiPath(path: string): string {
  return path.replace(/^\/v1\.\d+(?=\/)/v, '');
}
