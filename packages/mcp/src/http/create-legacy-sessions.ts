import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import type { CallRegistry } from '../create-call-registry';
import type { McpCaller } from '../create-caller-auth';

export interface LegacySession {
  readonly id: string;
  readonly key: string;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface SessionState extends LegacySession {
  readonly server: McpServer;
  readonly drain: () => Promise<void>;
  lastUsedAt: number;
  busy: number;
  readonly forgetEnds: () => void;
}

export interface SessionOwner extends McpCaller {
  readonly key: string;
  readonly ends: AbortSignal | null;
}

interface LegacySessionsOptions {
  readonly limits: {
    readonly perCaller: number;
    readonly total: number;
    readonly idleMs: number;
  };
  readonly now: () => number;

  // An SSE comment at this interval keeps an idle timeout from ending a long
  // call's stream.
  readonly keepaliveMs: number;

  readonly createServer: (
    owner: Readonly<SessionOwner>,
    calls: Readonly<CallRegistry>,
  ) => McpServer;
}

// The SDK's transport has no hook for a session limit, an idle sweep or the
// caller a session belongs to.
export function createLegacySessions(options: Readonly<LegacySessionsOptions>) {
  const sessions = new Map<string, SessionState>();

  const stopSession = async (session: Readonly<LegacySession>): Promise<void> => {
    const state = sessions.get(session.id);

    if (state === undefined) {
      return;
    }

    sessions.delete(session.id);
    state.forgetEnds();

    await state.server.close();
    await state.drain();
  };

  const makeRoom = (key: string): boolean => {
    const all = [...sessions.values()];
    const own = all.filter((state) => state.key === key);

    for (const [count, limit, pool] of [
      [own.length, options.limits.perCaller, own],
      [all.length, options.limits.total, all],
    ] as const) {
      if (count >= limit) {
        const evicted = findEvictable(pool);

        if (evicted === null) {
          return false;
        }

        void stopSession(evicted);
      }
    }

    return true;
  };

  return {
    open: async (owner: Readonly<SessionOwner>): Promise<LegacySession | null> => {
      if (owner.ends?.aborted === true || !makeRoom(owner.key)) {
        return null;
      }

      const id = crypto.randomUUID();
      const calls = createCallRegistry();
      const server = options.createServer(owner, calls);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        keepAliveMs: options.keepaliveMs,
      });

      const onEnd = (): void => {
        const state = sessions.get(id);

        if (state !== undefined) {
          void stopSession(state);
        }
      };

      owner.ends?.addEventListener('abort', onEnd, { once: true });

      const state: SessionState = {
        id,
        key: owner.key,
        transport,
        server,
        drain: calls.drain,
        lastUsedAt: options.now(),
        busy: 0,
        forgetEnds: () => owner.ends?.removeEventListener('abort', onEnd),
      };

      sessions.set(id, state);

      await server.connect(calls.createGate(transport));

      return state;
    },

    findOwned: (id: string, key: string): LegacySession | null => {
      const state = sessions.get(id);

      if (state?.key !== key) {
        return null;
      }

      state.lastUsedAt = options.now();

      return state;
    },

    track: (session: Readonly<LegacySession>, ended: Promise<void>): void => {
      const state = sessions.get(session.id);

      if (state === undefined) {
        return;
      }

      state.busy += 1;

      void (async () => {
        await ended;

        state.busy -= 1;
        state.lastUsedAt = options.now();
      })();
    },
    end: stopSession,

    sweep: (): void => {
      const cutoff = options.now() - options.limits.idleMs;

      for (const state of sessions.values()) {
        if (state.busy === 0 && state.lastUsedAt < cutoff) {
          void stopSession(state);
        }
      }
    },
    endAll: async (): Promise<void> => {
      await Promise.all([...sessions.values()].map((state) => stopSession(state)));
    },
  };
}

function findEvictable(candidates: readonly Readonly<SessionState>[]): LegacySession | null {
  const idle = candidates.filter((state) => state.busy === 0);

  return idle.toSorted((left, right) => left.lastUsedAt - right.lastUsedAt)[0] ?? null;
}
