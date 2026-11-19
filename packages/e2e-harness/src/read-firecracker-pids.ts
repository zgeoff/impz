export function buildFirecrackerPgrepArgv(id: string): readonly string[] {
  return ['pgrep', '-f', `firecracker.*imps/${id}/`];
}

export function readFirecrackerPids(id: string, stdout: string): readonly string[] {
  const pids = stdout.split('\n').filter((pid) => pid !== '');

  if (pids.length === 0) {
    throw new Error(`no firecracker for imp ${id}`);
  }

  return pids;
}
