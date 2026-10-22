import { isDeepStrictEqual } from 'node:util';
import { DockerfileError } from './dockerfile-error';
import { parseDockerfile, splitDockerfileLines, splitNameWords } from './dockerfile-parse';
import type { Instruction, ParsedDockerfile } from './dockerfile-parse';

type ImageUse = 'FROM' | 'COPY --from' | 'RUN --mount from';

export interface ExternalImage {
  readonly ref: string;
  readonly use: ImageUse;
}

// ADD fetches a `scheme://` source or git's `user@host:path` from the engine's own network
// (BuildKit's frontend/dockerfile/dfgitutil).
const REMOTE_SOURCE = /:\/\/|^[^\/]*@[^\/]*:/v;

function buildRefusal(line: number, message: string): DockerfileError {
  return new DockerfileError(`line ${String(line)}: ${message}`);
}

// The frontend's shell lexer drops quotes and applies the escape token in every FROM, ADD
// and COPY word and builder flag, so refusing both makes the word impd checks the word the
// frontend uses.
function checkPlain(text: string, escape: string, what: string, line: number): void {
  const isAmbiguous =
    text.includes('"') || text.includes("'") || text.includes(escape) || !/^[ -~]*$/v.test(text);

  if (isAmbiguous) {
    throw buildRefusal(
      line,
      `an ambiguous form: ${what} ${JSON.stringify(text)} holds a quote, the escape character or a character that is not printable ASCII`,
    );
  }
}

const PLATFORM_ARGS = new Set([
  'BUILDPLATFORM',
  'BUILDOS',
  'BUILDARCH',
  'BUILDVARIANT',
  'TARGETPLATFORM',
  'TARGETOS',
  'TARGETARCH',
  'TARGETVARIANT',
]);

// impd sends no platform, so the frontend sets both variables to the host's platform, which
// is the one impd inspects.
function resolvePlatform(value: string, platform: string | null, line: number): string {
  if (value === '$BUILDPLATFORM' || value === '$TARGETPLATFORM') {
    return platform ?? value;
  }

  throw buildRefusal(
    line,
    `FROM --platform=${value} is refused: impd builds for the host's platform only; use $BUILDPLATFORM or $TARGETPLATFORM, or leave it out`,
  );
}

// An ARG of a platform variable would change what --platform reads. The frontend splits ARG
// into words and lexes each name, dropping its quotes and escapes.
function checkArg(instruction: Readonly<Instruction>, escape: string): void {
  for (const word of splitNameWords(instruction.args, escape)) {
    const [written = ''] = word.split('=');

    if (written.includes('$')) {
      throw buildRefusal(
        instruction.line,
        `ARG ${written} names its variable with a variable, which impd cannot check`,
      );
    }

    const name = written.replaceAll(/["']/gv, '').replaceAll(escape, '');

    if (PLATFORM_ARGS.has(name.toUpperCase())) {
      throw buildRefusal(
        instruction.line,
        `ARG ${name} is refused: the build's platform variables are the host's, and impd checks images for that platform`,
      );
    }
  }
}

function readFlagValues(instruction: Readonly<Instruction>, name: string): string[] {
  return instruction.flags
    .filter((flag) => flag === `--${name}` || flag.startsWith(`--${name}=`))
    .map((flag) => flag.slice(name.length + 3));
}

function checkWords(instruction: Readonly<Instruction>, escape: string): void {
  const keyword = instruction.keyword;
  const line = instruction.line;

  checkPlain(instruction.rawFlags.trim(), escape, `the ${keyword.toUpperCase()} flags`, line);

  if (keyword === 'from') {
    for (const word of instruction.words) {
      checkPlain(word, escape, 'the FROM word', line);

      if (word.includes('$')) {
        throw buildRefusal(
          line,
          `FROM ${word} names its image with a variable, which impd cannot check`,
        );
      }
    }

    for (const platform of readFlagValues(instruction, 'platform')) {
      resolvePlatform(platform, null, line);
    }
  }

  if (keyword === 'add') {
    for (const source of instruction.words.slice(0, -1)) {
      checkPlain(source, escape, 'the ADD source', line);

      if (source.includes('$')) {
        throw buildRefusal(
          line,
          `the ADD source ${source} holds a variable, which impd cannot check`,
        );
      }

      if (REMOTE_SOURCE.test(source)) {
        throw buildRefusal(
          line,
          `ADD ${source} is refused: the engine would fetch it from the host's network; fetch it in a RUN step, or send it in the context`,
        );
      }
    }
  }
}

// The frontend matches COPY --from and RUN --mount from against any stage's name, ignoring case.
function listStageNames(instructions: readonly Instruction[]): Set<string> {
  const names = new Set<string>();

  for (const instruction of instructions) {
    const [, as, stage] = instruction.words;

    if (instruction.keyword === 'from' && as?.toLowerCase() === 'as' && stage !== undefined) {
      names.add(stage.toLowerCase());
    }
  }

  return names;
}

type PickImage = (ref: string, use: ImageUse, line: number) => string;

interface Stages {
  readonly names: ReadonlySet<string>;
  readonly count: number;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// The frontend takes as a stage index any COPY --from value that Go's strconv.Atoi reads.
function isStageIndex(from: string): boolean {
  if (!/^[+\-]?[0-9]+$/v.test(from)) {
    return false;
  }

  const value = BigInt(from);

  return value >= INT64_MIN && value <= INT64_MAX;
}

function checkStageIndex(from: string, count: number, line: number): void {
  const index = BigInt(from);

  if (index < 0n || index >= BigInt(count)) {
    throw buildRefusal(
      line,
      `COPY --from=${from} names no stage: the Dockerfile has ${String(count)}`,
    );
  }
}

interface PinnedInstruction {
  readonly instruction: Instruction;
  readonly flags: readonly string[];
  readonly words: readonly string[];
}

interface PickInstructionOptions {
  readonly instruction: Readonly<Instruction>;
  readonly earlierStages: ReadonlySet<string>;
  readonly stages: Readonly<Stages>;
  readonly pickImage: PickImage;
  readonly platform: string | null;
}

function pickInstruction(options: PickInstructionOptions): PinnedInstruction {
  const instruction = options.instruction;
  const earlierStages = options.earlierStages;
  const stages = options.stages;
  const pickImage = options.pickImage;
  const platform = options.platform;
  const line = instruction.line;

  if (instruction.keyword === 'from') {
    const [image = '', ...rest] = instruction.words;

    // The frontend matches a FROM base only against an earlier stage.
    const isExternal = image !== '' && image !== 'scratch' && !earlierStages.has(image);
    const base = isExternal ? pickImage(image, 'FROM', line) : image;

    const flags = instruction.flags.map((flag) =>
      flag.startsWith('--platform=')
        ? `--platform=${resolvePlatform(flag.slice('--platform='.length), platform, line)}`
        : flag,
    );

    const words = instruction.words.length === 0 ? [] : [base, ...rest];

    return { instruction, flags, words };
  }

  if (instruction.keyword === 'copy') {
    const flags = instruction.flags.map((flag) => {
      const from = flag.startsWith('--from=') ? flag.slice('--from='.length) : null;

      if (from !== null && isStageIndex(from)) {
        checkStageIndex(from, stages.count, line);
      }

      const isExternal =
        from !== null &&
        !isStageIndex(from) &&
        from !== 'scratch' &&
        !stages.names.has(from.toLowerCase());

      return isExternal ? `--from=${pickImage(from, 'COPY --from', line)}` : flag;
    });

    return { instruction, flags, words: instruction.words };
  }

  if (instruction.keyword === 'run') {
    const flags = instruction.flags.map((flag) => {
      if (!flag.startsWith('--mount=')) {
        return flag;
      }

      const fields = flag.slice('--mount='.length).split(',');

      const pinned = fields.map((field) => {
        const [key = '', ...value] = field.split('=');
        const from = value.join('=');

        const isExternal =
          key.toLowerCase() === 'from' &&
          from !== '' &&
          from !== 'scratch' &&
          !stages.names.has(from.toLowerCase());

        return isExternal ? `${key}=${pickImage(from, 'RUN --mount from', line)}` : field;
      });

      return `--mount=${pinned.join(',')}`;
    });

    return { instruction, flags, words: instruction.words };
  }

  return { instruction, flags: instruction.flags, words: instruction.words };
}

function resolveInstructions(
  parsed: Readonly<ParsedDockerfile>,
  pickImage: PickImage,
  platform: string | null,
): PinnedInstruction[] {
  const stages = {
    names: listStageNames(parsed.instructions),
    count: parsed.instructions.filter((instruction) => instruction.keyword === 'from').length,
  };

  const earlierStages = new Set<string>();

  return parsed.instructions.map((instruction) => {
    if (instruction.keyword === 'onbuild') {
      throw buildRefusal(
        instruction.line,
        'ONBUILD is refused: impd checks only the instructions this build runs',
      );
    }

    if (instruction.keyword === 'arg') {
      checkArg(instruction, parsed.escape);
    }

    if (['from', 'add', 'copy', 'run'].includes(instruction.keyword)) {
      checkWords(instruction, parsed.escape);
    }

    const pinned = pickInstruction({ instruction, earlierStages, stages, pickImage, platform });
    const [, as, stage] = instruction.words;

    if (instruction.keyword === 'from' && as?.toLowerCase() === 'as' && stage !== undefined) {
      earlierStages.add(stage.toLowerCase());
    }

    return pinned;
  });
}

export function checkDockerfile(dockerfile: string): ExternalImage[] {
  const images: ExternalImage[] = [];

  const collectImage: PickImage = (ref, use, line) => {
    if (ref.includes('$')) {
      throw buildRefusal(
        line,
        `${use} ${ref} names its image with a variable, which impd cannot check`,
      );
    }

    if (!images.some((image) => image.ref === ref && image.use === use)) {
      images.push({ ref, use });
    }

    return ref;
  };

  resolveInstructions(parseDockerfile(dockerfile), collectImage, null);

  return images;
}

function formatInstruction(pinned: Readonly<PinnedInstruction>): string {
  const instruction = pinned.instruction;
  const args = instruction.keyword === 'from' ? pinned.words.join(' ') : instruction.args;

  return [instruction.command, ...pinned.flags, args].filter((part) => part !== '').join(' ');
}

function listShapes(instructions: readonly Instruction[], pinned?: readonly PinnedInstruction[]) {
  return instructions.map((instruction, index) => {
    const changed = pinned?.[index];
    const words = changed?.words ?? instruction.words;

    return {
      keyword: instruction.keyword,
      flags: changed?.flags ?? instruction.flags,
      args: instruction.keyword === 'from' ? words.join(' ') : instruction.args,
      words,
      isJson: instruction.isJson,
    };
  });
}

export function renderPinnedDockerfile(
  dockerfile: string,
  pins: ReadonlyMap<string, string>,
  platform: string,
): string {
  const parsed = parseDockerfile(dockerfile);

  const findPin: PickImage = (ref, use, line) => {
    const pin = pins.get(ref);

    if (pin === undefined) {
      throw buildRefusal(line, `${use} ${ref} has no pin`);
    }

    return pin;
  };

  const pinned = resolveInstructions(parsed, findPin, platform);
  const lines = splitDockerfileLines(dockerfile);

  for (const entry of pinned.toReversed()) {
    const instruction = entry.instruction;

    const isChanged =
      !isDeepStrictEqual(entry.flags, instruction.flags) ||
      !isDeepStrictEqual(entry.words, instruction.words);

    if (isChanged) {
      const ending = /\r?\n$/v.exec(lines[instruction.endLine - 1] ?? '')?.[0] ?? '';
      const span = instruction.endLine - instruction.line + 1;

      lines.splice(instruction.line - 1, span, `${formatInstruction(entry)}${ending}`);
    }
  }

  const text = lines.join('');
  const reparsed = parseDockerfile(text);

  const isSame =
    reparsed.escape === parsed.escape &&
    isDeepStrictEqual(listShapes(reparsed.instructions), listShapes(parsed.instructions, pinned));

  if (!isSame) {
    throw new DockerfileError('impd could not pin the images this Dockerfile names');
  }

  return text;
}
