// Extracted from setup.ts - OpenCode prudent automation plugin builder
// This is the embedded JavaScript string for OpenCode's plugin system (V2 default export with V1 server() compatibility)

import { OFFICIAL_SESSION_SUMMARY_SCHEMA } from '../helpers/session-summary';

export function buildOpenCodeAutomationPlugin(mindPath: string): string {
  const resolvedMindPath = JSON.stringify(mindPath);

  // Static reminder for new/post-compacted sessions (~200 chars, action-oriented)
  const RECOVERY_TEXT =
    'Prudent session detected. Call `checkpoint_load` to restore recent work and maintain continuity.';

  return `import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MIND_BIN = ${resolvedMindPath};
const FALLBACK_MIND_BIN = 'mind';
const STATE_VERSION = 1;
const MAX_STATE_KEYS = 400;
const MAX_CONTEXT_CHARS = 1600;
const MAX_NOTES_CHARS = 800;
const MIN_CHECKPOINT_INTERVAL_MS = 90_000;
const MIN_SUMMARY_INTERVAL_MS = 240_000;
const SESSION_SUMMARY_SCHEMA = ${JSON.stringify(OFFICIAL_SESSION_SUMMARY_SCHEMA)};
const RECOVERY_TEXT = ${JSON.stringify(RECOVERY_TEXT)};

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function nowSqlTimestamp() {
  return nowIso().replace('T', ' ').replace('Z', '').split('.')[0];
}

function clampText(value, maxChars) {
  const normalized = String(value ?? '').replace(/[ \\t\\n\\r]+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function sanitizeSegment(value) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || 'unknown';
}

function extractSessionId(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'session-unknown';
  }

  const direct = payload.sessionID ?? payload.sessionId;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct;
  }

  // V2 stream events carry the session id under event.data.sessionID.
  const data = payload.data;
  if (data && typeof data === 'object') {
    const dataId = data.sessionID ?? data.sessionId ?? data.id;
    if (typeof dataId === 'string' && dataId.trim().length > 0) {
      return dataId;
    }
  }

  const legacy = payload.id;
  if (typeof legacy === 'string' && legacy.trim().length > 0) {
    return legacy;
  }

  const nested = payload.session;
  if (nested && typeof nested === 'object') {
    const nestedId = nested.id ?? nested.sessionID ?? nested.sessionId;
    if (typeof nestedId === 'string' && nestedId.trim().length > 0) {
      return nestedId;
    }
  }

  return 'session-unknown';
}

function buildProjectName(ctx) {
  const fromWorktree = typeof ctx?.worktree === 'string' ? basename(ctx.worktree) : '';
  const fromDirectory = typeof ctx?.directory === 'string' ? basename(ctx.directory) : '';
  return sanitizeSegment(fromWorktree || fromDirectory || 'unknown');
}

function getProjectSpace(ctx) {
  return 'projects/' + buildProjectName(ctx);
}

function buildSessionSummaryName(sessionId) {
  return 'session-' + nowIso().replace(/[:.]/g, '-') + '-' + sanitizeSegment(sessionId);
}

function getStatePath() {
  return import.meta.dir + '/.mind-automation-state.json';
}

function loadState() {
  const filePath = getStatePath();
  if (!existsSync(filePath)) {
    return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  }

  const parsed = safeJsonParse(readFileSync(filePath, 'utf-8'), null);
  if (!parsed || typeof parsed !== 'object') {
    return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  }

  return {
    version: STATE_VERSION,
    checkpoints: typeof parsed.checkpoints === 'object' && parsed.checkpoints ? parsed.checkpoints : {},
    summaries: typeof parsed.summaries === 'object' && parsed.summaries ? parsed.summaries : {},
    handled: typeof parsed.handled === 'object' && parsed.handled ? parsed.handled : {},
  };
}

function compactHandledKeys(handled) {
  const keys = Object.keys(handled);
  if (keys.length <= MAX_STATE_KEYS) {
    return handled;
  }

  const sorted = keys
    .map((key) => ({ key, value: Number(handled[key]) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_STATE_KEYS);

  const next = {};
  for (const item of sorted) {
    next[item.key] = item.value;
  }
  return next;
}

function saveState(state) {
  try {
    const filePath = getStatePath();
    mkdirSync(import.meta.dir, { recursive: true });
    const safeState = {
      ...state,
      version: STATE_VERSION,
      handled: compactHandledKeys(state.handled ?? {}),
    };
    writeFileSync(filePath, JSON.stringify(safeState, null, 2));
  } catch {
    // Non-blocking fallback: manual protocol remains available.
  }
}

function hasIntervalPassed(lastByKey, key, minMs) {
  const now = Date.now();
  const previous = Number(lastByKey[key] ?? 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous < minMs) {
    return false;
  }

  lastByKey[key] = now;
  return true;
}

function runMindCommand(args) {
  const baseOptions = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] };
  let result = spawnSync(MIND_BIN, args, baseOptions);
  if (result.status === 0) {
    return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  }

  result = spawnSync(FALLBACK_MIND_BIN, args, baseOptions);
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function ensureSessionScaffold(space, checkpointNotes) {
  runMindCommand(['create', space, 'Managed by OpenCode prudent automation']);
  runMindCommand([
    'checkpoint',
    'set',
    space,
    'Active OpenCode session',
    'Keep the current goal, pending work, and next action explicit',
    '--notes',
    checkpointNotes,
  ]);
}

function buildEventNotes(ctx, payload, extra) {
  const repo = buildProjectName(ctx);
  const sessionId = extractSessionId(payload);
  const sections = [
    'repo=' + repo,
    'session=' + sessionId,
    'event=' + String(payload?.type ?? 'unknown'),
    extra,
    'updated=' + nowIso(),
  ].filter(Boolean);

  return clampText(sections.join(' | '), MAX_NOTES_CHARS);
}

function recoverCheckpointContext(projectSpace) {
  void projectSpace;
  return null;
}

function buildSessionSummaryContent(projectSpace, payload, summary) {
  const timestamp = nowSqlTimestamp();
  return JSON.stringify(
    {
      goal: '',
      pending: '',
      notes: summary,
      createdAt: timestamp,
      updatedAt: timestamp,
      whatWasDone: summary,
      completedAt: timestamp,
      sessionSummary: {
        schema: SESSION_SUMMARY_SCHEMA,
        writer: {
          id: 'opencode_automation_plugin',
        },
        provenance: {
          projectSpace,
          sessionId: extractSessionId(payload),
          eventType: String(payload?.type ?? 'unknown'),
        },
      },
    },
    null,
    2
  );
}

function persistSessionSummary(ctx, payload, summary, state) {
  const projectSpace = getProjectSpace(ctx);
  const sessionId = extractSessionId(payload);
  const dedupeKey = projectSpace + ':' + sessionId;
  if (!hasIntervalPassed(state.summaries, dedupeKey, MIN_SUMMARY_INTERVAL_MS)) {
    return;
  }

  const safeSummary = clampText(summary, MAX_NOTES_CHARS);
  if (!safeSummary) {
    return;
  }

  const memoryName = buildSessionSummaryName(sessionId);
  const memoryContent = buildSessionSummaryContent(projectSpace, payload, safeSummary);
  runMindCommand([
    'add',
    projectSpace,
    memoryName,
    memoryContent,
    '--tags',
    'type:session,cat:summary',
    '--tier',
    '3',
  ]);
}

export const MindAutomationPlugin = async (ctx) => {
  const state = loadState();

  const checkpointForEvent = (eventPayload, extra) => {
    const projectSpace = getProjectSpace(ctx);
    const checkpointKey = projectSpace + ':' + extractSessionId(eventPayload);
    if (!hasIntervalPassed(state.checkpoints, checkpointKey, MIN_CHECKPOINT_INTERVAL_MS)) {
      return;
    }

    const notes = buildEventNotes(ctx, eventPayload, extra);
    ensureSessionScaffold(projectSpace, notes);
  };

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event !== 'object') {
          return;
        }

        if (event.type === 'session.created') {
          checkpointForEvent(event, 'Ensure project space and checkpoint at session start');
          return;
        }

        if (event.type === 'session.compacted') {
          checkpointForEvent(event, 'Post-compaction checkpoint refresh and context recovery');
          recoverCheckpointContext(getProjectSpace(ctx));
          return;
        }

        if (event.type === 'session.deleted') {
          const summary = buildEventNotes(ctx, event, 'Session end summary (prudent)');
          persistSessionSummary(ctx, event, summary, state);
        }
      } catch {
        // Non-blocking fallback: protocol instructions remain available.
      } finally {
        saveState(state);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        const payload = input && typeof input === 'object' ? input : {};
        const eventKey = getProjectSpace(ctx) + ':compacting:' + extractSessionId(payload);
        if (!hasIntervalPassed(state.handled, eventKey, MIN_CHECKPOINT_INTERVAL_MS)) {
          return;
        }

        checkpointForEvent(payload, 'Pre-compaction checkpoint capture and signal preservation');
        const recovered = recoverCheckpointContext(getProjectSpace(ctx));
        const escaped = (recovered ?? '').replace(/\\n/g, '\\n');

        if (Array.isArray(output?.context)) {
          output.context.push(
            '## mind Prudent Continuity',
            '- Before compaction: key context was checkpointed using mind checkpoint set.',
            '- After compaction: use \`checkpoint list <project-space> --status active\` and then \`checkpoint recover <project-space> --name <checkpoint-name>\` if needed.',
            escaped ? '\\nRecovered context snapshot:\\n' + escaped : '\\nRecovered context snapshot unavailable; follow manual mind protocol.'
          );
        }
      } catch {
        // Non-blocking fallback: protocol instructions remain available.
      } finally {
        saveState(state);
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!Array.isArray(output?.system) || output.system.length === 0) {
          return;
        }

        const sessionId = input && typeof input === 'object' ? extractSessionId(input) : 'session-unknown';
        const dedupeKey = getProjectSpace(ctx) + ':chat-transform:' + sessionId;

        if (state.handled[dedupeKey]) {
          return;
        }

        const lastIdx = output.system.length - 1;
        const projectSpace = getProjectSpace(ctx);
        const recovered = recoverCheckpointContext(projectSpace);
        const escaped = (recovered ?? '').replace(/\\n/g, '\\n');

        if (escaped) {
          state.handled[dedupeKey] = Date.now();
          output.system[lastIdx] += '\\n\\n' + escaped;
        } else {
          state.handled[dedupeKey] = Date.now();
          output.system[lastIdx] += '\\n\\n' + RECOVERY_TEXT;
        }
      } catch {
        // Non-blocking fallback: protocol instructions remain available.
      } finally {
        saveState(state);
      }
    },
  };
};

const buildV2Setup = async (ctx) => {
  const baseDirectory =
    ctx && ctx.location && typeof ctx.location.directory === 'string' ? ctx.location.directory : '';
  const baseWorktree =
    ctx && ctx.location && ctx.location.project && typeof ctx.location.project.canonical === 'string'
      ? ctx.location.project.canonical
      : '';
  // V2 ctx.location is the plugin instance location; the event stream can span
  // locations, so prefer each event's own location and fall back to the instance.
  const ctxFor = (payload) => {
    const directory =
      payload && payload.location && typeof payload.location.directory === 'string'
        ? payload.location.directory
        : '';
    return { directory: directory || baseDirectory, worktree: directory || baseWorktree };
  };
  const state = loadState();

  const checkpointForEvent = (eventPayload, extra) => {
    const projectCtx = ctxFor(eventPayload);
    const projectSpace = getProjectSpace(projectCtx);
    const checkpointKey = projectSpace + ':' + extractSessionId(eventPayload);
    if (!hasIntervalPassed(state.checkpoints, checkpointKey, MIN_CHECKPOINT_INTERVAL_MS)) {
      return;
    }

    const notes = buildEventNotes(projectCtx, eventPayload, extra);
    ensureSessionScaffold(projectSpace, notes);
  };

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (!event || typeof event !== 'object') {
            continue;
          }

          if (event.type === 'session.created') {
            checkpointForEvent(event, 'Ensure project space and checkpoint at session start');
          } else if (event.type === 'session.compacted' || event.type === 'session.compaction.ended') {
            checkpointForEvent(event, 'Post-compaction checkpoint refresh and context recovery');
            recoverCheckpointContext(getProjectSpace(ctxFor(event)));
          } else if (event.type === 'session.deleted') {
            const projectCtx = ctxFor(event);
            const summary = buildEventNotes(projectCtx, event, 'Session end summary (prudent)');
            persistSessionSummary(projectCtx, event, summary, state);
          }
        } catch {
          // Non-blocking fallback: protocol instructions remain available.
        } finally {
          saveState(state);
        }
      }
    } catch {
      // Non-blocking fallback: protocol instructions remain available.
    }
  })();

  try {
  await ctx.session.hook('context', (event) => {
    try {
      const projectCtx = ctxFor(event);
      const sessionId = event && typeof event === 'object' ? extractSessionId(event) : 'session-unknown';
      const dedupeKey = getProjectSpace(projectCtx) + ':chat-transform:' + sessionId;

      if (state.handled[dedupeKey]) {
        return;
      }

      const recovered = recoverCheckpointContext(getProjectSpace(projectCtx));
      const text = recovered && recovered.length > 0 ? recovered : RECOVERY_TEXT;

      if (event && Array.isArray(event.system)) {
        event.system.push({ type: 'text', text });
        state.handled[dedupeKey] = Date.now();
      }
    } catch {
      // Non-blocking fallback: protocol instructions remain available.
    } finally {
      saveState(state);
    }
  });

  await ctx.session.hook('compaction', async (event) => {
    try {
      const payload = event && typeof event === 'object' ? event : {};
      const projectCtx = ctxFor(payload);
      const eventKey = getProjectSpace(projectCtx) + ':compacting:' + extractSessionId(payload);
      if (!hasIntervalPassed(state.handled, eventKey, MIN_CHECKPOINT_INTERVAL_MS)) {
        return;
      }

      checkpointForEvent(payload, 'Pre-compaction checkpoint capture and signal preservation');
      const recovered = recoverCheckpointContext(getProjectSpace(projectCtx));
      const text = [
        '## mind Prudent Continuity',
        '- Before compaction: key context was checkpointed using mind checkpoint set.',
        '- After compaction: use \`checkpoint list <project-space> --status active\` and then \`checkpoint recover <project-space> --name <checkpoint-name>\` if needed.',
        recovered && recovered.length > 0
          ? '\\nRecovered context snapshot:\\n' + recovered
          : '\\nRecovered context snapshot unavailable; follow manual mind protocol.',
      ].join('\\n');

      if (event && Array.isArray(event.system)) {
        event.system.push({ type: 'text', text });
      }
    } catch {
      // Non-blocking fallback: protocol instructions remain available.
    } finally {
      saveState(state);
    }
  });
  } catch {
    // If hook registration fails, stop the event subscription so nothing leaks.
    controller.abort();
  }

  return () => controller.abort();
};

// V2 plugin definition. OpenCode V2 reads the default export's id and setup();
// V1 reads server() and ignores the V2 fields.
export default {
  id: 'mind-automation',
  setup: buildV2Setup,
  server: MindAutomationPlugin,
};
`;
}
