import type { ImpsConfig } from '../imps/imps-config';
import type { HttpsConfig } from './https/https-config';
import type { TailnetNamesConfig } from './tailnet-names/tailnet-names-config';

export interface NetworkConfig extends ImpsConfig {
  readonly apiPort: number;
  readonly brokerPort: number;
  readonly egressDnsPort: number;
  readonly egressDeny: readonly string[];
  readonly https: HttpsConfig | null;
  readonly tailnetNames: TailnetNamesConfig | null;
}
