import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { formatSubnet, parseIpv4 } from '../../host-net/net/addressing';
import { deriveGuestIp6 } from '../../host-net/net/addressing6';
import type { Ipv6Plan } from '../../host-net/net/ipv6-plan';
import { buildRangeMatcher } from '../../host-net/net/range-matcher';
import { NO_HOST_ROUTES } from '../../host-net/net/reach-policy';
import type { HostRoutes, ReachPolicy, ReachRanges } from '../../host-net/net/reach-policy';
import { listEgressSlots, readEgressPolicy } from '../../platform/db/egress';
import type { EgressSlot } from '../../platform/db/egress';
import { readImpByName } from '../../platform/db/imps';
import { listNetworkMembers, listNetworkNames } from '../../platform/db/networks';
import type { NetworkMember } from '../../platform/db/networks';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildNotFoundError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { buildKeyedMutex } from '../../platform/process/keyed-mutex';
import { startInterval } from '../../platform/process/start-interval';
import type { BucketSpec } from '../../platform/process/token-buckets';
import type { NetworkConfig } from '../network-config';
import { checkPeerAccept } from './check-peer-accept';
import { createExactResolver } from './create-exact-resolver';
import { createDnsForward } from './dns-upstream';
import type { DnsForward } from './dns-upstream';
import { runConntrackFlush, runForwardRulesList, runPairFlush } from './egress-commands';
import { createNftWriter, formatNftError, runNft } from './egress-firewall';
import type { NftRunner } from './egress-firewall';
import { createQueryHandler, startResolverServer } from './egress-resolver';
import type { QueryVerdict, ResolverServer } from './egress-resolver';
import { buildAllowRules, isNameAllowed, listExactNames } from './egress-rules';
import type { AllowRules } from './egress-rules';
import { buildElementChange, buildRuleset } from './egress-ruleset';
import type { RegistryAddress } from './egress-ruleset';
import { createEgressSets } from './egress-sets';
import type { AddressAnswer, HeldAnswer } from './egress-sets';
import { isMissingHostAddresses } from './is-missing-host-addresses';
import { listPeerGroups } from './list-peer-groups';
import { makeChangeNetworks } from './make-change-networks';
import type { NetworkChange } from './make-change-networks';
import { makeSetPolicy } from './make-set-policy';
import { resolveNetworkName } from './network-names';

const MIN_TTL_S = 300;
const MAX_TTL_S = 86_400;
const SET_SIZE = 4096;
const SWEEP_MS = 30_000;
const CLOSED_RATE: BucketSpec = { size: 500, refillMs: 10 };
const OPEN_RATE: BucketSpec = { size: 2000, refillMs: 1 };

export interface EgressDeps {
  readonly config: Pick<
    NetworkConfig,
    'subnet' | 'dns' | 'egressDnsPort' | 'egressDeny' | 'hostAddresses'
  >;
  readonly db: ImpDatabase;

  readonly isGranted: (impId: string, host: string) => Promise<boolean>;
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  readonly ipv6?: Ipv6Plan | null;
  readonly reach: ReachPolicy;

  readonly testRegistry?: RegistryAddress | null;

  readonly runNft?: NftRunner;
  readonly flushConnections?: (guestIp: string) => Promise<void>;
  readonly flushPair?: (first: string, second: string) => Promise<void>;
  readonly readForwardRules?: () => Promise<string>;
  readonly forward?: DnsForward;
  readonly resolveExact?: (name: string) => Promise<readonly AddressAnswer[]>;
  readonly now?: () => number;

  readonly repeat?: (run: () => void, durationMs: number) => () => void;
}

export interface EgressService {
  readonly start: () => Promise<void>;
  readonly stop: () => void;

  readonly requirePolicy: (policy: EgressPolicy) => void;
  readonly isEnforced: () => boolean;
  readonly requireImp: (impId: string) => Promise<void>;

  readonly addSlot: (slot: number) => Promise<void>;

  readonly releaseSlot: (slot: number) => Promise<void>;

  readonly changeNetworks: <T>(change: NetworkChange<T>) => Promise<T>;
  readonly readPolicy: (name: string) => Promise<EgressPolicy>;
  readonly setPolicy: (name: string, policy: EgressPolicy) => Promise<EgressPolicy>;

  readonly checkName: (slot: number, name: string) => Promise<QueryVerdict | null>;
  readonly writeAnswers: (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
  ) => Promise<void>;
  readonly runSweep: () => Promise<void>;

  readonly readAnswers: (slot: number) => readonly HeldAnswer[];
}

interface SlotView {
  readonly entry: EgressSlot;
  readonly rules: AllowRules;
}

interface HostRanges {
  readonly ranges: ReachRanges;
  readonly uplinks: HostRoutes['uplinks'];

  readonly error: string | null;
}

export function createEgressService(deps: EgressDeps): EgressService {
  const now = deps.now ?? Date.now;
  const repeat = deps.repeat ?? startInterval;
  const write = createNftWriter(deps.runNft ?? runNft);
  const flushConnections = deps.flushConnections ?? ((guestIp) => runConntrackFlush(guestIp));
  const flushPair = deps.flushPair ?? ((first, second) => runPairFlush(first, second));
  const readForwardRules = deps.readForwardRules ?? (() => runForwardRulesList());
  const forward = deps.forward ?? createDnsForward(deps.config.dns);
  const ipv6 = deps.ipv6 ?? null;
  const reach = deps.reach;
  const resolveExact = deps.resolveExact ?? createExactResolver(deps.config.dns, ipv6 !== null);
  const sets = createEgressSets({ minTtlS: MIN_TTL_S, maxTtlS: MAX_TTL_S, maxPerSlot: SET_SIZE });
  const mutex = buildKeyedMutex();
  const startRanges = reach.buildRanges(NO_HOST_ROUTES);

  const readHostRanges = async (hasPublic: boolean): Promise<HostRanges> => {
    try {
      const host = await reach.read(hasPublic);

      return { ranges: host.ranges, uplinks: host.uplinks, error: null };
    } catch (error) {
      const message = getErrorMessage(error);

      getImpdLogger('egress').warning("reading the host container's routes: {message}", {
        message,
      });

      return {
        ranges: startRanges,
        uplinks: NO_HOST_ROUTES.uplinks,
        error: hasPublic ? message : null,
      };
    }
  };

  const state: {
    slots: Map<number, SlotView>;

    members: readonly NetworkMember[];
    networkNames: ReadonlySet<string>;

    peerAcceptMissing: boolean;
    released: Set<number>;
    unenforced: string | null;
    server: ResolverServer | null;
    stopSweep: (() => void) | null;

    isScreened: (address: string) => boolean;

    publicUnenforced: string | null;
    denyListMissing: boolean;
  } = {
    slots: new Map(),
    members: [],
    networkNames: new Set(),
    peerAcceptMissing: false,
    released: new Set(),
    unenforced: null,
    server: null,
    stopSweep: null,
    isScreened: buildRangeMatcher([...startRanges.public4, ...startRanges.public6]),
    publicUnenforced: null,
    denyListMissing: false,
  };

  const findGuestIp6 = (guestIp: string): string | null => {
    const ip = parseIpv4(guestIp);

    return ipv6 === null || ip === null ? null : deriveGuestIp6(ipv6.prefix, ip);
  };

  const buildScript = (
    views: ReadonlyMap<number, SlotView>,
    host: HostRanges,
    members: readonly NetworkMember[],
  ): string =>
    buildRuleset({
      networks: listPeerGroups(members),
      subnet: formatSubnet(deps.config.subnet),
      dnsServers: deps.config.dns,
      privateRanges: host.ranges.private4,
      blocked6: host.ranges.blocked6,
      public4: host.ranges.public4,
      public6: host.ranges.public6,
      uplinks4: host.uplinks.ipv4,
      uplinks6: host.uplinks.ipv6,
      dnsPort: deps.config.egressDnsPort,
      setSize: SET_SIZE,
      slots: [...views.values()].map((view) => ({
        slot: view.entry.slot,
        tap: `imp${String(view.entry.slot)}`,
        guestIp: view.entry.guestIp,
        guestIp6: findGuestIp6(view.entry.guestIp),
        mode: view.entry.policy.mode,
        cidrs: EGRESS_MODE_TRAITS[view.entry.policy.mode].hasAllowList ? view.rules.cidrs : [],
        addresses: EGRESS_MODE_TRAITS[view.entry.policy.mode].hasAllowList
          ? sets.listAddresses(view.entry.slot)
          : [],
        testRegistry: view.entry.isBuilder ? (deps.testRegistry ?? null) : null,
      })),
    });

  const applyTable = (): Promise<void> =>
    mutex.runExclusive('table', async () => {
      const rows = await listEgressSlots(deps.db);

      const slots = new Map<number, SlotView>();

      for (const entry of rows) {
        if (!state.released.has(entry.slot)) {
          slots.set(entry.slot, { entry, rules: buildAllowRules(entry.policy.allow) });
        }
      }

      const allMembers = await listNetworkMembers(deps.db);

      const members = allMembers.filter((member) => slots.has(member.slot));

      const networkNames = await listNetworkNames(deps.db);

      if (state.unenforced === null) {
        const hasPublic = [...slots.values()].some(
          (view) => EGRESS_MODE_TRAITS[view.entry.policy.mode].isPublic,
        );

        const host = await readHostRanges(hasPublic);

        await write(buildScript(slots, host, members));

        state.isScreened = buildRangeMatcher([...host.ranges.public4, ...host.ranges.public6]);
        state.publicUnenforced = host.error;

        const isMissing = isMissingHostAddresses(hasPublic, deps.config.hostAddresses);

        if (isMissing && !state.denyListMissing) {
          getImpdLogger('egress').warning(
            "a public imp exists and IMP_HOST_ADDRESSES is empty, so only IMP_EGRESS_DENY keeps it from the Docker host's own addresses and networks; the systemd unit and the NixOS module fill it at each start, compose does not (docs/architecture/network/egress.md#public)",
          );
        }

        state.denyListMissing = isMissing;
      }

      for (const slot of state.slots.keys()) {
        if (!slots.has(slot)) {
          sets.clear(slot);
        }
      }

      state.slots = slots;
      state.members = members;

      if (state.unenforced === null && members.length > 0) {
        state.peerAcceptMissing = await checkPeerAccept({
          readForwardRules,
          wasMissing: state.peerAcceptMissing,
        });
      }

      state.networkNames = new Set(networkNames);
    });

  const tryApplyTable = async (): Promise<void> => {
    try {
      await applyTable();
    } catch (error) {
      getImpdLogger('egress').warning('rebuilding the table: {error}', {
        error: getErrorMessage(error),
      });
    }
  };

  const writeAnswers = async (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
  ): Promise<void> => {
    if (!hasAllowList(state.slots.get(slot))) {
      return;
    }

    const change = sets.record(slot, names, answers, now());

    const script =
      (change.removed.length > 0 ? buildElementChange('delete', slot, change.removed) : '') +
      (change.added.length > 0 ? buildElementChange('add', slot, change.added) : '');

    if (script !== '') {
      await write(script);
    }
  };

  const checkName = async (slot: number, name: string): Promise<QueryVerdict | null> => {
    const view = state.slots.get(slot);

    if (view === undefined) {
      return null;
    }

    const traits = EGRESS_MODE_TRAITS[view.entry.policy.mode];

    if (traits.isOpen) {
      return 'answer';
    }

    if (traits.isPublic) {
      return 'screen';
    }

    if (
      traits.hasAllowList &&
      (isNameAllowed(view.rules, name) || sets.isAlias(slot, name, now()))
    ) {
      return 'admit';
    }

    const granted = await deps.isGranted(view.entry.impId, name);

    return granted ? 'answer' : 'refuse';
  };

  const resolveExactNames = async (slot: number): Promise<void> => {
    const view = state.slots.get(slot);

    if (view === undefined || !hasAllowList(view)) {
      return;
    }

    for (const name of listExactNames(view.entry.policy.allow)) {
      try {
        const answers = await resolveExact(name);

        await writeAnswers(slot, [name], answers);
      } catch (error) {
        getImpdLogger('egress')
          .with({ imp: view.entry.name })
          .warning('resolving {name}: {error}', { name, error: getErrorMessage(error) });
      }
    }
  };

  const runSweep = async (): Promise<void> => {
    const due = sets.sweep(now());

    const scripts = [...due].flatMap(([slot, addresses]) =>
      hasAllowList(state.slots.get(slot)) ? [buildElementChange('delete', slot, addresses)] : [],
    );

    if (scripts.length > 0) {
      await write(scripts.join(''));
    }
  };

  const runLoggedSweep = async (): Promise<void> => {
    try {
      await runSweep();
    } catch (error) {
      getImpdLogger('egress').warning('sweep: {error}', { error: getErrorMessage(error) });
    }
  };

  const requireFirewall = (policy: EgressPolicy): void => {
    if (EGRESS_MODE_TRAITS[policy.mode].needsRuleset && state.unenforced !== null) {
      throw new ImpdError('PRECONDITION_FAILED', {
        message: `impd cannot enforce a ${policy.mode} egress policy here: ${state.unenforced}`,
      });
    }
  };

  const requirePolicy = (policy: EgressPolicy): void => {
    requireFirewall(policy);

    if (EGRESS_MODE_TRAITS[policy.mode].isPublic && state.publicUnenforced !== null) {
      throw new ImpdError('PRECONDITION_FAILED', {
        message: `impd cannot read the routes a public egress policy needs: ${state.publicUnenforced}`,
      });
    }
  };

  const changeNetworks = makeChangeNetworks({
    mutex,
    applyTable,
    tryApplyTable,
    flushPair,
    readMembers: () => state.members,
  });

  const setPolicy = makeSetPolicy({
    db: deps.db,
    mutex,
    sets,
    requireFirewall,
    requirePolicy,
    applyTable,
    tryApplyTable,
    closeTunnels: deps.closeTunnels,
    flushConnections,
    resolveExactNames,
  });

  return {
    start: async () => {
      try {
        await applyTable();
      } catch (error) {
        state.unenforced = formatNftError(error);

        await applyTable();

        const closed = [...state.slots.values()].filter(
          (view) => EGRESS_MODE_TRAITS[view.entry.policy.mode].needsRuleset,
        );

        getImpdLogger('egress').error(
          'NO FIREWALL: {unenforced}; imps with a public, box or none policy will not start ({length} now)',
          { unenforced: state.unenforced, length: String(closed.length) },
        );

        return;
      }

      const handle = createQueryHandler({
        subnet: deps.config.subnet,
        ipv6: ipv6 !== null,
        resolveLocal: (slot, query) =>
          resolveNetworkName(
            { names: state.networkNames, members: state.members },
            deps.config.subnet,
            { slot, ...query },
          ),
        checkName,
        writeAnswers,
        forward,
        isScreened: (address) => state.isScreened(address),
        maxTtlS: MIN_TTL_S,
        readRate: (slot) => (isForwardedFreely(state.slots.get(slot)) ? OPEN_RATE : CLOSED_RATE),
        now,
      });

      state.server = await startResolverServer(
        deps.config.egressDnsPort,
        deps.config.subnet,
        handle,
        { now },
      );

      state.stopSweep = repeat(() => {
        void runLoggedSweep();
      }, SWEEP_MS);

      for (const slot of state.slots.keys()) {
        void resolveExactNames(slot);
      }
    },

    stop: () => {
      state.server?.stop();
      state.stopSweep?.();
    },

    requirePolicy,
    isEnforced: () => state.unenforced === null,

    requireImp: async (impId) => {
      const policy = await readEgressPolicy(deps.db, impId);

      if (
        policy !== undefined &&
        EGRESS_MODE_TRAITS[policy.mode].isPublic &&
        state.publicUnenforced !== null
      ) {
        await mutex.runExclusive('policy', tryApplyTable);
      }

      if (policy !== undefined) {
        requirePolicy(policy);
      }
    },

    addSlot: (slot) =>
      mutex.runExclusive('policy', async () => {
        state.released.delete(slot);
        sets.clear(slot);

        await applyTable();

        void resolveExactNames(slot);
      }),

    releaseSlot: (slot) =>
      mutex.runExclusive('policy', async () => {
        state.released.add(slot);

        await applyTable();
      }),

    changeNetworks,

    readPolicy: async (name) => {
      const imp = await readImpByName(deps.db, name);

      const policy = imp === undefined ? undefined : await readEgressPolicy(deps.db, imp.id);

      if (policy === undefined) {
        throw buildNotFoundError('imp', name);
      }

      return policy;
    },

    setPolicy,

    checkName,
    writeAnswers,
    runSweep,
    readAnswers: (slot) => sets.listAnswers(slot, now()),
  };
}

function hasAllowList(view: SlotView | undefined): boolean {
  return view !== undefined && EGRESS_MODE_TRAITS[view.entry.policy.mode].hasAllowList;
}

function isForwardedFreely(view: SlotView | undefined): boolean {
  if (view === undefined) {
    return false;
  }

  const traits = EGRESS_MODE_TRAITS[view.entry.policy.mode];

  return traits.isOpen || traits.isPublic;
}
