import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

interface TraceVertex {
  readonly digest: string;
  readonly name: string;
  readonly cached: boolean;
  readonly started: boolean;
  readonly completed: boolean;

  readonly error: string;
}

interface TraceLog {
  readonly vertex: string;
  readonly message: Uint8Array;
}

export interface BuildTrace {
  readonly vertexes: readonly TraceVertex[];
  readonly logs: readonly TraceLog[];
}

// A `moby.buildkit.trace` message is BuildKit's control StatusResponse in protobuf, with
// vertexes as field 1 and logs as field 3.
export function decodeBuildTrace(bytes: Uint8Array): BuildTrace {
  const reader = new BinaryReader(bytes);

  const vertexes: TraceVertex[] = [];
  const logs: TraceLog[] = [];

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      vertexes.push(decodeVertex(reader.bytes()));
    } else if (field === 3 && wireType === WireType.LengthDelimited) {
      logs.push(decodeLog(reader.bytes()));
    } else {
      reader.skip(wireType, field);
    }
  }

  return { vertexes, logs };
}

// BuildKit's Vertex message: digest = 1, name = 3, cached = 4, started = 5, completed = 6,
// error = 7.
function decodeVertex(bytes: Uint8Array): TraceVertex {
  const reader = new BinaryReader(bytes);

  const vertex = {
    digest: '',
    name: '',
    cached: false,
    started: false,
    completed: false,
    error: '',
  };

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      vertex.digest = reader.string();
    } else if (field === 3 && wireType === WireType.LengthDelimited) {
      vertex.name = reader.string();
    } else if (field === 4 && wireType === WireType.Varint) {
      vertex.cached = reader.bool();
    } else if (field === 5 && wireType === WireType.LengthDelimited) {
      reader.bytes();

      vertex.started = true;
    } else if (field === 6 && wireType === WireType.LengthDelimited) {
      reader.bytes();

      vertex.completed = true;
    } else if (field === 7 && wireType === WireType.LengthDelimited) {
      vertex.error = reader.string();
    } else {
      reader.skip(wireType, field);
    }
  }

  return vertex;
}

// BuildKit's VertexLog message: vertex = 1, msg = 4.
function decodeLog(bytes: Uint8Array): TraceLog {
  const reader = new BinaryReader(bytes);

  const log: { vertex: string; message: Uint8Array } = { vertex: '', message: new Uint8Array() };

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      log.vertex = reader.string();
    } else if (field === 4 && wireType === WireType.LengthDelimited) {
      log.message = reader.bytes();
    } else {
      reader.skip(wireType, field);
    }
  }

  return log;
}
