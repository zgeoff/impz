import { buildGuestFailure } from './build-guest-failure';

export function formatGuestFailure(error: unknown): string {
  const failure = buildGuestFailure(error);

  return failure.code === undefined ? failure.message : `${failure.code}: ${failure.message}`;
}
