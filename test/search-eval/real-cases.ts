// ── Curated real queries + scan-derived ground truth ──
//
// These cases come from the real usage evidence file (OpenCode sessions,
// 2026-10). Their labels are NOT hand-authored: they are derived by scanning a
// COPY of the real database and recording which memories contain the query's
// significant tokens. This is a local benchmarking aid only — the fixture suite
// (cases.ts) is the CI source of truth.

import { Database } from 'bun:sqlite';

import { normalizeText } from './ground-truth';
import { refOf, sortRefs } from './refs';
import type { PresenceClass, RealCase, RealCasesFile } from './types';

/** Curated real queries covering diverse real failure classes. */
export const CURATED_REAL_QUERIES: { id: string; query: string }[] = [
  { id: 'real-embeddings', query: 'embeddings' },
  { id: 'real-foundry', query: 'foundry' },
  { id: 'real-iframe', query: 'iframe' },
  { id: 'real-borde', query: 'borde' },
  { id: 'real-token-color', query: 'token color' },
  { id: 'real-sesion16-name', query: 'sesion-16-prep-refugio-paladines-vigia' },
  { id: 'real-encuentro-name', query: 'encuentro-s16-cinco-lobos-balance-pa' },
  { id: 'real-temporal', query: 'temporal' },
  { id: 'real-spec004', query: 'spec004' },
  { id: 'real-rb26', query: 'rb26' },
  { id: 'real-large-report', query: 'large report performance diagnosis' },
  { id: 'real-embedding-or', query: 'embedding OR rag OR openrouter or openai' },
  { id: 'real-openai-or', query: 'openai OR semantic or vector' },
  { id: 'real-drex-stat', query: 'Drex Berull statblock ARCANA rango 2' },
  { id: 'real-arcana-reglas', query: 'ARCANA reglas nuevas criaturas rango tier PPF statblock' },
  { id: 'real-ogros-stat', query: 'ogros risco nombres PPF finales rango 2 statblock' },
  { id: 'real-sesion16-combate', query: 'sesion 16 grupo nivel combate PJs nivel' },
  { id: 'real-foundry-token-color', query: 'foundry token color' },
  { id: 'real-temp-hp-or', query: 'temporal HP OR temp hp OR salud temporal' },
  { id: 'real-detach-or', query: 'detach OR detachable or popout' },
  { id: 'real-modal-or', query: 'modal or configuracion or configuration' },
  { id: 'real-salud-or', query: 'salud or health or hp' },
  { id: 'real-config', query: 'config' },
  { id: 'real-vida', query: 'vida' },
  { id: 'real-arch-overview', query: 'architecture-overview' },
  { id: 'real-token-border', query: 'token border color selector highlight' },
  { id: 'real-tokenborder-or', query: 'tokenBorderColor OR "color del borde" OR "border color"' },
  { id: 'real-token-palette', query: 'token color palette' },
  { id: 'real-build-artifacts', query: 'build artifacts watch stale template main.js dist' },
  { id: 'real-color-option', query: 'color option rgba highlight border transparent palette' },
  { id: 'real-token-sheet', query: 'token color border configureSheet' },
  { id: 'real-arcana-token', query: 'arcana-token temp HP overlay alpha' },
  { id: 'real-arcanatoken-typeerror', query: 'ArcanaToken construction TypeError private fields' },
  { id: 'real-puntaroca', query: 'Puntaroca' },
  {
    id: 'real-puntaroca-visual',
    query: 'Puntaroca visual NPC Anselmo Marcial Dámaso Úrsula Larien Águeda Ubaldo Isidro Nicanor',
  },
  { id: 'real-creature-size-or', query: 'creature size OR creature-size OR tamaño criatura' },
  { id: 'real-creature-or', query: 'creature OR size OR token' },
  { id: 'real-canonical-sizes', query: 'canonical creature sizes' },
  { id: 'real-drawbar', query: 'temp hp bar animation intercept _drawBar' },
  {
    id: 'real-sesion16-resumen',
    query: 'Sesión 16 resumen PP puntos progreso formato transcripción',
  },
  { id: 'real-deuda-name', query: 'la-deuda-del-profeta-reemplaza-lobos-viaje-puntaroca' },
  {
    id: 'real-prep-sesion17',
    query: 'preparación sesión 17 refugio Garuda Puntaroca progreso de sesión 16',
  },
  {
    id: 'real-transparencia-or',
    query: 'transparencia OR alpha OR TEMP_HP_ALPHA OR semi-transparent',
  },
  {
    id: 'real-report-endpoint-or',
    query: 'report endpoint project id validation slug OR "005-large-report-performance"',
  },
  { id: 'real-cache-or', query: 'cache fix OR cache-fix OR FEAT-023 OR cache scope' },
  { id: 'real-project-slug', query: 'projectId slug uuid validation' },
  { id: 'real-test-isolation', query: 'integration test isolation cleanup analytics' },
  { id: 'real-vitest', query: 'vitest parallel test database' },
  { id: 'real-grounding', query: 'grounding ecosystem multirepo' },
  { id: 'real-multirepo', query: 'multirepo' },
  { id: 'real-mohabilbo', query: 'Mohabilbo ogros risco ARCANA Guerrero statblock' },
  { id: 'real-hondonada', query: 'Hondonada Peaje tesoro ogros botin campamento' },
  { id: 'real-xan-dartz', query: 'Xan Faelor Dartz Faro Puerto Bruma ataque noche viajeros Hoar' },
  { id: 'real-sigilos', query: 'Sigilos Sombríos Dragón de Penumbras' },
  { id: 'real-mystra', query: 'Mystra' },
  { id: 'real-leon-durell', query: 'Leon Durell' },
  { id: 'real-emoji-prefix', query: 'emoji prefix test' },
  { id: 'real-opencode-leak', query: 'leak opencode config test isolation' },
  { id: 'real-rebound-cache', query: 'rebound cache scope keep_empty' },
];

const OPERATORS = new Set(['or', 'and', 'not', 'near']);

/** Significant tokens for scanning: normalized, operators/quotes dropped. */
export function scanTokens(query: string): string[] {
  return normalizeText(query.replace(/["']/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0 && !OPERATORS.has(token));
}

const MAX_EXPECTED = 50;

interface ScanMemory {
  space: string;
  name: string;
  text: string;
  ref: string;
}

function loadMemories(db: Database): ScanMemory[] {
  const rows = db
    .query(
      `SELECT s.name AS space, m.name AS name, m.content AS content
       FROM memories m JOIN spaces s ON s.id = m.space_id`
    )
    .all() as { space: string; name: string; content: string }[];
  return rows.map(row => ({
    space: row.space,
    name: row.name,
    text: normalizeText(`${row.name} ${row.content}`),
    ref: refOf(row.space, row.name),
  }));
}

function deriveRealCase(id: string, query: string, memories: ScanMemory[]): RealCase {
  const tokens = scanTokens(query);
  const perToken = tokens.map(token => memories.some(memory => memory.text.includes(token)));
  const presentCount = perToken.filter(Boolean).length;

  let presence: PresenceClass;
  if (tokens.length > 0 && presentCount === tokens.length) presence = 'all-tokens-present';
  else if (presentCount === 0) presence = 'absent';
  else presence = 'partial';

  const allMatches = memories.filter(memory => tokens.every(token => memory.text.includes(token)));
  const expected = sortRefs(allMatches.map(memory => memory.ref)).slice(0, MAX_EXPECTED);

  return {
    id,
    query,
    space: null,
    params: {},
    expected,
    scan_hit_count: allMatches.length,
    presence,
    notes: `scan-derived; tokens=[${tokens.join(', ')}]`,
  };
}

/**
 * Build the real-cases file by scanning a read-only DB copy. The `dbPath` must
 * point at a COPY of the real database, never the live `data/mind.db`.
 */
export function buildRealCasesFile(dbPath: string): RealCasesFile {
  const db = new Database(dbPath, { readonly: true });
  try {
    const memories = loadMemories(db);
    const cases = CURATED_REAL_QUERIES.map(entry =>
      deriveRealCase(entry.id, entry.query, memories)
    );
    return {
      metadata: {
        generated_at: new Date().toISOString(),
        source_db: dbPath,
        access_mode: 'read-only COPY of data/mind.db',
        label_method:
          'scan-derived: expected = memories whose name+content contain ALL significant tokens (substring, case/diacritic-insensitive); OR/NOT operator semantics are NOT applied',
        scope: 'LOCAL RUNNER ONLY — labels are NOT CI-stable (depend on the live corpus snapshot)',
        token_rule:
          'normalize NFKD→lowercase, strip diacritics, split on non-alphanumerics, drop OR/AND/NOT',
      },
      cases,
    };
  } finally {
    db.close();
  }
}
