const RUN_GATES = new Set([
  'IMP_HOST_TESTS',
  'IMP_TEST_SMALL_FS',
  'IMP_TEST_ZFS_ROOT',
  'IMP_TEST_ZFS_DIR',
]);

export function removeAmbientImpEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('IMP_') && !RUN_GATES.has(key)) {
      delete process.env[key];
    }
  }
}
