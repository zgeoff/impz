import { createImpClient, watchEvents } from '@impz/client';
import type { ImpEvent } from '@impz/client';
import { buildImpPaths } from '@impz/daemon/testing/data-layout';
import { startTestImpd as startHarness } from '@impz/daemon/testing/start-test-impd';
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

    const client = createImpClient({ url: harness.url, token: TEST_TOKEN });

    return {
      url: harness.url,
      token: TEST_TOKEN,
      client,
      seedImage: async (name) => {
        await harness.createTestImage(name);
      },
      startGuest: async (impName) => {
        const imp = await client.imps.get({ name: impName });

        const vsockPath = buildImpPaths(harness.dataDir, imp.id).vsockSocket;

        const relay = await startRelayGuest(stack, vsockPath);

        const watching = new AbortController();

        const opened = Promise.withResolvers<void>();

        const watched = watchEvents(client, {
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
