import { lazy } from 'gunshi';
import { backupCommand } from '../commands/backup-command';
import {
  checkpointCommand,
  checkpointsCommand,
  restoreCommand,
} from '../commands/checkpoints-command';
import { cpCommand } from '../commands/cp-command';
import { setCommand, topCommand } from '../commands/cpu-command';
import { dbCommand } from '../commands/db-command';
import { diskCommand } from '../commands/disk-command';
import { eventsCommand } from '../commands/events-command';
import { exposeCommand, unexposeCommand } from '../commands/expose-command';
import { gcCommand } from '../commands/gc-command';
import { hostCommand, hostsCommand, loginCommand } from '../commands/hosts-command';
import { imageCommand, templateCommand } from '../commands/image-command';
import {
  consoleCommand,
  execCommand,
  forkCommand,
  holdCommand,
  lsCommand,
  policyCommand,
  rmCommand,
  sleepCommand,
  startCommand,
  stopCommand,
  urlCommand,
  wakeCommand,
} from '../commands/imps-command';
import { infoCommand } from '../commands/info-command';
import { mcpCommand } from '../commands/mcp-command';
import { moveCommand } from '../commands/move-command';
import { netCommand } from '../commands/networks-command';
import { newCommand } from '../commands/new-command';
import { oauthCommand } from '../commands/oauth-command';
import { proxyCommand } from '../commands/proxy-command';
import {
  auditCommand,
  grantCommand,
  grantsCommand,
  revokeCommand,
  secretCommand,
} from '../commands/secrets-command';
import { logsCommand, serviceCommand } from '../commands/services-command';
import { attachCommand, sessionsCommand } from '../commands/sessions-command';
import { tokenCommand } from '../commands/tokens-command';
import { defineGroup } from './define-command';

// `completion` walks this tree, so it loads lazily: a static import would be
// a cycle
export const subCommands = {
  new: newCommand,
  ls: lsCommand,
  rm: rmCommand,
  start: startCommand,
  stop: stopCommand,
  exec: execCommand,
  console: consoleCommand,
  attach: attachCommand,
  sessions: sessionsCommand,
  service: serviceCommand,
  logs: logsCommand,
  sleep: sleepCommand,
  wake: wakeCommand,
  hold: holdCommand,
  set: setCommand,
  top: topCommand,
  url: urlCommand,
  proxy: proxyCommand,
  cp: cpCommand,
  policy: policyCommand,
  expose: exposeCommand,
  unexpose: unexposeCommand,
  net: netCommand,
  checkpoint: checkpointCommand,
  checkpoints: checkpointsCommand,
  restore: restoreCommand,
  fork: forkCommand,
  move: moveCommand,
  disk: diskCommand,
  gc: gcCommand,
  db: dbCommand,
  backup: backupCommand,
  image: imageCommand,
  template: templateCommand,
  secret: secretCommand,
  grant: grantCommand,
  revoke: revokeCommand,
  grants: grantsCommand,
  audit: auditCommand,
  token: tokenCommand,
  events: eventsCommand,
  info: infoCommand,
  mcp: mcpCommand,
  oauth: oauthCommand,
  login: loginCommand,
  host: hostCommand,
  hosts: hostsCommand,
  completion: lazy(
    async () => {
      const completion = await import('../commands/completion-command');

      return completion.completionCommand;
    },
    {
      name: 'completion',
      description: 'Print the shell completion script (bash, zsh or fish)',
    },
  ),
};

export const mainCommand = defineGroup({
  name: 'impz',
  description: 'Persistent Linux microVMs that sleep when idle and wake on request',
  subCommands,
});
