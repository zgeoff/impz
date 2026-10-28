# Testing against impd

`@impz/testing` runs a real impd in the test process, on stand-ins for the VMs and the host. The
[package README](../../packages/testing/README.md) covers the install, the start and stop, and what
`startTestImpd` returns. This guide covers how far the stand-in guest copies the real guest agent.

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
