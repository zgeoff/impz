import { AgentError } from './agent-connection';
import { isAgentError } from './is-agent-error';

interface Feature {
  readonly since: readonly [number, number];
  readonly missing: string;
  readonly strict?: true;
}

const FEATURES = {
  sessions: { since: [0, 2], missing: 'no sessions' },
  ssh: { since: [0, 3], missing: 'no port forwarding or SFTP' },
  'agent-forwarding': { since: [0, 4], missing: 'no ssh-agent forwarding' },
  grow: { since: [0, 5], missing: 'no online disk grow' },
  'unix-dial-as-user': { since: [0, 6], missing: 'no safe unix socket forwarding' },
  cp: { since: [0, 7], missing: 'no imp cp' },
  'reverse-forward': { since: [0, 9], missing: 'no reverse forwards' },
  services: { since: [0, 10], missing: 'no services API' },

  // Strict, because an agent that ignored the field would run the command in the container as
  // root.
  'outer-exec': {
    since: [0, 16],
    missing: 'no exec --agent',
    strict: true,
  },

  // An older agent fixes the inner container's limit at its boot size, so its user processes are
  // OOM-killed in memory the guest grew into.
  'elastic-memory': {
    since: [0, 17],
    missing: 'no elastic memory, so its programs could not use a grow',
    strict: true,
  },
  'session-log': { since: [0, 18], missing: 'no session logs' },
  files: { since: [0, 19], missing: 'no read-only files' },

  // Strict, because an older agent ignores the field and runs the command with CAP_SYS_ADMIN.
  'drop-sys-admin': {
    since: [0, 20],
    missing: 'no exec without CAP_SYS_ADMIN',
    strict: true,
  },
} as const satisfies Record<string, Feature>;

export type AgentFeature = keyof typeof FEATURES;

export function buildAgentOutdatedError(feature: AgentFeature): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    `the imp's agent has ${FEATURES[feature].missing} yet; stop and start the imp to update it`,
  );
}

export function buildAgentUnknownError(feature: AgentFeature): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    `impd has no record of the imp's agent version, so it takes it to have ${FEATURES[feature].missing}; stop and start the imp to record it`,
  );
}

export function hasFeature(agentVersion: string | undefined, feature: AgentFeature): boolean {
  const known: Feature = FEATURES[feature];
  const [major, minor] = (agentVersion ?? '').split('.').map(Number);
  const [sinceMajor, sinceMinor] = known.since;

  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return known.strict !== true;
  }

  return major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
}

export function handleUnknownOp(feature: AgentFeature): (error: unknown) => never {
  return (error) => {
    if (isAgentError(error, 'UNKNOWN_OP')) {
      throw buildAgentOutdatedError(feature);
    }

    throw error;
  };
}
