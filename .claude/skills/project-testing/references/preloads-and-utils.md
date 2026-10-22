# Preloads, shared test utils and cleanup

The [root preload](../../../../packages/test-utils/src/preload.ts) owns the shared state of every
test process, and the dashboard adds
[a setup of its own](../../../../packages/dashboard/test-setup.ts) after it. Helpers that every
package uses live in [the shared test utils](../../../../packages/test-utils/src/), and each package
keeps its own stand-ins in its `test-utils` folder. Read a helper's own test before you rely on it,
because that test pins what the helper does.

## The root preload

The root preload gives each unit test a clean impd environment. It deletes every `IMP_*` variable
the shell passed in, except the run gates, so a developer's own settings never reach a test. A test
that needs an impd setting sets it through
[`updateEnv`](../../../../packages/test-utils/src/update-env.ts) before it calls `setupTest()`, and
the test's impd then reads it through
[`readImpEnv`](../../../../packages/test-utils/src/read-imp-env.ts), as production does.

The end-to-end suites run under a preload of their own, with no MSW server, because each journey
talks to a real dev instance over the network.

The shared test utils hold the condition wait
[`waitFor`](../../../../packages/test-utils/src/wait-for.ts) and the scripted answer queue
[`buildStubAnswerQueue`](../../../../packages/test-utils/src/build-stub-answer-queue.ts). The queue
hands out a dependency's answers in order and throws on a call past the last one, so a test that
expects three calls fails on a fourth.

## The dashboard's preload

Dashboard component tests run the real SDK against a real impd. The dashboard loads the DOM, then
the root preload, then its own setup, which points the page at impd's fake origin and adds the
`Sec-Fetch-Site` header that a browser sends to its own origin, because impd's same-origin check
reads it.

[`startDashboardImpd`](../../../../packages/dashboard/src/test-utils/start-dashboard-impd.ts) boots
impd through `startTestImpd` and routes the fake origin to it through MSW. Bun's fetch keeps no
cookies, so the route keeps the session cookie that impd sets and sends it back, as a browser does.

The dashboard's typecheck reads impd's source under lib.dom, where bun-types give way to the DOM's
types. A daemon module that calls a Bun-only signature therefore types the call so that it checks
under both.

To write a test, boot impd with `startDashboardImpd`, arrange state through the harness's root
client or its stand-ins, log in with its `logIn`, and mount the whole app through
[`renderApp`](../../../../packages/dashboard/src/test-utils/render-app.tsx). Assert what the page
did through impd's own state, never through a call's input.

## Cleanup order

`onTestFinished` runs callbacks in the order of registration, so the cleanup order follows from
which kind of util a test calls:

- **A util that registers its own cleanup** releases its resource before anything that the test
  registers after the call. The guest agent stand-ins, the SSH and DNS stand-ins, the Firecracker
  stand-ins, the test databases, the port picker and the in-memory metrics are this kind. A stub
  agent also accepts a stack, and then defers its close into that stack instead.
- **A util whose first parameter is a stack** registers nothing itself. The governed-imps harness,
  the move hosts, the broker's network stand-ins, the echo servers and the ZFS test dataset are this
  kind. The test creates the stack and registers its disposal on the next line. Anything that must
  release first, such as a held template build step, defers into the same stack after the util's
  call.

## What a setupTest returns

A daemon test file's `setupTest()` seeds the image that every imp create boots. A test that asserts
on that image reads it from `setupTest()` as `ctx.image` instead of naming it again.

To test behaviour that spans a whole test process, such as a preload, run the test file in a child
`bun test` through [`runChildTests`](../../../../packages/test-utils/src/run-child-tests.ts). The
runner gives the child its own working directory and kills it at a timeout.
