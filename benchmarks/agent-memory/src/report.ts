// REPORT.md generator.
//
// Turns a run directory (its `meta.json`, the aggregate `summary.json` and the
// per-item result files) into a single deterministic `REPORT.md` with the
// user-mandated sections, in order, plus explicit conclusions. It only ever
// reads result artifacts: it never runs a probe, never invents numbers, and it
// refuses to emit anything that looks like a credential or a user home path.
//
// When a stage did not run (for example an A1-only validation run), the report
// states that plainly (`not_run` / `n/a`) instead of guessing.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { A2QuestionResult } from './benchmarkA/judge';
import type { ScenarioConditionResult } from './benchmarkB/runner';
import { CONDITIONS, PINNED_VERSIONS, type ConditionId } from './config';
import { LOCOMO_CATEGORIES, categoryName } from './locomo/types';
import {
  loadRunSummary,
  renderSummaryTable,
  writeRunSummary,
  type RunSummary,
} from './metrics/aggregate';

// ── Secret scanning ──────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'home path', re: /\/(?:home|Users)\/[^\s/]+/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: 'openrouter-style key', re: /\bsk-or-[A-Za-z0-9_-]{8,}/ },
  { name: 'api key assignment', re: /\bapi[_-]?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{12,}/ },
  { name: 'credential env assignment', re: /\b(?:OPENCODE|OPENROUTER)_API_KEY\b\s*[:=]/ },
];

export class SecretLeakError extends Error {
  constructor(public readonly findings: readonly string[]) {
    super(`refusing to write report: possible secret(s) found: ${findings.join(', ')}`);
    this.name = 'SecretLeakError';
  }
}

/** Throw when the text looks like it contains a credential or a home path. */
export function assertNoSecrets(text: string): void {
  const findings = SECRET_PATTERNS.filter(pattern => pattern.re.test(text)).map(p => p.name);
  if (findings.length > 0) throw new SecretLeakError(findings);
}

// ── Small formatting helpers ─────────────────────────────────────────────────

function fmt(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

function fmtSigned(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
}

function fmtPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | undefined): string {
  return value === undefined ? 'n/a' : String(value);
}

// ── Artifact loading ─────────────────────────────────────────────────────────

function readA2Results(runDir: string): Partial<Record<ConditionId, A2QuestionResult[]>> {
  const out: Partial<Record<ConditionId, A2QuestionResult[]>> = {};
  for (const condition of CONDITIONS) {
    const path = join(runDir, 'results', `a2-${condition}.json`);
    if (existsSync(path))
      out[condition] = JSON.parse(readFileSync(path, 'utf8')) as A2QuestionResult[];
  }
  return out;
}

function readScenarioResults(
  runDir: string
): Partial<Record<ConditionId, ScenarioConditionResult[]>> {
  const out: Partial<Record<ConditionId, ScenarioConditionResult[]>> = {};
  for (const condition of CONDITIONS) {
    const path = join(runDir, 'results', `scenarios-${condition}.json`);
    if (existsSync(path)) {
      out[condition] = JSON.parse(readFileSync(path, 'utf8')) as ScenarioConditionResult[];
    }
  }
  return out;
}

function readJudgeQueue(runDir: string): string[] {
  const path = join(runDir, 'results', 'judge-manual-queue.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as string[];
  } catch {
    return [];
  }
}

export interface IsolationEvidenceSummary {
  /** Relative path of an `isolation-evidence/` directory that contains dumps. */
  readonly path: string;
  /** Non-empty lines in `summary.txt` (one per fail-closed check). */
  readonly checks: number;
  /** Number of dump files (every file except `summary.txt`). */
  readonly dumpFiles: number;
  /** Total files in the directory (`dumpFiles` + `summary.txt` when present). */
  readonly fileTotal: number;
}

/** Find every persisted isolation-evidence dir under the paid-stage trees. */
function collectIsolationEvidence(runDir: string): IsolationEvidenceSummary[] {
  const found: IsolationEvidenceSummary[] = [];
  const roots = ['a2', 'scenarios'].map(name => join(runDir, name));
  const walk = (dir: string, relative: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const child = join(dir, name);
      const relChild = relative ? `${relative}/${name}` : name;
      if (name === 'isolation-evidence') {
        const summaryPath = join(child, 'summary.txt');
        const checks = existsSync(summaryPath)
          ? readFileSync(summaryPath, 'utf8')
              .split('\n')
              .filter(line => line.trim() !== '').length
          : 0;
        let fileTotal = 0;
        let dumpFiles = 0;
        try {
          for (const entry of readdirSync(child, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            fileTotal += 1;
            if (entry.name !== 'summary.txt') dumpFiles += 1;
          }
        } catch {
          // Unreadable directory: leave the counts at zero.
        }
        found.push({ path: relChild, checks, dumpFiles, fileTotal });
        continue;
      }
      walk(child, relChild, depth + 1);
    }
  };
  for (const root of roots) walk(root, root.replace(`${runDir}/`, ''), 0);
  return found;
}

// ── Candidate collection (sections 8/9) ──────────────────────────────────────

const SUCCESS_CLASSES = new Set(['correct', 'correct_abstention']);

interface ExampleCandidate {
  readonly kind: 'A2' | 'B';
  readonly id: string;
  readonly noMemory: string;
  readonly mindV9: string;
  readonly mindV10: string;
}

function a2Examples(a2: Partial<Record<ConditionId, A2QuestionResult[]>>): ExampleCandidate[] {
  const byId = new Map<string, Partial<Record<ConditionId, A2QuestionResult>>>();
  for (const [condition, results] of Object.entries(a2)) {
    for (const result of results ?? []) {
      const entry = byId.get(result.id) ?? {};
      entry[condition as ConditionId] = result;
      byId.set(result.id, entry);
    }
  }
  const out: ExampleCandidate[] = [];
  for (const [id, entry] of [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const klass = (c: ConditionId) => entry[c]?.deterministic.klass;
    out.push({
      kind: 'A2',
      id,
      noMemory: klass('no-memory') ?? 'not_run',
      mindV9: klass('mind-v9') ?? 'not_run',
      mindV10: klass('mind-v10') ?? 'not_run',
    });
  }
  return out;
}

function bExamples(b: Partial<Record<ConditionId, ScenarioConditionResult[]>>): ExampleCandidate[] {
  const byId = new Map<string, Partial<Record<ConditionId, string>>>();
  for (const [condition, results] of Object.entries(b)) {
    for (const result of results ?? []) {
      const entry = byId.get(result.scenarioId) ?? {};
      entry[condition as ConditionId] =
        result.status === 'not_run'
          ? `not_run${result.notRunReason ? ` (${result.notRunReason})` : ''}`
          : result.assertion.pass
            ? 'pass'
            : 'fail';
      byId.set(result.scenarioId, entry);
    }
  }
  const out: ExampleCandidate[] = [];
  for (const [id, entry] of [...byId.entries()].sort((a, b2) => a[0].localeCompare(b2[0]))) {
    const label = (c: ConditionId) => entry[c] ?? 'not_run';
    out.push({
      kind: 'B',
      id,
      noMemory: label('no-memory'),
      mindV9: label('mind-v9'),
      mindV10: label('mind-v10'),
    });
  }
  return out;
}

function isHelp(candidate: ExampleCandidate): boolean {
  if (candidate.kind === 'A2') {
    const baseline = !SUCCESS_CLASSES.has(candidate.noMemory);
    const anyMind = SUCCESS_CLASSES.has(candidate.mindV9) || SUCCESS_CLASSES.has(candidate.mindV10);
    return baseline && anyMind;
  }
  return (
    candidate.noMemory === 'fail' && (candidate.mindV9 === 'pass' || candidate.mindV10 === 'pass')
  );
}

function isHurt(candidate: ExampleCandidate): boolean {
  if (candidate.kind === 'A2') {
    const baseline = SUCCESS_CLASSES.has(candidate.noMemory);
    const anyMindFail =
      (candidate.mindV9 !== 'not_run' && !SUCCESS_CLASSES.has(candidate.mindV9)) ||
      (candidate.mindV10 !== 'not_run' && !SUCCESS_CLASSES.has(candidate.mindV10));
    return baseline && anyMindFail;
  }
  return (
    candidate.noMemory === 'pass' && (candidate.mindV9 === 'fail' || candidate.mindV10 === 'fail')
  );
}

function renderCandidates(candidates: readonly ExampleCandidate[], max = 10): string {
  if (candidates.length === 0) return '_Sin candidatos automáticos en esta corrida._';
  const lines = [
    '| benchmark | id | no-memory | mind-v9 | mind-v10 |',
    '| --- | --- | --- | --- | --- |',
    ...candidates
      .slice(0, max)
      .map(c => `| ${c.kind} | ${c.id} | ${c.noMemory} | ${c.mindV9} | ${c.mindV10} |`),
  ];
  if (candidates.length > max) lines.push(`\n_… y ${candidates.length - max} más._`);
  return lines.join('\n');
}

// ── Sections ─────────────────────────────────────────────────────────────────

function section6(summary: RunSummary): string {
  const diffs = [
    ['A1', summary.diffs.a1],
    ['A2', summary.diffs.a2],
    ['B', summary.diffs.b],
  ] as const;
  const lines = [renderSummaryTable(summary), '', '### Diffs v9 → v10 (absoluto / relativo)', ''];
  for (const [label, rows] of diffs) {
    lines.push(`**${label}**`, '');
    if (rows.length === 0) {
      lines.push('- _not_run_', '');
      continue;
    }
    lines.push('| metric | v9 | v10 | abs | rel |', '| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${row.metric} | ${fmt(row.v9)} | ${fmt(row.v10)} | ${fmtSigned(row.absolute)} | ` +
          `${row.relative === null ? 'n/a' : fmtPct(row.relative)} |`
      );
    }
    lines.push('');
  }
  if (summary.diffs.mindVsNoMemory.length > 0) {
    lines.push('### Mind vs sin memoria', '');
    lines.push('| metric | no-memory | mind-v9 | mind-v10 |', '| --- | --- | --- | --- |');
    for (const row of summary.diffs.mindVsNoMemory) {
      lines.push(
        `| ${row.metric} | ${fmt(row.noMemory)} | ${fmt(row.mindV9)} | ${fmt(row.mindV10)} |`
      );
    }
    lines.push('');
  }
  lines.push(renderA2ByCategory(summary), '');
  lines.push(renderBaselineDeltas(summary));
  return lines.join('\n');
}

function section7(
  summary: RunSummary,
  a2: Partial<Record<ConditionId, A2QuestionResult[]>>,
  b: Partial<Record<ConditionId, ScenarioConditionResult[]>>,
  judgeQueue: readonly string[]
): string {
  const lines: string[] = [];
  lines.push('**Stages fallidos / no ejecutados**', '');
  if (summary.missingStages.length === 0) lines.push('- ninguno');
  for (const stage of summary.missingStages) lines.push(`- \`${stage}\` — not_run`);
  for (const [stage, info] of Object.entries(summary.meta.stages)) {
    if (info.status === 'failed' || info.status === 'blocked' || info.status === 'contaminated') {
      lines.push(`- \`${stage}\` — ${info.status}${info.note ? `: ${info.note}` : ''}`);
    }
  }
  lines.push('', '**Errores por ítem (A2)**', '');
  const a2Errors = Object.entries(a2).flatMap(([condition, results]) =>
    (results ?? [])
      .filter(result => result.error !== null)
      .map(result => `${condition}/${result.id}: ${result.error}`)
  );
  lines.push(a2Errors.length === 0 ? '- ninguno' : a2Errors.map(e => `- ${e}`).join('\n'));

  lines.push('', '**Sesiones B fallidas/contaminadas**', '');
  const bErrors = Object.entries(b).flatMap(([condition, results]) =>
    (results ?? []).flatMap(result =>
      result.sessions
        .filter(session => session.status !== 'ok')
        .map(
          session => `${condition}/${result.scenarioId}#${session.sessionIndex}: ${session.status}`
        )
    )
  );
  lines.push(bErrors.length === 0 ? '- ninguno' : bErrors.map(e => `- ${e}`).join('\n'));

  lines.push('', '**Cola manual del juez (respuestas no parseables)**', '');
  lines.push(judgeQueue.length === 0 ? '- vacía' : judgeQueue.map(id => `- ${id}`).join('\n'));
  return lines.join('\n');
}

function section10(b: Partial<Record<ConditionId, ScenarioConditionResult[]>>): string {
  const lines: string[] = ['**Uso de subagentes capturado**', ''];
  const rows: string[] = [];
  for (const condition of CONDITIONS) {
    const results = b[condition];
    if (!results) {
      rows.push(`| ${condition} | n/a | n/a | n/a |`);
      continue;
    }
    for (const result of results) {
      if (result.childCount === 0) continue;
      const childMem = result.childResults.reduce((total, child) => total + child.memoryCalls, 0);
      rows.push(`| ${condition} | ${result.scenarioId} | ${result.childCount} | ${childMem} |`);
    }
  }
  if (rows.length === 0) {
    lines.push('_Ninguna sesión hija capturada en esta corrida._');
    return lines.join('\n');
  }
  lines.push(
    '| condition | scenario | child sessions | child memory calls |',
    '| --- | --- | --- | --- |'
  );
  lines.push(...rows);
  return lines.join('\n');
}

/**
 * Judge spend recorded by the paid judge stage. The judge stage is the only one
 * that writes its cost into `meta.stages['judge:start'].note` (`"N prompts,
 * $X.XXXX, M manual"`); parse that deterministic note. Returns `null` when the
 * judge did not run or the note carries no amount.
 */
export function judgeCostFromMeta(meta: RunSummary['meta']): number | null {
  const note = meta.stages['judge:start']?.note;
  if (!note) return null;
  const match = note.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function section11(summary: RunSummary): string {
  const lines = [
    '| benchmark | condition | reps | resultado | mem. calls | tokens in | tokens out | cost USD |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const condition of CONDITIONS) {
    const entry = summary.conditions[condition];
    const a2 = entry?.a2;
    lines.push(
      `| A2 | ${condition} | ${num(a2?.reps)} | judge=${fmt(a2?.judgeScoreMean ?? null)} | ` +
        `${num(a2?.memoryCalls)} | ${num(a2?.tokensInput)} | ` +
        `${num(a2?.tokensOutput)} | ${fmt(a2?.costUsd ?? null, 4)} |`
    );
    const b = entry?.b;
    lines.push(
      `| B | ${condition} | n/a | rate=${fmt(b?.taskSuccess.rate ?? null)} | ${num(b?.memoryCalls)} | ` +
        `${num(b?.tokensInput)} | ${num(b?.tokensOutput)} | ${fmt(b?.costUsd ?? null, 4)} |`
    );
  }
  const judgeCost = judgeCostFromMeta(summary.meta);
  const total = summary.meta.budget.spentUsd;
  const cap = summary.meta.budget.maxCostUsd;
  lines.push(
    '',
    `- **Juez (LLM ciego):** ${judgeCost === null ? 'n/a' : `$${judgeCost.toFixed(4)}`} \`[MEDIDO]\``,
    `- **Gasto total de la corrida:** $${total.toFixed(4)}` +
      `${cap !== null ? ` de $${cap.toFixed(2)} de tope` : ''} \`[MEDIDO]\``
  );
  return lines.join('\n');
}

// Truly run-independent limitations: they hold for any report regardless of how
// much of the protocol ran. Anything that depends on the actual run (subset
// size, repetitions, executed vs missing conditions/stages) is stated as a fact
// below, never as a hardcoded "pilot / full run pending" claim.
const STATIC_LIMITATIONS = [
  'Una sola corrida/sesión por informe: los números provienen de una única pasada de medición (un solo conjunto de repeticiones); no se estima la varianza entre corridas.',
  'El juez usa la misma familia de modelo que el agente medido (sesgo de auto-preferencia posible); se reporta junto al scoring determinista, nunca en su lugar.',
  'Matiz v9↔v10: el `memory_query` con `search` de v9 usa una cascada FTS5→LIKE→embeddings y el de v10 el pipeline multicanal con fusión; es la comparación pedida, no una simple diferencia de schema.',
  'LoCoMo no tiene categoría de "conocimiento actualizado"; se documenta como hueco del dataset y se cubre con escenarios propios cuando la etapa B se ejecuta.',
  'Los tokens de contexto de A1 son una estimación `ceil(chars/4)` (sin tokenizer), reportada como tal.',
  'La temperatura pedida al proveedor puede no ser respetada; se registra pedida vs efectiva cuando está disponible.',
];

/** Distinct A2 repetition counts observed across the conditions that ran. */
function a2RepCounts(summary: RunSummary): number[] {
  const reps = new Set<number>();
  for (const entry of Object.values(summary.conditions)) {
    if (entry.a2) reps.add(entry.a2.reps);
  }
  return [...reps].sort((a, b) => a - b);
}

/** A2 conditions that ran, and those absent from this run (in dataset order). */
function a2ConditionSplit(summary: RunSummary): {
  ran: ConditionId[];
  notRun: ConditionId[];
} {
  const ran: ConditionId[] = [];
  const notRun: ConditionId[] = [];
  for (const condition of CONDITIONS) {
    if (summary.conditions[condition]?.a2) ran.push(condition);
    else notRun.push(condition);
  }
  return { ran, notRun };
}

/** Data-driven scope facts: what this run actually measured vs what did not run. */
function describeRunScope(summary: RunSummary): string[] {
  const facts: string[] = [];
  const meta = summary.meta;
  const reps = a2RepCounts(summary);
  const { ran, notRun } = a2ConditionSplit(summary);
  facts.push(
    `Subconjunto medido: \`${meta.subset.conversation}\` con ${meta.subset.count} preguntas ` +
      `(seed ${meta.subset.seed})` +
      (reps.length > 0 ? `; ${reps.join('/')} rep(s) por (condición, pregunta).` : '.')
  );
  if (ran.length > 0) {
    facts.push(`Condiciones con A2 ejecutado: ${ran.map(c => `\`${c}\``).join(', ')}.`);
  }
  if (notRun.length > 0) {
    facts.push(
      `Condiciones sin A2 en esta corrida (\`not_run\`): ${notRun.map(c => `\`${c}\``).join(', ')}.`
    );
  }
  if (summary.missingStages.length > 0) {
    facts.push(`Etapas no ejecutadas: ${summary.missingStages.join(', ')}.`);
  }
  const versions = meta.versions;
  if (versions.opencode === null || versions.sdk === null) {
    facts.push(
      'Versiones de OpenCode/SDK no registradas en `meta.json` (la corrida no ejecutó prompts pagos).'
    );
  }
  if (meta.budget.spentUsd === 0) {
    facts.push('Gasto registrado $0.00 (sólo etapas gratuitas).');
  }
  return facts;
}

/**
 * One-sentence, fact-driven scope statement for §1. It names the measured
 * subset size and repetition count and lists any stages that did not run, so a
 * full run is never described as a pending pilot.
 */
function scopeStatement(summary: RunSummary): string {
  const meta = summary.meta;
  const reps = a2RepCounts(summary);
  const repText = reps.length > 0 ? `, ${reps.join('/')} rep(s) por (condición, pregunta)` : '';
  const stages =
    summary.missingStages.length > 0
      ? ` Etapas no ejecutadas: ${summary.missingStages.join(', ')}.`
      : '';
  return (
    `Corrida determinista de una sola sesión sobre el subconjunto ` +
    `\`${meta.subset.conversation}\` (${meta.subset.count} preguntas, seed ${meta.subset.seed})` +
    `${repText}.${stages} Los resultados son indicativos de esta corrida.`
  );
}

function section12(summary: RunSummary): string {
  const lines = ['**Lista documentada (estática)**', ''];
  for (const item of STATIC_LIMITATIONS) lines.push(`- ${item}`);
  lines.push('', '**Hechos específicos de esta corrida**', '');
  const facts = describeRunScope(summary);
  lines.push(facts.length === 0 ? '- ninguno' : facts.map(f => `- ${f}`).join('\n'));
  return lines.join('\n');
}

function section13(summary: RunSummary): string {
  const lines: string[] = [];
  const a1 = summary.diffs.a1;
  const hit5 = a1.find(row => row.metric === 'hitAt5');
  const mrr = a1.find(row => row.metric === 'mrr');
  if (hit5 && hit5.absolute !== null) {
    lines.push(
      `- A1 hit@5: ${fmt(hit5.v9)} → ${fmt(hit5.v10)} (${fmtSigned(hit5.absolute)}); ` +
        `${hit5.absolute > 0 ? 'el pipeline de v10 recupera más evidencia' : hit5.absolute < 0 ? 'v10 recuperó menos evidencia que v9' : 'sin cambio'}.`
    );
  }
  if (mrr && mrr.absolute !== null && mrr.absolute !== 0) {
    lines.push(
      `- A1 MRR cambió ${fmtSigned(mrr.absolute)}; revisar el ranking del canal principal.`
    );
  }
  const a2Judge = summary.diffs.a2.find(row => row.metric === 'judgeScoreMean');
  if (a2Judge && a2Judge.absolute !== null && a2Judge.absolute !== 0) {
    lines.push(
      `- A2 judge score: ${fmt(a2Judge.v9)} → ${fmt(a2Judge.v10)} (${fmtSigned(a2Judge.absolute)}).`
    );
  }
  lines.push(
    summary.missingStages.length === 0
      ? '- Revisión cualitativa de esta corrida; ver secciones 7–9 (errores y ejemplos).'
      : `- _Revisión cualitativa pendiente_ para las etapas no ejecutadas (${summary.missingStages.join(', ')}); ver secciones 7–9.`
  );
  return lines.join('\n');
}

const CONCLUSION_QUESTIONS = [
  '¿Mejora v10 respecto de v9?',
  '¿Aporta Mind frente a no usar memoria?',
  '¿Qué funciona y qué falla?',
  '¿Vale el costo y la complejidad?',
];

/**
 * Conclusion #1 lines. When both v9 and v10 ran the comparison is stated; when
 * only one side (or only the baseline) ran, the text says plainly that the
 * v9↔v10 comparison is absent and names the conditions that WERE measured —
 * it never claims "A1/A2 no ejecutado" when the stage actually ran.
 */
function conclusionComparisonLines(summary: RunSummary): string[] {
  const lines: string[] = [];

  const a1v9 = summary.conditions['mind-v9']?.a1;
  const a1v10 = summary.conditions['mind-v10']?.a1;
  if (a1v9 && a1v10) {
    lines.push(
      `- A1 hit@5: v9=${fmt(a1v9.cat1To4.hitAt5)} vs v10=${fmt(a1v10.cat1To4.hitAt5)}; ` +
        `MRR v9=${fmt(a1v9.cat1To4.mrr)} vs v10=${fmt(a1v10.cat1To4.mrr)}.`
    );
  } else if (a1v9 || a1v10) {
    const measured = a1v10
      ? `\`mind-v10\` hit@5=${fmt(a1v10.cat1To4.hitAt5)}, MRR=${fmt(a1v10.cat1To4.mrr)}`
      : `\`mind-v9\` hit@5=${fmt(a1v9!.cat1To4.hitAt5)}, MRR=${fmt(a1v9!.cat1To4.mrr)}`;
    const missing = a1v10 ? 'v9' : 'v10';
    lines.push(
      `- A1: comparación v9↔v10 no disponible en esta corrida (${missing} no ejecutó A1); ` +
        `condición medida: ${measured}.`
    );
  } else {
    lines.push('- A1 no ejecutado.');
  }

  const a2Diff = summary.diffs.a2.find(row => row.metric === 'judgeScoreMean');
  if (a2Diff && a2Diff.absolute !== null) {
    lines.push(
      `- A2 judge: ${fmt(a2Diff.v9)} → ${fmt(a2Diff.v10)} (${fmtSigned(a2Diff.absolute)}).`
    );
    return lines;
  }
  const { ran } = a2ConditionSplit(summary);
  if (ran.length === 0) {
    lines.push('- A2 no ejecutado (pendiente).');
    return lines;
  }
  const missing = (['mind-v9', 'mind-v10'] as const).filter(condition => !ran.includes(condition));
  const measured = ran
    .map(condition => {
      const a2 = summary.conditions[condition]?.a2;
      return a2 ? `\`${condition}\` judge=${fmt(a2.judgeScoreMean)}, F1=${fmt(a2.f1Mean)}` : null;
    })
    .filter((value): value is string => value !== null)
    .join('; ');
  lines.push(
    `- A2: comparación v9↔v10 no disponible en esta corrida` +
      `${missing.length > 0 ? ` (${missing.join(' y ')} no ejecutó A2)` : ''}; ` +
      `condiciones medidas: ${measured}.`
  );
  return lines;
}

function conclusions(summary: RunSummary): string {
  const lines: string[] = [];
  const lines1 = conclusionComparisonLines(summary);
  lines.push(`### 1. ${CONCLUSION_QUESTIONS[0]}`, '', ...lines1, '');

  const triples = summary.diffs.mindVsNoMemory;
  lines.push(`### 2. ${CONCLUSION_QUESTIONS[1]}`, '');
  if (triples.length === 0) {
    lines.push(
      '- Sin datos comparables (A2/B no ejecutados); **pendiente de revisión cualitativa**.',
      ''
    );
  } else {
    for (const row of triples) {
      lines.push(
        `- ${row.metric}: no-memory=${fmt(row.noMemory)}, v9=${fmt(row.mindV9)}, v10=${fmt(row.mindV10)}.`
      );
    }
    lines.push('');
  }

  lines.push(`### 3. ${CONCLUSION_QUESTIONS[2]}`, '');
  const failures = summary.missingStages.length;
  lines.push(
    `- Etapas faltantes: ${failures === 0 ? 'ninguna' : summary.missingStages.join(', ')}.`,
    '- Detalle de errores en la sección 7.',
    ''
  );

  lines.push(`### 4. ${CONCLUSION_QUESTIONS[3]}`, '');
  const a2Cost = summary.conditions['mind-v10']?.a2?.costUsd;
  const bCost = summary.conditions['mind-v10']?.b?.costUsd;
  lines.push(
    `- Costo registrado: A2 v10=${fmt(a2Cost ?? null, 4)} USD, B v10=${fmt(bCost ?? null, 4)} USD.`,
    '- Relación calidad/costo por resultado: revisión cualitativa de esta única corrida (secciones 7–9); no hay estimación de varianza entre corridas.'
  );
  return lines.join('\n');
}

function unavailable(label: string, runId: string): string {
  return `_${label} no ejecutado en la corrida \`${runId}\` (not_run)._`;
}

// ── Report-style header, protocol and comparison tables ─────────────────────

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

/** Repo-style header metadata block (cf. docs/search-optimization-report.md). */
function renderHeader(summary: RunSummary): string {
  const meta = summary.meta;
  const paid =
    meta.budget.spentUsd > 0 || Object.values(summary.conditions).some(entry => entry.a2 !== null);
  const estado = paid ? 'corrida medida (A1 + A2)' : 'corrida gratuita (A1 / sin prompts pagos)';
  const datasetSubset = `${meta.subset.conversation} · ${meta.subset.count} preguntas · seed ${meta.subset.seed}`;
  const v9Entry = summary.conditions['mind-v9'];
  const v9Ran = Boolean(v9Entry && (v9Entry.a1 || v9Entry.a2 || v9Entry.b));
  const v9Label = v9Ran
    ? `- **SHA v9 (main, ejecutado):** \`${meta.shas.v9 ?? 'n/a'}\``
    : `- **SHA v9 (referencia, no ejecutado en esta corrida):** \`${meta.shas.v9 ?? 'n/a'}\``;
  return [
    '# Informe técnico — Benchmark de memoria para agentes (00008)',
    '',
    `- **Feature:** \`00008-agent-memory-benchmark\``,
    `- **Run ID:** \`${summary.runId}\``,
    `- **Repositorio:** \`benchmarks/agent-memory\``,
    `- **Fecha:** ${formatDate(meta.createdAt)}`,
    `- **Estado:** ${estado}`,
    `- **Runtime:** Bun \`${meta.versions.bun ?? 'n/a'}\` · OpenCode \`${meta.versions.opencode ?? 'n/a'}\` · SDK \`${meta.versions.sdk ?? 'n/a'}\``,
    `- **Proveedor / Modelo:** \`${meta.model.providerID}\` / \`${meta.model.id}\` (variant \`${meta.model.variant ?? 'default'}\`)`,
    `- **Precios:** costos reales por corrida registrados en la sección 11. \`[MEDIDO]\``,
    `- **SHA v10 (develop):** \`${meta.shas.v10 ?? 'n/a'}\``,
    v9Label,
    `- **Dataset:** sha256 \`${meta.dataset.sha256 ?? 'n/a'}\` · subset ${datasetSubset}`,
    `- **Documentos relacionados:** [\`search-optimization-report.md\`](../../docs/search-optimization-report.md) (convenciones de estilo), [\`search-benchmarks.md\`](../../docs/search-benchmarks.md) (metodología), [\`README.md\`](README.md).`,
  ].join('\n');
}

const EVIDENCE_LEGEND = [
  '## Etiquetas de evidencia',
  '',
  'Cada afirmación numérica lleva una etiqueta:',
  '',
  '- `[MEDIDO]` — observado en esta corrida y registrado en un artefacto (`runs/<run-id>/results/**`).',
  '- `[CALCULADO]` — aritmética derivada de valores medidos (deltas, medias, porcentajes).',
  '- `[CÓDIGO]` — hecho verificado leyendo el código del harness o de Mind.',
  '- `[LITERATURA]` — respaldado por documentación previa del repo o fuentes externas.',
  '',
  'Las **conclusiones medidas** se separan explícitamente de las **recomendaciones**:',
  'ningún número fue inventado; donde algo no se pudo medir se declara `n/a` / `not_run`.',
].join('\n');

/** Explicit measured-vs-recommendation and cross-protocol comparability note. */
function renderProtocol(summary: RunSummary): string {
  const meta = summary.meta;
  const conditions = Object.entries(summary.conditions)
    .filter(([, entry]) => entry.a2 !== null)
    .map(([condition, entry]) => `${condition} (${entry.a2!.reps} rep(s))`);
  return [
    '## Protocolo y comparabilidad',
    '',
    '**Protocolo medido** `[CÓDIGO]`',
    '',
    `- Modelo único: \`${meta.model.providerID}/${meta.model.id}\` (mismo para todas las condiciones).`,
    '- Ejecutor: OpenCode real vía su SDK oficial; un proceso aislado por unidad de medida.',
    '- Juez: LLM ciego, mismos candidatos anonimizados y barajados; el mapeo condición→candidato queda fuera del prompt.',
    '- Scoring primario: determinista (token-F1 / abstención adversarial) antes del juez.',
    `- Repeticiones por (condición, pregunta): ${meta.subset.count === 0 ? 'n/a' : 'ver tabla'}; condiciones con A2: ${conditions.length === 0 ? 'n/a' : conditions.join(', ')}.`,
    '- Subset y seed fijados en la cabecera; mismas preguntas para todas las condiciones.',
    '',
    '**Comparabilidad** `[LITERATURA]`',
    '',
    'Los números de este informe corresponden a **este** dataset, modelo, juez y protocolo.',
    '**No deben mezclarse** con cifras publicadas por otros autores (LoCoMo original, otros',
    'harness) salvo que compartan exactamente el mismo subset, modelo, juez y número de',
    'repeticiones. Las comparaciones v9↔v10 y Mind↔sin-memoria son internas a esta corrida.',
    '',
    '**Medido vs recomendación.** Las secciones 6 y 11 son medidas; la sección 13 y las',
    'conclusiones separan hechos medidos de recomendaciones para iteraciones futuras.',
  ].join('\n');
}

function renderA2ByCategory(summary: RunSummary): string {
  const ids: ConditionId[] = [];
  for (const condition of ['no-memory', 'mind-v10', 'mind-v9'] as const) {
    if (summary.conditions[condition]?.a2) ids.push(condition);
  }
  const lines = ['### A2 por categoría `[MEDIDO]`', ''];
  if (ids.length === 0) return `${lines[0]}\n\n_not_run_`;
  lines.push(
    '| categoría | condition | n | correct | partial | incorrect | abst. | halluc. | F1 mean | judge mean |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  );
  for (const category of LOCOMO_CATEGORIES) {
    for (const id of ids) {
      const cat = summary.conditions[id]?.a2?.perCategory[String(category)];
      if (!cat) continue;
      lines.push(
        `| ${categoryName(category)} | ${id} | ${cat.count} | ${cat.classes.correct} | ` +
          `${cat.classes.partial} | ${cat.classes.incorrect} | ${cat.correctAbstentions} | ` +
          `${cat.hallucinations} | ${fmt(cat.f1Mean)} | ${fmt(cat.judgeScoreMean)} |`
      );
    }
  }
  return lines.join('\n');
}

function renderBaselineDeltas(summary: RunSummary): string {
  const rows = summary.diffs.a2Baseline;
  if (rows.length === 0) return '### Delta vs baseline (no-memory) `[CALCULADO]`\n\n_not_run_';
  const lines = [
    '### Delta vs baseline (no-memory) `[CALCULADO]`',
    '',
    '`abs = condición − baseline`; `rel` sólo cuando el baseline es distinto de 0.',
    '',
    '| condition | scope | metric | baseline | valor | abs | rel |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.condition} | ${row.scope} | ${row.metric} | ${fmt(row.baseline)} | ` +
        `${fmt(row.value)} | ${fmtSigned(row.absolute)} | ` +
        `${row.relative === null ? 'n/a' : fmtPct(row.relative)} |`
    );
  }
  return lines.join('\n');
}

/** Per-question appendix: one row per question with the per-condition class mix. */
function renderPerQuestionAppendix(a2: Partial<Record<ConditionId, A2QuestionResult[]>>): string {
  const byId = new Map<string, Partial<Record<ConditionId, A2QuestionResult[]>>>();
  for (const [condition, results] of Object.entries(a2)) {
    for (const result of results ?? []) {
      const entry = byId.get(result.id) ?? {};
      const list = entry[condition as ConditionId] ?? [];
      list.push(result);
      entry[condition as ConditionId] = list;
      byId.set(result.id, entry);
    }
  }
  if (byId.size === 0) return '## Anexo — por pregunta\n\n_not_run_';
  const ids: ConditionId[] = [];
  for (const condition of ['no-memory', 'mind-v10', 'mind-v9'] as const) {
    if (a2[condition]) ids.push(condition);
  }
  const lines = [
    '## Anexo — por pregunta `[MEDIDO]`',
    '',
    'Clases agregadas por pregunta y condición (repeticiones resumidas).',
    '',
    `| pregunta | categoría | ${ids.map(id => `${id} (clase/juez)`).join(' | ')} |`,
    `| --- | --- | ${ids.map(() => '---').join(' | ')} |`,
  ];
  for (const [id, entry] of [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const any = entry[ids[0] as ConditionId]?.[0];
    const cells = ids.map(condition => {
      const list = entry[condition] ?? [];
      if (list.length === 0) return 'not_run';
      const classes = list
        .map(
          result =>
            `${result.deterministic.klass}${result.rep !== undefined ? `#r${result.rep}` : ''}`
        )
        .join(', ');
      const judgeScores = list
        .map(result => result.judge?.score)
        .filter((value): value is number => typeof value === 'number');
      const judgeMean =
        judgeScores.length === 0
          ? 'n/a'
          : (judgeScores.reduce((sum, value) => sum + value, 0) / judgeScores.length).toFixed(3);
      return `${classes} / ${judgeMean}`;
    });
    lines.push(`| ${id} | ${any?.categoryName ?? 'n/a'} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export interface GenerateReportInput {
  readonly runDir: string;
}

export function generateReport(input: GenerateReportInput): string {
  const { runDir } = input;
  const summary = loadRunSummary(runDir);
  const a2 = readA2Results(runDir);
  const b = readScenarioResults(runDir);
  const judgeQueue = readJudgeQueue(runDir);
  const evidence = collectIsolationEvidence(runDir);
  const meta = summary.meta;
  const runId = summary.runId;

  const hasA2 = Object.keys(a2).length > 0;
  const hasB = Object.keys(b).length > 0;

  const isolated = evidence.length
    ? [
        `Se persistieron ${evidence.length} dumps de verificación de aislamiento:`,
        '',
        ...evidence.map(
          e => `- \`${e.path}\` (${e.fileTotal} archivos: ${e.dumpFiles} dumps + \`summary.txt\`)`
        ),
        '',
        'Cada dump corresponde a un gate fail-closed (`paths`, `config`, `mcp`, `sessions`,',
        '`agents/skills/commands/plugins`) antes de enviar cualquier prompt pago.',
      ].join('\n')
    : unavailable('Evidencia de aislamiento', runId) +
      '\n\nLas comprobaciones fail-closed (rutas, config efectiva, MCP, sesiones vacías,\nagentes/skills/commands/plugins) se ejecutan antes de cada prompt pago.';

  const candidates = [...a2Examples(a2), ...bExamples(b)];
  const helped = candidates.filter(isHelp);
  const hurt = candidates.filter(isHurt);

  const sections: string[] = [];
  sections.push(renderHeader(summary));
  sections.push(EVIDENCE_LEGEND);
  sections.push(renderProtocol(summary));
  sections.push(
    `Los artefactos de resultados se generan de forma determinista; este informe se deriva de ellos (nunca se inventan números).`
  );

  sections.push(`## 1. Objetivo y metodología`);
  sections.push(
    [
      'Medir si un agente OpenCode real recuerda y usa información — no sólo similitud lexical — con y sin Mind.',
      '',
      'Tres condiciones sobre el mismo modelo, herramientas y prompts: `no-memory` (baseline), `mind-v9` (rama `main`) y `mind-v10` (rama `develop`).',
      'Cada versión de Mind ejecuta su PROPIO código desde un worktree git pinneado.',
      '',
      '- **A — LoCoMo** (`conv-26`): A1 retrieval (sin LLM) sobre un subconjunto determinista sembrado, y A2 answering real con scoring determinista (token-F1 / abstención adversarial) más un juez LLM ciego como medida secundaria.',
      '- **B — escenarios**: tareas chicas con fase de producción y fase de necesidad, evaluadas por aserciones sobre el workspace (nunca por la prosa del agente).',
      '',
      scopeStatement(summary),
    ].join('\n')
  );

  sections.push(`## 2. Herramientas y justificación`);
  sections.push(
    [
      '- **OpenCode real** vía su SDK oficial (agente, herramientas y MCP reales); sin simular decisiones con llamadas directas al LLM. Un proceso aislado por unidad de medida.',
      '- **Mind v9/v10** desde worktrees pinneados: la comparación es de motores reales, no de schemas.',
      '- **LoCoMo** como dataset público de memoria conversacional, descargado en runtime y verificado por sha256 (nunca vendorizado).',
      '- **Scoring determinista primero** (reproducible, sin modelo) y **juez LLM ciego** después (anonimizado y con orden aleatorizado), con cola manual para respuestas no parseables.',
    ].join('\n')
  );

  sections.push(`## 3. Evidencia de aislamiento`);
  sections.push(isolated);

  sections.push(`## 4. Versiones exactas`);
  sections.push(
    [
      '| dato | valor |',
      '| --- | --- |',
      `| run id | \`${runId}\` |`,
      `| v9 (main) SHA | \`${meta.shas.v9 ?? 'n/a'}\` |`,
      `| v10 (develop) SHA | \`${meta.shas.v10 ?? 'n/a'}\` |`,
      `| schema v9 / v10 | ${PINNED_VERSIONS.v9.schemaVersion} / ${PINNED_VERSIONS.v10.schemaVersion} |`,
      `| OpenCode | ${meta.versions.opencode ?? 'n/a'} |`,
      `| SDK | ${meta.versions.sdk ?? 'n/a'} |`,
      `| Bun | ${meta.versions.bun ?? 'n/a'} |`,
      `| modelo | ${meta.model.providerID}/${meta.model.id} (${meta.model.variant ?? 'default'}) |`,
      `| dataset | ${meta.dataset.url} |`,
      `| dataset sha256 | \`${meta.dataset.sha256 ?? 'n/a'}\` |`,
      `| subset | ${meta.subset.conversation} (seed ${meta.subset.seed}, ${meta.subset.count} preguntas) |`,
      '',
      'Nota: los rótulos "v9"/"v10" son los de rama del usuario; el schema real de `main` es 8 y el de `develop` es 10.',
    ].join('\n')
  );

  sections.push(`## 5. Dataset y escenarios`);
  sections.push(
    [
      `**LoCoMo** · conversación \`${meta.subset.conversation}\`, subconjunto determinista sembrado (seed ${meta.subset.seed}, ${meta.subset.count} preguntas).`,
      'Categorías del dataset: 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial (sin respuesta). La categoría "conocimiento actualizado" no existe en LoCoMo.',
      '',
      hasB
        ? '**Escenarios B** ejecutados en esta corrida (detalle en la sección 6).'
        : unavailable('Escenarios B', runId),
    ].join('\n')
  );

  sections.push(`## 6. Resultados comparativos`);
  sections.push(section6(summary));

  sections.push(`## 7. Errores y casos fallidos`);
  sections.push(section7(summary, a2, b, judgeQueue));

  sections.push(`## 8. Ejemplos donde Mind ayudó`);
  sections.push(
    hasA2 || hasB ? renderCandidates(helped) : unavailable('Candidatos (se requiere A2/B)', runId)
  );

  sections.push(`## 9. Ejemplos donde no aportó/perjudicó`);
  sections.push(
    hasA2 || hasB ? renderCandidates(hurt) : unavailable('Candidatos (se requiere A2/B)', runId)
  );

  sections.push(`## 10. Análisis de uso de subagentes`);
  sections.push(hasB ? section10(b) : unavailable('Sesiones de subagente', runId));

  sections.push(`## 11. Calidad vs costo`);
  sections.push(
    hasA2 || hasB
      ? section11(summary)
      : unavailable('Métricas de tokens/costo (se requiere A2/B)', runId)
  );

  sections.push(`## 12. Limitaciones`);
  sections.push(section12(summary));

  sections.push(`## 13. Recomendaciones para Mind`);
  sections.push(section13(summary));

  sections.push(`## Conclusiones`);
  sections.push(conclusions(summary));

  sections.push(renderPerQuestionAppendix(a2));

  const report = `${sections.join('\n\n')}\n`;
  assertNoSecrets(report);
  return report;
}

// ── Curated, committable export ──────────────────────────────────────────────

export interface CuratedPerQuestion {
  readonly id: string;
  readonly category: number;
  readonly categoryName: string;
  readonly adversarial: boolean;
  readonly reference: string | null;
  /**
   * What `reference` means for this item: `"adversarial_answer"` for category-5
   * adversarial items (the dataset ships a plausible distractor answer even
   * though no correct answer exists), `"answer"` otherwise.
   */
  readonly referenceKind: 'adversarial_answer' | 'answer';
  readonly conditions: Record<
    string,
    readonly {
      readonly rep: number;
      readonly class: string;
      readonly f1: number | null;
      readonly judgeScore: number | null;
      readonly memoryCalls: number;
      readonly costUsd: number;
    }[]
  >;
}

export interface CuratedSummary {
  readonly runId: string;
  readonly generatedFrom: 'results';
  readonly meta: RunSummary['meta'];
  readonly conditions: RunSummary['conditions'];
  readonly diffs: RunSummary['diffs'];
  readonly notes: readonly string[];
}

export interface CuratedExport {
  readonly dir: string;
  readonly summaryPath: string;
  readonly perQuestionPath: string;
}

/** Build the small, sanitized per-question view for the curated export. */
export function buildCuratedPerQuestion(
  a2: Partial<Record<ConditionId, A2QuestionResult[]>>
): CuratedPerQuestion[] {
  interface Measurement {
    rep: number;
    class: string;
    f1: number | null;
    judgeScore: number | null;
    memoryCalls: number;
    costUsd: number;
  }
  const byId = new Map<
    string,
    {
      id: string;
      category: number;
      categoryName: string;
      adversarial: boolean;
      reference: string | null;
      referenceKind: 'adversarial_answer' | 'answer';
      conditions: Record<string, Measurement[]>;
    }
  >();
  for (const [condition, results] of Object.entries(a2)) {
    for (const result of results ?? []) {
      const entry = byId.get(result.id) ?? {
        id: result.id,
        category: result.category,
        categoryName: result.categoryName,
        adversarial: result.adversarial,
        reference: result.reference,
        referenceKind: result.adversarial ? ('adversarial_answer' as const) : ('answer' as const),
        conditions: {},
      };
      const list = entry.conditions[condition] ?? [];
      list.push({
        rep: result.rep ?? 0,
        class: result.deterministic.klass,
        f1: result.deterministic.f1,
        judgeScore: result.judge?.score ?? null,
        memoryCalls: result.memoryCalls,
        costUsd: result.costUsd,
      });
      entry.conditions[condition] = list;
      byId.set(result.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Recursively rewrite absolute paths in an export payload so it is committable:
 * the run directory becomes `<run>`, and any remaining `/home/<user>` or
 * `/Users/<user>` prefix becomes `~`. Real secrets are NOT touched here — the
 * secret scan still runs afterwards and remains fail-closed.
 */
export function sanitizeForExport<T>(value: T, runDir: string): T {
  const rewrite = (text: string): string => {
    let out = runDir.length > 0 ? text.split(runDir).join('<run>') : text;
    out = out.replace(/\/(?:home|Users)\/[^\s/]+/g, '~');
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return rewrite(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Write the curated, committable artifacts under `results/<run-id>/` (OUTSIDE
 * the gitignored `runs/` tree): a machine-readable `summary.json` and a small
 * sanitized `per-question.json`. Payloads are path-sanitized first, then
 * secret-scanned (fail-closed for real credentials) before writing.
 */
export function exportCuratedResults(
  runDir: string,
  runId: string,
  exportRoot: string
): CuratedExport {
  const summary = loadRunSummary(runDir);
  const a2 = readA2Results(runDir);
  const dir = join(exportRoot, runId);
  mkdirSync(dir, { recursive: true });

  const curatedSummary: CuratedSummary = {
    runId,
    generatedFrom: 'results',
    meta: summary.meta,
    conditions: summary.conditions,
    diffs: summary.diffs,
    notes: summary.notes,
  };
  const perQuestion = buildCuratedPerQuestion(a2);

  const sanitizedSummary = sanitizeForExport(curatedSummary, runDir);
  const sanitizedPerQuestion = sanitizeForExport(perQuestion, runDir);
  const summaryText = `${JSON.stringify(sanitizedSummary, null, 2)}\n`;
  const perQuestionText = `${JSON.stringify(sanitizedPerQuestion, null, 2)}\n`;
  assertNoSecrets(summaryText);
  assertNoSecrets(perQuestionText);

  const summaryPath = join(dir, 'summary.json');
  const perQuestionPath = join(dir, 'per-question.json');
  writeFileSync(summaryPath, summaryText, 'utf8');
  writeFileSync(perQuestionPath, perQuestionText, 'utf8');
  return { dir, summaryPath, perQuestionPath };
}

export interface ReportCommandOptions {
  readonly runId: string;
  readonly runsRoot: string;
  readonly outPath: string;
}

export interface ReportCommandDeps {
  readonly repoRoot: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export async function runReportCommand(
  options: ReportCommandOptions,
  deps: ReportCommandDeps
): Promise<number> {
  return Promise.resolve(runReport(options, deps));
}

export function runReport(options: ReportCommandOptions, deps: ReportCommandDeps): number {
  const runDir = join(deps.repoRoot, options.runsRoot, options.runId);
  if (!existsSync(join(runDir, 'meta.json'))) {
    deps.stderr(`run '${options.runId}' not found or has no meta.json under ${options.runsRoot}`);
    return 1;
  }
  // Build the report and the curated export first; only write public artifacts
  // once BOTH succeed. A failing export surfaces a clear error + non-zero exit
  // instead of leaving a silently partial result.
  let report: string;
  let curated: ReturnType<typeof exportCuratedResults>;
  try {
    report = generateReport({ runDir });
    // Persist the machine-readable aggregate next to the per-item results.
    writeRunSummary(runDir, loadRunSummary(runDir));
    curated = exportCuratedResults(
      runDir,
      options.runId,
      join(deps.repoRoot, 'benchmarks/agent-memory/results')
    );
  } catch (error) {
    deps.stderr(`report/export failed for run '${options.runId}': ${String(error)}`);
    return 1;
  }
  const outPath = join(deps.repoRoot, options.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');
  deps.stdout(`wrote ${options.outPath} from run ${options.runId}`);
  deps.stdout(`exported ${curated.dir}`);
  return 0;
}

/**
 * Read the generated evidence summary for a paid run (used by tests).
 * Kept exported so the aggregation tests can assert the report path exists.
 */
export { collectIsolationEvidence };
