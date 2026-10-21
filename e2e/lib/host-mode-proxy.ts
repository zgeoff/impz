import * as z from 'zod';

const WordsSchema = z.array(z.string());
const ProxyArgsSchema = z.object({ proxy: z.object({ privileges: z.array(WordsSchema) }) });

export interface HostModeProxyOptions {
  readonly argsJson: string;
  readonly name: string;

  readonly dockerGid: string;
  readonly hostImage: string;

  readonly socketVolume: string;
  readonly socket: string;

  readonly binary: string;
}

export function buildHostModeProxyArgv(options: Readonly<HostModeProxyOptions>): string[] {
  const args = ProxyArgsSchema.parse(JSON.parse(options.argsJson));
  const privileges = args.proxy.privileges.flat();

  return [
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    options.name,
    ...privileges,
    '--group-add',
    options.dockerGid,
    '-e',
    `IMP_HOST_IMAGE=${options.hostImage}`,
    '-e',
    'IMP_BUILD_ISOLATION=host',
    '-e',
    `IMP_DOCKER_PROXY_LISTEN=${options.socket}`,
    '-e',
    'IMP_DOCKER_PROXY_STATE=/tmp',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${options.socketVolume}:/run/imp-docker`,
    '-v',
    `${options.binary}:/usr/local/bin/imp-docker-proxy:ro`,
    options.hostImage,
    '/usr/local/bin/imp-docker-proxy',
  ];
}
