import type { Readable, Writable } from 'node:stream';
import type { ServerChannel } from 'ssh2';
import type { DialStream } from '../../vm/agent-client/dial-stream';

export interface ChannelSink {
  readonly write: (data: Uint8Array) => void;
  readonly drained: () => Promise<void>;
  readonly end: () => void;
}

export function startChannelInput(channel: Readable, sink: ChannelSink): void {
  const waitForDrain = async (): Promise<void> => {
    await sink.drained();

    channel.resume();
  };

  channel.on('data', (chunk: Buffer) => {
    sink.write(chunk);
    channel.pause();
    void waitForDrain();
  });

  channel.once('end', sink.end);
}

export async function writeToChannel(channel: Writable, data: Uint8Array): Promise<void> {
  if (channel.write(data) || channel.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const stopWaiting = (): void => {
      channel.off('drain', stopWaiting);
      channel.off('close', stopWaiting);

      resolve();
    };

    channel.on('drain', stopWaiting);
    channel.on('close', stopWaiting);
  });
}

export async function runChannelRelay(channel: ServerChannel, stream: DialStream): Promise<void> {
  startChannelInput(channel, stream);

  channel.once('close', stream.close);

  try {
    for await (const event of stream.events()) {
      if (event.type === 'data') {
        await writeToChannel(channel, event.data);
      } else {
        channel.eof();
      }
    }
  } finally {
    stream.close();
    channel.destroy();
  }
}
