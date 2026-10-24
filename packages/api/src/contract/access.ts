import type { ProcedureMeta } from './contract-base';

const IMP = ['name'];

export const ACCESS = {
  noSession: { access: { on: 'none' } },
  readAny: { access: { scope: 'read', on: 'any' } },
  readHost: { access: { scope: 'read', on: 'host' } },
  readImp: { access: { scope: 'read', on: 'imp', fields: IMP } },
  execImp: { access: { scope: 'exec', on: 'imp', fields: IMP } },
  manageImp: { access: { scope: 'manage', on: 'imp', fields: IMP } },
  manageImpNoGrantable: { access: { scope: 'manage', on: 'imp', fields: IMP, noGrantable: true } },
  manageHost: { access: { scope: 'manage', on: 'host' } },
  manageImage: { access: { scope: 'manage', on: 'image' } },
  manageHeldImage: { access: { scope: 'manage', on: 'image', held: true } },
  manageGrant: { access: { scope: 'manage', on: 'grant', fields: IMP, secretField: 'secret' } },
} as const satisfies Record<string, ProcedureMeta>;
