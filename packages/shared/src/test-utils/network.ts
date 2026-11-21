import { createTestNetwork } from '@zgeoff/testing/fetch';
import { githubActionsHandlers } from './github-actions-handlers';

// Suites that run several loopback servers at once bind 127.0.0.1 to 127.0.0.6, and reach each one
// by its own address, so every one of those skips the network, as the kit's default does for 127.0.0.1.
const LOOPBACK_HOSTS = [1, 2, 3, 4, 5, 6].map((last) => `127.0.0.${String(last)}`);

// The test run's one network. Each bunfig lists this module as a preload, so every test file
// answers fetch from these handlers and fails on a request that no handler matches. A request to
// a loopback stub server or over a unix socket skips it.
export const network = createTestNetwork({
  handlers: [...githubActionsHandlers],
  passthroughHosts: [...LOOPBACK_HOSTS, '[::1]', 'localhost'],
});
