import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import type { IssueCertificate } from './acme-issuer';
import type { CertStore, Certificate } from './cert-store';
import { readCertificateInfo } from './read-certificate-info';
import type { CertificateInfo } from './renewal-policy';
import { planRenewal, readBackoffMs } from './renewal-policy';

export interface CertManager {
  readonly load: () => Certificate | null;

  readonly renew: () => Promise<Certificate | null>;
}

interface CertManagerOptions {
  readonly domain: string;
  readonly store: CertStore;
  readonly issue: IssueCertificate;
  readonly now: () => number;
}

export function createCertManager(options: CertManagerOptions): CertManager {
  const domain = options.domain;
  const store = options.store;
  let running: Promise<Certificate | null> | null = null;
  let loggedWaitUntil: number | null = null;

  const tryRenewal = async (): Promise<Certificate | null> => {
    const attempts = store.readAttempts();
    const now = options.now();

    const decision = planRenewal({
      info: readInfo(store.readCertificate()),
      domain,
      attempts,
      now,
    });

    if (decision.kind === 'keep') {
      return null;
    }

    if (decision.kind === 'wait') {
      if (loggedWaitUntil !== decision.until) {
        loggedWaitUntil = decision.until;

        getImpdLogger('https').info('{reason}; the next try is after {until}', {
          reason: decision.reason,
          until: new Date(decision.until).toISOString(),
        });
      }

      return null;
    }

    getImpdLogger('https').info('asking for a certificate for {domain} and *.{domain}: {reason}', {
      domain,
      reason: decision.reason,
    });

    const failures = attempts.failures + 1;

    store.writeAttempts({ failures, lastAttemptAt: now, lastError: attempts.lastError });

    try {
      const certificate = await options.issue(domain);

      store.writeCertificate(certificate);
      store.writeAttempts({ failures: 0, lastAttemptAt: now, lastError: null });

      const info = readInfo(certificate);
      const tookMs = options.now() - now;

      getImpdLogger('https').info(
        'got a certificate for {domain}, expiring {notAfter}, in {tookMs}ms',
        {
          domain,
          notAfter: info?.notAfter.toISOString() ?? 'at an unknown time',
          tookMs: String(tookMs),
        },
      );

      return certificate;
    } catch (error) {
      const reason = getErrorMessage(error);

      const retryAt = new Date(now + readBackoffMs(failures)).toISOString();

      store.writeAttempts({ failures, lastAttemptAt: now, lastError: reason });

      loggedWaitUntil = now + readBackoffMs(failures);

      getImpdLogger('https').warning(
        'no certificate for {domain}: {reason}; the next try is after {retryAt}',
        { domain, reason, retryAt },
      );

      return null;
    }
  };

  const runRenewal = async (): Promise<Certificate | null> => {
    try {
      return await tryRenewal();
    } catch (error) {
      getImpdLogger('https').warning('renewal failed: {error}', { error: getErrorMessage(error) });

      return null;
    } finally {
      running = null;
    }
  };

  return {
    load: () => {
      const certificate = store.readCertificate();
      const info = readInfo(certificate);

      if (certificate === null || info === null) {
        return null;
      }

      if (info.notAfter.getTime() <= options.now()) {
        getImpdLogger('https').info(
          'the stored certificate expired {notAfter}; serving it until a renewal succeeds',
          { notAfter: info.notAfter.toISOString() },
        );
      }

      return certificate;
    },
    renew: () => {
      running ??= runRenewal();

      return running;
    },
  };
}

function readInfo(certificate: Certificate | null): CertificateInfo | null {
  if (certificate === null) {
    return null;
  }

  try {
    return readCertificateInfo(certificate.chainPem);
  } catch (error) {
    getImpdLogger('https').warning('cannot read the stored certificate: {error}', {
      error: getErrorMessage(error),
    });

    return null;
  }
}
