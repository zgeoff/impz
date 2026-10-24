import * as z from 'zod';
import { NameSchema } from '../schemas/name-schema';
import { ResumeFromSchema, SessionOutputSchema } from '../schemas/session-output-schema';
import { SessionNameSchema } from '../schemas/session-schema';

// A client sends `start` or `attach` first and waits for `started`.
export const EXEC_PATH = '/exec';
export const EXEC_TICKET_PARAM = 'ticket';
export const EXEC_CLOSE_RESTARTING = 1012;

export const EXEC_CHANNELS = {
  stdin: 0,
  stdout: 1,
  stderr: 2,
} as const;

export type ExecChannel = (typeof EXEC_CHANNELS)[keyof typeof EXEC_CHANNELS];

interface ExecFrame {
  readonly channel: ExecChannel;
  readonly data: Uint8Array;
}

const DimensionSchema = z.int().min(1).max(65_535);
const EXEC_TOOLS = ['tar'] as const;

export type ExecTool = (typeof EXEC_TOOLS)[number];

// The guest agent's tar puts this PAX record on its first entry, holding the
// byte total of every regular file in the archive.
export const TAR_TOTAL_RECORD = 'IMP.total';
export const EXEC_REQUIREMENTS = ['broker'] as const;

export type ExecRequirement = (typeof EXEC_REQUIREMENTS)[number];

// impd acks a tool's stdin, and the client keeps at most this many bytes
// unacked, in frames of at most the next size, so a large upload cannot grow
// impd's memory.
export const EXEC_STDIN_WINDOW_BYTES = 1_048_576;
export const EXEC_MAX_STDIN_FRAME_BYTES = 65_536;

// The client acks a tool's stdout once it is written, and impd sends at most
// this many bytes past the acks, so a slow client disk cannot grow the
// client's memory.
export const EXEC_STDOUT_WINDOW_BYTES = 1_048_576;

// Either end waits while its socket holds this many bytes unsent, so a slow
// peer slows the sender instead of growing its memory.
export const EXEC_HIGH_WATER_BYTES = 1_048_576;
export const KILL_GRACE_MAX_MS = 60_000;

export const ExecStartMessageSchema = z
  .object({
    type: z.literal('start'),
    name: NameSchema,
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    tty: z.boolean(),
    cols: DimensionSchema.optional(),
    rows: DimensionSchema.optional(),
    session: SessionNameSchema.optional(),
    tool: z.enum(EXEC_TOOLS).optional(),

    // An outer exec runs as root outside the guest's container, so it needs
    // host-wide manage scope, and an exec ticket never starts one.
    outer: z.boolean().optional(),

    killGraceMs: z.int().min(1).max(KILL_GRACE_MAX_MS).optional(),

    resumeFrom: ResumeFromSchema.optional(),

    require: z.array(z.enum(EXEC_REQUIREMENTS)).optional(),

    log: z.boolean().optional(),

    dropSysAdmin: z.boolean().optional(),
  })
  .refine((start) => start.session === undefined || start.tty, {
    message: 'a session needs a tty',
    path: ['tty'],
  })
  .refine((start) => start.resumeFrom === undefined || start.session !== undefined, {
    message: 'only a session resumes',
    path: ['resumeFrom'],
  })
  .refine((start) => start.log !== true || start.session !== undefined, {
    message: 'only a session keeps a log',
    path: ['log'],
  })
  .refine((start) => start.killGraceMs === undefined || !start.tty, {
    message: 'a tty exec takes no kill grace',
    path: ['killGraceMs'],
  })
  .refine(
    (start) =>
      start.tool === undefined ||
      (!start.tty &&
        start.session === undefined &&
        start.env === undefined &&
        start.cwd === undefined),
    { message: 'a tool takes no tty, session, env or cwd', path: ['tool'] },
  )
  .refine(
    (start) => start.outer !== true || (start.tool === undefined && start.session === undefined),
    {
      message: 'an outer exec takes no tool or session',
      path: ['outer'],
    },
  )
  .refine(
    (start) =>
      start.require === undefined ||
      start.require.length === 0 ||
      (start.tool === undefined && start.outer !== true),
    { message: 'a tool or an outer exec takes no require', path: ['require'] },
  )
  .refine(
    (start) => start.dropSysAdmin !== true || (start.tool === undefined && start.outer !== true),
    { message: 'a tool or an outer exec cannot drop CAP_SYS_ADMIN', path: ['dropSysAdmin'] },
  );

export const ExecAttachMessageSchema = z.object({
  type: z.literal('attach'),
  name: NameSchema,
  session: SessionNameSchema,
  cols: DimensionSchema.optional(),
  rows: DimensionSchema.optional(),
  resumeFrom: ResumeFromSchema.optional(),

  wake: z.boolean().optional(),
});

export const ExecClientMessageSchema = z.discriminatedUnion('type', [
  ExecStartMessageSchema,
  ExecAttachMessageSchema,
  z.object({ type: z.literal('stdin_eof') }),
  z.object({ type: z.literal('resize'), cols: DimensionSchema, rows: DimensionSchema }),
  z.object({ type: z.literal('signal'), signal: z.string().regex(/^SIG[A-Z0-9]+$/u) }),

  z.object({ type: z.literal('stdout_ack'), bytes: z.int().positive() }),
]);

export type ExecClientMessage = z.infer<typeof ExecClientMessageSchema>;

export const DETACH_REASONS = ['taken_over', 'slow', 'lost'] as const;

export type DetachReason = (typeof DETACH_REASONS)[number];

export const ExecServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    pid: z.int().positive(),
    session: SessionNameSchema.optional(),
    created: z.boolean().optional(),

    groupKill: z.boolean().optional(),

    output: SessionOutputSchema.optional(),
  }),

  z.object({
    type: z.literal('exit'),
    code: z.int().nullable(),
    signal: z.string().nullable(),
    offset: z.int().nonnegative().optional(),
  }),

  z.object({
    type: z.literal('detached'),
    reason: z.enum(DETACH_REASONS),
    offset: z.int().nonnegative().optional(),
  }),

  z.object({ type: z.literal('stdin_ack'), bytes: z.int().positive() }),

  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
    data: z.unknown().optional(),
  }),
]);

export type ExecServerMessage = z.infer<typeof ExecServerMessageSchema>;

// The DOM's WebSocket.send takes only an ArrayBuffer-backed array.
export function encodeExecFrame(channel: ExecChannel, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(data.byteLength + 1);

  frame[0] = channel;

  frame.set(data, 1);

  return frame;
}

export function decodeExecFrame(frame: Uint8Array): ExecFrame {
  const [channel] = frame;

  if (!isExecChannel(channel)) {
    throw new Error(`exec frame has an unknown channel byte: ${String(channel)}`);
  }

  return { channel, data: frame.subarray(1) };
}

function isExecChannel(value: number | undefined): value is ExecChannel {
  return (
    value === EXEC_CHANNELS.stdin ||
    value === EXEC_CHANNELS.stdout ||
    value === EXEC_CHANNELS.stderr
  );
}
