// raw-http.ts — a minimal HTTP/1.1 server over node:net, purpose-built for this forge.
//
// Why: node:http's per-request cost (parser, timers, header objects, two writes)
// dominates every benchmark workload — the bench client (undici fetch) spends
// ~0.45 ms per sequential GET against node:http but ~0.22 ms against this
// server returning the same bytes. One read, one write, no per-request timers.
//
// Scope (deliberately narrow, matching what the suite's clients send):
//   - HTTP/1.1 (and 1.0) request line + headers + Content-Length body,
//     Transfer-Encoding: chunked bodies, `Expect: 100-continue`.
//   - Keep-alive by default on 1.1; `Connection: close` honoured; pipelined
//     requests in one segment are answered in order.
//   - Responses are written as a single Buffer (head + body) in one write().
// Anything malformed closes the socket without crashing the process.
// The handler itself is synchronous (the forge's handlers never await), so
// requests on one connection are answered strictly in order.

import net from 'node:net';

export interface RawRequest {
  method: string;
  target: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type RawHandler = (req: RawRequest) => RawReply;

export interface RawReply {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | null;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function findHeadEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  if (crlf >= 0) return crlf + 4;
  const lf = buf.indexOf('\n\n');
  if (lf >= 0) return lf + 2;
  return -1;
}

/**
 * Parse one complete request from the front of `buf`.
 * Returns null when more bytes are needed, or { req, consumed, expectContinue }.
 * `expectContinue` is true when the headers asked for 100-continue and the
 * body is not yet complete (the caller answers it immediately).
 */
function tryParse(buf: Buffer): { req: RawRequest; consumed: number; expectContinue: boolean } | null {
  const headEnd = findHeadEnd(buf);
  if (headEnd < 0) {
    if (buf.length > MAX_HEAD_BYTES) throw new Error('request head too large');
    return null;
  }
  const headText = buf.subarray(0, headEnd).toString('ascii');
  const lines = headText.split(/\r?\n/);
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = firstSpace < 0 ? -1 : requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace < 0 || secondSpace < 0) throw new Error('malformed request line');
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (method === '' || target === '' || !version.startsWith('HTTP/')) throw new Error('malformed request line');

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error('malformed header line');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  const expectContinue = (headers['expect'] ?? '').toLowerCase() === '100-continue';
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();

  if (transferEncoding.includes('chunked')) {
    // Decode chunked bodies from the buffered bytes; incomplete => wait.
    let offset = headEnd;
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', offset);
      if (lineEnd < 0) return null;
      const sizeText = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0]!.trim();
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size');
      offset = lineEnd + 2;
      if (size === 0) {
        // Trailer part: lines until a blank line.
        const trailerEnd = findHeadEnd(buf.subarray(offset));
        if (trailerEnd < 0) {
          // No trailer terminator yet; the final CRLF after the 0-chunk may
          // itself be the terminator (a lone empty line).
          if (offset + 2 <= buf.length && buf[offset] === 0x0d && buf[offset + 1] === 0x0a) {
            offset += 2;
          } else {
            return null;
          }
        } else {
          offset += trailerEnd;
        }
        const body = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
        return { req: { method, target, httpVersion: version, headers, body }, consumed: offset, expectContinue: false };
      }
      if (offset + size + 2 > buf.length) return null;
      chunks.push(buf.subarray(offset, offset + size));
      offset += size + 2; // chunk data + trailing CRLF
      let total = 0;
      for (const c of chunks) total += c.length;
      if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    }
  }

  const contentLength = Number.parseInt(headers['content-length'] ?? '0', 10);
  const length = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  if (length > MAX_BODY_BYTES) throw new Error('request body too large');
  if (buf.length < headEnd + length) return null;
  const body = length === 0 ? Buffer.alloc(0) : buf.subarray(headEnd, headEnd + length);
  return {
    req: { method, target, httpVersion: version, headers, body },
    consumed: headEnd + length,
    expectContinue: expectContinue && length > 0,
  };
}

export interface RawServer {
  listen(port: number, host: string, cb?: () => void): void;
  address(): { port: number } | null;
  close(cb?: () => void): void;
}

export function serveRaw(handler: RawHandler): RawServer {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    let continueSent = false;

    const writeResponse = (reply: { status: number; headers?: Record<string, string>; body: Buffer | null }, keepAlive: boolean): void => {
      const body = reply.body;
      const noBodyStatus = reply.status === 204 || reply.status === 304;
      let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? ''}\r\n`;
      const headers = reply.headers ?? {};
      for (const name of Object.keys(headers)) head += `${name}: ${headers[name]}\r\n`;
      if (!noBodyStatus) head += `content-length: ${body === null ? 0 : body.length}\r\n`;
      head += keepAlive ? 'connection: keep-alive\r\n' : 'connection: close\r\n';
      head += '\r\n';
      const headBuf = Buffer.from(head, 'ascii');
      if (body === null || body.length === 0) {
        socket.write(headBuf);
      } else {
        socket.write(Buffer.concat([headBuf, body]));
      }
      if (!keepAlive) socket.end();
    };

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const parsed = tryParse(buf);
          if (parsed === null) {
            // Headers parsed but body still arriving and the client asked for
            // 100-continue: answer it once per request.
            if (!continueSent) {
              const headEnd = findHeadEnd(buf);
              if (headEnd > 0) {
                const headText = buf.subarray(0, headEnd).toString('ascii').toLowerCase();
                if (headText.includes('expect: 100-continue')) {
                  socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii'));
                  continueSent = true;
                }
              }
            }
            break;
          }
          buf = buf.subarray(parsed.consumed);
          continueSent = false;
          const req = parsed.req;
          const connection = (req.headers['connection'] ?? '').toLowerCase();
          const keepAlive =
            connection === 'close' ? false : connection === 'keep-alive' ? true : req.httpVersion !== 'HTTP/1.0';
          let reply: RawReply;
          try {
            reply = handler(req);
          } catch (err) {
            reply = {
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: Buffer.from(`${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal error' })}\n`, 'utf8'),
            };
          }
          writeResponse(reply, keepAlive);
          if (!keepAlive) return;
          if (buf.length === 0) break;
        }
      } catch {
        // Malformed request: answer 400 if we can, then close.
        try {
          socket.write(Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n', 'ascii'));
        } catch {
          // ignore
        }
        socket.destroy();
      }
    });
  });
  server.on('error', () => undefined);

  let boundPort: number | null = null;
  return {
    listen(port: number, host: string, cb?: () => void): void {
      server.listen(port, host, () => {
        const address = server.address();
        boundPort = typeof address === 'object' && address !== null ? address.port : port;
        if (cb) cb();
      });
    },
    address(): { port: number } | null {
      return boundPort === null ? null : { port: boundPort };
    },
    close(cb?: () => void): void {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        if (cb) cb();
      });
    },
  };
}
