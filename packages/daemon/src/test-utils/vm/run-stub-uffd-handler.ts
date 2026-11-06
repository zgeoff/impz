import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// the wrapper passes the mode and the record file first, then the options the
// real handler's flag parser takes, in either of its forms
const parsed = parseArgs({
  args: process.argv.slice(2),
  options: { socket: { type: 'string' }, uid: { type: 'string' }, gid: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});

const [mode = 'serve', record = ''] = parsed.positionals;
const options = parsed.values;
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
