import { getConfig } from '@logtape/logtape';
import type { LogLevel } from '@logtape/logtape';
import { getImpdLogger } from './get-impd-logger';

const AREAS = new Set([
  'api',
  'audit',
  'backup',
  'boot',
  'broker',
  'cgroup',
  'credential',
  'disk',
  'egress',
  'events',
  'gc',
  'governor',
  'https',
  'idle',
  'image',
  'ipv6',
  'jail',
  'memory',
  'move',
  'oauth',
  'proxy',
  'public',
  'rpc',
  'session',
  'ssh',
  'stop',
  'storage',
  'tailnet',
  'warning',
  'xfs',
  'zfs',
]);

const IMP_AREA = 'imps';

interface LegacyLine {
  readonly area: string | undefined;
  readonly imp: string | undefined;
  readonly level: LogLevel;
}

export function printLog(message: string): void {
  if (getConfig() === null) {
    console.log(message);

    return;
  }

  const line = parseLegacyLine(message);
  const logger = getImpdLogger(line.area);

  // LogTape reads braces in a message as placeholders, so the text goes in as
  // one value
  (line.imp === undefined ? logger : logger.with({ imp: line.imp }))[line.level]('{line}', {
    line: message,
  });
}

export function parseLegacyLine(message: string): LegacyLine {
  const head = /^impd: (?<word>[\w.\-]+)(?<colon>:?)/v.exec(message)?.groups;
  const word = head?.['word'];

  return {
    ...pickAreaAndImp(word, head?.['colon'] === ':'),
    level: pickLevel(message),
  };
}

function pickAreaAndImp(
  word: string | undefined,
  hasColon: boolean,
): Pick<LegacyLine, 'area' | 'imp'> {
  if (word === undefined) {
    return { area: undefined, imp: undefined };
  }

  if (AREAS.has(word)) {
    return { area: word, imp: undefined };
  }

  return hasColon ? { area: IMP_AREA, imp: word } : { area: undefined, imp: undefined };
}

function pickLevel(message: string): LogLevel {
  if (/\bERROR\b|\bNO FIREWALL\b/v.test(message)) {
    return 'error';
  }

  if (/\bWARNING\b|\bwarning:|\bfailed\b|\bcould not\b|\bcannot\b|\brefused\b/v.test(message)) {
    return 'warning';
  }

  return 'info';
}
