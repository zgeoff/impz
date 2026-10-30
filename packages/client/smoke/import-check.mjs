// The packed client imported under plain Node, from a project that installed
// its tarball (scripts/release/check-client-package.sh): no Bun, no
// workspace. Argument: the version the package must report.
import assert from 'node:assert/strict';
import { CLIENT_VERSION, ExecError, createImpClient, isDefinedError } from '@impz/client';

const imp = createImpClient({ url: 'http://impd.test/', token: 't' });

assert.equal(CLIENT_VERSION, process.argv[2]);
assert.equal(typeof imp.imps.create, 'function');
assert.equal(typeof imp.requireAwake, 'function');
assert.equal(typeof imp.openExec, 'function');
assert.equal(typeof ExecError, 'function');
assert.equal(typeof isDefinedError, 'function');

console.log(`imported @impz/client ${CLIENT_VERSION}`);
