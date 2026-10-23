import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { $ } from 'bun';
import * as z from 'zod';
import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const prefix = `imp-headscale-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(join(tmpdir(), 'imp-headscale-'));

  stack.defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // Headscale refuses to start with an empty DERP map; the node needs no
  // relay to join, so one region it never reaches is enough.
  writeFileSync(
    join(directory, 'config.yaml'),
    [
      'server_url: http://headscale:8080',
      'listen_addr: 0.0.0.0:8080',
      'noise: { private_key_path: /var/lib/headscale/noise_private.key }',
      'prefixes: { v4: 100.64.0.0/10, v6: "fd7a:115c:a1e0::/48" }',
      'derp: { server: { enabled: false }, urls: [], paths: [/etc/headscale/derp.yaml] }',
      'database: { type: sqlite, sqlite: { path: /var/lib/headscale/db.sqlite } }',
      'dns: { magic_dns: true, base_domain: imp-e2e.test, override_local_dns: false }',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(directory, 'derp.yaml'),
    'regions: { 900: { regionid: 900, regioncode: none, regionname: none, nodes: [{ name: 900a, regionid: 900, hostname: derp.invalid }] } }\n',
  );

  await $`docker network create ${prefix}`.quiet();

  stack.defer(async () => {
    await $`docker network rm ${prefix}`.quiet();
  });

  const headscale = `${prefix}-headscale`;

  await $`docker run -d --name ${headscale} --network ${prefix} --network-alias headscale -v ${directory}:/etc/headscale:ro --tmpfs /var/lib/headscale ${HEADSCALE_IMAGES.headscale} serve`.quiet();

  stack.defer(async () => {
    await $`docker rm -f ${headscale}`.quiet();
  });

  const node = `${prefix}-node`;

  // the host image's tools that tailscale-up.sh runs, on Tailscale's own image
  await $`docker run -d --name ${node} --network ${prefix} --cap-add NET_ADMIN --device /dev/net/tun -v ${dirname(Bun.fileURLToPath(import.meta.url))}:/scripts:ro --entrypoint sleep ${HEADSCALE_IMAGES.tailscale} infinity`.quiet();

  stack.defer(async () => {
    await $`docker rm -f ${node}`.quiet();
  });

  await $`docker exec ${node} apk add --quiet --no-cache bash jq procps`.quiet();

  await waitFor(
    async () => {
      await $`docker exec ${headscale} headscale health`.quiet();
    },
    { timeoutMs: 30_000, intervalMs: 200 },
  );

  return { headscale, node };
}

test('it joins a Headscale tailnet with the tags its pre-auth key carries', async () => {
  const ctx = await setupTest();

  const created: unknown =
    await $`docker exec ${ctx.headscale} headscale preauthkeys create --tags tag:imp-e2e -o json`.json();

  const key = z.object({ key: z.string() }).parse(created).key;

  const up =
    await $`docker exec -e TAILSCALE_AUTHKEY -e IMP_TAILSCALE_STATE_DIR=mem -e IMP_TAILSCALE_TAGS=tag:imp-e2e -e IMP_TAILSCALE_LOGIN_SERVER=http://headscale:8080 ${ctx.node} /scripts/tailscale-up.sh`
      .env({ ...process.env, TAILSCALE_AUTHKEY: key })
      .quiet()
      .nothrow();

  const status: unknown = await $`docker exec ${ctx.node} tailscale status --json`.json();

  const selfSchema = z.object({ Tags: z.array(z.string()) });
  const self = z.object({ Self: selfSchema }).parse(status).Self;

  expect({ exitCode: up.exitCode, stderr: up.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: '',
  });

  expect(self.Tags).toStrictEqual(['tag:imp-e2e']);
}, 240_000);
