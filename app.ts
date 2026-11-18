// app.ts — the HTTP server: health probe, bearer auth, and routing to the git,
// REST, GraphQL and MCP surfaces. Every reply carries a non-empty
// X-GitHub-Request-Id and, for JSON, an application/json content type.
//
// Transport is raw-http.ts (a minimal HTTP/1.1 server over node:net): node:http's
// per-request cost dominates every benchmark workload, and this server answers
// the same bytes in about half the wall time against the bench's undici client.

import { VIEWER_LOGIN, forge } from './store.ts';
import { LazyQuery, errorReply, jsonReply, requestId, type Reply, type Req } from './http-util.ts';
import { handleGit, parseGitPath, type GitRoute } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { serveRaw, type RawReply, type RawRequest } from './raw-http.ts';

/** The bearer token every API call carries; set by the trial environment. */
let cachedToken: string | null = null;
export function shopToken(): string {
  // The environment fixes the token before the process starts; read it once.
  if (cachedToken === null) cachedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return cachedToken;
}

/** Normalise a handler reply into the raw server's one-write shape. */
function toRawReply(reply: Reply): RawReply {
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...(reply.headers ?? {}) };
  const body = reply.body === null ? null : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body, 'utf8');
  if (body !== null && !('content-type' in headers)) headers['content-type'] = 'application/json; charset=utf-8';
  return { status: reply.status, headers, body };
}

function handleRequest(raw: RawRequest): RawReply {
  // Parse the request line by hand: a URL object plus a headers copy per request
  // is pure overhead on a hot loop of thousands of small calls.
  const rawUrl = raw.target;
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
  // Headers arrive lower-cased from the raw server; use them in place.
  const headers = raw.headers;
  const request: Req = {
    method: raw.method.toUpperCase(),
    segments,
    pathname,
    query: new LazyQuery(queryIndex < 0 ? '' : rawUrl.slice(queryIndex + 1)),
    headers,
    body: raw.body,
    host: (typeof headers.host === 'string' ? headers.host : undefined) ?? '127.0.0.1',
  };

  // Health probe: no auth, always 200.
  if (request.method === 'GET' && pathname === '/healthz') {
    return toRawReply(jsonReply(200, { ok: true }));
  }

  // Bearer auth: the trial token when set; any non-empty bearer in dev mode.
  const token = shopToken();
  const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
  const authed = token === '' ? authorization.startsWith('Bearer ') && authorization.length > 7 : authorization === `Bearer ${token}`;
  if (!authed) return toRawReply(errorReply(401, 'Requires authentication'));

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitRoute: GitRoute | null = parseGitPath(pathname);
  if (gitRoute !== null) {
    if (gitRoute.owner !== VIEWER_LOGIN) return toRawReply(errorReply(404, 'Not Found'));
    const repo = forge.getRepo(gitRoute.owner, gitRoute.repo);
    if (!repo) return toRawReply(errorReply(404, 'Not Found'));
    const reply = handleGit(forge, request, repo, gitRoute);
    return toRawReply(reply ?? errorReply(404, 'Not Found'));
  }

  const graphql = handleGraphQL(forge, request);
  if (graphql !== null) return toRawReply(graphql);

  const mcp = handleMcp(forge, request);
  if (mcp !== null) return toRawReply(mcp);

  const rest = handleRest(forge, request);
  return toRawReply(rest ?? errorReply(404, 'Not Found'));
}

/** Build the server (exported so a local driver can run the forge directly). */
export function serve(): ReturnType<typeof serveRaw> {
  return serveRaw(handleRequest);
}
