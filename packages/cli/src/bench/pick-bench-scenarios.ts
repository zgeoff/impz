import { UsageError } from '../cli/errors';
import type { BenchScenario } from './bench-scenarios';

export function pickBenchScenarios(
  text: string,
  scenarios: readonly BenchScenario[],
): BenchScenario[] {
  return text.split(',').map((part) => {
    const name = part.trim();
    const found = scenarios.find((scenario) => scenario.name === name);

    if (found === undefined) {
      const known = scenarios.map((scenario) => scenario.name).join(', ');

      throw new UsageError(`no bench scenario ${name}; pick from ${known}`);
    }

    return found;
  });
}
