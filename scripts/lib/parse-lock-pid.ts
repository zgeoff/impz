export function parseLockPid(text: string | null): number | null {
  const pid = Number(text ?? '');

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
