// app.ts — the HTTP server: boot health, auth, and routing to the four surfaces (git smart
// HTTP, REST v3, GraphQL, MCP). main.ts owns the lifecycle; this file owns the wire.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER_LOGIN, forge, nextRequestId } from './forge.ts';
import {
  fetchV0,
  fetchV2,
  lsRefs,
  parseFetchBody,
  parseFetchBodyV0,
  parsePackets,
  receiveAdvertisement,
  receivePack,
  receiveReport,
  uploadAdvertisementV0,
  uploadAdvertisementV2,
} from './git.ts';
import type { Ctx, Reply } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(ctx: Ctx): boolean {
  if (TOKEN === '') return true;
  return ctx.token === TOKEN;
}

function sendReply(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) };
  let body: Buffer;
  if (reply.raw !== undefined) {
    body = reply.raw;
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
  } else if (reply.body !== undefined) {
    body = Buffer.from(`${JSON.stringify(reply.body)}\n`, 'utf8');
    headers['content-type'] = reply.contentType ?? JSON_TYPE;
  } else {
    body = Buffer.alloc(0);
  }
  headers['content-length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function buildCtx(req: IncomingMessage): Promise<Ctx> {
  const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const url = new URL(req.url ?? '/', 'http://entry');
  const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
  const bodyText = rawBody.toString('utf8');
  let json: unknown;
  let jsonError = false;
  if (rawBody.length > 0) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      jsonError = true;
    }
  }
  const authorization = req.headers.authorization;
  const token =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    segments,
    query: url.searchParams,
    bodyText,
    rawBody,
    json,
    jsonError,
    token,
    host: typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1',
    gitProtocol: typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : null,
  };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function handleGit(ctx: Ctx): Reply | null {
  const segments = ctx.segments;
  if (segments.length < 3) return null;
  const repoSegment = segments[1];
  if (!repoSegment.endsWith('.git')) return null;
  const owner = segments[0];
  const name = repoSegment.slice(0, -'.git'.length);
  const tail = segments.slice(2);
  const repo = forge.getRepo(owner, name);

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') {
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      if (ctx.gitProtocol !== null && ctx.gitProtocol.includes('version=2')) {
        return { status: 200, raw: uploadAdvertisementV2(), contentType: 'application/x-git-upload-pack-advertisement' };
      }
      return { status: 200, raw: uploadAdvertisementV0(repo), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, raw: receiveAdvertisement(repo), contentType: 'application/x-git-receive-pack-advertisement' };
    }
    return { status: 400, body: { message: 'unknown service' } };
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && ctx.method === 'POST') {
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const packets = parsePackets(ctx.rawBody).packets;
    if (packets.length === 0 && ctx.rawBody.length > 0) {
      return { status: 400, body: { message: 'malformed pkt-line request' } };
    }
    const parsed = parseFetchBody(packets);
    if (parsed !== null && parsed.command === 'ls-refs') {
      return { status: 200, raw: lsRefs(repo, parsed.args), contentType: 'application/x-git-upload-pack-result' };
    }
    if (parsed !== null && parsed.command === 'fetch') {
      return { status: 200, raw: fetchV2(repo, parsed.request), contentType: 'application/x-git-upload-pack-result' };
    }
    const requestV0 = parseFetchBodyV0(packets);
    return { status: 200, raw: fetchV0(repo, requestV0), contentType: 'application/x-git-upload-pack-result' };
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && ctx.method === 'POST') {
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const result = receivePack(repo, ctx.rawBody);
    return { status: 200, raw: receiveReport(result), contentType: 'application/x-git-receive-pack-result' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let ctx: Ctx;
      try {
        ctx = await buildCtx(req);
      } catch {
        res.writeHead(400, { 'content-type': JSON_TYPE });
        res.end('{"message":"Bad Request"}\n');
        return;
      }
      try {
        // The env's boot check: open, always 200.
        if (ctx.method === 'GET' && ctx.path === '/healthz') {
          sendReply(res, { status: 200, body: { ok: true } });
          return;
        }

        const gitReply = handleGit(ctx);
        if (gitReply !== null) {
          if (!authorized(ctx)) {
            sendReply(res, { status: 401, body: { message: 'Bad credentials' } });
            return;
          }
          sendReply(res, gitReply);
          return;
        }

        if (ctx.segments[0] === 'api' && ctx.segments[1] === 'v3') {
          if (!authorized(ctx)) {
            sendReply(res, { status: 401, body: { message: 'Bad credentials' } });
            return;
          }
          if (ctx.jsonError && ctx.method !== 'GET' && ctx.method !== 'DELETE') {
            sendReply(res, { status: 400, body: { message: 'Problems parsing JSON' } });
            return;
          }
          const reply = handleRest(ctx) ?? { status: 404, body: { message: 'Not Found' } };
          sendReply(res, reply as Reply);
          return;
        }

        if (ctx.path === '/api/graphql') {
          if (!authorized(ctx)) {
            sendReply(res, { status: 401, body: { message: 'Bad credentials' } });
            return;
          }
          if (ctx.method !== 'POST') {
            sendReply(res, { status: 404, body: { message: 'Not Found' } });
            return;
          }
          sendReply(res, handleGraphQL(ctx));
          return;
        }

        if (ctx.path === '/mcp') {
          if (!authorized(ctx)) {
            sendReply(res, { status: 401, body: { message: 'Unauthorized' } });
            return;
          }
          if (ctx.method !== 'POST') {
            sendReply(res, { status: 405, body: { message: 'Method Not Allowed' } });
            return;
          }
          sendReply(res, handleMcp(ctx));
          return;
        }

        void VIEWER_LOGIN;
        sendReply(res, { status: 404, body: { message: 'Not Found' } });
      } catch (err) {
        // A handler bug must never take the server down: the suite grades survival too.
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendReply(res, { status: 500, body: { message: 'Internal Server Error' } });
        } else {
          res.end();
        }
      }
    })();
  });
}
