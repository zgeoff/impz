import * as z from 'zod';

const NetworksSchema = z.record(z.string(), z.unknown());

export function parseNetworkNames(json: string): readonly string[] {
  const networks: unknown = JSON.parse(json);

  return Object.keys(NetworksSchema.parse(networks)).toSorted();
}
