import * as z from 'zod';
import { runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';

const ServeStatusSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
});

// tailscaled takes a serve port on the tailnet IP itself, so an impd listener
// on it never sees the traffic.
export function parseServePorts(json: string): readonly number[] {
  try {
    // tailscale prints nothing when there is no serve config
    const text = json.trim() === '' ? '{}' : json;
    const status = ServeStatusSchema.parse(JSON.parse(text));

    return Object.keys(status.TCP ?? {})
      .map(Number)
      .filter((port) => Number.isInteger(port));
  } catch {
    return [];
  }
}

export async function readServePorts(run: CommandRunner = runCommand): Promise<readonly number[]> {
  try {
    const result = await run(['tailscale', 'serve', 'status', '--json']);

    return result.exitCode === 0 ? parseServePorts(result.stdout) : [];
  } catch {
    return [];
  }
}
