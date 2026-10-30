import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const created = mkdtempSync(join(tmpdir(), 'imp-go-checks-'));
  const directory = realpathSync(created);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'checkout'));

  return {
    directoryPath: directory,
    checkout: join(directory, 'checkout'),
    scriptPath: join(import.meta.dir, 'run-go-checks.ts'),
  };
}

test('it passes the format check when gofmt lists no file', async () => {
  const ctx = setupTest();
  const gofmt = createStubBin(ctx.directoryPath, 'gofmt');

  const result = await $`${process.execPath} ${ctx.scriptPath} format`
    .cwd(ctx.checkout)
    .env({ PATH: gofmt.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(gofmt.calls, 'utf8')).toBe(
    'gofmt -l agent host/ksm-exec host/oci-fetch host/uffd-handler scripts/dockerfile-difftest docs/design/spikes/uffd-2m-restore/harness\n',
  );
});

test('it fails the format check, listing the files gofmt would reformat', async () => {
  const ctx = setupTest();
  const gofmt = createStubBin(ctx.directoryPath, 'gofmt', 'echo agent/cmd/imp-agent/main.go');

  const result = await $`${process.execPath} ${ctx.scriptPath} format`
    .cwd(ctx.checkout)
    .env({ PATH: gofmt.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '::error::gofmt wants to reformat:\nagent/cmd/imp-agent/main.go\n',
  });
});

test('it vets every Go module, with and without the root tag where a module has root tests', async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go');

  const result = await $`${process.execPath} ${ctx.scriptPath} vet`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(go.calls, 'utf8')).toBe(
    [
      'go -C agent vet ./...',
      'go -C agent vet -tags root ./...',
      'go -C host/ksm-exec vet ./...',
      'go -C host/oci-fetch vet ./...',
      'go -C host/uffd-handler vet ./...',
      'go -C host/uffd-handler vet -tags root ./...',
      'go -C scripts/dockerfile-difftest vet ./...',
      'go -C docs/design/spikes/uffd-2m-restore/harness vet ./...',
      '',
    ].join('\n'),
  );
});

test("it lints every Go module with the agent's pinned golangci-lint and config", async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go');
  const tool = `tool -modfile=${ctx.checkout}/agent/tools/go.mod golangci-lint run --config ${ctx.checkout}/agent/.golangci.yml`;

  const result = await $`${process.execPath} ${ctx.scriptPath} lint`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(go.calls, 'utf8')).toBe(
    [
      `go -C agent ${tool} --build-tags root ./...`,
      `go -C host/ksm-exec ${tool} ./...`,
      `go -C host/oci-fetch ${tool} --disable depguard ./...`,
      `go -C host/uffd-handler ${tool} --build-tags root ./...`,
      `go -C scripts/dockerfile-difftest ${tool} --disable depguard ./...`,
      `go -C docs/design/spikes/uffd-2m-restore/harness ${tool} --disable depguard ./...`,
      '',
    ].join('\n'),
  );
});

test('it stops at the first module that fails its lint', async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go', '[ "$2" = host/ksm-exec ] && exit 1\nexit 0');

  const result = await $`${process.execPath} ${ctx.scriptPath} lint`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(go.calls, 'utf8').trimEnd().split('\n')).toHaveLength(2);
});

test('it checks the shipped modules for known vulnerabilities', async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go');
  const tool = `tool -modfile=${ctx.checkout}/agent/tools/go.mod govulncheck ./...`;

  const result = await $`${process.execPath} ${ctx.scriptPath} vulnerabilities`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(go.calls, 'utf8')).toBe(
    [
      `go -C agent ${tool}`,
      `go -C host/ksm-exec ${tool}`,
      `go -C host/oci-fetch ${tool}`,
      `go -C host/uffd-handler ${tool}`,
      '',
    ].join('\n'),
  );
});

test('it fails the dead code check, listing what only tests call', async () => {
  const ctx = setupTest();

  const go = createStubBin(
    ctx.directoryPath,
    'go',
    '[ "$2" = host/oci-fetch ] && echo "fetch.go:12:6: unreachable func: parseDigest"\nexit 0',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath} deadcode`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout:
      '::error::only tests call these; delete them or move them into the tests:\nfetch.go:12:6: unreachable func: parseDigest\n',
  });

  expect(readFileSync(go.calls, 'utf8')).toBe(
    [
      `go -C agent tool -modfile=${ctx.checkout}/agent/tools/go.mod deadcode -test=false ./cmd/...`,
      `go -C host/ksm-exec tool -modfile=${ctx.checkout}/agent/tools/go.mod deadcode -test=false .`,
      `go -C host/oci-fetch tool -modfile=${ctx.checkout}/agent/tools/go.mod deadcode -test=false .`,
      `go -C host/uffd-handler tool -modfile=${ctx.checkout}/agent/tools/go.mod deadcode -test=false .`,
      '',
    ].join('\n'),
  );
});

test('it passes the dead code check when every function has a caller', async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go');

  const result = await $`${process.execPath} ${ctx.scriptPath} deadcode`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
});

test("it runs the agent's tests through test-go.sh and every other module's under the race detector", async () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go');

  mkdirSync(join(ctx.checkout, 'scripts'));

  writeFileSync(
    join(ctx.checkout, 'scripts', 'test-go.sh'),
    `#!/bin/bash\nprintf '%s\\n' test-go.sh >>'${go.calls}'\n`,
    { mode: 0o755 },
  );

  const result = await $`${process.execPath} ${ctx.scriptPath} test`
    .cwd(ctx.checkout)
    .env({ PATH: go.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(go.calls, 'utf8')).toBe(
    [
      'test-go.sh',
      'go -C host/ksm-exec test -race ./...',
      'go -C host/oci-fetch test -race ./...',
      'go -C host/uffd-handler test -race ./...',
      'go -C docs/design/spikes/uffd-2m-restore/harness test -race ./...',
      '',
    ].join('\n'),
  );
});

test("it runs the root-only tests as root, on the runner user's PATH", async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  const result = await $`${process.execPath} ${ctx.scriptPath} test-root`
    .cwd(ctx.checkout)
    .env({ PATH: sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    [
      `sudo -E env PATH=${sudo.bin} go -C agent test -tags root -race ./...`,
      `sudo -E env PATH=${sudo.bin} go -C host/uffd-handler test -tags root -race ./...`,
      '',
    ].join('\n'),
  );
});

test('it refuses a check it does not know, with its usage', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} fuzz`
    .cwd(ctx.checkout)
    .env({ PATH: ctx.directoryPath })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr: 'usage: run-go-checks.ts <format|vet|lint|vulnerabilities|deadcode|test|test-root>\n',
  });
});
