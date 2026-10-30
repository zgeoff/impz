import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { startTestImpd } from '@impz/daemon/testing';
import type { TestImpd } from '@impz/daemon/testing';

interface ImpdHostOptions {
  readonly env: Readonly<Record<string, string>>;
}

export async function startImpdHost(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<ImpdHostOptions>,
) {
  const ksm = { profitMib: 0 };
  const rootToken = faker.string.alphanumeric(32);
  const started: { harness: TestImpd | null } = { harness: null };
  const isAlive = (pid: number): boolean => started.harness?.fake.alive.has(pid) === true;

  const harness = await startTestImpd(stack, {
    env: options.env,
    rootToken,

    // held a minute past every span a test opens, so an imp's awake time
    // reads the same on every call
    frozenClockMs: Date.now() + 60_000,
    readUnsharedRamMib: (pid) => (isAlive(pid) ? 300 : null),
    checkGuestMerge: () => Promise.resolve(true),
    readKsmProfitMib: (pid) => {
      const profitMib = isAlive(pid) ? ksm.profitMib : null;

      return Promise.resolve(profitMib);
    },
  });

  started.harness = harness;

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);

  return {
    url: harness.url,
    rootToken,
    dataDir: harness.dataDir,
    db: harness.db,
    ksm,
    sendRequest,
    fake: harness.fake,

    // impd runs it on a ticker; a test runs one pass when it needs one
    runIdleCheck: () => harness.impd.idle.runCheck(),
    client: createImpClient({ url: 'http://impd.test', token: rootToken, fetch: sendRequest }),
  };
}
