// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and squash merges. All on the shared store;
// git object work (trees, commits, diffs) lives in gitobj.ts.
import {
  buildCommit,
  buildTreeFromFiles,
  displayMessage,
  flattenTree,
  lineDiffCounts,
  parseCommit,
  parseTree,
  peelToCommit,
  findMergeBase,
} from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  VIEWER,
  commentGlobalId,
  hashObject,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Comment,
  type GitObject,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({
  status,
  body,
  headers,
});
const notFound = (message = 'Not Found'): RestResponse => json(404, { message });
const unprocessable = (message: string): RestResponse => json(422, { message });
const conflict = (message: string): RestResponse => json(409, { message });

// ------------------------------------------------------------------ helpers

function gitIdent(store: Store): string {
  return `${VIEWER.login} <${VIEWER.email}> ${store.trialNowSec} +0000`;
}

function baseUrlOf(ctx: RestContext): string {
  return ctx.baseUrl;
}

export interface RestContext {
  store: Store;
  baseUrl: string;
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, node_id: Buffer.from(`U:${repo.owner}`).toString('base64'), type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: ctx.store.trialNowIso,
    updated_at: ctx.store.trialNowIso,
    pushed_at: ctx.store.trialNowIso,
    homepage: null,
    language: null,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    url: `${base}/api/v3/repos/${repo.fullName}`,
    forks_url: `${base}/api/v3/repos/${repo.fullName}/forks`,
    keys_url: `${base}/api/v3/repos/${repo.fullName}/keys{/key_id}`,
    collaborators_url: `${base}/api/v3/repos/${repo.fullName}/collaborators{/collaborator}`,
    teams_url: `${base}/api/v3/repos/${repo.fullName}/teams`,
    hooks_url: `${base}/api/v3/repos/${repo.fullName}/hooks`,
    issue_events_url: `${base}/api/v3/repos/${repo.fullName}/issues/events{/number}`,
    events_url: `${base}/api/v3/repos/${repo.fullName}/events`,
    assignees_url: `${base}/api/v3/repos/${repo.fullName}/assignees{/user}`,
    branches_url: `${base}/api/v3/repos/${repo.fullName}/branches{/branch}`,
    tags_url: `${base}/api/v3/repos/${repo.fullName}/tags`,
    blobs_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs{/sha}`,
    git_tags_url: `${base}/api/v3/repos/${repo.fullName}/git/tags{/sha}`,
    git_refs_url: `${base}/api/v3/repos/${repo.fullName}/git/refs{/sha}`,
    trees_url: `${base}/api/v3/repos/${repo.fullName}/git/trees{/sha}`,
    statuses_url: `${base}/api/v3/repos/${repo.fullName}/statuses/{sha}`,
    languages_url: `${base}/api/v3/repos/${repo.fullName}/languages`,
    stargazers_url: `${base}/api/v3/repos/${repo.fullName}/stargazers`,
    subscribers_url: `${base}/api/v3/repos/${repo.fullName}/subscribers`,
    subscription_url: `${base}/api/v3/repos/${repo.fullName}/subscription`,
    issues_url: `${base}/api/v3/repos/${repo.fullName}/issues{/number}`,
    pulls_url: `${base}/api/v3/repos/${repo.fullName}/pulls{/number}`,
    merges_url: `${base}/api/v3/repos/${repo.fullName}/merges`,
    compare_url: `${base}/api/v3/repos/${repo.fullName}/compare/{base}...{head}`,
    milestones_url: `${base}/api/v3/repos/${repo.fullName}/milestones{/number}`,
    notifications_url: `${base}/api/v3/repos/${repo.fullName}/notifications{?since,all,participating}`,
    labels_url: `${base}/api/v3/repos/${repo.fullName}/labels{/name}`,
    releases_url: `${base}/api/v3/repos/${repo.fullName}/releases{/id}`,
    deployments_url: `${base}/api/v3/repos/${repo.fullName}/deployments`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
  };
}

export function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: null, default: false, url: `${base}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(l.name)}` })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: ctx.store.trialNowIso,
    updated_at: ctx.store.trialNowIso,
    closed_at: issue.state === 'closed' ? ctx.store.trialNowIso : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.fullName}`,
    labels_url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    timeline_url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/timeline`,
    reactions: { url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    state_reason: null,
    draft: false,
    pull_request: undefined,
  };
}

function commentJson(ctx: RestContext, repo: Repo, issueNumber: number, c: Comment): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  return {
    id: c.id,
    node_id: commentGlobalId(repo.owner, repo.name, issueNumber, c.id),
    body: c.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: ctx.store.trialNowIso,
    updated_at: ctx.store.trialNowIso,
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${c.id}`,
    url: `${base}/api/v3/repos/${repo.fullName}/issues/${issueNumber}/comments/${c.id}`,
    issue_url: `${base}/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
    author_association: 'OWNER',
    reactions: { url: `${base}/api/v3/repos/${repo.fullName}/issues/comments/${c.id}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
  };
}

/** True when a pull request's head and base conflict on a file changed by both. */
export function pullIsConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  const baseFiles = pull.mergeBaseSha ? treeFiles(repo, pull.mergeBaseSha) : new Map();
  const headFiles = treeFiles(repo, pull.headSha);
  const curBaseFiles = treeFiles(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha);
  for (const [path, headFile] of headFiles) {
    const baseFile = baseFiles.get(path);
    if ((baseFile?.oid ?? null) === (headFile?.oid ?? null)) continue; // unchanged on head
    const curFile = curBaseFiles.get(path);
    if ((curFile?.oid ?? null) !== (baseFile?.oid ?? null) && (curFile?.oid ?? null) !== (headFile?.oid ?? null)) {
      return true;
    }
  }
  for (const [path, baseFile] of baseFiles) {
    if (headFiles.has(path)) continue; // deleted on head
    const curFile = curBaseFiles.get(path);
    if ((curFile?.oid ?? null) !== (baseFile?.oid ?? null)) return true; // deleted on head, changed on base
  }
  return false;
}

export function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  const mergeable = pull.state === 'open' ? !pullIsConflicted(ctx.store, repo, pull) : false;
  return {
    id: repo.databaseId * 100000 + pull.number,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: ctx.store.trialNowIso,
    updated_at: ctx.store.trialNowIso,
    closed_at: pull.state === 'closed' ? ctx.store.trialNowIso : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoJson(ctx, repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoJson(ctx, repo) },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    issue_url: `${base}/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    statuses_url: `${base}/api/v3/repos/${repo.fullName}/commits/${pull.headSha}/statuses`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    commits_url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `${base}/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `${base}/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments`,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: VIEWER.login, email: VIEWER.email, date: '' };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function commitJson(ctx: RestContext, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const base = baseUrlOf(ctx);
  return {
    sha: oid,
    node_id: Buffer.from(`C:${oid}`).toString('base64'),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: displayMessage(info.message),
      tree: { sha: info.tree, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${info.tree}` },
      url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${base}/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
    comments_url: `${base}/api/v3/repos/${repo.fullName}/commits/${oid}/comments`,
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p, url: `${base}/api/v3/repos/${repo.fullName}/commits/${p}`, html_url: `https://github.com/${repo.fullName}/commit/${p}` })),
  };
}

/** Resolve a ref name, full ref, or commit sha to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
  if (direct) return peelToCommit(repo.objects, direct);
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  if (obj && obj.type === 'tag') return peelToCommit(repo.objects, ref);
  return null;
}

/** The flat file map of a commit's tree (empty when the commit is missing). */
export function treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(obj.data).tree);
}

/**
 * Commit a set of file changes (Buffer = write, null = delete) on a branch,
 * creating the branch from the default tip when it does not exist yet.
 * Returns the new commit oid.
 */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  changes: Map<string, Buffer | null>,
): string {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const files = tip ? treeFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const newFiles = new Map<string, { oid: string; mode: string }>();
  for (const [path, file] of files) newFiles.set(path, { ...file });
  for (const [path, data] of changes) {
    if (data === null) {
      newFiles.delete(path);
    } else {
      const blobOid = hashObject('blob', data);
      if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data });
      newFiles.set(path, { oid: blobOid, mode: '100644' });
    }
  }
  const treeObjects = new Map<string, GitObject>();
  const rootTree = buildTreeFromFiles(newFiles, treeObjects);
  for (const [oid, obj] of treeObjects) repo.objects.set(oid, obj);
  const ident = gitIdent(store);
  const commitData = buildCommit(rootTree, tip ? [tip] : [], ident, ident, message);
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** Newest-first commit walk from a tip (parents in order). */
function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commitOid = peelToCommit(repo.objects, oid);
    if (!commitOid) continue;
    out.push(commitOid);
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

function pageLink(ctx: RestContext, path: string, query: Record<string, string>, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const params = new URLSearchParams({ ...query, per_page: String(perPage), page: String(page + 1) });
  const first = new URLSearchParams({ ...query, per_page: String(perPage), page: '1' });
  const last = new URLSearchParams({ ...query, per_page: String(perPage), page: String(lastPage) });
  const links: string[] = [`<${ctx.baseUrl}${path}?${params}>; rel="next"`];
  if (page > 1) {
    const prev = new URLSearchParams({ ...query, per_page: String(perPage), page: String(page - 1) });
    links.push(`<${ctx.baseUrl}${path}?${prev}>; rel="prev"`);
  }
  links.push(`<${ctx.baseUrl}${path}?${first}>; rel="first"`);
  links.push(`<${ctx.baseUrl}${path}?${last}>; rel="last"`);
  return links.join(', ');
}

function paginate<T>(items: T[], query: Record<string, string>): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.page ?? '1') || 1);
  return { page: items.slice((pageNum - 1) * perPage, pageNum * perPage), perPage, pageNum };
}

function getRepoOr404(ctx: RestContext, owner: string, name: string): Repo | RestResponse {
  const repo = ctx.store.getRepo(owner, name);
  return repo ?? notFound('Repository not found');
}

function isRepo(r: Repo | RestResponse): r is Repo {
  return (r as Repo).objects !== undefined;
}

// ------------------------------------------------------------------- routing

export function dispatchRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: Record<string, string>,
  body: unknown,
): RestResponse | null {
  const store = ctx.store;
  const b = body as Record<string, unknown> | null;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return json(405, { message: 'Method Not Allowed' });
    return json(
      200,
      {
        current_user_url: `${ctx.baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: `${ctx.baseUrl}/api/v3/authorizations`,
        code_search_url: `${ctx.baseUrl}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${ctx.baseUrl}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${ctx.baseUrl}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        user_url: `${ctx.baseUrl}/api/v3/users/{user}`,
        user_search_url: `${ctx.baseUrl}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
        meta_url: `${ctx.baseUrl}/api/v3/meta`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return json(405, { message: 'Method Not Allowed' });
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return json(405, { message: 'Method Not Allowed' });
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: Buffer.from(`U:${VIEWER.login}`).toString('base64'),
      avatar_url: '',
      gravatar_id: '',
      url: `${ctx.baseUrl}/api/v3/users/${VIEWER.login}`,
      html_url: `https://github.com/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
      name: VIEWER.name,
      company: null,
      blog: '',
      location: null,
      email: VIEWER.email,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: store.repos.size,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: store.trialNowIso,
      updated_at: store.trialNowIso,
    });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST' && segments.length === 2) {
      const name = typeof b?.name === 'string' ? b.name : '';
      if (!name) return unprocessable('name is required');
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof b?.description === 'string' ? b.description : '',
        b?.private === true,
        typeof b?.default_branch === 'string' ? b.default_branch : DEFAULT_BRANCH,
      );
      if (!repo) return unprocessable('Repository already exists');
      return json(201, repoJson(ctx, repo));
    }
    if (method === 'GET' && segments.length === 2) {
      const all = store.listRepos();
      const { page, perPage, pageNum } = paginate(all, query);
      const link = pageLink(ctx, '/api/v3/user/repos', query, pageNum, perPage, all.length);
      return json(200, page.map((r) => repoJson(ctx, r)), link ? { Link: link } : undefined);
    }
    return null;
  }

  if (segments[0] !== 'repos' || segments.length < 3) return null;
  const owner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      return json(200, repoJson(ctx, repo));
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      if (typeof b?.description === 'string') repo.description = b.description;
      if (typeof b?.private === 'boolean') repo.private = b.private;
      if (typeof b?.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
      return json(200, repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      store.repos.delete(store.key(owner, repoName));
      return json(204, null);
    }
    return null;
  }

  const repo = getRepoOr404(ctx, owner, repoName);
  if (!isRepo(repo)) return repo;

  // Branches.
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
      return json(200, branches);
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) return notFound('Branch not found');
      return json(200, { name: rest[1], commit: { sha }, protected: false });
    }
    return null;
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof b?.ref === 'string' ? b.ref : '';
      const sha = typeof b?.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/heads/') || !sha) return unprocessable('ref and sha are required');
      const branch = ref.slice('refs/heads/'.length);
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      const commit = peelToCommit(repo.objects, sha);
      if (!commit) return unprocessable('sha does not point at a commit in this repository');
      repo.refs.set(ref, sha);
      return json(201, {
        ref,
        node_id: Buffer.from(`R:${ref}`).toString('base64'),
        url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
      });
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${rest[3]}`);
      if (!sha) return notFound('Reference not found');
      return json(200, {
        ref: `refs/heads/${rest[3]}`,
        node_id: Buffer.from(`R:refs/heads/${rest[3]}`).toString('base64'),
        url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/git/refs/heads/${rest[3]}`,
        object: { sha, type: 'commit', url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
      });
    }
    return null;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.sha ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) return notFound('Commit not found');
    const commits = listCommits(repo, tip);
    return json(200, commits.map((oid) => commitJson(ctx, repo, oid)).filter(Boolean));
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(ctx, repo, method, path, query, b);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: null, default: false, url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(l.name)}` })));
    }
    if (method === 'POST' && rest.length === 1) {
      const name = typeof b?.name === 'string' ? b.name : '';
      const color = typeof b?.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('Label already exists');
      const label: Label = { name, color };
      repo.labels.set(name, label);
      return json(201, { name, color, description: null, default: false, url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}` });
    }
    return null;
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof b?.title === 'string' ? b.title : '';
        if (!title) return unprocessable('title is required');
        const rawLabels = Array.isArray(b?.labels) ? b.labels : [];
        const labels: Label[] = [];
        for (const raw of rawLabels) {
          const labelName = typeof raw === 'string' ? raw : typeof raw?.name === 'string' ? raw.name : '';
          const label = repo.labels.get(labelName);
          if (!label) return unprocessable(`Label does not exist: ${labelName}`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, typeof b?.body === 'string' ? b.body : '', labels);
        return json(201, issueJson(ctx, repo, issue));
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        const direction = query.direction ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, perPage, pageNum } = paginate(issues, query);
        const link = pageLink(ctx, `/api/v3/repos/${repo.fullName}/issues`, query, pageNum, perPage, issues.length);
        return json(200, page.map((i) => issueJson(ctx, repo, i)), link ? { Link: link } : undefined);
      }
      return null;
    }
    const issueNumber = Number(rest[1]);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) return null;
    const issue = repo.issues.find((i) => i.number === issueNumber);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!issue) return notFound('Issue not found');
        return json(200, issueJson(ctx, repo, issue));
      }
      if (method === 'PATCH') {
        if (!issue) return notFound('Issue not found');
        if (typeof b?.title === 'string') issue.title = b.title;
        if (typeof b?.body === 'string') issue.body = b.body;
        if (b?.state === 'open' || b?.state === 'closed') issue.state = b.state;
        return json(200, issueJson(ctx, repo, issue));
      }
      return null;
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound('Issue not found');
      if (method === 'POST' && rest.length === 3) {
        const bodyText = typeof b?.body === 'string' ? b.body : '';
        if (!bodyText) return unprocessable('body is required');
        const c = store.createComment(repo, issueNumber, bodyText);
        return json(201, commentJson(ctx, repo, issueNumber, c));
      }
      if (method === 'GET' && rest.length === 3) {
        const list = repo.comments.get(issueNumber) ?? [];
        return json(200, list.map((c) => commentJson(ctx, repo, issueNumber, c)));
      }
      return null;
    }
    return null;
  }

  // Pulls.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof b?.title === 'string' ? b.title : '';
        const head = typeof b?.head === 'string' ? b.head : '';
        const base = typeof b?.base === 'string' ? b.base : '';
        if (!title || !head || !base) return unprocessable('title, head and base are required');
        const headSha = resolveRef(repo, head);
        const baseSha = resolveRef(repo, base);
        if (!headSha) return unprocessable('head branch not found');
        if (!baseSha) return unprocessable('base branch not found');
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) return unprocessable('A pull request already exists for this head branch');
        const mergeBase = findMergeBase(repo.objects, headSha, baseSha);
        const pull = store.createPull(repo, title, typeof b?.body === 'string' ? b.body : '', head, base, headSha, baseSha, mergeBase);
        return json(201, pullJson(ctx, repo, pull));
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page } = paginate(pulls, query);
        return json(200, page.map((p) => pullJson(ctx, repo, p)));
      }
      return null;
    }
    const pullNumber = Number(rest[1]);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) return null;
    const pull = repo.pulls.find((p) => p.number === pullNumber);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!pull) return notFound('Pull request not found');
        return json(200, pullJson(ctx, repo, pull));
      }
      return null;
    }
    if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
      if (!pull) return notFound('Pull request not found');
      return json(200, pullFiles(ctx, repo, pull));
    }
    if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
      if (!pull) return notFound('Pull request not found');
      if (pull.state === 'closed') return json(405, { message: 'Pull request is already merged' });
      if (pullIsConflicted(store, repo, pull)) return json(405, { message: 'Merge conflict' });
      const sha = squashMerge(store, repo, pull);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.trialNowIso;
      pull.mergeCommitSha = sha;
      return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
    }
    return null;
  }

  return null;
}

// ----------------------------------------------------------------- contents

function handleContents(
  ctx: RestContext,
  repo: Repo,
  method: string,
  path: string,
  query: Record<string, string>,
  b: Record<string, unknown> | null,
): RestResponse {
  const store = ctx.store;
  const base = ctx.baseUrl;
  const branch = typeof b?.branch === 'string' && b.branch ? b.branch : (query.ref ?? repo.defaultBranch);
  const tip = resolveRef(repo, branch);

  if (method === 'GET') {
    if (!tip) return notFound('Not Found');
    const files = treeFiles(repo, tip);
    if (path === '') {
      // Root listing.
      const entries = dirEntries(ctx, repo, tip, '');
      return json(200, entries);
    }
    const file = files.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return notFound('Not Found');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        content: blob.data.toString('base64'),
        sha: file.oid,
        url: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`,
        git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${file.oid}`,
        html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
        download_url: null,
        _links: { git: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${file.oid}`, self: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
      });
    }
    // Directory?
    const prefix = `${path}/`;
    let isDir = false;
    for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
    if (!isDir) return notFound('Not Found');
    return json(200, dirEntries(ctx, repo, tip, path));
  }

  if (method === 'PUT') {
    const message = typeof b?.message === 'string' ? b.message : '';
    const contentB64 = typeof b?.content === 'string' ? b.content : '';
    if (!message || !contentB64) return unprocessable('message and content are required');
    let data: Buffer;
    try {
      data = Buffer.from(contentB64, 'base64');
    } catch {
      return json(400, { message: 'content is not valid base64' });
    }
    const files = tip ? treeFiles(repo, tip) : new Map();
    const existing = files.get(path);
    const sha = typeof b?.sha === 'string' ? b.sha : '';
    if (existing) {
      if (!sha) return unprocessable('sha is required to update a file');
      if (sha !== existing.oid) return conflict('sha does not match the current file');
    }
    const changes = new Map<string, Buffer | null>([[path, data]]);
    const commitOid = commitOnBranch(store, repo, branch, message, changes);
    const blobOid = hashObject('blob', data);
    const commit = commitJson(ctx, repo, commitOid);
    const commitView = (commit?.commit ?? {}) as Record<string, unknown>;
    return json(existing ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
        url: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
        git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
        download_url: null,
        type: 'file',
        encoding: 'base64',
        _links: { git: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`, self: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
      },
      commit: { sha: commitOid, message, author: commitView.author ?? null, committer: commitView.committer ?? null, tree: commitView.tree ?? { sha: '' }, parents: (commit?.parents ?? []) as unknown[] },
    });
  }

  if (method === 'DELETE') {
    if (!tip) return notFound('Not Found');
    const files = treeFiles(repo, tip);
    const existing = files.get(path);
    if (!existing) return notFound('Not Found');
    const sha = typeof b?.sha === 'string' ? b.sha : '';
    if (sha && sha !== existing.oid) return conflict('sha does not match the current file');
    const message = typeof b?.message === 'string' ? b.message : 'Delete file';
    const changes = new Map<string, Buffer | null>([[path, null]]);
    const commitOid = commitOnBranch(store, repo, branch, message, changes);
    return json(200, { commit: { sha: commitOid, message } });
  }

  return json(405, { message: 'Method Not Allowed' });
}

function dirEntries(ctx: RestContext, repo: Repo, tip: string, dir: string): Record<string, unknown>[] {
  const base = ctx.baseUrl;
  const files = treeFiles(repo, tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  // The tree oid of each immediate subdirectory, by walking the tip tree.
  const dirOids = new Map<string, string>();
  const walk = (treeOid: string, rel: string) => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode !== '40000') continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      dirOids.set(childRel, e.oid);
      walk(e.oid, childRel);
    }
  };
  const tipObj = repo.objects.get(tip);
  if (tipObj && tipObj.type === 'commit') walk(parseCommit(tipObj.data).tree, '');
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(file.oid);
      seen.set(rest, { type: 'file', oid: file.oid, size: blob ? blob.data.length : 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) {
        const rel = dir === '' ? dirName : `${dir}/${dirName}`;
        seen.set(dirName, { type: 'dir', oid: dirOids.get(rel) ?? '', size: 0 });
      }
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const path = prefix + name;
    out.push({
      type: entry.type,
      size: entry.size,
      name,
      path,
      sha: entry.oid,
      url: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`,
      git_url: entry.type === 'file' ? `${base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}` : `${base}/api/v3/repos/${repo.fullName}/git/trees/${entry.oid}`,
      html_url: `https://github.com/${repo.fullName}/${entry.type === 'file' ? 'blob' : 'tree'}/HEAD/${path}`,
      download_url: entry.type === 'file' ? null : null,
      _links: { git: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`, self: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/HEAD/${path}` },
    });
  }
  return out;
}

// --------------------------------------------------------------------- pulls

function pullFiles(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseFiles = pull.mergeBaseSha ? treeFiles(repo, pull.mergeBaseSha) : new Map();
  const headFiles = treeFiles(repo, pull.headSha);
  const out: Record<string, unknown>[] = [];
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...allPaths].sort()) {
    const baseFile = baseFiles.get(path);
    const headFile = headFiles.get(path);
    if ((baseFile?.oid ?? null) === (headFile?.oid ?? null)) continue;
    const oldData = baseFile ? repo.objects.get(baseFile.oid)?.data ?? null : null;
    const newData = headFile ? repo.objects.get(headFile.oid)?.data ?? null : null;
    const { additions, deletions } = lineDiffCounts(oldData, newData);
    const status = !baseFile ? 'added' : !headFile ? 'removed' : 'modified';
    out.push({
      sha: headFile?.oid ?? baseFile?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.fullName}/blob/${pull.headSha}/${path}`,
      raw_url: `https://github.com/${repo.fullName}/raw/${pull.headSha}/${path}`,
      contents_url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/contents/${path}?ref=${pull.headSha}`,
      patch: null,
    });
  }
  return out;
}

function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const baseFiles = pull.mergeBaseSha ? treeFiles(repo, pull.mergeBaseSha) : new Map();
  const headFiles = treeFiles(repo, pull.headSha);
  const curBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const merged = treeFiles(repo, curBaseTip);
  for (const [path, headFile] of headFiles) {
    const baseFile = baseFiles.get(path);
    if ((baseFile?.oid ?? null) !== (headFile?.oid ?? null)) merged.set(path, { ...headFile });
  }
  for (const [path] of baseFiles) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const changes = new Map<string, Buffer | null>();
  for (const [path, file] of merged) {
    const cur = treeFiles(repo, curBaseTip).get(path);
    if ((cur?.oid ?? null) !== (file?.oid ?? null)) {
      const blob = repo.objects.get(file.oid);
      changes.set(path, blob ? blob.data : null);
    }
  }
  for (const [path] of treeFiles(repo, curBaseTip)) {
    if (!merged.has(path)) changes.set(path, null);
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  return commitOnBranch(store, repo, pull.baseRef, message, changes);
}
