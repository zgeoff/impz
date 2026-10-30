import { resolve } from 'node:path';
import { $ } from 'bun';

// golangci-lint, govulncheck and deadcode are pinned in agent/tools/go.mod, a module of their own
// so their dependencies never move the agent's. The other modules share the agent's lint config.
const toolsModfile = resolve('agent/tools/go.mod');
const lintConfig = resolve('agent/.golangci.yml');
const spikeHarness = 'docs/design/spikes/uffd-2m-restore/harness';

const checks: Readonly<Record<string, () => Promise<void>>> = {
  format: checkFormat,
  vet: runVet,
  lint: runLint,
  vulnerabilities: runVulnerabilities,
  deadcode: checkDeadCode,
  test: runTests,
  'test-root': runRootTests,
};

async function main(): Promise<void> {
  const [name] = process.argv.slice(2);
  const check = name !== undefined && Object.hasOwn(checks, name) ? checks[name] : undefined;

  if (check === undefined) {
    console.error(`usage: run-go-checks.ts <${Object.keys(checks).join('|')}>`);

    process.exitCode = 2;

    return;
  }

  await check();
}

// gofmt -l lists unformatted files and exits 0 either way
async function checkFormat(): Promise<void> {
  const listed =
    await $`gofmt -l agent host/ksm-exec host/oci-fetch host/uffd-handler scripts/dockerfile-difftest ${spikeHarness}`.text();

  if (listed.trim() !== '') {
    console.log(`::error::gofmt wants to reformat:\n${listed.trimEnd()}`);

    process.exitCode = 1;
  }
}

async function runVet(): Promise<void> {
  await $`go -C agent vet ./...`;
  await $`go -C agent vet -tags root ./...`;
  await $`go -C host/ksm-exec vet ./...`;
  await $`go -C host/oci-fetch vet ./...`;
  await $`go -C host/uffd-handler vet ./...`;
  await $`go -C host/uffd-handler vet -tags root ./...`;
  await $`go -C scripts/dockerfile-difftest vet ./...`;
  await $`go -C ${spikeHarness} vet ./...`;
}

// the root tag adds the root-only tests to what the lint reads
async function runLint(): Promise<void> {
  const lint = (directory: string, flags: readonly string[]) =>
    $`go -C ${directory} tool -modfile=${toolsModfile} golangci-lint run --config ${lintConfig} ${flags} ./...`;

  await lint('agent', ['--build-tags', 'root']);
  await lint('host/ksm-exec', []);
  await lint('host/oci-fetch', ['--disable', 'depguard']);
  await lint('host/uffd-handler', ['--build-tags', 'root']);
  await lint('scripts/dockerfile-difftest', ['--disable', 'depguard']);
  await lint(spikeHarness, ['--disable', 'depguard']);
}

async function runVulnerabilities(): Promise<void> {
  const govulncheck = (directory: string) =>
    $`go -C ${directory} tool -modfile=${toolsModfile} govulncheck ./...`;

  await govulncheck('agent');
  await govulncheck('host/ksm-exec');
  await govulncheck('host/oci-fetch');
  await govulncheck('host/uffd-handler');
}

// deadcode lists functions no binary reaches, tests aside, and exits 0 either way
async function checkDeadCode(): Promise<void> {
  const deadcode = (directory: string, packages: string) =>
    $`go -C ${directory} tool -modfile=${toolsModfile} deadcode -test=false ${packages}`.text();

  const agent = await deadcode('agent', './cmd/...');
  const ksmExec = await deadcode('host/ksm-exec', '.');
  const ociFetch = await deadcode('host/oci-fetch', '.');
  const uffdHandler = await deadcode('host/uffd-handler', '.');

  const unreachable = `${agent}${ksmExec}${ociFetch}${uffdHandler}`.trimEnd();

  if (unreachable !== '') {
    console.log(
      `::error::only tests call these; delete them or move them into the tests:\n${unreachable}`,
    );

    process.exitCode = 1;
  }
}

// gotestsum, through scripts/test-go.sh, keeps the agent's JSON event stream, so each run's
// timings can be compared later.
async function runTests(): Promise<void> {
  await $`scripts/test-go.sh`;
  await $`go -C host/ksm-exec test -race ./...`;
  await $`go -C host/oci-fetch test -race ./...`;
  await $`go -C host/uffd-handler test -race ./...`;
  await $`go -C ${spikeHarness} test -race ./...`;
}

// The tests behind the root build tag change credentials, chown, mknod and write cgroup.kill. They
// leave root-owned files in the build cache, so this check runs last.
async function runRootTests(): Promise<void> {
  const path = `PATH=${process.env['PATH'] ?? ''}`;

  await $`sudo -E env ${path} go -C agent test -tags root -race ./...`;
  await $`sudo -E env ${path} go -C host/uffd-handler test -tags root -race ./...`;
}

if (import.meta.main) {
  await main();
}
