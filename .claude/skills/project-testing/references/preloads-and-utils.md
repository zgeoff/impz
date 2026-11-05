# Preloads, shared test utils and cleanup

These traps cost the most time:

- The root preload deletes your shell's `IMP_*` settings, so set an impd setting in the test.
- MSW fails any request that no handler answers, so a request to a real server needs that server on
  loopback or a unix socket.
- `onTestFinished` runs its callbacks first registered, first run. A disposable stack releases last
  deferred, first released. Pick the util by the order you need, as [Cleanup order](#cleanup-order)
  shows.

Before you rely on a helper, read its test, `<name>.test.ts` beside it. The test shows what the
helper does.

- [The root preload](#the-root-preload)
- [Shared test utils](#shared-test-utils)
- [The dashboard's preload](#the-dashboards-preload)
- [Cleanup order](#cleanup-order)
- [What a daemon setupTest returns](#what-a-daemon-setuptest-returns)

## The root preload

The [root preload](../../../../packages/shared/src/test-utils/preload.ts) runs before every test
file:

- It deletes every `IMP_*` variable the shell passed in, so your own settings never reach a test. It
  keeps the four that turn on the host networking, small filesystem and real ZFS pool tests:
  `IMP_HOST_TESTS`, `IMP_TEST_SMALL_FS`, `IMP_TEST_ZFS_ROOT` and `IMP_TEST_ZFS_DIR`.
- It starts an MSW server that fails each request no handler answers, and resets the handlers after
  each test.
- After each test, it puts back every variable that
  [`updateEnv`](../../../../packages/shared/src/test-utils/update-env.ts) changed, at the value it
  had before the test.

To give impd a setting:

1. Call `updateEnv('IMP_<NAME>', '<value>')` at the top of the test, before `setupTest()`.
2. In `setupTest()`, pass `env: readImpEnv()` to `startTestImpd`.
   [`readImpEnv`](../../../../packages/shared/src/test-utils/read-imp-env.ts) collects the `IMP_*`
   variables, and `startTestImpd` loads them into impd's config as production does.

## Shared test utils

Look in [the shared test utils](../../../../packages/shared/src/test-utils/) for a helper that knows
nothing about imp. Each package keeps its own stand-ins in its `src/test-utils/` folder.

- Wait on a condition with [`waitFor`](../../../../packages/shared/src/test-utils/wait-for.ts).
- Script a dependency's answers with
  [`buildStubAnswerQueue`](../../../../packages/shared/src/test-utils/build-stub-answer-queue.ts).
  It answers in order and throws on a call past the last answer, so a test that expects three calls
  fails on a fourth.
- Test behaviour that spans a whole test process, such as a preload, in a child `bun test` through
  [`runChildTests`](../../../../packages/shared/src/test-utils/run-child-tests.ts). The child gets
  its own working folder. `runChildTests` kills it after its `timeoutMs` argument, 4000 by default.

The end-to-end suites run under
[their own preload](../../../../packages/shared/src/test-utils/preload-e2e.ts), with no MSW server,
because each end-to-end test talks to a running impd over the network.

## The dashboard's preload

Dashboard component tests run the real client, `@impz/client`, against a real impd. The dashboard's
`bunfig.toml` preloads the DOM, then the root preload, then
[its own setup](../../../../packages/dashboard/test-setup.ts). That setup points the page at
`IMPD_ORIGIN`, a made-up origin that `startDashboardImpd` routes to impd, and adds the
`Sec-Fetch-Site` header that impd's same-origin check reads. A test never touches `IMPD_ORIGIN`.

To write a dashboard test:

1. Boot impd with
   [`startDashboardImpd`](../../../../packages/dashboard/src/test-utils/start-dashboard-impd.ts). It
   keeps impd's session cookie and sends it back, as a browser does.
2. Arrange state through the `harness` it returns: `harness.client`, an RPC client that holds the
   root token, or the harness's stand-ins.
3. Log in with that object's `logIn`.
4. Mount the whole app with
   [`renderApp`](../../../../packages/dashboard/src/test-utils/render-app.tsx).
5. Assert on impd's state, never on the arguments that a mock received.

The dashboard's type check reads impd's source with the DOM's types in place of Bun's. When daemon
code calls a function whose Bun signature differs from the DOM's, such as `fetch`, type the call so
that it checks under both.

## Cleanup order

Read a util's parameters to tell how it releases its resource:

- **A util that takes a stack as its first parameter**, such as
  [`startTestImpd`](../../../../packages/daemon/src/test-utils/start-test-impd.ts), defers its
  release into that stack and registers nothing. Search the `src/test-utils/` folders for
  `stack: Readonly<AsyncDisposableStack>` to find the others.
- **A util with no stack parameter** registers its own `onTestFinished`, so it releases before
  anything the test registers after the call.
- **A util with an optional `stack` option**, such as
  [`startStubAgent`](../../../../packages/daemon/src/test-utils/vm/start-stub-agent.ts), defers into
  the stack when you pass one, and registers its own `onTestFinished` only when you pass none.

When a test uses a stack, create it and register its disposal on the next line, so a throw later in
`setupTest()` still releases it:

```ts
const stack = new AsyncDisposableStack();

onTestFinished(() => stack.disposeAsync());
```

The stack releases last deferred, first released. When your resource must be released before the
util's resource, defer your release into the stack after the util's call. An example is a step that
the fake VMM, [`buildStubVmm`](../../../../packages/daemon/src/test-utils/vm/build-stub-vmm.ts),
still holds when impd stops.

## What a daemon setupTest returns

In a daemon test file, write `setupTest()` to create the stack, call `startTestImpd`, and return
what it returns, the harness. Seed no image in `setupTest()`:

- In each test that creates an imp, call the harness's `createTestImage` in the arrange phase. Keep
  the image record it returns when the test asserts on the image.
- To assert a timestamp, pass `frozenClockMs` to `startTestImpd` in `setupTest()`, and move the
  clock with the harness's `setClock` in the test's arrange phase.
