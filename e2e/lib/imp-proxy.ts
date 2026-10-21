import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { startImp } from './imp-cli';
import { waitFor } from './wait-for';

export const PAGE = 'e2e-tiny-ok\n';

export const GUEST_SERVERS = [
  'httpd -p 127.0.0.1:9001 -h /srv/www',
  String.raw`printf '#!/bin/sh\necho "got $(wc -c) bytes"\n' > /tmp/count`,
  'chmod +x /tmp/count',
  'setsid nc -lk -p 9002 -s 127.0.0.1 -e /tmp/count >/dev/null 2>&1 &',
].join('\n');

const decoder = new TextDecoder();

export interface RunningProxy {
  readonly ports: readonly number[];
  readonly readStderr: () => string;
  readonly stop: () => Promise<number>;
}

interface OutputSink {
  text: string;
}

async function readOutput(stream: ReadableStream<Uint8Array>, sink: OutputSink): Promise<void> {
  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk);
  }
}

export async function startProxy(name: string, ...specs: readonly string[]): Promise<RunningProxy> {
  const subprocess = await startImp(['proxy', name, ...specs]);

  const stderr = { text: '' };
  const stdout = { text: '' };

  void readOutput(subprocess.stderr, stderr);
  void readOutput(subprocess.stdout, stdout);

  const ports = await waitFor('impz proxy to listen', () => {
    const found = [...stdout.text.matchAll(/forwarding localhost:(?<port>\d+) ->/gv)];

    if (found.length < specs.length) {
      throw new Error(`impz proxy printed ${stdout.text}${stderr.text}`);
    }

    return found.map((match) => Number(match.groups?.['port']));
  });

  return {
    ports,
    readStderr: () => stderr.text,
    stop: () => {
      subprocess.kill('SIGINT');

      return subprocess.exited;
    },
  };
}

export function parseReverseForwards(stdout: string): string[] {
  return [...stdout.matchAll(/^forwarding [^:]+:(?<guest>\S+) ->/gmv)].map(
    (match) => match.groups?.['guest'] ?? '',
  );
}

export interface RunningReverse {
  readonly guests: readonly string[];
  readonly readStderr: () => string;
  readonly stop: () => Promise<number>;
}

export async function startReverse(
  name: string,
  ...specs: readonly string[]
): Promise<RunningReverse> {
  const subprocess = await startImp([
    'proxy',
    name,
    ...specs.flatMap((spec) => ['--reverse', spec]),
  ]);

  const stderr = { text: '' };
  const stdout = { text: '' };

  void readOutput(subprocess.stderr, stderr);
  void readOutput(subprocess.stdout, stdout);

  const guests = await waitFor('impz proxy --reverse to listen', () => {
    const found = parseReverseForwards(stdout.text);

    if (found.length < specs.length) {
      throw new Error(`impz proxy printed ${stdout.text}${stderr.text}`);
    }

    return found;
  });

  return {
    guests,
    readStderr: () => stderr.text,
    stop: () => {
      subprocess.kill('SIGINT');

      return subprocess.exited;
    },
  };
}

export function readText(stream: ReadableStream<Uint8Array>): { readonly read: () => string } {
  const sink = { text: '' };

  void readOutput(stream, sink);

  return { read: () => sink.text };
}

export function sendRequest(port: number, body: string): Promise<string> {
  const reply = Promise.withResolvers<string>();
  const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  let text = '';

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.resolve(text);
  });

  socket.end(body);

  return reply.promise;
}

export interface HeldSocket {
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

export async function openHeldSocket(port: number): Promise<HeldSocket> {
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port }, connected.resolve);

  socket.on('error', () => {
    // a reset shows as the close
  });

  socket.on('close', () => {
    closed.resolve();
  });

  await connected.promise;

  return { socket, closed: closed.promise };
}

export function sendOverHeldSocket(held: Readonly<HeldSocket>, text: string): Promise<string> {
  const reply = Promise.withResolvers<string>();

  if (held.socket.destroyed) {
    return Promise.reject(new Error('the held socket closed before a reply'));
  }

  held.socket.once('data', (chunk: Buffer) => {
    reply.resolve(chunk.toString());
  });

  held.socket.once('close', () => {
    reply.reject(new Error('the held socket closed before a reply'));
  });

  held.socket.write(text);

  return reply.promise;
}

export async function readPage(url: string): Promise<string> {
  const response = await fetch(url);

  return response.text();
}

export function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
