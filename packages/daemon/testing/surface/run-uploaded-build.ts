import { BUILD_CONTEXT_PATH, BuildContextErrorSchema, BuildContextUploadSchema } from '@impz/api';
import type { ImageOpEvent } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { TestImpd } from '../start-test-impd';

export interface UploadedBuild {
  readonly token: string;
  readonly query: string;
  readonly body: RequestInit['body'];
  readonly logs?: boolean;
  readonly signal?: AbortSignal;
}

export async function runUploadedBuild(
  harness: Pick<TestImpd, 'impd' | 'buildClient'>,
  build: Readonly<UploadedBuild>,
): Promise<ImageOpEvent[]> {
  const signal = build.signal === undefined ? {} : { signal: build.signal };

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?${build.query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${build.token}` },
      body: build.body,
      ...signal,
    }),
  );

  const answer: unknown = await response.json();

  if (!response.ok) {
    const failure = BuildContextErrorSchema.parse(answer);

    throw new ORPCError(failure.code, { status: response.status, message: failure.message });
  }

  const upload = BuildContextUploadSchema.parse(answer);

  const events = await harness
    .buildClient(build.token)
    .images.buildStream(
      { upload: upload.id, ...(build.logs !== undefined && { logs: build.logs }) },
      signal,
    );

  return Array.fromAsync(events);
}
