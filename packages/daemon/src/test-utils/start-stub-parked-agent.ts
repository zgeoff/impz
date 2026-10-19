import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

// The agent of a template's guest on `vsockSocket`: parked (stage template)
// until a claim, then booted on as the claimed imp with its boot's steps; a
// minute old, so old enough to snapshot. It closes when the test ends.
export function startStubParkedAgent(vsockSocket: string) {
  const claimed = { isClaimed: false };

  return startStubAgent(vsockSocket, (socket, request) => {
    const isClaim = JSON.stringify(decodeJsonPayload(request)).includes('"op":"claim"');

    claimed.isClaimed ||= isClaim;

    const boot = claimed.isClaimed
      ? {
          boot_steps: [
            { name: 'claim', ms: 3 },
            { name: 'mount', ms: 40 },
            { name: 'ready', ms: 2 },
          ],
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
