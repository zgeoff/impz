import { afterAll, afterEach, beforeAll } from 'bun:test';
import { buildRoutedFetch } from './build-routed-fetch';
import { bypassAmbientProxy } from './bypass-ambient-proxy';
import { githubRuns } from './github-actions-handlers';
import { registerRunHooks } from './register-run-hooks';
import { registerTracing } from './register-tracing';
import { removeAmbientImpEnv } from './remove-ambient-imp-env';
import { server } from './server';

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
  githubRuns.clear();
});

afterAll(() => {
  server.close();

  globalThis.fetch = nativeFetch;
});
