import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StubWarmAnswerSchema } from './stub-warm-answer-schema';

// the wrapper passes the mode, the record file and the warm answer file first,
// then the options the real handler's flag parser takes, in either of its forms
const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    socket: { type: 'string' },
    uid: { type: 'string' },
    gid: { type: 'string' },
    'count-data': { type: 'string' },
    warm: { type: 'string' },
    'count-blocks': { type: 'string' },
    'warm-blocks': { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});

// the blocks modes take the block list as their value and the memory file as a
// positional after the wrapper's three
const [mode = 'serve', record = '', answerFile = '', positionalMemFile] = parsed.positionals;

const {
  'count-data': countedFile,
  warm: warmedFile,
  'count-blocks': countedBlocksList,
  'warm-blocks': warmedBlocksList,
  ...options
} = parsed.values;

const blockList = warmedBlocksList ?? countedBlocksList;
const memFile = blockList === undefined ? (warmedFile ?? countedFile) : positionalMemFile;

if (memFile === undefined) {
  const socket = options.socket ?? '';

  if (mode === 'refuse') {
    process.stderr.write('not enough 2 MiB pages\n');
    process.exit(1);
  }

  // the memory file reaches the handler as descriptor 3, as impd passes it
  appendFileSync(
    record,
    `${JSON.stringify({ options, served: readFileSync('/dev/fd/3', 'latin1') })}\n`,
  );

  Bun.listen({
    unix: socket,
    socket: {
      data: () => {},
      open: (connection) => {
        if (mode === 'crash') {
          connection.end();
          process.exit(2);
        }
      },
    },
  });
} else {
  const isWarm = warmedFile !== undefined || warmedBlocksList !== undefined;
  const warmMode = pickWarmMode(blockList !== undefined, isWarm);
  const answerText = existsSync(answerFile) ? readFileSync(answerFile, 'utf8') : '{}';
  const answer = StubWarmAnswerSchema.parse(JSON.parse(answerText));

  appendFileSync(
    `${record}.warms`,
    `${JSON.stringify({ mode: warmMode, memFile, blockList, pid: process.pid })}\n`,
  );

  if (isWarm && answer.hangs) {
    // keeps the process alive, as a warm of a large file is, until impd kills it
    setInterval(() => {}, 60_000);
  } else {
    process.stdout.write(`${JSON.stringify({ blocks: answer.blocks })}\n`);
  }
}

function pickWarmMode(
  isBlockList: boolean,
  isWarm: boolean,
): '--count-data' | '--warm' | '--count-blocks' | '--warm-blocks' {
  if (isBlockList) {
    return isWarm ? '--warm-blocks' : '--count-blocks';
  }

  return isWarm ? '--warm' : '--count-data';
}
