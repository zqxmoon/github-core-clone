// forge.ts — the forge's state and domain logic, shared by the REST, GraphQL, MCP and git
// surfaces. Everything lives in memory; the process is the database. All ids, timestamps and
// request ids come from counters seeded at a fixed epoch (or MAKEFUN_TRIAL_NOW when the trial
// provides one), never from the wall clock, so a replayed trial walks the same state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The one login the trial's bearer <redacted> owns (the suite's seeded viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------------------
// deterministic clock: a fixed epoch plus a per-process counter of seconds.
// ---------------------------------------------------------------------------

function trialNowEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1767225600; // 2026-01-01T00:00:00Z
}

export const EPOCH_SEC = trialNowEpochSec();
let clockCounter = 0;

/** The next deterministic timestamp, in epoch seconds: strictly increasing per call. */
export function nextTimestampSec(): number {
  clockCounter += 1;
  return EPOCH_SEC + clockCounter;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${(requestCounter * 2654435761 % 4294967296).toString(16)}`;
}

// ---------------------------------------------------------------------------
// git object model: commits, trees, tags.
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree order: entries sort by name, directories as if the name ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTs: 0,
    committerName: '',
    committerEmail: '',
    committerTs: 0,
    message,
  };
  const ident = (value: string): { name: string; email: string; ts: number } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(value);
    if (!match) return { name: value, email: '', ts: 0 };
    return { name: match[1], email: match[2], ts: Number(match[3]) };
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const who = ident(line.slice(7));
      info.authorName = who.name; info.authorEmail = who.email; info.authorTs = who.ts;
    } else if (line.startsWith('committer ')) {
      const who = ident(line.slice(10));
      info.committerName = who.name; info.committerEmail = who.email; info.committerTs = who.ts;
    }
  }
  return info;
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  message: string;
  name: string;
  email: string;
  ts: number;
}): Buffer {
  const ident = `${info.name} <${info.email}> ${info.ts} +0000`;
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// packfiles: plain-object writing, and a reader that resolves ofs/ref deltas.
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain objects (no deltas), with a valid SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Read a pack into resolved objects. `externalBase` resolves a thin pack's missing base from
 * the receiving repository's own store. Throws on any structural problem.
 */
export function readPack(pack: Buffer, externalBase: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        const inPack = resolvedByOid.get(entry.baseOid ?? '');
        if (inPack) base = inPack;
        else {
          const external = externalBase(entry.baseOid ?? '');
          if (!external) throw new Error('ref-delta base missing');
          base = external;
        }
      }
      const object: GitObject = { type: base.type, data: applyDelta(base.data, entry.data) };
      resolvedByOid.set(hashObject(object.type, object.data), object);
      return object;
    }
    const object: GitObject = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    resolvedByOid.set(hashObject(object.type, object.data), object);
    return object;
  };
  return raw.map(resolve);
}

// ---------------------------------------------------------------------------
// repository state.
// ---------------------------------------------------------------------------

export interface LabelState {
  name: string;
  color: string;
  description: string;
}

export interface IssueState {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdTs: number;
  updatedTs: number;
}

export interface PullState {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseShaAtCreation: string;
  merged: boolean;
  mergedTs: number | null;
  mergeCommitSha: string | null;
  createdTs: number;
  updatedTs: number;
}

export interface CommentState {
  id: number;
  body: string;
  createdTs: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelState>();
  readonly issues = new Map<number, IssueState>();
  readonly pulls = new Map<number, PullState>();
  readonly comments = new Map<number, CommentState[]>();
  nextNumber = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  readonly createdTs: number;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdTs = nextTimestampSec();
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit authored by the viewer with the next deterministic timestamp. */
  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    const ts = nextTimestampSec();
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      name: VIEWER_LOGIN,
      email: `${VIEWER_LOGIN}@example.invalid`,
      ts,
    });
    return this.putObject('commit', data);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  setBranch(branch: string, oid: string): void {
    this.refs.set(`refs/heads/${branch}`, oid);
  }

  commitOf(oid: string): CommitInfo | null {
    const peeled = this.peelToCommit(oid);
    if (peeled === null) return null;
    const object = this.objects.get(peeled);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Follow tag objects to the commit they name; null when the chain ends elsewhere. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Peel a ref target for advertisement: the commit a tag names, else the target itself. */
  peel(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tag') return null;
    return this.peelToCommit(oid);
  }

  /** Every commit reachable from `tips` (tags peeled), as a set of commit oids. */
  reachableCommits(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(tip);
      if (commit !== null) queue.push(commit);
    }
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitOf(oid);
      if (info) for (const parent of info.parents) queue.push(parent);
    }
    return seen;
  }

  /** Every object (any type) reachable from `tips`. */
  reachableObjects(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const info = parseCommit(object.data);
        queue.push(info.tree, ...info.parents);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors (early-exit walk). */
  isAncestor(ancestor: string, descendant: string): boolean {
    const target = this.peelToCommit(ancestor);
    const from = this.peelToCommit(descendant);
    if (target === null || from === null) return false;
    if (target === from) return true;
    const seen = new Set<string>();
    const queue: string[] = [from];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitOf(oid);
      if (!info) continue;
      for (const parent of info.parents) {
        if (parent === target) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits: a common ancestor with the greatest generation. */
  mergeBase(a: string, b: string): string | null {
    const ca = this.peelToCommit(a);
    const cb = this.peelToCommit(b);
    if (ca === null || cb === null) return null;
    const ancestorsOf = (tip: string): Map<string, number> => {
      const depth = new Map<string, number>();
      const queue: Array<[string, number]> = [[tip, 0]];
      while (queue.length > 0) {
        const [oid, d] = queue.shift() as [string, number];
        if (depth.has(oid) && (depth.get(oid) as number) <= d) continue;
        depth.set(oid, d);
        const info = this.commitOf(oid);
        if (info) for (const parent of info.parents) queue.push([parent, d + 1]);
      }
      return depth;
    };
    const da = ancestorsOf(ca);
    const db = ancestorsOf(cb);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, d] of da) {
      const other = db.get(oid);
      if (other === undefined) continue;
      const score = d + other;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** Flatten a commit's tree into path -> {oid, mode}. */
  flattenTree(commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const info = this.commitOf(commitOid);
    if (!info) return out;
    const walk = (treeOid: string, prefix: string): void => {
      const object = this.objects.get(treeOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(info.tree, '');
    return out;
  }

  /** Rebuild a tree hierarchy from a flattened path map; returns the root tree oid. */
  buildTreeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Dir {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        let next = dir.dirs.get(segment);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(segment, next);
        }
        dir = next;
      }
      dir.files.set(segments[segments.length - 1], value);
    }
    const emit = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of dir.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
      return this.putObject('tree', buildTree(entries));
    };
    return emit(root);
  }
}

// ---------------------------------------------------------------------------
// the forge: every repository, keyed by full name.
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalIssueId = 1;

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId++, owner, name, isPrivate, description);
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  findRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  allocateIssueId(): number {
    return this.nextGlobalIssueId++;
  }
}

/** The one forge this process serves. */
export const forge = new Forge();

// ---------------------------------------------------------------------------
// shared domain operations (REST, GraphQL and MCP all funnel through these).
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

/** The file-level diff between two commits' trees. */
export function diffCommits(repo: Repo, fromCommit: string, toCommit: string): FileChange[] {
  const before = repo.flattenTree(fromCommit);
  const after = repo.flattenTree(toCommit);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    if (!oldEntry && newEntry) {
      const blob = repo.getObject(newEntry.oid);
      changes.push({ path, status: 'added', additions: blob ? lineCount(blob.data) : 0, deletions: 0 });
    } else if (oldEntry && !newEntry) {
      const blob = repo.getObject(oldEntry.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob ? lineCount(blob.data) : 0 });
    } else if (oldEntry && newEntry) {
      const oldBlob = repo.getObject(oldEntry.oid);
      const newBlob = repo.getObject(newEntry.oid);
      changes.push({
        path,
        status: 'modified',
        additions: newBlob ? lineCount(newBlob.data) : 0,
        deletions: oldBlob ? lineCount(oldBlob.data) : 0,
      });
    }
  }
  return changes;
}

/** Whether merging `pull` into its base branch's current tip would conflict (file-level 3-way). */
export function pullConflicts(repo: Repo, pull: PullState): boolean {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  if (baseTip === undefined) return true;
  const mergeBase = repo.mergeBase(baseTip, headTip);
  if (mergeBase === null) return true;
  const baseTree = repo.flattenTree(mergeBase);
  const currentTree = repo.flattenTree(baseTip);
  const headTree = repo.flattenTree(headTip);
  const headChanges = diffCommits(repo, mergeBase, headTip);
  for (const change of headChanges) {
    const atBase = baseTree.get(change.path);
    const atCurrent = currentTree.get(change.path);
    const atHead = headTree.get(change.path);
    const currentDiffersFromBase = (atCurrent?.oid ?? null) !== (atBase?.oid ?? null);
    const headDiffersFromCurrent = (atHead?.oid ?? null) !== (atCurrent?.oid ?? null);
    if (currentDiffersFromBase && headDiffersFromCurrent) return true;
  }
  return false;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'conflict' | 'already-closed' };

/** Squash-merge a pull request onto its base branch's current tip. */
export function mergePull(repo: Repo, pull: PullState): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: 'already-closed' };
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  if (baseTip === undefined) return { ok: false, reason: 'not-found' };
  if (pullConflicts(repo, pull)) return { ok: false, reason: 'conflict' };
  const mergeBase = repo.mergeBase(baseTip, headTip) as string;
  const merged = repo.flattenTree(baseTip);
  const headTree = repo.flattenTree(headTip);
  for (const change of diffCommits(repo, mergeBase, headTip)) {
    const atHead = headTree.get(change.path);
    if (atHead) merged.set(change.path, atHead);
    else merged.delete(change.path);
  }
  const treeOid = repo.buildTreeFromFlat(merged);
  const message = `${pull.title}\n\n${pull.body}`.trimEnd() + '\n';
  const sha = repo.makeCommit(treeOid, [baseTip], message);
  repo.setBranch(pull.baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedTs = nextTimestampSec();
  pull.mergeCommitSha = sha;
  pull.updatedTs = pull.mergedTs;
  pull.baseShaAtCreation = pull.baseShaAtCreation; // unchanged
  return { ok: true, sha };
}

/** Create an issue; returns null with `error` set when a label is unknown. */
export function createIssue(
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): { issue: IssueState } | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `unknown label: ${name}` };
  }
  const ts = nextTimestampSec();
  const issue: IssueState = {
    kind: 'issue',
    id: forge.allocateIssueId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    createdTs: ts,
    updatedTs: ts,
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

/** Create a pull request between two existing branches. */
export function createPull(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pull: PullState } | { error: string } {
  const headTip = repo.branchTip(headRef);
  const baseTip = repo.branchTip(baseRef);
  if (headTip === undefined) return { error: `head branch not found: ${headRef}` };
  if (baseTip === undefined) return { error: `base branch not found: ${baseRef}` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: 'a pull request already exists for this head and base' };
    }
  }
  const ts = nextTimestampSec();
  const pull: PullState = {
    kind: 'pull',
    id: forge.allocateIssueId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha: headTip,
    baseShaAtCreation: baseTip,
    merged: false,
    mergedTs: null,
    mergeCommitSha: null,
    createdTs: ts,
    updatedTs: ts,
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}
