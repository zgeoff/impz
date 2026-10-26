import { join } from 'node:path';
import { runTestBootstrap } from './run-test-bootstrap';
import { wireBootstrapIO } from './wire-bootstrap-io';

if (import.meta.main) {
  const exitCode = await runTestBootstrap({
    argv: Bun.argv.slice(2),
    root: join(import.meta.dir, '..', '..', '..', '..'),
    runID: process.pid,
    io: wireBootstrapIO(),
  });

  process.exit(exitCode);
}
