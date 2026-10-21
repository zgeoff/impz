export function buildImpdSocketUrl(port: string, path: '/exec' | '/tunnel', query: string): string {
  return `ws://127.0.0.1:${port}${path}?${query}`;
}

export async function tryExecSocket(
  port: string,
  query: string,
  name = 'dev',
  headers: Readonly<Record<string, string>> = {},
) {
  const socket = new WebSocket(buildImpdSocketUrl(port, '/exec', query), { headers });

  const outcome = Promise.withResolvers<string>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name, argv: ['true'], tty: false }));
  });

  socket.addEventListener('message', (event) => {
    outcome.resolve(String(event.data));
  });

  socket.addEventListener('error', () => {
    outcome.resolve('rejected');
  });

  // a refused upgrade fires error before close, so it stays 'rejected'
  socket.addEventListener('close', () => {
    outcome.resolve('closed');
  });

  try {
    return await outcome.promise;
  } finally {
    socket.close();
  }
}

export async function tryTunnelSocket(
  port: string,
  query: string,
  headers: Readonly<Record<string, string>>,
  name = 'nope',
): Promise<string> {
  const socket = new WebSocket(buildImpdSocketUrl(port, '/tunnel', query), { headers });

  const outcome = Promise.withResolvers<string>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', name, port: 5432 }));
  });

  socket.addEventListener('message', (event) => {
    outcome.resolve(String(event.data));
  });

  socket.addEventListener('error', () => {
    outcome.resolve('rejected');
  });

  // a refused upgrade fires error before close, so it stays 'rejected'
  socket.addEventListener('close', () => {
    outcome.resolve('closed');
  });

  try {
    return await outcome.promise;
  } finally {
    socket.close();
  }
}
