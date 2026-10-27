// ── Console/Markdown rendering for eval reports ──

import type { RealRunReport, RunReport } from './evaluator';
import type { SegmentMetrics } from './metrics';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function segmentRow(label: string, metrics: SegmentMetrics): string {
  return [
    pad(label, 22),
    pad(String(metrics.cases), 6),
    pad(String(metrics.passed), 7),
    pad(pct(metrics.avgPrecision), 8),
    pad(pct(metrics.avgRecall), 8),
    pad(String(metrics.tp), 5),
    pad(String(metrics.fp), 5),
    pad(String(metrics.fn), 5),
    pad(metrics.negatives === 0 ? '-' : pct(metrics.noiseRate), 8),
  ].join(' ');
}

const HEADER = [
  pad('segment', 22),
  pad('cases', 6),
  pad('passed', 7),
  pad('P@k', 8),
  pad('R@k', 8),
  pad('TP', 5),
  pad('FP', 5),
  pad('FN', 5),
  pad('noise', 8),
].join(' ');

function section(title: string, groups: Record<string, SegmentMetrics>): string[] {
  const lines = [`\n${title}`];
  lines.push(HEADER);
  for (const key of Object.keys(groups).sort()) {
    lines.push(segmentRow(key, groups[key]!));
  }
  return lines;
}

/** Render the fixture run summary as a plain-text table. */
export function renderSummaryTable(report: RunReport): string {
  const lines = ['Search evaluation — fixture suite'];
  lines.push(segmentRow('OVERALL', report.metrics.overall));
  lines.push(`errored cases: ${report.errored_cases}`);
  lines.push(...section('By origin', report.metrics.by_origin));
  lines.push(...section('By level', report.metrics.by_level));
  lines.push(...section('By type', report.metrics.by_type));
  return lines.join('\n');
}

/** Render the real-DB run summary, cross-tabbing presence vs zero-result. */
export function renderRealSummary(report: RealRunReport): string {
  const lines = ['Search evaluation — real queries (read-only DB copy)'];
  lines.push(`db: ${report.db_path}`);
  lines.push(
    `cases: ${report.case_count}  zero-result: ${report.zero_result_queries}  errored: ${report.errored_cases}`
  );
  lines.push('');
  lines.push(
    `${pad('presence', 22)} ${pad('queries', 8)} ${pad('zero', 6)} ${pad('with-result', 12)} ${pad('errored', 8)}`
  );
  for (const key of Object.keys(report.by_presence).sort()) {
    const group = report.by_presence[key]!;
    lines.push(
      `${pad(key, 22)} ${pad(String(group.queries), 8)} ${pad(String(group.zero_result), 6)} ${pad(String(group.with_result), 12)} ${pad(String(group.errored), 8)}`
    );
  }
  return lines.join('\n');
}
