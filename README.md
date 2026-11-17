# github-forge

A GitHub-compatible git forge in one Node 22 process, standard library only:
no dependencies, no git binary, no network beyond the trial env. It serves
git smart HTTP (upload-pack v2 + v0, receive-pack v0), GitHub REST v3, GraphQL
v4, and MCP over streamable HTTP, all on a single in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the lifecycle the harness drives: bind an ephemeral port,
register it at `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`,
exit 0 when the trial is over. The token the env presents is
`$MAKEFUN_SHOP_TOKEN`; `/healthz` takes none.

## Layout

- `main.ts` — lifecycle only (kit starter, kept as-is).
- `app.ts` — HTTP server: routing, auth, JSON body parsing, response headers.
- `store.ts` — the in-memory store: repositories, refs, objects, issues, pull
  requests, labels, comments, and the deterministic id/counter allocation.
- `gitobj.ts` — the git object model: SHA-1 hashing, commit/tree/tag parsing
  and building, pkt-line framing, packfile encode/decode (plain objects and
  OFS/REF deltas), reachability and fast-forward checks.
- `gitproto.ts` — smart HTTP: `info/refs` advertisements (v2 and v0),
  ls-refs, fetch (v2 and v0, with shallow/deepen), and receive-pack with
  per-ref fast-forward reporting.
- `rest.ts` — REST v3: repositories, branches, commits, contents, labels,
  issues, comments, pull requests, files, and squash merges.
- `graphql.ts` — GraphQL v4: a hand-rolled parser and executor for the
  documents `gh` and `github-mcp-server` send, including introspection,
  cursor pagination, and the five mutations.
- `mcp.ts` — MCP over JSON-RPC 2.0 streamable HTTP: `server/discover`,
  `initialize`, `tools/list`, `tools/call` for the eight forge tools.

## Determinism

Nothing the suite can observe carries wall-clock time or randomness. All
timestamps derive from `MAKEFUN_TRIAL_NOW` (or the scenario epoch when it is
unset); request ids are a monotonic counter; ids are assigned in creation
order; object and pack bytes are built in a fixed order.

## Licence

MIT — see `LICENSE`.
