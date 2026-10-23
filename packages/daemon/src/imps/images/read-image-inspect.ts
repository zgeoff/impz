import type { EngineRun } from './build-engine';
import { PIN_INSPECT_FORMAT, PinInspectSchema } from './image-pin';
import type { PinInspect } from './image-pin';

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
