import { onTestFinished } from 'bun:test';
import { Server } from 'ssh2';
import type { ServerChannel } from 'ssh2';
import { z } from 'zod';
import { generateEd25519Key } from '../../src/surface/ssh/host-key';

interface StubSshServerOptions {
  readonly password: string;
}

// ssh2 refuses a forward the server leaves unhandled. Closing the server stops only the
// listener, so each client ends its own connection.
export async function startStubSshServer(options: Readonly<StubSshServerOptions>) {
  const exec: { answer: (channel: ServerChannel) => void } = { answer: () => {} };
  const closes = { count: 0 };

  const server = new Server({ hostKeys: [generateEd25519Key().private] }, (client) => {
    client.on('authentication', (auth) => {
      const isRight = auth.method === 'password' && auth.password === options.password;

      if (isRight) {
        auth.accept();
      } else {
        auth.reject(['password']);
      }
    });

    client.on('error', () => {});

    client.on('close', () => {
      closes.count += 1;
    });

    client.on('session', (acceptSession) => {
      const session = acceptSession();

      session.on('exec', (acceptExec) => {
        exec.answer(acceptExec());
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  // a server listening on a TCP port reports an object with its port
  const address = z.object({ port: z.number() }).parse(server.address());

  return { port: address.port, exec, closes };
}
