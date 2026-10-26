import invariant from 'tiny-invariant';
import { BootstrapTestError } from './bootstrap-test-error';
import type { BootstrapIO, BootstrapRun } from './types';

export async function checkFirewallDrops(run: BootstrapRun): Promise<void> {
  const io = run.io;
  const container = run.state.container;

  invariant(container !== null, 'no test container is running');

  const format = '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}';

  const inspect = await io.shell`docker inspect -f ${format} ${container}`.quiet().text();

  const ip = inspect.trim();

  await io.shell`docker exec -d ${container} nc -lk 9999`.quiet();
  await io.sleep(1000);

  const hasSSH = await probeConnect(io, ip, 22);

  if (!hasSSH) {
    throw new BootstrapTestError(`SSH on ${ip}:22 does not connect`);
  }

  const isOpen = await probeConnect(io, ip, 9999);

  if (isOpen) {
    throw new BootstrapTestError(`port 9999 on ${ip} connects through the firewall`);
  }
}

async function probeConnect(io: BootstrapIO, ip: string, port: number): Promise<boolean> {
  const connect = await io.shell`timeout 5 bash -c ${`exec 3<>/dev/tcp/${ip}/${String(port)}`}`
    .quiet()
    .nothrow();

  return connect.exitCode === 0;
}
