# Stand-ins and booting impd

A stand-in replaces, in tests, a boundary that impd, its clients or its scripts cross, such as a VM
runner, a guest agent or a CLI that impd spawns. Give a new stand-in a test of its own beside it.
Before you write one, search for an existing one. A stand-in's file name starts with `build-stub-`,
`start-stub-`, `create-stub-` or `make-stub-`, and ends with what it replaces:

```bash
find packages scripts -path '*test-utils*' -name '*-stub-*.ts' ! -name '*.test.ts' | grep -i <boundary>
```

Read a stand-in's test to learn what it models and which calls it throws on.

The traps:

- A component that calls `Date.now()` itself ignores the test clock. Check before you control time,
  as [Booting impd](#booting-impd) shows.
- MSW (Mock Service Worker) sees only `fetch` calls in the test process. Use a real server for
  anything else, as [Kinds of stand-in](#kinds-of-stand-in) lists.
- Bun's idle timeouts end a silent request seconds later than the setting suggests.
  [Bun timer and transport facts](#bun-timer-and-transport-facts) gives the numbers.

## Contents

- [Kinds of stand-in](#kinds-of-stand-in)
- [Booting impd](#booting-impd)
- [Bun timer and transport facts](#bun-timer-and-transport-facts)
- [Broker test upstreams](#broker-test-upstreams)

## Kinds of stand-in

Choose the kind by the boundary that the code under test reaches:

- **The fake VMM**,
  [`buildStubVmm`](../../../../packages/daemon/src/test-utils/vm/build-stub-vmm.ts), replaces the VM
  runner, which starts and drives each Firecracker, under every impd test above the VM layer. Script
  each VM step to succeed, fail, die or hang. A hung step blocks until the test lets it go. Before
  you inspect a hung step, wait until the fake's `countHungCalls()` rises.
- **Guest agent stand-ins**, the `start-stub-*-agent` files, listen on an imp's vsock socket and
  speak the agent protocol. Pick the one for the protocol area the test drives, such as exec,
  sessions, attach, services or dial. They write each answer through the generated schemas in
  `@impz/agent-protocol`, as the Go agent does. Write plain JSON only for an older agent's answer
  that leaves out a field the schema always writes.
- **Command fakes** answer a CLI that impd spawns, such as `zfs`, `nft`, `tailscale`, `restic` or
  `docker`. Each one keeps a model of the state behind the CLI and records the argv it got. Assert
  on the resulting state, and on the argv only when the argv is the contract.
- **Real servers on loopback or a unix socket** answer a call that MSW can't see: a call over a unix
  socket, from a `node:http` client, over a WebSocket, with real TLS checks, or from a child
  process. The Docker engine, the Firecracker API, the DNS upstream, SSH, ACME and the broker's
  upstreams each have a stand-in of this kind. A Docker engine stand-in answers a call it doesn't
  model with a 500, and adds the call to a list of unexpected calls. Assert that list empty in each
  test that uses one.
- **MSW handler sets** replace a remote HTTP API that impd calls at its real origin, such as
  Tailscale, Cloudflare or an OAuth token endpoint. Build the set in the test and register it there;
  the preload drops it after the test.
- **Temporary directories** replace `/proc`, `/sys` and the cgroup tree. Their readers take a root
  path from the caller.
- **Timer stand-ins** fire only when the test says so. In a test of one component without impd, use
  [`buildStubClock`](../../../../packages/daemon/src/test-utils/platform/build-stub-clock.ts) for
  its clock, and `buildStubRepeat` or `buildStubTickerTimer`, beside it, for its timer. A test that
  boots impd uses the harness's clock, as [Booting impd](#booting-impd) shows.
- **Version-skew proxies** sit in front of the real impd app and drop or add fields, procedures or
  events. The client, CLI and MCP tests use them to check behaviour against an older or a newer
  impd.
- **Stub binaries on a temporary `PATH`** replace the commands that the shell scripts in `scripts/`
  and `deploy/` run. Each stub logs its calls to one file and answers from a script that the test
  gives it.

impd shrinks a guest's memory by unplugging memory from it. Three stand-ins model an unplug, and
each applies it at a different time. Pick the one whose timing the code under test expects:

- the fake VMM applies the unplug when the request arrives;
- `buildStubGuestMemory`, used by
  [`memory-controller.test.ts`](../../../../packages/daemon/src/vm/memory/memory-controller.test.ts),
  returns the new size on the next read;
- `buildStubElasticGuest`, used by
  [`shrink-guest.test.ts`](../../../../packages/daemon/src/vm/memory/shrink-guest.test.ts), unplugs
  one step on each read.

## Booting impd

[`createImpd`](../../../../packages/daemon/src/create-impd.ts) builds impd from its config and its
boundaries; `main.ts` calls it in production. Tests call it through
[`startTestImpd`](../../../../packages/daemon/src/test-utils/start-test-impd.ts), which
`@impz/daemon/test-utils` exports. `startTestImpd` runs every startup step that production runs,
opens the API, the broker and the wake proxy on free ports, and passes a stand-in for each host
boundary.

- Send RPCs through the `client` it returns, which holds the root token, or through the real client
  to its `url`.
- Replace a boundary through its `boundaries` option, typed by `ImpdBoundaries`. A key you pass
  replaces the harness's default for that key.
- Run a periodic check yourself: the harness starts no ticker on its own. Fire a ticker through
  `tickers`, or call the check, such as `impd.idle.runCheck()` for idle sleep.
- Move time with `advance`. To start from a fixed time, pass `frozenClockMs`, and then you can also
  call `setClock`.
- Restart impd over the same database and VMs, as a crash leaves them, with `restartImpd`.
- Hold a VM step through the fake VMM, which the harness returns as `fake`.
- Read `rpcFailures` for each RPC that failed in the test. The harness also prints each one to the
  test log.

A component follows the harness's clock only when `createImpd` passes it the `now` boundary. A
component that calls `Date.now()` itself stays on the wall clock, and a test can't move its time.
Before you control time in a test, check which kind the code under test is:

```bash
grep -nw "now" packages/daemon/src/create-impd.ts
grep -rln "Date.now()" packages/daemon/src --include='*.ts' | grep -v '\.test\.ts$'
```

A hit in the first search on the call that builds your component means it gets impd's clock. A hit
in the second on your component's file means it reads the wall clock. Then give the component a
`now` parameter. Pass `now` to it from `createImpd`.

The imp service's sleep timing takes a clock of its own: the wait before it sleeps a guest that just
booted. `startTestImpd` gives that wait the harness's clock only when you pass `frozenClockMs`.
Without `frozenClockMs`, the wait runs on the wall clock.

Three harnesses build on `startTestImpd`:

- **The impd pool**,
  [`createTestImpdPool`](../../../../packages/daemon/src/test-utils/imps/create-test-impd-pool.ts),
  lends one impd to each case of a property-based test, and removes every imp the case left before
  the next case. When a case shuts impd down, call the `retire` the case receives. The pool then
  drops that impd, and the next case boots a fresh one.
- **The move hosts**, `setupMoveHosts` in
  [`create-move-hosts.ts`](../../../../packages/daemon/src/test-utils/imp-ops/create-move-hosts.ts),
  start a source impd and a target impd for a move. Pass a fetch hook to see every request the
  source sends to the target. The fake VMM numbers VMs from 1 on each host, so match the two hosts'
  VMs by imp, never by the VM's number.
- **The CLI's impd host**,
  [`startImpdHost`](../../../../packages/cli/src/test-utils/start-impd-host.ts), runs one real impd
  per saved host, each with its own data dir, database, port and root token, for CLI tests that
  switch between hosts.

The CLI, client and MCP tests drive a `startTestImpd` impd with the real client or the real binary.
To test a protocol fault that impd never sends, such as a cut stream or a bad frame, use a stand-in
peer when the fault is in the transport. When the fault is in the answer, call the function that
parses the answer directly.

## Bun timer and transport facts

When a test checks that a request times out, or that it survives a silence, set its timings from
these Bun behaviours:

- A Bun server with an idle timeout of 1 s ends a silent request about 4 s after its last byte. It
  ends a request with no body, and a streamed answer that stops. It never ends a request that sent a
  body and still waits for its answer.
- A child Bun with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1` ends a fetch about 8 s after the server stops
  sending. Run a client in such a child to test its keepalive.
- A Bun server on a unix socket closes a silent connection after its default idle timeout. A
  stand-in that keeps a connection silent on purpose, such as
  [`startStubSilentOrigin`](../../../../packages/daemon/src/test-utils/network/start-stub-silent-origin.ts),
  sets the idle timeout to 0 behind a type assertion: Bun's types leave the option off unix servers.
- Over a unix socket, Bun's fetch replaces the Content-Length of a Blob's stream with the Blob's
  real size. To send a declared size, build the stream yourself.
- Bun's fetch fails a request whose own stream ends short of its declared Content-Length, with
  `ERR_HTTP_CONTENT_LENGTH_MISMATCH`. To test that a server refuses a body larger than its limit,
  declare the larger size, send less, and leave the stream open.

## Broker test upstreams

impd's broker forwards a guest's request for an outside host that a grant allows. When
`IMP_BROKER_TEST_UPSTREAMS` holds the path of a routing file, the broker sends each host listed in
the file to a test server. It still checks certificates, against the file's CA.

In a daemon test, pass `IMP_BROKER_TEST_UPSTREAMS` in the `env` option of `startTestImpd`, with
`IMP_SUBNET` set to a loopback range, so that a loopback address counts as a guest. The broker
proxy's test, which also shows the file's format,
[`create-broker-proxy.test.ts`](../../../../packages/daemon/src/network/broker/proxy/create-broker-proxy.test.ts),
does this. The dev instance and the `connectors` end-to-end suite use the same file, as the
[development runbook](../../../../docs/runbooks/development.md#end-to-end-tests) describes.
