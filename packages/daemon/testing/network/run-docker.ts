export async function runDocker(args: readonly string[]): Promise<string> {
  // Bun looks the binary up on the PATH it started with unless env is passed.
  const subprocess = Bun.spawn(['docker', ...args], {
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    const output = stderr.trim() === '' ? stdout.trim() : stderr.trim();

    throw new Error(`docker ${args.join(' ')} exited ${String(exitCode)}: ${output}`);
  }

  return stdout;
}
