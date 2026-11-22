# dockerfile-difftest

`impz image build` checks a Dockerfile before the build starts. To do that, impd parses it with a
port of the frontend's parser: `packages/daemon/src/imps/images/dockerfile/dockerfile-parse.ts`. The
check is sound only while impd and the frontend split each Dockerfile the same way. This tool checks
that they do. It generates Dockerfiles full of hostile forms and parses each one twice, with the
port and with the Go parser it ports. The forms cover quotes and escapes, `# escape=`, line
continuations, heredocs, a BOM, CRLF, JSON arrays with escapes, and spaces that are not ASCII.

impd builds a pinned copy of each Dockerfile, in which each image reference is replaced by its
digest (`renderPinnedDockerfile` in `dockerfile-check.ts`). The tool also pins every file that both
parsers accept, and parses the pinned copy twice in the same way.

## When to run it

Run it on every change to `DOCKERFILE_FRONTEND` (the `BUILDKIT_SYNTAX` pin in
`packages/daemon/src/imps/docker-contract/dockerfile-frontend.ts`) and on every change to
`dockerfile-parse.ts`. CI runs it with one fixed seed in the `checks` job.

## Requirements

- Go, at the version in `go.mod`.
- `go.mod` requires the moby/buildkit commit behind the pinned frontend. For
  `docker/dockerfile:1.28` that is v0.34.0, the commit tagged `dockerfile/1.28.0`. When you change
  the pin, find the commit for the new `dockerfile/<version>` tag, then update `go.mod`:

  ```sh
  cd scripts/dockerfile-difftest
  go get github.com/moby/buildkit@<commit> && go mod tidy
  ```

## Run

The runner lives in `packages/daemon/src/test-utils/dockerfile-difftest/run.ts`. The `run.ts` here
forwards to it, because `ci.yml` calls this path and reads this folder's `go.mod` and `go.sum`.

```sh
bun scripts/dockerfile-difftest/run.ts            # seed 1, 60000 files
bun scripts/dockerfile-difftest/run.ts --seed 7 --count 200000
```

The tool exits non-zero when:

- Both parsers accept a file but read different instructions, flags or words.
- Go refuses a file that impd accepts, and the error is not in `HARMLESS_GO_ERRORS`. That list holds
  errors from parsers that impd does not port, such as `ENV` pairs. Go fails the build on those
  errors, so it does not matter that impd accepts them.
- The two parsers read a pinned copy differently.
- impd accepts a file but cannot pin it.

When impd refuses a file that Go accepts, the tool prints the case and does not fail. impd fails
closed, as it does for an instruction name that is not ASCII.
