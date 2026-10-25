import { expect, test } from 'bun:test';
import { buildTicketHeader } from '../../src/imp-ops/moves/move-tickets';
import { SOURCE_PEER, TARGET_URL, setupMoveHosts } from './create-move-hosts';
import { makeStubSwitchedStorageTarget } from './make-stub-switched-storage-target';

function setupTest() {
  return setupMoveHosts();
}

test('it names the given storage in the real target offer reply', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  const request = new Request(`${TARGET_URL}/move/offer`, {
    method: 'POST',
    headers: { ...buildTicketHeader(ticket.ticket), 'content-type': 'application/json' },
    body: JSON.stringify({ imageDigest: 'sha256:ubuntu' }),
  });

  const response = await makeStubSwitchedStorageTarget('zfs')(
    request,
    (replacement) => ctx.target.moves.respond(replacement ?? request, SOURCE_PEER),
    ctx,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toStrictEqual({
    needsImage: true,
    needsSystemDrive: false,
    storage: 'zfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
    keepsBackupOff: true,
  });
});

test('it passes the answer of another route through unchanged', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  const request = new Request(`${TARGET_URL}/move/commit`, {
    method: 'POST',
    headers: buildTicketHeader(ticket.ticket),
  });

  const response = await makeStubSwitchedStorageTarget('xfs')(
    request,
    (replacement) => ctx.target.moves.respond(replacement ?? request, SOURCE_PEER),
    ctx,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    defined: false,
    code: 'CONFLICT',
    status: 409,
    message: 'nothing to commit: no receipt for this ticket',
    error: 'nothing to commit: no receipt for this ticket',
  });
});
