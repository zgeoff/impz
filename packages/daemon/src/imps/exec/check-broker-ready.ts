import type { ExecRequirement } from '@impz/api';
import { ImpdError } from '../../platform/errors/impd-error';
import { PROXY_VARIABLE } from './broker-exec-env';
import type { BrokerExecEnv } from './broker-exec-env';
import { readEnvKey } from './merge-env';

export function isBrokerRequired(requirements: readonly ExecRequirement[] | undefined): boolean {
  return requirements?.includes('broker') === true;
}

export function buildBrokerNotReadyError(detail: string) {
  return new ImpdError('PRECONDITION_FAILED', {
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
