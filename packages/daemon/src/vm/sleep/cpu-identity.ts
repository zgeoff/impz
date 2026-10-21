import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// A guest kernel picks its code paths on the CPU it boots on, so its memory snapshot loads only on
// the same CPU model with the same CPUID flags.
export interface CpuIdentity {
  readonly cpuModel: string;
  readonly cpuFlags: string;
}

export const UNKNOWN_CPU = 'unknown';

export function parseCpuInfo(text: string): CpuIdentity {
  const first = text.split(/\n\s*\n/u)[0] ?? '';

  const fields = new Map<string, string>();

  for (const line of first.split('\n')) {
    const at = line.indexOf(':');

    if (at !== -1) {
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }

  // arm64's /proc/cpuinfo names the model `CPU part` and the flags `Features`.
  const model = fields.get('model name') ?? fields.get('CPU part') ?? UNKNOWN_CPU;
  const flags = fields.get('flags') ?? fields.get('Features');

  if (flags === undefined) {
    return { cpuModel: model, cpuFlags: UNKNOWN_CPU };
  }

  const sorted = flags.split(/\s+/u).filter(Boolean).toSorted().join(' ');

  return { cpuModel: model, cpuFlags: createHash('sha256').update(sorted).digest('hex') };
}

export function readCpuIdentity(path = '/proc/cpuinfo'): CpuIdentity {
  try {
    return parseCpuInfo(readFileSync(path, 'utf8'));
  } catch {
    return { cpuModel: UNKNOWN_CPU, cpuFlags: UNKNOWN_CPU };
  }
}

export function findCpuChange(
  snapshot: Readonly<{ cpuModel?: string | undefined; cpuFlags?: string | undefined }>,
  host: Readonly<CpuIdentity>,
): string | null {
  if (snapshot.cpuModel !== undefined && snapshot.cpuModel !== host.cpuModel) {
    return `the CPU changed (${snapshot.cpuModel} → ${host.cpuModel})`;
  }

  if (snapshot.cpuFlags !== undefined && snapshot.cpuFlags !== host.cpuFlags) {
    return 'the CPU flags changed';
  }

  return null;
}
