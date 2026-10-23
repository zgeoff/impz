import { parseImageReference } from './parse-image-reference';

// The engine pulls from the host's network, so a loopback, link-local or IP-literal registry
// would reach a service on the host.
export function checkRegistry(registry: string): string | null {
  const host = readRegistryHost(registry).toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `registry ${registry} is the host's own`;
  }

  if (/^[0-9.]+$/v.test(host) || host.includes(':')) {
    return `registry ${registry} is an IP address`;
  }

  return null;
}

export function checkReferenceRegistry(reference: string): string | null {
  return checkRegistry(parseImageReference(reference).registry);
}

function readRegistryHost(registry: string): string {
  if (registry.startsWith('[')) {
    return registry.slice(1, registry.indexOf(']'));
  }

  return registry.split(':')[0] ?? '';
}
