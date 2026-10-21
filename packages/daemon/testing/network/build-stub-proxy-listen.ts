import type { ProxyListenOptions } from '../../src/network/proxy/wake-proxy';

export function buildStubProxyListen() {
  const events: string[] = [];
  const routes: string[] = [];

  return {
    events,
    routes,
    startListener: (options: ProxyListenOptions) => {
      const hostname = options.hostname ?? '';

      const handleRequest = async (request: Request) => {
        const route = await options.route(request);

        routes.push(route.kind);

        return new Response(`served on ${hostname}`, { headers: { 'x-route': route.kind } });
      };

      const server = Bun.serve({
        port: options.port,
        ...(options.hostname !== undefined && { hostname: options.hostname }),
        ...(options.tls !== undefined && { tls: options.tls }),
        ...(options.reusePort === true && { reusePort: true }),
        idleTimeout: 0,
        fetch: handleRequest,
      });

      events.push(`start ${hostname}`);

      return {
        port: server.port,
        stop: async (closeActiveConnections?: boolean) => {
          events.push(`stop ${hostname}`);

          await server.stop(closeActiveConnections);
        },
      };
    },
  };
}
