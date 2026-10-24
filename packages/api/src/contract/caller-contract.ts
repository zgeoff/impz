import { eventIterator } from '@orpc/contract';
import * as z from 'zod';
import { DockerfilePathSchema } from '../protocols/build-context-protocol';
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
import { ImageOpEventSchema } from '../schemas/image-op-event-schema';
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
import { ACCESS } from './access';
import { contractBase as base } from './contract-base';
import { impsContract } from './imps-contract';
import { tokensContract } from './tokens-contract';

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

// An upload names its image and Dockerfile when it sends the context.
const ImageBuildStreamInputSchema = z.union([
  ImageBuildInputSchema,
  z.object({ upload: z.string().min(1), logs: z.boolean().optional() }),
]);

export const CheckpointCreateInputSchema = z.object({
  name: NameSchema,
  label: z.string().min(1).max(64).optional(),
});

// every procedure that answers an authenticated caller
export const callerContract = {
  imps: impsContract,

  leases: {
    acquire: base.meta(ACCESS.execImp).input(LeaseInputSchema).output(LeaseSchema),

    renew: base.meta(ACCESS.execImp).input(LeaseInputSchema).output(LeaseSchema),

    release: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, label: LeaseLabelSchema }))
      .output(z.object({ released: z.boolean() })),

    list: base
      .meta({ access: { scope: 'exec', on: 'any', audit: false } })
      .input(z.object({ name: NameSchema.optional(), label: LeaseLabelSchema.optional() }))
      .output(z.array(LeaseSchema)),
  },

  // a move hands the whole imp, its disk and checkpoints, to another host;
  // on the target a ticket takes in an image and grants, which are host-wide
  moves: {
    prepare: base
      .meta(ACCESS.manageImpNoGrantable)
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

    facts: base.meta(ACCESS.manageHost).output(WarmHostSchema),

    receive: base
      .meta(ACCESS.manageHost)
      .input(
        z.object({
          name: NameSchema,
          bytes: z.int().nonnegative(),
          warm: WarmMoveSchema.optional(),
        }),
      )
      .output(MoveTicketSchema),

    send: base
      .meta(ACCESS.manageImpNoGrantable)
      .input(z.object({ name: NameSchema, to: PeerUrlSchema, ticket: z.string() }))
      .output(MoveStatusSchema),

    status: base
      .meta(ACCESS.readImp)
      .input(z.object({ name: NameSchema }))
      .output(MoveStatusSchema),

    reissue: base
      .meta(ACCESS.manageHost)
      .input(z.object({ name: NameSchema }))
      .output(MoveTicketSchema),

    resume: base
      .meta(ACCESS.manageImpNoGrantable)
      .input(z.object({ name: NameSchema, ticket: z.string().optional() }))
      .output(MoveStatusSchema),

    abort: base
      .meta(ACCESS.manageImp)
      .input(z.object({ name: NameSchema }))
      .output(MoveStatusSchema),
  },

  checkpoints: {
    create: base.meta(ACCESS.manageImp).input(CheckpointCreateInputSchema).output(CheckpointSchema),

    list: base.meta(ACCESS.readImp).input(NameInputSchema).output(z.array(CheckpointSchema)),

    restore: base
      .meta(ACCESS.manageImp)
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(ImpSchema),

    delete: base
      .meta(ACCESS.manageImp)
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(EmptySchema),
  },

  // a backup holds every imp; a restore can replace any of them
  backups: {
    run: base.meta(ACCESS.manageHost).output(BackupRunSchema),

    list: base.meta(ACCESS.readHost).output(BackupStatusSchema),

    restore: base
      .meta(ACCESS.manageHost)
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

    check: base
      .meta(ACCESS.manageHost)
      .input(z.object({ subset: BackupCheckSubsetSchema.optional() }))
      .output(EmptySchema),
  },

  images: {
    list: base.meta(ACCESS.readAny).output(z.array(ImageSchema)),

    // an image is the host's, but a token for some imps may add, pin and
    // unpin one under its own names from the registry path it was given; a
    // build, a template or a delete stays host-wide
    add: base.meta(ACCESS.manageImage).input(ImageAddInputSchema).output(ImageSchema),

    build: base.meta(ACCESS.manageHost).input(ImageBuildInputSchema).output(ImageSchema),

    addStream: base
      .meta({ access: { scope: 'manage', on: 'image', audit: 'refusals' } })
      .input(ImageAddInputSchema)
      .output(eventIterator(ImageOpEventSchema)),
    buildStream: base
      .meta({ access: { scope: 'manage', on: 'host', audit: 'refusals' } })
      .input(ImageBuildStreamInputSchema)
      .output(eventIterator(ImageOpEventSchema)),

    // a running build's steps show its Dockerfile's commands: host-wide
    builds: base.meta(ACCESS.readHost).output(z.array(ImageBuildRunSchema)),

    delete: base.meta(ACCESS.manageHost).input(NameInputSchema).output(EmptySchema),

    pin: base.meta(ACCESS.manageHeldImage).input(NameInputSchema).output(ImageSchema),
    unpin: base.meta(ACCESS.manageHeldImage).input(NameInputSchema).output(ImageSchema),
  },

  exec: {
    ticket: base
      .meta({ access: { scope: 'exec', on: 'imp', fields: ['name'], audit: false } })
      .input(NameInputSchema)
      .output(z.object({ ticket: z.string(), expiresAt: z.date() })),
  },

  sessions: {
    list: base.meta(ACCESS.readImp).input(NameInputSchema).output(z.array(SessionSchema)),

    kill: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, session: SessionNameSchema }))
      .output(EmptySchema),

    // a session's output can hold anything its program printed: reading or
    // deleting it is for those who may attach, and each read is audited
    logs: base
      .meta(ACCESS.readImp)
      .input(SessionLogListInputSchema)
      .output(z.array(SessionLogSchema)),

    readLog: base
      .meta(ACCESS.execImp)
      .input(SessionLogReadInputSchema)
      .output(SessionLogReadSchema),

    deleteLog: base
      .meta(ACCESS.execImp)
      .input(SessionLogDeleteInputSchema)
      .output(z.object({ deleted: z.int().nonnegative() })),
  },

  // a service runs a command as an exec does, and its log can hold
  // anything the command prints
  services: {
    list: base.meta(ACCESS.readImp).input(NameInputSchema).output(ServiceListSchema),

    add: base
      .meta(ACCESS.execImp)
      .input(
        z.object({
          name: NameSchema,
          service: ServiceDefSchema,
          replace: z.boolean().optional(),
        }),
      )
      .output(EmptySchema),

    remove: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    restart: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    logs: base
      .meta(ACCESS.execImp)
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

  // whoever may run a command in the imp may write a file there as root
  files: {
    write: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, path: FilePathSchema, content: FileContentSchema }))
      .output(z.object({ path: z.string() })),

    remove: base
      .meta(ACCESS.execImp)
      .input(z.object({ name: NameSchema, path: FilePathSchema }))
      .output(z.object({ removed: z.boolean() })),
  },

  // secrets belong to the host: a grant hands one to an imp, so a token
  // limited to some imps could grant itself any secret
  secrets: {
    add: base
      .meta(ACCESS.manageHost)
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

    list: base.meta(ACCESS.readAny).output(z.array(SecretSchema)),

    refresh: base
      .meta(ACCESS.manageHost)
      .input(z.object({ name: SecretNameSchema }))
      .output(SecretSchema),

    delete: base
      .meta(ACCESS.manageHost)
      .input(z.object({ name: SecretNameSchema }))
      .output(EmptySchema),
  },

  // a member reaches every other imp on the network, so a token limited to
  // some imps could reach past them; list shows the caller's imps only
  networks: {
    list: base.meta(ACCESS.readAny).output(z.array(NetworkSchema)),

    create: base.meta(ACCESS.manageHost).input(NameInputSchema).output(NetworkSchema),

    delete: base.meta(ACCESS.manageHost).input(NameInputSchema).output(EmptySchema),

    join: base
      .meta(ACCESS.manageHost)
      .input(z.object({ network: NameSchema, name: NameSchema }))
      .output(NetworkJoinSchema),

    warnings: base.meta(ACCESS.readImp).input(NameInputSchema).output(z.array(z.string())),

    leave: base
      .meta(ACCESS.manageHost)
      .input(z.object({ network: NameSchema, name: NameSchema }))
      .output(NetworkSchema),
  },

  grants: {
    add: base
      .meta(ACCESS.manageGrant)
      .input(
        z.object({
          name: NameSchema,
          secret: SecretNameSchema,
          filter: GrantFilterSchema.optional(),
        }),
      )
      .output(EmptySchema),

    delete: base
      .meta(ACCESS.manageGrant)
      .input(z.object({ name: NameSchema, secret: SecretNameSchema }))
      .output(EmptySchema),

    list: base.meta(ACCESS.readImp).input(NameInputSchema).output(z.array(SecretNameSchema)),

    details: base.meta(ACCESS.readImp).input(NameInputSchema).output(z.array(GrantSchema)),
  },

  audit: {
    list: base
      .meta(ACCESS.readAny)
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(AuditEntrySchema)),

    refused: base
      .meta(ACCESS.readAny)
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(RefusedRequestSchema)),

    calls: base
      .meta(ACCESS.readAny)
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(ApiCallSchema)),
  },

  events: {
    stream: base.meta(ACCESS.readAny).output(eventIterator(ImpEventSchema)),
  },

  system: {
    info: base.meta(ACCESS.readAny).output(SystemInfoSchema),

    features: base.meta(ACCESS.readAny).output(SystemFeaturesInfoSchema),

    gc: base
      .meta(ACCESS.manageHost)
      .input(
        z.object({
          dryRun: z.boolean().optional(),
          orphans: z.boolean().optional(),

          secretFiles: z.boolean().optional(),
          removeSecretFiles: z.boolean().optional(),
        }),
      )
      .output(StorageGcSchema),

    // the copy holds every imp, token hash and grant
    copyDatabase: base
      .meta(ACCESS.manageHost)
      .input(z.object({ name: NameSchema.optional() }))
      .output(DatabaseCopySchema),
  },

  oauth: {
    clients: {
      list: base.meta(ACCESS.manageHost).output(z.array(OAuthClientSchema)),

      add: base
        .meta(ACCESS.manageHost)
        .input(z.object({ name: NameSchema, redirectUris: RedirectUrisSchema }))
        .output(OAuthClientSchema),

      update: base
        .meta(ACCESS.manageHost)
        .input(z.object({ name: NameSchema, redirectUris: RedirectUrisSchema }))
        .output(OAuthClientSchema),

      delete: base.meta(ACCESS.manageHost).input(NameInputSchema).output(EmptySchema),
    },

    grants: {
      list: base.meta(ACCESS.manageHost).output(z.array(OAuthGrantSchema)),

      delete: base
        .meta(ACCESS.manageHost)
        .input(z.object({ id: z.string().min(1).max(64) }))
        .output(EmptySchema),
    },

    // Only a named token approves a sign-in, and never with more than its own
    // scope and imps.
    approvals: {
      get: base
        .meta(ACCESS.readAny)
        .input(z.object({ code: ApprovalCodeSchema }))
        .output(OAuthApprovalSchema),
      approve: base
        .meta(ACCESS.readAny)
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
