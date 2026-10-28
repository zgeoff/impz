# @impz/client

A typed client for [impd](https://github.com/zgeoff/impz), the imp host daemon. It runs in Bun, in
binaries that `bun build --compile` makes, in Node 22.6 or later, and in browsers with
`Promise.withResolvers`: Chrome 119, Firefox 121 and Safari 17.4 or later. CI checks each release
under Node, Bun and a compiled Bun binary.

```sh
npm install @impz/client
```

`@opentelemetry/api` is an optional peer: oRPC's type declarations name it, so a project that
type-checks its dependencies (no `skipLibCheck`) installs it too.

## Connect

```ts
import { createImpClient } from '@impz/client';

const imp = createImpClient({
  url: 'http://localhost:7070',
  token: process.env.IMP_TOKEN,
});
```

- `url` is impd's API. A path prefix is kept, so impd can sit behind a proxy at `/impd/`.
- `token` is the bearer token from `<IMP_DATA_DIR>/token`. It controls every imp on the host, so
  keep it on a server. A browser app sends its requests through a proxy that adds the token, and
  leaves `token` out.
- `fetch` swaps the transport, for example to call an in-process app in tests.

## Imps, checkpoints and forks

Every procedure of impd's API is on the client, with its input and output types.

```ts
const dev = await imp.imps.create({ name: 'dev', memoryMib: 2048 });

const checkpoint = await imp.checkpoints.create({ name: 'dev', label: 'clean' });

// a new imp from the checkpoint's disk
await imp.imps.fork({ source: 'dev', name: 'dev-2', checkpoint: checkpoint.id });

await imp.imps.sleep({ name: 'dev' });
```

`imp.requireAwake(name)` makes one wake call. It wakes a sleeping imp, boots a stopped one and
returns a running one as it is. impd refuses an imp in the `error` state with `INVALID_STATE`,
because a wake would restart it; pass `{ restartError: true }` to restart it anyway. While impd
stops, calls fail with `SERVICE_UNAVAILABLE`, and while it restarts, `fetch` cannot connect; pass
`{ retryUnavailable: { attempts, delayMs } }` to wait for it to come back. `RAM_BUDGET_EXCEEDED` is
never retried.

`watchEvents(imp, { onEvent })` follows `events.stream`: every imp first, then each change. `name`
keeps one imp's events, and `reconnect: { delayMs }` opens a fresh stream whenever one ends, until
impd refuses the call or `signal` aborts. `onOpen` runs as each stream opens, so a caller can catch
up on what changed while it was away.

`openForwardTunnel` relays one connection to a port in the imp over `/tunnel`, and
`openReverseForward` listens in the imp and relays each client back. `openToolExec` runs an agent
tool such as `tar` over `/exec` with acked stdin and stdout. Each takes a `connect` that opens the
WebSocket, and `resolveImpdWebSocketUrl` gives the URL for an impd endpoint.

## Run commands

`imp.run` runs a command to its exit and collects its output. Without `stdin`, stdin closes at once.

```ts
const result = await imp.run('dev', ['sh', '-c', 'uname -a; cat'], { stdin: 'hi\n' });

console.log(result.code, new TextDecoder().decode(result.stdout));
```

`imp.openExec` streams the output instead, `imp.openConsole` opens a login shell with a tty, and a
named session outlives the socket, so a client can attach to it again and resume where it stopped.

## Errors, features and versions

A failed call throws an `ORPCError` with impd's `code` and typed `data`; `safe` and `isDefinedError`
narrow it. A call to a procedure that an older impd lacks throws an `UnknownProcedureError` instead.
An older impd drops an input field it does not know, so `requireFeatures` checks the features a call
needs first. `imp.checkServer()` tells whether impd speaks this client's API.

## Documentation

The [client guide](https://github.com/zgeoff/impz/blob/main/docs/guides/client.md) covers streaming,
consoles, sessions and resume, every error code, the features table and the version check.
