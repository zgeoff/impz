import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSOLE_SHELL } from '@impz/api';
import { WRITE_SCRIPT } from '@impz/mcp/internal';
import { $ } from 'bun';

async function main(): Promise<void> {
  const completion = await $`bun run --silent impz completion bash`.text();

  // shellcheck reads no zsh or fish, so only the bash completion gets this check
  const scripts = [
    { name: 'console-shell', dialect: 'sh', text: CONSOLE_SHELL },
    { name: 'mcp-write-script', dialect: 'sh', text: WRITE_SCRIPT },
    { name: 'impz-completion.bash', dialect: 'bash', text: completion },
  ];

  const directory = mkdtempSync(join(tmpdir(), 'imp-embedded-shell-'));

  try {
    for (const script of scripts) {
      writeFileSync(join(directory, script.name), script.text);

      const check = await $`shellcheck --norc --shell=${script.dialect} ${script.name}`
        .cwd(directory)
        .nothrow();

      if (check.exitCode !== 0) {
        console.log(`::error::shellcheck finds a defect in ${script.name}`);

        process.exitCode = 1;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
