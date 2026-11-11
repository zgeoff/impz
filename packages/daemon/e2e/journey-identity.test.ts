import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IdentityTrustDocumentSchema } from '@impz/api';
import { verifyImpIdentity } from '@impz/client/identity';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { readContainerGateway } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '@impz/e2e-harness/reset-baseline';
import { startStubUpstream } from '@impz/e2e-harness/start-stub-upstream';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: getSuitePrefix('identity'), stack, client, gateway };
}

test('it gives each of two imps its own identity token through a custom connector, whatever header the imp sends', async () => {
  const ctx = await setupTest();

  const names = [`${ctx.prefix}one`, `${ctx.prefix}two`];
  const secret = `${ctx.prefix}svc`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  for (const name of names) {
    await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await holdImp(name);
  }

  const added = await tryImp(
    [
      'secret',
      'add',
      secret,
      '--kind',
      'static',
      '--hosts',
      'svc.imp.internal',
      '--upstream',
      upstream.plainOrigin,
      '--identity',
    ],
    { stdin: `${token}\n` },
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  for (const name of names) {
    await runImp('grant', name, secret);
  }

  const printed = await runImp('identity', 'jwks');

  const document = IdentityTrustDocumentSchema.parse(JSON.parse(printed));

  const rows = await Promise.all(names.map((name) => requireImp(name)));

  const seenBefore = upstream.seenIdentities.length;

  for (const [index, name] of names.entries()) {
    await runShellInImp(
      name,
      `curl -sS --fail -H 'Imp-Identity: forged-${String(index)}' https://svc.imp.internal/svc-e2e/me`,
    );
  }

  const seen = upstream.seenIdentities.slice(seenBefore);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const callers = await Promise.all(
    seen.map((entry) =>
      verifyImpIdentity(entry.value, {
        issuers: [document],
        audience: 'svc.imp.internal',
        nowSeconds,
      }),
    ),
  );

  expect(added.exitCode).toBe(0);
  expect(document.issuer).toBe('e2e-host');
  expect(seen.map((entry) => entry.path)).toStrictEqual(['/svc-e2e/me', '/svc-e2e/me']);

  expect(seen.map((entry) => entry.value)).toSatisfyAll(
    (value: string | null) => value !== null && !value.includes('forged'),
  );

  expect(callers).toStrictEqual(
    rows.map((row) => ({ issuer: 'e2e-host', id: row.id, name: row.name })),
  );
});
