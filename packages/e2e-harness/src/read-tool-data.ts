import type { ToolResult } from './start-mcp-session';

export function readToolData(result: Readonly<ToolResult>): Readonly<Record<string, unknown>> {
  if (result.isError) {
    throw new TypeError(`the tool failed: ${result.content[0]?.text ?? ''}`);
  }

  return result.structuredContent ?? {};
}
