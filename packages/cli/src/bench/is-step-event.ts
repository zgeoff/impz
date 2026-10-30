import type { Imp, ImpChangeReason, ImpEvent } from '@impz/api';

// An imp's wake count and its last sleep move with each wake and sleep, so a
// change the arrange made, which can reach the bench after the timed step
// started, never matches the imp that the timed step's call returned.
export function isStepEvent(event: ImpEvent, reason: ImpChangeReason, stepped: Imp): boolean {
  return (
    event.ev === 'ImpChanged' &&
    event.reason === reason &&
    event.imp.id === stepped.id &&
    event.imp.resources?.wakeCount === stepped.resources?.wakeCount &&
    event.imp.sleptAt?.getTime() === stepped.sleptAt?.getTime()
  );
}
