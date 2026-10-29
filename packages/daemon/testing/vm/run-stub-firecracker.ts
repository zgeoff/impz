import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import * as z from 'zod';
import { StubGuestMemorySchema } from './stub-guest-memory-schema';
import type { StubGuestMemory } from './stub-guest-memory-schema';

const [apiSocket = '', log = '', fail = 'none', mode = 'lines', memoryArg = 'none'] =
  process.argv.slice(-5);

const failures = fail === 'none' ? [] : fail.split(',');
const vm = { state: 'Running' };
const memory = memoryArg === 'none' ? null : StubGuestMemorySchema.parse(JSON.parse(memoryArg));

const SnapshotCreateSchema = z.object({
  snapshot_type: z.enum(['Full', 'Diff']),
  snapshot_path: z.string(),
  mem_file_path: z.string(),
});

const SnapshotLoadSchema = z.object({
  mem_backend: z.object({ backend_type: z.enum(['File', 'Uffd']), backend_path: z.string() }),
});

const PAGE_BYTES = 4096;

// the connection to the page handler stays open while the VM lives, as
// Firecracker's does
const handlerConnections: unknown[] = [];

async function handleRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;

  const body = await request.text();

  const call = body === '' ? `${request.method} ${path}` : `${request.method} ${path} ${body}`;

  appendFileSync(log, `${mode === 'bodies' ? call : `${request.method} ${path}`}\n`);

  if (failures.some((prefix) => call.startsWith(prefix))) {
    return Response.json({ fault_message: `refused ${request.method} ${path}` }, { status: 400 });
  }

  if (path === '/version') {
    return Response.json({ firecracker_version: 'v1.17.0' });
  }

  if (memory !== null && request.method === 'GET' && path === '/machine-config') {
    return Response.json({
      vcpu_count: 1,
      mem_size_mib: 128,
      smt: false,
      track_dirty_pages: memory.isTrackingDirtyPages,
      huge_pages: memory.hugePages ?? 'None',
    });
  }

  if (memory !== null && request.method === 'PUT' && path === '/snapshot/create') {
    writeSnapshot(memory, SnapshotCreateSchema.parse(JSON.parse(body)));
  }

  if (request.method === 'PUT' && path === '/snapshot/load') {
    const load = SnapshotLoadSchema.parse(JSON.parse(body));

    if (load.mem_backend.backend_type === 'Uffd') {
      return connectHandler(load.mem_backend.backend_path);
    }
  }

  if (path === '/') {
    return Response.json({ id: 'anonymous-instance', state: vm.state });
  }

  if (request.method === 'PATCH' && path === '/vm') {
    const patch: unknown = JSON.parse(body);

    vm.state =
      typeof patch === 'object' && patch !== null && 'state' in patch && patch.state === 'Paused'
        ? 'Paused'
        : 'Running';
  }

  return new Response(null, { status: 204 });
}

Bun.serve({
  unix: apiSocket,
  fetch: handleRequest,
});

// Firecracker's snapshot_memory_to_file opens the mem file without truncating
// it and empties it only when its size is not the guest's; a Diff of a VM that
// tracks dirty pages writes only those pages, each in its place.
function writeSnapshot(
  guest: Readonly<StubGuestMemory>,
  params: Readonly<z.infer<typeof SnapshotCreateSchema>>,
): void {
  writeFileSync(params.snapshot_path, 'vmstate');

  const sizeBytes = guest.pages.length * PAGE_BYTES;
  const fd = openSync(params.mem_file_path, constants.O_WRONLY | constants.O_CREAT, 0o600);

  if (fstatSync(fd).size !== sizeBytes) {
    ftruncateSync(fd, 0);
  }

  ftruncateSync(fd, sizeBytes);

  const allPages = Array.from({ length: guest.pages.length }, (_, page) => page);
  const pages = pickSnapshotPages(guest, params.snapshot_type) ?? allPages;

  for (const page of pages) {
    writeSync(
      fd,
      Buffer.alloc(PAGE_BYTES, guest.pages.charAt(page)),
      0,
      PAGE_BYTES,
      page * PAGE_BYTES,
    );
  }

  closeSync(fd);
}

// A Diff of a VM that tracks dirty pages holds those pages; one of a 2M VM that
// does not holds the pages mincore(2) finds; any other snapshot holds them all.
function pickSnapshotPages(
  guest: Readonly<StubGuestMemory>,
  type: 'Full' | 'Diff',
): readonly number[] | null {
  if (type === 'Full') {
    return null;
  }

  if (guest.isTrackingDirtyPages) {
    return guest.dirtyPages;
  }

  return guest.hugePages === '2M' ? (guest.presentPages ?? []) : null;
}

async function connectHandler(socket: string): Promise<Response> {
  try {
    const connection = await Bun.connect({ unix: socket, socket: { data: () => {} } });

    handlerConnections.push(connection);
  } catch {
    return Response.json(
      { fault_message: `Load snapshot error: cannot connect to the page handler at ${socket}` },
      { status: 400 },
    );
  }

  return new Response(null, { status: 204 });
}
