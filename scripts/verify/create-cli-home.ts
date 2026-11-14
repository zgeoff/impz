import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/repo-root.ts';

export interface CLIHome {
  // XDG_CONFIG_HOME for impz: its current host is the run's impd, with the token saved
  readonly configHome: string;

  // a folder whose `impz` runs this checkout's CLI, for PATH
  readonly bin: string;

  // the same token, for the actions' own client
  readonly tokenFile: string;
}

const IMPZ = join(REPO_ROOT, 'scripts', 'impz');

// Logs this checkout's impz in to the run's impd, in a config folder of the run's own, so the
// terminal, the event stream and the actions read the URL and token from there and never from the
// developer's saved hosts. `impz login` reads the token from stdin, so it never lands in an argv.
export async function createCLIHome(
  directory: string,
  url: string,
  token: string,
): Promise<CLIHome> {
  const home: CLIHome = {
    configHome: join(directory, 'config'),
    bin: join(directory, 'bin'),
    tokenFile: join(directory, 'token'),
  };

  await mkdir(home.configHome, { recursive: true, mode: 0o700 });
  await mkdir(home.bin, { recursive: true });
  await symlink(IMPZ, join(home.bin, 'impz'));
  await writeFile(home.tokenFile, token, { mode: 0o600 });

  const login = Bun.spawn([IMPZ, 'login', url, '--name', 'verify'], {
    env: { ...process.env, XDG_CONFIG_HOME: home.configHome },
    stdin: new Blob([`${token}\n`]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stderr] = await Promise.all([login.exited, new Response(login.stderr).text()]);

  if (exitCode !== 0) {
    throw new Error(`impz login ${url} failed with exit ${String(exitCode)}: ${stderr.trim()}`);
  }

  return home;
}
