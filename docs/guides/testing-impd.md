# Testing against impd

`@impz/testing` runs a real impd in the test process, on stand-ins for the VMs and the host. For the
install, the start and stop, and what `startTestImpd` returns, read the
[package README](../../packages/testing/README.md). Read on for the faults a test injects, the test
identity issuer, and how far the stand-in guest copies the real guest agent.

## Faults a test injects

`url` and `client` reach impd through a proxy. With no fault set and no `version` or `features`
given to `startTestImpd`, the proxy forwards each request and WebSocket unchanged.

- `fail(procedure, answer, options?)` answers the next calls to a procedure, such as `imps/sleep`,
  with an oRPC defined error, or with a raw body that is no oRPC error. `options.times` bounds the
  calls, and `options.when` narrows them by the decoded input.
- `stall(procedure)` leaves matching calls with no answer until the client aborts or the test stops
  impd.
- `clearFaults()` and each handle's `clear()` remove faults.
- `dropConnections()` destroys every open connection with no close frame, idle keep-alive ones
  included, and ends the requests in flight. The client sees a WebSocket close as code 1006.
- `freeze()` holds every byte in both directions until `thaw()` releases them, so a liveness check
  under a fake clock sees silence.
- `refuseExec(error)` answers the next exec WebSocket with impd's error frame, such as
  `PRECONDITION_FAILED` with `data.reason: 'broker_not_ready'`, and closes it.
- `closeTunnels(code, reason)` closes each open tunnel control socket, such as with 4001
  `'tunnel gone'`.
- `startTestImpd({ version, features })` makes the proxy rewrite the version and the features in
  impd's `system/info` and `system/features` answers.
- `calls` lists each oRPC call as `{ procedure, input, authorization }`.

```ts
impd.fail('imps/sleep', { code: 'CONFLICT', status: 409 }, { times: 1 });
```

## The test identity issuer

`@impz/testing/identity` makes tokens that `verifyImpIdentity` accepts, with no impd.
`createTestIdentityIssuer({ issuer, kid? })` returns an issuer, and `kid` defaults to
`<issuer>-key-1`.

- `document` is the trust document for `loadIdentityIssuers`, with one key and no retire entry.
- `signToken({ id, name, audience, iat?, exp?, nowSeconds? })` returns a compact ES256 token as impd
  mints it, with `exp` 55 s after `iat` by default.
- `forge(claims)` returns a token that a fresh key signs under the same issuer and kid.
- `retire(at)` returns a copy of `document` that retires the key at `at`.
- `IDENTITY_HEADER` is `'imp-identity'`, the header that carries the token.

## What the stand-in guest copies

An imp on this impd runs no VM. `startGuest(impName)` stands in for the imp's guest agent, and its
`connect(port)` plays a process in the imp that dials a reverse forward on that guest port. The
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

Before you rely on a guest behaviour in a test, find it under
[What the stand-in guest copies](#what-the-stand-in-guest-copies). When it's missing there, test it
on a real impd host. When you change the real guest agent's reverse forwards, or the stand-in guest,
update both lists in the same change, because a test that passes on the stand-in trusts them.
