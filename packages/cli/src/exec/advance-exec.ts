import type { ExecOutcome } from '@impz/client';
import { match } from 'ts-pattern';
import { formatUnauthorized } from '../cli/run-action';
import { toSignalExitCode } from '../cli/to-signal-exit-code';
import type { CliConfig } from '../config/cli-config';

const TAKEN_OVER_CODE = 254;
const REATTACH_MAX_DELAY_MS = 8000;

export interface ExecMachine {
  readonly imp: string;
  readonly session: string | null;
  readonly config: CliConfig;
  readonly windowMs: number;
  readonly firstDelayMs: number;
  readonly started: boolean;
  readonly reattachUntil: number | null;
  readonly tries: number;
}

export type ExecEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'outcome'; readonly outcome: ExecOutcome; readonly now: number }
  | { readonly kind: 'taken_over' };

export type ExecStep =
  | { readonly kind: 'attached'; readonly wasAway: boolean }
  | { readonly kind: 'stop'; readonly code: number; readonly message: string | null }
  | { readonly kind: 'reattach'; readonly delayMs: number; readonly isFirst: boolean };

export interface ExecTransition {
  readonly machine: ExecMachine;
  readonly step: ExecStep;
}

export function advanceExec(machine: Readonly<ExecMachine>, event: ExecEvent): ExecTransition {
  return match<ExecEvent, ExecTransition>(event)
    .with({ kind: 'started' }, () => ({
      machine: { ...machine, started: true, reattachUntil: null, tries: 0 },
      step: { kind: 'attached', wasAway: machine.reattachUntil !== null },
    }))
    .with({ kind: 'taken_over' }, () => ({
      machine,
      step: {
        kind: 'stop',
        code: TAKEN_OVER_CODE,
        message: `another client attached to ${formatSession(machine)}`,
      },
    }))
    .with({ kind: 'outcome' }, (ended) => {
      if (!canReattach(machine, ended.outcome, ended.now)) {
        const result = buildOutcomeResult(ended.outcome, machine.config, formatSession(machine));

        return { machine, step: { kind: 'stop', ...result } };
      }

      const tries = machine.tries + 1;
      const delayMs = Math.min(machine.firstDelayMs * 2 ** (tries - 1), REATTACH_MAX_DELAY_MS);
      const reattachUntil = machine.reattachUntil ?? ended.now + machine.windowMs;

      return {
        machine: { ...machine, reattachUntil, tries },
        step: { kind: 'reattach', delayMs, isFirst: machine.reattachUntil === null },
      };
    })
    .exhaustive();
}

export function formatSession(machine: Readonly<Pick<ExecMachine, 'imp' | 'session'>>): string {
  const session = machine.session ?? '';

  return `session ${session} (impz attach ${machine.imp} ${session})`;
}

function canReattach(machine: Readonly<ExecMachine>, outcome: ExecOutcome, now: number): boolean {
  if (machine.session === null || !machine.started) {
    return false;
  }

  if (machine.reattachUntil !== null && now >= machine.reattachUntil) {
    return false;
  }

  if (outcome.kind === 'detached') {
    return outcome.reason === 'lost' || outcome.reason === 'slow';
  }

  return outcome.kind === 'closed' || outcome.kind === 'unreachable';
}

interface OutcomeResult {
  readonly code: number;
  readonly message: string | null;
}

const IMP_FAILED_CODE = 255;

const INNER_DOWN_HINT =
  ' (the container in the imp starts again on its own; impz stop and impz start, or impz restore, bring it back)';

function buildOutcomeResult(
  outcome: ExecOutcome,
  config: CliConfig,
  session: string,
): OutcomeResult {
  return match<ExecOutcome, OutcomeResult>(outcome)
    .with({ kind: 'exit' }, (exit) => {
      if (exit.code !== null) {
        return { code: exit.code, message: null };
      }

      const code = exit.signal === null ? null : toSignalExitCode(exit.signal);

      if (code === null) {
        return {
          code: IMP_FAILED_CODE,
          message: 'impd reported an exit with no code and no known signal',
        };
      }

      return { code, message: null };
    })
    .with({ kind: 'failed' }, (failed) => {
      const prefix = failed.code === null ? '' : `${failed.code}: `;
      const code = pickFailedCode(failed.code);
      const hint = failed.code === 'INNER_DOWN' ? INNER_DOWN_HINT : '';

      return { code, message: `${prefix}${failed.message}${hint}` };
    })
    .with({ kind: 'detached' }, (detached) => {
      if (detached.reason === 'taken_over') {
        return { code: TAKEN_OVER_CODE, message: `another client attached to ${session}` };
      }

      const why =
        detached.reason === 'slow' ? 'this terminal fell behind' : 'the connection was lost';

      return { code: IMP_FAILED_CODE, message: `detached, ${why}: ${session}` };
    })
    .with({ kind: 'unauthorized' }, () => ({
      code: IMP_FAILED_CODE,
      message: formatUnauthorized(config),
    }))
    .with({ kind: 'unreachable' }, (unreachable) => ({
      code: IMP_FAILED_CODE,
      message: `cannot reach impd at ${config.url} (${unreachable.detail})`,
    }))
    .with({ kind: 'closed' }, (closed) => ({
      code: IMP_FAILED_CODE,
      message: `exec connection closed (${closed.reason})`,
    }))
    .with({ kind: 'bad_message' }, (bad) => ({
      code: IMP_FAILED_CODE,
      message: `bad message from impd: ${bad.detail}`,
    }))
    .with({ kind: 'local_error' }, (local) => buildLocalErrorResult(local.error))
    .exhaustive();
}

// exit codes follow ssh and the shells: 127 for a command that could not
// start, 141 for a broken pipe, 255 for a failure on the remote side
const PRECONDITION_FAILED_CODE = 1;
const EXEC_FAILED_CODE = 127;

function pickFailedCode(code: string | null): number {
  if (code === 'EXEC_FAILED') {
    return EXEC_FAILED_CODE;
  }

  return code === 'PRECONDITION_FAILED' ? PRECONDITION_FAILED_CODE : IMP_FAILED_CODE;
}

const BROKEN_PIPE_CODE = 141;

// a reader such as `head` that went away is quiet, as with a local command
function buildLocalErrorResult(error: unknown): OutcomeResult {
  if (isBrokenPipe(error)) {
    return { code: BROKEN_PIPE_CODE, message: null };
  }

  const message = error instanceof Error ? error.message : String(error);

  return { code: IMP_FAILED_CODE, message };
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE';
}
