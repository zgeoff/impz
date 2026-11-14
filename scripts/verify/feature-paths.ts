// Globs are root-relative, as `git ls-files` prints them, and match with Bun.Glob. A package is in
// a feature when the feature's journey runs code in it.

// impd and the packages it loads, which every journey runs: on stand-in VMs on `local`, in a dev
// instance on `local-kvm`.
const impd = [
  'packages/agent-protocol/**',
  'packages/api/**',
  'packages/client/**',
  'packages/daemon/**',
  'packages/durable/**',
  'packages/local-tar/**',
  'packages/mcp/**',
  'packages/shared/**',
] as const;

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

export const featurePaths = {
  'api-lifecycle': [...impd, 'packages/testing/**', 'packages/cli/**'],
  'mcp-scope': [...impd, 'packages/testing/**'],
  'cli-create-exec': [...vm, 'packages/cli/**', 'packages/daemon/src/imps/exec/**'],
  'sleep-wake': [...vm, 'packages/daemon/src/imps/exec/**'],
  'checkpoint-restore-fork': [...vm, 'packages/daemon/src/imp-ops/checkpoints/**'],
} as const satisfies Record<string, readonly string[]>;

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
  // 1. No runtime effect: prose and tests. Never `**/*.md`: a package may read markdown at run time.
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
  '.claude/**',
  '.codex/**',
  '.github/**',
  'scripts/{ci,dockerfile-difftest,proto,render,test-utils,zfs,verify-gate}/**',
  'scripts/*.{ts,sh}',
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
