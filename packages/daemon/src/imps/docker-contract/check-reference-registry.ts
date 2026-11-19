import { parseImageReference } from './parse-image-reference';

export function checkReferenceRegistry(reference: string): string | null {
  return checkRegistry(parseImageReference(reference).registry);
}

// A loopback, link-local or IP-literal registry would point a pull at a service on the host or
// a private network.
function checkRegistry(registry: string): string | null {
  const host = readRegistryHost(registry).toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `registry ${registry} is the host's own`;
  }

  if (/^[0-9.]+$/v.test(host) || host.includes(':')) {
    return `registry ${registry} is an IP address`;
  }

  return null;
}

function readRegistryHost(registry: string): string {
  if (registry.startsWith('[')) {
    return registry.slice(1, registry.indexOf(']'));
  }

  return registry.split(':')[0] ?? '';
}
