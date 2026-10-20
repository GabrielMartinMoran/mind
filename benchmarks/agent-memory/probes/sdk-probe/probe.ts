#!/usr/bin/env bun
/**
 * T1 probe: in-process @opencode/sdk driver feasibility.
 *
 * Creates an embedded OpenCode host (no listener), opens a session in a temp
 * workspace, sends one minimal prompt, and prints assistant metadata
 * (modelID, providerID, cost, tokens). Auth/config come from the isolated
 * environment (isolated HOME and XDG dirs plus OPENCODE_API_KEY), same as CLI.
 *
 * There is no separate package here: `@opencode/sdk` comes from the harness
 * subproject, so run it as `bun run probes/sdk-probe/probe.ts` from
 * `benchmarks/agent-memory` (or via `bun run` from that directory).
 */
import { OpenCode } from '@opencode/sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const result: Record<string, unknown> = {
  driver: 'sdk-in-process',
  created: false,
  promptSent: false,
  assistant: null,
  error: null,
  pass: false,
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

try {
  const workspace = mkdtempSync(join(tmpdir(), 'sdk-probe-ws-'));
  await using opencode = await OpenCode.create();
  result.created = true;

  const session = await opencode.sessions.create({
    location: { directory: workspace },
    model: { id: process.env.PROBE_MODEL_ID ?? 'deepseek-v4.1-flash', providerID: 'opencode-go' },
  });
  (result as any).sessionID = session.id;

  const promptResult = await opencode.sessions.prompt({
    sessionID: session.id,
    text: 'Reply with exactly: PROBE-OK',
  });
  result.promptSent = true;
  (result as any).promptRaw = promptResult ?? null;

  // Wait for the turn to settle (best-effort), then read the transcript.
  try {
    await withTimeout(opencode.sessions.wait({ sessionID: session.id }), 60000, 'wait');
  } catch (e: any) {
    (result as any).waitError = String(e?.message ?? e).slice(0, 300);
  }
  const messages: any = await opencode.message.list({ sessionID: session.id });
  const list = messages?.data ?? messages;
  const assistant = Array.isArray(list) ? list.find((m: any) => m?.type === 'assistant') : null;
  if (assistant) {
    (result as any).assistant = {
      model: assistant.model,
      cost: assistant.cost,
      tokens: assistant.tokens,
      finish: assistant.finish ?? null,
      error: assistant.error ?? null,
      text: (assistant.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text)
        .join(''),
    };
  }

  const a = (result as any).assistant;
  result.pass = !!(a && a.model && !a.error && (a.cost !== undefined || a.tokens));
} catch (e: any) {
  result.error = String(e?.message ?? e).slice(0, 1000);
}

console.log(JSON.stringify(result, null, 2));
if (process.env.SDK_PROBE_OUT) {
  await Bun.write(process.env.SDK_PROBE_OUT, JSON.stringify(result, null, 2));
}
process.exit(result.pass ? 0 : 1);
