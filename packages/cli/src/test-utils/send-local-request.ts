import { connect } from 'node:net';

export function sendLocalRequest(host: string, port: number, body: Uint8Array): Promise<string> {
  const reply = Promise.withResolvers<string>();
  const socket = connect({ host, port, allowHalfOpen: true });
  const chunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.resolve(Buffer.concat(chunks).toString());
  });

  socket.end(body);

  return reply.promise;
}
