// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp, plain JSON replies).
// Era 2026-07-28: `server/discover` plus the legacy `initialize` handshake, `tools/list`
// and `tools/call` over the same store the REST API uses.

import { VIEWER_ID, VIEWER_LOGIN, type Forge } from './store.ts';
import { asBoolean, asNumber, asString, errorReply, isRecord, jsonReply, parseJsonBody, type Reply, type Req } from './http-util.ts';
import { performSquashMerge } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, httpStatus = 200): Reply {
  return jsonReply(httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(structured: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Run one tool call. Returns the `result` payload, or an error message to report as isError. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): { ok: true; result: unknown } | { ok: false; message: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, message: `Unknown tool "${name}"` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, message: `Missing required argument "${required}" for tool "${name}"` };
    }
  }
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (name !== 'create_repo') {
    if (owner === null || repoName === null) return { ok: false, message: 'owner and repo are required' };
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    if (name === 'get_repo') {
      const view = {
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      };
      return { ok: true, result: toolText(view) };
    }
    if (name === 'create_issue') {
      const title = asString(args.title);
      if (title === null) return { ok: false, message: 'title is required' };
      const issue = {
        id: forge.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: asString(args.body) ?? '',
        state: 'open',
        labels: [],
        createdSeq: forge.seq++,
        comments: [],
      };
      repo.issues.push(issue);
      const view = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [] };
      return { ok: true, result: toolText(view) };
    }
    if (name === 'list_issues') {
      const state = asString(args.state) ?? 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return { ok: true, result: toolText({ issues: list }) };
    }
    if (name === 'create_pull_request') {
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (title === null || head === null || base === null) {
        return { ok: false, message: 'title, head and base are required' };
      }
      const headSha = forge.resolveCommit(repo, head);
      const baseSha = forge.resolveCommit(repo, base);
      if (headSha === null || baseSha === null) {
        return { ok: false, message: 'head or base branch does not exist' };
      }
      const pull = {
        id: forge.nextPullId++,
        number: repo.nextNumber++,
        title,
        body: '',
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        createdSeq: forge.seq++,
      };
      repo.pulls.push(pull);
      const view = {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      };
      return { ok: true, result: toolText(view) };
    }
    if (name === 'merge_pull_request') {
      const pullNumber = asNumber(args.pull_number);
      if (pullNumber === null) return { ok: false, message: 'pull_number is required' };
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (!pull) return { ok: false, message: `Pull request #${pullNumber} not found` };
      const result = performSquashMerge(forge, repo, pull);
      if (!result.ok) return { ok: false, message: result.reason ?? 'merge failed' };
      return { ok: true, result: toolText({ sha: result.sha, merged: true, message: 'Pull request successfully merged' }) };
    }
  }
  if (name === 'create_repo') {
    const repoNameArg = asString(args.name);
    if (repoNameArg === null) return { ok: false, message: 'name is required' };
    const repo = forge.createRepo(VIEWER_LOGIN, repoNameArg, {
      description: asString(args.description) ?? undefined,
      private: asBoolean(args.private) ?? undefined,
    });
    if (repo === null) return { ok: false, message: 'Repository already exists' };
    const view = {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
    return { ok: true, result: toolText(view) };
  }
  return { ok: false, message: `Unknown tool "${name}"` };
}

export function handleMcp(forge: Forge, req: Req): Reply | null {
  if (req.segments[0] !== 'mcp') return null;
  if (req.method !== 'POST') return errorReply(404, 'Not Found');
  const parsed = parseJsonBody(req);
  if (!parsed.ok) {
    // A non-JSON body is a JSON-RPC parse error.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    return rpcError(isRecord(body) ? body.id ?? null : null, -32600, 'Invalid Request');
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    return rpcResult(id, {
      protocolVersion: offered ?? '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = asString(params.name);
    if (toolName === null) return rpcError(id, -32602, 'Invalid params: tool name is required');
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = callTool(forge, toolName, args);
    if (!outcome.ok) {
      // Unknown tool or missing arguments: a JSON-RPC invalid-params error.
      if (outcome.message.startsWith('Unknown tool') || outcome.message.startsWith('Missing required argument')) {
        return rpcError(id, -32602, outcome.message);
      }
      return rpcResult(id, toolError(outcome.message));
    }
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
