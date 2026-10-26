import { expect, onTestFinished, test } from 'bun:test';
import { waitAwakePastIdle } from '@impz/e2e-harness/awake-past-idle';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { assertState, createInstanceClient, requireImp, runImp } from '@impz/e2e-harness/imp-cli';
import { countMatches } from '@impz/e2e-harness/imp-proxy';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { listSessions, requireSession } from '@impz/e2e-harness/sessions';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { openTerminal } from '@impz/e2e-harness/terminal';
import { waitFor } from '@impz/e2e-harness/wait-for';

// One stack for every release, so each terminal closes before its imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('sessions'), stack, client };
}

test('it keeps a detached console session through an idle sleep, and redraws it at the new size on attach', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}idle`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const entry = await openTerminal(['console', name]);

  ctx.stack.defer(() => entry.close());

  await entry.waitForText('# ');

  entry.type('echo marker-$((6*7))\n');

  await entry.waitForText('marker-42');

  entry.type('\u001D');

  const consoleCode = await entry.exited;
  const started = await requireSession(name, 'main');

  expect(consoleCode).toBe(0);
  expect(entry.readOutput()).toContain(`detached from session main (impz attach ${name} main)`);
  expect(started).toMatchObject({ state: 'running', attached: false, cols: 80, rows: 24 });

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  const asleep = await requireSession(name, 'main');
  const imp = await requireImp(name);

  expect(asleep.pid).toBe(started.pid);
  expect(imp.state).toBe('sleeping');
  expect(imp.sessions).toBe(1);

  const attached = await openTerminal(['attach', name], { cols: 100, rows: 30 });

  ctx.stack.defer(() => attached.close());

  await attached.waitForText('marker-42');

  const replayed = attached.readOutput().length;

  // The shell runs the program as the foreground job, which SIGWINCH reaches.
  attached.type(
    String.raw`sh -c 'trap "echo size=\$(stty size)" WINCH; echo drawn; while :; do sleep 0.2; done'`,
  );

  attached.type('\n');

  await attached.waitForText('drawn', replayed);

  attached.type('\u001D');

  const attachedCode = await attached.exited;
  const wide = await openTerminal(['attach', name], { cols: 120, rows: 40 });

  ctx.stack.defer(() => wide.close());

  await wide.waitForText('size=40 120');

  const redrawn = await requireSession(name, 'main');

  wide.type('\u001D');

  await wide.exited;

  expect(attachedCode).toBe(0);
  expect(redrawn).toMatchObject({ pid: started.pid, attached: true, cols: 120, rows: 40 });
});

test('it hands a session over to a second attach, and ends the first', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}take`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const entry = await openTerminal(['console', name]);

  ctx.stack.defer(() => entry.close());

  await entry.waitForText('# ');

  entry.type(
    String.raw`sh -c 'trap "echo size=\$(stty size)" WINCH; echo drawn; while :; do sleep 0.2; done'`,
  );

  entry.type('\n');

  await entry.waitForText('drawn');

  entry.type('\u001D');

  await entry.exited;

  const first = await openTerminal(['attach', name]);

  ctx.stack.defer(() => first.close());

  await first.waitForText('size=24 80');

  const second = await openTerminal(['attach', name]);

  ctx.stack.defer(() => second.close());

  const firstCode = await first.exited;

  // The replay holds the sizes the first terminal saw; the redraw adds one.
  const seen = countMatches(first.readOutput(), 'size=24 80');

  await waitFor('the second terminal to redraw', () => {
    if (countMatches(second.readOutput(), 'size=24 80') <= seen) {
      throw new Error('no redraw yet');
    }
  });

  const typed = second.readOutput().length;

  second.type('\u0003');
  second.type('echo second-$((2+3))\n');

  await second.waitForText('second-5', typed);

  second.type('\u001D');

  await second.exited;

  expect(firstCode).toBe(254);
  expect(first.readOutput()).toContain('another client attached to session main');
});

test('it keeps an attached terminal through an imp sleep by attaching again', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}sleep`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const terminal = await openTerminal(['console', name]);

  ctx.stack.defer(() => terminal.close());

  await terminal.waitForText('# ');

  terminal.type('echo live-$((3+4))\n');

  await terminal.waitForText('live-7');

  const before = await requireSession(name, 'main');

  await runImp('sleep', name);

  await terminal.waitForText('attaching again');

  const after = terminal.readOutput().length;

  terminal.type('echo back-$((40+2))\n');

  await terminal.waitForText('attached again', after);
  await terminal.waitForText('back-42', after);

  terminal.type('\u001D');

  const exitCode = await terminal.exited;
  const session = await requireSession(name, 'main');

  expect(exitCode).toBe(0);
  expect(session.pid).toBe(before.pid);
});

test('it keeps the imp awake while a detached session is busy, and lets it sleep once that session is killed', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}busy`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const idle = await openTerminal(['console', name]);

  ctx.stack.defer(() => idle.close());

  await idle.waitForText('# ');

  idle.type('\u001D');

  await idle.exited;

  const busy = await openTerminal(['console', name, '--session', 'busy']);

  ctx.stack.defer(() => busy.close());

  await busy.waitForText('# ');

  const typed = busy.readOutput().length;

  busy.type('echo spin-$((1+1)); while :; do :; done\n');

  await busy.waitForText('spin-2', typed);

  busy.type('\u001D');

  await busy.exited;

  const detached = Date.now();

  await waitAwakePastIdle(name, detached);
  await runImp('sessions', 'kill', name, 'busy');

  const sessions = await listSessions(name);

  expect(sessions.map((session) => session.name)).toStrictEqual(['main']);

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });
});
