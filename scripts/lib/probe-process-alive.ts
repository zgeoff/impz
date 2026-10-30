// signal 0 checks only that the process exists; EPERM means it exists but
// belongs to a user this one may not signal
export function probeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
