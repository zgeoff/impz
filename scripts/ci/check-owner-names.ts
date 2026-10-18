// Fails on the owner's domain, home path, or a 1Password vault outside the invented ones. The
// domain and login sit in owner-name-hashes.json as `printf %s <name> | sha256sum` hashes, and a
// problem names the file and line, never the matched text. Usage: bun run lint:owner-names
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

export interface OwnerNameHashes {
  readonly domains: ReadonlySet<string>;
  readonly logins: ReadonlySet<string>;
}

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

// `files` are paths relative to `root`; a file that is gone from the tree or binary is skipped
export function checkOwnerNames(
  root: string,
  files: readonly string[],
  hashes: OwnerNameHashes,
): Problem[] {
  return files.flatMap((file) => {
    const text = readText(join(root, file));

    return text === null ? [] : collectProblems(file, text, hashes);
  });
}

// invented vault names; a placeholder such as `<vault>`, `{vault}` or `$IMP_OP_VAULT` passes too
const ALLOWED_VAULTS = new Set(['example', 'vault']);

const PLACEHOLDER = /^(?:\\?\$|<|\{)/u;
const HOST = /(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*/giu;
const HOME = /\/(?:home|Users)\/(?<login>[^/\s'"`]+)/gu;
const VAULT = /op:\/\/(?<vault>[^/\s'"`]+)\//gu;

function collectProblems(file: string, text: string, hashes: OwnerNameHashes): Problem[] {
  return text.split('\n').flatMap((content, index) => {
    const line = index + 1;
    const problems: Problem[] = [];

    if ([...content.matchAll(HOST)].some((match) => isOwnerHost(match[0], hashes.domains))) {
      problems.push({ file, line, message: 'owner domain' });
    }

    if (
      [...content.matchAll(HOME)].some((match) =>
        hashes.logins.has(buildDigest(match.groups?.['login'] ?? '')),
      )
    ) {
      problems.push({ file, line, message: 'owner home path' });
    }

    if (
      [...content.matchAll(VAULT)].some((match) => !isAllowedVault(match.groups?.['vault'] ?? ''))
    ) {
      problems.push({ file, line, message: 'vault outside the allow list' });
    }

    return problems;
  });
}

// a host is the owner's when it, or a parent domain of it, hashes to one of the owner's domains
function isOwnerHost(host: string, domains: ReadonlySet<string>): boolean {
  const labels = host.toLowerCase().split('.');

  return labels.some(
    (_, start) =>
      labels.length - start >= 2 && domains.has(buildDigest(labels.slice(start).join('.'))),
  );
}

function isAllowedVault(vault: string): boolean {
  return ALLOWED_VAULTS.has(vault) || PLACEHOLDER.test(vault);
}

function buildDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

// null for a file that is gone from the tree or binary (a NUL byte)
function readText(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }

  const bytes = readFileSync(path);

  return bytes.includes(0) ? null : bytes.toString('utf8');
}

// the check's own test, whose probes are invented names it must find
const SKIPPED = new Set(['scripts/ci/check-owner-names.test.ts']);

function main(): void {
  const files = listFiles().filter((file) => !SKIPPED.has(file));
  const problems = checkOwnerNames(process.cwd(), files, loadHashes());

  for (const problem of problems) {
    console.error(`${problem.file}:${String(problem.line)}: ${problem.message}`);
  }

  if (problems.length > 0) {
    process.exit(1);
  }

  console.log(`check-owner-names: ${String(files.length)} files, no owner names`);
}

// untracked files too, so a new file is checked before it is staged
function listFiles(): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { stdout: 'pipe' },
  );

  if (result.exitCode !== 0) {
    throw new Error('git ls-files failed');
  }

  return [...new Set(result.stdout.toString().split('\0').filter(Boolean))];
}

const hashesSchema = z.object({ domains: z.array(z.string()), logins: z.array(z.string()) });

function loadHashes(): OwnerNameHashes {
  const text = readFileSync(new URL('owner-name-hashes.json', import.meta.url), 'utf8');
  const parsed = hashesSchema.parse(JSON.parse(text));

  return { domains: new Set(parsed.domains), logins: new Set(parsed.logins) };
}

if (import.meta.main) {
  main();
}
