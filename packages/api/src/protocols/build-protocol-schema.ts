import { getEventIteratorSchemaDetails, isContractProcedure } from '@orpc/contract';
import type { AnySchema } from '@orpc/contract';
import * as z from 'zod';
import { impContract } from '../contract/imp-contract';
import { IMP_ERRORS } from '../contract/imp-errors';
import {
  BUILD_CONTEXT_PATH,
  BuildContextErrorSchema,
  BuildContextQuerySchema,
  BuildContextUploadSchema,
} from './build-context-protocol';
import {
  EXEC_CHANNELS,
  EXEC_CLOSE_RESTARTING,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_PATH,
  EXEC_STDIN_WINDOW_BYTES,
  EXEC_STDOUT_WINDOW_BYTES,
  EXEC_TICKET_PARAM,
  ExecClientMessageSchema,
  ExecServerMessageSchema,
} from './exec-protocol';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
  TunnelClientMessageSchema,
  TunnelServerMessageSchema,
} from './tunnel-protocol';

const JsonSchemaSchema = z.record(z.string(), z.unknown()).readonly();
const MessageDirectionSchema = z.enum(['toServer', 'toClient']);

const ProcedureSchemaSchema = z
  .object({
    input: JsonSchemaSchema,
    output: JsonSchemaSchema,

    stream: z.boolean(),
  })
  .readonly();

const MessageSchemaSchema = z
  .object({ direction: MessageDirectionSchema, schema: JsonSchemaSchema })
  .readonly();

const ErrorSchemaSchema = z
  .object({
    // Null for a common oRPC code, whose status oRPC fixes.
    status: z.number().nullable(),
    data: JsonSchemaSchema,
  })
  .readonly();

export const ProtocolSchemaSchema = z
  .object({
    procedures: z.record(z.string(), ProcedureSchemaSchema).readonly(),
    messages: z.record(z.string(), MessageSchemaSchema).readonly(),
    errors: z.record(z.string(), ErrorSchemaSchema).readonly(),
    constants: z.record(z.string(), z.unknown()).readonly(),
  })
  .readonly();

export type ProtocolSchema = z.infer<typeof ProtocolSchemaSchema>;

export function buildProtocolSchema(): ProtocolSchema {
  return {
    procedures: collectProcedures(impContract, []),
    messages: {
      'exec.client': toMessage('toServer', ExecClientMessageSchema),
      'exec.server': toMessage('toClient', ExecServerMessageSchema),
      'tunnel.client': toMessage('toServer', TunnelClientMessageSchema),
      'tunnel.server': toMessage('toClient', TunnelServerMessageSchema),
      'buildContext.query': toMessage('toServer', BuildContextQuerySchema),
      'buildContext.upload': toMessage('toClient', BuildContextUploadSchema),
      'buildContext.error': toMessage('toClient', BuildContextErrorSchema),
    },
    errors: Object.fromEntries(
      Object.entries(IMP_ERRORS).map(([code, error]) => {
        const status = 'status' in error && typeof error.status === 'number' ? error.status : null;
        const data = 'data' in error ? error.data : undefined;

        return [code, { status, data: buildJsonSchema(data, 'output') }];
      }),
    ),
    constants: {
      EXEC_PATH,
      EXEC_TICKET_PARAM,
      EXEC_CLOSE_RESTARTING,
      EXEC_CHANNELS,
      EXEC_STDIN_WINDOW_BYTES,
      EXEC_MAX_STDIN_FRAME_BYTES,
      EXEC_STDOUT_WINDOW_BYTES,
      BUILD_CONTEXT_PATH,
      TUNNEL_PATH,
      TUNNEL_CLOSE_NORMAL,
      TUNNEL_CLOSE_PROTOCOL,
      TUNNEL_CLOSE_RESTARTING,
      TUNNEL_CLOSE_LOST,
      TUNNEL_WINDOW_BYTES,
      TUNNEL_MAX_FRAME_BYTES,
    },
  };
}

type ProcedureSchema = z.infer<typeof ProcedureSchemaSchema>;

function collectProcedures(
  node: unknown,
  path: readonly string[],
): Record<string, ProcedureSchema> {
  if (isProcedure(node)) {
    const definition = node['~orpc'];
    const events = getEventIteratorSchemaDetails(definition.outputSchema);
    const output = events === undefined ? definition.outputSchema : events.yields;

    return {
      [path.join('.')]: {
        input: buildJsonSchema(definition.inputSchema, 'input'),
        output: buildJsonSchema(output, 'output'),
        stream: events !== undefined,
      },
    };
  }

  if (typeof node !== 'object' || node === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(node).flatMap(([key, child]) =>
      Object.entries(collectProcedures(child, [...path, key])),
    ),
  );
}

interface Procedure {
  readonly '~orpc': {
    readonly inputSchema?: AnySchema;
    readonly outputSchema?: AnySchema;
  };
}

function isProcedure(node: unknown): node is Procedure {
  return isContractProcedure(node);
}

type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// oRPC's serializer carries a Date as itself, and JSON Schema cannot express
// a custom type or a transform.
function buildJsonSchema(schema: unknown, io: 'input' | 'output'): JsonSchema {
  if (schema === undefined) {
    return {};
  }

  if (!(schema instanceof z.ZodType)) {
    throw new TypeError('the protocol schema reads zod schemas only');
  }

  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    override: (context) => {
      const zodSchema = context.zodSchema;

      if (zodSchema instanceof z.ZodDate) {
        context.jsonSchema.type = 'string';
        context.jsonSchema.format = 'date-time';
      } else if (zodSchema instanceof z.ZodCustom) {
        context.jsonSchema['x-unrepresentable'] = 'custom';
      } else if (zodSchema instanceof z.ZodTransform) {
        context.jsonSchema['x-unrepresentable'] = 'transform';
      }
    },
  });

  return json;
}

export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

type MessageSchema = z.infer<typeof MessageSchemaSchema>;

// A message on the wire is what its reader parses, so it is the schema's input.
function toMessage(direction: MessageDirection, schema: unknown): MessageSchema {
  return { direction, schema: buildJsonSchema(schema, 'input') };
}
