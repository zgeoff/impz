type SendRequest = (request: Request) => Promise<Response>;

// A timeout or a reset after the send loses the answer to a call impd has
// carried out, so the caller never learns it; the lost hook runs in that gap.
export function makeLostAnswerFetch(
  send: SendRequest,
  lostPath: string,
  error: Error,
  onLost: () => Promise<unknown> = () => Promise.resolve(),
): SendRequest {
  let isLost = false;

  return async (request) => {
    const response = await send(request);

    if (!isLost && new URL(request.url).pathname === lostPath) {
      isLost = true;

      await onLost();

      throw error;
    }

    return response;
  };
}
