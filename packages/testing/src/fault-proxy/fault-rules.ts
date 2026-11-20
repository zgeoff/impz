import type { DefinedFault, FailOptions, FaultHandle, RawFault } from '../types';

type FaultAction =
  | { readonly kind: 'answer'; readonly answer: DefinedFault | RawFault }
  | { readonly kind: 'stall' };

interface FaultRule {
  readonly procedure: string;
  readonly action: FaultAction;
  readonly when: ((input: unknown) => boolean) | undefined;
  remaining: number | null;
}

export interface FaultRules {
  readonly add: (procedure: string, action: FaultAction, options?: FailOptions) => FaultHandle;
  readonly clear: () => void;

  // the action of the first rule that matches the call, which uses up one of its calls
  readonly take: (procedure: string, input: unknown) => FaultAction | null;
}

export function createFaultRules(): FaultRules {
  let rules: FaultRule[] = [];

  const drop = (rule: FaultRule): void => {
    rules = rules.filter((candidate) => candidate !== rule);
  };

  return {
    add: (procedure, action, options = {}) => {
      const rule: FaultRule = {
        procedure,
        action,
        when: options.when,
        remaining: options.times ?? null,
      };

      rules.push(rule);

      return {
        clear: () => {
          drop(rule);
        },
      };
    },
    clear: () => {
      rules = [];
    },
    take: (procedure, input) => {
      const rule = rules.find(
        (candidate) =>
          candidate.procedure === procedure &&
          (candidate.when === undefined || candidate.when(input)),
      );

      if (rule === undefined) {
        return null;
      }

      if (rule.remaining !== null) {
        rule.remaining -= 1;

        if (rule.remaining <= 0) {
          drop(rule);
        }
      }

      return rule.action;
    },
  };
}
