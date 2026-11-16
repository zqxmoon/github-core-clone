// graphql.ts — the GraphQL v4 surface at /api/graphql: a small parser and executor over a
// static schema, backed by the same forge state as REST. It speaks exactly the dialect the
// suite sends: operations with names and variables, aliases, inline fragments, inline enum
// lists and input objects, null variables, and batched operation arrays. Unknown fields are
// HTTP 200 with an errors array naming the field, as GitHub answers.

import {
  IssueState,
  PullState,
  Repo,
  VIEWER_LOGIN,
  createIssue,
  createPull,
  diffCommits,
  forge,
  mergePull,
  nextTimestampSec,
  pullConflicts,
} from './forge.ts';
import { Ctx, Reply, globalId, jsonReply, parseGlobalId } from './http.ts';

// ---------------------------------------------------------------------------
// schema: the field and enum surface introspection reports and validation uses.
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['login', 'id', 'name', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', '__typename',
  ],
  Ref: ['name', 'target', '__typename'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'closed', 'repository', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt', 'url', '__typename',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFilesConnection: ['nodes', 'totalCount', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', '__typename'],
  __Field: ['name', 'description', 'type', 'args', '__typename'],
  __EnumValue: ['name', 'description', '__typename'],
  __Schema: ['queryType', 'mutationType', 'types', '__typename'],
};

const ENUM_TYPES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// lexer and parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selectionSet: Selection[] | null;
}

type Selection =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '$', '!', '[', ']', '=', '@']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if (PUNCT.has(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push(`"${source.slice(index + 3, end < 0 ? source.length : end)}"`);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let text = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1];
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
        } else {
          text += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push(`"${text}"`);
      continue;
    }
    const rest = source.slice(index);
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      index += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragmentName = this.next();
        this.expect('on');
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(fragmentName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next(); // argument name
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      this.skipDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token) || /[eE]/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GqlObject {
  return { __type: type, ...fields };
}

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(node: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of node.args) out[name] = resolveValue(value, variables);
  return out;
}

function userObject(login: string): GqlObject {
  return obj('User', { login });
}

function issueObject(repo: Repo, issue: IssueState): GqlObject {
  return obj('Issue', { repo, issue });
}

function pullObject(repo: Repo, pull: PullState): GqlObject {
  return obj('PullRequest', { repo, pull });
}

function repoObject(repo: Repo): GqlObject {
  return obj('Repository', { repo });
}

function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface ExecContext {
  variables: Variables;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

/** Resolve one field on one object; returns a scalar, a GqlObject, a list, or null. */
function resolveField(source: GqlObject, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const type = source.__type;
  if (field === '__typename') return type;

  if (type === 'Query') {
    if (field === 'viewer') return userObject(VIEWER_LOGIN);
    if (field === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = forge.getRepo(owner, name);
      return repo ? repoObject(repo) : null;
    }
    if (field === 'node') return resolveNode(String(args.id ?? ''));
    if (field === '__type') return typeObject(String(args.name ?? ''));
    if (field === '__schema') return obj('__Schema', {});
    return null;
  }

  if (type === 'Mutation') {
    return resolveMutation(field, args, ctx);
  }

  if (type === 'User') {
    if (field === 'login') return source.login;
    if (field === 'id') return globalId('User', '1000');
    if (field === 'name') return 'ada iversen';
    return null;
  }

  if (type === 'Repository') {
    const repo = source.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return userObject(repo.owner);
      case 'defaultBranchRef': {
        const tip = repo.branchTip(repo.defaultBranch);
        return tip === undefined ? null : obj('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObject(repo, issue) : null;
      }
      case 'issues':
        return issuesConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObject(repo, pull) : null;
      }
      case 'pullRequests':
        return pullsConnection(repo, args);
      default:
        return null;
    }
  }

  if (type === 'Ref') {
    if (field === 'name') return source.name;
    return null;
  }

  if (type === 'Issue') {
    const repo = source.repo as Repo;
    const issue = source.issue as IssueState;
    switch (field) {
      case 'id':
        return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'closed':
        return issue.state === 'closed';
      case 'author':
        return userObject(VIEWER_LOGIN);
      case 'repository':
        return repoObject(repo);
      default:
        return null;
    }
  }

  if (type === 'PullRequest') {
    const repo = source.repo as Repo;
    const pull = source.pull as PullState;
    switch (field) {
      case 'id':
        return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'files': {
        const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
        const changes = diffCommits(repo, pull.baseShaAtCreation, headTip);
        const first = typeof args.first === 'number' ? args.first : changes.length;
        return obj('PullRequestChangedFilesConnection', {
          nodes: changes.slice(0, first).map((change) =>
            obj('PullRequestChangedFile', { path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() }),
          ),
          totalCount: changes.length,
        });
      }
      case 'author':
        return userObject(VIEWER_LOGIN);
      default:
        return null;
    }
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    if (field === 'nodes') return source.nodes;
    if (field === 'pageInfo') return source.pageInfo;
    if (field === 'totalCount') return source.totalCount;
    if (field === 'edges') {
      const nodes = source.nodes as GqlObject[];
      return nodes.map((node) => obj(type === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge', { node, cursor: '' }));
    }
    return null;
  }

  if (type === 'PullRequestChangedFilesConnection') {
    if (field === 'nodes') return source.nodes;
    if (field === 'totalCount') return source.totalCount;
    return null;
  }

  if (type === 'PageInfo') {
    if (field === 'hasNextPage') return source.hasNextPage;
    if (field === 'hasPreviousPage') return source.hasPreviousPage ?? false;
    if (field === 'endCursor') return source.endCursor;
    if (field === 'startCursor') return source.startCursor ?? source.endCursor;
    return null;
  }

  if (type === 'PullRequestChangedFile') {
    if (field === 'path') return source.path;
    if (field === 'additions') return source.additions;
    if (field === 'deletions') return source.deletions;
    if (field === 'changeType') return source.changeType;
    return null;
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field === 'issue') return source.issue;
    if (field === 'clientMutationId') return null;
    return null;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return source.pullRequest;
    if (field === 'clientMutationId') return null;
    return null;
  }
  if (type === 'AddCommentPayload') {
    if (field === 'commentEdge') return source.commentEdge;
    if (field === 'clientMutationId') return null;
    return null;
  }
  if (type === 'CommentEdge') {
    if (field === 'node') return source.node;
    if (field === 'cursor') return '';
    return null;
  }
  if (type === 'IssueComment') {
    if (field === 'id') return source.id;
    if (field === 'body') return source.body;
    if (field === 'author') return userObject(VIEWER_LOGIN);
    return null;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge') {
    if (field === 'node') return source.node;
    if (field === 'cursor') return source.cursor;
    return null;
  }

  if (type === '__Type') {
    if (field === 'name') return source.name;
    if (field === 'kind') return source.kind;
    if (field === 'description') return null;
    if (field === 'fields') {
      const names = (source.fieldNames as string[] | undefined) ?? [];
      return names.map((name) => obj('__Field', { name }));
    }
    if (field === 'enumValues') {
      const values = (source.enumValues as string[] | undefined) ?? [];
      return values.map((name) => obj('__EnumValue', { name }));
    }
    return null;
  }
  if (type === '__Field') {
    if (field === 'name') return source.name;
    if (field === 'description') return null;
    return null;
  }
  if (type === '__EnumValue') {
    if (field === 'name') return source.name;
    if (field === 'description') return null;
    return null;
  }
  if (type === '__Schema') {
    if (field === 'queryType') return typeObject('Query');
    if (field === 'mutationType') return typeObject('Mutation');
    return null;
  }

  return null;
}

function typeObject(name: string): GqlObject | null {
  if (Object.prototype.hasOwnProperty.call(TYPE_FIELDS, name)) {
    return obj('__Type', { name, kind: 'OBJECT', fieldNames: [...TYPE_FIELDS[name]] });
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_TYPES, name)) {
    return obj('__Type', { name, kind: 'ENUM', enumValues: [...ENUM_TYPES[name]] });
  }
  return null;
}

function resolveNode(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = forge.findRepoById(Number(parsed.key));
    return repo ? repoObject(repo) : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':');
    const repo = forge.findRepoById(Number(repoId));
    if (!repo) return null;
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(Number(number));
      return issue ? issueObject(repo, issue) : null;
    }
    const pull = repo.pulls.get(Number(number));
    return pull ? pullObject(repo, pull) : null;
  }
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states !== null && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy !== null ? 'DESC' : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const total = issues.length;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = issues.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1].number) : null;
  return obj('IssueConnection', {
    nodes: page.map((issue) => issueObject(repo, issue)),
    totalCount: total,
    pageInfo: obj('PageInfo', { hasNextPage, hasPreviousPage: after !== null, endCursor, startCursor: page.length > 0 ? issueCursor(page[0].number) : null }),
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states !== null && states.length > 0) {
    pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
  const page = pulls.slice(0, first);
  return obj('PullRequestConnection', {
    nodes: page.map((pull) => pullObject(repo, pull)),
    totalCount: pulls.length,
    pageInfo: obj('PageInfo', { hasNextPage: pulls.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null }),
  });
}

function repoByGlobalId(id: unknown): Repo | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return forge.findRepoById(Number(parsed.key));
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = repoByGlobalId(input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreateIssuePayload', { issue: null });
      }
      const result = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return obj('CreateIssuePayload', { issue: null });
      }
      return obj('CreateIssuePayload', { issue: issueObject(repo, result.issue) });
    }
    case 'closeIssue': {
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed ? forge.findRepoById(Number(parsed.key.split(':')[0])) : null;
      const issue = repo && parsed ? repo.issues.get(Number(parsed.key.split(':')[1])) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'issue not found' });
        return obj('CloseIssuePayload', { issue: null });
      }
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObject(repo, issue) });
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreatePullRequestPayload', { pullRequest: null });
      }
      const result = createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return obj('CreatePullRequestPayload', { pullRequest: null });
      }
      return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, result.pull) });
    }
    case 'mergePullRequest': {
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed ? forge.findRepoById(Number(parsed.key.split(':')[0])) : null;
      const pull = repo && parsed ? repo.pulls.get(Number(parsed.key.split(':')[1])) : undefined;
      if (!repo || !pull) {
        ctx.errors.push({ message: 'pull request not found' });
        return obj('MergePullRequestPayload', { pullRequest: null });
      }
      const outcome = mergePull(repo, pull);
      if (!outcome.ok) ctx.errors.push({ message: `merge failed: ${outcome.reason}` });
      return obj('MergePullRequestPayload', { pullRequest: pullObject(repo, pull) });
    }
    case 'addComment': {
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed ? forge.findRepoById(Number(parsed.key.split(':')[0])) : null;
      const number = parsed ? Number(parsed.key.split(':')[1]) : NaN;
      const issue = repo ? repo.issues.get(number) : undefined;
      const pull = repo && !issue ? repo.pulls.get(number) : undefined;
      if (!repo || (!issue && !pull)) {
        ctx.errors.push({ message: 'subject not found' });
        return obj('AddCommentPayload', { commentEdge: null });
      }
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdTs: nextTimestampSec() };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      const node = obj('IssueComment', { id: globalId('IssueComment', `${repo.id}:${comment.id}`), body: comment.body });
      return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node, cursor: '' }) });
    }
    default:
      return null;
  }
}

/** Execute one selection set against one object, collecting validation errors. */
function executeSelectionSet(source: GqlObject, selections: Selection[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = source.__type;
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(source, fragment, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const knownFields = TYPE_FIELDS[typeName];
    if (knownFields && !knownFields.includes(selection.name) && selection.name !== '__typename') {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = argsOf(selection, ctx.variables);
    const value = selection.name === '__typename' ? typeName : resolveField(source, selection.name, args, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value === 'object') {
    const gqlObject = value as GqlObject;
    if (typeof gqlObject.__type === 'string' && selection.selectionSet) {
      return executeSelectionSet(gqlObject, selection.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

/** Execute one operation document; returns the GraphQL response body. */
export function executeGraphQL(queryText: string, variables: Variables, operationName: string | null): Record<string, unknown> {
  let document: Document;
  try {
    document = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operation =
    operationName !== null
      ? (document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0])
      : document.operations[0];
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(root, operation.selectionSet, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Handle one POST /api/graphql (single operation or a batched array). */
export function handleGraphQL(ctx: Ctx): Reply {
  const payload = ctx.json;
  if (Array.isArray(payload)) {
    const responses = payload.map((entry) => {
      const item = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
      return executeGraphQL(
        String(item.query ?? ''),
        (item.variables ?? {}) as Variables,
        typeof item.operationName === 'string' ? item.operationName : null,
      );
    });
    return jsonReply(200, responses);
  }
  const item = (payload ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  const response = executeGraphQL(
    String(item.query ?? ''),
    (item.variables ?? {}) as Variables,
    typeof item.operationName === 'string' ? item.operationName : null,
  );
  return jsonReply(200, response);
}
