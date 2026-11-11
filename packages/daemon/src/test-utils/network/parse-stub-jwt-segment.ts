import * as z from 'zod';

const SegmentSchema = z.record(z.string(), z.unknown());

// The header (index 0) or the claims (index 1) of a compact JWT, as written.
export function parseStubJwtSegment(token: string, index: number): Record<string, unknown> {
  const segment = token.split('.')[index] ?? '';

  return SegmentSchema.parse(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));
}
