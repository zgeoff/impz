import type { Scope } from '@impz/api';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ImpGuard } from './imp-guard';
import type { ToolClient } from './tools/tool-client';

export interface McpCaller {
  readonly client: ToolClient;
  readonly guard: ImpGuard;
  readonly scope: Scope;
}

interface CallHooks {
  readonly onCallStart: () => void;
  readonly onCallEnd: () => void;
}

interface CallerAuth extends CallHooks {
  readonly caller: McpCaller;
}

// The SDK hands a request's AuthInfo to its handler as the same object.
const callers = new WeakMap<AuthInfo, CallerAuth>();

// The SDK checks nothing in an AuthInfo: impd authenticates the request
// before the SDK sees it.
export function createCallerAuth(
  caller: Readonly<McpCaller>,
  hooks: Partial<CallHooks> = {},
): AuthInfo {
  const authInfo: AuthInfo = { token: '', clientId: 'imp', scopes: [caller.scope] };

  callers.set(authInfo, {
    caller,
    onCallStart: hooks.onCallStart ?? (() => {}),
    onCallEnd: hooks.onCallEnd ?? (() => {}),
  });

  return authInfo;
}

export function findCallerAuth(authInfo: AuthInfo | undefined): CallerAuth | null {
  return authInfo === undefined ? null : (callers.get(authInfo) ?? null);
}
