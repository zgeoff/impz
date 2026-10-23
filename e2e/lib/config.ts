export const config = {
  ramBudgetMib: readNumber('E2E_RAM_BUDGET_MIB', 6144),
  idleTimeoutS: readNumber('E2E_IDLE_TIMEOUT_S', 10),

  scaleCount: readNumber('E2E_SCALE_COUNT', 30),
  scaleMemoryMib: readNumber('E2E_SCALE_MEMORY_MIB', 512),
  scaleFillMib: readNumber('E2E_SCALE_FILL_MIB', 256),

  chaosRounds: readNumber('E2E_CHAOS_ROUNDS', 8),
  chaosSeed: readNumber('E2E_CHAOS_SEED', Date.now() % 1_000_000_007),

  maxNewMs: readNumber('E2E_MAX_NEW_MS', 3000),
  maxCheckpointMs: readNumber('E2E_MAX_CHECKPOINT_MS', 500),

  keep: process.env['E2E_KEEP'] === '1',

  keptPrefixes: (process.env['E2E_KEPT_PREFIXES'] ?? '')
    .split(',')
    .filter((prefix) => prefix !== ''),

  acceptance: process.env['E2E_ACCEPTANCE'] === '1',

  metricsFile: process.env['E2E_METRICS_FILE'] ?? null,

  // Only a ZFS host run on a machine of its own sets it: a test may then drop
  // the machine's caches and change the run's ZFS root.
  ownsZfsHost: process.env['E2E_OWNS_ZFS_HOST'] === '1',

  // The name must resolve to 127.0.0.1 on this machine.
  registryName: process.env['E2E_REGISTRY_NAME'] ?? 'imp-e2e-registry.test',
} as const;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }

  return value;
}
