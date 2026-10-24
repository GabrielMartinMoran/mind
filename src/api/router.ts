import { createLogEntry } from '../helpers/logger';
import type { MindStore } from '../store/mind-store';

import { logRoutes } from './routes/logs';
import { memoryRoutes } from './routes/memories';
import { searchRoutes } from './routes/search';
import { spaceRoutes } from './routes/spaces';
import { statusRoutes } from './routes/status';
import { tagRoutes } from './routes/tags';
import type { RouteContext, RouteDefinition } from './routes/types';

const ALL_ROUTES: RouteDefinition[] = [
  ...spaceRoutes,
  ...tagRoutes,
  ...memoryRoutes,
  ...searchRoutes,
  ...statusRoutes,
  ...logRoutes,
];

export async function matchApiRoute(req: Request, store: MindStore): Promise<Response | null> {
  const url = new URL(req.url);
  const logEntry = createLogEntry(store);

  // Skip logging for health checks
  const isHealthCheck = url.pathname === '/health' || url.pathname === '/api/health';
  const isLogsRead =
    req.method === 'GET' && (url.pathname === '/api/logs' || url.pathname === '/api/logs/');
  const shouldLog = !isHealthCheck && !isLogsRead;

  const json = (data: unknown, status = 200): Response => Response.json(data, { status });
  const err = (msg: string, status = 400): Response => Response.json({ error: msg }, { status });
  const parseBody = async <T>(request: Request): Promise<T> => request.json() as Promise<T>;

  // Determine operation name from route
  const routeMatch = ALL_ROUTES.find(
    route => route.method === req.method && route.match(url.pathname)
  );
  const operation = routeMatch
    ? `${routeMatch.method.toLowerCase()}_${url.pathname.replace(/\//g, '_').replace(/^_/, '')}`
    : url.pathname;

  const startTime = Date.now();
  let logLevel: 'info' | 'warn' | 'error' = 'info';
  let errorMessage: string | undefined;
  let outputData: Record<string, unknown> | undefined;

  // Extract caller info from request
  const callerInfo: Record<string, unknown> = {
    ip:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      'unknown',
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    sessionId: req.headers.get('x-session-id') ?? undefined,
  };

  for (const route of ALL_ROUTES) {
    if (route.method !== req.method) continue;
    const params = route.match(url.pathname);
    if (!params) continue;

    const ctx: RouteContext = {
      req,
      url,
      store,
      params,
      json,
      err,
      parseBody,
    };

    try {
      const response = await route.handle(ctx);

      // Extract response body for logging (clone the response to read it)
      if (shouldLog) {
        try {
          const clone = response.clone();
          const jsonData = await clone.json().catch(() => ({ status: response.status }));
          outputData = jsonData as Record<string, unknown>;
        } catch {
          outputData = { status: response.status };
        }
      }

      return response;
    } catch (error: any) {
      logLevel = 'error';
      errorMessage = error.message;
      throw error;
    } finally {
      if (shouldLog) {
        const durationMs = Date.now() - startTime;
        logEntry({
          source: 'api',
          operation,
          level: logLevel,
          inputData: {
            method: req.method,
            pathname: url.pathname,
            params: Object.keys(params).length > 0 ? params : undefined,
          },
          outputData,
          errorMessage,
          durationMs,
          callerInfo,
        });
      }
    }
  }

  return null;
}
