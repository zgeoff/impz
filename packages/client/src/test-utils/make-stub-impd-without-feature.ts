import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import * as z from 'zod';
import type { ImpdFeature } from '../require-features';

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
const FEATURE_PATHS = new Set(['/rpc/system/features', '/rpc/system/info']);

const FeatureAnswerSchema = z.looseObject({
  features: z.record(z.string(), z.boolean().optional()).optional(),
});

export function makeStubImpdWithoutFeature(
  handle: (request: Request) => Promise<Response>,
  feature: ImpdFeature,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (!FEATURE_PATHS.has(new URL(request.url).pathname) || !response.ok) {
      return response;
    }

    const body: unknown = await response.json();

    const answer = FeatureAnswerSchema.parse(serializer.deserialize(body));
    const { [feature]: _dropped, ...features } = answer.features ?? {};

    return Response.json(serializer.serialize({ ...answer, features }));
  };
}
