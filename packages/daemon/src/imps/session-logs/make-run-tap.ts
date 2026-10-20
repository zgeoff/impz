import { isDiskFullError } from '../../surface/api-errors';
import type { ExecStream } from '../../vm/agent-client/exec-stream';
import type { SessionLogState } from './create-session-log-state';
import { getGenerationBounds } from './generation-log';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp } from './session-log-service';

// what a tap's copy reads besides the state
interface RunTapDeps {
  readonly log: (message: string) => void;
  readonly applyImpLimit: (imp: SessionLogImp, life: number) => Promise<void>;
}

export function makeRunTap(
  ctx: SessionLogState,
  deps: RunTapDeps,
): (imp: SessionLogImp, entry: LiveLog, tap: Readonly<ExecStream>, life: number) => Promise<void> {
  const stopForFullDisk = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
    deps.log(
      `impd: imp ${imp.id}: stopped the log of session ${entry.session}: the disk reached its reserve`,
    );

    ctx.send({ type: 'log.stop', entry });

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
          const unchecked = ctx.readUncheckedBytes(imp.id) + event.data.byteLength;

          if (start !== newest || unchecked >= ctx.limitCheckBytes) {
            newest = start;

            ctx.send({ type: 'bytes.clear', impId: imp.id });

            await deps.applyImpLimit(imp, life);
          } else {
            ctx.send({ type: 'bytes.add', impId: imp.id, bytes: event.data.byteLength });
          }
        } else if (event.type === 'exit') {
          const end = getGenerationBounds(entry.log.readMeta()).logEnd;

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
      ctx.send({ type: 'tap.end', key: entry.key, tap });
    }
  };

  return runTap;
}

function toExitCode(code: number, signal: number): number | null {
  return signal === 0 ? code : null;
}
