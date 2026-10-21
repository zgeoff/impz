import {
  FRAME_TYPES,
  PingSchema,
  RequestSchema,
  decodeMessageFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

export function startStubParkedAgent(vsockSocket: string) {
  const claimed = { isClaimed: false };

  return startStubAgent(vsockSocket, (socket, request) => {
    const isClaim = decodeMessageFrame(RequestSchema, request).op === 'claim';

    claimed.isClaimed ||= isClaim;

    const boot = claimed.isClaimed
      ? {
          bootSteps: [
            // oxlint-disable zgeoff/no-abbreviated-names -- `ms` is BootStep's field in proto/
            { name: 'claim', ms: 3 },
            { name: 'mount', ms: 40 },
            { name: 'ready', ms: 2 },
            // oxlint-enable zgeoff/no-abbreviated-names
          ],
        }
      : { stage: 'template' };

    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
        ok: true,
        version: '0.1.0',
        uptimeMs: 60_000,
        ...boot,
      }),
    );
  });
}
