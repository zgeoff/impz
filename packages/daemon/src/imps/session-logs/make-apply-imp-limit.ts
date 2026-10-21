import type { SessionLogState } from './create-session-log-state';
import { countLogBytes } from './generation-log';
import { readImpMetas, removeGenerationDir } from './session-log-files';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

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

  const applyImpLimit = async (imp: SessionLogImp, life: number): Promise<void> => {
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
      .toSorted((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));

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
        .toSorted(
          (left, right) => countLogBytes(right.log.readMeta()) - countLogBytes(left.log.readMeta()),
        );

      if (largest === undefined) {
        return;
      }

      const isRemoved = await largest.log.removeOldestSegment();

      if (ctx.isForgotten(imp.id, life)) {
        return;
      }

      if (!isRemoved) {
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
