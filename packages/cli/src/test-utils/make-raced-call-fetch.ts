type SendRequest = (request: Request) => Promise<Response>;

// Another caller's work can land after a client reads impd and before its
// next call arrives; the race hook runs in that gap, once, ahead of the first
// call on the path.
export function makeRacedCallFetch(
  send: SendRequest,
  racedPath: string,
  onRace: () => Promise<unknown>,
): SendRequest {
  let isRaced = false;

  return async (request) => {
    if (!isRaced && new URL(request.url).pathname === racedPath) {
      isRaced = true;

      await onRace();
    }

    return send(request);
  };
}
