import type { Image, ImageOpEvent } from '@impz/api';
import { readFeatures } from '@impz/client';
import type { ImpClient } from '../config/create-imp-client';
import type { ProgressOutput } from '../cp/copy-progress';
import { createBuildStatus } from './build-status';

type AddInput = Parameters<ImpClient['images']['add']>[0];

type BuildInput = Parameters<ImpClient['images']['build']>[0];

export async function runImageAdd(
  client: Pick<ImpClient, 'images' | 'system'>,
  input: AddInput,
  label: string,
  output: ProgressOutput,
): Promise<Image> {
  if (!(await probeImageOpStream(client))) {
    return client.images.add(input);
  }

  const events = await client.images.addStream(input);

  return readImageOp(events, label, output);
}

export async function runOnHostBuild(
  client: Pick<ImpClient, 'images' | 'system'>,
  input: Omit<BuildInput, 'logs'>,
  output: ProgressOutput,
  quiet = false,
): Promise<Image> {
  if (!(await probeImageOpStream(client))) {
    return client.images.build(input);
  }

  const events = await client.images.buildStream({ ...input, logs: !quiet });

  return readImageOp(events, 'impz image build', output, quiet);
}

// An impd from before the streams answers only when the work ends, so a
// pull or a build longer than the client's fetch waits fails there
async function probeImageOpStream(client: Pick<ImpClient, 'system'>): Promise<boolean> {
  const features = await readFeatures(client);

  return features.imageOpStream === true;
}

async function readImageOp(
  events: Readonly<AsyncIterable<ImageOpEvent>>,
  label: string,
  output: ProgressOutput,
  quiet = false,
): Promise<Image> {
  const status = createBuildStatus(output, label, quiet);

  try {
    for await (const event of events) {
      if (event.type === 'image') {
        return event.image;
      }

      if (event.type === 'log') {
        status.printLog(event.text);
      } else if (event.type === 'progress') {
        status.show(event);
      }
    }
  } finally {
    status.finish();
  }

  throw new Error('impd ended the stream before it answered the image');
}
