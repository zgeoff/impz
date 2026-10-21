import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

export function startStubParkedAgent(vsockSocket: string) {
  const claimed = { isClaimed: false };

  return startStubAgent(vsockSocket, (socket, request) => {
    const isClaim = JSON.stringify(decodeJsonPayload(request)).includes('"op":"claim"');

    claimed.isClaimed ||= isClaim;

    const boot = claimed.isClaimed
      ? {
          // oxlint-disable zgeoff/no-abbreviated-names -- `ms` is BootStep's field in proto/
          boot_steps: [
            { name: 'claim', ms: 3 },
            { name: 'mount', ms: 40 },
            { name: 'ready', ms: 2 },
          ],
          // oxlint-enable zgeoff/no-abbreviated-names
        }
      : { stage: 'template' };

    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        version: '0.1.0',
        uptime_ms: 60_000,
        ...boot,
      }),
    );
  });
}
