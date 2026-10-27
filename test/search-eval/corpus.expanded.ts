// ── Expanded fixture corpus for the v2 search evaluation suite ──
//
// ADDITIVE to `corpus.ts` (which is the immutable v1 corpus). This module never
// mutates `FIXTURE_CORPUS`; it composes a richer v2 corpus from the v1 docs plus
// new documents that exercise the axes the v2 suite must cover:
//
//   - Spanish accented words (`configuración`, `puntuación`, `acción`)
//   - ñ/n minimal pairs (`año`/`ano`, `caña`/`cana`)
//   - very long memories (1–4 KB) with a rare token buried mid-document
//   - a frequent token spread across many documents (`registro`)
//   - short tokens, long rare words, and camel/kebab/snake identifiers
//   - near-duplicate distractors (same shape, one distinguishing token)
//
// All content is a static literal (or a deterministic function of literals), so
// the corpus — and therefore every derived label — is reproducible byte-for-byte.

import { FIXTURE_CORPUS } from './corpus';
import type { CorpusDoc } from './ground-truth';

export const EXPANDED_SPACES = {
  project: 'projects/search-lab-v2',
  i18n: 'projects/i18n-lab',
} as const;

const FILLER_ES =
  'El equipo revisó el documento y anotó cada detalle relevante para el registro interno del proyecto. ';

/**
 * Build a 1–4 KB deterministic document body with `rareSentence` buried at the
 * midpoint. `repeats` controls the length; the midpoint insertion guarantees the
 * rare token is neither at the very start nor the very end.
 */
function longContent(rareSentence: string, repeats: number): string {
  const body = Array.from(
    { length: repeats },
    (_, index) => `Sección ${index + 1}. ${FILLER_ES}`
  ).join('');
  const mid = Math.floor(body.length / 2);
  return `${body.slice(0, mid)} ${rareSentence} ${body.slice(mid)}`;
}

/** A short `registro` document carrying a unique distinguishing token. */
function registroDoc(suffix: string, extra: string): CorpusDoc {
  return {
    space: EXPANDED_SPACES.project,
    name: `registro-${suffix}`,
    content: `Registro de incidencias ${suffix}: ${extra} El registro se guarda por separado.`,
    tier: 3,
    tags: ['type:project'],
  };
}

export const EXPANDED_CORPUS: CorpusDoc[] = [
  // ── Spanish accents ──
  {
    space: EXPANDED_SPACES.project,
    name: 'guia-configuracion',
    content:
      'Guía de configuración inicial: la puntuación de la configuración y cada acción del asistente quedan registradas.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'puntuacion-examen',
    content:
      'Puntuación del examen: puntuación final, puntuación parcial y puntuación por sección.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'accion-reaccion',
    content:
      'Acción y reacción: cada acción dispara una reacción, y la acción encadenada reacciona.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'configuracion-red',
    content:
      'Configuración de red: configuración de puertos, configuración de proxy y configuración DNS.',
    tier: 3,
    tags: ['type:config'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'corazon-cancion',
    content: 'Canción del corazón: el corazón, la canción y la razón viajan juntos.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── ñ / n minimal pairs ──
  {
    space: EXPANDED_SPACES.project,
    name: 'ano-fiscal-2026',
    content: 'El año fiscal 2026 y el cierre anual del año con presupuesto del año anterior.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'canaveral-rio',
    content: 'El cañaveral junto al río y la caña de pescar del pescador.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'cana-prematura',
    content: 'Cabello cano y cana prematura: la cana aparece antes de tiempo.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── very long memories (1–4 KB) with a rare token buried mid-document ──
  {
    space: EXPANDED_SPACES.project,
    name: 'informe-largo-zentharion',
    content: longContent('El identificador reservado zentharion aparece solo aquí.', 24),
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'manual-extenso-plutonio',
    content: longContent('La clave de lote plutonio-enriquecido-x9 es única.', 20),
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'bitacora-larga-obsidiana',
    content: longContent('La muestra obsidiana-negra quedó archivada.', 28),
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'catalogo-prolijo-vespertino',
    content: longContent('El turno vespertino quedó documentado.', 16),
    tier: 3,
    tags: ['type:project'],
  },

  // ── frequent token across many documents (`registro`) ──
  registroDoc('01', 'Pérdida de paquetes en el nodo norte.'),
  registroDoc('02', 'Latencia elevada en el nodo sur.'),
  registroDoc('03', 'Reinicio del servicio de colas.'),
  registroDoc('04', 'Disco casi lleno en el nodo este.'),
  registroDoc('05', 'Certificado a punto de expirar.'),
  registroDoc('06', 'Error de autenticación intermitente.'),
  registroDoc('07', 'Timeout del proxy inverso.'),
  registroDoc('08', 'Memoria agotada en el worker.'),
  registroDoc('09', 'Cambio de configuración no aplicado.'),
  registroDoc('10', 'Alerta de temperatura del gabinete.'),

  // ── short tokens ──
  {
    space: EXPANDED_SPACES.project,
    name: 'hp-temp-regla',
    content: 'Regla de hp: hp temporal, hp máxima y hp restante tras el golpe.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'pp-progreso-regla',
    content: 'pp y puntos de progreso: cada pp acumula progreso de la sesión.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── long rare words (>16 chars) ──
  {
    space: EXPANDED_SPACES.i18n,
    name: 'internacionalizacion-guia',
    content: 'Guía de internacionalizacion: cubre la internacionalizacion completa del sitio.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.i18n,
    name: 'contrarrevolucionario-nota',
    content: 'Nota sobre el movimiento contrarrevolucionario y su contrarrevolucionario líder.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'electroencefalograma-estudio',
    content: 'Estudio con electroencefalograma: el electroencefalograma registra la actividad.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'desconfiguracion-incidente',
    content: 'Incidente de desconfiguracion: una desconfiguracion rompió el despliegue.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── identifiers: camelCase, kebab-case, snake_case ──
  {
    space: EXPANDED_SPACES.project,
    name: 'handleSearchResults-impl',
    content: 'handleSearchResults transforma y pagina los resultados de búsqueda.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'parseQueryAstNotation-impl',
    content: 'parseQueryAstNotation convierte la consulta en un árbol de nodos.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'search-eval-v2-runner',
    content: 'search-eval-v2-runner orquesta la suite versionada v2.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'multi-token-query-builder',
    content: 'multi-token-query-builder arma consultas con varios tokens.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'search_fusion_weights',
    content: 'search_fusion_weights define los pesos por canal de la fusión.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'ranking_metrics_v2',
    content: 'ranking_metrics_v2 calcula MRR y nDCG@10 sobre el top-k.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── near-duplicate distractors (one distinguishing token) ──
  {
    space: EXPANDED_SPACES.project,
    name: 'cache-scope-alpha',
    content:
      'cache scope alpha: la caché gestiona entradas vacías con keep_empty en la variante alpha.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'cache-scope-beta',
    content:
      'cache scope beta: la caché gestiona entradas vacías con keep_empty en la variante beta.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'spec005-feat-026',
    content: 'spec005 / FEAT-026: nueva ruta de reporte y validación slug uuid.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── bilingual glossary / border token ──
  {
    space: EXPANDED_SPACES.i18n,
    name: 'glossary-es-en',
    content:
      'Glosario bilingüe: memory/memoria, search/búsqueda, space/espacio, link/enlace, tag/etiqueta.',
    tier: 2,
    tags: ['type:reference'],
  },
  {
    space: EXPANDED_SPACES.project,
    name: 'token-borde-bilingue',
    content: 'Token border color: color del borde del token y border ring highlight.',
    tier: 3,
    tags: ['type:project'],
  },
];

/** The v2 corpus: the immutable v1 corpus plus the expanded documents. */
export const V2_CORPUS: CorpusDoc[] = [...FIXTURE_CORPUS, ...EXPANDED_CORPUS];

/** All distinct spaces in the v2 corpus, sorted for deterministic seeding. */
export function listV2Spaces(): string[] {
  return [...new Set(V2_CORPUS.map(doc => doc.space))].sort();
}
