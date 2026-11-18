// app.ts — the HTTP server: health probe, bearer auth, and routing to the git,
// REST, GraphQL and MCP surfaces. Every reply carries a non-empty
// X-GitHub-Request-Id and, for JSON, an application/json content type.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { VIEWER_LOGIN, forge } from './store.ts';
import { errorReply, jsonReply, requestId, type Reply, type Req } from './http-util.ts';
import { handleGit, parseGitPath, type GitRoute } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The bearer token every API call carries; set by the trial environment. */
let cachedToken: string | null = null;
export function shopToken(): string {
  // The environment fixes the token before the process starts; read it once.
  if (cachedToken === null) cachedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return cachedToken;
}

function sendReply(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...(reply.headers ?? {}) };
  const body = reply.body === null ? null : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body, 'utf8');
  if (body !== null && !('content-type' in headers)) headers['content-type'] = 'application/json; charset=utf-8';
  if (body !== null) headers['content-length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

async function handleRequest(req: IncomingMessage, rawBody: Buffer, res: ServerResponse): Promise<void> {
  // Parse the request line by hand: a URL object plus a headers copy per request
  // is pure overhead on a hot loop of thousands of small calls.
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const rawPath = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  let pathname: string;
  if (rawPath.indexOf('%') < 0) {
    pathname = rawPath;
  } else {
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      pathname = rawPath;
    }
  }
  const segments = pathname.split('/').filter((part) => part !== '');
  // Node already lower-cases incoming header names; use them in place.
  const headers = req.headers as Record<string, string>;
  const request: Req = {
    method: (req.method ?? 'GET').toUpperCase(),
    segments,
    pathname,
    query: new URLSearchParams(queryIndex < 0 ? '' : rawUrl.slice(queryIndex + 1)),
    headers,
    body: rawBody,
    host: (typeof req.headers.host === 'string' ? req.headers.host : undefined) ?? '127.0.0.1',
  };

  // Health probe: no auth, always 200.
  if (request.method === 'GET' && pathname === '/healthz') {
    sendReply(res, jsonReply(200, { ok: true }));
    return;
  }

  // Bearer auth: the trial token when set; any non-empty bearer in dev mode.
  const token = shopToken();
  const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
  const authed = token === '' ? authorization.startsWith('Bearer ') && authorization.length > 7 : authorization === `Bearer ${token}`;
  if (!authed) {
    sendReply(res, errorReply(401, 'Requires authentication'));
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitRoute: GitRoute | null = parseGitPath(pathname);
  if (gitRoute !== null) {
    if (gitRoute.owner !== VIEWER_LOGIN) {
      sendReply(res, errorReply(404, 'Not Found'));
      return;
    }
    const repo = forge.getRepo(gitRoute.owner, gitRoute.repo);
    if (!repo) {
      sendReply(res, errorReply(404, 'Not Found'));
      return;
    }
    const reply = handleGit(forge, request, repo, gitRoute);
    sendReply(res, reply ?? errorReply(404, 'Not Found'));
    return;
  }

  const graphql = handleGraphQL(forge, request);
  if (graphql !== null) {
    sendReply(res, graphql);
    return;
  }

  const mcp = handleMcp(forge, request);
  if (mcp !== null) {
    sendReply(res, mcp);
    return;
  }

  const rest = handleRest(forge, request);
  if (rest !== null) {
    sendReply(res, rest);
    return;
  }

  sendReply(res, errorReply(404, 'Not Found'));
}

/** Build the request handler (exported so a local driver can run the forge directly). */
export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handleRequest(req, Buffer.concat(chunks), res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendReply(res, errorReply(500, err instanceof Error ? err.message : 'Internal error'));
        } else {
          res.end();
        }
      });
    });
    req.on('error', () => {
      if (!res.headersSent) sendReply(res, errorReply(500, 'Request error'));
    });
  };
}

export function serve(): ReturnType<typeof createServer> {
  return createServer(createApp());
}
