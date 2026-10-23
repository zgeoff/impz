import {
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildErrorSchema,
  ImageBuildEventSchema,
  ImageBuildResultSchema,
} from '@impz/api';
import type { Image, ImageBuildProgress } from '@impz/api';
import { readLines } from '@impz/shared';
import { ORPCError } from '@orpc/client';

export async function readBuildAnswer(
  response: Response,
  onProgress: ((progress: ImageBuildProgress) => void) | undefined,
  onLog?: (line: string) => void,
): Promise<Image> {
  if (response.ok && isStream(response)) {
    return readBuildEvents(response, onProgress, onLog);
  }

  // An impd without the build stream answers with plain JSON.
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return ImageBuildResultSchema.parse(body);
  }

  const failure = ImageBuildErrorSchema.safeParse(body);

  if (failure.success) {
    throw new ORPCError(failure.data.code, {
      status: response.status,
      message: failure.data.message,
    });
  }

  // A 401 comes from impd's auth before the route, without a code.
  const code = response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR';

  throw new ORPCError(code, {
    status: response.status,
    message: `impd answered ${String(response.status)} to the image build`,
  });
}

function isStream(response: Response): boolean {
  return response.headers.get('content-type')?.startsWith(IMAGE_BUILD_STREAM_TYPE) === true;
}

async function readBuildEvents(
  response: Response,
  onProgress: ((progress: ImageBuildProgress) => void) | undefined,
  onLog: ((line: string) => void) | undefined,
): Promise<Image> {
  const lines = response.body === null ? [] : readLines(response.body);

  for await (const line of lines) {
    const parsed = ImageBuildEventSchema.safeParse(parseJson(line));

    if (!parsed.success) {
      continue;
    }

    const event = parsed.data;

    if (event.type === 'image') {
      return event.image;
    }

    if (event.type === 'error') {
      throw new ORPCError(event.code, { message: event.message });
    }

    if (event.type === 'log') {
      onLog?.(event.text);
    } else {
      onProgress?.(event);
    }
  }

  throw new ORPCError('INTERNAL_SERVER_ERROR', {
    message: 'the image build stream ended before impd answered the image',
  });
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
