import * as z from 'zod';
import { BasicUserSchema } from './exposure-schema';
import { NameSchema } from './name-schema';

// impd keeps each value in a file named for the secret, so a name is never a
// path or a flag.
export const SecretNameSchema = NameSchema;

// Every API token is printable ASCII, and a value with CR or LF could split
// the header impd sets from it.
const PrintableSchema = z.string().regex(/^[!-~]+$/u, 'must be printable ASCII without spaces');

export const SecretValueSchema = PrintableSchema.min(1).max(8192);

/* @internal */
export const BrokerHostSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/u,
    'must be a lowercase hostname such as api.example.com',
  );

const BrokerUpstreamSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    const url = URL.parse(value);

    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      context.addIssue({ code: 'custom', message: 'must be an http or https URL' });

      return z.NEVER;
    }

    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'must not hold a user name or password' });

      return z.NEVER;
    }

    if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
      context.addIssue({ code: 'custom', message: 'must not have a query or a fragment' });

      return z.NEVER;
    }

    if (url.pathname !== '/') {
      context.addIssue({ code: 'custom', message: 'must be an origin with no path' });

      return z.NEVER;
    }

    return url.origin;
  });

// Some frameworks run the method one of these names in place of the
// request's own, so on a filtered grant they could turn an allowed POST into
// a method the filter refused.
export const METHOD_OVERRIDE_HEADERS: readonly string[] = [
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
];

export const BrokerRuleSchema = z.object({
  host: BrokerHostSchema,
  header: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u, 'must be a lowercase header name such as authorization')
    .superRefine((header, context) => {
      if (METHOD_OVERRIDE_HEADERS.includes(header)) {
        context.addIssue({
          code: 'custom',
          message: `must not be ${header}, which overrides the request's method`,
        });
      }
    }),
  scheme: z.enum(['bearer', 'basic', 'raw']),
  user: BasicUserSchema.optional(),
  upstream: BrokerUpstreamSchema.optional(),
});

export type BrokerRule = z.infer<typeof BrokerRuleSchema>;

export const SecretPresetSchema = z.enum(['github', 'anthropic', 'npm']);

export type SecretPreset = z.infer<typeof SecretPresetSchema>;

export const SecretKindSchema = z.enum([...SecretPresetSchema.options, 'custom', 'oauth']);

export type SecretKind = z.infer<typeof SecretKindSchema>;

export const OAuthConfigSchema = z.object({
  tokenUrl: z.url({ protocol: /^https$/u }).max(2048),
  clientId: PrintableSchema.min(1).max(256),
  tokenFormat: z.enum(['json', 'form']).default('form'),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

// Never a token: any token able to list secrets sees this state, so the ID
// token appears only as its claims.
const OAuthStateSchema = OAuthConfigSchema.extend({
  status: z.enum(['pending', 'ready', 'needs_login']),
  expiresAt: z.date().nullable(),
  refreshedAt: z.date().nullable(),
  error: z.string().nullable(),
  idClaims: z.record(z.string(), z.unknown()).readonly().nullable(),
});

export const BROKER_ENV_NAMES: readonly string[] = [
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

// The guest's tools read these names, and some, such as gh, refuse to send a
// request while their variable is unset. A placeholder set after the broker's
// own variables would replace its proxy or its CA.
export const SecretEnvSchema = z
  .array(
    z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/u, 'must be an upper-case variable name')
      .refine((name) => !BROKER_ENV_NAMES.includes(name), 'must not be a variable the broker sets'),
  )
  .max(16)
  .readonly();

// A secret's value never leaves impd.
export const SecretSchema = z.object({
  name: SecretNameSchema,
  kind: SecretKindSchema,
  rules: z.array(BrokerRuleSchema).readonly(),
  env: SecretEnvSchema,

  imps: z.array(NameSchema).readonly(),
  createdAt: z.date(),

  oauth: OAuthStateSchema.optional(),
});

export type Secret = z.infer<typeof SecretSchema>;

export const SecretAddedSchema = SecretSchema.extend({
  droppedGrants: z.int().nonnegative().default(0),
});

export type SecretAdded = z.infer<typeof SecretAddedSchema>;

const GrantMethodSchema = z
  .string()
  .regex(/^[A-Z]{1,16}$/u, 'must be an uppercase method such as GET');

// No `%`, because a pattern matches the path as the URL parser leaves it.
const GrantPathSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:\/(?:\*|[A-Za-z0-9._~!$&'()+,;=:@-]*))*(?:\/\*\*)?$/u,
    'must be a path such as /v1/messages, with * for one segment and a last /** for the rest',
  )
  .refine((path) => path.startsWith('/'), 'must start with /');

export const GrantFilterSchema = z
  .object({
    methods: z.array(GrantMethodSchema).min(1).max(16).readonly().optional(),
    paths: z.array(GrantPathSchema).min(1).max(64).readonly().optional(),
  })
  .refine(
    (filter) => filter.methods !== undefined || filter.paths !== undefined,
    'must name methods, paths or both',
  );

export type GrantFilter = z.infer<typeof GrantFilterSchema>;

export const GrantSchema = z.object({
  secret: SecretNameSchema,
  filter: GrantFilterSchema.nullable(),
});

export type Grant = z.infer<typeof GrantSchema>;

const AuditRefusalSchema = z.enum([
  'not-http',
  'not-connect',
  'bad-target',

  'connection-limit',

  'egress-policy',

  'address-refused',

  'wrong-host',

  'websocket',

  'no-grant',

  'outside-filter',
]);

export type AuditRefusal = z.infer<typeof AuditRefusalSchema>;

export const AuditEntrySchema = z.object({
  at: z.date(),
  imp: NameSchema,
  secret: SecretNameSchema,
  method: z.string(),
  host: BrokerHostSchema,
  path: z.string(),

  status: z.int(),
  requestBytes: z.int().nonnegative(),
  responseBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const RefusedRequestSchema = z.object({
  at: z.date(),
  imp: NameSchema,

  method: z.string().nullable(),

  host: z.string().max(253).nullable(),

  path: z.string().nullable(),

  status: z.int(),
  durationMs: z.int().nonnegative(),
  reason: AuditRefusalSchema,
});

export type RefusedRequest = z.infer<typeof RefusedRequestSchema>;
