import { readFileSync } from 'node:fs';
import { readServePorts } from '../../host-net/net/tailscale-serve';
import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import { listPublicImpNames, readPublicImp } from '../../platform/db/exposure';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { WakeProxy } from '../proxy/wake-proxy';
import { createAcmeIssuer } from './acme/acme-issuer';
import { createCertStore } from './acme/cert-store';
import { createDnsProvider } from './dns/create-dns-provider';
import type { DnsToken } from './dns/dns-token';
import type { HttpsConfig } from './https-config';
import type { HttpsService } from './https-service';
import { createHttpsService } from './https-service';

interface BuildHttpsOptions {
  readonly config: HttpsConfig;
  readonly dataDir: string;
  readonly db: ImpDatabase;
  readonly proxy: Pick<WakeProxy, 'startListener'>;
  readonly readTailscale: (() => Promise<TailscaleStatus>) | null;

  readonly dnsToken: DnsToken | null;
}

export function wireHttpsService(options: BuildHttpsOptions): HttpsService {
  const config = options.config;
  const store = createCertStore(options.dataDir);
  const dns = createDnsProvider(config.dns, options.dnsToken);

  const issue = createAcmeIssuer({
    directoryUrl: config.acmeDirectory,
    email: config.acmeEmail,
    caPem: config.acmeCaFile === null ? null : readFileSync(config.acmeCaFile, 'utf8'),
    store,
    dns,
  });

  const service = createHttpsService({
    config,
    store,
    issue,
    dns,
    proxy: options.proxy,
    readTailscale: options.readTailscale,
    readServePorts,
    now: Date.now,
    listPublicImps: () => listPublicImpNames(options.db),
    readPublicImpByName: (name) => readPublicImp(options.db, name),
  });

  const unsubscribe = options.db.writes.subscribe((write) => {
    if (write.kind === 'removed' && write.imp.publicAuth !== null) {
      void service.updatePublicRecords();
    }
  });

  return {
    ...service,
    start: () => {
      if (options.dnsToken !== null) {
        void checkDnsToken(options.dnsToken);
      }

      service.start();
    },
    stop: async () => {
      unsubscribe();

      await service.stop();
    },
  };
}

async function checkDnsToken(token: DnsToken): Promise<void> {
  try {
    await token.read();
  } catch (error) {
    getImpdLogger('https').warning(
      '{error}; DNS records and certificates wait until it holds a token',
      { error: getErrorMessage(error) },
    );
  }
}
