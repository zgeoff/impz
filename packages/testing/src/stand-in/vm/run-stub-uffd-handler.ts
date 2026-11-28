import {
  appendFileSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { parseArgs } from 'node:util';
import { StubWarmAnswerSchema } from './stub-warm-answer-schema';

const MEM_FILE_FD = 3;
const TOUCHED_FILE_FD = 5;

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

  markTouchedBlocks(readAnswer().touches);

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
  const answer = readAnswer();

  if (blockList !== undefined && answer.refusesBlockLists) {
    process.stderr.write('flag provided but not defined\n');
    process.exit(2);
  }

  appendFileSync(
    `${record}.warms`,
    `${JSON.stringify({ mode: warmMode, memFile, blockList, pid: process.pid })}\n`,
  );

  if (isWarm && answer.hangs) {
    // keeps the process alive, as a warm of a large file is, until impd kills it
    setInterval(() => {}, 60_000);
  } else {
    process.stdout.write(`${JSON.stringify({ blocks: countAnswer(answer.blocks) })}\n`);
  }
}

// the blocks modes count the blocks the list marks, as the real handler counts
// those that also hold data, so the answer's count serves only the whole file
function countAnswer(wholeBlocks: number): number {
  if (blockList === undefined) {
    return wholeBlocks;
  }

  return [...readFileSync(blockList)].filter((mark) => mark !== 0).length;
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

function readAnswer() {
  const answerText = existsSync(answerFile) ? readFileSync(answerFile, 'utf8') : '{}';

  return StubWarmAnswerSchema.parse(JSON.parse(answerText));
}

// as the real handler does: sizes descriptor 5 to a byte per 2 MiB block of the
// memory file, zeroed, and marks the blocks it served
function markTouchedBlocks(touches: readonly number[]): void {
  const blockBytes = 2 * 1024 * 1024;
  const blocks = Math.ceil(fstatSync(MEM_FILE_FD).size / blockBytes);

  // a spawn that passes no descriptor 5 leaves the runtime's own, which is no regular file
  if (!probeRegularFile(TOUCHED_FILE_FD)) {
    return;
  }

  ftruncateSync(TOUCHED_FILE_FD, 0);
  ftruncateSync(TOUCHED_FILE_FD, blocks);

  for (const block of touches) {
    if (block < blocks) {
      writeSync(TOUCHED_FILE_FD, Uint8Array.of(1), 0, 1, block);
    }
  }
}

function probeRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}
