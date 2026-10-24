import { instance } from './instance';
import type { CommandRunners } from './instance';
import { startTailnetMember } from './tailnet-member';
import type { TailscaleE2EKey } from './tailscale-key';

export interface TailscaleTailnet {
  readonly member: string;
}

// The test-side member of the test tailnet: a container, since this machine's
// own tailscaled stays on the tailnet it already has.
export async function startTailscaleTailnet(
  runners: CommandRunners,
  key: Readonly<TailscaleE2EKey>,
  container: string = instance.container,
): Promise<TailscaleTailnet> {
  const member = buildMemberName(container);

  await stopTailscaleTailnet(runners, container);

  await startTailnetMember(runners, {
    name: member,
    key: key.key,
    tailscaleArgs: `--advertise-tags=${key.tags}`,
  });

  return { member };
}

export async function stopTailscaleTailnet(
  runners: CommandRunners,
  container: string = instance.container,
): Promise<void> {
  await runners.runCommand(['docker', 'rm', '-f', buildMemberName(container)]);
}

function buildMemberName(container: string): string {
  return `${container}-ts-member`;
}
