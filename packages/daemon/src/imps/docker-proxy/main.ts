import { chmodSync, rmSync } from 'node:fs';
import { loadOrCreateToken } from '../../identity/token';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { setupLogging } from '../../platform/process/setup-logging';
import { BUILD_IMAGE_PATTERN, DEFAULT_BUILD_IMAGE } from '../docker-contract/build-image';
import { CREATE_BODY_MAX_BYTES, createDockerProxy } from './proxy';

const BODY_SLACK_BYTES = 1024 ** 2;

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];

  return value === undefined || value === '' ? fallback : value;
}

// A default tag could name a repository other than the one the proxy runs from, and the rule that
// keeps a pull off that repository would then guard the wrong one.
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; set it to the image this proxy runs from`);
  }

  return value;
}

function readBuilderImage(): string {
  const image = readEnv('IMP_BUILD_IMAGE', DEFAULT_BUILD_IMAGE);

  if (!BUILD_IMAGE_PATTERN.test(image)) {
    throw new Error(`IMP_BUILD_IMAGE is ${image}, not an image by digest, <ref>@sha256:<hex>`);
  }

  return image;
}

function main(): void {
  setupLogging();

  const listen = readEnv('IMP_DOCKER_PROXY_LISTEN', '/run/imp-docker/docker.sock');
  const upstreamSocket = readEnv('IMP_DOCKER_PROXY_UPSTREAM', '/var/run/docker.sock');
  const stateDir = readEnv('IMP_DOCKER_PROXY_STATE', '/var/lib/imp-docker-proxy');
  const hostImage = requireEnv('IMP_HOST_IMAGE');
  const builderImage = readBuilderImage();

  const handleRequest = createDockerProxy({
    upstreamSocket,
    token: loadOrCreateToken(stateDir),
    hostImage,
    builderImage,
  });

  rmSync(listen, { force: true });

  // Bun's types leave idleTimeout off unix servers, but Bun applies it there too, and 0 lets an
  // export stream for as long as it takes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const serveOptions = {
    unix: listen,
    fetch: handleRequest,
    maxRequestBodySize: CREATE_BODY_MAX_BYTES + BODY_SLACK_BYTES,
    idleTimeout: 0,
  } as unknown as Bun.Serve.Options<undefined>;

  const server = Bun.serve(serveOptions);

  chmodSync(listen, 0o600);

  getImpdLogger('docker-proxy').info(
    'imp-docker-proxy on {listen}, engine {upstreamSocket}, host image {hostImage}, pulls only {builderImage}, no builds',
    { listen, upstreamSocket, hostImage, builderImage },
  );

  const stop = async (): Promise<void> => {
    await server.stop(true);

    rmSync(listen, { force: true });

    process.exit(0);
  };

  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main();
