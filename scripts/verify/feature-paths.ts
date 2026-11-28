import { join } from 'node:path';
import { collectReachedFolders } from './collect-reached-folders.ts';
import { corePaths } from './core-paths.ts';
import { readWorkspacePackages } from './read-workspace-packages.ts';
import type { WorkspacePackage } from './types.ts';

// Globs are root-relative, as `git ls-files` prints them, and match with Bun.Glob. A part that
// impd loads at start goes only in the features whose journey runs it: a change that breaks the
// start still fails each journey it flags.
interface FeatureReach {
  // package folders that the journey runs whole, with the workspace packages they depend on
  readonly packages: readonly string[];

  // the parts of a package that the journey runs, which bring that package's workspace dependencies
  readonly paths: readonly string[];
}

// The CLI imports the MCP server at start for `impz mcp`, and impd for its /mcp route, but only an
// MCP journey calls it. The walk never adds it, and each MCP feature names it.
const namedOnlyFolders = ['packages/mcp'];

const workspace = await readWorkspace(join(import.meta.dir, '..', '..'));

// the event stream that `impz events` and the MCP `imp_event_list` read
const eventReads: FeatureReach = {
  packages: [],
  paths: [
    'packages/daemon/src/surface/{create-event-routes,read-api-event}.ts',
    'packages/daemon/src/platform/events/{build-cursor-event,create-event-check,open-event-stream,pick-stream-start,read-event-page}.ts',
  ],
};

// the MCP server, the public MCP route, and the OAuth sign-in of its service client
const mcpRoute: FeatureReach = {
  packages: ['packages/mcp'],
  paths: [
    'packages/daemon/src/surface/{mcp,oauth}/**',
    'packages/daemon/src/surface/create-oauth-routes.ts',
    'packages/daemon/src/identity/oauth/**',
  ],
};

// What only a real VM runs: the guest agent and its protocol, impd's VM layer, the kernel, the host
// container and its Go programs, the dev instance that `local-kvm` starts, and the image its
// journeys boot. Only a change here, or to a KVM feature's own code, needs a KVM host's verdict.
const vm = [
  'agent/**',
  'proto/**',
  'packages/agent-protocol/**',
  'packages/daemon/src/vm/**',
  'kernel/**',
  'host/**',
  '.dockerignore',
  'scripts/dev/**',
  'scripts/lib/**',
  'scripts/impz',
  'scripts/release/build-system-drive.sh',
  'packages/daemon/e2e/fixtures/tiny/Dockerfile',
  'packages/daemon/e2e/fixtures/tiny/rootfs/**',
] as const;

// The features on `local` hold the core list, the folders of their packages and of the workspace
// packages those depend on, from each `package.json` as this file loads, and the parts of packages
// they name. The features on a real VM hold what only a real VM runs, and their own code.
export const featurePaths = {
  'api-lifecycle': buildFeatureGlobs(
    workspace,
    buildJoinedReach(eventReads, { packages: ['packages/cli'], paths: [] }),
  ),
  'mcp-scope': buildFeatureGlobs(workspace, mcpRoute),
  'mcp-reads': buildFeatureGlobs(
    workspace,
    buildJoinedReach(mcpRoute, eventReads, {
      packages: [],
      paths: ['packages/daemon/src/surface/create-image-routes.ts'],
    }),
  ),
  'cli-create-exec': [...vm, 'packages/cli/**', 'packages/daemon/src/imps/exec/**'],
  'sleep-wake': [...vm, 'packages/daemon/src/imps/exec/**'],
  'checkpoint-restore-fork': [...vm, 'packages/daemon/src/imp-ops/checkpoints/**'],
} as const satisfies Record<string, readonly string[]>;

interface Workspace {
  readonly packages: readonly WorkspacePackage[];
  readonly coreFolders: readonly string[];
  readonly splitFolders: readonly string[];
}

function buildFeatureGlobs(workspaceFacts: Workspace, reach: FeatureReach): string[] {
  const ownerFolders = collectOwnerFolders(reach.paths, workspaceFacts.packages);

  const walkSkipped = new Set([
    ...workspaceFacts.coreFolders,
    ...workspaceFacts.splitFolders,
    ...namedOnlyFolders,
  ]);

  // a split package's other parts run only where a feature names them
  const partFolders = new Set([...workspaceFacts.splitFolders, ...ownerFolders]);

  const ownFolders = collectReachedFolders(
    [...reach.packages, ...ownerFolders],
    workspaceFacts.packages,
    walkSkipped,
  ).filter((folder) => !partFolders.has(folder));

  return [
    ...workspaceFacts.coreFolders.map((folder) => `${folder}/**`),
    ...corePaths.globs,
    ...ownFolders.map((folder) => `${folder}/**`),
    ...reach.paths,
  ];
}

// The folder of the package that holds each glob, the deepest when packages nest.
function collectOwnerFolders(
  globs: readonly string[],
  packages: readonly WorkspacePackage[],
): string[] {
  const owners = globs.flatMap((glob) => {
    const holders = packages
      .map((entry) => entry.folder)
      .filter((folder) => glob.startsWith(`${folder}/`))
      .toSorted((first, second) => second.length - first.length);

    return holders.slice(0, 1);
  });

  return [...new Set(owners)];
}

async function readWorkspace(rootDir: string): Promise<Workspace> {
  const packages = await readWorkspacePackages(rootDir);

  return {
    packages,
    coreFolders: collectReachedFolders(corePaths.packages, packages, new Set()),
    splitFolders: collectOwnerFolders(corePaths.globs, packages),
  };
}

function buildJoinedReach(...reaches: readonly FeatureReach[]): FeatureReach {
  return {
    packages: reaches.flatMap((reach) => reach.packages),
    paths: reaches.flatMap((reach) => reach.paths),
  };
}

// A change to one of these changes every feature: the verify CLI and its targets' apps, and the
// root manifest, lock file and Bun pin, which decide every package's runtime dependencies.
export const sharedPaths = [
  'scripts/verify/**',
  'package.json',
  'bun.lock',
  '.bun-version',
] as const;

// A path that one of these globs matches counts as no change, even where a feature's or a shared
// glob matches it too.
export const ignoredPaths = [
  // 1. No runtime effect: prose, tests and test helpers. Never `**/*.md`: a package may read markdown at run time.
  'docs/**',
  '**/README.md',
  '**/CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  '**/LICENSE',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*_test.go',
  '**/testdata/**',
  'packages/*/src/**/test-utils/**',
  'packages/e2e-harness/**',
  'packages/daemon/e2e/bunfig.toml',
  'packages/daemon/e2e/fixtures/{git,headscale,ra,ws}/**',
  'packages/daemon/e2e/fixtures/tiny/Dockerfile.bare',

  // 2. Build, lint, CI and editor wiring, which Bun never reads when it runs the source.
  '**/tsconfig*.json',
  '**/bunfig.toml',
  'rig.config.ts',
  'knip.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  '.formatignore',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitleaks.toml',
  '.hadolint.yaml',
  '.env.example',
  'commitlint.config.js',
  'lefthook.yml',
  'audit-ignores.json',
  'socket.yml',
  'review.json',
  'renovate.json',
  'buf.yaml',
  'buf.gen.yaml',
  'agent/.golangci.yml',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.github/**',
  'scripts/{ci,dockerfile-difftest,proto,render,src,zfs,verify-gate}/**',
  'scripts/*.{ts,sh,json}',
  'scripts/release/*.ts',
  'scripts/release/{build-cli,build-formula,build-release-assets,build-release,check-base-image,check-client-package,check-client-runtimes,check-release-image,check-reproducible,check-testing-package,pack-client,pack-testing}.sh',

  // 3. release-please's own files. A package's manifest is no exception: its exports and
  //    dependencies change what impd runs, so it sits under its package's feature paths.
  '.release-please-manifest.json',
  'release-please-config.json',

  // 4. Code that no journey runs: the dashboard, the shipped guest images (the journeys boot the
  //    tiny fixture), the deployment and its Nix module, the installer, the bench scripts, and the
  //    ssh2 patch, which only impd's SSH server loads.
  'packages/dashboard/**',
  'packages/daemon/bench/**',
  'images/**',
  'deploy/**',
  'flake.nix',
  'flake.lock',
  'install.sh',
  'patches/**',
] as const;
