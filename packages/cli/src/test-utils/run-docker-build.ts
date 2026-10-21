export function checkDockerBuildx(docker = 'docker'): boolean {
  return (
    Bun.which(docker) !== null &&
    Bun.spawnSync([docker, 'buildx', 'version'], { stdout: 'ignore', stderr: 'ignore' }).success
  );
}

export interface DockerBuildOptions {
  readonly dockerfile: string;
  readonly context: { readonly directory: string } | { readonly tarPath: string };
  readonly destination: string;
}

export function runDockerBuild(options: Readonly<DockerBuildOptions>): void {
  const source = 'directory' in options.context ? options.context.directory : '-';
  const stdin = 'tarPath' in options.context ? Bun.file(options.context.tarPath) : 'ignore';

  const argv = [
    'docker',
    'buildx',
    'build',
    '--quiet',
    '-f',
    options.dockerfile,
    '-o',
    `type=local,dest=${options.destination}`,
    source,
  ];

  const result = Bun.spawnSync(argv, { stdin, stdout: 'ignore', stderr: 'pipe' });

  if (!result.success) {
    throw new Error(`${argv.join(' ')}: ${result.stderr.toString()}`);
  }
}
