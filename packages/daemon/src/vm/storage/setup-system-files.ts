import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../../config';
import { writeCopyDurably } from '../../platform/process/write-file-durably';
import { buildSystemDrivePath } from './data-layout';
import { deriveFileSha256, readKernelInfo } from './system-file-info';
import type { SystemFileInfo } from './system-file-info';

export interface SystemFiles {
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly info: SystemFileInfo;
}

export async function setupSystemFiles(config: Config): Promise<SystemFiles> {
  const kernelSource = config.kernelSource ?? config.kernelPath;

  if (!existsSync(kernelSource)) {
    const missing = config.kernelSource === null ? ' and no source is configured' : '';

    throw new Error(`${kernelSource} does not exist${missing}`);
  }

  const kernel = readFileSync(kernelSource);
  const guestKernel = readKernelInfo(kernel);

  // the copy renames over the old kernel, so a VM that has it open keeps the old inode
  if (config.kernelSource !== null && !probeContent(config.kernelPath, kernel)) {
    writeCopy(config.kernelSource, config.kernelPath);
  }

  if (!existsSync(config.systemDriveSource)) {
    throw new Error(`${config.systemDriveSource} does not exist`);
  }

  const sha256 = await deriveFileSha256(config.systemDriveSource);

  // a sleeping VM's Firecracker snapshot reopens its drive by path, so the bytes there never change
  const systemDrivePath = buildSystemDrivePath(config.dataDir, sha256);

  if (!existsSync(systemDrivePath)) {
    writeCopy(config.systemDriveSource, systemDrivePath);
  }

  return {
    kernelPath: config.kernelPath,
    systemDrivePath,
    info: { guestKernel, systemDrive: { sha256 } },
  };
}

function probeContent(path: string, content: Uint8Array): boolean {
  return existsSync(path) && Buffer.from(content).equals(readFileSync(path));
}

function writeCopy(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeCopyDurably(source, target);
}
