# @impz/testing

A real [impd](https://github.com/zgeoff/impz), the imp host daemon, for the tests of code that
drives impd through [`@impz/client`](https://www.npmjs.com/package/@impz/client). impd runs its own
startup, API, broker and lifecycle in the test process, on stand-ins for the VMs and the host. A
test starts one in about 50 ms, so code that talks to impd needs no KVM host.

It runs on Bun only, under `bun test`: impd uses `bun:sqlite`. Each release matches the
`@impz/client` release of the same version.

```sh
bun add --dev @impz/testing
```

## Start and stop

```ts
import { onTestFinished, test } from 'bun:test';
import { startTestImpd } from '@impz/testing';

test('it creates an imp', async () => {
  const impd = await startTestImpd();

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');
  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });
});
```

`startTestImpd(options)` takes:

- `env`: impd settings, as the `IMP_*` variables impd reads at start. A setting that turns on HTTPS
  or OpenTelemetry export needs the package that impd loads for it, which the package lists as an
  optional peer dependency: add `acme-client` or the `@opentelemetry/*` exporters to your dev
  dependencies.
- `onLog`: a callback for each line impd logs. impd writes nothing to stderr.
- `version`: the version that `system.info` and `system.features` report, so a client's
  outdated-impd branch runs.
- `features`: feature flags merged into what `system.features` reports.

It returns:

| Field                 | What it is                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `url`                 | the fault proxy's API on a loopback port, for a client the test builds itself |
| `impdUrl`             | impd's own API, which bypasses the proxy                                      |
| `client`              | an `@impz/client` client on `url` with `TEST_TOKEN`, the root token           |
| `seedImage(name)`     | adds an image of that name, which `imps.create` boots                         |
| `startGuest(impName)` | starts the stand-in guest of a created imp, for reverse forwards              |
| `fireTicker(label)`   | runs one of impd's periodic jobs now; no job runs on its own                  |
| `stop()`              | stops impd and removes its data                                               |

It also returns the fault hooks `fail`, `stall`, `clearFaults`, `dropConnections`, `freeze`, `thaw`,
`refuseExec`, `closeTunnels` and the recorded `calls`.

## Faults and identity tokens

`url` and `client` reach impd through a proxy that forwards every request and WebSocket until a test
sets a fault.

```ts
impd.fail('imps/sleep', { code: 'CONFLICT', status: 409 }, { times: 1 });
```

`@impz/testing/identity` makes tokens that `verifyImpIdentity` from `@impz/client/identity` accepts,
with no impd:

```ts
import { createTestIdentityIssuer } from '@impz/testing/identity';

const issuer = await createTestIdentityIssuer({ issuer: 'host-a' });
const token = await issuer.signToken({ id: 'imp-1', name: 'box', audience: 'tasks.imp.internal' });
```

[Testing against impd](https://github.com/zgeoff/impz/blob/main/docs/guides/testing-impd.md) lists
each fault and each issuer method.

## The stand-in guest

An imp on this impd runs no VM, so nothing runs inside it. `startGuest(impName)` answers impd for
the imp's guest agent, and its `connect(port)` plays a process in the imp that dials a reverse
forward on that guest port. It returns a Node `Duplex`: what the test writes reaches the forward's
local end, and what that end sends back is what the test reads.

```ts
const guest = await impd.startGuest('box');
const stream = await guest.connect(4000);
```

The guest relays bytes and EOFs as the real guest agent's reverse forwards do, and drops its
connections when the imp sleeps.
[Testing against impd](https://github.com/zgeoff/impz/blob/main/docs/guides/testing-impd.md) lists
what it copies and what it does not.

## What this impd does not do

It boots no VM, runs no command in an imp, and reaches no network: an exec, a file copy or an egress
probe needs a real impd host. The broker refuses every upstream.
