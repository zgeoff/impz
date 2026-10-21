import type { ServiceLog } from '@impz/api';

// Each decoder outlives a follow's reconnects, because a cursor can fall
// inside a UTF-8 character whose rest comes on the next stream.
export interface LogDecoders {
  readonly readText: (service: string, data: Uint8Array) => string;

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
