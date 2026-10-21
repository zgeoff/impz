import type { ExecRequirement } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-372 puts the broker behind a port
import { PROXY_VARIABLE } from '../../network/broker/guest-trust';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-372 puts the broker behind a port
import type { BrokerExecEnv } from '../../network/broker/guest-trust';
import { readEnvKey } from './merge-env';

export function isBrokerRequired(requirements: readonly ExecRequirement[] | undefined): boolean {
  return requirements?.includes('broker') === true;
}

export function buildBrokerNotReadyError(detail: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `the broker is not ready for this exec: ${detail}`,
    data: { reason: 'broker_not_ready' as const, detail },
  });
}

export function checkBrokerReady(
  broker: BrokerExecEnv,
  env: readonly string[],
): ReturnType<typeof buildBrokerNotReadyError> | null {
  if (broker.kind === 'ungranted') {
    return buildBrokerNotReadyError('the imp has no grant, so impd sets no broker variables');
  }

  if (broker.kind === 'untrusted') {
    return buildBrokerNotReadyError(
      `the broker CA bundle is not in this boot of the guest: ${broker.detail}`,
    );
  }

  if (!broker.env.some((entry) => readEnvKey(entry) === PROXY_VARIABLE)) {
    return buildBrokerNotReadyError(`impd built no ${PROXY_VARIABLE} for this exec`);
  }

  const started = new Set(env);

  const replaced = broker.env.find((entry) => !started.has(entry));

  if (replaced !== undefined) {
    return buildBrokerNotReadyError(
      `the exec's env sets ${readEnvKey(replaced)}, which the broker sets`,
    );
  }

  return null;
}
