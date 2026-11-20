import type { DefinedFault, RawFault } from '../types';

export function buildFaultResponse(answer: DefinedFault | RawFault): Response {
  if ('body' in answer) {
    return typeof answer.body === 'string'
      ? new Response(answer.body, {
          status: answer.status,
          headers: { 'content-type': 'text/plain' },
        })
      : Response.json(answer.body, { status: answer.status });
  }

  return Response.json(
    {
      json: {
        defined: true,
        code: answer.code,
        status: answer.status,
        message: answer.message ?? answer.code,
        ...(answer.data !== undefined && { data: answer.data }),
      },
    },
    { status: answer.status },
  );
}
