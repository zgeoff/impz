import { afterAll, afterEach, beforeAll } from 'bun:test';
import { bypassAmbientProxy } from './bypass-ambient-proxy';
import { server } from './mock-server';
import { registerRunHooks } from './register-run-hooks';
import { registerTracing } from './register-tracing';
import { removeAmbientImpEnv } from './remove-ambient-imp-env';
import { buildRoutedFetch } from './route-fetch';

const nativeFetch = globalThis.fetch;

removeAmbientImpEnv();
bypassAmbientProxy();
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
