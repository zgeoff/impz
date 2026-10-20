// whether `docker buildx` runs on this machine; the Docker suites skip
// without it. `docker` is the binary, the one on PATH by default.
export function checkDockerBuildx(docker = 'docker'): boolean {
  return (
    Bun.which(docker) !== null &&
    Bun.spawnSync([docker, 'buildx', 'version'], { stdout: 'ignore', stderr: 'ignore' }).success
  );
}

export interface DockerBuildOptions {
  // the Dockerfile, as `-f` takes it
  readonly dockerfile: string;

  // a context directory, or a context tar piped to `-` on stdin
  readonly context: { readonly directory: string } | { readonly tarPath: string };

  // where `-o type=local` exports the image's files
  readonly destination: string;
}

// Runs the real `docker buildx build` and exports the image's files to
// dest; a FROM scratch image pulls nothing. Throws with docker's stderr when
// the build fails.
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
