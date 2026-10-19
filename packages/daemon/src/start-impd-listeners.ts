import { buildApiListenOptions } from './api-listen-options';
import type { ApiAudit } from './audit/api-audit';
import type { Broker } from './broker/broker-service';
import type { buildImpdApp } from './build-impd-app';
import type { Config } from './config';
import { buildHttpsService } from './https/build-https-service';
import type { DnsToken } from './https/dns/dns-token';
import type { PublicRecordsLink } from './https/public-records-link';
import type { ImpdDeps } from './impd-deps';
import type { RunImpdStartupStep } from './impd-startup-steps';
import type { Imps } from './imps/imp-service';
import type { ImpdAccess } from './load-impd-access';
import type { TailscaleStatus } from './net/tailscale-status';
import { startPublicListener } from './oauth/public-listener';
import { getImpdLogger } from './process/get-impd-logger';
import { printLog } from './process/print-log';
import type { ForwardedPeers } from './proxy/forwarded-peers';
import { startWakeProxy } from './proxy/wake-proxy';
import type { WakeProxy } from './proxy/wake-proxy';
import type { AuthorizedKeys } from './ssh/authorized-keys';
import { startSsh } from './ssh/start-ssh';
import type { TailnetNames } from './tailnet-names/tailnet-names';

export interface ImpdListenerParts {
  readonly api: ReturnType<typeof buildImpdApp>;
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

  // where the wake proxy goes once it is up, for the imps' writes
  readonly proxyHolder: { proxy: WakeProxy | null };
}

// Every port impd serves, each opened in its own startup step: the API,
// the public MCP route, the wake proxy, HTTPS, the broker and SSH. A part
// the config leaves off is null.
export async function startImpdListeners(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<ImpdListenerParts>,
  runStep: RunImpdStartupStep,
) {
  const log = deps.log ?? printLog;
  const db = deps.db;

  const api = runStep('api', () => {
    // Elysia's listen adds a process beforeExit listener that holds the app;
    // the stop removes it, so a stopped impd leaves nothing reachable
    const exitListeners = new Set(process.listeners('beforeExit'));

    const listening = parts.api.app.listen(buildApiListenOptions(config, deps.apiIdleTimeoutS));
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

  // off unless the operator names the route's origin
  const publicMcp = runStep('public-mcp', () =>
    config.publicMcp === null
      ? null
      : startPublicListener(
          { config: config.publicMcp, oauth: parts.access.oauth, mcp: parts.api.publicMcp },
          log,
        ),
  );

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

    await started.syncListeners();

    return started;
  });

  const https = runStep('https', () => {
    if (config.https === null) {
      return null;
    }

    const service = buildHttpsService({
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

    return service;
  });

  // in the background: an API or tailscaled outage never holds up impd
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

  return { app: api.app, stopApi: api.stop, publicMcp, proxy, https, brokerPort, ssh };
}
