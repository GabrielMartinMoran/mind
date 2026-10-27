// ── Deterministic fixture corpus for the search evaluation suite ──
//
// 60–120 documents spread across three spaces, mirroring the real usage
// domains observed in the evidence file (project notes, foundry/module work,
// TTRPG session prep). Content is Spanish/English mixed, includes accents,
// kebab/snake/camel identifiers, long and short docs, tags and tiers. The
// corpus is committed and used to build a throwaway store per run, so the
// engine's indexing/sync path is exercised for real.

import type { CorpusDoc } from './ground-truth';

export const FIXTURE_SPACES = {
  project: 'projects/search-lab',
  foundry: 'projects/foundry-lab',
  ttrpg: 'sessions/ttrpg-lab',
} as const;

export const FIXTURE_CORPUS: CorpusDoc[] = [
  // ── projects/search-lab ──
  {
    space: FIXTURE_SPACES.project,
    name: 'architecture-overview',
    content:
      'Arquitectura general del proyecto mind: capas de store, CLI y MCP. Architecture overview and layering notes for future agents.',
    tier: 1,
    tags: ['type:reference', 'ref:architecture', 'status:living'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'cache-fix-feat-023',
    content:
      'Fix de caché FEAT-023: cache analyzed_file scoped to purity-api. The cache-fix avoids stale analyzed_file results and documents cache scope.',
    tier: 2,
    tags: ['cat:bugfix', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'large-report-performance',
    content:
      'Diagnóstico de performance de reportes grandes. Large report performance diagnosis covering lean payloads and report loading virtualization pagination.',
    tier: 2,
    tags: ['cat:discovery', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'embeddings-rag-provider',
    content:
      'Embeddings con proveedor OpenRouter y OpenAI. RAG semantic vector search provider selection and OpenRouter embedding provider notes.',
    tier: 2,
    tags: ['type:project', 'cat:decision'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'rb26-openrouter-only',
    content:
      'Rebound 26 (rb26): simulación openrouter-only y remoción de anthropic. openrouter-only provider switch with anthropic removal.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'report-endpoint-validation',
    content:
      'El endpoint de report valida projectId, slug y uuid. Validation rules for report endpoint project id slug uuid.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'integration-test-isolation',
    content:
      'Integration test isolation cleanup analíticos. Vitest parallel test database setup para evitar leaks entre suites.',
    tier: 3,
    tags: ['type:project', 'cat:pattern'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'build-artifacts-watch',
    content:
      'Build artifacts watch stale template main.js dist. Vite watch deja artifacts obsoletos en dist.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'job-status-feat-033',
    content:
      'Job status FEAT-033 status retriever: endpoint de detalle de job con auth y project access.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'detach-fullbleed-verified',
    content:
      'detach fullbleed full-bleed verificado: popout, detached window, applicationv2 y ownerDocument onDetach.',
    tier: 2,
    tags: ['cat:pattern', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'modal-config-configuration',
    content:
      'modal de configuración: configuration sheet render iframe forceReload pattern for modal settings.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'auth-jwt-token',
    content:
      'Auth JWT token session validation for API requests. Tokens expire quickly and require refresh.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'db-postgres-local-dev',
    content:
      'Database postgres local dev connection string and migration notes for the development database.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'deploy-k8s-manifest',
    content: 'Deploy kubernetes k8s cluster fluxitsoft: POSTGRES manifest and rollout strategy.',
    tier: 3,
    tags: ['type:config'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'purity-web-frontend',
    content: 'purity-web deploy: frontend build and static assets served by the API server.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'analytics-code-quality',
    content:
      'Analytics code_quality report structure: how the report aggregates metrics per module.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'card-thumbnails-favorites',
    content:
      'Card thumbnails real card colors favorites localStorage for the Yu-Gi-Oh Tag Force Evolution static viewer.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'tag-force-evolution-packs',
    content:
      'Tag Force Evolution PS2 pack data static catalog sources and pack aggregation in scripts/build_catalog.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'character-affection-sandwiches',
    content:
      'Character affection hearts sandwiches preferences image guide for Tag Force Evolution PS2.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'makefile-static-server',
    content: 'Makefile run local static server via scripts/build_catalog and bun run dev.',
    tier: 3,
    tags: ['type:config'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'opencode-config-leak',
    content:
      'Leak de config de opencode en test isolation. injectModel parity entre scaffolder e installer.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'installer-sweep-reinstall',
    content:
      'Installer sweep ownership y reinstalar (reinstall) de artefactos gestionados sin duplicados.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'grounding-ecosystem-multirepo',
    content: 'Grounding del ecosistema multirepo: cómo los agentes cruzan espacios de memoria.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'rebound-cache-scope',
    content:
      'Rebound cache scope keep_empty: la caché conserva entradas vacías cuando keep_empty está activo.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'spec004-feat-025',
    content: 'spec004 / FEAT-025: bypass de caché y purge k8s manifest POSTGRES.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.project,
    name: 'report-loading-virtualization',
    content:
      'Report loading performance: virtualización y paginación para reportes de miles de filas.',
    tier: 2,
    tags: ['type:project'],
  },

  // ── projects/foundry-lab ──
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-color-selector',
    content:
      'foundry token color border color selector highlight. La hoja configureSheet usa tokenBorderColor para pintar el borde.',
    tier: 1,
    tags: ['type:project', 'cat:pattern'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-color-temp-hp',
    content:
      'token color temp HP bar: animateBars intercepta _drawBar; refresh con uiScale y _drawBar.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-color-t1-qa',
    content:
      'token color T1 QA forceReload offsets arcana-sheet-v2. Verificación visual del borde tras forceReload.',
    tier: 2,
    tags: ['type:session', 'status:validated'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'creature-size-canonical',
    content:
      'canonical creature sizes: creature size token configureSheet y flags. token size flag arcana flag.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'arcana-token-temp-hp-alpha',
    content:
      'arcana-token temp HP overlay alpha. TEMP_HP_ALPHA semi-transparent alpha animation for the token bar.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'arcanatoken-construction-typeerror',
    content:
      'ArcanaToken construction TypeError private fields: constructor falla al desacoplar (detach).',
    tier: 3,
    tags: ['cat:bugfix', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'status-effects-exclusivity',
    content:
      'foundry status effects exclusivity fatigue arcana actor. Registry de status effects con exclusivity entre estados.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'status-effects-cards-cefiro',
    content:
      'status effects buffs cartas Céfiro bardo inspiración. ActiveEffect y statusEffects para el bardo Céfiro.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'foundry-v14-module',
    content: 'foundry v14 module system compatibility notes and migration checklist.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'detach-owner-document',
    content:
      'detach owner-document: onDetach y applicationv2 popout across ownerDocument boundaries.',
    tier: 3,
    tags: ['cat:pattern', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-cutter-actor-updater',
    content: 'token-cutter, arcana-sheet-v2 y actor-updater: pipeline de actualización de actores.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'animacion-temp-bar',
    content:
      'animación de la temp bar: animateBars intercepta _drawBar para animar la barra temporal.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'temp-hp-absorption',
    content:
      'temp hp absorption. Salud temporal, puntos de salud temporales y orden de absorción de daño.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'manage-cards-allcards',
    content:
      'ManageCardsView, AvailableCardsView y allCards. Secciones y subtabs manage available cards.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'efectos-activos-emoji',
    content: '"Efectos Activos" display-only con usos. emoji prefix test para las cartas activas.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'creature-size-t7-qa-verified',
    content:
      'creature-size-t7-qa-verified: tamaño criatura verificado en encontronazo de tamaño token.',
    tier: 3,
    tags: ['type:session', 'status:validated'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 't5-detach-fullbleed-verified',
    content: 't5-detach-fullbleed-verified: full-bleed detach verificado en la hoja arcana.',
    tier: 3,
    tags: ['type:session', 'status:validated'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-color-border-ring',
    content: 'token color border ring: token border color selector y ring highlight en el token.',
    tier: 2,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-size-flag-or-arcana-flag',
    content: 'token size flag o arcana flag: creature size token configureSheet y canonical sizes.',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'detach-or-detachable-or-popout',
    content:
      'detach or detachable or popout: desacoplar la hoja en ventana separada (detached window).',
    tier: 3,
    tags: ['type:project'],
  },
  {
    space: FIXTURE_SPACES.foundry,
    name: 'token-border-color-configure-sheet',
    content: 'tokenBorderColor en configureSheet: token border color selector highlight del borde.',
    tier: 3,
    tags: ['type:project'],
  },

  // ── sessions/ttrpg-lab ──
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'sesion-16-prep-refugio-paladines-vigia',
    content:
      'Sesión 16: preparación del refugio de los paladines y la vigía. Refugio de Garuda, Puntaroca, progreso de sesión.',
    tier: 1,
    tags: ['type:session', 'cat:summary'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'encuentro-s16-cinco-lobos-balance-pa',
    content:
      'Encuentro S16: cinco lobos, balance de PA y puntos. Viaje a Puntaroca, encuentro Arco 2.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'sesion-16-resumen-pp',
    content:
      'Sesión 16 resumen: PP y puntos de progreso, formato de transcripción y registro de sesión.',
    tier: 2,
    tags: ['type:session', 'cat:summary'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'sesion-17-prep-garuda',
    content: 'Preparación sesión 17: refugio Garuda, Puntaroca, y progreso de sesión 16 como base.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'la-deuda-del-profeta',
    content:
      'La Deuda del Profeta: reemplaza a los lobos en el viaje a Puntaroca. Renombrar archivo Mohabilbo.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'comitiva-serelia-garuda',
    content: 'Comitiva de Serelia y Garuda: refugiados y salida de Puntaroca en la sesión 17.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'mohabilbo-ogro-statblock',
    content: 'Mohabilbo: ogro risco de ARCANA, Guerrero rango 2, statblock R2 y PPF finales.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'drex-berull-statblock',
    content:
      'Drex Berull: statblock ARCANA rango 2. Ficha de criatura para el combate de la sesión.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'arcana-reglas-criaturas',
    content: 'ARCANA: reglas nuevas de criaturas por rango y tier, formato PPF y statblock.',
    tier: 3,
    tags: ['cat:discovery', 'type:project'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'hondonada-peaje-tesoro',
    content: 'Hondonada: el peaje, el tesoro, el botín y el campamento de los ogros.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'xan-faelor-dartz',
    content:
      'Xan Faelor y Dartz: el Faro, Puerto Bruma, ataque nocturno, viajeros y defensa compartida. Hoar.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'npc-fichas-iframe',
    content: 'NPC fichas: statblock ARCANA, formato rasgos e iframe incrustado en la ficha.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'puntaroca-elenco',
    content:
      'Puntaroca: NPC padres, Mira Montalba, cantero y pastora. Zonas y elenco del asentamiento.',
    tier: 2,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'salud-temp-hp-sesion',
    content:
      'Salud temporal y HP temporal: puntos de salud temporales durante el combate de la sesión.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'leon-durell-48-horas',
    content: 'Leon Durell: 48 horas de husk y cuerpo vacío antes del regreso.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'mystra-arco-3',
    content: 'Mystra, el tercer componente del sello del Arco 3: Garak-Akú y los Sigilos Sombríos.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'sigilos-sombrios-dragon',
    content:
      'Sigilos Sombríos y el Dragón de Penumbras: husks, 48 horas y el Núcleo ancla de Goro.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'habitacion-segura-templo',
    content:
      'Habitación segura: templo con la espada larga del alba, pasillo secreto y archivo del paladín.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'faro-puerto-bruma-hoar',
    content:
      'El Faro de Puerto Bruma: alianza con Hoar y Lathander, el Último Resplandor y la advertencia.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'ogros-risco-nombres-ppf',
    content:
      'Ogros risco: nombres PPF finales, rango 2 y statblock. Encuentro de la Deuda del Profeta.',
    tier: 3,
    tags: ['type:session'],
  },
  {
    space: FIXTURE_SPACES.ttrpg,
    name: 'xan-faelor-guardian-espectador',
    content:
      'Xan Faelor: el guardián espectador, Justo Castigo y el ataque al faro. Diario de Puerto Bruma.',
    tier: 3,
    tags: ['type:session'],
  },
];

export function listFixtureSpaces(): string[] {
  return [...new Set(FIXTURE_CORPUS.map(doc => doc.space))].sort();
}
