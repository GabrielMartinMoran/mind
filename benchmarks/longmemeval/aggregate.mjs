/**
 * Merge independent, disjoint LongMemEval QA shards.
 * Refuses incomplete data instead of silently inflating/deflating accuracy.
 *
 * node benchmarks/longmemeval/aggregate.mjs <directory> <output.json> <expectedCount>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const [root, output, countString] = process.argv.slice(2);
const expected = Number(countString ?? 60);
if (!root || !output || !Number.isInteger(expected)) throw new Error('Usage: aggregate.mjs dir output count');
const files = readdirSync(root).filter((s) => s.endsWith('.json') && s.includes('qa60-shard-')).sort();
if (!files.length) throw new Error('No QA shard files found in ' + root);
const shards = files.map((file) => JSON.parse(readFileSync(root + '/' + file, 'utf8')));
const reference = shards[0];
const arms = ['mind', 'bm25', 'no-memory'];
const cases = shards.flatMap((shard) => {
  if (shard.datasetSha256 !== reference.datasetSha256 || shard.answerer?.model !== reference.answerer?.model) {
    throw new Error('Mixed dataset or model');
  }
  return shard.cases;
});
const ids = new Set(cases.map((c) => c.id));
if (ids.size !== cases.length || cases.length !== expected) throw new Error('Expected ' + expected + ' distinct questions, got ' + ids.size + ' unique among ' + cases.length);
for (const c of cases) for (const arm of arms) {
  if (typeof c[arm]?.correct !== 'boolean') throw new Error('Missing judge decision for ' + c.id + ' / ' + arm);
}
const stats = (subset, arm) => {
  const correct = subset.filter(c => c[arm].correct).length;
  const n = subset.length;
  const p = correct / n;
  const z = 1.96;
  const denom = 1 + z*z/n;
  const center = (p+z*z/(2*n))/denom;
  const margin = z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/denom;
  return {correct, total:n, accuracy:p, wilson95:[Math.max(0,center-margin),Math.min(1,center+margin)]};
};
const scores = Object.fromEntries(arms.map(arm => [arm, stats(cases,arm)]));
const categories = Object.fromEntries([...new Set(cases.map(c => c.type))].sort().map(type => [type,
  Object.fromEntries(arms.map(arm=>[arm,stats(cases.filter(c=>c.type===type),arm)]))
]));
const report = {
  protocol: reference.protocol,
  datasetSha256: reference.datasetSha256,
  answerer: reference.answerer,
  judge: reference.judge,
  context: reference.context,
  count: cases.length,
  scores,
  categories,
  cases,
};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log('QA60_RESULT '+JSON.stringify({count:cases.length, model:report.answerer,context:report.context,scores,categories}));
