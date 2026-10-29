export function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get('upgrade') ?? '')
    .split(',')
    .some((protocol) => protocol.trim().toLowerCase().split('/')[0] === 'websocket');
}
