// MCP over JSON-RPC 2.0 streamable HTTP: server/discover (2026-07-28),
// initialize (legacy handshake), tools/list and tools/call for the forge
// tools. The tools act on the same store as REST, so a repository or issue
// made over MCP reads back over /api/v3 unchanged.
import { findMergeBase } from './gitobj.ts';
import {
  commitOnBranch,
  issueJson,
  pullIsConflicted,
  pullJson,
  repoJson,
  resolveRef,
  treeFiles,
  type RestContext,
} from './rest.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

export interface McpResponse {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): never {
  throw Object.assign(new Error(`missing required argument: ${name}`), { code: -32602 });
}

function requireArgs(args: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') missingArg(name);
  }
}

function getRepoOrThrow(store: Store, owner: unknown, repo: unknown): Repo {
  const r = store.getRepo(String(owner ?? ''), String(repo ?? ''));
  if (!r) throw Object.assign(new Error('Repository not found'), { code: -32602 });
  return r;
}

function callTool(ctx: RestContext, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      requireArgs(args, ['name']);
      const repo = store.createRepo(
        VIEWER.login,
        String(args.name),
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
        'main',
      );
      if (!repo) throw Object.assign(new Error('Repository already exists'), { code: -32602 });
      return toolResult(repoJson(ctx, repo));
    }
    case 'get_repo': {
      requireArgs(args, ['owner', 'repo']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      return toolResult(repoJson(ctx, repo));
    }
    case 'create_issue': {
      requireArgs(args, ['owner', 'repo', 'title']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(ctx, repo, issue));
    }
    case 'list_issues': {
      requireArgs(args, ['owner', 'repo']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      return toolResult(issues.map((i) => issueJson(ctx, repo, i)));
    }
    case 'create_pull_request': {
      requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      const headRef = String(args.head);
      const baseRef = String(args.base);
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (!headSha) throw Object.assign(new Error('head branch not found'), { code: -32602 });
      if (!baseSha) throw Object.assign(new Error('base branch not found'), { code: -32602 });
      const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      if (existing) return toolResult(pullJson(ctx, repo, existing));
      const mergeBase = findMergeBase(repo.objects, headSha, baseSha);
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', headRef, baseRef, headSha, baseSha, mergeBase);
      return toolResult(pullJson(ctx, repo, pull));
    }
    case 'merge_pull_request': {
      requireArgs(args, ['owner', 'repo', 'pull_number']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) throw Object.assign(new Error('Pull request not found'), { code: -32602 });
      if (pull.state === 'closed') throw Object.assign(new Error('Pull request is already closed'), { code: -32602 });
      if (pullIsConflicted(store, repo, pull)) throw Object.assign(new Error('Merge conflict'), { code: -32602 });
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
      const sha = commitOnBranch(store, repo, pull.baseRef, message, squashChanges(store, repo, pull));
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.trialNowIso;
      pull.mergeCommitSha = sha;
      return toolResult({ number: pull.number, merged: true, sha, message: 'Pull request successfully merged', state: 'closed', merge_commit_sha: sha });
    }
    case 'get_issue': {
      requireArgs(args, ['owner', 'repo', 'issue_number']);
      const repo = getRepoOrThrow(store, args.owner, args.repo);
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) throw Object.assign(new Error('Issue not found'), { code: -32602 });
      return toolResult(issueJson(ctx, repo, issue));
    }
    case 'list_repos': {
      return toolResult(store.listRepos().map((r) => repoJson(ctx, r)));
    }
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
  }
}

// The file changes a squash merge applies (same rule as GraphQL).
function squashChanges(store: Store, repo: Repo, pull: import('./store.ts').Pull): Map<string, Buffer | null> {
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

export function handleMcp(ctx: RestContext, rawBody: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof (params.protocolVersion as string) === 'string' ? (params.protocolVersion as string) : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = callTool(ctx, name, args);
      return { status: 200, body: rpcResult(id, result) };
    } catch (err) {
      const code = (err as { code?: number }).code ?? -32602;
      const message = (err as Error).message;
      if (code === -32601 || code === -32602) {
        return { status: 200, body: rpcError(id, code, message) };
      }
      return { status: 200, body: rpcResult(id, toolError(message)) };
    }
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
