import type { NetworkConfig } from '../network/network-config';
import type { TailnetRule } from './auth/create-tailnet-identities';
import type { PublicMcpConfig } from './oauth/public-mcp-config';

export interface IdentityConfig extends NetworkConfig {
  readonly tailnetRules: readonly TailnetRule[] | null;
  readonly publicMcp: PublicMcpConfig | null;
}
