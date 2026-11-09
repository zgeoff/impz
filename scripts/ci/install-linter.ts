import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { getStepEnv } from '../lib/get-step-env.ts';
import { parseStepCommand } from '../lib/parse-step-command.ts';

interface Linter {
  readonly repo: string;
  readonly tag: (version: string) => string;
  readonly asset: (version: string) => string;

  // the binary's path inside the archive; a linter released as a bare binary has none
  readonly member?: (version: string) => string;
}

// Pinned releases, checked by sum: the runner's apt shellcheck is older and reports a different set
// of findings, and the hooks run these versions locally.
const linters: Readonly<Record<string, Linter>> = {
  shellcheck: {
    repo: 'koalaman/shellcheck',
    tag: (version) => version,
    asset: (version) => `shellcheck-${version}.linux.x86_64.tar.xz`,
    member: (version) => `shellcheck-${version}/shellcheck`,
  },
  shfmt: {
    repo: 'mvdan/sh',
    tag: (version) => version,
    asset: (version) => `shfmt_${version}_linux_amd64`,
  },
  actionlint: {
    repo: 'rhysd/actionlint',
    tag: (version) => `v${version}`,
    asset: (version) => `actionlint_${version}_linux_amd64.tar.gz`,
    member: () => 'actionlint',
  },
  zizmor: {
    repo: 'zizmorcore/zizmor',
    tag: (version) => version,
    asset: () => 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
    member: () => 'zizmor',
  },
  hadolint: {
    repo: 'hadolint/hadolint',
    tag: (version) => version,
    asset: () => 'hadolint-linux-x86_64',
  },
};

async function main(): Promise<void> {
  const command = parseStepCommand(
    'install-linter.ts',
    [{ name: 'linter', choices: Object.keys(linters) }],
    process.argv.slice(2),
  );

  if (!command.isValid) {
    console.error(command.usage);

    process.exitCode = 2;

    return;
  }

  const [name] = command.values;
  const linter = name === undefined ? undefined : linters[name];

  invariant(name !== undefined && linter, 'the parser accepts only a listed linter');

  const prefix = name.toUpperCase();
  const version = getStepEnv(process.env, `${prefix}_VERSION`);
  const sum = getStepEnv(process.env, `${prefix}_SHA256`);
  const temp = getStepEnv(process.env, 'RUNNER_TEMP');
  const githubPath = getStepEnv(process.env, 'GITHUB_PATH');
  const work = join(temp, name);
  const download = join(work, 'download');
  const bin = join(temp, 'bin');

  mkdirSync(work, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // through gh with the job's token: under load, GitHub answers an anonymous release download with
  // a 504 Gateway Timeout for as long as the load lasts
  await $`gh release download ${linter.tag(version)} --repo ${linter.repo} --pattern ${linter.asset(version)} --output ${download}`;

  const downloaded = new Bun.CryptoHasher('sha256').update(readFileSync(download)).digest('hex');

  if (downloaded !== sum) {
    console.error(`${name} ${version} has sha256 ${downloaded}, want ${sum}`);

    process.exitCode = 1;

    return;
  }

  const member = linter.member?.(version);

  if (member !== undefined) {
    await $`tar -xf ${download} -C ${work} ${member}`;
  }

  const binary = member === undefined ? download : join(work, member);

  copyFileSync(binary, join(bin, name));
  chmodSync(join(bin, name), 0o755);
  appendFileSync(githubPath, `${bin}\n`);

  await $`${join(bin, name)} --version`;
}

if (import.meta.main) {
  await main();
}
