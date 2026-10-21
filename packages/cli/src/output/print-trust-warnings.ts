import type { CommandIO } from '../cli/command-io';
import type { ImpClient } from '../config/create-imp-client';

export async function printTrustWarnings(
  client: ImpClient,
  io: CommandIO,
  name: string,
): Promise<void> {
  const warnings = await client.networks.warnings({ name });

  for (const warning of warnings) {
    io.printError(`warning: ${warning}`);
  }
}
