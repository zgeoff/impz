import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubDockerCli } from '../../../../testing/imps/create-stub-docker-cli';
import { listChildPids } from '../../../../testing/platform/list-child-pids';
import {
  assertUnpacked,
  findUnpackFailure,
  readSetfcapWarning,
  writeExportedTree,
} from './unpack-export';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-unpack-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

// GNU tar 1.35 exits 0 when it runs without CAP_SETFCAP, and prints this
test('#assertUnpacked fails an unpack whose capability tar had no permission to set and names SETFCAP', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: some/file: time stamp in the future\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(
    expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      message:
        "the image has a file capability that impd could not keep (tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted); imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)",
    }),
  );
});

test.each([
  [
    "tar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Invalid argument",
  ],
  [
    "tar: setxattrat: Cannot set 'user.mime_type' extended attribute for file 'srv/a': Operation not supported",
  ],
])(
  '#assertUnpacked fails an unpack with the line of another attribute tar could not set: %s',
  (line) => {
    expect(() => {
      assertUnpacked({ exitCode: 0, stdout: '', stderr: `${line}\n` });
    }).toThrow(
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        message: `the image has an extended attribute that impd could not keep: ${line}`,
      }),
    );
  },
);

test('#assertUnpacked blames SETFCAP when its line comes after another attribute failure', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/a': Operation not supported\ntar: setxattrat: Cannot set 'security.capability' extended attribute for file 'usr/bin/ping': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
});

test('#assertUnpacked passes a warning that only names a file called security.capability', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr: 'tar: srv/security.capability: time stamp 2030-01-01 is in the future\n',
    });
  }).not.toThrow();
});

test('#assertUnpacked reads the attribute name, not the file name, of a failed attribute', () => {
  expect(() => {
    assertUnpacked({
      exitCode: 0,
      stdout: '',
      stderr:
        "tar: setxattrat: Cannot set 'user.x' extended attribute for file 'srv/security.capability': Operation not permitted\n",
    });
  }).toThrow(expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }));
});

test('#assertUnpacked passes an unpack with no warning', () => {
  expect(() => {
    assertUnpacked({ exitCode: 0, stdout: '', stderr: '' });
  }).not.toThrow();
});

test('#assertUnpacked fails an unpack whose tar exited non-zero with its stderr', () => {
  expect(() => {
    assertUnpacked({ exitCode: 2, stdout: '', stderr: 'tar: Unexpected EOF in archive' });
  }).toThrowWithMessage(Error, 'docker export | tar exited 2: tar: Unexpected EOF in archive');
});

test('#findUnpackFailure finds no failure when both processes exit 0', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: { exitCode: 0, stdout: '', stderr: '' },
      unpacked: { exitCode: 0, stdout: '', stderr: 'tar: a warning\n' },
      isTarFirst: false,
      isExportStopped: false,
    }),
  ).toBeNull();
});

test('#findUnpackFailure names the export alone when only the export fails', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: {
        exitCode: 1,
        stdout: '',
        stderr:
          'Error response from daemon: imp-docker-proxy: GET /containers/c1/export is not a call impd makes\n',
      },
      unpacked: { exitCode: 0, stdout: '', stderr: '' },
      isTarFirst: false,
      isExportStopped: false,
    }),
  ).toStrictEqual(
    new Error(
      'docker export c1 exited 1: Error response from daemon: imp-docker-proxy: GET /containers/c1/export is not a call impd makes',
    ),
  );
});

test('#findUnpackFailure names tar alone when only tar fails', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: { exitCode: 0, stdout: '', stderr: '' },
      unpacked: { exitCode: 2, stdout: '', stderr: 'tar: Unexpected EOF in archive\n' },
      isTarFirst: true,
      isExportStopped: false,
    }),
  ).toStrictEqual(new Error('tar exited 2: tar: Unexpected EOF in archive'));
});

test('#findUnpackFailure names both failures, the export first, when the export ends first', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: { exitCode: 1, stdout: '', stderr: 'Error: No such container: c1\n' },
      unpacked: { exitCode: 2, stdout: '', stderr: 'tar: This does not look like a tar archive\n' },
      isTarFirst: false,
      isExportStopped: false,
    }),
  ).toStrictEqual(
    new Error(
      'docker export c1 exited 1: Error: No such container: c1; tar exited 2: tar: This does not look like a tar archive',
    ),
  );
});

test('#findUnpackFailure names both failures, tar first, when tar stops first', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: { exitCode: 1, stdout: '', stderr: 'write /dev/stdout: broken pipe\n' },
      unpacked: { exitCode: 2, stdout: '', stderr: 'tar: Cannot open: Permission denied\n' },
      isTarFirst: true,
      isExportStopped: false,
    }),
  ).toStrictEqual(
    new Error(
      'tar exited 2: tar: Cannot open: Permission denied; docker export c1 exited 1: write /dev/stdout: broken pipe',
    ),
  );
});

test('#findUnpackFailure leaves out the export that impd stopped after tar stopped', () => {
  expect(
    findUnpackFailure({
      containerId: 'c1',
      exported: { exitCode: 143, stdout: '', stderr: '' },
      unpacked: { exitCode: 2, stdout: '', stderr: 'tar: Cannot open: Permission denied\n' },
      isTarFirst: true,
      isExportStopped: true,
    }),
  ).toStrictEqual(new Error('tar exited 2: tar: Cannot open: Permission denied'));
});

// The mask is imp-host's capability set from deploy/imp-host.args.json, which holds bit 31.
test('#readSetfcapWarning gives no start warning when CapEff holds CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000882810fb\n')).toBeNull();
});

test('#readSetfcapWarning gives the start warning when CapEff lacks CAP_SETFCAP', () => {
  expect(readSetfcapWarning('Name:\timpd\nCapEff:\t00000000082810fb\n')).toBe(
    'no CAP_SETFCAP, so an image add or build fails on an image with a file capability; imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)',
  );
});

test('#writeExportedTree unpacks the container export into the root', async () => {
  const ctx = await setupTest();

  const tree = join(ctx.directoryPath, 'tree');
  const root = join(ctx.directoryPath, 'root');

  mkdirSync(join(tree, 'etc'), { recursive: true });
  mkdirSync(root);
  writeFileSync(join(tree, 'etc', 'hostname'), 'imp\n');

  const docker = createStubDockerCli({
    directory: ctx.directoryPath,
    exportTar: Bun.spawnSync(['tar', '-C', tree, '-c', 'etc']).stdout,
  });

  updateEnv('PATH', docker.path);

  await writeExportedTree('c'.repeat(64), root);

  expect(readFileSync(join(root, 'etc', 'hostname'), 'utf8')).toBe('imp\n');
});

test('#writeExportedTree fails the unpack with the stderr of an export that fails', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerCli({ directory: ctx.directoryPath });

  updateEnv('PATH', docker.path);

  expect(writeExportedTree('c'.repeat(64), ctx.directoryPath)).rejects.toThrowWithMessage(
    Error,
    /docker export c{64} exited 1: stub docker: export c{64} is not modelled(?:;|$)/v,
  );
});

test('#writeExportedTree fails the unpack with the stderr of a tar that fails', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerCli({
    directory: ctx.directoryPath,
    exportTar: new TextEncoder().encode('not a tar archive'),
  });

  updateEnv('PATH', docker.path);

  expect(writeExportedTree('c'.repeat(64), ctx.directoryPath)).rejects.toThrowWithMessage(
    Error,
    /^tar exited 2: tar: This does not look like a tar archive\n/v,
  );
});

test('#writeExportedTree stops and reaps the export when tar cannot start', async () => {
  const ctx = await setupTest();

  createStubDockerCli({
    directory: ctx.directoryPath,
    exportTar: new TextEncoder().encode('tar'),
    isExportHeld: true,
  });

  const tools = join(ctx.directoryPath, 'tools');

  mkdirSync(tools);
  symlinkSync(Bun.which('cat') ?? '/bin/cat', join(tools, 'cat'));
  symlinkSync(Bun.which('sleep') ?? '/bin/sleep', join(tools, 'sleep'));
  updateEnv('PATH', `${join(ctx.directoryPath, 'bin')}:${tools}`);

  const before = listChildPids();

  const failure = await writeExportedTree('c'.repeat(64), ctx.directoryPath).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(listChildPids()).toStrictEqual(before);
});

test('#writeExportedTree stops an export that tar stopped reading, and fails with the stderr of tar', async () => {
  const ctx = await setupTest();

  const tree = join(ctx.directoryPath, 'tree');

  mkdirSync(join(tree, 'etc'), { recursive: true });
  writeFileSync(join(tree, 'etc', 'hostname'), 'imp\n');

  const docker = createStubDockerCli({
    directory: ctx.directoryPath,
    exportTar: Bun.spawnSync(['tar', '-C', tree, '-c', 'etc']).stdout,
    isExportHeld: true,
  });

  updateEnv('PATH', docker.path);

  const missing = join(ctx.directoryPath, 'missing');

  expect(writeExportedTree('c'.repeat(64), missing)).rejects.toThrowWithMessage(
    Error,
    `tar exited 2: tar: ${missing}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`,
  );
});
