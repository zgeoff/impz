import { match } from 'ts-pattern';
import { instance } from './instance';
import type { CommandResult, CommandRunners } from './instance';
import { startTailnetMember } from './tailnet-member';
import type { TailscaleE2EKey } from './tailscale-key';

export interface TailscaleTailnet {
  readonly member: string;
}

export const MEMBER_OWNER_LABEL = 'impz.e2e.tailnet-member';

// The test-side member of the test tailnet: a container, since this machine's
// own tailscaled stays on the tailnet it already has.
export async function startTailscaleTailnet(
  runners: CommandRunners,
  key: Readonly<TailscaleE2EKey>,
): Promise<TailscaleTailnet> {
  const member = buildMemberName(instance.container);

  await stopTailscaleTailnet(runners);

  await startTailnetMember(runners, {
    name: member,
    key: key.key,
    tailscaleArgs: `--advertise-tags=${key.tags}`,
    labels: { [MEMBER_OWNER_LABEL]: instance.container },
  });

  return { member };
}

// The member's name comes from the instance's, so another container can hold
// it; only the owner label marks one this harness started.
export async function stopTailscaleTailnet(runners: CommandRunners): Promise<void> {
  const member = buildMemberName(instance.container);

  const inspected = await runners.runCommand([
    'docker',
    'inspect',
    '--format',
    `{{index .Config.Labels "${MEMBER_OWNER_LABEL}"}}`,
    member,
  ]);

  const removal = pickMemberRemoval(inspected, instance.container);

  await match(removal)
    .with({ kind: 'absent' }, () => Promise.resolve())
    .with({ kind: 'owned' }, async () => {
      await runners.runChecked(['docker', 'rm', '-f', member]);
    })
    .with({ kind: 'foreign' }, () =>
      Promise.reject(
        new Error(
          `${member} is not a tailnet member this harness started for ${instance.container}, so it stays: remove it or set another IMP_DEV_NAME`,
        ),
      ),
    )
    .with({ kind: 'unknown' }, (unknown) =>
      Promise.reject(new Error(`docker inspect ${member} failed: ${unknown.reason}`)),
    )
    .exhaustive();
}

type MemberRemoval =
  | { readonly kind: 'absent' }
  | { readonly kind: 'owned' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unknown'; readonly reason: string };

function pickMemberRemoval(inspected: Readonly<CommandResult>, owner: string): MemberRemoval {
  if (inspected.exitCode !== 0) {
    return /no such object/iv.test(inspected.stderr)
      ? { kind: 'absent' }
      : { kind: 'unknown', reason: inspected.stderr.trim() };
  }

  return inspected.stdout.trim() === owner ? { kind: 'owned' } : { kind: 'foreign' };
}

function buildMemberName(container: string): string {
  return `${container}-ts-member`;
}
