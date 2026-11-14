// A loopback port that nothing listens on now, for a listener that impd opens itself.
export function readFreePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => {} },
  });

  const port = listener.port;

  listener.stop(true);

  return port;
}
