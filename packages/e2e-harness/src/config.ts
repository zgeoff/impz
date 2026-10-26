export type HarnessEnv = Readonly<Record<string, string | undefined>>;

export type E2EConfig = ReturnType<typeof buildConfig>;

export function buildConfig(env: HarnessEnv) {
  return {
    ramBudgetMib: parseCount(env, 'E2E_RAM_BUDGET_MIB', 6144),
    idleTimeoutS: parseCount(env, 'E2E_IDLE_TIMEOUT_S', 10),

    scaleCount: parseCount(env, 'E2E_SCALE_COUNT', 30),
    scaleMemoryMib: parseCount(env, 'E2E_SCALE_MEMORY_MIB', 512),
    scaleFillMib: parseCount(env, 'E2E_SCALE_FILL_MIB', 256),

    chaosRounds: parseCount(env, 'E2E_CHAOS_ROUNDS', 8),
    chaosSeed: parseCount(env, 'E2E_CHAOS_SEED', Date.now() % 1_000_000_007),

    maxNewMs: parseCount(env, 'E2E_MAX_NEW_MS', 3000),
    maxCheckpointMs: parseCount(env, 'E2E_MAX_CHECKPOINT_MS', 500),

    keep: env['E2E_KEEP'] === '1',

    keptPrefixes: (env['E2E_KEPT_PREFIXES'] ?? '').split(',').filter((prefix) => prefix !== ''),

    acceptance: env['E2E_ACCEPTANCE'] === '1',

    metricsFile: env['E2E_METRICS_FILE'] ?? null,

    // Only a ZFS host run on a machine of its own sets it: a test may then drop
    // the machine's caches and change the run's ZFS root.
    ownsZfsHost: env['E2E_OWNS_ZFS_HOST'] === '1',

    // The name must resolve on this machine to the registry network's gateway.
    registryName: env['E2E_REGISTRY_NAME'] ?? 'imp-e2e-registry.test',
  } as const;
}

export const config = buildConfig(process.env);

function parseCount(env: HarnessEnv, name: string, fallback: number): number {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }

  return value;
}
