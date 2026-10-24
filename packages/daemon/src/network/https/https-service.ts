import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import type { PublicImp } from '../../platform/db/exposure';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createSemaphore } from '../../platform/process/semaphore';
import type { Ticker, TickerTimer } from '../../platform/process/ticker';
import { startTicker } from '../../platform/process/ticker';
import type { IssueCertificate } from './acme/acme-issuer';
import { createCertManager } from './acme/cert-manager';
import type { CertStore, Certificate } from './acme/cert-store';
import { buildPublicOwner } from './dns/dns-provider';
import type { DnsProvider } from './dns/dns-provider';
import type { HttpsConfig } from './https-config';
import { createHttpsListeners } from './https-listeners';
import type { HttpsListeners, ProxyListen } from './https-listeners';
import { createPublicScope } from './public-auth';
import { createPublicLimits } from './public-limits';

const RENEW_INTERVAL_MS = 10 * 60_000;
const ADDRESS_INTERVAL_MS = 30_000;

export interface RecordsStatus {
  readonly isOk: boolean;
  readonly error: string | null;
  readonly at: number;
}

interface HttpsPorts {
  readonly https: number | null;
  readonly http: number | null;
}

export interface HttpsService {
  readonly start: () => void;

  readonly updatePublicRecords: () => Promise<RecordsStatus>;

  readonly readRecordsStatus: () => RecordsStatus | null;

  readonly readPorts: () => {
    readonly tailnet: HttpsPorts;
    readonly public: HttpsPorts | null;
  };
  readonly stop: () => Promise<void>;
}

interface HttpsServiceDeps {
  readonly config: HttpsConfig;
  readonly store: CertStore;
  readonly issue: IssueCertificate;
  readonly dns: DnsProvider;
  readonly proxy: ProxyListen;

  readonly readTailscale: (() => Promise<TailscaleStatus>) | null;
  readonly readServePorts: () => Promise<readonly number[]>;
  readonly now: () => number;

  readonly listPublicImps: () => Promise<readonly string[]>;
  readonly readPublicImpByName: (name: string) => Promise<PublicImp | undefined>;

  readonly timer?: TickerTimer;

  readonly publicAddress?: string;
}

export function createHttpsService(deps: HttpsServiceDeps): HttpsService {
  const config = deps.config;
  const domain = config.domain;

  const certs = createCertManager({
    domain,
    store: deps.store,
    issue: deps.issue,
    now: deps.now,
  });

  const listeners = createHttpsListeners({
    proxy: deps.proxy,
    domain,
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    scope: { kind: 'tailnet' },
  });

  const publicConfig = config.public;

  const publicListeners: HttpsListeners | null =
    publicConfig === null
      ? null
      : createHttpsListeners({
          proxy: deps.proxy,
          domain,
          httpsPort: publicConfig.httpsPort,
          httpPort: publicConfig.httpPort,
          scope: createPublicScope(deps.readPublicImpByName, createPublicLimits(deps.now)),
        });

  const setCertificate = (certificate: Certificate): void => {
    listeners.setCertificate(certificate);
    publicListeners?.setCertificate(certificate);
  };

  const state: {
    tailnetIp: string | null;
    recordsIp: string | null;
    recordsError: string | null;
    checkedServeFor: string | null;
    stopped: boolean;
  } = {
    tailnetIp: null,
    recordsIp: null,
    recordsError: null,
    checkedServeFor: null,
    stopped: false,
  };

  const tickers: Ticker[] = [];

  const startTask = (label: string, intervalMs: number, task: () => Promise<void>): Ticker =>
    startTicker({ label, intervalMs, task, timer: deps.timer });

  const runRenewal = async (): Promise<void> => {
    const certificate = await certs.renew();

    if (certificate !== null && !state.stopped) {
      setCertificate(certificate);
    }
  };

  // the tailnet IP changes when Tailscale deletes an ephemeral node that
  // stayed offline
  const setRecords = async (ip: string): Promise<void> => {
    try {
      await deps.dns.setA(domain, ip);
      await deps.dns.setA(`*.${domain}`, ip);

      state.recordsIp = ip;
      state.recordsError = null;

      getImpdLogger('https').info('{domain} and *.{domain} point at {ip}', { domain, ip });
    } catch (error) {
      const message = `cannot point ${domain} at ${ip}: ${getErrorMessage(error)}`;

      if (message !== state.recordsError) {
        state.recordsError = message;

        getImpdLogger('https').warning('{message}', { message });
      }
    }
  };

  const checkServePorts = async (ip: string): Promise<void> => {
    state.checkedServeFor = ip;

    const held = await deps.readServePorts();

    for (const port of [config.httpsPort, config.httpPort]) {
      if (held.includes(port)) {
        getImpdLogger('https').warning(
          'tailscale serve holds tailnet port {port}, so impd never sees that traffic; remove it with `tailscale serve --https={port} off` or `tailscale serve reset`',
          { port: String(port) },
        );
      }
    }
  };

  const updateAddresses = async (): Promise<void> => {
    const status = deps.readTailscale === null ? null : await deps.readTailscale();

    state.tailnetIp = status?.ip ?? state.tailnetIp;

    const ip = state.tailnetIp;

    if (state.stopped) {
      return;
    }

    if (ip === null) {
      listeners.setAddresses(['127.0.0.1']);

      return;
    }

    listeners.setAddresses(['127.0.0.1', ip]);

    if (state.checkedServeFor !== ip) {
      await checkServePorts(ip);
    }

    if (state.recordsIp !== ip) {
      await setRecords(ip);
    }
  };

  const publicOwner = buildPublicOwner(domain);

  const applyPublicRecords = async (): Promise<void> => {
    const ip = publicConfig?.ip ?? null;
    const wanted = ip === null ? [] : await deps.listPublicImps();

    const present = await deps.dns.listA(domain, publicOwner);

    for (const name of wanted) {
      const fqdn = `${name}.${domain}`;

      if (ip !== null && present.get(fqdn) !== ip) {
        await deps.dns.setA(fqdn, ip, publicOwner);

        getImpdLogger('https').info('{fqdn} points at {ip} (public)', { fqdn, ip });
      }
    }

    for (const fqdn of present.keys()) {
      const label = fqdn.slice(0, -(domain.length + 1));

      if (label.includes('.') || wanted.includes(label)) {
        continue;
      }

      await deps.dns.removeA(fqdn, publicOwner);

      getImpdLogger('https').info('removed {fqdn} (no longer public)', { fqdn });
    }
  };

  const recordsGate = createSemaphore(1);
  let recordsStatus: RecordsStatus | null = null;

  const updatePublicRecords = (): Promise<RecordsStatus> =>
    recordsGate.run(async () => {
      try {
        await applyPublicRecords();

        recordsStatus = { isOk: true, error: null, at: deps.now() };
      } catch (error) {
        const message = getErrorMessage(error);

        getImpdLogger('https').warning('public records: {message}', { message });

        recordsStatus = { isOk: false, error: message, at: deps.now() };
      }

      return recordsStatus;
    });

  return {
    updatePublicRecords,
    readRecordsStatus: () => recordsStatus,
    readPorts: () => ({
      tailnet: listeners.readPorts(),
      public: publicListeners?.readPorts() ?? null,
    }),
    start: () => {
      const certificate = certs.load();

      if (certificate !== null) {
        setCertificate(certificate);
      }

      publicListeners?.setAddresses([deps.publicAddress ?? '0.0.0.0']);

      if (deps.readTailscale === null) {
        getImpdLogger('https').info(
          'no tailnet; https://<imp>.{domain} answers only inside the host container',
          { domain },
        );
      }

      void runLogged('addresses', updateAddresses);
      void runLogged('renewal', runRenewal);
      void updatePublicRecords();

      tickers.push(
        startTask('https renewal', RENEW_INTERVAL_MS, runRenewal),

        startTask('https public records', RENEW_INTERVAL_MS, async () => {
          await updatePublicRecords();
        }),
        startTask('https addresses', ADDRESS_INTERVAL_MS, updateAddresses),
      );
    },
    stop: async () => {
      state.stopped = true;

      await Promise.all(tickers.map((ticker) => ticker.stop()));
      await listeners.stop();
      await publicListeners?.stop();
    },
  };
}

async function runLogged(label: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    getImpdLogger('https').warning('{label}: {error}', { label, error: getErrorMessage(error) });
  }
}
