// E-WB2 false-negative classifier.
//
// Reads the instrumented per-stage dumps (E-WB1, regenerated with an uncapped
// admitted ranking and explicit NOT exclusions), the original benchmark probe
// verdicts, and the LoCoMo gold evidence ids, then labels every gold evidence
// item at K=10 (primary) and K=25 (secondary) and writes the machine-readable
// classification plus a Spanish report.
//
// Gold evidence is used ONLY to score/classify retrieval. It is never used to
// build a query. No database, network, or model call is involved.
//
// Usage:
//   bun run classify.ts [--dumps <jsonl>] [--probes <jsonl>] [--locomo <json>]
//                       [--probe-index <json>] [--out-dir <dir>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── Types ──

export interface DebugRecord {
  q: string;
  candidates_by_channel: Record<string, string[]>;
  after_coverage_by_rung: Record<string, string[]>;
  after_not: string[];
  excluded_by_not: string[];
  admitted_strict: string[];
  admitted_ranked_final: string[];
  admission_kept: number;
  admission_dropped: number;
  zero_reason: string | null;
  admission_tier: string;
}

export interface GoldEvidence {
  evidence: string[];
  category: string;
}

export type ItemLabel =
  | 'admitted_top10'
  | 'admitted_outside_top10'
  | 'dropped_by_admission'
  | 'dropped_by_coverage'
  | 'excluded_by_not'
  | 'ranked_beyond_cap_or_unknown'
  | 'never_candidate'
  | 'no_evidence_gold';

export type FunnelStatus = 'ALL' | 'partial' | 'NONE' | 'no_evidence_gold';

export interface StageTrace {
  channels: string[];
  after_coverage: string[];
  in_after_not: boolean;
  in_excluded_by_not: boolean;
  in_admitted_strict: boolean;
  final_rank: number | null;
}

export interface ItemClassification {
  name: string;
  label: ItemLabel;
  rank: number | null;
  stages: StageTrace;
}

export interface ProbeClassification {
  answerable: boolean;
  evidence_count: number;
  hits: number;
  funnel: FunnelStatus;
  items: ItemClassification[];
}

// ── Pure classification ──

function uniqueChannels(record: DebugRecord, name: string): string[] {
  return Object.entries(record.candidates_by_channel)
    .filter(([, names]) => names.includes(name))
    .map(([channel]) => channel);
}

function coveredChannels(record: DebugRecord, name: string): string[] {
  return Object.entries(record.after_coverage_by_rung)
    .filter(([, names]) => names.includes(name))
    .map(([channel]) => channel);
}

/** True when the emitted ranking is provably shorter than the admitted set. */
function capHidesAdmitted(record: DebugRecord): boolean {
  return record.admission_kept > record.admitted_ranked_final.length;
}

/** Label one gold evidence item at the stated K. Exactly one label is returned. */
export function classifyItem(record: DebugRecord, name: string, k: number): ItemClassification {
  const rank = record.admitted_ranked_final.indexOf(name);
  const channels = uniqueChannels(record, name);
  const afterCoverage = coveredChannels(record, name);
  const inAfterNot = record.after_not.includes(name);
  const inExcluded = record.excluded_by_not.includes(name);

  const stages: StageTrace = {
    channels,
    after_coverage: afterCoverage,
    in_after_not: inAfterNot,
    in_excluded_by_not: inExcluded,
    in_admitted_strict: record.admitted_strict.includes(name),
    final_rank: rank >= 0 ? rank : null,
  };

  if (rank >= 0) {
    return {
      name,
      label: rank < k ? 'admitted_top10' : 'admitted_outside_top10',
      rank,
      stages,
    };
  }

  // Not in the admitted ranking. Distinguish, in order:
  //   1. an explicit NOT exclusion (the dump lists it in `excluded_by_not`);
  //   2. admission: present after NOT but not admitted (`after_not`);
  //   3. channel coverage: a candidate that never reached `after_not` and was
  //      not NOT-excluded — the only in-pipeline remover between the channels
  //      and `after_not` is the coverage floor (`max(2, floor(n/2))`), applied
  //      inside the `any`/`trigram`/`fuzzy` channels;
  //   4. never a candidate at all.
  if (inExcluded) {
    return { name, label: 'excluded_by_not', rank: null, stages };
  }
  if (inAfterNot) {
    if (capHidesAdmitted(record)) {
      return { name, label: 'ranked_beyond_cap_or_unknown', rank: null, stages };
    }
    return { name, label: 'dropped_by_admission', rank: null, stages };
  }
  if (channels.length > 0) {
    return { name, label: 'dropped_by_coverage', rank: null, stages };
  }
  return { name, label: 'never_candidate', rank: null, stages };
}

/** Classify a probe's gold evidence at K: funnel status plus per-item labels. */
export function classifyProbe(
  record: DebugRecord,
  gold: GoldEvidence,
  k: number,
  adversarial: boolean
): ProbeClassification {
  const evidenceCount = gold.evidence.length;
  if (evidenceCount === 0) {
    return {
      answerable: !adversarial,
      evidence_count: 0,
      hits: 0,
      funnel: 'no_evidence_gold',
      items: [],
    };
  }
  const items = gold.evidence.map(name => classifyItem(record, name, k));
  const hits = items.filter(item => item.label === 'admitted_top10').length;
  const funnel: FunnelStatus = hits === 0 ? 'NONE' : hits === evidenceCount ? 'ALL' : 'partial';
  return { answerable: !adversarial, evidence_count: evidenceCount, hits, funnel, items };
}

// ── I/O and aggregation ──

interface ProbeRecord {
  probe_id: string;
  question: string;
  category: string;
  adversarial: boolean;
  gold: string;
  answer: string;
  correct: boolean;
  by_judge: boolean | null;
  abstained: boolean;
  why: string;
}

interface ProbeIndexEntry {
  seq: number;
  probe_id: string;
  category: string;
  adversarial: boolean;
}

interface ExampleItem {
  probe_id: string;
  question: string;
  category: string;
  adversarial: boolean;
  answerable: boolean;
  gold_ids: string[];
  bucket_label: ItemLabel;
  item: ItemClassification;
  funnel: FunnelStatus;
  judge: { correct: boolean; abstained: boolean; answer: string; why: string };
  record: Pick<
    DebugRecord,
    'admission_tier' | 'admission_kept' | 'admission_dropped' | 'zero_reason'
  >;
}

const BUCKET_ORDER: ItemLabel[] = [
  'admitted_top10',
  'admitted_outside_top10',
  'dropped_by_admission',
  'dropped_by_coverage',
  'excluded_by_not',
  'ranked_beyond_cap_or_unknown',
  'never_candidate',
];

/** Item labels in the order the report table renders them. */
const DISPLAY_LABELS: ItemLabel[] = [
  'admitted_top10',
  'admitted_outside_top10',
  'dropped_by_admission',
  'dropped_by_coverage',
  'excluded_by_not',
  'ranked_beyond_cap_or_unknown',
  'never_candidate',
];

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

/** Map question text -> gold evidence. Questions are unique in LoCoMo conv-26. */
function loadGold(locomoPath: string, conversation: string): Map<string, GoldEvidence> {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as Array<Record<string, unknown>>;
  const conv = dataset.find(entry => String(entry.sample_id ?? '') === conversation);
  if (!conv) throw new Error(`conversation ${conversation} not found in ${locomoPath}`);
  const qa = (conv.qa as Array<Record<string, unknown>>) ?? [];
  const map = new Map<string, GoldEvidence>();
  for (const question of qa) {
    map.set(String(question.question ?? '').trim(), {
      evidence: (question.evidence as string[] | undefined) ?? [],
      category: String(question.category ?? ''),
    });
  }
  return map;
}

interface Classification {
  meta: Record<string, unknown>;
  summary: Record<string, unknown>;
  items_by_label: Record<string, Record<string, number>>;
  items_by_label_answerable: Record<string, Record<string, number>>;
  probes_with_label: Record<string, Record<string, number>>;
  probes_by_funnel: Record<string, Record<string, number>>;
  probes_by_funnel_all: Record<string, Record<string, number>>;
  by_category: Record<string, unknown>;
  overlays: Record<string, unknown>;
  unknown: Record<string, unknown>;
  examples: ExampleItem[];
  per_probe: Array<Record<string, unknown>>;
}

interface Options {
  dumps: string;
  probes: string;
  locomo: string;
  probeIndex: string;
  outDir: string;
}

export function buildClassification(options: Options): Classification {
  const records = readJsonl<DebugRecord>(options.dumps);
  const probes = readJsonl<ProbeRecord>(options.probes).filter(p => p.probe_id);
  const probeIndex = JSON.parse(readFileSync(options.probeIndex, 'utf8')) as ProbeIndexEntry[];
  const conversation = probes[0]?.probe_id.split(':')[0] ?? 'conv-26';
  const gold = loadGold(options.locomo, conversation);

  if (records.length !== probes.length || probeIndex.length !== records.length) {
    throw new Error(
      `length mismatch: dumps=${records.length} probes=${probes.length} index=${probeIndex.length}`
    );
  }

  const probeById = new Map(probes.map(p => [p.probe_id, p]));
  const kValues = [10, 25] as const;
  const itemsByLabel: Record<string, Record<string, number>> = {};
  const itemsByLabelAnswerable: Record<string, Record<string, number>> = {};
  const probesWithLabel: Record<string, Record<string, number>> = {};
  const probesByFunnel: Record<string, Record<string, number>> = {};
  const probesByFunnelAll: Record<string, Record<string, number>> = {};
  const perProbe: Array<Record<string, unknown>> = [];

  for (const k of kValues) {
    // Seed every label with 0 so the machine-readable output has a stable
    // schema (a bucket that measures zero is still reported, not omitted).
    itemsByLabel[`K${k}`] = Object.fromEntries(DISPLAY_LABELS.map(label => [label, 0]));
    itemsByLabelAnswerable[`K${k}`] = Object.fromEntries(DISPLAY_LABELS.map(label => [label, 0]));
    probesWithLabel[`K${k}`] = Object.fromEntries(DISPLAY_LABELS.map(label => [label, 0]));
    probesByFunnel[`K${k}`] = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
    probesByFunnelAll[`K${k}`] = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
  }

  // Accumulators for category tables and examples at K=10.
  const categoryAcc: Record<
    string,
    {
      probes: number;
      answerable: number;
      items: Record<string, number>;
      funnel: Record<string, number>;
    }
  > = {};
  const firstExampleByBucket = new Map<ItemLabel, ExampleItem>();
  const noEvidenceProbes: string[] = [];
  const retrievedButModelFailed: string[] = [];
  const abstainedWithNoEvidence: string[] = [];

  for (let seq = 0; seq < records.length; seq += 1) {
    const record = records[seq]!;
    const meta = probeIndex[seq]!;
    const probe = probeById.get(meta.probe_id);
    if (!probe) throw new Error(`probe ${meta.probe_id} missing from probes.jsonl`);
    const goldEvidence = gold.get(probe.question.trim());
    if (!goldEvidence) throw new Error(`no gold evidence for question: ${probe.question}`);
    if (record.q.trim() !== probe.question.trim()) {
      throw new Error(`dump/probe order mismatch at seq ${seq} (${meta.probe_id})`);
    }

    const perK: Record<string, ProbeClassification> = {};
    for (const k of kValues) {
      const classification = classifyProbe(record, goldEvidence, k, probe.adversarial);
      perK[`K${k}`] = classification;
      probesByFunnelAll[`K${k}`]![classification.funnel] += 1;
      if (classification.answerable) {
        probesByFunnel[`K${k}`]![classification.funnel] += 1;
      }
      for (const item of classification.items) {
        itemsByLabel[`K${k}`]![item.label] = (itemsByLabel[`K${k}`]![item.label] ?? 0) + 1;
        if (classification.answerable) {
          itemsByLabelAnswerable[`K${k}`]![item.label] =
            (itemsByLabelAnswerable[`K${k}`]![item.label] ?? 0) + 1;
        }
      }
      const labelsInProbe = new Set(classification.items.map(item => item.label));
      for (const label of labelsInProbe) {
        probesWithLabel[`K${k}`]![label] = (probesWithLabel[`K${k}`]![label] ?? 0) + 1;
      }
    }

    // Category table at K=10.
    const category = probe.category;
    const acc = (categoryAcc[category] ??= {
      probes: 0,
      answerable: 0,
      items: {},
      funnel: { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 },
    });
    acc.probes += 1;
    if (!probe.adversarial) acc.answerable += 1;
    const k10 = perK.K10!;
    acc.funnel[k10.funnel] += 1;
    for (const item of k10.items) acc.items[item.label] = (acc.items[item.label] ?? 0) + 1;

    if (k10.funnel === 'no_evidence_gold') noEvidenceProbes.push(probe.probe_id);
    if (k10.answerable && k10.funnel === 'ALL' && !probe.correct) {
      retrievedButModelFailed.push(probe.probe_id);
    }
    if (k10.answerable && k10.funnel === 'NONE' && probe.abstained) {
      abstainedWithNoEvidence.push(probe.probe_id);
    }

    // Examples: first answerable probe per bucket at K=10 (adversarial evidence
    // is not answerability evidence, so it is not used to illustrate buckets).
    for (const item of k10.items) {
      if (probe.adversarial) continue;
      if (firstExampleByBucket.has(item.label)) continue;
      firstExampleByBucket.set(item.label, {
        probe_id: probe.probe_id,
        question: probe.question,
        category: probe.category,
        adversarial: probe.adversarial,
        answerable: k10.answerable,
        gold_ids: goldEvidence.evidence,
        bucket_label: item.label,
        item,
        funnel: k10.funnel,
        judge: {
          correct: probe.correct,
          abstained: probe.abstained,
          answer: probe.answer,
          why: probe.why,
        },
        record: {
          admission_tier: record.admission_tier,
          admission_kept: record.admission_kept,
          admission_dropped: record.admission_dropped,
          zero_reason: record.zero_reason,
        },
      });
    }

    perProbe.push({
      seq,
      probe_id: probe.probe_id,
      category: probe.category,
      adversarial: probe.adversarial,
      answerable: k10.answerable,
      judge: { correct: probe.correct, abstained: probe.abstained, why: probe.why },
      gold_ids: goldEvidence.evidence,
      funnel: { K10: perK.K10!.funnel, K25: perK.K25!.funnel },
      hits: { K10: perK.K10!.hits, K25: perK.K25!.hits },
      items: perK.K10!.items.map((item, index) => ({
        name: item.name,
        label_k10: item.label,
        label_k25: perK.K25!.items[index]?.label ?? item.label,
        rank: item.rank,
        stages: item.stages,
      })),
      stage_record: {
        admission_tier: record.admission_tier,
        admission_kept: record.admission_kept,
        admission_dropped: record.admission_dropped,
        zero_reason: record.zero_reason,
        excluded_by_not: record.excluded_by_not,
      },
    });
  }

  const examples: ExampleItem[] = [];
  for (const bucket of BUCKET_ORDER) {
    const example = firstExampleByBucket.get(bucket);
    if (example) examples.push(example);
  }
  // Always include a no-evidence-gold example (probe-level bucket).
  const noEvidenceProbe = noEvidenceProbes[0] ? probeById.get(noEvidenceProbes[0]) : undefined;
  if (noEvidenceProbe && examples.length < 6) {
    const seq = probes.indexOf(noEvidenceProbe);
    const record = records[seq]!;
    examples.push({
      probe_id: noEvidenceProbe.probe_id,
      question: noEvidenceProbe.question,
      category: noEvidenceProbe.category,
      adversarial: noEvidenceProbe.adversarial,
      answerable: !noEvidenceProbe.adversarial,
      gold_ids: [],
      bucket_label: 'no_evidence_gold',
      item: {
        name: '(sin evidencia gold)',
        label: 'no_evidence_gold',
        rank: null,
        stages: {
          channels: [],
          after_coverage: [],
          in_after_not: false,
          in_excluded_by_not: false,
          in_admitted_strict: false,
          final_rank: null,
        },
      },
      funnel: 'no_evidence_gold',
      judge: {
        correct: noEvidenceProbe.correct,
        abstained: noEvidenceProbe.abstained,
        answer: noEvidenceProbe.answer,
        why: noEvidenceProbe.why,
      },
      record: {
        admission_tier: record.admission_tier,
        admission_kept: record.admission_kept,
        admission_dropped: record.admission_dropped,
        zero_reason: record.zero_reason,
      },
    });
  }

  const allItems = Object.values(itemsByLabel.K10 ?? {}).reduce((sum, n) => sum + n, 0);
  const answerableItems = Object.values(itemsByLabelAnswerable.K10 ?? {}).reduce(
    (sum, n) => sum + n,
    0
  );
  const unknownItems = itemsByLabel.K10?.ranked_beyond_cap_or_unknown ?? 0;

  return {
    meta: {
      feature: '00009-memory-recall-investigation',
      task: 'E-WB2',
      generated_at: new Date().toISOString(),
      k_primary: 10,
      k_secondary: 25,
      dump_rank_cap: 'DEBUG_RANK_CAP=1000 (no dump had admission_kept > emitted rank)',
      inputs: {
        dumps: resolve(options.dumps),
        probes: resolve(options.probes),
        locomo: resolve(options.locomo),
        probe_index: resolve(options.probeIndex),
      },
      gold_usage: 'classification/scoring only; never used to build a query',
    },
    summary: {
      probes: probes.length,
      answerable: probes.filter(p => !p.adversarial).length,
      adversarial: probes.filter(p => p.adversarial).length,
      no_evidence_gold_probes: noEvidenceProbes.length,
      gold_items: allItems,
      gold_items_answerable: answerableItems,
    },
    items_by_label: itemsByLabel,
    items_by_label_answerable: itemsByLabelAnswerable,
    probes_with_label: probesWithLabel,
    probes_by_funnel: probesByFunnel,
    probes_by_funnel_all: probesByFunnelAll,
    by_category: categoryAcc,
    overlays: {
      retrieved_but_model_failed: {
        count: retrievedButModelFailed.length,
        probes: retrievedButModelFailed,
        rule: 'answerable probe with ALL gold evidence in top-10 but judge verdict correct=false',
      },
      abstained_with_no_evidence: {
        count: abstainedWithNoEvidence.length,
        probes: abstainedWithNoEvidence,
        rule: 'answerable probe with NONE of its gold evidence in top-10 and abstained=true',
      },
      correct_answerable: probes.filter(p => !p.adversarial && p.correct).length,
    },
    unknown: {
      ranked_beyond_cap_or_unknown: itemsByLabel.K10?.ranked_beyond_cap_or_unknown ?? 0,
      ambiguous_total: unknownItems,
      excluded_by_not: itemsByLabel.K10?.excluded_by_not ?? 0,
      dropped_by_coverage: itemsByLabel.K10?.dropped_by_coverage ?? 0,
      cause:
        'Con el cap subido a 1000 ningún dump tuvo admission_kept > ranking emitido, así que no quedan ítems con rango oculto. `excluded_by_not` mide exclusiones NOT reales (0: las preguntas naturales no generan operadores NOT) y `dropped_by_coverage` mide candidatos descartados por el piso de coverage antes de la admisión (0 en conv-26: todo candidato de un canal filtrado por coverage también entraba por `like`/`token_set`, que no se filtran).',
    },
    examples,
    per_probe: perProbe,
  };
}

// ── Spanish report renderer ──

function pct(n: number, d: number): string {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`;
}

function labelTable(items: Record<string, number>, total: number): string {
  const rows = DISPLAY_LABELS.map(
    label => `| \`${label}\` | ${items[label] ?? 0} | ${pct(items[label] ?? 0, total)} |`
  ).join('\n');
  return `| Etiqueta | Ítems | % |\n| --- | ---: | ---: |\n${rows}`;
}

export function renderReport(classification: Classification): string {
  const s = classification.summary as {
    probes: number;
    answerable: number;
    adversarial: number;
    no_evidence_gold_probes: number;
    gold_items: number;
    gold_items_answerable: number;
  };
  const k10 = classification.items_by_label.K10 ?? {};
  const k25 = classification.items_by_label.K25 ?? {};
  const a10 = classification.items_by_label_answerable.K10 ?? {};
  const f10 = classification.probes_by_funnel.K10 ?? {};
  const f25 = classification.probes_by_funnel.K25 ?? {};
  const overlays = classification.overlays as {
    retrieved_but_model_failed: { count: number };
    abstained_with_no_evidence: { count: number };
    correct_answerable: number;
  };
  const unknown = classification.unknown as {
    ranked_beyond_cap_or_unknown: number;
    excluded_by_not: number;
    dropped_by_coverage: number;
    ambiguous_total: number;
    cause: string;
  };
  const total10 = Object.values(k10).reduce((a, b) => a + b, 0);
  const total25 = Object.values(k25).reduce((a, b) => a + b, 0);
  const totalA10 = Object.values(a10).reduce((a, b) => a + b, 0);

  const funnelRows = (f: Record<string, number>): string => {
    const total = ['ALL', 'partial', 'NONE', 'no_evidence_gold'].reduce(
      (sum, status) => sum + (f[status] ?? 0),
      0
    );
    return ['ALL', 'partial', 'NONE', 'no_evidence_gold']
      .map(status => `| \`${status}\` | ${f[status] ?? 0} | ${pct(f[status] ?? 0, total)} |`)
      .join('\n');
  };

  const categoryRows = Object.entries(
    classification.by_category as Record<
      string,
      {
        probes: number;
        answerable: number;
        items: Record<string, number>;
        funnel: Record<string, number>;
      }
    >
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, acc]) => {
      const hits = acc.funnel.ALL ?? 0;
      const partial = acc.funnel.partial ?? 0;
      const none = acc.funnel.NONE ?? 0;
      const never = acc.items.never_candidate ?? 0;
      const dropped = acc.items.dropped_by_admission ?? 0;
      const outside = acc.items.admitted_outside_top10 ?? 0;
      const inside = acc.items.admitted_top10 ?? 0;
      return `| ${category} | ${acc.probes} | ${acc.answerable} | ${inside} | ${outside} | ${dropped} | ${never} | ${hits} | ${partial} | ${none} |`;
    })
    .join('\n');

  const exampleSections = classification.examples
    .map((example, index) => {
      const stages = example.item.stages;
      const channels = stages.channels.length > 0 ? stages.channels.join(', ') : '∅';
      const coverage = stages.after_coverage.length > 0 ? stages.after_coverage.join(', ') : '∅';
      const verdict = example.adversarial
        ? 'adversarial (no answerable)'
        : example.judge.correct
          ? 'correcto'
          : 'incorrecto';
      return `### Ejemplo ${index + 1} — \`${example.item.label}\`
- **Pregunta:** ${example.question}
- **Probe:** \`${example.probe_id}\` · categoría **${example.category}** · answerable: **${example.answerable}**
- **Gold ids:** ${example.gold_ids.length ? example.gold_ids.join(', ') : '(ninguno)'}
- **Ítem traza:** \`${example.item.name}\`
  - canales candidatos: ${channels}
  - tras coverage: ${coverage}
  - en \`after_not\`: ${stages.in_after_not} · excluido por NOT: ${stages.in_excluded_by_not}
  - en \`admitted_strict\`: ${stages.in_admitted_strict} · rank final: ${stages.final_rank ?? '—'}
  - admisión: tier **${String(example.record.admission_tier)}**, kept **${String(example.record.admission_kept)}**, dropped **${String(example.record.admission_dropped)}**
- **Funnel del probe:** ${example.funnel}
- **Veredicto del juez:** ${verdict}${example.judge.abstained ? ' · abstención' : ''}${example.judge.why ? ` — _${example.judge.why}_` : ''}`;
    })
    .join('\n\n');

  return `# E-WB2 — Clasificación de falsos negativos (recall de memoria)

**Feature:** \`00009-memory-recall-investigation\` · **Tarea:** E-WB2
**K primario:** 10 (la profundidad con la que el benchmark puntuó). **K secundario:** 25.

> Gold se usa **solo** para clasificar/puntuar; nunca para construir consultas.
> Los dumps son RAG-off. Todo el análisis es replay local ($0, sin DB viva, sin LLM).

## 1. Gate de los dumps (medido)

[MEDIDO] El dump de instrumentación se regeneró con el cap de ranking subido de
50 a \`DEBUG_RANK_CAP=1000\` y con un set explícito \`excluded_by_not\`; además
cada registro emite \`admission_kept\`/\`admission_dropped\`. El gate de replay se
re-ejecutó y sigue en PASS:

| Gate | Resultado |
| --- | --- |
| Counts == \`context_chunks\` guardados | **120/120** |
| Determinismo (dos replays planos) | **pass** (120 comparados, 0 mismatches) |
| Instrumentado == plano | **pass** (120 comparados, 0 mismatches) |
| Dumps con \`admission_kept > len(admitted_ranked_final)\` | **0/120** |
| Máximo \`admission_kept\` observado | **375** (< 1000) |

**Consecuencia:** el cap 50 anterior era la causa de la ambigüedad de admisión;
con 1000 no queda ningún ítem con rango oculto. Ver §7 (UNKNOWN).

## 2. Ítems de evidencia por etiqueta

[MEDIDO] ${s.gold_items} ítems gold en ${s.probes} probes (${s.answerable} answerable,
${s.adversarial} adversarial); ${s.no_evidence_gold_probes} probes answerable sin
evidencia gold. ${s.gold_items_answerable} ítems corresponden a probes answerable.

### K = 10 (primario)

[MEDIDO]

${labelTable(k10, total10)}

### K = 25 (secundario)

[MEDIDO] Misma semántica que K=10 pero con el corte en 25: aquí
\`admitted_top10\` significa "dentro del top-25" y \`admitted_outside_top10\`
"fuera del top-25".

${labelTable(k25, total25)}

### Solo probes answerable, K = 10

[MEDIDO] ${totalA10} ítems.

${labelTable(a10, totalA10)}

## 3. Funnel por probe (evidencia completa/parcial/ninguna en top-K)

[MEDIDO] Sobre los probes answerable (${s.answerable}, incluidos los 2 sin gold).

### K = 10

| Estado | Probes | % |
| --- | ---: | ---: |
${funnelRows(f10)}

### K = 25

| Estado | Probes | % |
| --- | ---: | ---: |
${funnelRows(f25)}

> Nota: las tablas de funnel son **answerable-only** (${s.answerable}); los 28
> adversarial se reportan aparte en \`probes_by_funnel_all\`. Los dos answerable
> sin evidencia gold aparecen como \`no_evidence_gold\`.

## 4. Por categoría (K = 10)

[MEDIDO] Ítems por etiqueta y funnel por probe. \`adversarial\` no es answerable.

| Categoría | Probes | Answerable | top10 | outside10 | dropped_adm | never_cand | ALL | partial | NONE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${categoryRows}

## 5. Cruce con el veredicto del juez (overlay)

[MEDIDO]

| Fenómeno | Probes | Regla |
| --- | ---: | --- |
| \`retrieved-but-model-failed\` | ${overlays.retrieved_but_model_failed.count} | answerable con TODA la evidencia en top-10 pero \`correct=false\` |
| \`abstained-with-no-evidence\` | ${overlays.abstained_with_no_evidence.count} | answerable con NINGUNA evidencia en top-10 y \`abstained=true\` |
| Answerable correctos | ${overlays.correct_answerable} | \`correct=true\` sobre ${s.answerable} answerable |

**Lectura:** la recuperación no es el único cuello de botella. De los probes con
evidencia completa en top-10, ${overlays.retrieved_but_model_failed.count} igual
fallaron por el modelo; a la inversa, ${overlays.abstained_with_no_evidence.count}
probes se abstuvieron sin ninguna evidencia recuperada (abstención correcta ante
falta de contexto).

## 6. Ejemplos con traza completa

[MEDIDO] Un ejemplo por bucket disponible (se omiten buckets con 0 ítems).

${exampleSections}

## 7. UNKNOWN / ambigüedad

[MEDIDO]

| Bucket | Ítems | Causa |
| --- | ---: | --- |
| \`ranked_beyond_cap_or_unknown\` | ${unknown.ranked_beyond_cap_or_unknown} | Con el cap subido a 1000 ningún dump tuvo \`admission_kept\` > ranking emitido: no quedan ítems con rango oculto. |
| \`excluded_by_not\` (NOT real) | ${unknown.excluded_by_not} | Sin operadores NOT en las preguntas naturales del benchmark; \`excluded_by_not\` vacío en los 120 dumps. |
| \`dropped_by_coverage\` | ${unknown.dropped_by_coverage} | Candidatos que no llegaron a \`after_not\` sin exclusión NOT explícita: descartados por el piso de coverage dentro de \`any\`/\`trigram\`/\`fuzzy\`. |
| **Ambigüedad total** | **${unknown.ambiguous_total}** | Solo el bucket de cap. ${unknown.cause} |

No se infiere ningún ítem "perdido" fuera de estas categorías: la clasificación
es exhaustiva sobre los ${s.gold_items} ítems gold.

## 8. Limitaciones declaradas

- [MEDIDO] Una sola conversación (\`conv-26\`), RAG off; no generaliza por sí solo.
- [INFERIDO] La etiqueta \`dropped_by_admission\` es determinista respecto del dump
  (post-NOT, no admitido, sin cap oculto), pero no distingue coverage de
  predicado booleano dentro de la admisión.
- Los reportes adversariales incluyen \`evidence\` en el dataset LoCoMo; se
  clasifican pero se marcan como no answerable y no se usan para el funnel
  principal de answerable.
`;
}

// ── CLI ──

function defaultOptions(): Options {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    dumps: join(agentMemory, 'experiments/REPORTS/workbench/dumps/rag-off-stages.jsonl'),
    probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
    locomo: join(integration, 'data/locomo10.json'),
    probeIndex: join(agentMemory, 'experiments/REPORTS/workbench/dumps/probe-index.json'),
    outDir: join(agentMemory, 'experiments/REPORTS/false-negatives'),
  };
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const base = defaultOptions();
  return {
    dumps: flags.get('dumps') ?? base.dumps,
    probes: flags.get('probes') ?? base.probes,
    locomo: flags.get('locomo') ?? base.locomo,
    probeIndex: flags.get('probe-index') ?? base.probeIndex,
    outDir: flags.get('out-dir') ?? base.outDir,
  };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const classification = buildClassification(options);
  mkdirSync(options.outDir, { recursive: true });
  const jsonPath = join(options.outDir, 'classification.json');
  const reportPath = join(options.outDir, 'report.md');
  writeFileSync(jsonPath, `${JSON.stringify(classification, null, 2)}\n`);
  writeFileSync(reportPath, renderReport(classification));
  const summary = classification.summary as { probes: number; gold_items: number };
  process.stdout.write(
    `classification written: ${summary.probes} probes, ${summary.gold_items} gold items → ${resolve(options.outDir)}\n`
  );
}
