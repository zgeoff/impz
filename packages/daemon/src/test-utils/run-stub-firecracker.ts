// Firecracker's API on the socket its argv names, in a process of its own;
// start-stub-firecracker.ts builds the argv. GET / answers the VM's state,
// which PATCH /vm sets, and a guest memory gets snapshots and a machine config.
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

const [apiSocket = '', log = '', fail = 'none', mode = 'lines', memoryArg = 'none'] =
  process.argv.slice(-5);

const failures = fail === 'none' ? [] : fail.split(',');
const vm = { state: 'Running' };

const MemorySchema = z.object({
  pages: z.string(),
  dirtyPages: z.array(z.number()),
  isTrackingDirtyPages: z.boolean(),
});

const memory = memoryArg === 'none' ? null : MemorySchema.parse(JSON.parse(memoryArg));

const SnapshotCreateSchema = z.object({
  snapshot_type: z.enum(['Full', 'Diff']),
  snapshot_path: z.string(),
  mem_file_path: z.string(),
});

const PAGE_BYTES = 4096;

Bun.serve({
  unix: apiSocket,
  fetch: async (request) => {
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
        huge_pages: 'None',
      });
    }

    if (memory !== null && request.method === 'PUT' && path === '/snapshot/create') {
      writeSnapshot(memory, SnapshotCreateSchema.parse(JSON.parse(body)));
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
  },
});

// As Firecracker's snapshot_memory_to_file: the mem file is opened without a
// truncate, emptied only when its size is not the guest's, and a Diff of a VM
// that tracks its pages writes only the dirty ones, each in its place.
function writeSnapshot(
  guest: Readonly<z.infer<typeof MemorySchema>>,
  params: Readonly<z.infer<typeof SnapshotCreateSchema>>,
): void {
  writeFileSync(params.snapshot_path, 'vmstate');

  const sizeBytes = guest.pages.length * PAGE_BYTES;
  const fd = openSync(params.mem_file_path, constants.O_WRONLY | constants.O_CREAT, 0o600);

  if (fstatSync(fd).size !== sizeBytes) {
    ftruncateSync(fd, 0);
  }

  ftruncateSync(fd, sizeBytes);

  const isDiff = params.snapshot_type === 'Diff' && guest.isTrackingDirtyPages;
  const pages = isDiff ? guest.dirtyPages : [...guest.pages].map((_, page) => page);

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
