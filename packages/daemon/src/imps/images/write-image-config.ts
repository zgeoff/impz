import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ImpdError } from '../../platform/errors/impd-error';

// The tree's names are the image's own and impd writes as root, so no step may follow a
// link out of the tree.
export function writeImageConfig(root: string, contents: string): void {
  const etc = join(root, 'etc');
  const directory = join(etc, 'imp');

  // No race: the tree sits under impd's 0700 directory, and tar has exited.
  createDirectory(etc, '/etc');
  createDirectory(directory, '/etc/imp');

  const file = join(directory, 'image.json');

  // rmSync looks at the name itself (lstat), so a link goes and never its target.
  rmSync(file, { recursive: true, force: true });

  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );

  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

function createDirectory(path: string, name: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (stat === undefined) {
    mkdirSync(path, { mode: 0o755 });

    return;
  }

  if (!stat.isDirectory()) {
    throw new ImpdError('BAD_REQUEST', {
      message: `the image's ${name} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}; impd writes /etc/imp/image.json there, so it must be a directory`,
    });
  }
}
