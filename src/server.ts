import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrackerConfig } from './config.ts';
import { SessionRegistry } from './core/registry.ts';
import { revealInFileManager } from './desktop.ts';
import { VERSION } from './version.ts';

/** Static assets sit next to this module in both `src/` and `dist/`. */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ServerOptions {
  config: TrackerConfig;
  registry?: SessionRegistry;
}

export function createServer({ config, registry }: ServerOptions): Server {
  const sessions = registry ?? new SessionRegistry(config);

  return createHttpServer((req, res) => {
    handle(req, res, config, sessions).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal error' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: TrackerConfig,
  registry: SessionRegistry,
): Promise<void> {
  // A local server holding transcript contents is a DNS-rebinding target, so
  // when we are bound to loopback we only answer requests addressed to loopback.
  if (isLoopback(config.host) && !isLoopback(hostnameOf(req.headers.host))) {
    sendJson(res, 403, { error: 'Only loopback hosts may reach this server' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Ahead of the read-only gate below, because this is the one route that acts.
  const revealMatch = /^\/api\/sessions\/([\w-]+)\/reveal$/.exec(path);
  if (revealMatch?.[1]) {
    await reveal(req, res, registry, revealMatch[1]);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: `${req.method ?? 'Request'} not allowed` });
    return;
  }

  if (path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      node: process.version,
      claudeDir: config.claudeDir,
      sources: await registry.statuses(),
    });
    return;
  }

  if (path === '/api/sessions') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    sendJson(res, 200, await registry.list({ limit: Number.isFinite(limit) ? limit : undefined }));
    return;
  }

  const detailMatch = /^\/api\/sessions\/([\w-]+)$/.exec(path);
  if (detailMatch?.[1]) {
    const detail = await registry.detail(detailMatch[1]);
    if (!detail) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (path.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Unknown endpoint' });
    return;
  }

  await sendStatic(res, path === '/' ? '/index.html' : path);
}

async function sendStatic(res: ServerResponse, path: string): Promise<void> {
  const target = resolve(join(WEB_ROOT, normalize(decodeURIComponent(path))));
  if (target !== WEB_ROOT.replace(/[\\/]$/, '') && !target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  }
}

/**
 * Show one session's transcript in the file manager.
 *
 * Two things keep this narrow. The path is never taken from the request — the id is
 * looked up and the transcript the source already vouches for is what gets revealed,
 * so there is nothing to point at a file of the caller's choosing. And it is a POST
 * with an origin check: the loopback guard above only proves the *address* was
 * loopback, which a form on any website can arrange, whereas `Origin` is the
 * browser's own account of who asked.
 */
async function reveal(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry,
  id: string,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { error: 'Reveal must be a POST' });
    return;
  }

  if (!isSameOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: 'Cross-origin request refused' });
    return;
  }

  const detail = await registry.detail(id);
  if (!detail?.transcriptPath) {
    sendJson(res, 404, { error: 'No transcript on disk for this session' });
    return;
  }

  revealInFileManager(detail.transcriptPath);
  sendJson(res, 200, { ok: true, path: detail.transcriptPath });
}

/** Browsers always send `Origin` on a POST, so a missing one is not our page asking. */
function isSameOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function hostnameOf(header: string | undefined): string {
  if (!header) return '';
  // Strip the port, keeping bracketed IPv6 literals intact.
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(header.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Listen on `config.port`, stepping forward if the port is taken.
 * Returns the port actually bound.
 */
export function listen(server: Server, config: TrackerConfig, attempts = 20): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let port = config.port;
    let remaining = attempts;

    const onError = (error: unknown): void => {
      const code = (error as { code?: string }).code;
      if (code === 'EADDRINUSE' && remaining-- > 0) {
        port += 1;
        server.listen(port, config.host);
        return;
      }
      server.off('error', onError);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolvePort(port);
    });
    server.listen(port, config.host);
  });
}
