// Every step createImpd runs, in order. A step whose part the config turns
// off still runs, and finds nothing to start.
export const IMPD_STARTUP_STEPS = [
  'ksm',
  'telemetry',
  'data-dir',
  'database',
  'storage',
  'firewall',
  'imps',
  'reconcile',
  'builders',
  'boot-templates',
  'system-drives',
  'access',
  'moves',
  'api',
  'public-mcp',
  'proxy',
  'https',
  'tailnet-names',
  'broker',
  'ssh',
  'tickers',
  'default-image',
] as const;

export type ImpdStartupStep = (typeof IMPD_STARTUP_STEPS)[number];

// runs one step of the start and records that it ran
export type RunImpdStartupStep = <T>(step: ImpdStartupStep, task: () => T) => T;
