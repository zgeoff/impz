import type { SessionLogState } from './create-session-log-state';
import { countLogBytes } from './generation-log';
import { readImpMetas, removeGenerationDir } from './session-log-files';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

// what an imp's limit reads besides the state
interface ImpLimitDeps {
  readonly limits: SessionLogLimits;
  readonly log: (message: string) => void;
}

export function makeApplyImpLimit(
  ctx: SessionLogState,
  deps: ImpLimitDeps,
): (imp: SessionLogImp, life: number) => Promise<void> {
  const stopForLimit = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
    deps.log(
      `impd: imp ${imp.id}: stopped the log of session ${entry.session}: its logs reached IMP_SESSION_LOG_IMP_MAX_MIB`,
    );

    ctx.send({ type: 'log.stop', entry });

    await entry.log.stop('imp_limit');
  };

  // ended logs go oldest first; then the largest live log gives up its
  // oldest segment; when every live log is down to one, the newest still
  // written stops, and stays as it is until its generation ends
  const applyImpLimit = async (imp: SessionLogImp, life: number): Promise<void> => {
    // work from an earlier life of the imp: the logs on disk are a later one's
    if (ctx.isForgotten(imp.id, life)) {
      return;
    }

    const countImpBytes = () =>
      readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id)).reduce(
        (sum, meta) => sum + countLogBytes(meta),
        0,
      );

    const metas = readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id));

    const ended = metas
      .filter((meta) => meta.state === 'ended')
      .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

    let total = countImpBytes();

    for (const meta of ended) {
      if (total <= deps.limits.impMaxBytes) {
        return;
      }

      removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);

      total -= countLogBytes(meta);
    }

    while (total > deps.limits.impMaxBytes) {
      const [largest] = ctx
        .listLive(imp.id)
        .toSorted((a, b) => countLogBytes(b.log.readMeta()) - countLogBytes(a.log.readMeta()));

      if (largest === undefined) {
        return;
      }

      const isRemoved = await largest.log.removeOldestSegment();

      // destroyed meanwhile: the logs listed now are a later life's
      if (ctx.isForgotten(imp.id, life)) {
        return;
      }

      if (!isRemoved) {
        // the newest by start, and of two that started at once the later one
        const newest = ctx
          .listLive(imp.id)
          .filter((entry) => !ctx.isDropped(entry.key))
          .reduce<LiveLog | undefined>(
            (found, entry) =>
              found === undefined ||
              entry.log.readMeta().startedAt >= found.log.readMeta().startedAt
                ? entry
                : found,
            undefined,
          );

        if (newest !== undefined) {
          await stopForLimit(imp, newest);
        }

        return;
      }

      total = countImpBytes();
    }
  };

  return applyImpLimit;
}
