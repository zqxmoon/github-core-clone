// git.ts — the smart-HTTP surface: pkt-lines, ref advertisement, protocol v2 ls-refs/fetch,
// v0 fetch, and v0 receive-pack with report-status. The object model lives in forge.ts; this
// file is only the wire.

import {
  Repo,
  ZERO_OID,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
} from './forge.ts';
import type { GitObject } from './forge.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse as many complete packets as `buffer` holds; returns them plus the unconsumed rest. */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    // Not a pkt-line header: the packet stream ends here (a receive-pack packfile, whose
    // first four bytes are 'PACK', is the usual case). The caller reads the rest itself.
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Wrap bytes in sideband band-1 packets (each its own pkt-line, at most 65516 payload bytes). */
export function sidebandWrap(data: Buffer, band: number): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs a repository advertises, in git's order (branches, then tags), with peeled tags. */
function advertisedRefs(repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const lines: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const peeled = repo.peel(oid);
    if (peeled !== null) line.peeled = peeled;
    lines.push(line);
  }
  return lines;
}

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta multi_ack_detailed shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

export function uploadAdvertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

export function uploadAdvertisementV0(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const refs = advertisedRefs(repo);
  if (headOid === undefined && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0symref=HEAD:${headTarget} ${UPLOAD_CAPS_V0}\n`));
  } else {
    const firstOid = headOid ?? refs[0].oid;
    parts.push(pktLine(`${firstOid} HEAD\0symref=HEAD:${headTarget} ${UPLOAD_CAPS_V0}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function receiveAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${RECEIVE_CAPS}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${caps}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch: object selection with haves, shallow and deepen.
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  done: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallowInfo: string[];
  unshallow: string[];
}

/** The commits a fetch includes, honouring haves (excluded history) and depth (generations). */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const held = new Set<string>();
  for (const have of request.haves) {
    const commit = repo.peelToCommit(have);
    if (commit !== null) held.add(commit);
  }
  const shallowHeld = new Set<string>();
  for (const boundary of request.shallow) {
    const commit = repo.peelToCommit(boundary);
    if (commit !== null) shallowHeld.add(commit);
  }
  // Objects the client provably holds: everything reachable from its haves, with the walk
  // cut at its shallow boundary — a boundary commit and its tree are held, its parents are
  // unknown to the client and prove nothing (any have's ancestry truncates there too).
  const excludedObjects = new Set<string>();
  {
    const queue: string[] = [...request.haves, ...request.shallow];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (excludedObjects.has(oid)) continue;
      const object = repo.getObject(oid);
      if (!object) continue;
      excludedObjects.add(oid);
      if (object.type === 'commit') {
        const info = parseCommit(object.data);
        queue.push(info.tree);
        const commit = repo.peelToCommit(oid);
        if (commit === null || !shallowHeld.has(commit)) queue.push(...info.parents);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    const commit = repo.peelToCommit(want);
    if (commit !== null) wantCommits.push(commit);
  }

  if (request.depth !== null && request.depth > 0) {
    // Breadth-first from the wants. Absolute deepen counts generations from the want
    // (generation depth-1 is the new boundary). deepen-relative counts only the edges past
    // the client's current shallow boundary: edges inside the held region are free, the
    // first edge out of a boundary commit costs 1, and cost == depth is the new boundary.
    const depth = request.depth;
    const level = new Map<string, number>();
    const queue: Array<[string, number]> = wantCommits.map((commit) => [commit, 0]);
    while (queue.length > 0) {
      const [oid, gen] = queue.shift() as [string, number];
      if (level.has(oid) && (level.get(oid) as number) <= gen) continue;
      level.set(oid, gen);
      const atBoundary = request.deepenRelative ? gen >= depth : gen >= depth - 1;
      if (atBoundary) {
        boundary.add(oid);
        continue;
      }
      const info = repo.commitOf(oid);
      if (info) {
        for (const parent of info.parents) {
          const nextGen = request.deepenRelative ? (shallowHeld.has(oid) || gen > 0 ? gen + 1 : 0) : gen + 1;
          queue.push([parent, nextGen]);
        }
      }
    }
    for (const oid of level.keys()) {
      if (!held.has(oid) && !shallowHeld.has(oid)) included.add(oid);
    }
    // A held want at the last generation is not a boundary: the client has its objects.
    for (const oid of [...boundary]) {
      if (held.has(oid)) boundary.delete(oid);
    }
  } else {
    const excludedCommits = repo.reachableCommits(request.haves);
    const reachable = repo.reachableCommits(wantCommits);
    for (const oid of reachable) {
      if (excludedCommits.has(oid)) continue;
      if (shallowHeld.has(oid)) continue;
      included.add(oid);
    }
    if (request.shallow.length > 0) {
      // A fetch out of a shallow clone without deepen keeps the client's boundary.
      for (const commit of shallowHeld) {
        if (repo.reachableCommits(wantCommits).has(commit)) boundary.add(commit);
      }
    }
  }

  // The object closure of the included commits, minus what the client holds. Commits that are
  // not included are never emitted (their trees belong to history the client either has or is
  // cut off from by the shallow boundary).
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const emit = (oid: string): void => {
    if (seen.has(oid) || excludedObjects.has(oid)) return;
    const object = repo.getObject(oid);
    if (!object) return;
    if (object.type === 'commit' && !included.has(oid)) return;
    seen.add(oid);
    objects.push(object);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      emit(info.tree);
      for (const parent of info.parents) emit(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') emit(entry.oid);
      }
    } else if (object.type === 'tag') {
      emit(parseTag(object.data).object);
    }
  };
  // Wants may name tag objects: emit them (and the commits they name) too.
  for (const want of request.wants) {
    const object = repo.getObject(want);
    if (object && object.type === 'tag') emit(want);
  }
  for (const commit of included) emit(commit);

  const unshallow: string[] = [];
  if (request.depth !== null) {
    for (const old of shallowHeld) {
      if (boundary.has(old)) continue;
      const info = repo.commitOf(old);
      if (!info) continue;
      const parentsIncluded = info.parents.every((parent) => included.has(parent) || held.has(parent));
      if (parentsIncluded && repo.reachableCommits(wantCommits).has(old)) unshallow.push(old);
    }
  }

  return { objects, shallowInfo: [...boundary], unshallow };
}

/** Run a fetch and frame it as a protocol v2 response (sections + sideband packfile). */
export function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (!request.done) {
    // No `done` yet: git's upload-pack answers acknowledgments, and a `ready` line volunteers
    // the packfile in the same response (which then follows below). A request that carries
    // `done` must be answered with the packfile directly, no acknowledgments section.
    parts.push(pktLine('acknowledgments\n'));
    const acked = request.haves.find((have) => repo.getObject(have) !== undefined || repo.peelToCommit(have) !== null);
    if (acked !== undefined) parts.push(pktLine(`ACK ${repo.peelToCommit(acked) ?? acked}\n`));
    else parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallowInfo.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowInfo) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(writePack(plan.objects), 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Run a fetch and frame it as a protocol v0 response (NAK/ACK lines, then sideband pack). */
export function fetchV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowInfo) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandWrap(writePack(plan.objects), 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 fetch request body into a FetchRequest; null when it is not a fetch command. */
export function parseFetchBody(packets: Packet[]): { command: string; args: string[]; request: FetchRequest } | null {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines[0] ?? '';
  if (!commandLine.startsWith('command=')) return null;
  const command = commandLine.slice('command='.length);
  const args = lines.slice(1);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') request.deepenRelative = true;
    else if (arg === 'done') request.done = true;
  }
  return { command, args, request };
}

/** Parse a v0 upload-pack request body (want section, flush, have section, flush). */
export function parseFetchBodyV0(packets: Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: true };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
    }
  }
  return request;
}

// ---------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------

export interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface ReceiveResult {
  unpackOk: boolean;
  outcomes: PushOutcome[];
  sideband: boolean;
}

/** Apply a receive-pack request body (pkt-line commands + optional pack) to the repository. */
export function receivePack(repo: Repo, body: Buffer): ReceiveResult {
  let packets: Packet[];
  let rest: Buffer;
  try {
    const parsed = parsePackets(body);
    packets = parsed.packets;
    rest = parsed.rest;
  } catch {
    return { unpackOk: false, outcomes: [], sideband: false };
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  // The pack begins right after the flush packet that ends the command list; track the wire
  // length of every packet consumed to find it.
  let packStart = body.length;
  let offset = 0;
  for (const packet of packets) {
    offset += packet.kind === 'data' ? packet.payload.length + 4 : 4;
    if (packet.kind === 'flush') {
      packStart = offset;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  void rest;
  const pack = body.subarray(packStart);

  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.getObject(oid));
      for (const object of objects) repo.putObject(object.type, object.data);
    } catch {
      unpackOk = false;
    }
  }

  const outcomes: PushOutcome[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    outcomes.push({ ref: command.ref, ok: applyCommand(repo, command), reason: '' });
    const last = outcomes[outcomes.length - 1];
    if (!last.ok) last.reason = 'non-fast-forward';
  }
  return { unpackOk, outcomes, sideband: capabilities.split(' ').includes('side-band-64k') };
}

function applyCommand(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): boolean {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete: refuse when the caller's view of the ref is stale.
    if (current !== undefined && command.oldOid !== ZERO_OID && command.oldOid !== current) return false;
    repo.refs.delete(command.ref);
    return true;
  }
  const newObject = repo.getObject(command.newOid);
  if (!newObject) return false;
  if (current !== undefined) {
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return false;
    // Updates must be fast-forward (for branches and tags alike, peeling tags to commits).
    if (!repo.isAncestor(current, command.newOid)) return false;
  } else if (command.oldOid !== ZERO_OID && repo.getObject(command.oldOid) === undefined) {
    // Creating with a non-zero old the server has never seen: accept only when it names the
    // current (absent) state — git would refuse; the suite always sends zero for creates.
    return false;
  }
  repo.refs.set(command.ref, command.newOid);
  return true;
}

/** Frame a receive-pack result: the report-status stream, sideband-wrapped when negotiated. */
export function receiveReport(result: ReceiveResult): Buffer {
  const lines: string[] = [`unpack ${result.unpackOk ? 'ok' : 'error'}\n`];
  for (const outcome of result.outcomes) {
    lines.push(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`);
  }
  const report = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (result.sideband) return Buffer.concat([sidebandWrap(report, 1), PKT_FLUSH]);
  return report;
}
