import * as z from 'zod';

const NetworksSchema = z.record(z.string(), z.unknown());

// The networks in docker's NetworkSettings.Networks, sorted as jq's keys gave them.
export function parseNetworkNames(json: string): readonly string[] {
  const networks: unknown = JSON.parse(json);

  return Object.keys(NetworksSchema.parse(networks)).toSorted();
}
