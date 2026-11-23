import { expect, test } from 'bun:test';
import { SystemInfoSchema } from '../schemas/system-info-schema';
import { buildMockSystemInfo } from './build-mock-system-info';

test('it builds a default system info', () => {
  const info = buildMockSystemInfo();
  const parsed: unknown = SystemInfoSchema.safeParse(info).data;
  const received: unknown = info;

  expect(received).toStrictEqual({
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
    ramBudgetMib: expect.any(Number),
    ramUsedMib: expect.any(Number),
    ramReservedMib: expect.any(Number),
    ramCommittedMib: expect.any(Number),
    ramPriorityKeptMib: expect.any(Number),
    ramSleepingMib: expect.any(Number),
    ramPrioritySleepingMib: expect.any(Number),
    awakeCount: expect.any(Number),
    impCount: expect.any(Number),
    sessionCount: expect.any(Number),
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0, ipv6: 0 } },
    firecrackerVersion: expect.stringMatching(/^v\d+\.\d+\.\d+$/u),
    guestKernel: {
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    },
    systemDrive: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    guest: { scratchDir: '/tmp', isClearedOnBoot: false },
    storage: {
      backend: 'xfs',
      usedBytes: expect.any(Number),
      availableBytes: expect.any(Number),
      reserveBytes: expect.any(Number),
      pendingBytes: expect.any(Number),
      isLow: false,
      impDiskBytes: expect.any(Number),
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    ksm: null,
    cpu: { hostCpus: expect.any(Number), limitsEnforced: true },
    defaults: {
      memoryMib: expect.any(Number),
      image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u),
    },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      tokenUpdate: true,
      tokenImageAdd: true,
      databaseCopy: true,
      imageOpStream: true,
      imageBuilds: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
      sessionLog: true,
      publicEgress: true,
      oauthSecrets: true,
      secretUpstream: true,
      secretPresets: true,
      backupOptOut: true,
      brokerRefusals: true,
      grantFilters: true,
      readOnlyFiles: true,
      execDropSysAdmin: true,
      guestScratch: true,
      imagePins: true,
      imageAliases: true,
      buildContextUpload: true,
      destroyIdCheck: true,
      eventCursor: true,
      secretIdentity: true,
    },
  });

  expect(parsed).toStrictEqual(info);
  expect(info.defaults?.memoryMib).toBeLessThanOrEqual(info.ramBudgetMib);
});

test('it merges a guest override into the default guest', () => {
  const info = buildMockSystemInfo({ guest: { scratchDir: '/var/scratch' } });

  expect(info.guest).toStrictEqual({ scratchDir: '/var/scratch', isClearedOnBoot: false });
});

test('it applies overrides on top of the defaults', () => {
  const info: unknown = buildMockSystemInfo({
    ramBudgetMib: 2048,
    storage: { isLow: true },
    features: { publicEgress: false },
  });

  expect(info).toStrictEqual({
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
    ramBudgetMib: 2048,
    ramUsedMib: expect.any(Number),
    ramReservedMib: expect.any(Number),
    ramCommittedMib: expect.any(Number),
    ramPriorityKeptMib: expect.any(Number),
    ramSleepingMib: expect.any(Number),
    ramPrioritySleepingMib: expect.any(Number),
    awakeCount: expect.any(Number),
    impCount: expect.any(Number),
    sessionCount: expect.any(Number),
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0, ipv6: 0 } },
    firecrackerVersion: expect.stringMatching(/^v\d+\.\d+\.\d+$/u),
    guestKernel: {
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    },
    systemDrive: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    guest: { scratchDir: '/tmp', isClearedOnBoot: false },
    storage: {
      backend: 'xfs',
      usedBytes: expect.any(Number),
      availableBytes: expect.any(Number),
      reserveBytes: expect.any(Number),
      pendingBytes: expect.any(Number),
      isLow: true,
      impDiskBytes: expect.any(Number),
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    ksm: null,
    cpu: { hostCpus: expect.any(Number), limitsEnforced: true },
    defaults: {
      memoryMib: expect.any(Number),
      image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u),
    },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      tokenUpdate: true,
      tokenImageAdd: true,
      databaseCopy: true,
      imageOpStream: true,
      imageBuilds: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
      sessionLog: true,
      publicEgress: false,
      oauthSecrets: true,
      secretUpstream: true,
      secretPresets: true,
      backupOptOut: true,
      brokerRefusals: true,
      grantFilters: true,
      readOnlyFiles: true,
      execDropSysAdmin: true,
      guestScratch: true,
      imagePins: true,
      imageAliases: true,
      buildContextUpload: true,
      destroyIdCheck: true,
      eventCursor: true,
      secretIdentity: true,
    },
  });
});
