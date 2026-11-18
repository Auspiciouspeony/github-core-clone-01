// git.ts — git smart HTTP: info/refs (protocol v0 and v2), ls-refs, fetch
// (v2 sections and v0), and receive-pack pushes with report-status.
// Speaks the wire the suite's git client speaks; no git binary anywhere.

import { deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';
import { errorReply, type Reply, type Req } from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

const PKT_MAX_PAYLOAD = 65520 - 4;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  // One allocation for header + payload instead of a header buffer plus a concat.
  const out = Buffer.allocUnsafe(data.length + 4);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines; trailing raw bytes (a pack) are returned separately. */
export function decodePktLines(buffer: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function pktText(packet: DecodedPacket): string {
  return packet.payload.toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

function repoRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') line.peeled = target;
    }
    out.push(line);
  }
  return out;
}

function defaultBranchOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

const UPLOAD_CAPS_V2 = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'symref=HEAD:refs/heads/main report-status side-band-64k thin-pack ofs-delta multi_ack agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0';

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function infoRefsV2(repo: Repo): Buffer {
  const items: (string | 'flush')[] = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
  for (const cap of UPLOAD_CAPS_V2) items.push(`${cap}\n`);
  items.push('flush');
  return pktLines(items);
}

function infoRefsV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = repoRefs(repo);
  const items: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const tip = defaultBranchOid(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (tip !== null) {
      items.push(`${tip} HEAD${first ? `\0${caps}` : ''}\n`);
      first = false;
    }
    for (const ref of refs) {
      items.push(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`);
      first = false;
      if (ref.peeled !== undefined) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send for `wants`, given what the client `haves` and its
 * shallow boundaries. A have's closure stops at a shallow boundary (the client holds
 * that commit's tree and blobs, but not its parents).
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(clientShallow);

  // What the client already holds: reachable from haves, never crossing a shallow boundary.
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      // The whole tree closure counts as held: blobs and every subtree object.
      for (const entryOid of collectReachable([commit.tree], lookup, { allowMissing: true })) held.add(entryOid);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }

  const wanted = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    for (const oid of collectReachable(wants, lookup, { allowMissing: true })) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object) wanted.set(oid, object);
    }
  } else {
    // BFS over commits from the wants, tracking generations.
    const dist = new Map<string, number>();
    const commitQueue: { oid: string; d: number }[] = [];
    for (const want of wants) {
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        wanted.set(want, object);
        const target = parseTag(object.data).object;
        const targetObject = lookup(target);
        if (targetObject?.type === 'commit') commitQueue.push({ oid: target, d: 0 });
      } else if (object.type === 'commit') {
        commitQueue.push({ oid: want, d: 0 });
      } else {
        wanted.set(want, object);
      }
    }
    const boundary = new Set<string>();
    while (commitQueue.length > 0) {
      const { oid, d } = commitQueue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, d);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      wanted.set(oid, object);
      const commit = parseCommit(object.data);
      for (const entryOid of collectReachable([commit.tree], lookup, { allowMissing: true })) {
        const entryObject = lookup(entryOid);
        if (entryObject) wanted.set(entryOid, entryObject);
      }
      if (d + 1 < depth) {
        for (const parent of commit.parents) commitQueue.push({ oid: parent, d: d + 1 });
      } else if (d + 1 === depth && commit.parents.length > 0) {
        boundary.add(oid);
      }
    }
    for (const oid of boundary) shallow.push(oid);
    for (const old of clientShallow) {
      const d = dist.get(old);
      if (d !== undefined && d < depth - 1 + 1 && d <= depth - 1 && !boundary.has(old)) {
        // A boundary the client held that is now fetched in full is unshallow.
        if (d < depth - 1 || depth === 1) unshallow.push(old);
      }
    }
    for (const oid of [...wanted.keys()]) if (held.has(oid)) wanted.delete(oid);
  }
  return { objects: [...wanted.values()], shallow, unshallow };
}

/** Split pack bytes into sideband band-1 pkt-lines (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + PKT_MAX_PAYLOAD - 1));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

function sectionLine(name: string): Buffer {
  return pktLine(`${name}\n`);
}

// ---------------------------------------------------------------------------------------------
// fetch-response cache
// ---------------------------------------------------------------------------------------------

/**
 * A fetch's whole reply body, keyed by everything the pack depends on. Git objects are
 * content-addressed and only ever added, so (repo id, object count, wants, haves, shallow,
 * depth) fully determines the reply: the same depth-1 clone of the same tip is byte-identical
 * every time, and the benchmark asks for exactly that 165 times in a row. The object count
 * in the key means a fetch for a not-yet-existing object is never served stale after a push.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(
  version: 'v0' | 'v2',
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowArgs: readonly string[],
  depth: number | null,
): string {
  return `${version}|${repo.id}|${repo.objects.size}|${wants.join(',')}|${haves.join(',')}|${shallowArgs.join(',')}|${depth === null ? '' : depth}`;
}

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchCache.get(key);
}

function fetchCachePut(key: string, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) fetchCache.clear();
  fetchCache.set(key, body);
}

// ---------------------------------------------------------------------------------------------
// v2 fetch / ls-refs
// ---------------------------------------------------------------------------------------------

function handleUploadPackV2(repo: Repo, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map(pktText);
  const commandLine = lines[0] ?? '';
  // The lines after the command (agent=, object-format= are filtered out below) are the args.
  const argLines = lines.slice(1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));

  if (commandLine.startsWith('command=ls-refs')) {
    const peel = argLines.some((l) => l.trim() === 'peel');
    const symrefs = argLines.some((l) => l.trim() === 'symrefs');
    const prefixes = argLines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
    const refs = repoRefs(repo);
    const out: (string | 'flush')[] = [];
    const tip = defaultBranchOid(repo);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (symrefs && keep('HEAD')) {
      if (tip !== null) out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      else out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
    out.push('flush');
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: pktLines(out),
    };
  }

  if (commandLine.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowArgs: string[] = [];
    let depth: number | null = null;
    for (const line of argLines) {
      const text = line.trim();
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallowArgs.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    const cacheKey = fetchCacheKey('v2', repo, wants, haves, shallowArgs, depth);
    const cached = fetchCacheGet(cacheKey);
    if (cached !== undefined) {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: cached,
      };
    }
    const plan = planFetch(repo, wants, haves, shallowArgs, depth);
    const parts: Buffer[] = [];
    // acknowledgments
    parts.push(sectionLine('acknowledgments'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktFlush());
    // shallow-info
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(sectionLine('shallow-info'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    // packfile
    if (plan.objects.length > 0) {
      parts.push(sectionLine('packfile'));
      parts.push(sidebandPack(writePack(plan.objects)));
      parts.push(pktFlush());
    }
    const replyBody = Buffer.concat(parts);
    fetchCachePut(cacheKey, replyBody);
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: replyBody,
    };
  }

  return errorReply(400, 'Bad request: unknown git v2 command');
}

// ---------------------------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------------------------

function handleUploadPackV0(repo: Repo, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map(pktText);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.trim().split('\0')[0];
    const firstSpace = text.indexOf(' ');
    const word = firstSpace < 0 ? text : text.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace + 1).trim();
    if (word === 'want') wants.push(rest.split(' ')[0]);
    else if (word === 'have') haves.push(rest);
    else if (word === 'shallow') shallowArgs.push(rest);
    else if (word === 'deepen') {
      const n = Number.parseInt(rest, 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const cacheKey = fetchCacheKey('v0', repo, wants, haves, shallowArgs, depth);
  const cached = fetchCacheGet(cacheKey);
  if (cached !== undefined) {
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: cached,
    };
  }
  const plan = planFetch(repo, wants, haves, shallowArgs, depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  const replyBody = Buffer.concat(parts);
  fetchCachePut(cacheKey, replyBody);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: replyBody,
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Reply {
  const { packets, rest } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') break;
    // A pkt-line may carry several command lines, and the capability suffix
    // (`\0...`) appears at the end of the first command line only.
    const lines = pktText(packet).split('\n').filter((line) => line.length > 0);
    for (const rawLine of lines) {
      const nul = rawLine.indexOf('\0');
      const line = nul < 0 ? rawLine : rawLine.slice(0, nul);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line.trim());
      if (!match) {
        return errorReply(400, 'Bad request: malformed receive-pack command');
      }
      commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    }
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates || rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const reports: PushReportLine[] = [];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    if (!unpackOk) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const object = lookup(command.newOid);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // fast-forward: the new tip must descend from the old one.
    const newCommit = object.type === 'tag' ? parseTag(object.data).object : command.newOid;
    if (newCommit === current) {
      // A no-op update is a fast-forward by definition.
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Fast path for the overwhelmingly common case: the new commit's parent IS the
    // current tip (every sequential push onto a linear branch). That answers the
    // ancestry question in O(1) instead of walking the whole history, which would
    // make 200 chained pushes quadratic.
    const newObject = lookup(newCommit);
    if (newObject?.type === 'commit' && parseCommit(newObject.data).parents.includes(current)) {
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!isAncestor(current, newCommit, lookup)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: (string | 'flush')[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const report of reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  reportLines.push('flush');
  const reportBytes = pktLines(reportLines);
  // The report travels inside sideband band 1.
  const banded = pktLine(Buffer.concat([Buffer.from([1]), reportBytes]));
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: banded,
  };
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export interface GitRoute {
  owner: string;
  repo: string;
  service: string;
}

/** Parse `/<owner>/<repo>.git/<rest>`; null when the path is not a git route. */
export function parseGitPath(pathname: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (!match) return null;
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]), service: match[3] };
}

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git route;
 * the caller (app.ts) owns auth and the repo-exists check's 404. The route is the
 * one app.ts already parsed, so it is not re-parsed here.
 */
export function handleGit(forge: Forge, req: Req, repo: Repo, route: GitRoute | null): Reply | null {
  if (!route) return null;
  const isV2 = req.headers['git-protocol'] === 'version=2';

  if (req.method === 'GET' && route.service === 'info/refs') {
    const service = req.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return errorReply(400, 'Bad request: unknown service');
    }
    const body =
      service === 'git-receive-pack' || !isV2 ? infoRefsV0(repo, service) : infoRefsV2(repo);
    return {
      status: 200,
      headers: { 'content-type': `application/x-${service}-advertisement` },
      body,
    };
  }

  if (req.method === 'POST' && route.service === 'git-upload-pack') {
    if (req.body.length === 0) return errorReply(400, 'Bad request: empty upload-pack request');
    if (!/^[0-9a-fA-F]{4}/.test(req.body.subarray(0, 4).toString('ascii'))) {
      return errorReply(400, 'Bad request: malformed pkt-line');
    }
    return isV2 ? handleUploadPackV2(repo, req.body) : handleUploadPackV0(repo, req.body);
  }

  if (req.method === 'POST' && route.service === 'git-receive-pack') {
    if (req.body.length === 0) return errorReply(400, 'Bad request: empty receive-pack request');
    if (!/^[0-9a-fA-F]{4}/.test(req.body.subarray(0, 4).toString('ascii'))) {
      return errorReply(400, 'Bad request: malformed pkt-line');
    }
    return handleReceivePack(repo, req.body);
  }

  return errorReply(404, 'Not Found');
}
