// rest.ts — the REST v3 surface under /api/v3: repositories, contents, refs, branches,
// commits, labels, issues, comments and pull requests. Handlers return a Reply or null when
// the path is not theirs; app.ts turns null into the JSON 404 the protocol checks expect.

import {
  CommentState,
  IssueState,
  PullState,
  Repo,
  VIEWER_ID,
  VIEWER_LOGIN,
  createIssue,
  createPull,
  diffCommits,
  forge,
  isoOf,
  mergePull,
  nextTimestampSec,
  parseCommit,
  parseTree,
} from './forge.ts';
import { Ctx, Reply, errorReply, globalId, jsonReply } from './http.ts';

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    owner: userJson(repo.owner),
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdTs),
    updated_at: isoOf(repo.createdTs),
    pushed_at: isoOf(repo.createdTs),
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? '000000', description: label?.description ?? '', default: false };
}

export function issueJson(repo: Repo, issue: IssueState): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(VIEWER_LOGIN),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: isoOf(issue.createdTs),
    updated_at: isoOf(issue.updatedTs),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedTs) : null,
  };
}

export function pullJson(repo: Repo, pull: PullState): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreation;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedTs !== null ? isoOf(pull.mergedTs) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(VIEWER_LOGIN),
    created_at: isoOf(pull.createdTs),
    updated_at: isoOf(pull.updatedTs),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedTs) : null,
  };
}

export function commentJson(repo: Repo, comment: CommentState): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${comment.id}`),
    body: comment.body,
    user: userJson(VIEWER_LOGIN),
    created_at: isoOf(comment.createdTs),
    updated_at: isoOf(comment.createdTs),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bodyObject(ctx: Ctx): Record<string, unknown> {
  if (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

function stringField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === 'string' ? value : null;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(ctx: Ctx): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

/** A Link header with rel="next" when another page exists (the pagination checks follow it). */
function linkHeader(ctx: Ctx, path: string, page: Page, total: number): Record<string, string> {
  if (page.page * page.perPage >= total) return {};
  const url = `http://${ctx.host}${path}?per_page=${page.perPage}&page=${page.page + 1}`;
  return { link: `<${url}>; rel="next"` };
}

function repoFromParams(owner: string, name: string): Repo | null {
  return forge.getRepo(owner, name);
}

function notFound(): Reply {
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

function createRepo(ctx: Ctx): Reply {
  const body = bodyObject(ctx);
  const name = stringField(body, 'name');
  if (name === null || name === '') return errorReply(422, 'Repository creation failed: name is required');
  const isPrivate = body.private === true;
  const description = stringField(body, 'description') ?? '';
  const repo = forge.createRepo(VIEWER_LOGIN, name, isPrivate, description);
  if (repo === null) {
    return {
      status: 422,
      body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] },
    };
  }
  return jsonReply(201, repoJson(repo));
}

function listUserRepos(ctx: Ctx): Reply {
  const page = pageOf(ctx);
  const repos = forge.reposOf(VIEWER_LOGIN);
  const slice = paginate(repos, page);
  return jsonReply(200, slice.map(repoJson), linkHeader(ctx, '/api/v3/user/repos', page, repos.length));
}

function getRepo(repo: Repo): Reply {
  return jsonReply(200, repoJson(repo));
}

function patchRepo(ctx: Ctx, repo: Repo): Reply {
  const body = bodyObject(ctx);
  const description = stringField(body, 'description');
  if (description !== null) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const name = stringField(body, 'name');
  if (name !== null && name !== '' && name !== repo.name) {
    // Renaming moves the map key; the suite only patches descriptions, but stay correct.
    forge.repos.delete(repo.fullName);
    (repo as { name: string }).name = name;
    forge.repos.set(repo.fullName, repo);
  }
  return jsonReply(200, repoJson(repo));
}

// ---------------------------------------------------------------------------
// contents, trees, refs, branches, commits
// ---------------------------------------------------------------------------

interface TreeHit {
  kind: 'file' | 'dir';
  oid: string;
  mode: string;
}

/** Resolve a path inside a commit's tree; null when any segment is missing. */
function treeHit(repo: Repo, commitOid: string, path: string): TreeHit | null {
  const info = repo.commitOf(commitOid);
  if (!info) return null;
  if (path === '') return { kind: 'dir', oid: info.tree, mode: '40000' };
  const segments = path.split('/');
  let treeOid = info.tree;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = repo.getObject(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.getObject(treeOid);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.getObject(entry.oid)?.data.length ?? 0),
  }));
}

/** The branch a contents call addresses: explicit branch/ref, else the default branch. */
function contentsBranch(ctx: Ctx, body: Record<string, unknown>): string {
  const fromBody = stringField(body, 'branch');
  if (fromBody !== null && fromBody !== '') return fromBody;
  const fromQuery = ctx.query.get('ref');
  if (fromQuery !== null && fromQuery !== '') return fromQuery;
  return 'main';
}

function getContents(ctx: Ctx, repo: Repo, path: string): Reply {
  const body = bodyObject(ctx);
  const branch = contentsBranch(ctx, body);
  const tip = repo.branchTip(branch);
  if (tip === undefined) return notFound();
  const hit = treeHit(repo, tip, path);
  if (hit === null) return notFound();
  if (hit.kind === 'dir') return jsonReply(200, dirListing(repo, hit.oid, path));
  const blob = repo.getObject(hit.oid);
  if (!blob) return notFound();
  const name = path.split('/').pop() ?? path;
  return jsonReply(200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    sha: hit.oid,
    content: blob.data.toString('base64'),
  });
}

function putContents(ctx: Ctx, repo: Repo, path: string): Reply {
  const body = bodyObject(ctx);
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  if (message === null || content === null) return errorReply(422, 'message and content are required');
  const branch = contentsBranch(ctx, body);
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  let tip = repo.branchTip(branch);
  if (tip === undefined) {
    // An unborn default branch starts here; another missing branch forks from the default tip.
    if (branch !== repo.defaultBranch) tip = repo.branchTip(repo.defaultBranch);
    if (tip === undefined && branch !== repo.defaultBranch) return errorReply(404, `branch not found: ${branch}`);
  }
  const flat = tip !== undefined ? repo.flattenTree(tip) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  const sha = stringField(body, 'sha');
  if (existing !== undefined && sha !== existing.oid) {
    return errorReply(409, `${path} does not match ${sha ?? '(no sha given)'}`);
  }
  const blobOid = repo.putObject('blob', data);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = repo.buildTreeFromFlat(flat);
  const commitOid = repo.makeCommit(treeOid, tip !== undefined ? [tip] : [], message);
  repo.setBranch(branch, commitOid);
  const name = path.split('/').pop() ?? path;
  return jsonReply(existing !== undefined ? 200 : 201, {
    content: { type: 'file', encoding: 'base64', size: data.length, name, path, sha: blobOid },
    commit: { sha: commitOid },
  });
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): Reply {
  const body = bodyObject(ctx);
  const message = stringField(body, 'message');
  const sha = stringField(body, 'sha');
  if (message === null || sha === null) return errorReply(422, 'message and sha are required');
  const branch = contentsBranch(ctx, body);
  const tip = repo.branchTip(branch);
  if (tip === undefined) return notFound();
  const flat = repo.flattenTree(tip);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  if (existing.oid !== sha) return errorReply(409, `${path} does not match ${sha}`);
  flat.delete(path);
  const treeOid = repo.buildTreeFromFlat(flat);
  const commitOid = repo.makeCommit(treeOid, [tip], message);
  repo.setBranch(branch, commitOid);
  return jsonReply(200, { content: null, commit: { sha: commitOid } });
}

function listBranches(repo: Repo): Reply {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return jsonReply(200, branches);
}

function getBranch(repo: Repo, branch: string): Reply {
  const tip = repo.branchTip(branch);
  if (tip === undefined) return notFound();
  return jsonReply(200, { name: branch, commit: { sha: tip }, protected: false });
}

function createRef(ctx: Ctx, repo: Repo): Reply {
  const body = bodyObject(ctx);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === null || sha === null || !ref.startsWith('refs/')) return errorReply(422, 'ref and sha are required');
  const object = repo.getObject(sha);
  if (object === undefined) return errorReply(422, `unknown object: ${sha}`);
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha, type: object.type } });
}

function getRef(repo: Repo, ref: string): Reply {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = repo.getObject(oid);
  return jsonReply(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

function listCommits(ctx: Ctx, repo: Repo): Reply {
  const refParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (refParam !== null && refParam !== '') {
    tip = repo.refs.get(refParam) ?? repo.branchTip(refParam) ?? (repo.getObject(refParam) ? refParam : undefined);
  } else {
    tip = repo.branchTip(repo.defaultBranch);
  }
  if (tip === undefined) return notFound();
  const start = repo.peelToCommit(tip);
  if (start === null) return notFound();
  // Newest first: breadth by generation, then by commit timestamp descending.
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = [[start, 0]];
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    if (depth.has(oid)) continue;
    depth.set(oid, d);
    const info = repo.commitOf(oid);
    if (info) for (const parent of info.parents) queue.push([parent, d + 1]);
  }
  const ordered = [...depth.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    const ta = repo.commitOf(a[0])?.committerTs ?? 0;
    const tb = repo.commitOf(b[0])?.committerTs ?? 0;
    return tb - ta;
  });
  const page = pageOf(ctx);
  const slice = paginate(ordered, page);
  const commits = slice.map(([oid]) => {
    const info = repo.commitOf(oid) as NonNullable<ReturnType<Repo['commitOf']>>;
    void parseCommit;
    return {
      sha: oid,
      commit: {
        message: info.message,
        author: { name: info.authorName, email: info.authorEmail, date: isoOf(info.authorTs) },
        committer: { name: info.committerName, email: info.committerEmail, date: isoOf(info.committerTs) },
      },
      parents: info.parents.map((parent) => ({ sha: parent })),
    };
  });
  return jsonReply(200, commits);
}

// ---------------------------------------------------------------------------
// labels, issues, comments, pulls
// ---------------------------------------------------------------------------

function createLabel(ctx: Ctx, repo: Repo): Reply {
  const body = bodyObject(ctx);
  const name = stringField(body, 'name');
  if (name === null || name === '') return errorReply(422, 'name is required');
  if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: label already exists');
  const color = (stringField(body, 'color') ?? '000000').replace(/^#/, '');
  repo.labels.set(name, { name, color, description: stringField(body, 'description') ?? '' });
  return jsonReply(201, labelJson(repo, name));
}

function listLabels(repo: Repo): Reply {
  return jsonReply(200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const labels = body.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function createIssueHandler(ctx: Ctx, repo: Repo): Reply {
  const body = bodyObject(ctx);
  const title = stringField(body, 'title');
  if (title === null || title === '') return errorReply(422, 'title is required');
  const result = createIssue(repo, title, stringField(body, 'body') ?? '', labelNamesOf(body));
  if ('error' in result) return errorReply(422, result.error);
  return jsonReply(201, issueJson(repo, result.issue));
}

function listIssues(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = pageOf(ctx);
  return jsonReply(200, paginate(issues, page).map((issue) => issueJson(repo, issue)));
}

function getIssue(repo: Repo, number: number): Reply {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  return jsonReply(200, issueJson(repo, issue));
}

function patchIssue(ctx: Ctx, repo: Repo, number: number): Reply {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  const body = bodyObject(ctx);
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== null) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== null) issue.body = text;
  if (Array.isArray(body.labels)) {
    const names = labelNamesOf(body);
    for (const name of names) if (!repo.labels.has(name)) return errorReply(422, `unknown label: ${name}`);
    issue.labels = names;
  }
  issue.updatedTs = nextTimestampSec();
  return jsonReply(200, issueJson(repo, issue));
}

function createComment(ctx: Ctx, repo: Repo, number: number): Reply {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  const body = bodyObject(ctx);
  const text = stringField(body, 'body');
  if (text === null) return errorReply(422, 'body is required');
  const comment: CommentState = { id: repo.nextCommentId++, body: text, createdTs: nextTimestampSec() };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return jsonReply(201, commentJson(repo, comment));
}

function listComments(repo: Repo, number: number): Reply {
  if (!repo.issues.has(number)) return notFound();
  const list = repo.comments.get(number) ?? [];
  return jsonReply(200, list.map((comment) => commentJson(repo, comment)));
}

function createPullHandler(ctx: Ctx, repo: Repo): Reply {
  const body = bodyObject(ctx);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === null || head === null || base === null) return errorReply(422, 'title, head and base are required');
  const headRef = head.includes(':') ? head.split(':').pop() as string : head;
  const baseRef = base.includes(':') ? base.split(':').pop() as string : base;
  const result = createPull(repo, title, stringField(body, 'body') ?? '', headRef, baseRef);
  if ('error' in result) return errorReply(422, result.error);
  return jsonReply(201, pullJson(repo, result.pull));
}

function listPulls(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const page = pageOf(ctx);
  return jsonReply(200, paginate(pulls, page).map((pull) => pullJson(repo, pull)));
}

function getPull(repo: Repo, number: number): Reply {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  return jsonReply(200, pullJson(repo, pull));
}

function getPullFiles(repo: Repo, number: number): Reply {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const changes = diffCommits(repo, pull.baseShaAtCreation, headTip);
  return jsonReply(
    200,
    changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })),
  );
}

function mergePullHandler(ctx: Ctx, repo: Repo, number: number): Reply {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  void ctx;
  const outcome = mergePull(repo, pull);
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') return errorReply(405, 'Pull Request is not mergeable');
    if (outcome.reason === 'already-closed') return errorReply(405, 'Pull Request is not mergeable: already closed');
    return notFound();
  }
  return jsonReply(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** Handle one /api/v3 request; null when the path is outside this surface. */
export function handleRest(ctx: Ctx): Reply | null {
  const segments = ctx.segments;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      return jsonReply(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return notFound();
  }
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    return jsonReply(200, { installed_version: '1.0.0', github_developer_version: 'v3' });
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return jsonReply(200, userJson(VIEWER_LOGIN));
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') return listUserRepos(ctx);
    return notFound();
  }
  if (rest[0] !== 'repos' || rest.length < 3) return notFound();

  const owner = rest[1];
  const name = rest[2];
  const tail = rest.slice(3);
  const repo = repoFromParams(owner, name);

  if (tail.length === 0) {
    if (repo === null) return notFound();
    if (method === 'GET') return getRepo(repo);
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }
  if (repo === null) return notFound();

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return notFound();
  }
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') return listBranches(repo);
    if (tail.length >= 2 && method === 'GET') return getBranch(repo, tail.slice(1).join('/'));
    return notFound();
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) return createRef(ctx, repo);
    if (method === 'GET' && tail.length >= 3) return getRef(repo, `refs/${tail.slice(2).join('/')}`);
    return notFound();
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return listCommits(ctx, repo);
  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'POST') return createLabel(ctx, repo);
    if (tail.length === 1 && method === 'GET') return listLabels(repo);
    return notFound();
  }
  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'POST') return createIssueHandler(ctx, repo);
    if (tail.length === 1 && method === 'GET') return listIssues(ctx, repo);
    const number = Number(tail[1]);
    if (tail.length === 2 && method === 'GET') return getIssue(repo, number);
    if (tail.length === 2 && method === 'PATCH') return patchIssue(ctx, repo, number);
    if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') return createComment(ctx, repo, number);
    if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') return listComments(repo, number);
    return notFound();
  }
  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'POST') return createPullHandler(ctx, repo);
    if (tail.length === 1 && method === 'GET') return listPulls(ctx, repo);
    const number = Number(tail[1]);
    if (tail.length === 2 && method === 'GET') return getPull(repo, number);
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return getPullFiles(repo, number);
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return mergePullHandler(ctx, repo, number);
    return notFound();
  }
  return notFound();
}
