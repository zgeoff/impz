import { Resolver } from 'node:dns/promises';
import type { AddressAnswer } from './egress-sets';

export function createExactResolver(
  servers: readonly string[],
  ipv6: boolean,
): (name: string) => Promise<readonly AddressAnswer[]> {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });

  resolver.setServers([...servers]);

  const resolveAaaa = async (name: string): Promise<readonly AddressAnswer[]> => {
    try {
      const records = await resolver.resolve6(name, { ttl: true });

      return records.map((record) => ({ address: record.address, ttlS: record.ttl }));
    } catch {
      return [];
    }
  };

  return async (name) => {
    const records = await resolver.resolve4(name, { ttl: true });

    const answers = records.map((record) => ({ address: record.address, ttlS: record.ttl }));

    if (!ipv6) {
      return answers;
    }

    const answers6 = await resolveAaaa(name);

    return [...answers, ...answers6];
  };
}
