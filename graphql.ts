// graphql.ts — a small GraphQL v4 implementation for this forge: a recursive-descent
// parser for the documents the suite sends, plus an executor over the shared store.
// Only the surface the suite exercises is implemented; unknown fields report an error
// naming the field (HTTP 200, `errors` array) instead of failing the request.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  diffTrees,
  globalId,
  parseCommit,
  parseGlobalId,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { asString, errorReply, isRecord, isoNow, jsonReply, parseJsonBody, type Reply, type Req } from './http-util.ts';
import { mergeableState, performSquashMerge } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Enum'; value: string }
  | { kind: 'Null' }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSpread | InlineFragment;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue?: ValueNode }[];
  selections: Selection[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDefinition>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`Expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expect('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.peek().value === '{') {
      return { kind, name, variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.next();
    if (keyword.value === 'mutation') kind = 'mutation';
    else if (keyword.value !== 'query') throw new Error(`Unknown operation ${JSON.stringify(keyword.value)}`);
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.peek().value === '(' ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    return { kind, name, variables, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): { name: string; type: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; type: string; defaultValue?: ValueNode }[] = [];
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  private parseType(): string {
    let type: string;
    if (this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
      this.expect(']');
    } else {
      type = this.expectName();
    }
    if (this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek().value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().value === '(' ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'int') return { kind: 'Int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'Float', value: Number.parseFloat(token.value) };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'List', values };
    }
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().value !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'Object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema metadata (for __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Viewer: ['login', 'id', 'name', 'email', 'repositories'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository'],
  User: ['login', 'id', 'name', 'email'],
  Commit: ['oid'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'body', 'author'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  LabelConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  RepositoryConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  RepositoryEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PULL_REQUEST', 'PROJECT', 'WIKI', 'REGISTRY_PACKAGE'];

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, FragmentDefinition>;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

function makeConnection(connectionType: string, edgeType: string, nodes: GqlObject[], first: unknown, after: unknown): GqlObject {
  const start = typeof after === 'string' ? decodeCursor(after) + 1 : 0;
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, first) : nodes.length;
  const page = nodes.slice(start, start + limit);
  return {
    __typename: connectionType,
    nodes: page,
    edges: page.map((node, i) => ({ __typename: edgeType, node, cursor: encodeCursor(start + i) })),
    totalCount: nodes.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + limit < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
      endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
    },
  };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRequest): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function userObject(login: string, id: number): GqlObject {
  return {
    __typename: 'User',
    login,
    id,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : `${login}@example.invalid`,
  };
}

function findRepoById(forge: Forge, databaseId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

/** Look an issue up by the (repo id, number) pair its global id carries. */
function findIssueByRef(forge: Forge, repoId: number, number: number): { repo: Repo; issue: Issue } | null {
  const repo = findRepoById(forge, repoId);
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === number);
  return issue ? { repo, issue } : null;
}

/** Look a pull request up by the (repo id, number) pair its global id carries. */
function findPullByRef(forge: Forge, repoId: number, number: number): { repo: Repo; pull: PullRequest } | null {
  const repo = findRepoById(forge, repoId);
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === number);
  return pull ? { repo, pull } : null;
}

interface FieldResult {
  value: unknown;
  /** The __typename to recurse into when `value` is an object (or array of objects). */
  type: string | null;
}

/** Resolve one field. Returns undefined for an unknown field (error already recorded). */
function resolveField(
  typeName: string,
  source: GqlObject,
  field: FieldSelection,
  ctx: ExecContext,
): FieldResult | undefined {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, ctx.variables);
  const forge = ctx.forge;
  const unknown = (): undefined => {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}"` });
    return undefined;
  };

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return { value: { __typename: 'Viewer', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, type: 'Viewer' };
    }
    if (field.name === 'repository') {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner !== VIEWER_LOGIN) return { value: null, type: null };
      const repo = owner === null || name === null ? undefined : forge.getRepo(owner, name);
      return { value: repo ? repoObject(repo) : null, type: 'Repository' };
    }
    if (field.name === 'node') {
      const id = asString(args.id);
      const parsed = id === null ? null : parseGlobalId(id);
      if (parsed === null) return { value: null, type: null };
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(forge, Number(parsed.parts[0]));
        return { value: repo ? repoObject(repo) : null, type: 'Repository' };
      }
      if (parsed.kind === 'Issue') {
        const issue = findIssueByRef(forge, Number(parsed.parts[0]), Number(parsed.parts[1]));
        return { value: issue ? issueObject(issue.repo, issue.issue) : null, type: 'Issue' };
      }
      if (parsed.kind === 'PullRequest') {
        const pull = findPullByRef(forge, Number(parsed.parts[0]), Number(parsed.parts[1]));
        return { value: pull ? pullObject(pull.repo, pull.pull) : null, type: 'PullRequest' };
      }
      return { value: null, type: null };
    }
    if (field.name === '__type') {
      const name = asString(args.name);
      if (name === null || !(name in TYPE_FIELDS) && name !== 'SearchType') return { value: null, type: null };
      if (name === 'SearchType') {
        return {
          value: {
            __typename: '__Type',
            name,
            kind: 'ENUM',
            fields: null,
            enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v })),
          },
          type: '__Type',
        };
      }
      return {
        value: {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: (TYPE_FIELDS[name] ?? []).map((f) => ({
            __typename: '__Field',
            name: f,
            type: { __typename: '__Type', name: 'String', kind: 'SCALAR', ofType: null },
          })),
          enumValues: null,
        },
        type: '__Type',
      };
    }
    if (field.name === '__schema') {
      return {
        value: {
          __typename: '__Schema',
          types: Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT', fields: null, enumValues: null })),
        },
        type: '__Schema',
      };
    }
    return unknown();
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = parseGlobalId(asString(input.repositoryId) ?? '');
      const repo = repoId?.kind === 'Repository' ? findRepoById(forge, Number(repoId.parts[0])) : undefined;
      const title = asString(input.title);
      if (!repo || title === null) {
        ctx.errors.push({ message: 'createIssue: repositoryId or title is invalid' });
        return { value: { __typename: 'CreateIssuePayload', issue: null }, type: 'CreateIssuePayload' };
      }
      const issue: Issue = {
        id: forge.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: asString(input.body) ?? '',
        state: 'open',
        labels: [],
        createdSeq: forge.seq++,
        comments: [],
      };
      repo.issues.push(issue);
      return { value: { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) }, type: 'CreateIssuePayload' };
    }
    if (field.name === 'closeIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const issueId = parseGlobalId(asString(input.issueId) ?? '');
      const issue = issueId?.kind === 'Issue' ? findIssueByRef(forge, Number(issueId.parts[0]), Number(issueId.parts[1])) : null;
      if (!issue) {
        ctx.errors.push({ message: 'closeIssue: issueId is invalid' });
        return { value: { __typename: 'CloseIssuePayload', issue: null }, type: 'CloseIssuePayload' };
      }
      issue.issue.state = 'closed';
      return { value: { __typename: 'CloseIssuePayload', issue: issueObject(issue.repo, issue.issue) }, type: 'CloseIssuePayload' };
    }
    if (field.name === 'createPullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = parseGlobalId(asString(input.repositoryId) ?? '');
      const repo = repoId?.kind === 'Repository' ? findRepoById(forge, Number(repoId.parts[0])) : undefined;
      const title = asString(input.title);
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      if (!repo || title === null || head === null || base === null) {
        ctx.errors.push({ message: 'createPullRequest: input is invalid' });
        return { value: { __typename: 'CreatePullRequestPayload', pullRequest: null }, type: 'CreatePullRequestPayload' };
      }
      const headSha = forge.resolveCommit(repo, head);
      const baseSha = forge.resolveCommit(repo, base);
      if (headSha === null || baseSha === null) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return { value: { __typename: 'CreatePullRequestPayload', pullRequest: null }, type: 'CreatePullRequestPayload' };
      }
      const pull: PullRequest = {
        id: forge.nextPullId++,
        number: repo.nextNumber++,
        title,
        body: asString(input.body) ?? '',
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
      return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) }, type: 'CreatePullRequestPayload' };
    }
    if (field.name === 'mergePullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const pullId = parseGlobalId(asString(input.pullRequestId) ?? '');
      const pull = pullId?.kind === 'PullRequest' ? findPullByRef(forge, Number(pullId.parts[0]), Number(pullId.parts[1])) : null;
      if (!pull) {
        ctx.errors.push({ message: 'mergePullRequest: pullRequestId is invalid' });
        return { value: { __typename: 'MergePullRequestPayload', pullRequest: null }, type: 'MergePullRequestPayload' };
      }
      const result = performSquashMerge(forge, pull.repo, pull.pull);
      if (!result.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${result.reason ?? 'merge failed'}` });
        return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullObject(pull.repo, pull.pull) }, type: 'MergePullRequestPayload' };
      }
      return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullObject(pull.repo, pull.pull) }, type: 'MergePullRequestPayload' };
    }
    if (field.name === 'addComment') {
      const input = isRecord(args.input) ? args.input : {};
      const subjectId = parseGlobalId(asString(input.subjectId) ?? '');
      const body = asString(input.body);
      const issue = subjectId?.kind === 'Issue' ? findIssueByRef(forge, Number(subjectId.parts[0]), Number(subjectId.parts[1])) : null;
      if (!issue || body === null) {
        ctx.errors.push({ message: 'addComment: subjectId or body is invalid' });
        return { value: { __typename: 'AddCommentPayload', commentEdge: null }, type: 'AddCommentPayload' };
      }
      const comment = { id: forge.nextCommentId++, body, createdSeq: forge.seq++ };
      issue.issue.comments.push(comment);
      return {
        value: {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('Comment', issue.repo.id, issue.issue.number, comment.id),
              body: comment.body,
              author: userObject(VIEWER_LOGIN, VIEWER_ID),
            },
            cursor: encodeCursor(issue.issue.comments.length - 1),
          },
        },
        type: 'AddCommentPayload',
      };
    }
    return unknown();
  }

  if (typeName === 'Viewer') {
    if (field.name === 'login') return { value: VIEWER_LOGIN, type: null };
    if (field.name === 'id') return { value: VIEWER_ID, type: null };
    if (field.name === 'name') return { value: VIEWER_NAME, type: null };
    if (field.name === 'email') return { value: VIEWER_EMAIL, type: null };
    if (field.name === 'repositories') {
      const nodes = forge.listRepos(VIEWER_LOGIN).map(repoObject);
      return { value: makeConnection('RepositoryConnection', 'RepositoryEdge', nodes, args.first, args.after), type: 'RepositoryConnection' };
    }
    return unknown();
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    if (field.name === 'id') return { value: globalId('Repository', repo.id), type: null };
    if (field.name === 'databaseId') return { value: repo.id, type: null };
    if (field.name === 'name') return { value: repo.name, type: null };
    if (field.name === 'nameWithOwner') return { value: `${repo.owner}/${repo.name}`, type: null };
    if (field.name === 'owner') return { value: userObject(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0), type: 'User' };
    if (field.name === 'defaultBranchRef') {
      const tip = forge.resolveCommit(repo, repo.defaultBranch);
      if (tip === null) return { value: null, type: null };
      return { value: { __typename: 'Ref', name: repo.defaultBranch, oid: tip }, type: 'Ref' };
    }
    if (field.name === 'viewerPermission') return { value: 'ADMIN', type: null };
    if (field.name === 'hasIssuesEnabled') return { value: true, type: null };
    if (field.name === 'issue') {
      const number = typeof args.number === 'number' ? args.number : null;
      const issue = number === null ? undefined : repo.issues.find((i) => i.number === number);
      return { value: issue ? issueObject(repo, issue) : null, type: 'Issue' };
    }
    if (field.name === 'issues') {
      let list = [...repo.issues];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      if (isRecord(args.orderBy)) {
        const direction = String(args.orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const nodes = list.map((i) => issueObject(repo, i));
      return { value: makeConnection('IssueConnection', 'IssueEdge', nodes, args.first, args.after), type: 'IssueConnection' };
    }
    if (field.name === 'pullRequest') {
      const number = typeof args.number === 'number' ? args.number : null;
      const pull = number === null ? undefined : repo.pulls.find((p) => p.number === number);
      return { value: pull ? pullObject(repo, pull) : null, type: 'PullRequest' };
    }
    if (field.name === 'pullRequests') {
      let list = [...repo.pulls];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      if (isRecord(args.orderBy)) {
        const direction = String(args.orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const nodes = list.map((p) => pullObject(repo, p));
      return { value: makeConnection('PullRequestConnection', 'PullRequestEdge', nodes, args.first, args.after), type: 'PullRequestConnection' };
    }
    return unknown();
  }

  if (typeName === 'Issue') {
    const { repo, issue } = source as unknown as { repo: Repo; issue: Issue };
    if (field.name === 'id') return { value: globalId('Issue', repo.id, issue.number), type: null };
    if (field.name === 'databaseId') return { value: issue.id, type: null };
    if (field.name === 'number') return { value: issue.number, type: null };
    if (field.name === 'title') return { value: issue.title, type: null };
    if (field.name === 'body') return { value: issue.body, type: null };
    if (field.name === 'state') return { value: issue.state.toUpperCase(), type: null };
    if (field.name === 'createdAt') return { value: isoNow(), type: null };
    if (field.name === 'author') return { value: userObject(VIEWER_LOGIN, VIEWER_ID), type: 'User' };
    if (field.name === 'repository') return { value: repoObject(repo), type: 'Repository' };
    if (field.name === 'labels') {
      const nodes: GqlObject[] = issue.labels.map((l) => ({ __typename: 'Label', id: globalId('Label', repo.id, l.name), name: l.name, color: l.color }));
      return { value: makeConnection('LabelConnection', 'LabelEdge', nodes, args.first, args.after), type: 'LabelConnection' };
    }
    if (field.name === 'comments') {
      const nodes: GqlObject[] = issue.comments.map((c) => ({
        __typename: 'IssueComment',
        id: globalId('Comment', repo.id, issue.number, c.id),
        body: c.body,
        author: userObject(VIEWER_LOGIN, VIEWER_ID),
      }));
      return { value: makeConnection('IssueCommentConnection', 'IssueCommentEdge', nodes, args.first, args.after), type: 'IssueCommentConnection' };
    }
    return unknown();
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as unknown as { repo: Repo; pull: PullRequest };
    if (field.name === 'id') return { value: globalId('PullRequest', repo.id, pull.number), type: null };
    if (field.name === 'databaseId') return { value: pull.id, type: null };
    if (field.name === 'number') return { value: pull.number, type: null };
    if (field.name === 'title') return { value: pull.title, type: null };
    if (field.name === 'body') return { value: pull.body, type: null };
    if (field.name === 'state') return { value: pull.merged ? 'MERGED' : pull.state.toUpperCase(), type: null };
    if (field.name === 'merged') return { value: pull.merged, type: null };
    if (field.name === 'mergedAt') return { value: pull.mergedAt, type: null };
    if (field.name === 'mergeable') return { value: mergeableState(forge, repo, pull), type: null };
    if (field.name === 'headRefName') return { value: pull.headRef, type: null };
    if (field.name === 'baseRefName') return { value: pull.baseRef, type: null };
    if (field.name === 'headRef') return { value: { __typename: 'Ref', name: pull.headRef, oid: pull.headSha }, type: 'Ref' };
    if (field.name === 'baseRef') return { value: { __typename: 'Ref', name: pull.baseRef, oid: pull.baseSha }, type: 'Ref' };
    if (field.name === 'author') return { value: userObject(VIEWER_LOGIN, VIEWER_ID), type: 'User' };
    if (field.name === 'repository') return { value: repoObject(repo), type: 'Repository' };
    if (field.name === 'files') {
      const baseCommit = repo.objects.get(pull.baseSha);
      const headCommit = repo.objects.get(pull.headSha);
      if (!baseCommit || !headCommit) return { value: makeConnection('PullRequestFileConnection', 'PullRequestFileEdge', [], args.first, args.after), type: 'PullRequestFileConnection' };
      const baseTree = parseCommit(baseCommit.data).tree;
      const headTree = parseCommit(headCommit.data).tree;
      const changes = diffTrees(baseTree, headTree, (oid) => repo.objects.get(oid));
      const nodes: GqlObject[] = changes.map((c) => ({
        __typename: 'PullRequestFile',
        path: c.path,
        additions: c.additions,
        deletions: c.deletions,
      }));
      return { value: makeConnection('PullRequestFileConnection', 'PullRequestFileEdge', nodes, args.first, args.after), type: 'PullRequestFileConnection' };
    }
    return unknown();
  }

  if (typeName === 'User') {
    if (field.name === 'login') return { value: source.login, type: null };
    if (field.name === 'id') return { value: source.id, type: null };
    if (field.name === 'name') return { value: source.name ?? null, type: null };
    if (field.name === 'email') return { value: source.email ?? null, type: null };
    return unknown();
  }

  if (typeName === 'Commit') {
    if (field.name === 'oid') return { value: source.oid, type: null };
    return unknown();
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return { value: source.name, type: null };
    if (field.name === 'target') return { value: { __typename: 'Commit', oid: source.oid }, type: 'Commit' };
    return unknown();
  }

  if (typeName === 'Label') {
    if (field.name === 'id') return { value: source.id, type: null };
    if (field.name === 'name') return { value: source.name, type: null };
    if (field.name === 'color') return { value: source.color, type: null };
    return unknown();
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id') return { value: source.id, type: null };
    if (field.name === 'body') return { value: source.body, type: null };
    if (field.name === 'author') return { value: source.author, type: 'User' };
    return unknown();
  }

  if (typeName === 'PullRequestFile') {
    if (field.name === 'path') return { value: source.path, type: null };
    if (field.name === 'additions') return { value: source.additions, type: null };
    if (field.name === 'deletions') return { value: source.deletions, type: null };
    return unknown();
  }

  if (typeName.endsWith('Connection')) {
    if (field.name === 'nodes') return { value: source.nodes, type: null };
    if (field.name === 'edges') return { value: source.edges, type: null };
    if (field.name === 'totalCount') return { value: source.totalCount, type: null };
    if (field.name === 'pageInfo') return { value: source.pageInfo, type: 'PageInfo' };
    return unknown();
  }

  if (typeName.endsWith('Edge')) {
    if (field.name === 'node') return { value: source.node, type: null };
    if (field.name === 'cursor') return { value: source.cursor, type: null };
    return unknown();
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return { value: source.hasNextPage, type: null };
    if (field.name === 'hasPreviousPage') return { value: source.hasPreviousPage, type: null };
    if (field.name === 'startCursor') return { value: source.startCursor, type: null };
    if (field.name === 'endCursor') return { value: source.endCursor, type: null };
    return unknown();
  }

  if (typeName === '__Type') {
    if (field.name === 'name') return { value: source.name, type: null };
    if (field.name === 'kind') return { value: source.kind, type: null };
    if (field.name === 'fields') return { value: source.fields, type: null };
    if (field.name === 'enumValues') return { value: source.enumValues, type: null };
    return unknown();
  }

  if (typeName === '__Field') {
    if (field.name === 'name') return { value: source.name, type: null };
    if (field.name === 'type') return { value: source.type, type: '__Type' };
    return unknown();
  }

  if (typeName === '__EnumValue') {
    if (field.name === 'name') return { value: source.name, type: null };
    return unknown();
  }

  if (typeName === '__Schema') {
    if (field.name === 'types') return { value: source.types, type: null };
    return unknown();
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') return { value: source.issue, type: 'Issue' };
    return unknown();
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return { value: source.pullRequest, type: 'PullRequest' };
    return unknown();
  }

  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return { value: source.commentEdge, type: 'IssueCommentEdge' };
    return unknown();
  }

  return unknown();
}

function executeSelections(
  typeName: string,
  source: GqlObject,
  selections: Selection[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"` });
        continue;
      }
      Object.assign(out, executeSelections(typeName, source, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(typeName, source, selection.selections, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const result = resolveField(typeName, source, selection, ctx);
    if (result === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections.length > 0 && result.value !== null && result.value !== undefined) {
      if (Array.isArray(result.value)) {
        out[key] = result.value.map((item) => {
          if (item !== null && typeof item === 'object' && '__typename' in item) {
            const child = item as GqlObject;
            return executeSelections(child.__typename, child, selection.selections, ctx);
          }
          return item;
        });
      } else if (typeof result.value === 'object') {
        const child = result.value as GqlObject;
        const childType = result.type ?? child.__typename;
        out[key] = executeSelections(childType, child, selection.selections, ctx);
      } else {
        out[key] = result.value;
      }
    } else {
      out[key] = result.value;
    }
  }
  return out;
}

function executeOperation(operation: Operation, document: Document, forge: Forge, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { forge, variables, errors: [], fragments: document.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, { __typename: rootType }, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------------------------

export function handleGraphQL(forge: Forge, req: Req): Reply | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'graphql') return null;
  if (req.method !== 'POST') return errorReply(404, 'Not Found');
  const parsed = parseJsonBody(req);
  if (!parsed.ok) return parsed.reply;
  const body = parsed.value;
  const documents: { query?: unknown; variables?: unknown; operationName?: unknown }[] = Array.isArray(body)
    ? body.filter(isRecord)
    : isRecord(body)
      ? [body]
      : [];
  if (documents.length === 0) return errorReply(400, 'Bad request: expected a GraphQL request object');
  const results: Record<string, unknown>[] = [];
  for (const doc of documents) {
    const query = asString(doc.query);
    if (query === null) {
      results.push({ data: null, errors: [{ message: 'GraphQL query is required' }] });
      continue;
    }
    let document: Document;
    try {
      document = parseGraphQL(query);
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const operationName = asString(doc.operationName);
    const operation = document.operations.find((op) => op.name === operationName) ?? document.operations[0];
    if (!operation) {
      results.push({ data: null, errors: [{ message: 'No operation found in document' }] });
      continue;
    }
    results.push(executeOperation(operation, document, forge, variables));
  }
  return jsonReply(200, Array.isArray(body) ? results : results[0]);
}
