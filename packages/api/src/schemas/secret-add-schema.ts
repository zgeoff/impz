import * as z from 'zod';
import {
  BrokerRuleSchema,
  OAuthConfigSchema,
  SecretEnvSchema,
  SecretKindSchema,
  SecretNameSchema,
  SecretPresetSchema,
  SecretValueSchema,
} from './secret-schema';

const SecretRulesSchema = z
  .array(BrokerRuleSchema, {
    error: (issue) => (issue.input === undefined ? 'needs at least one host' : undefined),
  })
  .min(1, 'needs at least one host')
  .max(16)
  .superRefine((rules, context) => {
    const hosts = rules.map((rule) => rule.host);
    const repeated = hosts.find((host, index) => hosts.indexOf(host) !== index);

    if (repeated !== undefined) {
      context.addIssue({ code: 'custom', message: `${repeated} has more than one rule` });
    }
  })
  .readonly();

// Strict, so a field that another shape owns, such as rules on a preset, is
// refused rather than dropped unread.
const StaticBindingSchema = z.strictObject({
  kind: z.literal('static'),
  rules: SecretRulesSchema,
  env: SecretEnvSchema.optional(),
});

const OAuthBindingSchema = z.strictObject({
  kind: z.literal('oauth'),
  rules: SecretRulesSchema.refine(
    (rules) => rules.every((rule) => rule.upstream === undefined),
    'an oauth secret cannot have an upstream; it is for kind static',
  ),
  env: SecretEnvSchema.optional(),
  oauth: OAuthConfigSchema,
});

// An impz older than presets names the preset as the kind, and a static
// secret as `custom`.
const OldPresetBindingSchema = z.strictObject({ kind: SecretPresetSchema });

export const SecretAddKindSchema = z.enum([
  ...SecretKindSchema.options,
  ...SecretPresetSchema.options,
  'custom',
]);

const OldCustomBindingSchema = z.strictObject({
  kind: z.literal('custom'),
  rules: SecretRulesSchema,
});

// A preset names no kind, which keeps one discriminated union: a plain union
// reports only "Invalid input" when every branch fails.
const PresetBindingSchema = z.strictObject({
  kind: z.undefined().optional(),
  preset: SecretPresetSchema,
});

export const SecretBindingSchema = z.discriminatedUnion('kind', [
  StaticBindingSchema,
  OAuthBindingSchema,
  PresetBindingSchema,
  OldPresetBindingSchema,
  OldCustomBindingSchema,
]);

export type SecretBinding = z.infer<typeof SecretBindingSchema>;

const AddFields = {
  name: SecretNameSchema,
  value: SecretValueSchema,
  replace: z.boolean().optional(),
  rebind: z.boolean().optional(),
};

export const SecretAddSchema = z.discriminatedUnion('kind', [
  StaticBindingSchema.extend(AddFields),
  OAuthBindingSchema.extend(AddFields),
  PresetBindingSchema.extend(AddFields),
  OldPresetBindingSchema.extend(AddFields),
  OldCustomBindingSchema.extend(AddFields),
]);

export type SecretAdd = z.infer<typeof SecretAddSchema>;

export type SecretAddKind = z.infer<typeof SecretAddKindSchema>;
