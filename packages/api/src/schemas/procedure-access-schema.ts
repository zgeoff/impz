import * as z from 'zod';
import { ScopeSchema } from './token-schema';

const FieldsSchema = z.array(z.string()).readonly();

// A call that needs no session, such as the login that makes one.
const NoSessionAccessSchema = z.object({ on: z.literal('none') });

const HostAccessSchema = z.object({
  scope: ScopeSchema,
  on: z.literal('host'),
  audit: z.union([z.literal(false), z.literal('refusals')]).optional(),
});

const ImpAccessSchema = z.object({
  scope: ScopeSchema,
  on: z.literal('imp'),
  fields: FieldsSchema,
  noGrantable: z.literal(true).optional(),
  audit: z.literal(false).optional(),
});

const GrantAccessSchema = z.object({
  scope: ScopeSchema,
  on: z.literal('grant'),
  fields: FieldsSchema,
  secretField: z.string(),
  audit: z.literal(false).optional(),
});

const ImageAccessSchema = z.object({
  scope: ScopeSchema,
  on: z.literal('image'),
  audit: z.union([z.literal(false), z.literal('refusals')]).optional(),
});

const AnyAccessSchema = z.object({
  scope: ScopeSchema,
  on: z.literal('any'),
  audit: z.literal(false).optional(),
});

export const ProcedureAccessSchema = z.discriminatedUnion('on', [
  NoSessionAccessSchema,
  HostAccessSchema,
  ImpAccessSchema,
  GrantAccessSchema,
  ImageAccessSchema,
  AnyAccessSchema,
]);

export type ProcedureAccess = z.infer<typeof ProcedureAccessSchema>;

export type CallerAccess = Exclude<ProcedureAccess, { readonly on: 'none' }>;
