import { expect, test } from 'bun:test';
import { transformLayerPaths } from './transform-layer-paths';

test('it rewrites the imports of a moved file from its old folder', () => {
  expect(
    transformLayerPaths(
      [
        "import { impService } from '../imps/imp-service';",
        "import { channel } from './channel-io';",
        "import { start } from '..';",
        '',
      ].join('\n'),
      {
        root: '/repo',
        file: 'packages/daemon/src/ssh/ssh-gateway.ts',
        current: 'packages/daemon/src/surface/ssh/ssh-gateway.ts',
      },
    ),
  ).toBe(
    [
      "import { impService } from '../../imps/imps/imp-service';",
      "import { channel } from '../../imps/ssh/channel-io';",
      "import { start } from '../..';",
      '',
    ].join('\n'),
  );
});

test("it rewrites a path from a moved file's own folder", () => {
  expect(
    transformLayerPaths(
      [
        "const script = join(import.meta.dir, '../../testing/run-stub.ts');",
        "const sibling = new URL('ssh-gateway.ts', import.meta.url);",
        '',
      ].join('\n'),
      {
        root: '/repo',
        file: 'packages/daemon/src/ssh/channel-io.test.ts',
        current: 'packages/daemon/src/imps/ssh/channel-io.test.ts',
      },
    ),
  ).toBe(
    [
      "const script = join(import.meta.dir, '../../../testing/run-stub.ts');",
      "const sibling = new URL('../../surface/ssh/ssh-gateway.ts', import.meta.url);",
      '',
    ].join('\n'),
  );
});

test('it rewrites the daemon paths in a file that stays', () => {
  expect(
    transformLayerPaths(
      [
        "import { readImp } from '@impz/daemon/src/db/imps';",
        "import { impService } from '../../daemon/src/imps/imp-service';",
        '',
      ].join('\n'),
      {
        root: '/repo',
        file: 'packages/cli/src/run.test.ts',
        current: 'packages/cli/src/run.test.ts',
      },
    ),
  ).toBe(
    [
      "import { readImp } from '@impz/daemon/src/platform/db/imps';",
      "import { impService } from '../../daemon/src/imps/imps/imp-service';",
      '',
    ].join('\n'),
  );
});

test('it rewrites a daemon path in prose and leaves a shorter path alone', () => {
  expect(
    transformLayerPaths('See `packages/daemon/src/net/addressing.ts:12` and `src/net/x`.\n', {
      root: '/repo',
      file: 'notes/guide.md',
      current: 'notes/guide.md',
    }),
  ).toBe('See `packages/daemon/src/host-net/net/addressing.ts:12` and `src/net/x`.\n');
});

test("it rewrites the src paths of knip's daemon workspace only", () => {
  expect(
    transformLayerPaths(
      [
        '{',
        '  "packages/daemon": {',
        '    "entry": ["src/docker-proxy/main.ts", "src/**/*.pebble.ts"],',
        '    "ignoreIssues": { "src/db/schema.ts": ["types"] }',
        '  },',
        '  "packages/cli": { "entry": ["src/db/main.ts"] }',
        '}',
        '',
      ].join('\n'),
      { root: '/repo', file: 'knip.json', current: 'knip.json' },
    ),
  ).toBe(
    [
      '{',
      '  "packages/daemon": {',
      '    "entry": ["src/imps/docker-proxy/main.ts", "src/**/*.pebble.ts"],',
      '    "ignoreIssues": { "src/platform/db/schema.ts": ["types"] }',
      '  },',
      '  "packages/cli": { "entry": ["src/db/main.ts"] }',
      '}',
      '',
    ].join('\n'),
  );
});

test('it leaves the imports of a placed file as they are', () => {
  expect(
    transformLayerPaths("import { readImp } from '../../platform/db/imps';\n", {
      root: '/repo',
      file: 'packages/daemon/src/imps/imps/imp-service.ts',
      current: 'packages/daemon/src/imps/imps/imp-service.ts',
    }),
  ).toBe("import { readImp } from '../../platform/db/imps';\n");
});
