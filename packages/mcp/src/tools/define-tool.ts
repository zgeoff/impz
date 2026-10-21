import type { Scope } from '@impz/api';
import { ExecError, ORPCError } from '@impz/client';
import type { CallToolResult, Tool as ToolDefinition } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { After } from '../after';
import { GuardError } from '../imp-guard';
import type { ImpGuard } from '../imp-guard';
import type { ToolClient } from './tool-client';

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface ToolContext {
  readonly client: ToolClient;
  readonly guard: ImpGuard;

  // impd finishes a create, fork or restore it has started, so only a tool
  // that runs a guest command passes the cancel on.
  readonly signal: Readonly<AbortSignal>;
  readonly killGraceMs: number;
  readonly after: After;
}

interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: boolean;
}

export interface Tool {
  readonly definition: ToolDefinition;

  // Hiding a tool from tools/list is not the check: impd refuses a call that
  // lacks the scope all the same.
  readonly scope: Scope;

  // impd finishes some calls once started, so their result still goes out
  // after a cancel and the agent learns the name of what it made.
  readonly cancellable: boolean;
  readonly call: (args: unknown, context: Readonly<ToolContext>) => Promise<CallToolResult>;
}

interface ToolOutput {
  readonly data: Readonly<Record<string, unknown>>;
  readonly failed?: string;
}

interface ToolSpec<Input extends z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly annotations: ToolAnnotations;
  readonly scope: Scope;
  readonly cancellable?: false;
  readonly run: (input: z.output<Input>, context: Readonly<ToolContext>) => Promise<ToolOutput>;
}

export function defineTool<Input extends z.ZodObject>(spec: Readonly<ToolSpec<Input>>): Tool {
  const definition: ToolDefinition = {
    name: spec.name,
    title: spec.annotations.title,
    description: spec.description,
    inputSchema: {
      ...JsonObjectSchema.parse(z.toJSONSchema(spec.input, { io: 'input' })),
      type: 'object',
    },
    annotations: spec.annotations,
  };

  const cancellable = spec.cancellable ?? true;

  return {
    definition,
    scope: spec.scope,
    cancellable,
    call: async (args, context) => {
      const parsed = spec.input.safeParse(args ?? {});

      if (!parsed.success) {
        return buildErrorResult(`invalid arguments: ${z.prettifyError(parsed.error)}`);
      }

      try {
        const output = await spec.run(parsed.data, context);

        // Parsing the text back makes each date the same ISO string in the
        // structured content as in the text.
        const text = JSON.stringify(output.data, null, 2);
        const data = JsonObjectSchema.parse(JSON.parse(text));

        return {
          content: [
            {
              type: 'text',
              text: output.failed === undefined ? text : `${output.failed}\n${text}`,
            },
          ],
          structuredContent: data,
          isError: output.failed !== undefined,
        };
      } catch (error) {
        if (cancellable && context.signal.aborted) {
          throw error;
        }

        return buildErrorResult(formatErrorText(error));
      }
    },
  };
}

function buildErrorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatErrorText(error: unknown): string {
  if (error instanceof ORPCError) {
    return formatCoded(String(error.code), error.message);
  }

  if (error instanceof ExecError) {
    return formatCoded(error.code, error.message);
  }

  if (error instanceof GuardError) {
    return formatCoded('GUARD', error.message);
  }

  return error instanceof Error ? error.message : String(error);
}

function formatCoded(code: string, message: string): string {
  return `${code}: ${message}`;
}
