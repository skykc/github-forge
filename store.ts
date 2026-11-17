// The in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments, plus the deterministic id allocation the
// whole forge shares. One trial is one fresh process, so nothing persists.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
export const SCENARIO_EPOCH_SEC = 1735689600;

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  comments: Map<number, Comment[]>;
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextRepoSeq = 1;
  nextIssueId = 1;
  requestSeq = 1;
  readonly trialNowSec: number;
  readonly trialNowIso: string;

  constructor() {
    this.trialNowSec = parseTrialNow();
    this.trialNowIso = new Date(this.trialNowSec * 1000).toISOString();
  }

  nextRequestId(): string {
    return `req-${this.requestSeq++}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Every repository belongs to the viewer; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  /** Create a repository; returns null when the name is already taken. */
  createRepo(
    owner: string,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
  ): Repo | null {
    if (owner !== VIEWER.login) return null;
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch: defaultBranch || DEFAULT_BRANCH,
      databaseId: this.nextRepoId++,
      seq: this.nextRepoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      issueSeq: 1,
      pullSeq: 1,
      commentSeq: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.issueSeq++,
      title,
      body,
      state: 'open',
      labels,
      seq: repo.issues.length + 1,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = { id: repo.commentSeq++, body };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
    mergeBaseSha: string | null,
  ): Pull {
    const pull: Pull = {
      number: repo.pullSeq++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha,
      seq: repo.pulls.length + 1,
    };
    repo.pulls.push(pull);
    return pull;
  }
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function repoGlobalId(owner: string, name: string): string {
  return Buffer.from(`R:${owner}/${name}`, 'utf8').toString('base64');
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`I:${owner}/${name}#${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`PR:${owner}/${name}#${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(
  owner: string,
  name: string,
  issueNumber: number,
  commentId: number,
): string {
  return Buffer.from(`C:${owner}/${name}#${issueNumber}#${commentId}`, 'utf8').toString('base64');
}

export interface DecodedGlobalId {
  kind: 'R' | 'I' | 'PR' | 'C';
  owner: string;
  name: string;
  number: number;
  commentId: number;
}

/** Decode an opaque global id made by the helpers above; null when malformed. */
export function decodeGlobalId(id: string): DecodedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const m = /^(R|I|PR|C):([^/]+)\/([^#]+)(?:#(\d+)(?:#(\d+))?)?$/.exec(text);
  if (!m) return null;
  return {
    kind: m[1] as DecodedGlobalId['kind'],
    owner: m[2],
    name: m[3],
    number: m[4] ? Number(m[4]) : 0,
    commentId: m[5] ? Number(m[5]) : 0,
  };
}
