import { expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readThroughProxy } from './http';
import { runShellInImp } from './imp-cli';
import { waitFor } from './wait-for';

export interface MemoryProof {
  readonly name: string;
  readonly token: string;

  readonly identity: string;
}

function buildIdentityScript(pid: string): string {
  return `echo ${pid} $(cut -d' ' -f22 /proc/${pid}/stat) $(cat /proc/sys/kernel/random/boot_id)`;
}

export async function startMemoryProof(name: string): Promise<MemoryProof> {
  const token = randomBytes(16).toString('hex');

  // httpd forks into the background, so the script polls for its pid.
  const identity = await runShellInImp(
    name,
    [
      'mkdir -p /run/proof && mount -t tmpfs -o size=1m tmpfs /run/proof',
      `echo ${token} > /run/proof/index.html`,
      'setsid httpd -p 8080 -h /run/proof </dev/null >/dev/null 2>&1',
      'tries=0',
      'until pid=$(pidof httpd); do',
      '  tries=$((tries + 1)) && [ "$tries" -lt 50 ] || { echo "no httpd after 5 s" >&2; exit 1; }',
      '  sleep 0.1',
      'done',
      buildIdentityScript('$pid'),
    ].join('\n'),
  );

  expect(identity.split(' ')).toHaveLength(3);

  await waitFor(`${name} to serve the token`, async () => {
    const body = await readThroughProxy(name);

    expect(body).toBe(token);
  });

  return { name, token, identity };
}

export async function checkMemoryKept(proof: MemoryProof): Promise<boolean> {
  const pid = proof.identity.split(' ')[0] ?? '';

  try {
    const identity = await runShellInImp(proof.name, buildIdentityScript(pid));

    return identity === proof.identity;
  } catch {
    return false;
  }
}

export async function checkMemoryProof(proof: MemoryProof): Promise<void> {
  const pid = proof.identity.split(' ')[0] ?? '';

  const identity = await runShellInImp(proof.name, buildIdentityScript(pid));

  expect(identity).toBe(proof.identity);
}
