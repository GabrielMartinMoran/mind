/**
 * End-to-end LongMemEval-S QA pilot over the exact retrieved session IDs.
 * Paired arms: Mind, BM25, and no memory. Answerer + blinded LLM judge.
 * NO gold answers or has_answer flags are ever placed in answer prompts.
 * Judge implements official LongMemEval task-specific rubric.
 *
 * Invocation:
 * bun benchmarks/longmemeval/answer.mjs --input=/tmp/longmemeval_s_cleaned.json \
 *   --retrieval=benchmarks/longmemeval/retrieval.json --output=benchmarks/longmemeval/qa.json \
 *   --provider=ollama --model=llama3.2:3b
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const opts = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const input = opts.get('input') ?? '/tmp/longmemeval_s_cleaned.json';
const retrievalPath = opts.get('retrieval') ?? 'benchmarks/longmemeval/retrieval.json';
const output = opts.get('output') ?? 'benchmarks/longmemeval/qa.json';
const provider = opts.get('provider') ?? 'opencode';
const model = opts.get('model') ?? (provider === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : provider === 'openrouter' ? 'deepseek/deepseek-v4.1-flash' : 'llama3.2:3b');
const judgeModel = opts.get('judge-model') ?? model;
const budgetUsd = Number(opts.get('max-usd') ?? '0.75');
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10) throw new Error('max-usd must be between 0 and 10');
let spentUsd = 0;
const maxSessions = Number(opts.get('sessions') ?? 2);
const charsPerSession = Number(opts.get('session-chars') ?? 500);
const arms = (opts.get('arms') ?? 'mind,bm25,no-memory').split(',').map(s => s.trim()).filter(Boolean);
const allowedArms = new Set(['mind', 'mindRagOff', 'mindRagOn', 'bm25', 'no-memory']);
if (!arms.length || new Set(arms).size !== arms.length || arms.some(arm => !allowedArms.has(arm))) {
  throw new Error('Invalid or duplicate arm in --arms');
}
const dataset = await Bun.file(input).json();
const retrieval = await Bun.file(retrievalPath).json();
const byId = new Map(dataset.map((item) => [item.question_id, item]));
const count = Number(opts.get('count') ?? 12);
if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Invalid count');
const offset = Number(opts.get('offset') ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset >= 500) throw new Error('Invalid offset');
const items = retrieval.perQuestion.slice(offset, offset + count);
if (!items?.length) throw new Error('Retrieval results missing.');
if (!['ollama', 'openrouter', 'opencode'].includes(provider)) throw new Error('Unsupported provider: ' + provider);
if (provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is absent');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const result = {
  protocol: 'LongMemEval-S cleaned QA, forced retrieval, session-level memory (NOT autonomous write/use)',
  datasetSha256: retrieval.datasetSha256,
  selection: { count: items.length, offset },
  answerer: { provider, model, temperature: 0, reasoning: provider === 'openrouter' ? 'low' : null },
  judge: { provider, model: judgeModel, temperature: 0, reasoning: null, criterion: 'LongMemEval task-specific yes/no rubrics' },
  budget: { maxUsd: budgetUsd, spentUsd: 0, scope: 'reader+judge only; embedding costs are separate' },
  context: { maxSessions, charsPerSession, turnSelection: 'query-term overlap, identical for both retrieved arms' },
  cases: [],
};

async function opencodeCompletion(messages) {
  const dir = '/tmp/mind-longmemeval-opencode';
  mkdirSync(dir, { recursive: true });
  // OpenCode CLI must be the caller: free-tier chat API cannot be used by other clients.
  const prompt = messages.map((msg) => msg.role.toUpperCase() + ':\n' + msg.content).join('\n\n') + '\n\nASSISTANT:';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 60000);
    try {
      const proc = Bun.spawn([
        'opencode', 'run', '--model', model, '--format', 'json',
        '--title', 'LongMemEval QA ' + String(Date.now()),
        prompt,
      ], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: controller.signal,
        stdin: 'ignore',
        env: { ...process.env, OPENCODE_DISABLE_FREE_MODELS: '0', OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'deny' }) },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error('OpenCode exit ' + exitCode + ': ' + stderr.slice(0, 500));
      const parts = [];
      const failures = [];
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const item = JSON.parse(line);
          if (item.type === 'text' && typeof item.part?.text === 'string') {
            parts.push(item.part.text);
          }
          if (item.type === 'error') failures.push(JSON.stringify(item).slice(0, 400));
        } catch {}
      }
      if (failures.length) throw new Error('OpenCode model error: ' + failures.join('; '));
      const text = parts.join('\n').trim();
      if (!text) throw new Error('OpenCode returned no text: ' + stdout.slice(-300));
      return { text, usage: null };
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn('OPENCODE_RETRY ' + (attempt + 1) + ': ' + String(error).slice(0, 300));
      await sleep(2500 * (attempt + 1));
    } finally {
      clearTimeout(deadline);
    }
  }
}

async function chat(messages, maxTokens, role = 'answerer') {
  if (provider === 'opencode') return opencodeCompletion(messages);
  const endpoint = provider === 'ollama'
    ? 'http://127.0.0.1:11434/api/chat'
    : 'https://openrouter.ai/api/v1/chat/completions';
  const requestModel = role === 'judge' ? judgeModel : model;
  const payload = provider === 'ollama'
    ? { model: requestModel, messages, stream: false, options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: maxTokens } }
    : { model: requestModel, messages, temperature: 0, ...(role === 'answerer' ? { reasoning: { effort: 'low' } } : {}), max_tokens: maxTokens };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(provider === 'openrouter' ? { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new Error('Model HTTP ' + response.status + ': ' + body.slice(0, 400));
      }
      const parsed = JSON.parse(body);
      const answer = provider === 'ollama'
        ? parsed.message?.content
        : parsed.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('Empty/nontext completion');
      if (provider === 'openrouter') {
        const usage = parsed.usage;
        if (!usage) throw new Error('OpenRouter usage missing; cannot enforce budget');
        const reported = Number(usage.cost);
        const inputTokens = Number(usage.prompt_tokens);
        const outputTokens = Number(usage.completion_tokens);
        // Conservative fallback when usage.cost is absent. Prices are $/M and
        // this estimate is not a hard provider-side spending limit.
        const cost = Number.isFinite(reported) && reported >= 0
          ? reported
          : Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
            ? (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000
            : NaN;
        if (!Number.isFinite(cost)) throw new Error('Missing OpenRouter cost and token usage');
        spentUsd += cost;
        result.budget.spentUsd = spentUsd;
        if (spentUsd > budgetUsd) throw new Error('Soft OpenRouter QA budget exceeded (' + budgetUsd + ' USD)');
      }
      return { text: answer.trim(), usage: parsed.usage ?? null };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Inference retries exhausted');
}
const stop = new Set('who what why when where how which did does was were is are as the a an in on at to of for with since during from and or my me i we they he she their them it this that about after before be been was by into has had have do not did'.split(' '));
function excerpt(session, query) {
  const terms = new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((x) => !stop.has(x)));
  const scored = session.map((turn, i) => {
    const content = String(turn.content ?? '');
    const words = new Set(content.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    let score = 0;
    for (const word of terms) if (words.has(word)) score += 1;
    return { index: i, score, content, role: String(turn.role ?? 'unknown') };
  });
  // Select the top query-relevant turns, then restore chronological order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = scored.slice(0, 6).sort((a, b) => a.index - b.index);
  const text = picked.map((turn) => turn.role + ': ' + turn.content).join('\n\n');
  return text.slice(0, charsPerSession);
}
function contextFor(example, ids) {
  const lookup = new Map(example.haystack_session_ids.map((id, i) => [String(id), i]));
  const parts = [];
  for (const id of ids.slice(0, maxSessions)) {
    const i = lookup.get(String(id));
    if (i === undefined) continue;
    const excerptText = excerpt(example.haystack_sessions[i], example.question);
    parts.push('Conversation session (' + String(example.haystack_dates[i]) + '):\n' + excerptText);
  }
  return parts.join('\n\n---\n\n');
}
function answerPrompt(example, context) {
  return [
    { role: 'system', content: 'You are an assistant answering questions about a user from their conversation history. Use only the history provided. If information is missing, say you cannot determine the answer. Be concise. Never guess or invent personal details.' },
    { role: 'user', content: 'Conversation history:\n' + (context || '(No conversation history available)') + '\n\nQuestion date: ' + example.question_date + '\nQuestion: ' + example.question + '\nAnswer:' },
  ];
}
function judgePrompt(example, response) {
  const task = example.question_type;
  let lead;
  let tail = 'Is the model response correct? Answer yes or no only.';
  if (example.question_id.endsWith('_abs')) {
    lead = 'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.';
    tail = 'Does the model correctly identify the question as unanswerable? Answer yes or no only.';
  } else if (task === 'single-session-preference') {
    lead = 'I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user\'s personal information correctly.';
  } else if (task === 'knowledge-update') {
    lead = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.';
  } else {
    lead = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
    if (task === 'temporal-reasoning') lead += ' In addition, do not penalize off-by-one errors for the number of days/weeks/months.';
  }
  return lead + '\n\nQuestion: ' + example.question + '\n\nCorrect Answer / Explanation: ' + String(example.answer) + '\n\nModel Response: ' + response + '\n\n' + tail;
}
function accuracy(arm, filter = () => true) {
  const rows = result.cases.filter(filter).flatMap((x) => x[arm] ? [x[arm]] : []);
  const judged = rows.filter((x) => typeof x.correct === 'boolean');
  return { judged: judged.length, correct: judged.filter((x) => x.correct).length, accuracy: judged.length ? judged.filter((x) => x.correct).length / judged.length : null };
}
function flush() {
  result.budget.spentUsd = spentUsd;
  result.scores = Object.fromEntries(arms.map((arm) => [arm, accuracy(arm)]));
  result.categories = Object.fromEntries([...new Set(result.cases.map((x) => x.type))].sort().map((category) => [
    category,
    Object.fromEntries(arms.map((arm) => [arm, accuracy(arm, (item) => item.type === category)])),
  ]));
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
for (const [index, row] of items.entries()) {
  const example = byId.get(row.id);
  if (!example) throw new Error('Dataset ID not found: ' + row.id);
  const entry = {
    id: row.id,
    type: example.question_type,
    abstention: row.isAbstention,
    retrieval: { mind: row.mind, bm25: row.bm25, gold: row.gold },
    question: example.question,
    goldAnswer: example.answer,
  };
  result.cases.push(entry);
  for (const arm of arms) {
    const context = arm === 'no-memory' ? '' : contextFor(example, row[arm]);
    console.log('QA_CALL ' + row.id + ' arm=' + arm + ' contextChars=' + context.length);
    const began = performance.now();
    try {
      const predicted = await chat(answerPrompt(example, context), provider === 'openrouter' ? 512 : 160, 'answerer');
      const verdict = await chat([{ role: 'user', content: judgePrompt(example, predicted.text) }], provider === 'openrouter' ? 192 : 12, 'judge');
      const label = /^(yes)\b/i.test(verdict.text.trim());
      const rejected = /^(no)\b/i.test(verdict.text.trim());
      entry[arm] = {
        answer: predicted.text,
        judgeRaw: verdict.text,
        correct: label ? true : rejected ? false : null,
        contextChars: context.length,
        latencyMs: Math.round(performance.now() - began),
        usageAnswer: predicted.usage,
        usageJudge: verdict.usage,
      };
    } catch (error) {
      entry[arm] = { error: String(error), correct: null, contextChars: context.length };
      flush();
      throw error;
    }
    if (entry[arm].correct === null) throw new Error('Unrecognized judge verdict for ' + row.id + ' arm ' + arm);
    flush();
  }
  console.log('QA_PROGRESS ' + (index + 1) + '/' + items.length
    + ' scores=' + JSON.stringify(result.scores));
}
flush();
console.log('QA_RESULT ' + JSON.stringify({
  count: result.cases.length,
  model, judgeModel, provider, budget: result.budget, scores: result.scores, categories: result.categories,
}));
