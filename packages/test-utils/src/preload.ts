import { afterAll, afterEach, beforeAll } from 'bun:test';
import { server } from './mock-server';
import { registerRunHooks } from './register-run-hooks';
import { registerTracing } from './register-tracing';
import { removeAmbientImpEnv } from './remove-ambient-imp-env';
import { removeAmbientProxyEnv } from './remove-ambient-proxy-env';
import { buildRoutedFetch } from './route-fetch';

const nativeFetch = globalThis.fetch;

removeAmbientImpEnv();
removeAmbientProxyEnv();
registerRunHooks();
registerTracing();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  globalThis.fetch = buildRoutedFetch(nativeFetch, globalThis.fetch);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();

  globalThis.fetch = nativeFetch;
});
