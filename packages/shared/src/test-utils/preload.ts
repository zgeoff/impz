import { afterEach } from 'bun:test';
import { bypassAmbientProxy } from './bypass-ambient-proxy';
import { githubRuns } from './github-actions-handlers';
import { registerTracing } from './register-tracing';
import { removeAmbientImpEnv } from './remove-ambient-imp-env';
import { setFakerSeed } from './set-faker-seed';

removeAmbientImpEnv();
bypassAmbientProxy();
setFakerSeed();
registerTracing();

afterEach(() => {
  githubRuns.clear();
});
