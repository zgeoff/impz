import * as z from 'zod';

export interface BackupKeep {
  readonly hourly: number;
  readonly daily: number;
  readonly weekly: number;
}

export interface BackupConfig {
  readonly repository: string;
  readonly passwordFile: string;
  readonly intervalS: number;
  readonly keep: BackupKeep;

  readonly forget: boolean;
  readonly database: boolean;
  readonly cpus: number;
  readonly memoryMib: number;
}

const CountSchema = z.coerce.number().pipe(z.int().positive());
const KEEP_BUCKETS = ['hourly', 'daily', 'weekly'] as const;

const BackupEnvSchema = z.object({
  IMP_BACKUP_REPOSITORY: z.string().optional(),
  IMP_BACKUP_PASSWORD_FILE: z.string().optional(),
  IMP_BACKUP_INTERVAL_S: CountSchema.default(21_600),
  IMP_BACKUP_KEEP: z.string().default('hourly=24,daily=7,weekly=4'),
  IMP_BACKUP_FORGET: z.enum(['true', 'false']).default('true'),
  IMP_BACKUP_DATABASE: z.enum(['true', 'false']).default('false'),
  IMP_BACKUP_CPUS: CountSchema.default(2),
  IMP_BACKUP_MEMORY_MIB: CountSchema.default(512),
});

export function loadBackupConfig(
  env: Readonly<Record<string, string | undefined>>,
): BackupConfig | null {
  const parsed = BackupEnvSchema.parse(env);

  if (parsed.IMP_BACKUP_REPOSITORY === undefined) {
    return null;
  }

  if (parsed.IMP_BACKUP_PASSWORD_FILE === undefined) {
    throw new Error('IMP_BACKUP_REPOSITORY needs IMP_BACKUP_PASSWORD_FILE');
  }

  return {
    repository: parsed.IMP_BACKUP_REPOSITORY,
    passwordFile: parsed.IMP_BACKUP_PASSWORD_FILE,
    intervalS: parsed.IMP_BACKUP_INTERVAL_S,
    keep: parseBackupKeep(parsed.IMP_BACKUP_KEEP),
    forget: parsed.IMP_BACKUP_FORGET === 'true',
    database: parsed.IMP_BACKUP_DATABASE === 'true',
    cpus: parsed.IMP_BACKUP_CPUS,
    memoryMib: parsed.IMP_BACKUP_MEMORY_MIB,
  };
}

/* @internal */
export function parseBackupKeep(value: string): BackupKeep {
  const keep = { hourly: 0, daily: 0, weekly: 0 };

  for (const part of value.split(',')) {
    const [bucket = '', count = ''] = part.trim().split('=');
    const parsed = Number(count);

    if (!isKeepBucket(bucket) || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `IMP_BACKUP_KEEP: ${JSON.stringify(part)} is not hourly|daily|weekly=<count>`,
      );
    }

    keep[bucket] = parsed;
  }

  if (keep.hourly + keep.daily + keep.weekly === 0) {
    throw new Error('IMP_BACKUP_KEEP keeps nothing');
  }

  return keep;
}

function isKeepBucket(bucket: string): bucket is (typeof KEEP_BUCKETS)[number] {
  return (KEEP_BUCKETS as readonly string[]).includes(bucket);
}
