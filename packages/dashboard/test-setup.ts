import { afterAll, afterEach, beforeAll, mock } from 'bun:test';
import { buildStubBrowserFetch } from './src/test-utils/build-stub-browser-fetch';
import { IMPD_ORIGIN } from './src/test-utils/impd-origin';

const routedFetch = globalThis.fetch;

declare global {
  var happyDOM: { readonly setURL: (url: string) => void };
}

globalThis.happyDOM.setURL(`${IMPD_ORIGIN}/ui/`);

// impd's same-origin check reads the Sec-Fetch-Site header a browser sends;
// the stand-in wraps MSW's fetch, so MSW sees the header
beforeAll(() => {
  globalThis.fetch = buildStubBrowserFetch(globalThis.fetch, `${IMPD_ORIGIN}/ui/`);
});

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  globalThis.fetch = routedFetch;
});
