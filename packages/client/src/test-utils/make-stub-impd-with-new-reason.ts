import { splitLines } from '@impz/shared';
import * as z from 'zod';

export function makeStubImpdWithNewReason(
  handle: (request: Request) => Promise<Response>,
  reason: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (new URL(request.url).pathname !== '/rpc/events/stream' || response.body === null) {
      return response;
    }

    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(splitLines())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (line, controller) => {
            controller.enqueue(`${buildRenamedLine(line, reason)}\n`);
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(body, { status: response.status, headers: response.headers });
  };
}

const FieldsSchema = z.record(z.string(), z.unknown());
const EventLineSchema = FieldsSchema.pipe(z.looseObject({ json: FieldsSchema }));

function buildRenamedLine(line: string, reason: string): string {
  if (!line.startsWith('data: ')) {
    return line;
  }

  const data: unknown = JSON.parse(line.slice('data: '.length));
  const parsed = EventLineSchema.safeParse(data);

  if (!parsed.success || parsed.data.json['ev'] !== 'ImpChanged') {
    return line;
  }

  return `data: ${JSON.stringify({ ...parsed.data, json: { ...parsed.data.json, reason } })}`;
}
