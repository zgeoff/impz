import type { ExecStream } from '../agent-client/exec-stream';
import { isDiskFullError } from '../api-errors';
import type { LiveLog, SessionLogState } from './create-session-log-state';
import { readGenerationBounds } from './generation-log';
import type { SessionLogImp } from './session-log-service';

// what a tap's copy reads besides the state
interface RunTapDeps {
  readonly log: (message: string) => void;
  readonly applyImpLimit: (imp: SessionLogImp, life: number) => Promise<void>;
}

// the runTap of createSessionLogs
export function makeRunTap(
  ctx: SessionLogState,
  deps: RunTapDeps,
): (imp: SessionLogImp, entry: LiveLog, tap: Readonly<ExecStream>, life: number) => Promise<void> {
  const stopForFullDisk = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
    deps.log(
      `impd: imp ${imp.id}: stopped the log of session ${entry.session}: the disk reached its reserve`,
    );

    if (ctx.isCurrent(entry)) {
      ctx.dropped.add(entry.key);
      ctx.stopTap(entry.key);
    }

    await entry.log.stop('disk_full');
  };

  // copies the tap into the log until it ends: an exit ends the log; a
  // detach or a dropped connection leaves it for the next look to tap again
  const runTap = async (
    imp: SessionLogImp,
    entry: LiveLog,
    tap: Readonly<ExecStream>,
    life: number,
  ) => {
    // each new segment is a new start: a log at its own bound adds one as it
    // drops one, so its count stays the same; growth within a segment counts
    // toward the next check too
    let newest = entry.log.readMeta().segments.at(-1)?.start;

    try {
      for await (const event of tap.events()) {
        if (event.type === 'stdout') {
          await entry.log.append(event.data);

          const start = entry.log.readMeta().segments.at(-1)?.start;
          const unchecked = (ctx.uncheckedBytes.get(imp.id) ?? 0) + event.data.byteLength;

          if (start !== newest || unchecked >= ctx.limitCheckBytes) {
            newest = start;

            ctx.uncheckedBytes.set(imp.id, 0);

            await deps.applyImpLimit(imp, life);
          } else {
            ctx.uncheckedBytes.set(imp.id, unchecked);
          }
        } else if (event.type === 'exit') {
          const end = readGenerationBounds(entry.log.readMeta()).logEnd;

          await ctx.writeEnd(entry, { end, exitCode: toExitCode(event.code, event.signal) });
        }
      }
    } catch (error) {
      if (isDiskFullError(error)) {
        await stopForFullDisk(imp, entry);
      } else {
        ctx.printError(imp, error);
      }
    } finally {
      if (ctx.taps.get(entry.key) === tap) {
        ctx.stopTap(entry.key);
      }
    }
  };

  return runTap;
}

function toExitCode(code: number, signal: number): number | null {
  return signal === 0 ? code : null;
}
