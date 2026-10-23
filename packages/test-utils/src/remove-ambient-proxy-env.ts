const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

export function removeAmbientProxyEnv(): void {
  for (const key of PROXY_VARIABLES) {
    // an empty value, not a delete: Bun 1.4.2's fetch keeps a proxy variable
    // that the process deletes after startup
    process.env[key] = '';
  }
}
