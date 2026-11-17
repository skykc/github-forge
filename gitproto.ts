// git smart HTTP: info/refs advertisements (v2 and v0), ls-refs, fetch
// (v2 and v0, with shallow/deepen), and receive-pack with per-ref
// fast-forward reporting. The pack/object work lives in gitobj.ts.
import {
  decodePack,
  decodePktLines,
  encodePack,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktSideband,
  reachableCommits,
  reachableObjects,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-forge/1.0';

function json404(message: string): GitResponse {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function json400(message: string): GitResponse {
  return {
    status: 400,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

/** All refs sorted, HEAD first when it has a target. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** Peeled commit for an annotated tag ref, or null. */
function peeledCommit(repo: Repo, refName: string): string | null {
  const oid = repo.refs.get(refName);
  if (!oid) return null;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToCommit(repo.objects, oid);
}

// ------------------------------------------------------------ info/refs

function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  let first = true;
  const pushLine = (text: string) => {
    lines.push(pktLine(first ? `${text}\0${caps}\n` : `${text}\n`));
    first = false;
  };
  pushLine(`${tip} HEAD`);
  for (const ref of refs) {
    pushLine(`${ref.oid} ${ref.name}`);
    const peeled = peeledCommit(repo, ref.name);
    if (peeled) pushLine(`${peeled} ${ref.name}^{}`);
  }
  return lines;
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string | null,
  gitProtocol: string | null,
): GitResponse {
  const repo = resolveRepo(store, owner, name);
  if (!repo) return json404('Repository not found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      const body = Buffer.concat([
        pktLine('version 2\n'),
        pktLine(`agent=${AGENT}\n`),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow filter\n'),
        pktLine('object-format=sha1\n'),
        pktFlush(),
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    const caps =
      'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=github-forge/1.0 object-format=sha1';
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      pktFlush(),
      ...v0RefLines(repo, caps),
      pktFlush(),
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const caps =
      'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0 symref=HEAD:refs/heads/main';
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      pktFlush(),
      ...v0RefLines(repo, caps),
      pktFlush(),
    ]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return json400('Unknown service');
}

// ----------------------------------------------------------- upload-pack

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2Args(lines: { kind: string; data?: Buffer }[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.kind !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8').trimEnd();
    if (text.startsWith('want ')) plan.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) plan.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) plan.depth = Number(text.slice(7).trim());
  }
  return plan;
}

/**
 * The objects a fetch must deliver. Commits come from a depth-limited walk
 * off the wants; the haves walk (cut at the client's shallow boundary) is
 * what the client already holds, so its objects are excluded.
 */
function planFetch(repo: Repo, plan: FetchPlan): {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
} {
  const objects = repo.objects;
  // Peel wants to commits for the reachability walk.
  const wantCommits = plan.wants
    .map((w) => peelToCommit(objects, w) ?? w)
    .filter((w) => objects.has(w));
  const commits = reachableCommits(objects, wantCommits, plan.depth ?? undefined);
  // The new shallow boundary: the deepest included commits (parents not included).
  const boundary: string[] = [];
  for (const c of commits) {
    const obj = objects.get(c);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.every((p) => !commits.has(p))) boundary.push(c);
  }
  const unshallow = plan.shallow.filter((s) => {
    if (!commits.has(s)) return false;
    const obj = objects.get(s);
    if (!obj || obj.type !== 'commit') return false;
    return parseCommit(obj.data).parents.every((p) => commits.has(p));
  });
  // What the client already holds: walk from the haves, stopping at the
  // client's shallow boundary (its parents are not held).
  const held = new Set<string>(plan.shallow);
  const heldObjects = new Map<string, GitObject>();
  const queue = [...plan.haves];
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const commitOid = peelToCommit(objects, oid);
    if (!commitOid || seenCommits.has(commitOid)) continue;
    seenCommits.add(commitOid);
    const obj = objects.get(commitOid);
    if (!obj) continue;
    heldObjects.set(commitOid, obj);
    const info = parseCommit(obj.data);
    const walkTree = (treeOid: string, seen: Set<string>) => {
      if (seen.has(treeOid)) return;
      seen.add(treeOid);
      const tree = objects.get(treeOid);
      if (!tree) return;
      heldObjects.set(treeOid, tree);
      if (tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        const child = objects.get(e.oid);
        if (!child) continue;
        if (e.mode === '40000') walkTree(e.oid, seen);
        else heldObjects.set(e.oid, child);
      }
    };
    walkTree(info.tree, new Set());
    if (held.has(commitOid)) continue; // shallow boundary: parents are not held
    for (const p of info.parents) queue.push(p);
  }
  // Objects the walk off the wants needs. The raw wants go in (not the
  // peeled commits) so an annotated tag object a clone asked for is itself
  // delivered, not just the commit it points at.
  const wanted = reachableObjects(objects, plan.wants, { maxDepth: plan.depth ?? undefined });
  const deliver = new Map<string, GitObject>();
  for (const [oid, obj] of wanted) {
    if (!heldObjects.has(oid)) deliver.set(oid, obj);
  }
  return {
    objects: deliver,
    shallow: plan.depth !== null ? boundary : [],
    unshallow: plan.depth !== null ? unshallow : plan.shallow.filter((s) => commits.has(s)),
  };
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65000;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    chunks.push(pktSideband(1, pack.subarray(pos, Math.min(pos + CHUNK, pack.length))));
  }
  return Buffer.concat(chunks);
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  const hasRefs = repo.refs.size > 0;
  const matches = (name: string) =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (!hasRefs) {
    if (matches('HEAD')) {
      lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
    lines.push(pktFlush());
    return Buffer.concat(lines);
  }
  if (matches('HEAD')) {
    const sym = args.symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(pktLine(`${tip} HEAD${sym}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledCommit(repo, ref.name);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = resolveRepo(store, owner, name);
  if (!repo) return json404('Repository not found');
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return json400(`malformed pkt-line stream: ${(err as Error).message}`);
  }
  const first = packets.find((p) => p.kind === 'data');
  const command = first?.data?.toString('utf8').trim() ?? '';
  if (gitProtocol === 'version=2') {
    if (command === 'command=ls-refs') {
      const args = { peel: false, symrefs: false, prefixes: [] as string[] };
      for (const p of packets) {
        if (p.kind !== 'data' || !p.data) continue;
        const text = p.data.toString('utf8').trimEnd();
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice(11));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
    }
    if (command === 'command=fetch') {
      const plan = parseV2Args(packets);
      const { objects, shallow, unshallow } = planFetch(repo, plan);
      const pack = encodePack([...objects.entries()].map(([oid, o]) => ({ oid, type: o.type, data: o.data })));
      const parts: Buffer[] = [];
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(pktDelim());
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(pktDelim());
      }
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(pack));
      parts.push(pktFlush());
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: Buffer.concat(parts),
      };
    }
    return json400(`unknown v2 command: ${command}`);
  }
  // v0 fetch.
  const plan = parseV2Args(packets);
  const { objects, shallow, unshallow } = planFetch(repo, plan);
  const pack = encodePack([...objects.entries()].map(([oid, o]) => ({ oid, type: o.type, data: o.data })));
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = resolveRepo(store, owner, name);
  if (!repo) return json404('Repository not found');
  // Split the command pkt-lines from the pack: the first flush ends the commands.
  const commands: PushCommand[] = [];
  let pos = 0;
  let packStart = body.length;
  try {
    while (pos + 4 <= body.length) {
      const len = parseInt(body.subarray(pos, pos + 4).toString('utf8'), 16);
      if (!Number.isFinite(len) || len < 0) throw new Error('bad pkt-line length');
      if (len === 0) {
        packStart = pos + 4;
        break;
      }
      if (len === 1) {
        pos += 4;
        continue;
      }
      if (pos + len > body.length) throw new Error('pkt-line overruns the body');
      const text = body.subarray(pos + 4, pos + len).toString('utf8').trimEnd();
      const cmdPart = text.split('\0')[0];
      const [oldOid, newOid, ref] = cmdPart.split(' ');
      if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
      pos += len;
    }
  } catch (err) {
    return json400(`malformed push: ${(err as Error).message}`);
  }
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const decoded = decodePack(packBytes, repo.objects);
      for (const [oid, obj] of decoded) repo.objects.set(oid, { type: obj.type, data: obj.data });
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const report: Buffer[] = [];
  if (unpackError) {
    report.push(pktLine(`unpack ${unpackError}\n`));
    for (const cmd of commands) report.push(pktLine(`ng ${cmd.ref} unpack failed\n`));
  } else {
    report.push(pktLine('unpack ok\n'));
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && (cmd.oldOid === ZERO_OID || current === cmd.oldOid)) {
          ok = true;
        } else {
          reason = 'delete failed';
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current === undefined) ok = true;
        else reason = 'already exists';
      } else {
        // Update: the ref must still be at oldOid and the new tip must have
        // the old tip as an ancestor.
        const newCommit = peelToCommit(repo.objects, cmd.newOid);
        if (current !== cmd.oldOid) {
          reason = 'non-fast-forward';
        } else if (!newCommit) {
          reason = 'non-fast-forward';
        } else if (!isAncestor(repo.objects, cmd.oldOid, newCommit)) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        report.push(pktLine(`ok ${cmd.ref}\n`));
      } else {
        report.push(pktLine(`ng ${cmd.ref} ${reason}\n`));
      }
    }
  }
  const bodyParts: Buffer[] = [pktSideband(1, Buffer.concat([...report, pktFlush()])), pktFlush()];
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(bodyParts),
  };
}
