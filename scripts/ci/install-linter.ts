import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getStepEnv } from '../lib/get-step-env.ts';

interface Linter {
  readonly url: (version: string) => string;

  // the binary's path inside the archive; a linter released as a bare binary has none
  readonly member?: (version: string) => string;
}

// Pinned releases, checked by sum: the runner's apt shellcheck is older and reports a different set
// of findings, and the hooks run these versions locally.
const linters: Readonly<Record<string, Linter>> = {
  shellcheck: {
    url: (version) =>
      `https://github.com/koalaman/shellcheck/releases/download/${version}/shellcheck-${version}.linux.x86_64.tar.xz`,
    member: (version) => `shellcheck-${version}/shellcheck`,
  },
  shfmt: {
    url: (version) =>
      `https://github.com/mvdan/sh/releases/download/${version}/shfmt_${version}_linux_amd64`,
  },
  actionlint: {
    url: (version) =>
      `https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz`,
    member: () => 'actionlint',
  },
  zizmor: {
    url: (version) =>
      `https://github.com/zizmorcore/zizmor/releases/download/${version}/zizmor-x86_64-unknown-linux-gnu.tar.gz`,
    member: () => 'zizmor',
  },
  hadolint: {
    url: (version) =>
      `https://github.com/hadolint/hadolint/releases/download/${version}/hadolint-linux-x86_64`,
  },
};

async function main(): Promise<void> {
  const [name] = process.argv.slice(2);
  const linter = name !== undefined && Object.hasOwn(linters, name) ? linters[name] : undefined;

  if (name === undefined || linter === undefined) {
    console.error(`usage: install-linter.ts <${Object.keys(linters).join('|')}>`);

    process.exitCode = 2;

    return;
  }

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

  await $`curl -fsSL --retry 3 -o ${download} ${linter.url(version)}`;

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
