import type { CommandRunners } from './instance';

// impd's tailnet front cancels a request whose client shuts its side, and holds
// the connection open after its answer, so nc's input stays open until the
// answer's Content-Length bytes are in.
const SEND_RAW = String.raw`
request=$(mktemp)
done=$(mktemp -u)
cr=$(printf '\r')
cat > "$request"
{ cat "$request"; until [ -e "$done" ]; do sleep 0.1; done; } | nc -w 30 "$0" "$1" | {
  length=0
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in [Cc]ontent-[Ll]ength:*) length=$(printf '%s' "$line" | tr -dc 0-9) ;; esac
    [ "$line" = "$cr" ] && break
  done
  head -c "$length"
  touch "$done"
}
rm -f "$request" "$done"
`;

// Only the member reaches a tailnet address, and BusyBox wget there drops the
// body of an error status, so the request goes out raw through its nc.
export function makeMemberFetch(
  member: string,
  runners: Pick<CommandRunners, 'runCommand'>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);

    const body = await request.text();

    const result = await runners.runCommand(
      ['docker', 'exec', '-i', member, 'sh', '-c', SEND_RAW, url.hostname, url.port],
      { stdin: formatRawRequest(request, url, body) },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `${request.method} ${url.href} from ${member} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }

    return parseRawResponse(result.stdout, result.stderr);
  };
}

const SKIPPED_HEADERS = new Set(['host', 'connection', 'content-length']);

function formatRawRequest(request: Request, url: URL, body: string): string {
  const headers = [...request.headers]
    .filter(([name]) => !SKIPPED_HEADERS.has(name))
    .map(([name, value]) => `${name}: ${value}\r\n`);

  return [
    `${request.method} ${url.pathname}${url.search} HTTP/1.0\r\n`,
    `host: ${url.host}\r\n`,
    ...headers,
    `content-length: ${String(Buffer.byteLength(body))}\r\n`,
    '\r\n',
    body,
  ].join('');
}

function parseRawResponse(raw: string, stderr: string): Response {
  const split = raw.indexOf('\r\n\r\n');

  if (split === -1) {
    throw new Error(`no HTTP response: ${raw.slice(0, 200)}${stderr.trim()}`);
  }

  const [statusLine = '', ...headerLines] = raw.slice(0, split).split('\r\n');
  const status = /^HTTP\/[\d.]+ (?<code>\d{3})/v.exec(statusLine)?.groups?.['code'];

  if (status === undefined) {
    throw new Error(`no HTTP status line: ${statusLine}`);
  }

  const headers = new Headers(
    headerLines.map((line): [string, string] => {
      const colon = line.indexOf(':');

      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );

  return new Response(raw.slice(split + 4), { status: Number(status), headers });
}
