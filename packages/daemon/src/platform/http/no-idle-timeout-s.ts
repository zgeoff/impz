// Bun's types leave idleTimeout off unix servers, but it applies there too (10 s by default,
// which cuts off a slow model call). The augmentation sits in a module that the servers import,
// because the type checker applies a module nobody imports too late.
declare module 'bun' {
  namespace Serve {
    // oxlint-disable-next-line no-unused-vars -- a merged interface repeats Bun's type parameter
    interface UnixServeOptions<WebSocketData> {
      idleTimeout?: number;
    }
  }
}

// a server with an idleTimeout of 0 never cuts off a quiet connection
export const NO_IDLE_TIMEOUT_S = 0;
