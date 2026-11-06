import * as z from 'zod';

const RpcBodySchema = z.looseObject({ json: z.unknown() });
const RecordSchema = z.record(z.string(), z.unknown());

export interface StubImpdReleaseOptions {
  readonly withoutFeatures?: readonly string[];
  readonly isWithoutFeatureList?: boolean;
  readonly withoutProcedures?: readonly string[];
  readonly withoutEvents?: Readonly<Record<string, readonly string[]>>;
  readonly withoutFields?: Readonly<Record<string, readonly string[]>>;
  readonly withFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const FEATURE_PROCEDURES = new Set(['system/features', 'system/info']);

const ABSENT_PROCEDURE = 'older-impd/absent';

export function buildStubImpdReleaseFetch(
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubImpdReleaseOptions> = {},
) {
  const calls: string[] = [];

  const send = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    const marker = url.pathname.indexOf('/rpc/');

    if (marker === -1) {
      return fetch(request);
    }

    const prefix = url.pathname.slice(0, marker);
    const procedure = url.pathname.slice(marker + '/rpc/'.length);

    calls.push(procedure);

    if (options.withoutProcedures?.includes(procedure) === true) {
      url.pathname = `${prefix}/rpc/${ABSENT_PROCEDURE}`;

      return fetch(new Request(url.href, request));
    }

    const response = await fetch(request);

    if (!response.ok) {
      return response;
    }

    const types = options.withoutEvents?.[procedure];

    if (types !== undefined) {
      return removeEvents(response, types);
    }

    const isFeatures = FEATURE_PROCEDURES.has(procedure);
    const without = options.withoutFields?.[procedure] ?? [];
    const added = options.withFields?.[procedure] ?? {};

    if (!isFeatures && without.length === 0 && Object.keys(added).length === 0) {
      return response;
    }

    const answer: unknown = await response.json();

    const body = RpcBodySchema.parse(answer);

    const buildItem = (item: unknown): unknown => {
      const fields = Object.fromEntries(
        Object.entries(RecordSchema.parse(item)).filter(([key]) => !without.includes(key)),
      );

      return { ...(isFeatures ? stripFeatures(fields, options) : fields), ...added };
    };

    const json = Array.isArray(body.json) ? body.json.map(buildItem) : buildItem(body.json);

    return Response.json({ ...body, json }, { status: response.status });
  };

  return { fetch: send, calls };
}

const EventDataSchema = z.looseObject({ json: z.looseObject({ type: z.string() }) });

async function removeEvents(response: Response, types: readonly string[]): Promise<Response> {
  const text = await response.text();

  const events = text.split('\n\n').filter((event) => {
    const data = event.split('\n').find((line) => line.startsWith('data: '));

    if (data === undefined) {
      return true;
    }

    const parsed = EventDataSchema.safeParse(JSON.parse(data.slice('data: '.length)));

    return !parsed.success || !types.includes(parsed.data.json.type);
  });

  return new Response(events.join('\n\n'), {
    status: response.status,
    headers: response.headers,
  });
}

const InfoJsonSchema = z.looseObject({ features: RecordSchema.optional() });

function stripFeatures(
  info: Readonly<Record<string, unknown>>,
  options: Readonly<StubImpdReleaseOptions>,
): Record<string, unknown> {
  const { features, ...rest } = InfoJsonSchema.parse(info);

  if (options.isWithoutFeatureList === true || features === undefined) {
    return rest;
  }

  return {
    ...rest,
    features: Object.fromEntries(
      Object.entries(features).filter(([key]) => options.withoutFeatures?.includes(key) !== true),
    ),
  };
}
