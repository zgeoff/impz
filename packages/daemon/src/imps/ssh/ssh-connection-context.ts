// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 moves the caller into platform
import type { AuditActor } from '../../identity/auth/caller';
import type { ImpRecord } from '../../platform/db/imps';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import type { AgentExecRequest, ExecStream } from '../../vm/agent-client/exec-stream';
import type { ImpRuntime } from '../imps/imp-runtime';
import type { AgentForwarding } from './agent-forwarding';

export interface SshBackend extends Pick<
  ImpRuntime,
  'requireRunning' | 'tracker' | 'openDial' | 'openListener' | 'openAccept' | 'recordActivity'
> {
  readonly readImp: (name: string) => Promise<ImpRecord | undefined>;
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature: AgentFeature | undefined,
    actor: AuditActor,
  ) => Promise<ExecStream>;
}

export interface SshConnectionContext {
  readonly impName: string;
  readonly actor: AuditActor;
  readonly backend: SshBackend;
  readonly awake: Promise<void>;
  readonly sshEnv: readonly string[];
  readonly agent: AgentForwarding;
  readonly log: (message: string) => void;
}
