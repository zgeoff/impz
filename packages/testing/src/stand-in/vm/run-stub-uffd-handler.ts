import {
  appendFileSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { parseArgs } from 'node:util';
import { StubWarmAnswerSchema } from './stub-warm-answer-schema';

const MEM_FILE_FD = 3;
const TOUCHED_FILE_FD = 5;
const BLOCK_BYTES = 2 * 1024 * 1024;

// a little-endian uint32 per 2 MiB block: 0 for a block never served, otherwise
// the 1-based order of its first fault
const TOUCHED_ENTRY_BYTES = 4;

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
const [mode = 'serve', record = '', answerFile = '', positionalMemFile, limit] = parsed.positionals;

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
    `${JSON.stringify({
      mode: warmMode,
      memFile,
      blockList,
      limit: limit === undefined ? undefined : Number(limit),
      pid: process.pid,
    })}\n`,
  );

  if (isWarm && answer.hangs) {
    // keeps the process alive, as a warm of a large file is, until impd kills it
    setInterval(() => {}, 60_000);
  } else {
    process.stdout.write(`${JSON.stringify({ blocks: countAnswer(answer.blocks) })}\n`);
  }
}

// the blocks modes count the blocks the list marks, as the real handler counts
// those that also hold data, so the answer's count serves only the whole file;
// a warm of blocks reads no more than its limit, which follows the memory file
function countAnswer(wholeBlocks: number): number {
  if (blockList === undefined) {
    return wholeBlocks;
  }

  const raw = readFileSync(blockList);

  // the list is a uint32 per block of the memory file, as the real handler
  // refuses any other size; a memory file a test never wrote leaves only the width
  const isWrongSize =
    memFile !== undefined && existsSync(memFile)
      ? raw.length !== Math.ceil(statSync(memFile).size / BLOCK_BYTES) * TOUCHED_ENTRY_BYTES
      : raw.length % TOUCHED_ENTRY_BYTES !== 0;

  if (isWrongSize) {
    process.stderr.write(`block list: ${raw.length} bytes, not a uint32 per block\n`);
    process.exit(1);
  }

  const marked = Array.from({ length: raw.length / TOUCHED_ENTRY_BYTES }, (_, block) =>
    raw.readUInt32LE(block * TOUCHED_ENTRY_BYTES),
  ).filter((ordinal) => ordinal !== 0).length;

  return warmedBlocksList === undefined ? marked : Math.min(marked, Number(limit));
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

// as the real handler does: sizes descriptor 5 to a uint32 per 2 MiB block of
// the memory file, zeroed, and numbers the blocks it served by first fault
function markTouchedBlocks(touches: readonly number[]): void {
  const blocks = Math.ceil(fstatSync(MEM_FILE_FD).size / BLOCK_BYTES);

  // a spawn that passes no descriptor 5 leaves the runtime's own, which is no regular file
  if (!probeRegularFile(TOUCHED_FILE_FD)) {
    return;
  }

  ftruncateSync(TOUCHED_FILE_FD, 0);
  ftruncateSync(TOUCHED_FILE_FD, blocks * TOUCHED_ENTRY_BYTES);

  const ordinals = new Map<number, number>();

  for (const block of touches) {
    if (block < blocks && !ordinals.has(block)) {
      ordinals.set(block, ordinals.size + 1);

      const entry = Buffer.alloc(TOUCHED_ENTRY_BYTES);

      entry.writeUInt32LE(ordinals.size);

      writeSync(TOUCHED_FILE_FD, entry, 0, TOUCHED_ENTRY_BYTES, block * TOUCHED_ENTRY_BYTES);
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
