import * as fs from 'fs';
import * as path from 'path';

import { CONFIG } from '../config';
import type { MindStore } from '../store/mind-store';
import { createSqliteStore } from '../store/sqlite-store';
import { withAutoExport } from '../sync/auto-export-store';

import { matchApiRoute } from './router';

export function getWebRootPath(): string {
  return path.resolve(import.meta.dir, '..', '..', 'web');
}

function resolveStaticFile(pathname: string): Response {
  const webRoot = getWebRootPath();
  const publicDir = path.join(webRoot, 'public');

  if (pathname === '/') {
    return new Response(fs.readFileSync(path.join(publicDir, 'index.html')), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const relativePath = pathname.replace(/^\/+/, '');
  const candidate = path.join(webRoot, relativePath);

  if (!candidate.startsWith(webRoot)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return new Response(fs.readFileSync(path.join(publicDir, 'index.html')), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const ext = path.extname(candidate);
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };

  return new Response(fs.readFileSync(candidate), {
    headers: { 'Content-Type': types[ext] ?? 'application/octet-stream' },
  });
}

export async function handleRequest(req: Request, store: MindStore): Promise<Response> {
  const matched = await matchApiRoute(req, store);
  if (matched) return matched;

  const url = new URL(req.url);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return resolveStaticFile(url.pathname);
}

export async function runApiServer(port?: number, existingStore?: MindStore): Promise<void> {
  const httpPort = port ?? Number(process.env.MIND_PORT ?? CONFIG.defaultPort);
  const idleTimeout = Number(process.env.MIND_API_IDLE_TIMEOUT ?? 30);

  if (!existingStore) {
    if (!fs.existsSync(CONFIG.dataDir)) {
      fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    }
  }

  const store = withAutoExport(existingStore ?? createSqliteStore(CONFIG.dbPath), {
    source: 'api',
  });

  Bun.serve({
    port: httpPort,
    idleTimeout,
    async fetch(req) {
      try {
        return await handleRequest(req, store);
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    },
  });

  console.log(`mind web running at http://localhost:${httpPort}`);
  await new Promise(() => {});
}
