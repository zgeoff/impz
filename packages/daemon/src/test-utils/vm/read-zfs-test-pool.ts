export function readZfsTestPool(): { parent: string; parentDir: string } | null {
  const parent = process.env['IMP_TEST_ZFS_ROOT'];
  const parentDir = process.env['IMP_TEST_ZFS_DIR'];

  if (parent === undefined || parentDir === undefined) {
    return null;
  }

  return { parent, parentDir };
}
