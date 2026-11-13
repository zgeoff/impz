import type { GrantLimits } from '@zgeoff/mcp-auth';
import type { Caller } from '../../platform/principal/caller';
import { ImpLimitsSchema } from './imp-limits-schema';
import type { ImpLimits } from './imp-limits-schema';
import { parseConsentImps } from './parse-consent-imps';
import { pickGrantCheck } from './pick-grant-check';
import { renderConsentImps } from './render-consent-imps';

interface ImpGrantLimitsDeps {
  // In memory: verify runs the check on every call.
  readonly findToken: (id: string) => Caller | null;
}

export function buildImpGrantLimits(deps: Readonly<ImpGrantLimitsDeps>): GrantLimits<ImpLimits> {
  return {
    renderConsentFields: () => renderConsentImps(),
    parseConsentFields: (form) => parseConsentImps(form),
    parseStored: (json) => ImpLimitsSchema.safeParse(json).data ?? null,
    check: (grant) => {
      const approver = grant.approvedBy.startsWith('token:')
        ? deps.findToken(grant.approvedBy.slice('token:'.length))
        : null;

      return Promise.resolve(pickGrantCheck(grant, approver));
    },
  };
}
