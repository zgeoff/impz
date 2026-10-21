import { UsageError } from '../cli/errors';
import { formatError } from '../cli/run-action';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import { readHostConfig } from '../config/host-store';
import type { CliEnv } from '../config/host-store';

const HOST_TIMEOUT_MS = 5000;

export type StartTimer = (durationMs: number, fire: () => void) => () => void;

export interface SavedTarget {
  readonly host: string;
  readonly config: CliConfig;
}

export type HostAnswer<T> =
  | { readonly host: string; readonly value: T }
  | { readonly host: string; readonly error: string };

export function listSavedTargets(
  env: CliEnv,
  warn: (line: string) => void = console.error,
): SavedTarget[] {
  const hosts = Object.entries(readHostConfig(env, warn).hosts);

  if (hosts.length === 0) {
    throw new UsageError('no saved hosts (see impz login)');
  }

  return hosts
    .map(([host, saved]) => ({ host, config: { url: saved.url, token: saved.token, host } }))
    .toSorted((first, second) => first.host.localeCompare(second.host));
}

export function runOnHosts<T>(
  targets: readonly SavedTarget[],
  call: (client: ImpClient, signal: AbortSignal) => Promise<T>,
  timeoutMs = HOST_TIMEOUT_MS,
  startTimer: StartTimer = startTimeout,
): Promise<HostAnswer<T>[]> {
  return Promise.all(
    targets.map(async (target): Promise<HostAnswer<T>> => {
      try {
        const value = await runWithTimeout(
          (signal) => call(createImpClient(target.config), signal),
          timeoutMs,
          startTimer,
        );

        return { host: target.host, value };
      } catch (error) {
        return { host: target.host, error: formatError(error, target.config) };
      }
    }),
  );
}

// the signal aborts the requests; the race ends the wait even when a call
// does not watch it. The abort in finally also ends the calls still open
// after another one failed, so none of them keeps the process alive.
async function runWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  startTimer: StartTimer,
): Promise<T> {
  const controller = new AbortController();

  const expired = Promise.withResolvers<never>();

  const cancelTimer = startTimer(timeoutMs, () => {
    controller.abort();
    expired.reject(new Error(`no answer in ${String(timeoutMs / 1000)} s`));
  });

  try {
    return await Promise.race([call(controller.signal), expired.promise]);
  } finally {
    cancelTimer();

    controller.abort();
  }
}

function startTimeout(durationMs: number, fire: () => void): () => void {
  const timer = setTimeout(fire, durationMs);

  return () => {
    clearTimeout(timer);
  };
}
