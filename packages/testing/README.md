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

It returns:

| Field                 | What it is                                                          |
| --------------------- | ------------------------------------------------------------------- |
| `url`                 | impd's API on a loopback port, for a client the test builds itself  |
| `client`              | an `@impz/client` client on `url` with `TEST_TOKEN`, the root token |
| `seedImage(name)`     | adds an image of that name, which `imps.create` boots               |
| `startGuest(impName)` | starts the stand-in guest of a created imp, for reverse forwards    |
| `fireTicker(label)`   | runs one of impd's periodic jobs now; no job runs on its own        |
| `stop()`              | stops impd and removes its data                                     |

The client sleeps and wakes an imp as it does on a real host: `client.imps.sleep({ name })` and
`client.imps.wake({ name })`.

## The stand-in guest

An imp on this impd runs no VM, so nothing runs inside it. `startGuest(impName)` answers impd for
the imp's guest agent, and its `connect(port)` plays a process in the imp that dials a reverse
forward on that guest port. It returns a Node `Duplex`: what the test writes reaches the forward's
local end, and what that end sends back is what the test reads.

```ts
import { openReverseForward } from '@impz/client';
import { TEST_TOKEN } from '@impz/testing';

const guest = await impd.startGuest('box');

const forward = openReverseForward({
  baseUrl: impd.url,
  token: TEST_TOKEN,
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

The guest copies these behaviours of the real guest agent's reverse forwards:

- Bytes relay both ways between the process and the forward's local end.
- The process's end of its side reaches the local end as an EOF, and the local end's EOF ends what
  the process reads.
- A process that resets its connection drops the relay with no EOF.
- A forward that asks for port 0 gets a free port, and a second forward on a port in use fails with
  `LISTEN_FAILED`.
- When the imp sleeps or goes away, the guest drops its connections, so a forward ends as `lost`. A
  forward opened after the wake listens on the guest again.

It does not copy:

- unix socket forwards and ssh-agent forwarding, which it answers with `UNKNOWN_OP`
- the refusal of a port below 1024 to an image whose user is not root
- the limit of 16 clients waiting for impd, and the 10 s after which an unpaired client closes

## What this impd does not do

It boots no VM, runs no command in an imp, and reaches no network: an exec, a file copy or an egress
probe needs a real impd host. The broker refuses every upstream.
