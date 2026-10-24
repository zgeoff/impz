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

- `env`: impd settings, as the `IMP_*` variables impd reads at start.
- `onLog`: a callback for each line impd logs. impd writes nothing to stderr.

It returns:

| Field                 | What it is                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `url`                 | impd's API on a loopback port, for a client the test builds itself |
| `token`               | impd's root token, also exported as `TEST_TOKEN`                   |
| `client`              | an `@impz/client` client on `url` with the root token              |
| `seedImage(name)`     | adds an image of that name, which `imps.create` boots              |
| `startGuest(impName)` | starts the stand-in guest of a created imp, for reverse forwards   |
| `fireTicker(label)`   | runs one of impd's periodic jobs now; no job runs on its own       |
| `stop()`              | stops impd and removes its data                                    |

The client sleeps and wakes an imp as it does on a real host: `client.imps.sleep({ name })` and
`client.imps.wake({ name })`.

## The stand-in guest

An imp on this impd runs no VM, so nothing runs inside it. `startGuest(impName)` answers impd for
the imp's guest agent, and its `connect(port)` plays a process in the imp that dials a reverse
forward on that guest port. It returns a Node `Duplex`: what the test writes reaches the forward's
local end, and what that end sends back is what the test reads.

```ts
import { openReverseForward } from '@impz/client';

const guest = await impd.startGuest('box');

const forward = openReverseForward({
  baseUrl: impd.url,
  token: impd.token,
  name: 'box',
  guest: { network: 'tcp', port: 4000 },
  connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  onConnection: (accept) => {
    // relay to the local end, as the app under test does
  },
});

await forward.listening;

const stream = await guest.connect(4000);
```

When the imp sleeps or goes away, the guest drops its connections, as a real VM's agent does, so a
forward ends as `lost`. A forward opened after the wake listens on the guest again. `listPorts()`
lists the guest ports that a forward listens on now.

## What this impd does not do

It boots no VM, runs no command in an imp, and reaches no network: an exec, a file copy or an egress
probe needs a real impd host. The broker refuses every upstream.
