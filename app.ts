// The starter's HTTP surface, exactly as it ships: a health probe and an API root, and a JSON 404
// for everything else. The contest's real surface — git smart HTTP, REST v3 resources, GraphQL v4 and
// the MCP endpoint — is what you add (README.md names it, and the rules link below says what scores).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore } from './store.ts';
import { body, isAuthorized, rest } from './rest.ts';
import { graphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitHandler } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

async function readRequest(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', `F${store.nextRequest++}`);
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://entry');
    const send = (status: number, value: unknown, headers: Readonly<Record<string, string>> = {}) => {
      const text = `${JSON.stringify(value)}\n`;
      res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': `F${store.nextRequest++}`, ...headers });
      res.end(text);
    };
    if (method === 'GET' && path === '/healthz') { send(200, { ok: true }); return; }
    if (!isAuthorized(req, store)) { send(401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="Git Forge"' }); return; }
    try {
      if (path.startsWith('/api/v3') && await rest(store, req, res, url)) return;
      if (path === '/api/graphql' && method === 'POST') { send(200, graphql(store, JSON.stringify(await body(req)))); return; }
      if (path === '/mcp' && method === 'POST') {
        let message: any; try { message = await body(req); } catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        const answer = handleMcp(store, message); if (!answer) { res.writeHead(202, { 'x-github-request-id': `F${store.nextRequest++}` }); res.end(); return; } send(200, answer); return;
      }
      const gm = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
      if (gm) { const payload = method === 'POST' ? await readRequest(req) : Buffer.alloc(0); const g = gitHandler(store, gm[1], gm[2], gm[3], method, payload, url.search.slice(1), String(req.headers['git-protocol']||'')); res.writeHead(g.status, g.headers); res.end(g.body); return; }
      send(404, { message: 'Not Found' });
    } catch { if (!res.headersSent) send(400, { message: 'Bad Request' }); else res.destroy(); }
  });
}
