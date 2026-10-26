import { Agent } from 'node:https';
import type * as AcmeClient from 'acme-client';
import type { Challenge } from 'acme-client/types/rfc8555';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import type { DnsProvider, TxtRecord } from '../dns/dns-provider';
import type { CertStore, Certificate } from './cert-store';
import { listCertificateNames } from './renewal-policy';

interface AcmePollOptions {
  readonly backoffAttempts: number;
  readonly backoffMin: number;
  readonly backoffMax: number;
}

export interface AcmeIssuerOptions {
  readonly directoryUrl: string;
  readonly email: string | null;

  readonly caPem: string | null;
  readonly store: CertStore;
  readonly dns: DnsProvider;

  readonly poll?: AcmePollOptions;
}

interface PendingChallenge {
  readonly challenge: Challenge;
  readonly fqdn: string;
  readonly value: string;
}

export type IssueCertificate = (domain: string) => Promise<Certificate>;

export function createAcmeIssuer(options: AcmeIssuerOptions): IssueCertificate {
  const loading: { promise: Promise<typeof AcmeClient> | null } = { promise: null };

  const loadAcme = (): Promise<typeof AcmeClient> => {
    loading.promise ??= readAcmeClient(options.caPem);

    return loading.promise;
  };

  // a key that has an account but lost its URL is never registered again:
  // acme-client then sends an account update that strict CAs such as Pebble
  // refuse
  const openClient = async (acme: typeof AcmeClient): Promise<AcmeClient.Client> => {
    const stored = options.store.readAccount(options.directoryUrl);

    if (stored !== null) {
      return new acme.Client({
        directoryUrl: options.directoryUrl,
        accountKey: stored.keyPem,
        accountUrl: stored.url,
        ...options.poll,
      });
    }

    const key = await acme.crypto.createPrivateEcdsaKey();

    const keyPem = key.toString();

    const client = new acme.Client({
      directoryUrl: options.directoryUrl,
      accountKey: keyPem,
      ...options.poll,
    });

    await client.createAccount({
      termsOfServiceAgreed: true,
      ...(options.email !== null && { contact: [`mailto:${options.email}`] }),
    });

    options.store.writeAccount({
      directoryUrl: options.directoryUrl,
      url: client.getAccountUrl(),
      keyPem,
    });

    return client;
  };

  const runOrder = async (domain: string): Promise<Certificate> => {
    await checkDirectory(options.directoryUrl, options.caPem);

    const acme = await loadAcme();
    const client = await openClient(acme);

    const names = listCertificateNames(domain);

    const order = await client.createOrder({
      identifiers: names.map((name) => ({ type: 'dns', value: name })),
    });

    const authorizations = await client.getAuthorizations(order);

    const records: TxtRecord[] = [];

    try {
      const pending: PendingChallenge[] = [];

      for (const authorization of authorizations) {
        if (authorization.status === 'valid') {
          continue;
        }

        const name = authorization.identifier.value;
        const challenge = authorization.challenges.find((item) => item.type === 'dns-01');

        if (challenge === undefined) {
          throw new Error(`the CA offers no dns-01 challenge for ${name}`);
        }

        const fqdn = `_acme-challenge.${name}`;

        const value = await client.getChallengeKeyAuthorization(challenge);
        const record = await options.dns.addTxt(fqdn, value);

        records.push(record);
        pending.push({ challenge, fqdn, value });
      }

      // `<domain>` and `*.<domain>` share one challenge name, so both values
      // reach every nameserver before the CA is told to look at either
      for (const fqdn of new Set(pending.map((item) => item.fqdn))) {
        const values = pending.filter((item) => item.fqdn === fqdn).map((item) => item.value);

        await options.dns.waitForTxt(fqdn, values);
      }

      for (const item of pending) {
        await client.completeChallenge(item.challenge);
        await client.waitForValidStatus(item.challenge);
      }

      const certificateKey = await acme.crypto.createPrivateEcdsaKey();

      const [key, csr] = await acme.crypto.createCsr(
        { commonName: domain, altNames: [...names] },
        certificateKey,
      );

      const finalized = await client.finalizeOrder(order, csr);
      const chainPem = await client.getCertificate(finalized);

      return { keyPem: key.toString(), chainPem };
    } finally {
      await removeRecords(options, records);
    }
  };

  return async (domain) => {
    try {
      return await runOrder(domain);
    } catch (error) {
      throw new Error(formatAcmeError(error), { cause: error });
    }
  };
}

// acme-client loads on the first order, so an impd with HTTPS off never loads it, and
// @impz/testing leaves it out of the dependencies of a consumer that boots impd without HTTPS
async function readAcmeClient(caPem: string | null): Promise<typeof AcmeClient> {
  const acme = await import('acme-client');

  if (caPem !== null) {
    acme.axios.defaults.httpsAgent = new Agent({ ca: caPem });
  }

  return acme;
}

// Under Bun a failed TLS handshake inside acme-client reads only `undefined
// is not an object (evaluating 'response.config')`. Asking the directory
// first, with fetch, gives the real reason.
async function checkDirectory(directoryUrl: string, caPem: string | null): Promise<void> {
  try {
    const response = await fetch(directoryUrl, {
      ...(caPem !== null && { tls: { ca: caPem } }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
  } catch (error) {
    throw new Error(`cannot reach the ACME server at ${directoryUrl}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

async function removeRecords(
  options: AcmeIssuerOptions,
  records: readonly TxtRecord[],
): Promise<void> {
  for (const record of records) {
    try {
      await options.dns.removeTxt(record);
    } catch (error) {
      const reason = getErrorMessage(error);

      getImpdLogger('https').warning('could not remove the TXT record {fqdn}: {reason}', {
        fqdn: record.fqdn,
        reason,
      });
    }
  }
}

function formatAcmeError(error: unknown): string {
  const message = getErrorMessage(error);

  if (error instanceof TypeError && message.includes('response.config')) {
    return 'the ACME server did not answer (a connection or TLS failure)';
  }

  return message;
}
