// Bun's WebSocket takes headers, so the bearer token stays out of the URL
export function openBunWebSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
): WebSocket {
  return new WebSocket(url, { headers: { ...headers } });
}
