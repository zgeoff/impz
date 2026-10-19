import type { ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createSecretFiles } from '../broker/secret-files';
import type { AppDeps } from '../build-app';
import { buildImpdApp } from '../build-impd-app';
import { buildImpdServices } from '../build-impd-services';
import type { ImpdDeps } from '../create-impd';
import { createImpdMoves } from '../create-impd-moves';
import { createDnsToken } from '../https/dns/dns-token';
import { createPublicRecordsLink } from '../https/public-records-link';
import { BUILD_KEEPALIVE_MS } from '../images/build-event-stream';
import type { MoveServiceDeps } from '../moves/move-service';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { buildTestDeps } from './build-test-deps';
import type { ImpService } from './imp-service';
import { readNoTailscale } from './read-no-tailscale';
import type { ImpTest } from './test-imps';
import { TEST_TOKEN } from './test-token';

type Impd = ReturnType<ImpTest['restartImpd']>;

type AppParts = Pick<
  ImpTest,
  | 'config'
  | 'db'
  | 'images'
  | 'storage'
  | 'storageGate'
  | 'diskBudget'
  | 'now'
  | 'log'
  | 'logRpcFailure'
  | 'broker'
  | 'tokens'
  | 'revocations'
  | 'oauth'
  | 'egress'
  | 'readIdentity'
  | 'readKsmHostStats'
>;

// The HTTP app over `impd` (the harness's or a restarted one), an oRPC client
// that calls it without a socket, a no-op freeze and thaw, and `openExec` in
// place of the guest agent, which the fake VMs do not run.
export function buildTestApp(
  ctx: Readonly<AppParts>,
  impd: Readonly<Impd>,
  token = TEST_TOKEN,

  // a fake agent's streams in place of the VM's
  agent: Partial<Pick<ImpService, 'openExec' | 'openAttach'>> = {},

  // tailnet identity, off by default
  tailnet: AppDeps['tailnet'] = null,

  // a move test's fetch to the other host, and its hooks
  moveOptions: Partial<
    Pick<
      MoveServiceDeps,
      | 'fetch'
      | 'startPeerDeadline'
      | 'releaseName'
      | 'onCommitted'
      | 'partBytes'
      | 'readWarmHost'
      | 'readTapMac'
    >
  > = {},

  // the gap between the progress events of a streamed image call
  buildKeepaliveMs = BUILD_KEEPALIVE_MS,
) {
  const identity = ctx.readIdentity();

  const deps = buildTestDeps({
    db: ctx.db,
    dataDir: ctx.config.dataDir,
    storage: ctx.storage,
    systemDrivePath: identity.systemDrivePath,
    now: ctx.now,
    log: ctx.log,
    logRpcFailure: ctx.logRpcFailure,
  });

  // the services under the API log nowhere, as before the shim
  const quiet: ImpdDeps = { ...deps, log: () => {} };

  const storage = {
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    images: ctx.images,
  };

  const services = buildImpdServices(ctx.config, quiet, {
    storage,
    imps: impd.imps,
    egress: ctx.egress,
    secretFiles: createSecretFiles(ctx.config.dataDir),
  });

  const peers = createForwardedPeers(ctx.now);

  const moves = createImpdMoves(
    ctx.config,
    quiet,
    {
      storage,
      imps: impd.imps,
      broker: ctx.broker,
      egress: ctx.egress,
      audit: services.audit,
      readIdentity: ctx.readIdentity,
    },
    {
      readTailnetIp: () => Promise.resolve(null),
      releaseName: () => Promise.resolve(),
      onCommitted: () => {},
      ...moveOptions,
    },
  );

  // the DNS API token as main reads it, for system info
  const dnsTokenSource = ctx.config.https?.dns.token ?? null;
  const dnsToken = dnsTokenSource === null ? null : createDnsToken(dnsTokenSource, ctx.now);

  const built = buildImpdApp(ctx.config, deps, {
    storage,
    access: { tokens: ctx.tokens, revocations: ctx.revocations, oauth: ctx.oauth },
    services,
    imps: { ...impd.imps, ...agent },
    governor: impd.governor,
    broker: ctx.broker,
    egress: ctx.egress,

    // every test VM reports this Firecracker, whatever identity a restart took
    identity: { ...identity, firecrackerVersion: 'v1.17.0' },
    peers,
    tailnet,
    backups: null,
    moves,
    publicRecords: createPublicRecordsLink(),
    checkDnsToken: dnsToken?.check ?? null,
    readTailscale: readNoTailscale,
    readTailnetNames: null,
    isReady: () => true,
    keepaliveMs: buildKeepaliveMs,
    ...(ctx.readKsmHostStats !== null && { readKsmHostStats: ctx.readKsmHostStats }),
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => built.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    app: built.app,
    publicMcp: built.publicMcp,
    closeExecSessions: built.closeExecSessions,
    client,
    peers,
    moves,
  };
}
