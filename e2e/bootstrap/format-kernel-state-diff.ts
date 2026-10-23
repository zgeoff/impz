interface KernelStates {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export function formatKernelStateDiff(states: KernelStates): string {
  const before = new Set(states.before);
  const after = new Set(states.after);

  const removed = states.before.filter((line) => !after.has(line)).map((line) => `< ${line}`);
  const added = states.after.filter((line) => !before.has(line)).map((line) => `> ${line}`);

  return [...removed, ...added].map((line) => `${line}\n`).join('');
}
