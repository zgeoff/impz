import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import { DockerfilePathSchema, ImageOpEventSchema } from '../protocols/image-build-protocol';
import { ApiCallSchema } from '../schemas/api-call-schema';
import {
  BackupCheckSubsetSchema,
  BackupRestoreSchema,
  BackupRunSchema,
  BackupStatusSchema,
} from '../schemas/backup-schema';
import { CheckpointRefSchema } from '../schemas/checkpoint-ref-schema';
import { CheckpointSchema } from '../schemas/checkpoint-schema';
import { EmptySchema } from '../schemas/empty-schema';
import { ImpEventSchema } from '../schemas/event-schema';
import { FileContentSchema, FilePathSchema } from '../schemas/file-schema';
import { ImageBuildRunSchema } from '../schemas/image-build-run-schema';
import { ImageRefSchema } from '../schemas/image-ref-schema';
import { ImageSchema } from '../schemas/image-schema';
import { ImpSchema } from '../schemas/imp-schema';
import { LeaseLabelSchema, LeaseSchema, LeaseTtlSchema } from '../schemas/lease-schema';
import {
  MovePlanSchema,
  MoveStatusSchema,
  MoveTicketSchema,
  PeerUrlSchema,
  WarmHostSchema,
  WarmMoveSchema,
} from '../schemas/move-schema';
import { NameInputSchema } from '../schemas/name-input-schema';
import { NameSchema } from '../schemas/name-schema';
import { NetworkJoinSchema, NetworkSchema } from '../schemas/network-schema';
import {
  ApprovalCodeSchema,
  GrantPatternSchema,
  OAuthApprovalSchema,
  OAuthClientSchema,
  OAuthGrantSchema,
  RedirectUrisSchema,
} from '../schemas/oauth-schema';
import {
  AuditEntrySchema,
  BrokerRuleSchema,
  GrantFilterSchema,
  GrantSchema,
  OAuthConfigSchema,
  RefusedRequestSchema,
  SecretAddedSchema,
  SecretKindSchema,
  SecretNameSchema,
  SecretSchema,
  SecretValueSchema,
} from '../schemas/secret-schema';
import {
  SERVICE_LOG_MAX_LINES,
  ServiceDefSchema,
  ServiceListSchema,
  ServiceLogSchema,
  ServiceNameSchema,
} from '../schemas/service-schema';
import {
  SessionLogDeleteInputSchema,
  SessionLogListInputSchema,
  SessionLogReadInputSchema,
  SessionLogReadSchema,
  SessionLogSchema,
} from '../schemas/session-log-schema';
import { SessionNameSchema, SessionSchema } from '../schemas/session-schema';
import { DatabaseCopySchema, StorageGcSchema } from '../schemas/storage-schema';
import { SystemFeaturesInfoSchema, SystemInfoSchema } from '../schemas/system-info-schema';
import { ScopeSchema } from '../schemas/token-schema';
import { IMP_ERRORS } from './imp-errors';
import { impsContract } from './imps-contract';
import { tokensContract } from './tokens-contract';

const base = oc.errors(IMP_ERRORS);

// A lease labelled `hold` never blocks a sleep, so it would hold nothing.
const LeaseInputSchema = z.object({
  name: NameSchema,
  label: LeaseLabelSchema.refine((label) => label !== 'hold', 'hold is the label imps.hold writes'),
  ttlSeconds: LeaseTtlSchema,
});

const ImageAddInputSchema = z.union([
  z.object({ ref: ImageRefSchema, name: NameSchema.optional() }),
  z.object({ imp: NameSchema, name: NameSchema }),
]);

const ImageBuildInputSchema = z.object({
  // Absolute, so docker build cannot read it as a flag.
  contextDir: z.string().startsWith('/'),
  name: NameSchema,
  dockerfile: DockerfilePathSchema.optional(),

  logs: z.boolean().optional(),
});

export const CheckpointCreateInputSchema = z.object({
  name: NameSchema,
  label: z.string().min(1).max(64).optional(),
});

// every procedure that answers an authenticated caller
export const callerContract = {
  imps: impsContract,

  leases: {
    acquire: base.input(LeaseInputSchema).output(LeaseSchema),

    renew: base.input(LeaseInputSchema).output(LeaseSchema),

    release: base
      .input(z.object({ name: NameSchema, label: LeaseLabelSchema }))
      .output(z.object({ released: z.boolean() })),

    list: base
      .input(z.object({ name: NameSchema.optional(), label: LeaseLabelSchema.optional() }))
      .output(z.array(LeaseSchema)),
  },

  moves: {
    prepare: base
      .input(
        z.object({
          name: NameSchema,
          stop: z.boolean().optional(),

          force: z.boolean().optional(),
          targetStorage: z.enum(['xfs', 'zfs']).optional(),
          target: WarmHostSchema.optional(),
        }),
      )
      .output(MovePlanSchema),

    facts: base.output(WarmHostSchema),

    receive: base
      .input(
        z.object({
          name: NameSchema,
          bytes: z.int().nonnegative(),
          warm: WarmMoveSchema.optional(),
        }),
      )
      .output(MoveTicketSchema),

    send: base
      .input(z.object({ name: NameSchema, to: PeerUrlSchema, ticket: z.string() }))
      .output(MoveStatusSchema),

    status: base.input(z.object({ name: NameSchema })).output(MoveStatusSchema),

    reissue: base.input(z.object({ name: NameSchema })).output(MoveTicketSchema),

    resume: base
      .input(z.object({ name: NameSchema, ticket: z.string().optional() }))
      .output(MoveStatusSchema),

    abort: base.input(z.object({ name: NameSchema })).output(MoveStatusSchema),
  },

  checkpoints: {
    create: base.input(CheckpointCreateInputSchema).output(CheckpointSchema),

    list: base.input(NameInputSchema).output(z.array(CheckpointSchema)),

    restore: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(ImpSchema),

    delete: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(EmptySchema),
  },

  backups: {
    run: base.output(BackupRunSchema),

    list: base.output(BackupStatusSchema),

    restore: base
      .input(
        z.object({
          name: NameSchema.optional(),
          all: z.boolean().optional(),
          at: z.date().optional(),

          as: NameSchema.optional(),

          merge: z.boolean().optional(),
        }),
      )
      .output(BackupRestoreSchema),

    check: base.input(z.object({ subset: BackupCheckSubsetSchema.optional() })).output(EmptySchema),
  },

  images: {
    list: base.output(z.array(ImageSchema)),

    add: base.input(ImageAddInputSchema).output(ImageSchema),

    build: base.input(ImageBuildInputSchema).output(ImageSchema),

    addStream: base.input(ImageAddInputSchema).output(eventIterator(ImageOpEventSchema)),
    buildStream: base.input(ImageBuildInputSchema).output(eventIterator(ImageOpEventSchema)),

    builds: base.output(z.array(ImageBuildRunSchema)),

    delete: base.input(NameInputSchema).output(EmptySchema),

    pin: base.input(NameInputSchema).output(ImageSchema),
    unpin: base.input(NameInputSchema).output(ImageSchema),
  },

  exec: {
    ticket: base
      .input(NameInputSchema)
      .output(z.object({ ticket: z.string(), expiresAt: z.date() })),
  },

  sessions: {
    list: base.input(NameInputSchema).output(z.array(SessionSchema)),

    kill: base
      .input(z.object({ name: NameSchema, session: SessionNameSchema }))
      .output(EmptySchema),

    logs: base.input(SessionLogListInputSchema).output(z.array(SessionLogSchema)),

    readLog: base.input(SessionLogReadInputSchema).output(SessionLogReadSchema),

    deleteLog: base
      .input(SessionLogDeleteInputSchema)
      .output(z.object({ deleted: z.int().nonnegative() })),
  },

  services: {
    list: base.input(NameInputSchema).output(ServiceListSchema),

    add: base
      .input(
        z.object({
          name: NameSchema,
          service: ServiceDefSchema,
          replace: z.boolean().optional(),
        }),
      )
      .output(EmptySchema),

    remove: base
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    restart: base
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    logs: base
      .input(
        z.object({
          name: NameSchema,
          service: ServiceNameSchema.optional(),
          lines: z.int().min(0).max(SERVICE_LOG_MAX_LINES).optional(),
          follow: z.boolean().optional(),
        }),
      )
      .output(eventIterator(ServiceLogSchema)),
  },

  files: {
    write: base
      .input(z.object({ name: NameSchema, path: FilePathSchema, content: FileContentSchema }))
      .output(z.object({ path: z.string() })),

    remove: base
      .input(z.object({ name: NameSchema, path: FilePathSchema }))
      .output(z.object({ removed: z.boolean() })),
  },

  secrets: {
    add: base
      .input(
        z.object({
          name: SecretNameSchema,
          kind: SecretKindSchema,
          value: SecretValueSchema,
          rules: z.array(BrokerRuleSchema).min(1).max(16).optional(),
          oauth: OAuthConfigSchema.optional(),
          replace: z.boolean().optional(),
          rebind: z.boolean().optional(),
        }),
      )
      .output(SecretAddedSchema),

    list: base.output(z.array(SecretSchema)),

    refresh: base.input(z.object({ name: SecretNameSchema })).output(SecretSchema),

    delete: base.input(z.object({ name: SecretNameSchema })).output(EmptySchema),
  },

  networks: {
    list: base.output(z.array(NetworkSchema)),

    create: base.input(NameInputSchema).output(NetworkSchema),

    delete: base.input(NameInputSchema).output(EmptySchema),

    join: base.input(z.object({ network: NameSchema, name: NameSchema })).output(NetworkJoinSchema),

    warnings: base.input(NameInputSchema).output(z.array(z.string())),

    leave: base.input(z.object({ network: NameSchema, name: NameSchema })).output(NetworkSchema),
  },

  grants: {
    add: base
      .input(
        z.object({
          name: NameSchema,
          secret: SecretNameSchema,
          filter: GrantFilterSchema.optional(),
        }),
      )
      .output(EmptySchema),

    delete: base
      .input(z.object({ name: NameSchema, secret: SecretNameSchema }))
      .output(EmptySchema),

    list: base.input(NameInputSchema).output(z.array(SecretNameSchema)),

    details: base.input(NameInputSchema).output(z.array(GrantSchema)),
  },

  audit: {
    list: base
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(AuditEntrySchema)),

    refused: base
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(RefusedRequestSchema)),

    calls: base
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(ApiCallSchema)),
  },

  events: {
    stream: base.output(eventIterator(ImpEventSchema)),
  },

  system: {
    info: base.output(SystemInfoSchema),

    features: base.output(SystemFeaturesInfoSchema),

    gc: base
      .input(
        z.object({
          dryRun: z.boolean().optional(),
          orphans: z.boolean().optional(),

          secretFiles: z.boolean().optional(),
          removeSecretFiles: z.boolean().optional(),
        }),
      )
      .output(StorageGcSchema),

    copyDatabase: base.input(z.object({ name: NameSchema.optional() })).output(DatabaseCopySchema),
  },

  oauth: {
    clients: {
      list: base.output(z.array(OAuthClientSchema)),

      add: base
        .input(z.object({ name: NameSchema, redirectUris: RedirectUrisSchema }))
        .output(OAuthClientSchema),

      update: base
        .input(z.object({ name: NameSchema, redirectUris: RedirectUrisSchema }))
        .output(OAuthClientSchema),

      delete: base.input(NameInputSchema).output(EmptySchema),
    },

    grants: {
      list: base.output(z.array(OAuthGrantSchema)),

      delete: base.input(z.object({ id: z.string().min(1).max(64) })).output(EmptySchema),
    },

    // Only a named token approves a sign-in, and never with more than its own
    // scope and imps.
    approvals: {
      get: base.input(z.object({ code: ApprovalCodeSchema })).output(OAuthApprovalSchema),
      approve: base
        .input(
          z.object({
            code: ApprovalCodeSchema,
            scope: ScopeSchema,

            // Left out, the grant takes the approver's own imp patterns.
            imps: z.array(GrantPatternSchema).min(1).max(32).optional(),
          }),
        )
        .output(EmptySchema),
    },
  },

  tokens: tokensContract,
};

export type CallerContract = typeof callerContract;
