import * as z from 'zod';
import { NameSchema } from '../schemas/name-schema';

// One socket per TCP connection: the client sends `open` and waits for `opened`.
// A reverse forward's control socket answers `listen`, then sends a `connection`
// per guest client, which the client takes with `accept` on a socket of its own.
export const TUNNEL_PATH = '/tunnel';
export const TUNNEL_CLOSE_NORMAL = 1000;
export const TUNNEL_CLOSE_PROTOCOL = 1002;
export const TUNNEL_CLOSE_RESTARTING = 1012;
export const TUNNEL_CLOSE_LOST = 4000;

// A sender keeps at most this many bytes unacked, because a WebSocket cannot
// pause reads and a slow reader would otherwise grow the other side's memory.
export const TUNNEL_WINDOW_BYTES = 1_048_576;

// A sender may pass the window by one message of at most this size.
export const TUNNEL_MAX_FRAME_BYTES = 65_536;
const AckSchema = z.object({ type: z.literal('ack'), bytes: z.int().positive() });

const TunnelListenSchema = z
  .object({
    type: z.literal('listen'),
    name: NameSchema,
    network: z.enum(['unix', 'tcp']),
    path: z.string().startsWith('/').nullable().optional(),
    port: z.int().min(0).max(65_535).optional(),
  })
  .refine(
    (listen) =>
      listen.network === 'tcp'
        ? listen.port !== undefined && listen.path === undefined
        : listen.port === undefined,
    { message: 'tcp takes a port, unix a path or null', path: ['network'] },
  );

export type TunnelListen = z.infer<typeof TunnelListenSchema>;

export const TunnelClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open'),
    name: NameSchema,
    port: z.int().min(1).max(65_535),
  }),
  z.object({ type: z.literal('eof') }),
  AckSchema,
  TunnelListenSchema,
  z.object({
    type: z.literal('accept'),
    name: NameSchema,
    listener: z.string().min(1),
    connection: z.int().positive(),
  }),
]);

export type TunnelClientMessage = z.infer<typeof TunnelClientMessageSchema>;

export const TunnelServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened') }),
  z.object({ type: z.literal('eof') }),
  AckSchema,

  z.object({
    type: z.literal('listening'),
    listener: z.string(),
    path: z.string().nullable(),
    port: z.int().nullable(),
  }),

  z.object({ type: z.literal('connection'), id: z.int().positive() }),

  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

export type TunnelServerMessage = z.infer<typeof TunnelServerMessageSchema>;
