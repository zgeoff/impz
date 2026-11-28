import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectFeatureScopes, isGlobMatch } from '@wringer/core';
import * as z from 'zod';
import { createVerifyRegistry } from './create-verify-registry.ts';

async function setupTest() {
  const gateSchema = z.object({ match: z.string(), skills: z.array(z.string()) });
  const rootDir = join(import.meta.dir, '..', '..');
  const rulesPath = join(rootDir, '.claude', 'skill-gate.json');

  const rulesJSON: unknown = await Bun.file(rulesPath).json();

  const rules = z.object({ gates: z.array(gateSchema) }).parse(rulesJSON);
  const registry = createVerifyRegistry();
  const scopes = collectFeatureScopes(registry);

  const trackedText = await Bun.$`git ls-files`.cwd(rootDir).text();

  return {
    rules,
    featureNames: registry.features.map((feature) => feature.name),
    trackedPaths: trackedText.trim().split('\n'),
    isIgnored: (path: string) => isGlobMatch(path, registry.ignore),
    collectFlagged: (path: string) =>
      isGlobMatch(path, registry.ignore)
        ? []
        : scopes.filter((scope) => isGlobMatch(path, scope.globs)).map((scope) => scope.name),
  };
}

test('it asks for the verify skill before an edit to each file that a feature or shared path holds', async () => {
  const ctx = await setupTest();

  const verifyGlobs = ctx.rules.gates
    .filter((gate) => gate.skills.includes('verify'))
    .map((gate) => gate.match);

  const mapped = ctx.trackedPaths.filter((path) => ctx.collectFlagged(path).length > 0);

  expect(mapped.filter((path) => !isGlobMatch(path, verifyGlobs))).toStrictEqual([]);
});

test.each([
  {
    path: 'packages/cli/src/commands/events-command.ts',
    flagged: ['api-lifecycle', 'cli-create-exec'],
  },
  {
    path: 'packages/daemon/src/surface/create-event-routes.ts',
    flagged: ['api-lifecycle', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/platform/events/open-event-stream.ts',
    flagged: ['api-lifecycle', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/surface/create-image-routes.ts',
    flagged: ['mcp-reads'],
  },
  {
    path: 'packages/mcp/src/tools/imp-tools.ts',
    flagged: ['mcp-scope', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/surface/mcp/create-mcp-endpoint.ts',
    flagged: ['mcp-scope', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/surface/oauth/public-listener.ts',
    flagged: ['mcp-scope', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/identity/oauth/build-service-caller.ts',
    flagged: ['mcp-scope', 'mcp-reads'],
  },
  {
    path: 'packages/daemon/src/imps/exec/exec-session.ts',
    flagged: ['api-lifecycle', 'mcp-scope', 'mcp-reads', 'cli-create-exec', 'sleep-wake'],
  },
  {
    path: 'packages/daemon/src/imp-ops/checkpoints/checkpoint-service.ts',
    flagged: ['api-lifecycle', 'mcp-scope', 'mcp-reads', 'checkpoint-restore-fork'],
  },
  {
    path: 'packages/daemon/e2e/fixtures/tiny/Dockerfile',
    flagged: ['cli-create-exec', 'sleep-wake', 'checkpoint-restore-fork'],
  },
  {
    path: 'agent/cmd/imp-agent/main.go',
    flagged: ['cli-create-exec', 'sleep-wake', 'checkpoint-restore-fork'],
  },
])('it flags only the features whose journey reaches $path', async (row) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(row.path)).toStrictEqual([...row.flagged]);
});

test.each([
  'packages/daemon/src/main.ts',
  'packages/daemon/src/impd/create-impd.ts',
  'packages/daemon/src/surface/create-app.ts',
  'packages/daemon/src/surface/create-imp-routes.ts',
  'packages/daemon/src/identity/auth/access-policy.ts',
  'packages/daemon/src/platform/events/event-bus.ts',
  'packages/testing/src/stand-in/start-test-impd.ts',
  'packages/client/src/index.ts',
  'packages/api/src/index.ts',
  'packages/durable/src/index.ts',
])('it flags each impd feature, and none on a real VM, for the core file %s', async (path) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(path)).toStrictEqual(['api-lifecycle', 'mcp-scope', 'mcp-reads']);
});

test.each([
  'packages/daemon/src/vm/sleep/snapshot-meta.ts',
  'packages/agent-protocol/src/index.ts',
  'scripts/verify/create-verify-registry.ts',
])('it flags every feature for %s', async (path) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(path)).toStrictEqual(ctx.featureNames);
});

test.each([
  'packages/daemon/src/test-utils/surface/build-stub-mcp-transport.ts',
  'packages/cli/src/test-utils/run-cli-in-process.ts',
  'packages/mcp/src/test-utils/create-mcp-server.ts',
])('it flags no feature for %s, which no journey runs', async (path) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(path)).toStrictEqual([]);
});

test('it maps every tracked file to a feature or the ignore list', async () => {
  const ctx = await setupTest();

  expect(
    ctx.trackedPaths.filter(
      (path) => !ctx.isIgnored(path) && ctx.collectFlagged(path).length === 0,
    ),
  ).toStrictEqual([]);
});
