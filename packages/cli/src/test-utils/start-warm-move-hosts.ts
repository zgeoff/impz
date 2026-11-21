import { createImpClient } from '@impz/client';
import { createMoveHosts, createUbuntuImage } from '@impz/daemon/test-utils';
import { TEST_TOKEN } from '@impz/testing/test-token';

export async function startWarmMoveHosts(stack: Readonly<AsyncDisposableStack>) {
  const hosts = await createMoveHosts(stack, { isShared: true });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  return {
    from: createImpClient({ url: hosts.source.url, token: TEST_TOKEN }),
    to: createImpClient({ url: hosts.target.url, token: TEST_TOKEN }),
  };
}
