import type { HttpsService, RecordsStatus } from './https-service';

export interface PublicRecordsLink {
  readonly attach: (
    service: Pick<HttpsService, 'updatePublicRecords' | 'readRecordsStatus'>,
  ) => void;
  readonly update: () => Promise<RecordsStatus | null>;
  readonly readStatus: () => RecordsStatus | null;
}

export function createPublicRecordsLink(): PublicRecordsLink {
  let attached: Pick<HttpsService, 'updatePublicRecords' | 'readRecordsStatus'> | null = null;

  return {
    attach: (service) => {
      attached = service;
    },
    update: () => (attached === null ? Promise.resolve(null) : attached.updatePublicRecords()),
    readStatus: () => attached?.readRecordsStatus() ?? null,
  };
}
