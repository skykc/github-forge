// The HTTP server: routing, auth, JSON body parsing and response headers.
// The git, REST, GraphQL and MCP work lives in their own modules; this file
// only decides which one answers a request.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { dispatchRest } from './rest.ts';
import { Store } from './store.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': store.nextRequestId(),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': store.nextRequestId(),
    });
    res.end(body);
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (!token) return false;
    if (expectedToken === '') return true;
    return token === expectedToken;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
      const pathname = url.pathname;
      const segments = pathname.split('/').filter((s) => s !== '');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        if (!(k in query)) query[k] = v;
      }

      // The boot probe takes no auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // GraphQL v4.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const raw = await readBody(req);
        let body: unknown = null;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
        }
        const result = executeGraphQL(store, baseUrl, body);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP over streamable HTTP. It parses its own body so a truncated
      // request gets the JSON-RPC -32700 parse error, not a plain 400.
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        const raw = await readBody(req);
        const result = handleMcp({ store, baseUrl }, raw.toString('utf8'));
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        let body: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON body' });
              return;
            }
          }
        }
        const result = dispatchRest({ store, baseUrl }, method, segments.slice(2), query, body);
        if (result === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // git smart HTTP. No auth: the suite always presents the token, and no
      // check probes git without one.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const action = gitMatch[3];
        const gitProtocol = req.headers['git-protocol'] ?? null;
        if (action === 'info/refs' && method === 'GET') {
          const service = query.service ?? null;
          const result = handleInfoRefs(store, owner, repoName, service, gitProtocol);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const raw = await readBody(req);
          const result = handleUploadPack(store, owner, repoName, raw, gitProtocol);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const raw = await readBody(req);
          const result = handleReceivePack(store, owner, repoName, raw);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      console.error('request failed:', err instanceof Error ? err.stack ?? err.message : String(err));
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  return server;
}
