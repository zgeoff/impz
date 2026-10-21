import { createImpClient } from '@impz/client';
import { TEST_TOKEN, startTestImpd } from '@impz/daemon/testing';
import type { TestImpd, TestImpdOptions } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { http } from 'msw';
import { IMPD_ORIGIN } from './impd-origin';
import { teeFirstChunk } from './tee-first-chunk';

export interface DashboardImpd {
  readonly harness: TestImpd;
  readonly logIn: (token?: string) => Promise<void>;
  readonly waitForEventStream: () => Promise<void>;
}

const EVENT_STREAM_PATH = '/rpc/events/stream';

// A browser keeps the session cookie that impd sets and sends it back to
// impd's origin, but Bun's fetch keeps no cookies, so the route keeps them.
export async function startDashboardImpd(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<TestImpdOptions> = {},
): Promise<DashboardImpd> {
  const harness = await startTestImpd(stack, options);

  const cookies = new Map<string, string>();

  const streamed = Promise.withResolvers<Error | null>();

  server.use(
    http.all(`${IMPD_ORIGIN}/*`, async (info) => {
      const request = new Request(info.request);

      if (cookies.size > 0) {
        request.headers.set('cookie', formatCookies(cookies));
      }

      const response = await harness.impd.api.app.handle(request);

      for (const header of response.headers.getSetCookie()) {
        const cookie = Bun.Cookie.parse(header);

        if (cookie.isExpired()) {
          cookies.delete(cookie.name);
        } else {
          cookies.set(cookie.name, cookie.value);
        }
      }

      if (new URL(request.url).pathname !== EVENT_STREAM_PATH) {
        return response;
      }

      // impd subscribes a stream to its events before it sends the stream's first
      // bytes, so an event published after them reaches the page
      const teed = teeFirstChunk(response);

      streamed.resolve(teed.firstChunk);

      return teed.response;
    }),
  );

  const waitForEventStream = async (): Promise<void> => {
    const failure = await streamed.promise;

    if (failure !== null) {
      throw new Error('the event stream failed before its first chunk', { cause: failure });
    }
  };

  return { harness, logIn, waitForEventStream };
}

function formatCookies(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function logIn(token = TEST_TOKEN): Promise<void> {
  await createImpClient({ url: IMPD_ORIGIN }).auth.login({ token });
}
