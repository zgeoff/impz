import { assign, setup } from 'xstate';

interface ReconcilerMachineInput {
  readonly startPass: (consecutiveErrors: number) => void;
  readonly pickDelayMs: (consecutiveErrors: number) => number;
}

interface ReconcilerMachineContext extends ReconcilerMachineInput {
  readonly consecutiveErrors: number;
  readonly delayMs: number;
  readonly rerun: boolean;
  readonly stopping: boolean;
}

type ReconcilerMachineEvent =
  | { readonly type: 'trigger' }
  | { readonly type: 'stop' }
  | { readonly type: 'passed'; readonly consecutiveErrors: number };

// xstate's setup reads only the types of these fields, never a value, so an
// empty object serves.
interface ReconcilerMachineTypes {
  readonly context?: ReconcilerMachineContext;
  readonly input?: ReconcilerMachineInput;
  readonly events?: ReconcilerMachineEvent;
}

const types: ReconcilerMachineTypes = {};

export const reconcilerMachine = setup({
  types,
  delays: {
    next: (args) => args.context.delayMs,
  },
  guards: {
    isStopping: (args) => args.context.stopping,
    isRerunRequested: (args) => args.context.rerun,
  },
  actions: {
    startPass: (args) => {
      args.context.startPass(args.context.consecutiveErrors);
    },
  },
}).createMachine({
  id: 'reconciler',
  context: (args) => ({
    ...args.input,
    consecutiveErrors: 0,
    delayMs: args.input.pickDelayMs(0),
    rerun: false,
    stopping: false,
  }),
  initial: 'waiting',
  states: {
    waiting: {
      after: {
        next: { target: 'running' },
      },
      on: {
        trigger: { target: 'running' },
        stop: { target: 'stopped' },
      },
    },
    running: {
      entry: 'startPass',
      on: {
        passed: [
          { guard: 'isStopping', target: 'stopped' },
          {
            guard: 'isRerunRequested',
            target: 'running',
            reenter: true,
            actions: assign((args) => ({
              consecutiveErrors: args.event.consecutiveErrors,
              rerun: false,
            })),
          },
          {
            target: 'waiting',
            actions: assign((args) => ({
              consecutiveErrors: args.event.consecutiveErrors,
              delayMs: args.context.pickDelayMs(args.event.consecutiveErrors),
            })),
          },
        ],
        trigger: { actions: assign({ rerun: true }) },
        stop: { actions: assign({ stopping: true }) },
      },
    },
    stopped: {
      type: 'final',
    },
  },
});
