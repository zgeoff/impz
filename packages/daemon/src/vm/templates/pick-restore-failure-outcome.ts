import { match } from 'ts-pattern';
import type { TemplateFault } from '../vmm/template-vm';

type RestoreFailureOutcome = 'ignore' | 'keep' | 'remove' | 'disable';

interface RestoreFailureFacts {
  readonly fault: TemplateFault;
  readonly isCurrentBuild: boolean;
  readonly restoredBefore: number;
  readonly restoredNow: number;
  readonly failuresBefore: number;
  readonly isOff: boolean;
}

export function pickRestoreFailureOutcome(
  facts: Readonly<RestoreFailureFacts>,
): RestoreFailureOutcome {
  if (!facts.isCurrentBuild) {
    return 'ignore';
  }

  return match(facts.fault)
    .with(null, (): RestoreFailureOutcome => 'ignore')
    .with('agent', () =>
      facts.restoredNow > facts.restoredBefore ? 'keep' : pickCountedOutcome(facts),
    )
    .with('load', () => pickCountedOutcome(facts))
    .exhaustive();
}

const MAX_RESTORE_FAILURES = 3;

function pickCountedOutcome(facts: Readonly<RestoreFailureFacts>): 'remove' | 'disable' {
  return facts.failuresBefore + 1 >= MAX_RESTORE_FAILURES && !facts.isOff ? 'disable' : 'remove';
}
