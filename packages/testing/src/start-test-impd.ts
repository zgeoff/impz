import { createImpClient, watchEvents } from '@impz/client';
import type { ImpEvent } from '@impz/client';
import { buildImpPaths } from '@impz/daemon/host/vm/storage/build-imp-paths';
import { startTestImpd as startHarness } from '@impz/testing/stand-in/start-test-impd';
import { startFaultProxy } from './fault-proxy/start-fault-proxy';
import { startRelayGuest } from './start-relay-guest';
import { TEST_TOKEN } from './test-token';
import type { TestImpd, TestImpdOptions } from './types';

// the first agent release with every feature a reverse forward and a sleep need
const GUEST_AGENT_VERSION = '0.18.0';

export async function startTestImpd(options: TestImpdOptions = {}): Promise<TestImpd> {
  const stack = new AsyncDisposableStack();

  try {
    const harness = await startHarness(stack, {
      ...(options.env !== undefined && { env: options.env }),
      ...(options.onLog !== undefined && { onLog: options.onLog }),
    });

    harness.fake.agent.version = GUEST_AGENT_VERSION;

    const proxy = await startFaultProxy(stack, {
      impdUrl: harness.url,
      ...(options.version !== undefined && { version: options.version }),
      ...(options.features !== undefined && { features: options.features }),
    });

    const client = createImpClient({ url: proxy.url, token: TEST_TOKEN });

    // the guest's own calls reach impd directly, so they stay out of the proxy's call log
    const guestClient = createImpClient({ url: harness.url, token: TEST_TOKEN });

    return {
      url: proxy.url,
      impdUrl: harness.url,
      client,
      fail: proxy.fail,
      stall: proxy.stall,
      clearFaults: proxy.clearFaults,
      dropConnections: proxy.dropConnections,
      freeze: proxy.freeze,
      thaw: proxy.thaw,
      refuseExec: proxy.refuseExec,
      closeTunnels: proxy.closeTunnels,
      calls: proxy.calls,
      // oxlint-disable-next-line zgeoff/function-verb -- seedImage is the published name of this method
      seedImage: async (name) => {
        await harness.createTestImage(name);
      },
      startGuest: async (impName) => {
        const imp = await guestClient.imps.get({ name: impName });

        const vsockPath = buildImpPaths(harness.dataDir, imp.id).vsockSocket;

        const relay = await startRelayGuest(stack, vsockPath);

        const watching = new AbortController();

        const opened = Promise.withResolvers<void>();

        const watched = watchEvents(guestClient, {
          name: impName,
          signal: watching.signal,
          onOpen: () => {
            opened.resolve();
          },
          onEvent: (event) => {
            if (isGuestDown(event)) {
              relay.endConnections();
            }
          },
        });

        stack.defer(async () => {
          watching.abort();

          await watched.catch(() => {});
        });

        await Promise.race([opened.promise, watched]);

        return relay.guest;
      },
      fireTicker: harness.tickers.fire,
      stop: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();

    throw error;
  }
}

// the fake VMs keep the guest's socket through a sleep, where a real VM's agent connections end
function isGuestDown(event: Readonly<ImpEvent>): boolean {
  return event.ev === 'ImpRemoved' || (event.ev === 'ImpChanged' && event.imp.state !== 'running');
}
