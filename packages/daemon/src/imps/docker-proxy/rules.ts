import { checkRegistry } from '../docker-contract/check-registry';
import { parseImageReference } from '../docker-contract/parse-image-reference';

export type Check = { readonly isOk: true } | { readonly isOk: false; readonly reason: string };

const OK: Check = { isOk: true };

function buildFailure(reason: string): Check {
  return { isOk: false, reason };
}

interface ParamRule {
  readonly isRequired?: boolean;
  readonly isRepeatable?: boolean;
  readonly check: (value: string) => string | null;
}

function checkOneOf(allowed: ReadonlySet<string>): (value: string) => string | null {
  return (value) => (allowed.has(value) ? null : `is ${JSON.stringify(value)}`);
}

function checkQuery(
  query: ReadonlyMap<string, readonly string[]>,
  rules: Readonly<Record<string, ParamRule>>,
): Check {
  for (const [key, values] of query) {
    const rule = rules[key];

    if (rule === undefined) {
      return buildFailure(`param ${key} is not allowed`);
    }

    if (values.length > 1 && rule.isRepeatable !== true) {
      return buildFailure(`param ${key} is given ${String(values.length)} times`);
    }

    for (const value of values) {
      const problem = rule.check(value);

      if (problem !== null) {
        return buildFailure(`param ${key} ${problem}`);
      }
    }
  }

  for (const [key, rule] of Object.entries(rules)) {
    if (rule.isRequired === true && !query.has(key)) {
      return buildFailure(`param ${key} is missing`);
    }
  }

  return OK;
}

/* @internal */
export function checkImageReference(reference: string, hostImage: string): Check {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@\[\]\-]*$/v.test(reference)) {
    return buildFailure(`image ${JSON.stringify(reference)} is not a reference`);
  }

  const image = parseImageReference(reference);
  const problem = checkRegistry(image.registry);

  if (problem !== null) {
    return buildFailure(problem);
  }

  const host = parseImageReference(hostImage);

  if (image.registry === host.registry && image.path === host.path) {
    return buildFailure(`image ${reference} is the repository imp-host runs from`);
  }

  return OK;
}

function checkTag(value: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}$|^sha256:[a-f0-9]{64}$/v.test(value)
    ? null
    : `is ${JSON.stringify(value)}`;
}

// The docker CLI sends a pull by digest with the digest as the tag param, and the engine pulls
// fromImage's repository at the tag alone.
function checkPullOnly(fromImage: string, tag: string, pullOnly: string): Check {
  const image = parseImageReference(fromImage);
  const only = parseImageReference(pullOnly);

  if (image.registry === only.registry && image.path === only.path && tag === only.digest) {
    return OK;
  }

  return buildFailure(
    `a pull of ${fromImage}:${tag} is refused: the proxy pulls only IMP_BUILD_IMAGE, ${pullOnly}`,
  );
}

export function checkPullQuery(
  query: ReadonlyMap<string, readonly string[]>,
  hostImage: string,
  pullOnly: string,
): Check {
  const checked = checkQuery(query, {
    fromImage: { isRequired: true, check: () => null },

    // The engine pulls every tag of the repository when a pull names no tag.
    tag: { isRequired: true, check: checkTag },
  });

  if (!checked.isOk) {
    return checked;
  }

  const fromImage = query.get('fromImage')?.[0] ?? '';
  const reference = checkImageReference(fromImage, hostImage);

  if (!reference.isOk) {
    return reference;
  }

  return checkPullOnly(fromImage, query.get('tag')?.[0] ?? '', pullOnly);
}

export function checkRemoveQuery(query: ReadonlyMap<string, readonly string[]>): Check {
  return checkQuery(query, { force: { check: checkOneOf(new Set(['0', '1', 'true', 'false'])) } });
}

export function checkNoQuery(query: ReadonlyMap<string, readonly string[]>): Check {
  return checkQuery(query, {});
}

const CREATE_DEFAULTS: Readonly<Record<string, unknown>> = {
  AttachStdout: true,
  AttachStderr: true,
};

const HOST_CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  NetworkMode: 'default',
  RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
  MemorySwappiness: -1,
};

// In these Docker API maps the key is the setting, so `{"/x": {}}` declares a volume.
const MAP_KEYS = new Set([
  'Volumes',
  'Labels',
  'ExposedPorts',
  'PortBindings',
  'Tmpfs',
  'StorageOpt',
  'Sysctls',
]);

function isEmptyValue(value: unknown, key = ''): boolean {
  if (value === null || value === false || value === 0 || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isEmptyValue(item));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);

    return MAP_KEYS.has(key)
      ? entries.length === 0
      : entries.every(([name, item]) => isEmptyValue(item, name));
  }

  return false;
}

function findNonDefaultKey(
  object: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>,
  skip: ReadonlySet<string>,
): string | null {
  for (const [key, value] of Object.entries(object)) {
    if (skip.has(key) || isEmptyValue(value, key)) {
      continue;
    }

    if (!(key in defaults) || !Bun.deepEquals(value, defaults[key])) {
      return key;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkCreateOnly(image: string, builderImage: string): Check {
  const named = parseImageReference(image);
  const only = parseImageReference(builderImage);

  if (
    named.registry === only.registry &&
    named.path === only.path &&
    named.digest !== null &&
    named.digest === only.digest
  ) {
    return OK;
  }

  return buildFailure(
    `a create from ${image} is refused: the proxy creates only from IMP_BUILD_IMAGE, ${builderImage}`,
  );
}

export function checkCreateBody(
  body: unknown,
  hostImage: string,
  builderImage: string,
): Check & { readonly image?: string } {
  if (!isRecord(body)) {
    return buildFailure('the body is not a JSON object');
  }

  const image = body['Image'];

  if (typeof image !== 'string') {
    return buildFailure('Image is missing');
  }

  if (!Bun.deepEquals(body['Cmd'], ['/bin/true'])) {
    return buildFailure(`Cmd is ${JSON.stringify(body['Cmd'])}, not ["/bin/true"]`);
  }

  const topKey = findNonDefaultKey(body, CREATE_DEFAULTS, new Set(['Image', 'Cmd', 'HostConfig']));

  if (topKey !== null) {
    return buildFailure(`${topKey} is set`);
  }

  const hostConfig = body['HostConfig'] ?? {};

  if (!isRecord(hostConfig)) {
    return buildFailure('HostConfig is not an object');
  }

  const hostKey = findNonDefaultKey(hostConfig, HOST_CONFIG_DEFAULTS, new Set());

  if (hostKey !== null) {
    return buildFailure(`HostConfig.${hostKey} is set`);
  }

  const reference = checkImageReference(image, hostImage);

  if (!reference.isOk) {
    return reference;
  }

  const only = checkCreateOnly(image, builderImage);

  return only.isOk ? { isOk: true, image } : only;
}
