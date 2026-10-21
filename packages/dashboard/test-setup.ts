import { afterAll, afterEach, beforeAll, mock } from 'bun:test';
import { registerRunHooks } from '@impz/test-utils/register-run-hooks';
import { resetMockDb } from './src/mocks/db/reset-mock-db';
import { IMPD_ORIGIN } from './src/mocks/handlers';
import { impdEventListeners } from './src/mocks/impd-events';
import { server } from './src/mocks/node';
import { buildStubBrowserFetch } from './src/test-utils/build-stub-browser-fetch';

const bunFetch = globalThis.fetch;

declare global {
  var happyDOM: { readonly setURL: (url: string) => void };
}

registerRunHooks();

globalThis.happyDOM.setURL(`${IMPD_ORIGIN}/ui/`);

// impd's session routes need the Sec-Fetch-Site header a browser sends; the
// stand-in wraps MSW's fetch, so MSW sees the header
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  globalThis.fetch = buildStubBrowserFetch(globalThis.fetch, `${IMPD_ORIGIN}/ui/`);
});

afterEach(() => {
  server.resetHandlers();

  resetMockDb();

  impdEventListeners.clear();
  mock.restore();
});

afterAll(() => {
  server.close();

  globalThis.fetch = bunFetch;
});
