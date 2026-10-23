import { EgressPolicySchema } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { toPlainOctets } from '@impz/shared';

// A policy that impd stored, backed up or sent on a move can hold an IPv4 octet
// with a leading zero, such as 008, which impd reads as decimal and the policy
// schema refuses.
export function parseEgressPolicy(mode: string, allow: unknown): EgressPolicy | null {
  const plain = Array.isArray(allow)
    ? allow.map((entry: unknown) => (typeof entry === 'string' ? toPlainOctets(entry) : entry))
    : allow;

  const parsed = EgressPolicySchema.safeParse({ mode, allow: plain });

  return parsed.success ? parsed.data : null;
}
