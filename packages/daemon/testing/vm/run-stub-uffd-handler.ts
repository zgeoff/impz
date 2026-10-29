import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const [mode = 'serve', record = '', ...args] = process.argv.slice(2);

// the options the real handler's flag parser takes, in either of its forms
const parsed = parseArgs({
  args,
  options: { socket: { type: 'string' }, uid: { type: 'string' }, gid: { type: 'string' } },
  strict: true,
});

const socket = parsed.values.socket ?? '';

if (mode === 'refuse') {
  process.stderr.write('not enough 2 MiB pages\n');
  process.exit(1);
}

// the memory file reaches the handler as descriptor 3, as impd passes it
appendFileSync(
  record,
  `${JSON.stringify({ args, served: readFileSync('/dev/fd/3', 'latin1') })}\n`,
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
