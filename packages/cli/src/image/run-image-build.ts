import { resolve } from 'node:path';
import type { Image } from '@impz/api';
import {
  MissingDockerfileError,
  countFileBytes,
  countTarBytes,
  listContextEntries,
  writeLocalEntries,
} from '@impz/local-tar';
import type { LocalEntry } from '@impz/local-tar';
import { UsageError } from '../cli/errors';
import type { ImpClient } from '../config/create-imp-client';
import { createCopyProgress } from '../cp/copy-progress';
import type { CopyProgress, ProgressOutput } from '../cp/copy-progress';
import { createBuildStatus } from './build-status';

export interface ImageBuildOptions {
  readonly directory: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
  readonly quiet?: boolean;
  readonly output: ProgressOutput;
}

/* @internal */
export function createContextStream(
  entries: readonly LocalEntry[],
  progress: CopyProgress,
  warn: (text: string) => void,
): ReadableStream<Uint8Array> {
  const pipe = new TransformStream<Uint8Array, Uint8Array>();

  const writer = pipe.writable.getWriter();

  const send = async (chunk: Uint8Array): Promise<void> => {
    await writer.ready;

    await writer.write(chunk);
  };

  const writeEntries = async (): Promise<void> => {
    try {
      await writeLocalEntries(entries, send, progress, warn);

      await writer.close();
    } catch (error) {
      await writer.abort(error);
    }
  };

  void writeEntries();

  return pipe.readable;
}

export async function runImageBuild(
  client: ImpClient,
  options: Readonly<ImageBuildOptions>,
): Promise<Image> {
  const dockerfile = options.dockerfile ?? 'Dockerfile';

  const entries = await listContextEntries(resolve(options.directory), dockerfile).catch(
    (error: unknown) => {
      throw error instanceof MissingDockerfileError ? new UsageError(error.message) : error;
    },
  );

  const quiet = options.quiet === true;
  const output = { ...options.output, isTTY: options.output.isTTY && !quiet };

  const writeWarning = (text: string): void => {
    options.output.write(`impz image build: ${text}\n`);
  };

  const progress = createCopyProgress(output, Date.now, 'impz image build');
  const status = createBuildStatus(output, 'impz image build', quiet);

  const size = await countTarBytes(entries);

  progress.setTotal(countFileBytes(entries));

  // impd's build stream opens once the upload ends, and off a terminal no byte count shows the
  // upload.
  if (!output.isTTY) {
    status.show({ type: 'progress', phase: 'upload', elapsedMs: 0 });
  }

  try {
    return await client.buildImage(
      options.name,
      createContextStream(entries, progress, writeWarning),
      {
        size,
        ...(options.dockerfile !== undefined && { dockerfile: options.dockerfile }),
        onProgress: (event) => {
          progress.finish();
          status.show(event);
        },
        ...(!quiet && {
          onLog: (line: string) => {
            progress.finish();
            status.printLog(line);
          },
        }),
      },
    );
  } finally {
    progress.finish();
    status.finish();
  }
}
