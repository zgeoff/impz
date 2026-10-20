import * as z from 'zod';

// oRPC's answer as the RPC protocol encodes it: the output under `json`
const RpcBodySchema = z.looseObject({ json: z.unknown() });
const RecordSchema = z.record(z.string(), z.unknown());
const InfoJsonSchema = z.looseObject({ features: RecordSchema.optional() });

// one SSE event of an event-iterator procedure, its data as oRPC encodes it
const EventDataSchema = z.looseObject({ json: z.looseObject({ type: z.string() }) });

// What another release of impd answers differently, by procedure such as
// `imps/list`: what an older one lacked, or what a newer one adds
export interface StubImpdReleaseOptions {
  // the feature flags a release before them did not report in
  // system.features and system.info
  readonly withoutFeatures?: readonly string[];

  // a release from before SystemInfo.features reported no features object
  readonly isWithoutFeatureList?: boolean;

  // procedures a release before them did not have, such as `moves/facts`;
  // impd's own answer for a procedure it does not know comes back
  readonly withoutProcedures?: readonly string[];

  // a fault: an event-iterator procedure's events of these types never
  // arrive, such as `{ 'images/addStream': ['image'] }`; the rest, and the
  // stream's end, do
  readonly withoutEvents?: Readonly<Record<string, readonly string[]>>;

  // output fields a release before them did not send, such as
  // `{ 'imps/fork': ['grantsNotCopied'] }`
  readonly withoutFields?: Readonly<Record<string, readonly string[]>>;

  // output fields a newer release adds, which this side's schema does not
  // know; each item gets them when the output is a list
  readonly withFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// the answers that carry the feature flags
const FEATURE_PROCEDURES = new Set(['system/features', 'system/info']);

// the path a procedure takes when no impd has it
const ABSENT_PROCEDURE = 'older-impd/absent';

// impd's fetch as another release answers it: the real app's answers less
// what that release lacked, plus what it adds. `calls` records the procedure
// of each RPC call it forwards, such as `system/info`.
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

      return { ...(isFeatures ? removeFeatures(fields, options) : fields), ...added };
    };

    const json = Array.isArray(body.json) ? body.json.map(buildItem) : buildItem(body.json);

    return Response.json({ ...body, json }, { status: response.status });
  };

  return { fetch: send, calls };
}

// system.info or system.features without the flags the release lacked; a
// reply without features stays without them, as the stand-in only removes
function removeFeatures(
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

// an event stream without the events of `types`; an event without a type,
// such as the stream's end, always passes
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
