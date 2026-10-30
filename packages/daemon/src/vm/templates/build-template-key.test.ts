import { expect, test } from 'bun:test';
import { readAgentFixture } from '@impz/test-utils/read-agent-fixture';
import * as z from 'zod';
import { buildMockHostIdentity } from '../../../testing/vm/build-mock-host-identity';
import { TEMPLATE_BOOT_ARGS, buildTemplateKey } from './build-template-key';

test('#TEMPLATE_BOOT_ARGS is the cmdline the agent reads as a template (agent/internal/contract)', () => {
  expect(TEMPLATE_BOOT_ARGS).toBe(
    z.object({ template_boot_args: z.string() }).parse(readAgentFixture('host/cmdline.json'))
      .template_boot_args,
  );
});

test('#buildTemplateKey changes with each thing a restore inherits', () => {
  const identity = buildMockHostIdentity();
  const shape = { vcpus: 1, memoryMib: 512 };

  const keys = [
    buildTemplateKey(identity, shape),
    buildTemplateKey({ ...identity, guestKernel: `${identity.guestKernel}-other` }, shape),
    buildTemplateKey({ ...identity, systemDrive: `${identity.systemDrive}-other` }, shape),
    buildTemplateKey(
      { ...identity, firecrackerVersion: `${identity.firecrackerVersion}-other` },
      shape,
    ),
    buildTemplateKey({ ...identity, snapshotVersion: `${identity.snapshotVersion}-other` }, shape),
    buildTemplateKey({ ...identity, hostKernel: `${identity.hostKernel}-other` }, shape),
    buildTemplateKey({ ...identity, cpuModel: `${identity.cpuModel}-other` }, shape),
    buildTemplateKey({ ...identity, cpuFlags: `${identity.cpuFlags}-other` }, shape),
    buildTemplateKey(identity, { ...shape, vcpus: 2 }),
    buildTemplateKey(identity, { ...shape, memoryMib: 1024 }),
    buildTemplateKey(identity, { ...shape, hugePages: '2M' }),
  ];

  expect(new Set(keys).size).toBe(keys.length);
});

test('#buildTemplateKey keeps the key of a shape on host pages when it names them', () => {
  const identity = buildMockHostIdentity();

  expect(buildTemplateKey(identity, { vcpus: 1, memoryMib: 512, hugePages: 'None' })).toBe(
    buildTemplateKey(identity, { vcpus: 1, memoryMib: 512 }),
  );
});

test('#buildTemplateKey keeps the key when only the drive path changes', () => {
  const identity = buildMockHostIdentity();
  const shape = { vcpus: 1, memoryMib: 512 };

  expect(buildTemplateKey({ ...identity, systemDrivePath: '/elsewhere' }, shape)).toBe(
    buildTemplateKey(identity, shape),
  );
});
