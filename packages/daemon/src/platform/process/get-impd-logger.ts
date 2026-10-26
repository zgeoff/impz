import { getLogger } from '@logtape/logtape';
import type { Logger } from '@logtape/logtape';

export type ImpdArea =
  | 'api'
  | 'audit'
  | 'backup'
  | 'boot'
  | 'broker'
  | 'cgroup'
  | 'disk'
  | 'egress'
  | 'events'
  | 'gc'
  | 'governor'
  | 'https'
  | 'image'
  | 'imps'
  | 'ipv6'
  | 'jail'
  | 'memory'
  | 'move'
  | 'oauth'
  | 'proxy'
  | 'public'
  | 'session'
  | 'ssh'
  | 'stop'
  | 'storage'
  | 'tailnet'
  | 'ticker'
  | 'xfs'
  | 'zfs';

export function getImpdLogger(area: ImpdArea): Logger {
  return getLogger(['impd', area]);
}
