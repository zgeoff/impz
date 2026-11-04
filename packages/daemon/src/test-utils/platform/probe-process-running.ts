export function probeProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means a process of another user holds the PID, so it still runs
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
