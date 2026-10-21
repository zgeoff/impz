import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { readEgressPolicy, writeEgressPolicy } from '../../platform/db/egress';
import { readImpByName } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { KeyedMutex } from '../../platform/process/keyed-mutex';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildMovingError, buildNotFoundError } from '../../surface/api-errors';
import { buildAllowRules, isNameAllowed, isTunnelAllowed } from './egress-rules';
import type { EgressSets } from './egress-sets';

interface SetPolicyDeps {
  readonly db: ImpDatabase;
  readonly mutex: KeyedMutex;
  readonly sets: EgressSets;
  readonly requireFirewall: (policy: EgressPolicy) => void;
  readonly requirePolicy: (policy: EgressPolicy) => void;
  readonly applyTable: () => Promise<void>;
  readonly tryApplyTable: () => Promise<void>;
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;
  readonly flushConnections: (guestIp: string) => Promise<void>;
  readonly resolveExactNames: (slot: number) => Promise<void>;
}

export function makeSetPolicy(
  deps: SetPolicyDeps,
): (name: string, policy: EgressPolicy) => Promise<EgressPolicy> {
  return (name, policy) =>
    deps.mutex.runExclusive('policy', async () => {
      deps.requireFirewall(policy);

      const imp = await readImpByName(deps.db, name);

      const previous = imp === undefined ? undefined : await readEgressPolicy(deps.db, imp.id);

      if (imp === undefined || previous === undefined) {
        throw buildNotFoundError('imp', name);
      }

      if (imp.moveState !== null) {
        throw buildMovingError(name);
      }

      await writeEgressPolicy(deps.db, imp.id, policy);

      const rules = buildAllowRules(policy.allow);

      if (EGRESS_MODE_TRAITS[policy.mode].hasAllowList) {
        deps.sets.prune(imp.slot, (allowed) => isNameAllowed(rules, allowed));
      } else {
        deps.sets.clear(imp.slot);
      }

      try {
        await deps.applyTable();

        deps.requirePolicy(policy);
      } catch (error) {
        await writeEgressPolicy(deps.db, imp.id, previous);

        await deps.tryApplyTable();

        throw error;
      }

      const isNewlyPublic =
        EGRESS_MODE_TRAITS[policy.mode].isPublic && !EGRESS_MODE_TRAITS[previous.mode].isPublic;

      deps.closeTunnels(imp.id, (host) => !isNewlyPublic && isTunnelAllowed(policy, host));

      if (EGRESS_MODE_TRAITS[policy.mode].needsRuleset) {
        await deps.flushConnections(imp.ip);
      }

      void deps.resolveExactNames(imp.slot);

      return policy;
    });
}
