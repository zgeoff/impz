import type { Uplinks } from '../../src/host-net/net/host-routes';

interface StubHostRoutesOptions {
  readonly connected4?: readonly string[];
  readonly connected6?: readonly string[];
  readonly uplinks?: Uplinks;
}

export function buildStubHostRoutes(options: Readonly<StubHostRoutesOptions> = {}) {
  const state = { failure: null as string | null };
  const uplinks = options.uplinks ?? { ipv4: [], ipv6: [] };

  return {
    deps: {
      readConnected4: (): Promise<readonly string[]> => Promise.resolve(options.connected4 ?? []),
      readConnected6: (): Promise<readonly string[]> => Promise.resolve(options.connected6 ?? []),
      readUplinks: (): Promise<Uplinks> =>
        state.failure === null
          ? Promise.resolve(uplinks)
          : Promise.reject(new Error(state.failure)),
    },

    failUplinks: (message: string): void => {
      state.failure = message;
    },

    restoreUplinks: (): void => {
      state.failure = null;
    },
  };
}
