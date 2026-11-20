# Testing against impd

`@impz/testing` runs a real impd in the test process, on stand-ins for the VMs and the host. The
[package README](../../packages/testing/README.md) covers the install, the start and stop, and what
`startTestImpd` returns. This guide covers the faults a test injects and how far the stand-in guest
copies the real guest agent.

## Faults a test injects

`url` and `client` reach impd through a proxy. With no rule set, it forwards each request and
WebSocket unchanged.

- `fail(procedure, answer, options?)` answers the next calls to a procedure, such as `imps/sleep`,
  with an oRPC defined error, or with a raw body that is no oRPC error. `options.times` bounds the
  calls, and `options.when` narrows them by the decoded input.
- `stall(procedure)` leaves matching calls with no answer until the client aborts or the test stops
  impd.
- `clearFaults()` and each handle's `clear()` remove faults.
- `dropConnections()` destroys every open HTTP and WebSocket connection with no close frame, which
  the client sees as code 1006.
- `freeze()` and `thaw()` hold every byte in both directions, so a liveness check under a fake clock
  sees silence.
- `refuseExec(error)` answers the next exec WebSocket with impd's error frame, such as
  `PRECONDITION_FAILED` with `data.reason: 'broker_not_ready'`, and closes it.
- `closeTunnels(code, reason)` closes each open tunnel control socket, such as with 4001
  `'tunnel gone'`.
- `startTestImpd({ version, features })` rewrites the version and the features that impd reports.
- `calls` lists each oRPC call as `{ procedure, input, authorization }`.

```ts
impd.fail('imps/sleep', { code: 'CONFLICT', status: 409 }, { times: 1 });
```

`@impz/testing/identity` makes tokens that `verifyImpIdentity` accepts, with no impd. Its README
section lists the issuer's methods. The proxy cannot reach a keep-alive connection that no request
is using, so `dropConnections` ends the requests in flight and the WebSockets.

## What the stand-in guest copies

An imp on this impd runs no VM. `startGuest(impName)` answers impd for the imp's guest agent, and
its `connect(port)` plays a process in the imp that dials a reverse forward on that guest port. The
guest copies these behaviours of the real guest agent's reverse forwards:

- Bytes relay both ways between the process and the forward's local end.
- The process's end of its side reaches the local end as an EOF, and the local end's EOF ends what
  the process reads.
- A process that resets its connection drops the relay with no EOF.
- A forward that asks for port 0 gets a free port, and a second forward on a port in use fails with
  `LISTEN_FAILED`.
- When the imp sleeps or goes away, the guest drops its connections, so a forward ends as `lost`. A
  forward opened after the wake listens on the guest again.

## What it does not copy

- Unix socket forwards and ssh-agent forwarding, which it answers with `UNKNOWN_OP`.
- The refusal of a port below 1024 to an image whose user is not root.
- The limit of 16 clients waiting for impd, and the 10 s after which an unpaired client closes.

A test of those behaviours needs a real impd host.
