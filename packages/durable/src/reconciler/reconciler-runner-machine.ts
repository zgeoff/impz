import { assign, setup } from 'xstate';

interface ReconcilerRunnerContext {
  readonly controller: AbortController;
  readonly starting: Promise<void>;
}

type ReconcilerRunnerEvent =
  | { readonly type: 'start'; readonly starting: Promise<void> }
  | { readonly type: 'started' }
  | { readonly type: 'stop' }
  | { readonly type: 'stopped' };

// xstate's setup reads only the types of these fields, never a value, so an
// empty object serves.
interface ReconcilerRunnerTypes {
  readonly context?: ReconcilerRunnerContext;
  readonly events?: ReconcilerRunnerEvent;
}

const types: ReconcilerRunnerTypes = {};

export const reconcilerRunnerMachine = setup({
  types,
  actions: {
    abortPasses: (args) => {
      args.context.controller.abort();
    },
  },
}).createMachine({
  id: 'reconciler-runner',
  context: () => ({ controller: new AbortController(), starting: Promise.resolve() }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        start: {
          target: 'starting',
          actions: assign((args) => ({ starting: args.event.starting })),
        },
        stop: { target: 'stopping' },
      },
    },
    starting: {
      on: {
        started: { target: 'running' },
        stop: { target: 'stopping' },
      },
    },
    running: {
      on: {
        stop: { target: 'stopping' },
      },
    },
    stopping: {
      entry: 'abortPasses',
      on: {
        stopped: { target: 'stopped' },
      },
    },
    stopped: {
      type: 'final',
    },
  },
});
