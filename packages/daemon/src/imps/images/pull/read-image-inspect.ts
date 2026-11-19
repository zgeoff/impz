import type { EngineRun } from '../build/build-engine';
import { PIN_INSPECT_FORMAT, PinInspectSchema } from './pick-repo-digest';
import type { PinInspect } from './pick-repo-digest';

export async function readImageInspect(
  run: EngineRun,
  ref: string,
  signal: AbortSignal,
): Promise<PinInspect | null> {
  const inspected = await run(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
    signal,
  );

  signal.throwIfAborted();

  if (inspected.exitCode !== 0) {
    return null;
  }

  return PinInspectSchema.parse(JSON.parse(inspected.stdout));
}
