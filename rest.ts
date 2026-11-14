// rest.ts — GitHub REST API v3: repos, refs, branches, commits, contents, labels,
// issues, comments and pull requests, all on the shared in-memory store.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  hashObject,
  mergeBase,
  parseCommit,
  parseTree,
  type Forge,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  asBoolean,
  asString,
  errorReply,
  isRecord,
  isoNow,
  jsonReply,
  parseJsonBody,
  type Reply,
  type Req,
} from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function pullView(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function notFound(): Reply {
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents: tree surgery on the store
// ---------------------------------------------------------------------------------------------

/** Rebuild a tree (storing every intermediate tree) from a flat path -> blob map. */
export function buildNestedTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: { mode: string; name: string; oid: string }[];
    dirs: Map<string, Map<string, { oid: string; mode: string }>>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      root.files.push({ mode: entry.mode, name: path, oid: entry.oid });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      if (!root.dirs.has(dir)) root.dirs.set(dir, new Map());
      root.dirs.get(dir)!.set(rest, entry);
    }
  }
  const build = (node: Node): string => {
    const entries = [...node.files];
    for (const [dir, sub] of node.dirs) {
      const subNode: Node = { files: [], dirs: new Map() };
      for (const [path, entry] of sub) {
        const slash = path.indexOf('/');
        if (slash < 0) subNode.files.push({ mode: entry.mode, name: path, oid: entry.oid });
        else {
          const d = path.slice(0, slash);
          if (!subNode.dirs.has(d)) subNode.dirs.set(d, new Map());
          subNode.dirs.get(d)!.set(path.slice(slash + 1), entry);
        }
      }
      entries.push({ mode: '40000', name: dir, oid: build(subNode) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Descend a tree to a path; returns the entry's oid/mode or null. */
function resolveTreePath(
  repo: Repo,
  treeOid: string,
  path: string,
): { oid: string; mode: string } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The direct children of a directory path ('' = the root), as contents entries. */
function listDirectory(repo: Repo, treeOid: string, path: string): Record<string, unknown>[] | null {
  let current = treeOid;
  if (path !== '') {
    const resolved = resolveTreePath(repo, treeOid, path);
    if (!resolved || resolved.mode !== '40000') return null;
    current = resolved.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

interface CommitResult {
  commitSha: string;
  blobSha: string | null;
  created: boolean;
}

/** Apply a file create/update/delete on a branch, creating the branch if missing. */
function commitFileChange(
  forge: Forge,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): CommitResult {
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refs.get(branchRef) ?? null;
  let createdBranch = false;
  if (tip === null) {
    // A new branch starts at the default branch's tip (or nothing, for an unborn repo).
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    createdBranch = true;
  }
  const baseTreeOid = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const flat = baseTreeOid === null ? new Map() : flattenTree(baseTreeOid, (oid) => repo.objects.get(oid));
  let blobSha: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobSha = hashObject('blob', content);
    repo.objects.set(blobSha, { type: 'blob', data: content });
    flat.set(path, { oid: blobSha, mode: '100644' });
  }
  const treeOid = buildNestedTree(repo, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message,
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
  });
  const commitSha = hashObject('commit', commitData);
  repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(branchRef, commitSha);
  return { commitSha, blobSha, created: createdBranch };
}

// ---------------------------------------------------------------------------------------------
// merge logic
// ---------------------------------------------------------------------------------------------

/** Is a pull request mergeable right now? (UNKNOWN is never returned: the store knows.) */
export function mergeableState(forge: Forge, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = forge.resolveCommit(repo, pull.baseRef);
  const headTip = forge.resolveCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'CONFLICTING';
  const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
  if (base === null) return 'CONFLICTING';
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const currentBaseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headChanges = diffTrees(baseTree, headTree, (oid) => repo.objects.get(oid));
  const baseChanges = diffTrees(baseTree, currentBaseTree, (oid) => repo.objects.get(oid));
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (!other) continue;
    // Both sides touched the same path. A conflict is any difference in the result,
    // unless both sides produced exactly the same blob (identical edits merge cleanly).
    const headBlob = change.status === 'removed' ? null : flattenTree(headTree, (oid) => repo.objects.get(oid)).get(change.path)?.oid ?? null;
    const baseBlob = other.status === 'removed' ? null : flattenTree(currentBaseTree, (oid) => repo.objects.get(oid)).get(other.path)?.oid ?? null;
    if (headBlob !== baseBlob) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Shared with the GraphQL mutation. */
export function performSquashMerge(
  forge: Forge,
  repo: Repo,
  pull: PullRequest,
): { ok: boolean; sha?: string; reason?: string } {
  const baseTip = forge.resolveCommit(repo, pull.baseRef);
  const headTip = forge.resolveCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'head or base branch does not exist' };
  if (mergeableState(forge, repo, pull) === 'CONFLICTING') return { ok: false, reason: 'Merge conflict' };
  const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const currentBaseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headChanges = diffTrees(baseTree, headTree, (oid) => repo.objects.get(oid));
  const flat = flattenTree(currentBaseTree, (oid) => repo.objects.get(oid));
  for (const change of headChanges) {
    if (change.status === 'removed') {
      flat.delete(change.path);
    } else {
      const entry = flattenTree(headTree, (oid) => repo.objects.get(oid)).get(change.path);
      if (entry) flat.set(change.path, entry);
    }
  }
  const newTree = buildNestedTree(repo, flat);
  const mergeData = buildCommit({
    tree: newTree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
  });
  const mergeSha = hashObject('commit', mergeData);
  repo.objects.set(mergeSha, { type: 'commit', data: mergeData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha };
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: Req): Reply | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const segments = req.segments.slice(2);
  const method = req.method;

  // --- API root and meta ---------------------------------------------------------------
  if (segments.length === 0 && method === 'GET') {
    return jsonReply(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return jsonReply(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
  }

  // --- create / list the viewer's repos -------------------------------------------------
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = asString(body.name);
      if (name === null || name === '') return errorReply(422, 'Validation Failed: name is required');
      const repo = forge.createRepo(VIEWER_LOGIN, name, {
        description: asString(body.description) ?? undefined,
        private: asBoolean(body.private) ?? undefined,
      });
      if (repo === null) return errorReply(422, 'Repository already exists');
      return jsonReply(201, repoView(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
      const all = forge.listRepos(VIEWER_LOGIN);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page < totalPages) {
        const base = `http://${req.host}${req.pathname}`;
        const links: string[] = [`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`];
        links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
        extra.Link = links.join(', ');
      }
      return jsonReply(200, slice.map(repoView), extra);
    }
    return errorReply(404, 'Not Found');
  }

  // --- repo-scoped routes ---------------------------------------------------------------
  if (segments.length >= 2 && segments[0] === 'repos') {
    const owner = segments[1];
    const name = segments[2] ?? '';
    if (owner !== VIEWER_LOGIN) return notFound();
    const repo = forge.getRepo(owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return notFound();
        return jsonReply(200, repoView(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return notFound();
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const description = asString(body.description);
        if (description !== null) repo.description = description;
        return jsonReply(200, repoView(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return notFound();
        forge.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return errorReply(404, 'Not Found');
    }

    if (!repo) return notFound();

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === null || sha === null || !ref.startsWith('refs/')) {
          return errorReply(422, 'Validation Failed: ref and sha are required');
        }
        if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
          return errorReply(422, 'Validation Failed: sha does not exist');
        }
        repo.refs.set(ref, sha);
        return jsonReply(201, { ref, object: { sha, type: object.type } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        return jsonReply(200, { ref, object: { sha: oid } });
      }
      return errorReply(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
        return jsonReply(200, branches);
      }
      if (method === 'GET' && rest.length === 2) {
        const oid = repo.refs.get(`refs/heads/${rest[1]}`);
        if (oid === undefined) return notFound();
        return jsonReply(200, { name: rest[1], commit: { sha: oid }, protected: false });
      }
      return errorReply(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveCommit(repo, ref);
      if (tip === null) return notFound();
      const commits = forge.listCommits(repo, tip).map((oid) => {
        const commit = parseCommit(repo.objects.get(oid)!.data);
        return {
          sha: oid,
          commit: {
            message: commit.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID },
          committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
        };
      });
      return jsonReply(200, commits);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const branch = req.query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = forge.resolveCommit(repo, branch);
        if (tip === null) return notFound();
        const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
        if (path === '') {
          const listing = listDirectory(repo, treeOid, '');
          return jsonReply(200, listing ?? []);
        }
        const entry = resolveTreePath(repo, treeOid, path);
        if (!entry) return notFound();
        if (entry.mode === '40000') {
          const listing = listDirectory(repo, treeOid, path);
          return jsonReply(200, listing ?? []);
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob) return notFound();
        return jsonReply(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: path.split('/').pop(),
          path,
          content: blob.data.toString('base64'),
          sha: entry.oid,
        });
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const contentB64 = asString(body.content);
        if (contentB64 === null) return errorReply(422, 'Validation Failed: content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorReply(400, 'Bad request: content is not valid base64');
        }
        const targetBranch = asString(body.branch) ?? branch;
        const message = asString(body.message) ?? `Update ${path}`;
        const currentTip = forge.resolveCommit(repo, targetBranch);
        let existed = false;
        if (currentTip !== null) {
          const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
          const current = resolveTreePath(repo, currentTree, path);
          if (current) {
            existed = true;
            const givenSha = asString(body.sha);
            if (givenSha !== null && givenSha !== current.oid) {
              return errorReply(409, 'Conflict: sha does not match the current file');
            }
          }
        }
        const result = commitFileChange(forge, repo, targetBranch, path, content, message);
        return jsonReply(existed ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const targetBranch = asString(body.branch) ?? branch;
        const message = asString(body.message) ?? `Delete ${path}`;
        const currentTip = forge.resolveCommit(repo, targetBranch);
        if (currentTip === null) return notFound();
        const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
        const current = resolveTreePath(repo, currentTree, path);
        if (!current) return notFound();
        const givenSha = asString(body.sha);
        if (givenSha !== null && givenSha !== current.oid) {
          return errorReply(409, 'Conflict: sha does not match the current file');
        }
        const result = commitFileChange(forge, repo, targetBranch, path, null, message);
        return jsonReply(200, { content: null, commit: { sha: result.commitSha, message } });
      }
      return errorReply(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const labelName = asString(body.name);
        const color = asString(body.color) ?? 'ffffff';
        if (labelName === null || labelName === '') return errorReply(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(labelName);
        if (existing) return jsonReply(201, { name: existing.name, color: existing.color });
        const label: Label = { name: labelName, color };
        repo.labels.set(labelName, label);
        return jsonReply(201, { name: label.name, color: label.color });
      }
      if (method === 'GET' && rest.length === 1) {
        return jsonReply(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      return errorReply(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        if (title === null || title === '') return errorReply(422, 'Validation Failed: title is required');
        const labelNames = Array.isArray(body.labels)
          ? body.labels.map((l) => (typeof l === 'string' ? l : isRecord(l) ? asString(l.name) : null)).filter((l): l is string => l !== null)
          : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (!label) return errorReply(422, `Validation Failed: label "${labelName}" does not exist`);
          labels.push(label);
        }
        const issue: Issue = {
          id: forge.nextIssueId++,
          number: repo.nextNumber++,
          title,
          body: asString(body.body) ?? '',
          state: 'open',
          labels,
          createdSeq: forge.seq++,
          comments: [],
        };
        repo.issues.push(issue);
        return jsonReply(201, issueView(issue));
      }
      if (method === 'GET' && rest.length === 1) {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        return jsonReply(200, list.map(issueView));
      }
      const issueNumber = Number.parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      if (rest.length === 2 && method === 'GET') {
        if (!issue) return notFound();
        return jsonReply(200, issueView(issue));
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (!issue) return notFound();
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        const state = asString(body.state);
        const issueBody = asString(body.body);
        if (title !== null) issue.title = title;
        if (issueBody !== null) issue.body = issueBody;
        if (state === 'open' || state === 'closed') issue.state = state;
        return jsonReply(200, issueView(issue));
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.reply;
          const body = isRecord(parsed.value) ? parsed.value : {};
          const commentBody = asString(body.body);
          if (commentBody === null) return errorReply(422, 'Validation Failed: body is required');
          const comment = { id: forge.nextCommentId++, body: commentBody, createdSeq: forge.seq++ };
          issue.comments.push(comment);
          return jsonReply(201, {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID },
            created_at: isoNow(),
          });
        }
        if (method === 'GET') {
          return jsonReply(200, issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID },
            created_at: isoNow(),
          })));
        }
      }
      return errorReply(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        const head = asString(body.head);
        const base = asString(body.base);
        if (title === null || head === null || base === null) {
          return errorReply(422, 'Validation Failed: title, head and base are required');
        }
        const headSha = forge.resolveCommit(repo, head);
        const baseSha = forge.resolveCommit(repo, base);
        if (headSha === null || baseSha === null) {
          return errorReply(422, 'Validation Failed: head or base branch does not exist');
        }
        const pull: PullRequest = {
          id: forge.nextPullId++,
          number: repo.nextNumber++,
          title,
          body: asString(body.body) ?? '',
          state: 'open',
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
        return jsonReply(201, pullView(pull));
      }
      if (method === 'GET' && rest.length === 1) {
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        return jsonReply(200, list.map(pullView));
      }
      const pullNumber = Number.parseInt(rest[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (rest.length === 2 && method === 'GET') {
        if (!pull) return notFound();
        return jsonReply(200, pullView(pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return notFound();
        const baseCommit = repo.objects.get(pull.baseSha);
        const headCommit = repo.objects.get(pull.headSha);
        if (!baseCommit || !headCommit) return notFound();
        const baseTree = parseCommit(baseCommit.data).tree;
        const headTree = parseCommit(headCommit.data).tree;
        const changes = diffTrees(baseTree, headTree, (oid) => repo.objects.get(oid));
        return jsonReply(200, changes.map((c) => ({
          filename: c.path,
          status: c.status,
          additions: c.additions,
          deletions: c.deletions,
          changes: c.additions + c.deletions,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return notFound();
        if (pull.merged) {
          return jsonReply(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
        }
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.reply;
        const result = performSquashMerge(forge, repo, pull);
        if (!result.ok) {
          if (result.reason === 'Merge conflict') return errorReply(405, 'Merge conflict');
          return notFound();
        }
        return jsonReply(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return errorReply(404, 'Not Found');
    }
  }

  return errorReply(404, 'Not Found');
}
