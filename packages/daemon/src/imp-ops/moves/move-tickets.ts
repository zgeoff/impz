import * as z from 'zod';
import { isSameDigest } from '../../platform/secrets/is-same-digest';
import { isValidSignature } from '../../platform/secrets/is-valid-signature';
import { parseOpaqueToken } from '../../platform/secrets/parse-opaque-token';
import type { OpaqueToken } from '../../platform/secrets/parse-opaque-token';
import { sign } from '../../platform/secrets/sign';

const MOVE_AUTH_SCHEME = 'ImpMove';

export const MOVE_TICKET_PREFIX = '';

export function isSameHash(leftItem: string, rightItem: string): boolean {
  return isSameDigest(Buffer.from(leftItem, 'hex'), Buffer.from(rightItem, 'hex'));
}

export function readTicketHeader(request: Request): OpaqueToken | null {
  const header = request.headers.get('authorization') ?? '';
  const prefix = `${MOVE_AUTH_SCHEME} `;

  return header.startsWith(prefix)
    ? parseOpaqueToken(MOVE_TICKET_PREFIX, header.slice(prefix.length).trim())
    : null;
}

export function buildTicketHeader(ticket: string): Record<string, string> {
  return { authorization: `${MOVE_AUTH_SCHEME} ${ticket}` };
}

const ReceiptFileSchema = z.object({
  kind: z.string(),
  index: z.int().nonnegative().optional(),
  sha256: z.string(),
  bytes: z.int().nonnegative(),
});

const ReceiptBodySchema = z.object({
  ticketId: z.string(),
  name: z.string(),
  impId: z.string(),
  files: z.array(ReceiptFileSchema),
});

export type ReceiptBody = z.infer<typeof ReceiptBodySchema>;

type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

export type ReadonlyReceiptBody = Readonly<Omit<ReceiptBody, 'files'>> & {
  readonly files: readonly Readonly<ReceiptFile>[];
};

// The body travels as the JSON text the MAC covers, so no key order or
// re-encoding can change what was signed.
export const ReceiptSchema = z.object({ body: z.string(), mac: z.string() });

export type Receipt = z.infer<typeof ReceiptSchema>;

export function buildReceipt(body: ReadonlyReceiptBody, secret: string): Receipt {
  const text = JSON.stringify(body);

  return { body: text, mac: sign(secret, text).toString('hex') };
}

export function readReceipt(receipt: Readonly<Receipt>, secret: string): ReceiptBody | null {
  if (!isValidSignature(secret, receipt.body, receipt.mac, 'hex')) {
    return null;
  }

  return ReceiptBodySchema.parse(JSON.parse(receipt.body));
}
