import type { ServiceLog } from '@impz/api';

// Each service's UTF-8 decoder, kept across a follow's reconnects: a cursor
// can fall inside a character, and its rest comes on the next stream.
export interface LogDecoders {
  readonly readText: (service: string, data: Uint8Array) => string;

  // what the decoders still hold, once the log ends for good
  readonly readRest: () => Generator<ServiceLog, void, undefined>;
}

export function createLogDecoders(): LogDecoders {
  const decoders = new Map<string, TextDecoder>();

  return {
    readText: (service, data) => {
      const decoder = decoders.get(service) ?? new TextDecoder();

      decoders.set(service, decoder);

      return decoder.decode(data, { stream: true });
    },
    *readRest() {
      for (const [service, decoder] of decoders) {
        const rest = decoder.decode();

        if (rest !== '') {
          yield { type: 'log', service, text: rest };
        }
      }
    },
  };
}
