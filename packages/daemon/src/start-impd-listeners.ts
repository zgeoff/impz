import type { Config } from './config';
import type { createImpdApp } from './create-impd-app';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import type { ImpdDeps } from './impd-deps';
import type { RunImpdStartupStep } from './impd-startup-steps';
import type { Imps } from './imps/imps/imp-service';
import type { AuthorizedKeys } from './imps/ssh/authorized-keys';
import type { ImpdAccess } from './load-impd-access';
import type { Broker } from './network/broker/broker-service';
import type { DnsToken } from './network/https/dns/dns-token';
import type { PublicRecordsLink } from './network/https/public-records-link';
import { wireHttpsService } from './network/https/wire-https-service';
import type { ForwardedPeers } from './network/proxy/forwarded-peers';
import { startWakeProxy } from './network/proxy/wake-proxy';
import type { WakeProxy } from './network/proxy/wake-proxy';
import type { TailnetNames } from './network/tailnet-names/tailnet-names';
import type { ApiAudit } from './platform/audit/api-audit';
import { getImpdLogger } from './platform/process/get-impd-logger';
import { printLog } from './platform/process/print-log';
import type { ImpdStopParts } from './stop-impd';
import { buildApiListenOptions } from './surface/api-listen-options';
import { startPublicListener } from './surface/oauth/public-listener';
import { startSsh } from './surface/ssh/start-ssh';

export interface ImpdListenerParts {
  readonly api: ReturnType<typeof createImpdApp>;
  readonly access: ImpdAccess;
  readonly imps: Imps;
  readonly peers: ForwardedPeers;
  readonly broker: Broker;
  readonly audit: ApiAudit;
  readonly authorizedKeys: AuthorizedKeys;
  readonly publicRecords: PublicRecordsLink;
  readonly dnsToken: DnsToken | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly tailnetNames: TailnetNames | null;
  readonly proxyHolder: { proxy: WakeProxy | null };
}

interface ImpdListenerStartup {
  readonly runStep: RunImpdStartupStep;
  readonly plan: Pick<ImpdStopParts, 'api' | 'publicMcp' | 'proxy' | 'https' | 'ssh'>;
}

export async function startImpdListeners(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<ImpdListenerParts>,
  startup: Readonly<ImpdListenerStartup>,
) {
  const runStep = startup.runStep;
  const plan = startup.plan;
  const log = deps.log ?? printLog;
  const db = deps.db;

  const api = runStep('api', () => {
    // Elysia's listen adds a process beforeExit listener that holds the app;
    // the stop removes it, so a stopped impd leaves nothing reachable
    const exitListeners = new Set(process.listeners('beforeExit'));

    const listening = parts.api.app.listen(
      buildApiListenOptions(config, deps.apiIdleTimeoutS, deps.apiHostname),
    );

    const added = process.listeners('beforeExit').filter((item) => !exitListeners.has(item));

    getImpdLogger('api').info('api on :{port}, data in {dataDir}', {
      port: config.apiPort,
      dataDir: config.dataDir,
    });

    const stop = async (closeActive: boolean): Promise<void> => {
      await listening.stop(closeActive);

      for (const listener of added) {
        process.off('beforeExit', listener);
      }
    };

    return { app: listening, stop };
  });

  plan.api = { stop: api.stop };

  const publicMcp = runStep('public-mcp', () =>
    config.publicMcp === null
      ? null
      : startPublicListener(
          { config: config.publicMcp, oauth: parts.access.oauth, mcp: parts.api.publicMcp },
          log,
        ),
  );

  plan.publicMcp = publicMcp;

  const proxy = await runStep('proxy', async () => {
    const started = startWakeProxy({
      config,
      db,
      imps: parts.imps,
      log,
      peers: parts.peers,
      ...(deps.proxyPorts !== undefined && { ports: deps.proxyPorts }),
    });

    parts.proxyHolder.proxy = started;
    plan.proxy = started;

    await started.syncListeners();

    return started;
  });

  const https = runStep('https', () => {
    if (config.https === null) {
      return null;
    }

    const service = wireHttpsService({
      config: config.https,
      dataDir: config.dataDir,
      db,
      proxy,
      readTailscale: config.tailscaleEnabled ? parts.readTailscale : null,
      dnsToken: parts.dnsToken,
      log,
    });

    parts.publicRecords.attach(service);
    service.start();

    plan.https = service;

    return service;
  });

  // not awaited, so a Tailscale API or tailscaled outage never holds up impd
  runStep('tailnet-names', () => {
    void parts.tailnetNames?.runSync();
  });

  const brokerPort = await runStep('broker', async () => {
    const port = await parts.broker.listen(config.brokerPort);

    getImpdLogger('broker').info("credential broker on :{port} of every imp's gateway", { port });

    return port;
  });

  const ssh = await runStep('ssh', () =>
    startSsh({
      config,
      db,
      imps: parts.imps,
      authorizedKeys: parts.authorizedKeys,
      tokens: parts.access.tokens,
      revocations: parts.access.revocations,
      log,
      audit: parts.audit,
      now: Date.now,
    }),
  );

  plan.ssh = ssh;

  return { app: api.app, stopApi: api.stop, publicMcp, proxy, https, brokerPort, ssh };
}
