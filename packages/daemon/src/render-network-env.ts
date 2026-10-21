import { NetworkEnvSchema } from './config';
import { formatSubnet, parseSubnet } from './host-net/net/addressing';

export function renderNetworkEnv(env: Readonly<Record<string, string | undefined>>): string {
  // an empty variable (`IMP_SUBNET=` in an env file) means unset
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = NetworkEnvSchema.parse(present);

  return [
    `IMP_SUBNET=${formatSubnet(parseSubnet(parsed.IMP_SUBNET))}`,
    `IMP_BROKER_PORT=${String(parsed.IMP_BROKER_PORT)}`,
    `IMP_EGRESS_DNS_PORT=${String(parsed.IMP_EGRESS_DNS_PORT)}`,
    '',
  ].join('\n');
}
