import * as z from 'zod';
import { MOVING_RETRY_AFTER_S } from './api-errors';

export async function withRetryAfter(response: Response): Promise<Response> {
  if (response.status !== 409) {
    return response;
  }

  try {
    const body: unknown = await response.clone().json();

    const MovingBodySchema = z.object({ json: z.object({ code: z.literal('MOVING') }) });

    if (!MovingBodySchema.safeParse(body).success) {
      return response;
    }
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);

  headers.set('retry-after', String(MOVING_RETRY_AFTER_S));

  return new Response(response.body, { status: response.status, headers });
}
