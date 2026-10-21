import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config';
import { setupSystemFiles } from './setup-system-files';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-system-files-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it installs the system drive under its sha256', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  const expected = join(
    ctx.directoryPath,
    'data',
    'system',
    'drives',
    '7da85c2b44484d6fc3efaeea7807587cb8e760156748e0e70988c94f31eb163d.squashfs',
  );

  expect(files.systemDrivePath).toBe(expected);
  expect(readFileSync(expected, 'utf8')).toBe('drive a');
});

test('it installs a changed system drive at its own path and keeps the one before it', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
    IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
  });

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const first = await setupSystemFiles(config);

  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive b');

  const second = await setupSystemFiles(config);

  expect(second.systemDrivePath).toBe(
    join(
      ctx.directoryPath,
      'data',
      'system',
      'drives',
      '9d4e34158e51fc516bc5f09fe33a9ee07712ddefda94c351978e6c366de830c5.squashfs',
    ),
  );

  expect(readFileSync(second.systemDrivePath, 'utf8')).toBe('drive b');
  expect(readFileSync(first.systemDrivePath, 'utf8')).toBe('drive a');
});

test('it leaves an installed system drive in place when its source is unchanged', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
    IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
  });

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const first = await setupSystemFiles(config);

  const installed = statSync(first.systemDrivePath).ino;

  const again = await setupSystemFiles(config);

  expect(again.systemDrivePath).toBe(first.systemDrivePath);
  expect(statSync(again.systemDrivePath).ino).toBe(installed);
});

test('it reports the hashes it installed by, for system.info', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  expect(files.info).toStrictEqual({
    guestKernel: {
      version: '6.1.188',
      sha256: '4d0bcb0c40c3f487930fe8e285765a9d0122209b9e7712968a447caa5d1b4ea7',
    },
    systemDrive: { sha256: '7da85c2b44484d6fc3efaeea7807587cb8e760156748e0e70988c94f31eb163d' },
  });
});

test('it copies the configured kernel into the data dir', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  expect(files.kernelPath).toBe(join(ctx.directoryPath, 'data', 'system', 'vmlinux'));
  expect(readFileSync(files.kernelPath, 'utf8')).toBe('Linux version 6.1.188 (imp@imp)\0');
});

test('it replaces a kernel in the data dir that differs from the configured one', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'data', 'system'), { recursive: true });

  writeFileSync(
    join(ctx.directoryPath, 'data', 'system', 'vmlinux'),
    'Linux version 6.1.100 (imp@imp)\0',
  );

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  expect(readFileSync(files.kernelPath, 'utf8')).toBe('Linux version 6.1.188 (imp@imp)\0');
});

test('it leaves a kernel in the data dir alone when it matches the configured one', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'data', 'system'), { recursive: true });

  writeFileSync(
    join(ctx.directoryPath, 'data', 'system', 'vmlinux'),
    'Linux version 6.1.188 (imp@imp)\0',
  );

  const installed = statSync(join(ctx.directoryPath, 'data', 'system', 'vmlinux')).ino;

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  expect(statSync(files.kernelPath).ino).toBe(installed);
});

test('it boots from the kernel in the data dir when no kernel is configured', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'data', 'system'), { recursive: true });

  writeFileSync(
    join(ctx.directoryPath, 'data', 'system', 'vmlinux'),
    'Linux version 6.1.188 (imp@imp)\0',
  );

  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const files = await setupSystemFiles(
    loadConfig({
      IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
    }),
  );

  expect(files.info.guestKernel.version).toBe('6.1.188');
});

test('it refuses a configured kernel that does not exist', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const config = loadConfig({
    IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
    IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
  });

  expect(setupSystemFiles(config)).rejects.toThrowWithMessage(
    Error,
    `${join(ctx.directoryPath, 'vmlinux')} does not exist`,
  );
});

test('it refuses a missing kernel in the data dir when no kernel is configured', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'drive.squashfs'), 'drive a');

  const config = loadConfig({
    IMP_DATA_DIR: join(ctx.directoryPath, 'data'),
    IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'drive.squashfs'),
  });

  expect(setupSystemFiles(config)).rejects.toThrowWithMessage(
    Error,
    `${join(ctx.directoryPath, 'data', 'system', 'vmlinux')} does not exist and no source is configured`,
  );
});

test('it refuses a system drive that does not exist', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'kernel');

  const config = loadConfig({
    IMP_DATA_DIR: ctx.directoryPath,
    IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
  });

  expect(setupSystemFiles(config)).rejects.toThrowWithMessage(
    Error,
    `${join(ctx.directoryPath, 'system', 'imp-system.squashfs')} does not exist`,
  );
});

test('it installs the drive placed in the data dir when no drive is configured, and keeps it', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'vmlinux'), 'kernel');
  mkdirSync(join(ctx.directoryPath, 'system'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'system', 'imp-system.squashfs'), 'hand-placed drive');

  const files = await setupSystemFiles(
    loadConfig({ IMP_DATA_DIR: ctx.directoryPath, IMP_KERNEL: join(ctx.directoryPath, 'vmlinux') }),
  );

  expect(readFileSync(files.systemDrivePath, 'utf8')).toBe('hand-placed drive');
  expect(existsSync(join(ctx.directoryPath, 'system', 'imp-system.squashfs'))).toBeTrue();
});
