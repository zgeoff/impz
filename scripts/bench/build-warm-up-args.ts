// A boot template serves one memory size, so the warm-up's creates take the
// timed run's --memory and warm the template that run boots from.
export function buildWarmUpArgs(benchArgs: readonly string[]): string[] {
  const warmUp = ['bench', 'create', '--concurrency', '1', '--samples', '3'];
  const index = benchArgs.findIndex((arg) => arg === '--memory' || arg.startsWith('--memory='));
  const flag = benchArgs[index];

  if (flag === undefined) {
    return warmUp;
  }

  if (flag !== '--memory') {
    return [...warmUp, flag];
  }

  const value = benchArgs[index + 1];

  return value === undefined ? warmUp : [...warmUp, flag, value];
}
