import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildStubBrowserFetch } from './build-stub-browser-fetch';

test('it marks a request to the page origin as same-origin', async () => {
  const sendRequest = mock<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test');

  await browserFetch('http://impd.test/rpc/auth/login', { method: 'POST' });

  const input = sendRequest.mock.calls[0]?.[0];

  invariant(input !== undefined);

  const request = new Request(input);

  expect(sendRequest).toHaveBeenCalledOnce();
  expect(request.headers.get('sec-fetch-site')).toBe('same-origin');
});

test('it leaves a request to another origin unmarked', async () => {
  const sendRequest = mock<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test');

  await browserFetch('http://other.test/api');

  const input = sendRequest.mock.calls[0]?.[0];

  invariant(input !== undefined);

  const request = new Request(input);

  expect(sendRequest).toHaveBeenCalledOnce();
  expect(request.headers.get('sec-fetch-site')).toBeNull();
});
