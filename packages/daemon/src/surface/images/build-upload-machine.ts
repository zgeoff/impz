import { setup } from 'xstate';

interface BuildUploadContext {
  readonly ttlMs: number;
  readonly free: () => void;
}

type BuildUploadEvent =
  | { readonly type: 'take' }
  | { readonly type: 'release' }
  | { readonly type: 'stop' };

// xstate's setup reads only the types of these fields, never a value, so an
// empty object serves.
interface BuildUploadTypes {
  readonly context?: BuildUploadContext;
  readonly input?: BuildUploadContext;
  readonly events?: BuildUploadEvent;
}

const types: BuildUploadTypes = {};

export const buildUploadMachine = setup({
  types,
  delays: {
    uploadTtl: (args) => args.context.ttlMs,
  },
  actions: {
    free: (args) => {
      args.context.free();
    },
  },
}).createMachine({
  id: 'build-upload',
  context: (args) => args.input,
  initial: 'held',
  states: {
    held: {
      on: {
        take: { target: 'taken' },
        stop: { target: 'released' },
      },
      after: {
        uploadTtl: { target: 'released' },
      },
    },
    taken: {
      on: {
        release: { target: 'released' },
      },
    },
    released: {
      type: 'final',
      entry: 'free',
    },
  },
});
