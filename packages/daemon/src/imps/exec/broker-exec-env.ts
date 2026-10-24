export type BrokerExecEnv =
  | { readonly kind: 'ready'; readonly env: readonly string[] }
  | { readonly kind: 'ungranted' }
  | { readonly kind: 'untrusted'; readonly detail: string };

export const PROXY_VARIABLE = 'HTTPS_PROXY';
