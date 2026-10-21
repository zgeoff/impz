import { expect, test } from 'bun:test';
import packageJson from '../../package.json' with { type: 'json' };
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { mainCommand } from './command-tree';
import { collectNodes, readCompletionTree } from './completion';

test.each([
  ['impz'],
  ['impz new'],
  ['impz ls'],
  ['impz rm'],
  ['impz start'],
  ['impz stop'],
  ['impz exec'],
  ['impz console'],
  ['impz attach'],
  ['impz sessions'],
  ['impz service'],
  ['impz service add'],
  ['impz service ls'],
  ['impz service rm'],
  ['impz service restart'],
  ['impz logs'],
  ['impz sleep'],
  ['impz wake'],
  ['impz hold'],
  ['impz set'],
  ['impz top'],
  ['impz url'],
  ['impz proxy'],
  ['impz cp'],
  ['impz policy'],
  ['impz expose'],
  ['impz unexpose'],
  ['impz net'],
  ['impz net create'],
  ['impz net ls'],
  ['impz net rm'],
  ['impz net join'],
  ['impz net leave'],
  ['impz checkpoint'],
  ['impz checkpoints'],
  ['impz restore'],
  ['impz fork'],
  ['impz move'],
  ['impz disk'],
  ['impz disk resize'],
  ['impz gc'],
  ['impz db'],
  ['impz db copy'],
  ['impz backup'],
  ['impz backup ls'],
  ['impz backup run'],
  ['impz backup restore'],
  ['impz backup check'],
  ['impz image'],
  ['impz image add'],
  ['impz image build'],
  ['impz image builds'],
  ['impz image ls'],
  ['impz image rm'],
  ['impz template'],
  ['impz template create'],
  ['impz template ls'],
  ['impz template rm'],
  ['impz secret'],
  ['impz secret add'],
  ['impz secret refresh'],
  ['impz secret ls'],
  ['impz secret rm'],
  ['impz grant'],
  ['impz revoke'],
  ['impz grants'],
  ['impz audit'],
  ['impz token'],
  ['impz token new'],
  ['impz token set'],
  ['impz token ls'],
  ['impz token rm'],
  ['impz token key'],
  ['impz token key add'],
  ['impz token key ls'],
  ['impz token key rm'],
  ['impz token whoami'],
  ['impz events'],
  ['impz info'],
  ['impz mcp'],
  ['impz oauth'],
  ['impz oauth client'],
  ['impz oauth client add'],
  ['impz oauth client set'],
  ['impz oauth client ls'],
  ['impz oauth client rm'],
  ['impz oauth grant'],
  ['impz oauth grant ls'],
  ['impz oauth grant rm'],
  ['impz oauth approve'],
  ['impz login'],
  ['impz host'],
  ['impz host ls'],
  ['impz host use'],
  ['impz host rm'],
  ['impz hosts'],
  ['impz completion'],
])('it prints a usage line and no trailing spaces in the help of %s', async (path) => {
  const result = await runCLIInProcess({ args: [...path.split(' ').slice(1), '--help'] });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toInclude('\n\nUSAGE ');
  expect(result.stdout.split('\n')).toSatisfyAll((line: string) => line === line.trimEnd());
});

test('it prints the help of the root with every command and the global flags', async () => {
  const result = await runCLIInProcess({ args: ['--help'] });

  expect(result.stdout.replace(`(impz v${packageJson.version})`, '(impz v<version>)'))
    .toMatchInlineSnapshot(`
"Persistent Linux microVMs that sleep when idle and wake on request (impz v<version>)

USAGE impz [OPTIONS] new|ls|rm|start|stop|exec|console|attach|sessions|service|logs|sleep|wake|hold|set|top|url|proxy|cp|policy|expose|unexpose|net|checkpoint|checkpoints|restore|fork|move|disk|gc|db|backup|image|template|secret|grant|revoke|grants|audit|token|events|info|mcp|oauth|login|host|hosts|completion

OPTIONS

  --host=<host>    saved host to call (see impz host ls)

COMMANDS

          new    Create an imp and boot it
           ls    List imps
           rm    Destroy an imp and its disk and checkpoints
        start    Boot a stopped imp
         stop    Shut an imp down (its disk stays, its memory and leases do not)
         exec    Run a command in an imp (impz exec [-t] <name> -- cmd args)
      console    Open a shell in an imp, in a session that outlives the terminal (ctrl-] detaches)
       attach    Attach to a session in an imp: its recent output, then live (ctrl-] detaches)
     sessions    List an imp's sessions without waking it (impz sessions kill <name> <session> ends one; logs, log and log-rm read and delete session logs)
      service    Manage an imp's services: add, ls, rm, restart
         logs    Print an imp's service logs (impz logs <name> [service] [-f] [-n lines])
        sleep    Snapshot an imp to disk and free its RAM, ending its leases
         wake    Resume a sleeping or stopped imp
         hold    Keep an imp awake for a while (0 releases)
          set    Change an imp's CPU limit or weight (at once when running), its vCPUs (stopped only), or its HTTP port
          top    Watch every imp's CPU, memory and traffic
          url    Print an imp's URLs: https first when HTTPS is on, then its tailnet name, local and tailnet
        proxy    Forward local ports to ports in an imp, waking it on connect (impz proxy <name> 5432 3001:3000), or with --reverse, a socket or port in the imp to this machine
           cp    Copy a file or directory into or out of an imp (impz cp ./dir box:/srv/dir, impz cp box:/var/log/x .)
       policy    Show or set an imp's egress policy: open, public, box with --allow, or none
       expose    Serve an imp to the internet at https://<name>.<domain>, with optional auth
     unexpose    Take an imp off the internet: tailnet only again
          net    Manage private networks between imps
   checkpoint    Checkpoint an imp's disk (impz checkpoint rm <name> <checkpoint> deletes one)
  checkpoints    List an imp's checkpoints, newest first
      restore    Roll an imp's disk back to a checkpoint; an awake imp reboots
         fork    Create an imp from another imp's disk or checkpoint
         move    Move an imp to another saved host: a stopped one cold, a sleeping one with its memory (see docs/guides/hosts.md)
         disk    Manage imp disks
           gc    Remove what a crash left that nothing names, and list the orphans it keeps
           db    impd's database
       backup    Off-host backups of every imp (restic)
        image    Manage images
     template    Manage templates: images made from an imp's disk
       secret    Manage the secrets the credential broker adds
        grant    Let an imp use a secret: the broker adds it to the imp's requests to its hosts
       revoke    Take a secret away from an imp
       grants    List the secrets granted to an imp
        audit    Show requests the broker sent with a credential or refused, or calls to impd, newest first
        token    Manage API tokens and their scopes (needs manage)
       events    Follow impd: every imp, then each change, as one JSON object a line
         info    Show impd version, RAM budget and counts, or one imp with its container
          mcp    Serve imps to a coding agent as MCP tools over stdio. The guard limits which imps the tools touch; it stops mistakes. For a real limit, run it with a scoped token (impz token new).
        oauth    Manage sign-ins to the public MCP route: clients, grants and approvals
        login    Save an impd and its token, and make it the current host
         host    Manage saved impd hosts (see also impz login)
        hosts    List saved hosts (impz host ls)
   completion    Print the shell completion script (bash, zsh or fish)

Use impz <command> --help for more information about a command.

"
`);
});

test('it prints the help of a nested command with its arguments', async () => {
  const result = await runCLIInProcess({ args: ['token', 'key', 'add', '--help'] });

  expect(result.stdout).toMatchInlineSnapshot(`
"Bind the keys in a public key file to a token: an ssh login with one runs as it (key add)

USAGE key add [OPTIONS] <NAME> <FILE>

ARGUMENTS

  NAME    token name (Required)
  FILE    public key file, such as ~/.ssh/id_ed25519.pub (Required)

OPTIONS

  --json    print JSON


"
`);
});

test('it prints the help of a command with options and their value hints', async () => {
  const result = await runCLIInProcess({ args: ['service', 'add', '--help'] });

  expect(result.stdout).toMatchInlineSnapshot(`
"Add a service to an imp and start it (impz service add <name> <service> --cmd "…" or -- argv) (service add)

USAGE service add [OPTIONS] <NAME> <SERVICE>

ARGUMENTS

     NAME    imp name (Required)
  SERVICE    service name (Required)

OPTIONS

              --cmd=<cmd>    the command, run by /bin/sh
              --env=<env>    KEY=VALUE; give it once per variable
              --cwd=<cwd>    working directory (default /)
            --user=<user>    user to run as (default the image's)
      --restart=<restart>    always (default), on-failure or never
                --replace    replace a service by that name
  --http-port=<http_port>    then point the imp's URL at this port (impz set; needs manage)


"
`);
});

test('it pins the help of every command in the tree', async () => {
  const tree = await readCompletionTree(mainCommand);

  expect(collectNodes(tree).map((node) => node.path)).toStrictEqual([
    'impz',
    'impz new',
    'impz ls',
    'impz rm',
    'impz start',
    'impz stop',
    'impz exec',
    'impz console',
    'impz attach',
    'impz sessions',
    'impz service',
    'impz service add',
    'impz service ls',
    'impz service rm',
    'impz service restart',
    'impz logs',
    'impz sleep',
    'impz wake',
    'impz hold',
    'impz set',
    'impz top',
    'impz url',
    'impz proxy',
    'impz cp',
    'impz policy',
    'impz expose',
    'impz unexpose',
    'impz net',
    'impz net create',
    'impz net ls',
    'impz net rm',
    'impz net join',
    'impz net leave',
    'impz checkpoint',
    'impz checkpoints',
    'impz restore',
    'impz fork',
    'impz move',
    'impz disk',
    'impz disk resize',
    'impz gc',
    'impz db',
    'impz db copy',
    'impz backup',
    'impz backup ls',
    'impz backup run',
    'impz backup restore',
    'impz backup check',
    'impz image',
    'impz image add',
    'impz image build',
    'impz image builds',
    'impz image ls',
    'impz image rm',
    'impz template',
    'impz template create',
    'impz template ls',
    'impz template rm',
    'impz secret',
    'impz secret add',
    'impz secret refresh',
    'impz secret ls',
    'impz secret rm',
    'impz grant',
    'impz revoke',
    'impz grants',
    'impz audit',
    'impz token',
    'impz token new',
    'impz token set',
    'impz token ls',
    'impz token rm',
    'impz token key',
    'impz token key add',
    'impz token key ls',
    'impz token key rm',
    'impz token whoami',
    'impz events',
    'impz info',
    'impz mcp',
    'impz oauth',
    'impz oauth client',
    'impz oauth client add',
    'impz oauth client set',
    'impz oauth client ls',
    'impz oauth client rm',
    'impz oauth grant',
    'impz oauth grant ls',
    'impz oauth grant rm',
    'impz oauth approve',
    'impz login',
    'impz host',
    'impz host ls',
    'impz host use',
    'impz host rm',
    'impz hosts',
    'impz completion',
  ]);
});
