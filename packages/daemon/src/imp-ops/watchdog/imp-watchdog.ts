import type { ImpClock, ImpDisk, ImpHost, ImpVms } from '../../imps/imps/imp-context';
import type { ImpLock } from '../../imps/imps/imp-lock';
import type { ImpVmOps } from '../../imps/imps/imp-vm-ops';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createAgentWatchdog } from '../../vm/watchdog/agent-watchdog';
import type { AgentWatchdog } from '../../vm/watchdog/agent-watchdog';
import { writeWatchdogSnapshot } from './write-watchdog-snapshot';

const CONFIRM_MS = 5000;
const RECHECK_MS = 1000;

export function createImpWatchdog(
  context: ImpHost & ImpClock & ImpVms & ImpDisk,
  lock: ImpLock,
  ops: ImpVmOps,
): AgentWatchdog {
  return createAgentWatchdog({
    timeoutMs: context.config.watchdogTimeoutS * 1000,
    action: context.config.watchdogAction,
    now: context.now,
    confirmSilent: async (imp) =>
      !(await context.vms.probeAgentReady(context.findPaths(imp.id), CONFIRM_MS)),
    recover: async (imp, action) => {
      const result = await lock.tryWithImpId(imp.id, async (fresh) => {
        if (fresh?.state !== 'running' || fresh.pid !== imp.pid) {
          return false;
        }

        const paths = context.findPaths(fresh.id);

        const answered = await context.vms.probeAgentReady(paths, RECHECK_MS);

        if (answered) {
          getImpdLogger('imps')
            .with({ imp: fresh.name })
            .info('its agent answers again; the watchdog stands down');

          return false;
        }

        if (action === 'snapshot') {
          await writeWatchdogSnapshot(context, ops, fresh);
        }

        try {
          await ops.startFreshImpVm(
            fresh,
            'the watchdog restarted it: its agent stopped answering',
          );

          getImpdLogger('imps').with({ imp: fresh.name }).info('the watchdog booted it cold');
        } catch (error) {
          getImpdLogger('imps')
            .with({ imp: fresh.name })
            .warning('the watchdog restart failed: {error}', { error: getErrorMessage(error) });
        }

        return true;
      });

      return result.ran && result.value;
    },
  });
}
