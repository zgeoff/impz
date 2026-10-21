import { TEST_TOKEN, startTestImpd } from '@impz/daemon/testing';
import type { TestImpd, TestImpdOptions } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { http } from 'msw';
import { IMPD_ORIGIN } from './impd-origin';

export interface DashboardImpd {
  readonly harness: TestImpd;
  readonly logIn: (token?: string) => Promise<void>;
}

// A browser keeps the session cookie that impd sets and sends it back to
// impd's origin, but Bun's fetch keeps no cookies, so the route keeps them.
export async function startDashboardImpd(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<TestImpdOptions> = {},
): Promise<DashboardImpd> {
  const harness = await startTestImpd(stack, options);

  const cookies = new Map<string, string>();

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

      return response;
    }),
  );

  return { harness, logIn };
}

function formatCookies(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function logIn(token = TEST_TOKEN): Promise<void> {
  const response = await fetch(`${IMPD_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (response.status !== 204) {
    throw new Error(`impd refused the login with ${String(response.status)}`);
  }
}
