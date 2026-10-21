import { z } from 'zod';

const PROXY_PREFIX = 'imp-docker-proxy: ';
const ENGINE_FAILURE_PREFIX = `${PROXY_PREFIX}the engine call failed: `;
const REFUSAL_MAX_CHARS = 1000;

// The docker CLI prints an engine error after this prefix, and a create of an image the engine
// lacks prints the `Unable to find image` line first.
const DAEMON_ERROR_PREFIX = 'Error response from daemon: ';
const UNABLE_TO_FIND_LINE = /^Unable to find image '[^'\n]+' locally$/u;
const RefusalBodySchema = z.strictObject({ message: z.string() });

export function formatRefusal(reason: string): string {
  return `${PROXY_PREFIX}${reason}`;
}

export function formatEngineFailure(message: string): string {
  return `${ENGINE_FAILURE_PREFIX}${message}`;
}

export function readProxyRefusal(text: string): string | null {
  const body = readJsonMessage(text.trim());

  if (body !== null) {
    return toRefusal(body);
  }

  const errorLine = readErrorLine(text.trimEnd().split('\n'));

  if (!errorLine.startsWith(DAEMON_ERROR_PREFIX)) {
    return null;
  }

  const answer = errorLine.slice(DAEMON_ERROR_PREFIX.length);

  return toRefusal(readJsonMessage(answer) ?? answer);
}

function readErrorLine(lines: readonly string[]): string {
  const [first = '', second = ''] = lines;

  if (lines.length === 1) {
    return first;
  }

  return lines.length === 2 && UNABLE_TO_FIND_LINE.test(first) ? second : '';
}

function toRefusal(message: string): string | null {
  if (!message.startsWith(PROXY_PREFIX) || message.startsWith(ENGINE_FAILURE_PREFIX)) {
    return null;
  }

  const firstLine = message.split('\n', 1)[0] ?? '';

  return firstLine.trim().slice(0, REFUSAL_MAX_CHARS);
}

function readJsonMessage(text: string): string | null {
  if (!text.startsWith('{')) {
    return null;
  }

  try {
    const body = RefusalBodySchema.safeParse(JSON.parse(text));

    return body.success ? body.data.message : null;
  } catch {
    return null;
  }
}
