import type { DnsProvider } from './dns-provider';

export function createChalltestsrvProvider(apiUrl: string): DnsProvider {
  // challtestsrv has no list call, so a restarted impd forgets its records,
  // and they stay until challtestsrv restarts
  const records = new Map<string, { readonly owner: string; readonly ip: string }>();

  const sendCommand = async (path: string, body: unknown): Promise<void> => {
    const response = await fetch(new URL(path, apiUrl), {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`challtestsrv ${path}: ${String(response.status)}`);
    }
  };

  return {
    addTxt: async (fqdn, value) => {
      await sendCommand('/set-txt', { host: `${fqdn}.`, value });

      return { fqdn, value, id: value };
    },

    // challtestsrv clears every value of the name at once
    removeTxt: async (record) => {
      await sendCommand('/clear-txt', { host: `${record.fqdn}.` });
    },

    waitForTxt: () => Promise.resolve(),
    setA: async (fqdn, ip, owner = 'managed by impd') => {
      await sendCommand('/add-a', { host: `${fqdn}.`, addresses: [ip] });

      records.set(fqdn, { owner, ip });
    },
    listA: (domain, owner) => {
      const found = [...records]
        .filter(([fqdn, record]) => fqdn.endsWith(`.${domain}`) && record.owner === owner)
        .map(([fqdn, record]) => [fqdn, record.ip] as const);

      return Promise.resolve(new Map(found));
    },
    removeA: async (fqdn, owner) => {
      if (records.get(fqdn)?.owner !== owner) {
        return;
      }

      await sendCommand('/clear-a', { host: `${fqdn}.` });

      records.delete(fqdn);
    },
  };
}
