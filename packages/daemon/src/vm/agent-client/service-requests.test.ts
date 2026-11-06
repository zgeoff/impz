import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubAgent } from '../../test-utils/vm/start-stub-agent';
import { openServiceLogStream } from './service-requests';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-service-logs-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { vsockPath: join(directory, 'vsock.sock') };
}

test('#openServiceLogStream names the guest and the log start when the agent never answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, () => {});

  expect(
    openServiceLogStream(ctx.vsockPath, { service: 'web', lines: 10, follow: false }, 1),
  ).rejects.toThrowWithMessage(
    Error,
    `agent at ${ctx.vsockPath} sent no services.logs start within 1 ms`,
  );
});
