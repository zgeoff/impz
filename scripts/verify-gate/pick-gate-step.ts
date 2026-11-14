import * as z from 'zod';

const refSchema = z.object({ ref: z.string().min(1) });

const pullRequestSchema = z.object({
  body: z.string().nullable(),
  base: refSchema,
  head: refSchema,
  user: z.object({ login: z.string(), type: z.string() }),
});

const pullRequestEventSchema = z.object({ pull_request: pullRequestSchema });

// The bots whose pull requests carry no verify report, each by the app's login and the branch it
// opens them from: release-please's one release pull request, as release-please-config.json names
// the component, and each Renovate branch.
const SKIPPED_BOTS = [
  {
    login: 'zgeoff-release-bot[bot]',
    isBranch: (ref: string) => ref === 'release-please--branches--main--components--impz',
    reason: 'a release pull request carries no verify report',
  },
  {
    login: 'zgeoff-renovate[bot]',
    isBranch: (ref: string) => ref.startsWith('renovate/'),
    reason: 'a renovate pull request carries no verify report',
  },
] as const;

export type GateStep =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'gate'; readonly baseRef: string; readonly body: string }
  | { readonly kind: 'refused'; readonly message: string };

// Release and dependency pull requests merge on green CI, and nobody runs a journey on them. Only
// the bot's own login skips, so a person's branch of the same name still meets the gate.
export function pickGateStep(event: unknown): GateStep {
  const parsed = pullRequestEventSchema.safeParse(event);

  if (!parsed.success) {
    return {
      kind: 'refused',
      message: 'the event holds no pull request; run this on pull_request',
    };
  }

  const pullRequest = parsed.data.pull_request;

  const bot = SKIPPED_BOTS.find(
    (candidate) =>
      pullRequest.user.type === 'Bot' &&
      pullRequest.user.login === candidate.login &&
      candidate.isBranch(pullRequest.head.ref),
  );

  if (bot !== undefined) {
    return { kind: 'skip', reason: bot.reason };
  }

  return { kind: 'gate', baseRef: pullRequest.base.ref, body: pullRequest.body ?? '' };
}
