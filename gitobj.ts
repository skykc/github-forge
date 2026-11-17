// The git object model: SHA-1 hashing, commit/tree/tag parsing and building,
// pkt-line framing, packfile encode/decode (plain objects and OFS/REF deltas),
// reachability, fast-forward and merge-base walks, and tree diffs. Written
// from the git object format itself; no git binary, no dependencies.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, ZERO_OID, type GitObject, type ObjectType } from './store.ts';

export { ZERO_OID };

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-lines

export function pktLine(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'utf8');
}

export function pktSideband(band: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([band]), payload]);
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}

export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Split a byte stream into pkt-lines. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('pkt-line truncated');
    const len = parseInt(buf.subarray(pos, pos + 4).toString('utf8'), 16);
    if (!Number.isFinite(len) || len < 0) throw new Error('pkt-line length is not hex');
    if (len === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
    } else {
      if (pos + len > buf.length) throw new Error('pkt-line overruns the buffer');
      out.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return out;
}

// ------------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Build commit bytes; the message is stored with a trailing newline, git-style. */
export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let head = `tree ${tree}\n`;
  for (const p of parents) head += `parent ${p}\n`;
  head += `author ${author}\ncommitter ${committer}\n`;
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${head}\n${msg}`, 'utf8');
}

/** The message as a REST response should show it: one trailing newline stripped. */
export function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// --------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(pos, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    pos = nul + 21;
  }
  return out;
}

/** Git tree sort order: entries compare as name, with directories as name + '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FileEntry {
  oid: string;
  mode: string;
}

/**
 * Build the tree hierarchy for a flat path -> file map. Returns the root tree
 * oid; every tree object created is put into `out` (oid -> object).
 */
export function buildTreeFromFiles(
  files: Map<string, FileEntry>,
  out: Map<string, GitObject>,
): string {
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of subdirs) {
      const oid = buildDir(`${prefix}${dir}/`);
      entries.push({ mode: '40000', name: dir, oid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    out.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildDir('');
}

/** Flatten a tree into path -> file entries (recursively, skipping submodules). */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
  out = new Map<string, FileEntry>(),
): Map<string, FileEntry> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix + e.name;
    if (e.mode === '40000') {
      flattenTree(objects, e.oid, `${path}/`, out);
    } else if (e.mode !== '160000') {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

// ---------------------------------------------------------------------- pack

function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Encode objects as a pack (plain objects only, no deltas), in oid order. */
export function encodePack(objects: { oid: string; type: ObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const o of sorted) {
    parts.push(encodeObjectHeader(TYPE_CODES[o.type], o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(createHash('sha1').update(body).digest('hex'), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
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
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function readPackEntryHeader(buffer: Buffer, start: number): { type: number; size: number; next: number } {
  let byte = buffer[start];
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { type, size, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export interface DecodedObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Decode a packfile. Deltas are resolved against objects earlier in the same
 * pack, or against `known` (the repository's objects) for REF deltas.
 * Verifies the trailer checksum and the declared object count.
 */
export function decodePack(
  buf: Buffer,
  known: Map<string, GitObject>,
): Map<string, DecodedObject> {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const checksum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (trailer !== checksum) throw new Error('pack trailer checksum mismatch');
  const out = new Map<string, DecodedObject>();
  const byOffset = new Map<number, DecodedObject>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    const { type, size, next } = readPackEntryHeader(buf, pos);
    pos = next;
    let base: DecodedObject | GitObject | undefined;
    if (type === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(buf, pos);
      pos = after;
      base = byOffset.get(entryStart - baseOffset);
      if (!base) throw new Error('ofs-delta base is not in the pack');
    } else if (type === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      base = byOffset.size ? [...byOffset.values()].find((o) => o.oid === baseOid) : undefined;
      if (!base) base = out.get(baseOid) ?? known.get(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} is unknown`);
    }
    const { data, next: afterData } = inflateAt(buf, pos);
    pos = afterData;
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, got ${data.length}`);
    let obj: DecodedObject;
    if (type === 6 || type === 7) {
      const resolved = applyDelta(base!.data, data);
      obj = { oid: hashObject(base!.type, resolved), type: base!.type, data: resolved };
    } else {
      const objType = CODE_TYPES[type];
      if (!objType) throw new Error(`unknown pack object type ${type}`);
      obj = { oid: hashObject(objType, data), type: objType, data };
    }
    out.set(obj.oid, obj);
    byOffset.set(entryStart, obj);
  }
  return out;
}

// ------------------------------------------------------------- reachability

/** Peel a tag object to its target commit (following tag chains). */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All commit oids reachable from `tips` (following parents), optionally capped at `maxDepth` generations. */
export function reachableCommits(
  objects: Map<string, GitObject>,
  tips: string[],
  maxDepth?: number,
): Set<string> {
  const out = new Set<string>();
  const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    const commitOid = peelToCommit(objects, oid);
    if (!commitOid || seen.has(commitOid)) continue;
    seen.add(commitOid);
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    out.add(commitOid);
    const obj = objects.get(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return out;
}

/**
 * All objects reachable from `tips`: commits (respecting maxDepth), their
 * trees and blobs, and tag objects on the way. `exclude` oids (and everything
 * reachable from them) are skipped.
 */
export function reachableObjects(
  objects: Map<string, GitObject>,
  tips: string[],
  opts: { maxDepth?: number; exclude?: Set<string> } = {},
): Map<string, GitObject> {
  const excludeCommits = opts.exclude ? reachableCommits(objects, [...opts.exclude]) : new Set<string>();
  const commits = reachableCommits(objects, tips, opts.maxDepth);
  const out = new Map<string, GitObject>();
  const visitTree = (treeOid: string, seen: Set<string>) => {
    if (seen.has(treeOid)) return;
    seen.add(treeOid);
    const tree = objects.get(treeOid);
    if (!tree) return;
    out.set(treeOid, tree);
    if (tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const child = objects.get(e.oid);
      if (!child) continue;
      if (e.mode === '40000') visitTree(e.oid, seen);
      else out.set(e.oid, child);
    }
  };
  const seenTrees = new Set<string>();
  for (const c of commits) {
    if (excludeCommits.has(c)) continue;
    const obj = objects.get(c);
    if (!obj) continue;
    out.set(c, obj);
    const info = parseCommit(obj.data);
    visitTree(info.tree, seenTrees);
  }
  // Tag objects on the tips themselves.
  for (const tip of tips) {
    let cur = tip;
    for (let i = 0; i < 16; i++) {
      const obj = objects.get(cur);
      if (!obj || obj.type !== 'tag') break;
      out.set(cur, obj);
      cur = parseTag(obj.data).object;
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `descendant` following parents. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const reachable = reachableCommits(objects, [descendant]);
  return reachable.has(ancestor);
}

/** The merge-base of two commits: the first commit reachable from both, by generation order. */
export function findMergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const fromA = reachableCommits(objects, [a]);
  if (fromA.has(b)) return b;
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// -------------------------------------------------------------------- diffs

/** Line counts for a file change, via LCS on lines (small files only). */
export function lineDiffCounts(oldData: Buffer | null, newData: Buffer | null): {
  additions: number;
  deletions: number;
} {
  const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
  const newLines = newData ? newData.toString('utf8').split('\n') : [];
  const strip = (lines: string[]) => {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = strip(oldLines);
  const b = strip(newLines);
  if (a.length > 2000 || b.length > 2000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS length via a rolling row.
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const common = prev[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}
