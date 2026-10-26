const PROXY_PREFIX = 'imp-docker-proxy: ';
const ENGINE_FAILURE_PREFIX = `${PROXY_PREFIX}the engine call failed: `;

export function formatRefusal(reason: string): string {
  return `${PROXY_PREFIX}${reason}`;
}

export function formatEngineFailure(message: string): string {
  return `${ENGINE_FAILURE_PREFIX}${message}`;
}
