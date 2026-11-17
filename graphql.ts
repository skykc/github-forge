// GitHub GraphQL v4: a hand-rolled parser and executor for the documents
// `gh` and `github-mcp-server` send, including introspection, cursor
// pagination and the five mutations. No schema library, no dependencies.
import {
  commitOnBranch,
  pullIsConflicted,
  resolveRef,
  treeFiles,
} from './rest.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  VIEWER,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { findMergeBase } from './gitobj.ts';

// -------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]|&='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(input[j])) j++;
      const raw = input.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number(raw) });
      else tokens.push({ kind: 'int', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] }
  | { kind: 'enum'; value: string };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        doc.operations.push({ kind: 'operation', operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        doc.fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unknown document keyword ${keyword}`);
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value as string;
      const variables: string[] = [];
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '$') {
            variables.push(this.expectName());
          } else if (t.kind === 'punct' && t.value === '=') {
            this.parseValue(); // default value, discarded
          } else if (t.kind === 'punct' && (t.value === ':' || t.value === '!' || t.value === '[' || t.value === ']')) {
            continue;
          } else if (t.kind === 'name') {
            continue; // type names
          }
        }
        this.expectPunct(')');
      }
      // Directives.
      while (this.isPunct('@')) {
        this.next();
        this.expectName();
        if (this.isPunct('(')) this.parseArguments();
      }
      doc.operations.push({ kind: 'operation', operation: keyword, name, variables, selection: this.parseSelectionSet() });
    }
    return doc;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.isPunct('...')) {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          out.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          out.push({ kind: 'fragmentSpread', name: this.next().value as string });
        } else {
          out.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.isPunct(':')) {
        this.next();
        alias = first;
        name = this.expectName();
      }
      let args: { name: string; value: ValueNode }[] = [];
      if (this.isPunct('(')) args = this.parseArguments();
      while (this.isPunct('@')) {
        this.next();
        this.expectName();
        if (this.isPunct('(')) this.parseArguments();
      }
      let selection: SelectionNode[] = [];
      if (this.isPunct('{')) selection = this.parseSelectionSet();
      out.push({ kind: 'field', alias, name, args, selection });
    }
    this.expectPunct('}');
    return out;
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const out: { name: string; value: ValueNode }[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string' || t.kind === 'int' || t.kind === 'float') return { kind: 'literal', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// --------------------------------------------------------------- execution

type Ctx = { store: Store; baseUrl: string };
type AnyObj = { __typename: string; [key: string]: unknown };

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'literal':
      return node.value;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function pageInfoFor(total: number, taken: number, lastTaken: number | null): AnyObj {
  return {
    __typename: 'PageInfo',
    hasNextPage: taken < total,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: lastTaken !== null ? cursorFor(lastTaken) : null,
  };
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObj(repo: Repo, issueNumber: number, comment: Comment): AnyObj {
  return { __typename: 'Comment', repo, issueNumber, comment };
}

// The fields each type exposes, with their resolvers. A field absent from its
// type's map is an unknown field (a GraphQL error naming it).
type Resolver = (parent: AnyObj, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id }),
    repository: (_p, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? { __typename: 'Repository', repo } : null;
    },
    node: (_p, args, ctx) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) return null;
      if (decoded.kind === 'R') return { __typename: 'Repository', repo };
      if (decoded.kind === 'I') {
        const issue = repo.issues.find((i) => i.number === decoded.number);
        return issue ? issueObj(repo, issue) : null;
      }
      if (decoded.kind === 'PR') {
        const pull = repo.pulls.find((p) => p.number === decoded.number);
        return pull ? pullObj(repo, pull) : null;
      }
      if (decoded.kind === 'C') {
        const list = repo.comments.get(decoded.number) ?? [];
        const comment = list.find((c) => c.id === decoded.commentId);
        return comment ? commentObj(repo, decoded.number, comment) : null;
      }
      return null;
    },
    __type: (_p, args) => introspectionType(String(args.name ?? '')),
  },
  User: {
    login: (p) => p.login as string,
    id: (p) => p.id as number,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (p) => repoGlobalId((p.repo as Repo).owner, (p.repo as Repo).name),
    databaseId: (p) => (p.repo as Repo).databaseId,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p) => (p.repo as Repo).fullName,
    owner: (p) => ({ __typename: 'User', login: (p.repo as Repo).owner, id: VIEWER.id }),
    defaultBranchRef: (p) => ({ __typename: 'Ref', name: (p.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (p, args) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (p, args) => {
      const repo = p.repo as Repo;
      let issues = [...repo.issues];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const dir = String(orderBy.direction ?? 'ASC').toUpperCase();
      issues.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
      const after = numberFromCursor(args.after);
      if (after !== null) issues = issues.filter((i) => i.number > after);
      const total = issues.length;
      const first = typeof args.first === 'number' ? args.first : total;
      const taken = issues.slice(0, first);
      const last = taken.length > 0 ? taken[taken.length - 1].number : null;
      return {
        __typename: 'IssueConnection',
        nodes: taken.map((i) => issueObj(repo, i)),
        pageInfo: pageInfoFor(total, taken.length, last),
        totalCount: total,
      };
    },
    pullRequests: (p, args) => {
      const repo = p.repo as Repo;
      let pulls = [...repo.pulls];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
        pulls = pulls.filter((pr) => wanted.has(pr.state === 'merged' ? 'merged' : pr.state));
      } else {
        pulls = pulls.filter((pr) => pr.state === 'open');
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const dir = String(orderBy.direction ?? 'ASC').toUpperCase();
      pulls.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
      const after = numberFromCursor(args.after);
      if (after !== null) pulls = pulls.filter((pr) => pr.number > after);
      const total = pulls.length;
      const first = typeof args.first === 'number' ? args.first : total;
      const taken = pulls.slice(0, first);
      const last = taken.length > 0 ? taken[taken.length - 1].number : null;
      return {
        __typename: 'PullRequestConnection',
        nodes: taken.map((pr) => pullObj(repo, pr)),
        pageInfo: pageInfoFor(total, taken.length, last),
        totalCount: total,
      };
    },
    pullRequest: (p, args) => {
      const repo = p.repo as Repo;
      const pull = repo.pulls.find((pr) => pr.number === Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    },
  },
  Ref: {
    name: (p) => p.name as string,
  },
  Issue: {
    id: (p) => issueGlobalId((p.repo as Repo).owner, (p.repo as Repo).name, (p.issue as Issue).number),
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    body: (p) => (p.issue as Issue).body,
    state: (p) => ((p.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (p, _a, ctx) => `${ctx.baseUrl}/api/v3/repos/${(p.repo as Repo).fullName}/issues/${(p.issue as Issue).number}`,
    createdAt: (_p, _a, ctx) => ctx.store.trialNowIso,
    updatedAt: (_p, _a, ctx) => ctx.store.trialNowIso,
    author: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id }),
  },
  PullRequest: {
    id: (p) => pullGlobalId((p.repo as Repo).owner, (p.repo as Repo).name, (p.pull as Pull).number),
    number: (p) => (p.pull as Pull).number,
    title: (p) => (p.pull as Pull).title,
    body: (p) => (p.pull as Pull).body,
    state: (p) => {
      const pull = p.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (p) => (p.pull as Pull).merged,
    mergeable: (p, _a, ctx) => {
      const pull = p.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullIsConflicted(ctx.store, p.repo as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (p) => (p.pull as Pull).headRef,
    baseRefName: (p) => (p.pull as Pull).baseRef,
    files: (p, args) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      const baseFiles = pull.mergeBaseSha ? treeFiles(repo, pull.mergeBaseSha) : new Map();
      const headFiles = treeFiles(repo, pull.headSha);
      const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])]
        .filter((path) => (baseFiles.get(path)?.oid ?? null) !== (headFiles.get(path)?.oid ?? null))
        .sort();
      const first = typeof args.first === 'number' ? args.first : paths.length;
      const taken = paths.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: taken.map((path) => ({ __typename: 'PullRequestChangedFile', path })),
        pageInfo: pageInfoFor(paths.length, taken.length, null),
        totalCount: paths.length,
      };
    },
  },
  PullRequestChangedFile: {
    path: (p) => p.path as string,
  },
  Comment: {
    id: (p) => commentGlobalId((p.repo as Repo).owner, (p.repo as Repo).name, p.issueNumber as number, (p.comment as Comment).id),
    body: (p) => (p.comment as Comment).body,
  },
  IssueConnection: {
    nodes: (p) => p.nodes as unknown[],
    edges: (p) => (p.nodes as AnyObj[]).map((n) => ({ __typename: 'IssueEdge', node: n, cursor: cursorFor(n.issue.number) })),
    pageInfo: (p) => p.pageInfo as AnyObj,
    totalCount: (p) => p.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (p) => p.nodes as unknown[],
    edges: (p) => (p.nodes as AnyObj[]).map((n) => ({ __typename: 'PullRequestEdge', node: n, cursor: cursorFor(n.pull.number) })),
    pageInfo: (p) => p.pageInfo as AnyObj,
    totalCount: (p) => p.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (p) => p.nodes as unknown[],
    edges: (p) => (p.nodes as AnyObj[]).map((n) => ({ __typename: 'PullRequestChangedFileEdge', node: n, cursor: '' })),
    pageInfo: (p) => p.pageInfo as AnyObj,
    totalCount: (p) => p.totalCount as number,
  },
  IssueEdge: {
    node: (p) => p.node as AnyObj,
    cursor: (p) => p.cursor as string,
  },
  PullRequestEdge: {
    node: (p) => p.node as AnyObj,
    cursor: (p) => p.cursor as string,
  },
  PullRequestChangedFileEdge: {
    node: (p) => p.node as AnyObj,
    cursor: (p) => p.cursor as string,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage as boolean,
    hasPreviousPage: (p) => p.hasPreviousPage as boolean,
    startCursor: (p) => (p.startCursor as string | null) ?? null,
    endCursor: (p) => (p.endCursor as string | null) ?? null,
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'R') throw new Error('repositoryId does not identify a repository');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    },
    closeIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'I') throw new Error('issueId does not identify an issue');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    },
    createPullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'R') throw new Error('repositoryId does not identify a repository');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (!headSha || !baseSha) throw new Error('head or base branch not found');
      const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === headRef && pr.baseRef === baseRef);
      if (existing) return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, existing) };
      const mergeBase = findMergeBase(repo.objects, headSha, baseSha);
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', headRef, baseRef, headSha, baseSha, mergeBase);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PR') throw new Error('pullRequestId does not identify a pull request');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.find((pr) => pr.number === decoded.number);
      if (!repo || !pull) throw new Error('pull request not found');
      if (pull.state === 'closed') throw new Error('pull request is already closed');
      if (pullIsConflicted(ctx.store, repo, pull)) throw new Error('Merge conflict');
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
      const changes = squashChanges(ctx.store, repo, pull);
      const sha = commitOnBranch(ctx.store, repo, pull.baseRef, message, changes);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = ctx.store.trialNowIso;
      pull.mergeCommitSha = sha;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    },
    addComment: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'I') throw new Error('subjectId does not identify an issue');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (!repo || !issue) throw new Error('issue not found');
      const comment = ctx.store.createComment(repo, decoded.number, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'AddCommentEdge', node: commentObj(repo, decoded.number, comment) },
        comment: commentObj(repo, decoded.number, comment),
      };
    },
  },
  CreateIssuePayload: { issue: (p) => p.issue as AnyObj },
  CloseIssuePayload: { issue: (p) => p.issue as AnyObj },
  CreatePullRequestPayload: { pullRequest: (p) => p.pullRequest as AnyObj },
  MergePullRequestPayload: { pullRequest: (p) => p.pullRequest as AnyObj },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge as AnyObj,
    comment: (p) => p.comment as AnyObj,
  },
  AddCommentEdge: { node: (p) => p.node as AnyObj },
};

// The file changes a squash merge applies: head-vs-merge-base applied onto
// the current base tip. (Shared with the REST merge; kept here to avoid a
// circular import of rest.ts's private helper.)
function squashChanges(store: Store, repo: Repo, pull: Pull): Map<string, Buffer | null> {
  const baseFiles = pull.mergeBaseSha ? treeFiles(repo, pull.mergeBaseSha) : new Map();
  const headFiles = treeFiles(repo, pull.headSha);
  const curBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const curBaseFiles = treeFiles(repo, curBaseTip);
  const merged = new Map(curBaseFiles);
  for (const [path, headFile] of headFiles) {
    if ((baseFiles.get(path)?.oid ?? null) !== (headFile?.oid ?? null)) merged.set(path, { ...headFile });
  }
  for (const [path] of baseFiles) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const changes = new Map<string, Buffer | null>();
  for (const [path, file] of merged) {
    if ((curBaseFiles.get(path)?.oid ?? null) !== (file?.oid ?? null)) {
      const blob = repo.objects.get(file.oid);
      changes.set(path, blob ? blob.data : null);
    }
  }
  for (const [path] of curBaseFiles) {
    if (!merged.has(path)) changes.set(path, null);
  }
  return changes;
}

// ------------------------------------------------------------ introspection

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'updatedAt', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  Comment: ['id', 'body'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
};

function introspectionType(name: string): AnyObj | null {
  if (INTROSPECTION_FIELDS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: INTROSPECTION_FIELDS[name].map((f) => ({ __typename: '__Field', name: f })),
      enumValues: null,
    };
  }
  if (INTROSPECTION_ENUMS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: INTROSPECTION_ENUMS[name].map((v) => ({ __typename: '__EnumValue', name: v })),
    };
  }
  return null;
}

RESOLVERS['__Type'] = {
  name: (p) => p.name as string,
  kind: (p) => p.kind as string,
  fields: (p) => (p.fields as AnyObj[] | null) ?? null,
  enumValues: (p) => (p.enumValues as AnyObj[] | null) ?? null,
};
RESOLVERS['__Field'] = { name: (p) => p.name as string };
RESOLVERS['__EnumValue'] = { name: (p) => p.name as string };

// --------------------------------------------------------------- execution

interface ExecState {
  errors: { message: string }[];
  doc: DocumentNode;
  variables: Record<string, unknown>;
  ctx: Ctx;
}

function executeSelection(
  parent: AnyObj | null,
  parentType: string,
  selection: SelectionNode[],
  state: ExecState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && parent && parent.__typename !== sel.typeCondition) continue;
      if (sel.typeCondition && !parent) continue;
      const nested = executeSelection(parent, sel.typeCondition ?? parentType, sel.selection, state);
      Object.assign(out, nested);
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = state.doc.fragments.get(sel.name);
      if (!frag) {
        state.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCondition && parent && parent.__typename !== frag.typeCondition) continue;
      const nested = executeSelection(parent, frag.typeCondition ?? parentType, frag.selection, state);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const typeResolvers = RESOLVERS[parentType];
    const resolver = typeResolvers?.[sel.name];
    if (!resolver) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = resolveValue(a.value, state.variables);
    let value: unknown;
    try {
      value = resolver(parent ?? ({ __typename: parentType } as AnyObj), args, state.ctx);
    } catch (err) {
      state.errors.push({ message: (err as Error).message });
      out[responseKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (sel.selection.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item && typeof item === 'object' && '__typename' in item) {
          return executeSelection(item as AnyObj, (item as AnyObj).__typename, sel.selection, state);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      out[responseKey] = executeSelection(value as AnyObj, (value as AnyObj).__typename, sel.selection, state);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

export function executeGraphQL(
  store: Store,
  baseUrl: string,
  body: unknown,
): { status: number; body: unknown } {
  const ctx: Ctx = { store, baseUrl };
  const runOne = (docBody: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof docBody.query === 'string' ? docBody.query : '';
    const variables = (docBody.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof docBody.operationName === 'string' ? docBody.operationName : null;
    let doc: DocumentNode;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    let operation = doc.operations[0];
    if (operationName) {
      const found = doc.operations.find((op) => op.name === operationName);
      if (found) operation = found;
    }
    if (!operation) return { data: null, errors: [{ message: 'No operation provided.' }] };
    const state: ExecState = { errors: [], doc, variables, ctx };
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection({ __typename: rootType }, rootType, operation.selection, state);
    const result: Record<string, unknown> = { data };
    if (state.errors.length > 0) result.errors = state.errors;
    return result;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => runOne((item ?? {}) as Record<string, unknown>)) };
  }
  if (body && typeof body === 'object') {
    return { status: 200, body: runOne(body as Record<string, unknown>) };
  }
  return { status: 400, body: { errors: [{ message: 'Request body must be a JSON object.' }] } };
}
