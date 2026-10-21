import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import type { PublicImp } from '../../platform/db/exposure';
import { getErrorMessage } from '../../platform/process/get-error-message';
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
  readonly log: (message: string) => void;

  readonly listPublicImps: () => Promise<readonly string[]>;
  readonly readPublicImpByName: (name: string) => Promise<PublicImp | undefined>;

  readonly timer?: TickerTimer;

  readonly publicAddress?: string;
}

export function createHttpsService(deps: HttpsServiceDeps): HttpsService {
  const config = deps.config;
  const domain = config.domain;
  const log = deps.log;

  const certs = createCertManager({
    domain,
    store: deps.store,
    issue: deps.issue,
    now: deps.now,
    log,
  });

  const listeners = createHttpsListeners({
    proxy: deps.proxy,
    domain,
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    log,
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
          log,
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

  const startTask = (
    label: string,
    intervalMs: number,
    task: () => Promise<void>,
    taskLog: (message: string) => void,
  ): Ticker => startTicker(label, intervalMs, task, taskLog, deps.timer);

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

      log(`impd: https: ${domain} and *.${domain} point at ${ip}`);
    } catch (error) {
      const message = `impd: https: cannot point ${domain} at ${ip}: ${getErrorMessage(error)}`;

      if (message !== state.recordsError) {
        state.recordsError = message;

        log(message);
      }
    }
  };

  const checkServePorts = async (ip: string): Promise<void> => {
    state.checkedServeFor = ip;

    const held = await deps.readServePorts();

    for (const port of [config.httpsPort, config.httpPort]) {
      if (held.includes(port)) {
        log(
          `impd: https: warning: tailscale serve holds tailnet port ${String(port)}, so impd never sees that traffic; remove it with \`tailscale serve --https=${String(port)} off\` or \`tailscale serve reset\``,
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

        log(`impd: https: ${fqdn} points at ${ip} (public)`);
      }
    }

    for (const fqdn of present.keys()) {
      const label = fqdn.slice(0, -(domain.length + 1));

      if (label.includes('.') || wanted.includes(label)) {
        continue;
      }

      await deps.dns.removeA(fqdn, publicOwner);

      log(`impd: https: removed ${fqdn} (no longer public)`);
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

        log(`impd: https: public records: ${message}`);

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
        log(
          `impd: https: no tailnet; https://<imp>.${domain} answers only inside the host container`,
        );
      }

      void runLogged('addresses', updateAddresses, log);
      void runLogged('renewal', runRenewal, log);
      void updatePublicRecords();

      tickers.push(
        startTask('https renewal', RENEW_INTERVAL_MS, runRenewal, log),

        startTask(
          'https public records',
          RENEW_INTERVAL_MS,
          async () => {
            await updatePublicRecords();
          },
          log,
        ),
        startTask('https addresses', ADDRESS_INTERVAL_MS, updateAddresses, log),
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

async function runLogged(
  label: string,
  task: () => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    log(`impd: https: ${label}: ${getErrorMessage(error)}`);
  }
}
