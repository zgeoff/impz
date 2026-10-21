import { EGRESS_MODE_TRAITS, EgressModeSchema } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { UsageError } from '../cli/errors';

export function parsePolicy(
  mode: string | undefined,
  allow: string | undefined,
): EgressPolicy | undefined {
  if (mode === undefined && allow === undefined) {
    return undefined;
  }

  const parsed = EgressModeSchema.safeParse(mode ?? 'box');

  if (!parsed.success) {
    throw new UsageError(`the egress policy is open, public, box or none, not ${mode ?? ''}`);
  }

  const entries = (allow ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');

  if (!EGRESS_MODE_TRAITS[parsed.data].hasAllowList && entries.length > 0) {
    throw new UsageError(`--allow is for a box policy, not ${parsed.data}`);
  }

  return { mode: parsed.data, allow: entries };
}

export function formatPolicy(policy: EgressPolicy): string {
  return EGRESS_MODE_TRAITS[policy.mode].hasAllowList
    ? `box: ${policy.allow.length === 0 ? '(nothing)' : policy.allow.join(', ')}`
    : policy.mode;
}
