export function isAgentSessionState(state: string): state is 'running' | 'exited' {
  return state === 'running' || state === 'exited';
}
