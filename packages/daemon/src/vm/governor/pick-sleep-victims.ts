export interface VictimCandidate {
  readonly id: string;
  readonly ramMib: number;
  readonly lastActiveAt: number;
  readonly held: boolean;
  readonly busy: boolean;
}

export interface SleepVictims<Candidate extends VictimCandidate> {
  readonly victims: Candidate[];
  readonly enough: boolean;
}

export function pickSleepVictims<Candidate extends VictimCandidate>(
  candidates: readonly Candidate[],
  needMib: number,
): SleepVictims<Candidate> {
  if (needMib <= 0) {
    return { victims: [], enough: true };
  }

  const eligible = candidates
    .filter((candidate) => !candidate.held && !candidate.busy)
    .toSorted((left, right) => left.lastActiveAt - right.lastActiveAt);

  const victims: Candidate[] = [];
  let freed = 0;

  for (const candidate of eligible) {
    victims.push(candidate);

    freed += candidate.ramMib;

    if (freed >= needMib) {
      return { victims, enough: true };
    }
  }

  return { victims, enough: false };
}
