import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { buildMovingError, buildNotFoundError } from '../api-errors';
import { readEgressPolicy, writeEgressPolicy } from '../db/egress';
import { findImpByName } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { KeyedMutex } from '../process/keyed-mutex';
import { buildAllowRules, isNameAllowed, isTunnelAllowed } from './egress-rules';
import type { EgressSets } from './egress-sets';

// what a policy change needs of the rest of the egress service
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

// the setPolicy of EgressService
export function makeSetPolicy(
  deps: SetPolicyDeps,
): (name: string, policy: EgressPolicy) => Promise<EgressPolicy> {
  // one change at a time, slots included, so a rollback never undoes a
  // later change
  return (name, policy) =>
    deps.mutex.runExclusive('policy', async () => {
      // the routes a public policy needs are read with the table, below
      deps.requireFirewall(policy);

      const imp = await findImpByName(deps.db, name);

      const previous = imp === undefined ? undefined : await readEgressPolicy(deps.db, imp.id);

      if (imp === undefined || previous === undefined) {
        throw buildNotFoundError('imp', name);
      }

      // a send carries the policy it read at its start
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

      // the row goes back, and the table is built again from it, so nft
      // and the database agree whichever table nft last took; a public
      // policy whose routes could not be read goes back too
      try {
        await deps.applyTable();

        deps.requirePolicy(policy);
      } catch (error) {
        await writeEgressPolicy(deps.db, imp.id, previous);

        await deps.tryApplyTable();

        throw error;
      }

      // the guest's own flows the new policy may deny, and the broker's
      // tunnels, which conntrack does not see. A tunnel is kept by its
      // host, and one that becomes public was dialled under fewer checks.
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
