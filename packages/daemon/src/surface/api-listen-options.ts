import type { Config } from '../config';
import { MOVE_PART_BYTES } from '../imp-ops/moves/move-parts';

// Bun refuses a larger body before any route sees it, so the slack leaves the
// build route room to answer 413 itself.
const BODY_SLACK_BYTES = 1024 ** 2;

// Elysia's own default: Bun ends a request idle this long unless its route
// lifts the limit with `server.timeout(request, 0)`.
const API_IDLE_TIMEOUT_S = 30;

export function buildApiListenOptions(
  config: Readonly<Pick<Config, 'apiPort' | 'buildContextMaxBytes'>>,
  idleTimeout: number = API_IDLE_TIMEOUT_S,
  hostname?: string,
) {
  return {
    port: config.apiPort,
    maxRequestBodySize: Math.max(config.buildContextMaxBytes, MOVE_PART_BYTES) + BODY_SLACK_BYTES,
    idleTimeout,
    ...(hostname !== undefined && { hostname }),
  };
}
