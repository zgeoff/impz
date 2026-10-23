import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImageBuilder,
  createBuilderImage,
  createFilesTar,
  createImage,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const workDir = await mkdtemp(join(tmpdir(), 'dashboard-images-'));

  onTestFinished(() => rm(workDir, { recursive: true, force: true }));

  return { stack, workDir };
}

test('it lists each image with its size', async () => {
  const ctx = await setupTest();
  const dashboardImpd = await startDashboardImpd(ctx.stack);

  const image = buildMockNewImage({ name: 'base', sizeBytes: 512 * 1024 * 1024 });

  await Bun.write(buildImagePaths(dashboardImpd.harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(dashboardImpd.harness.db, image);

  await dashboardImpd.logIn();

  const rendered = renderApp('/images');

  const row = await rendered.findByRole('row', { name: /base/u });

  expect(within(row).getByText('512 MiB')).toBeInTheDocument();
});

test('it adds an image from a ref, which impd names when the name is left blank', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'from node\n' })],
    repoDigest: `sha256:${'d'.repeat(64)}`,
  });

  const dashboardImpd = await startDashboardImpd(ctx.stack, {
    boundaries: {
      agent: { openBuilderExec: (_name, request) => builder.guest.open(request) },
    },
  });

  await createBuilderImage({
    db: dashboardImpd.harness.db,
    dataDir: dashboardImpd.harness.dataDir,
    ref: dashboardImpd.harness.config.build.image,
  });

  await dashboardImpd.logIn();

  const rendered = renderApp('/images');

  const field = await rendered.findByLabelText('Image ref');

  await user.type(field, 'docker.io/library/node:22');
  await user.click(rendered.getByRole('button', { name: 'Add image' }));

  const row = await rendered.findByRole('row', { name: /docker\.io\/library\/node:22/u });
  const images = await dashboardImpd.harness.client.images.list();

  expect(row).toBeInTheDocument();

  expect(images.map((image) => [image.name, image.ref])).toStrictEqual([
    ['imp-builder', dashboardImpd.harness.config.build.image],
    ['node', 'docker.io/library/node:22'],
  ]);
});

test('it deletes an image after a confirm', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();
  const dashboardImpd = await startDashboardImpd(ctx.stack);

  await dashboardImpd.harness.createTestImage('base');
  await dashboardImpd.logIn();

  const rendered = renderApp('/images');

  const row = await rendered.findByRole('row', { name: /base/u });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete base?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /base/u })).toBeNull();
  });

  const images = await dashboardImpd.harness.client.images.list();

  expect(images).toStrictEqual([]);
});
