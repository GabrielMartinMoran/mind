> **Historical report for feature 00004-search-optimization.** Frozen on 2026-10-20.
> Current behavior: [Search engine](../../search-engine.md).

# Optimización del motor de búsqueda — hallazgos, decisiones aprobadas y plan de ejecución

- **Feature:** `00004-search-optimization`
- **Repositorio:** `/home/gabrielmoran/Git/mind`
- **Fecha:** 2026-10-17
- **Estado:** **plan APROBADO (2026-10-17) con consideraciones vinculantes E1–E9**
  — ejecución T1–T5 autorizada (en curso; sin cambios de código de producción
  aún)
- **Alcance (una línea):** corregir el recall silencioso con diacríticos (R1),
  reducir el costo/espacio del índice trigram y el costo del canal fuzzy, y
  construir la infraestructura de evaluación/benchmarks necesaria para decidir
  con evidencia, **sin cambiar el ranking ni el contrato público**.
- **Estado final (post-ejecución, 2026-10-17):** T1–T5 ejecutadas. Se entregó
  **R1 + trigram contentless + fuzzy P-A-only + schema v10 definitivo**. Los
  esquemas intermedios dev v10 (con diccionario `search_terms`/`memory_terms`) y
  dev v11 (sin diccionario) **nunca se publicaron**; el v10 final consolidado no
  tiene diccionario y es funcionalmente idéntico a aquel dev v11. Los párrafos
  siguientes
  describen el plan **previo** a la ejecución (schema v9 como referencia); el
  estado real y las mediciones finales están en
  [`search-optimization-report.md`](search-optimization-report.md) y
  [`search-benchmarks.md`](../../search-benchmarks.md).
- **Nota:** documento de handoff. **Sin cambios de código de producción; baseline
  v1 intacto.** Esta fase sólo produjo mediciones, prototipos y este plan. El
  motor lexical offline actual (schema v9) sigue siendo el que corre en
  producción y es la referencia contra la que se medirá cada mejora.

## Etiquetas de evidencia

Toda afirmación numérica se marca con una de estas etiquetas:

- `[MEDIDO]` — observado en una corrida de medición registrada en un artefacto.
- `[DOC]` — respaldado por documentación externa (por ejemplo, sqlite.org/fts5).
- `[FACT-CODE]` — hecho verificado leyendo el código fuente real (archivo/línea).
- `[ANALYSIS]` — razonamiento derivado de hechos medidos o de código.
- `[PROYECTADO]` — inferencia/extrapolación **no medida** directamente.

Ninguna métrica de este documento fue inventada. Donde algo no se pudo medir
(canal semántico offline, proyección a 50k/100k, impacto corpus-wide de R1) se
declara de forma explícita.

## Contexto y objetivo

Esta iteración continúa la auditoría `00003-search-audit` (ver
[`search-audit.md`](../00003-search-audit/search-audit.md)), que identificó tres defectos críticos y
varias palancas simples de alto valor. El objetivo es **actuar** sobre esos
hallazgos con evidencia medida, no rediseñar la arquitectura.

### Objetivos de la iteración

1. **R1 — diacríticos:** cerrar el recall silencioso del canal trigram con texto
   acentuado (hoy `figuracio` no encuentra `configuración`).
2. **Costo del fuzzy:** eliminar o reducir drásticamente el cuello de latencia
   dominante (el re-plegado de documentos por consulta).
3. **Tamaño del trigram:** reducir el espacio del índice sin perder capacidad
   funcional (substring).
4. **Preservar/mejorar la calidad:** mantener recall de substring y typos, y
   mejorarlo donde el ganador lo permita (incluidos errores en los primeros 3
   caracteres).
5. **No tocar el ranking prematuramente:** ninguna optimización debe alterar la
   fórmula de fusión, los pesos ni la admission gate.

### Restricciones duras (fuera de alcance)

Ninguna tarea de esta feature modifica:

- Pesos de fusión, fórmula de fusión, agreement bonus.
- Buckets de confianza (`high`/`medium`/`low`).
- Admission gate (`documentSatisfiesQuery`).
- Combinación lexical/semántica ni la arquitectura de concurrencia (sin
  paralelismo real).
- El contrato público (CLI, MCP, API) ni los filtros/operadores del parser.
- La búsqueda semántica opcional.

Tampoco se reemplaza la arquitectura por cascada ni se eliminan canales para
"simplificar". No se cambia `FUZZY_MAX_DISTANCE` sin medición de falsos
positivos: se mide, no se cambia a ciegas.

### Reglas de seguridad

- **Nunca** operaciones destructivas sobre `data/mind.db` vivo. Todo el trabajo
  experimental corre sobre **copias** (repo y DB en `/tmp/opencode/`, o worktrees).
- Las migraciones se prueban sobre **copias** con el wrapper de
  `migration-safety` (backup, validación, restore) antes de tocar nada real.
- Los prototipos y la instrumentación de medición viven fuera de `src/` o en
  copias; el repo de producción no acumula cambios especulativos.

## Descubrimientos

Cada hallazgo lleva su número, etiqueta y la referencia al artefacto de
evidencia. Los artefactos crudos están en
`/tmp/opencode/search-optimization/{m1a,m1b}/` (efímeros).

### R1 — `remove_diacritics` (tokenizer trigram)

- `[DOC]` Disponible desde **SQLite 3.45.0** (confirmado en la fuente del tag
  `version-3.45.0/ext/fts5/fts5_tokenize.c` y en el foro oficial). Runtime
  medido: **3.53.0** (`bun:sqlite` 1.3.14).
- `[DOC]` Valores `0|1|2`; cualquier valor distinto de `0` mapea al fold
  complejo. En trigram, `1` y `2` dan resultados **idénticos** `[MEDIDO]`.
  Recomendación: usar `1` (el `2` para trigram está tolerado pero
  indocumentado).
- `[DOC]` **Incompatible con `case_sensitive 1`** → `error in tokenizer
constructor` `[MEDIDO]`.
- `[DOC]` **Desactiva la optimización de LIKE/GLOB indexados** (pasan a scan
  completo). `[MEDIDO]` mind sólo usa `MATCH` sobre la tabla, así que el impacto
  es nulo.
- `[MEDIDO]` Folding **bidireccional** (query plegada ↔ doc acentuado y
  viceversa); `ñ→n` (`ano` encuentra `el año pasado`); **combinantes y
  precompuestos equivalentes** (`cafe`+U+0301 ↔ `café`); case-insensitive
  preservado; términos de **<3 chars siguen sin matchear** (límite del trigram).
- `[MEDIDO]` **`CREATE ... IF NOT EXISTS` NO actualiza las opciones** del
  tokenizer (`no-op` silencioso). La migración **debe** hacer
  `DROP` + `CREATE` + repoblar.
- `[ANALYSIS]` Residual: el fold de SQLite es sólo latino; `stripDiacritics`
  (NFD) en JS quita marcas de todos los scripts → asimetría residual fuera de
  latino (fuera del alcance ES actual, se documenta).

### `contentless_delete=1` (trigram)

- `[DOC]` Disponible desde **SQLite 3.43.0**. DDL `content='',
contentless_delete=1`.
- `[MEDIDO]` Capacidades preservadas: `INSERT` con rowid explícito, `DELETE`,
  `INSERT OR REPLACE`, `UPDATE` con todas las columnas, `delete-all`,
  `optimize`/`merge`/`automerge`/`pgsz`, `bm25`/`rank`, `COUNT(*)`, `MATCH`,
  `EXCEPT`/`LEFT JOIN` (validación de huérfanos).
- `[MEDIDO]` Limitaciones: `rebuild` **no soportado** (error), **subset-UPDATE**
  error, comando `'delete'` inválido, columnas leídas = **NULL**, `snippet()` no
  disponible y `highlight()` NULL (ninguno se usa en mind).
- `[MEDIDO]` Tombstones: 500 inserts → 86 KB; delete 250 → 114 KB (crece);
  `optimize` + `VACUUM` → 53 KB. `DELETE`/`optimize` no devuelven bytes al SO
  (sólo `VACUUM`).
- **Combinación objetivo v10** (`trigram remove_diacritics 1` +
  `content='' contentless_delete=1`): `[MEDIDO]` **OK** con todas las
  operaciones de `FtsHelper` (insert / update = delete+insert / delete) y con el
  matching de substring plegado.
- `[FACT-CODE]` **Consecuencia obligatoria:** `ensureIntegrity`
  (`src/store/sqlite-store.ts:44`) usa `'rebuild'` para la recuperación ante
  corrupción → **debe reworkarse a `delete-all` + repoblar desde `memories`**
  (riesgo alto si se omite: la recuperación fallaría en v10).

### Migración v10 consolidada — change points

`[FACT-CODE]` Una **única migración v10** (R1 + contentless, más la tabla de
diccionario si el ganador fuzzy la requiere) toca estos puntos:

- `src/store/schema.ts`: `SCHEMA_VERSION 9→10`; DDL fresh con las opciones
  nuevas; `MIGRATE_V9_TO_V10` (`DROP` + `CREATE` +
  `INSERT ... SELECT fts_id, name, content FROM memories` + bump de versión);
  guard `currentVersion < 10`.
- `src/store/migration-safety.ts`: `validateMigratedDatabase` a v10; validación
  de v10 (opciones presentes en `sqlite_master.sql`, paridad de conteo/rowids);
  el chequeo de huérfanos sigue funcionando `[MEDIDO]`.
- `src/store/sqlite-store.ts`: `ensureIntegrity` → `delete-all` + repoblar para
  la tabla trigram.
- Tests a actualizar (líneas exactas en el informe R1):
  `test/trigram-search.spec.ts` (versión, `ftsRows` con columnas NULL,
  migración, nuevos casos R1/contentless), `test/migration-safety.spec.ts`
  (versión, paridad por rowid, fixture v9→v10), `test/uuid-migration.spec.ts`
  (versión).
- Baseline v1 **inmutable** + baseline **nuevo y versionado** del motor
  optimizado (E1).
- `AGENTS.md` y `CHANGELOG.md` obligatorios por política.

### Sonda `detail=none` — **rechazada para producción**

- `[MEDIDO]` `detail=none` rompe toda query >3 chars
  (`fts5: phrase queries are not supported (detail!=full)`), prohíbe filtros de
  columna y `NEAR`.
- `[MEDIDO]` Una consulta ≥3 chars puede descomponerse en `AND` de trigramas y
  verificarse luego en JS (`content.includes(term)`): recall **exacto** en la
  sonda, pero con **FP 5–8 %** sobre términos de 7–11 trigramas, sobre-admisión,
  pérdida del ranking por frase y complejidad alta para todos los consumidores
  (CLI/MCP/API/fusión).
- **Veredicto:** **rechazada para producción**; queda documentada como
  experimento. `[ANALYSIS]`

### Desglose de costo del fuzzy (M1b)

Medido sobre una copia read-only del corpus real (4 496 memorias / 86 spaces,
schema v9, RAG off), con instrumentación sólo en la copia:

| Etapa                                     |                                    Costo (p50) | Etiqueta   |
| ----------------------------------------- | ---------------------------------------------: | ---------- |
| **Plegado de documentos (`foldedWords`)** |          **75,4 ms** (≈61 % de `store.search`) | `[MEDIDO]` |
| Fetch SQL de vocabulario                  |                                         2,3 ms | `[MEDIDO]` |
| Expansión (`expandFuzzyTokens`)           | 5,6 ms (sort ≈4,9; OSA **0,03**; filtro ≈0,35) | `[MEDIDO]` |
| MATCH de expansiones                      |                                         1,7 ms | `[MEDIDO]` |
| Re-plegado de coverage                    |                                        13,2 ms | `[MEDIDO]` |
| Cap de expansiones (50)                   |                 **nunca se alcanza** (máx. 31) | `[MEDIDO]` |

`store.search` global p50 **123,3 ms** / p95 365,1 ms (62 queries). El driver
**NO** es la distancia ni la expansión: es **re-plegar hasta 2000 documentos
(name+content) por consulta** en el canal fuzzy.

Vocabulario y candidatos `[MEDIDO]`:

- `|V| = 25 105` términos plegados; `df p50 = 2`; **44 % con df=1**
  (11 111/25 105); diccionario estimado **≈0,3 MB** (296 KB term+int df);
  17 307 trigramas distintos sobre términos; índice delete-2 ≈ 974 135 entradas.
- **24/62 consultas arquetípicas tocan el `LIMIT 2000` sin `ORDER BY`** →
  selección de candidatos **truncada y no garantizada determinista** aunque el
  snapshot estático dé resultado estable (riesgo real ante escrituras concurrentes
  / VACUUM / cambios de plan).
- P-B (diccionario + scan completo sin prefijo de 3): **≈7 ms/token** (frente a
  15,6–112 ms/consulta del rebuild actual por consulta).
- P-C build costs: índice trigram de términos ≈31 ms; delete-2 ≈648 ms
  (media; p50 645 ms).
- Escritura baseline: add/update/delete ≈ **0,1–0,2 ms/op**.

### Infraestructura de evaluación y benchmarks (R3)

- Suite v1: **297 casos / 68 docs**; baseline RAG off **246/297**; snapshot hash
  **`1f5bf98a…`** (246 passes). `[MEDIDO]`
- **Brecha de métricas:** el `evaluator.ts` stock no expone MRR, nDCG@10,
  latencia ni contadores de candidatos.
- Existe un **seam `SearchFn`** ya usado por la suite para inyectar la función de
  búsqueda; RAG se fuerza off en todas las corridas.
- Diseño de **suite v2** (~+250 casos versionados): primeros-3-char errors,
  transposiciones, inserciones/borrados, palabras cortas/largas, longitudes de
  query, acentos/R1, caso, ES/EN, posiciones de substring, identificadores,
  memorias largas, palabras frecuentes, negativos duros, casos irrelevantes y
  **casos adversariales anti-bias** (que favorecen a la implementación vieja).
- `scripts/bench-search.ts` (aprobado, T1): latencias p50/p95/p99 por clase,
  telemetría por canal, write-path, tamaño vía `VACUUM INTO` (dbstat no
  disponible), RSS, contadores de candidatos; escalabilidad 1k/10k automáticos,
  **50k real obligatorio** antes de cerrar fuzzy y 100k manual/opcional.
- `scripts/search-diff.ts` (aprobado, T1): comparación old-vs-new por **worktrees**
  (dos copias), diffs por consulta (añadidos/quitados/reordenados) con razones
  vía el campo `methods`.
- Benchmarks pesados **opt-in, fuera de `bun test`** (make targets); artefactos
  commiteables = **sólo agregados**.

## Decisiones

### Adoptadas por evidencia (D1–D9)

- **D1 — R1 + contentless en una única migración v10.** Adoptar
  `tokenize='trigram remove_diacritics 1'` + `content='', contentless_delete=1`
  en **una sola** migración v10 (runtime-probado `[MEDIDO]`; `IF NOT EXISTS` no
  actualiza → `DROP` + `CREATE` + repoblar).
- **D2 — `ensureIntegrity` rework obligatorio.** De `'rebuild'` (inválido en
  contentless) a `delete-all` + repoblar; validación v10 (opciones en
  `sqlite_master.sql`, paridad, huérfanos).
- **D3 — `detail=none` rechazado para producción.** FP 5–8 %, sobre-admisión,
  pérdida de bm25 por frase y complejidad; se documenta el prototipo y el
  veredicto.
- **D4 — Fuzzy: prototipar P-A y P-B (+P-D).** El costo dominante es el plegado
  de documentos. Se prototipan en copia aislada y se elige por benchmark. El
  ganador debe: (a) reducir sustancialmente la latencia fuzzy; (b) preservar o
  mejorar el recall de typos **incluidos errores en los primeros 3 chars**;
  (c) no subir noise/FP injustificadamente; (d) caber en el canal `fuzzy`
  (mismo `ChannelScores`/`-rank`/coverage). Si ninguno supera con evidencia,
  **no se reemplaza producción** y se documenta.
- **D5 — Determinismo.** Fijar `ORDER BY` en la generación de candidatos fuzzy
  (el `LIMIT 2000` actual no es determinista).
- **D6 — Evaluación.** v1 inmutable; v2 versionada con baseline propio; MRR y
  nDCG@10; diffs por consulta; adversariales anti-bias.
- **D7 — Benchmarks en el repo.** `scripts/bench-search.ts` + `scripts/search-diff.ts`
  commiteables; opt-in fuera de `bun test`; artefactos commiteados = agregados.
- **D8 — Migración única.** v10 incluye R1 + contentless (+ tabla de diccionario
  si el ganador fuzzy la requiere), consolidada en un solo paso.
- **D9 — Sin cambios de ranking.** Cualquier diff de ranking atribuible a la
  optimización debe explicarse por recall nuevo (R1/typos), no por cambios de
  fórmula. **Reinterpretado por E2:** no se exige identidad de orden; cada cambio
  se evalúa por calidad (ver §Aprobación).

### Decisiones resueltas (aprobadas 2026-10-17)

Ambas decisiones quedaron **APROBADAS** en la aprobación del plan
(2026-10-17); ya **no bloquean** el inicio de T1/T3.

- **APROBADO — Sink de diagnóstico.** **Sink de diagnóstico default-off,
  env-gated** (`MIND_SEARCH_DIAG=1` o equivalente) en
  `src/store/repositories/search-repository.ts`, con las condiciones
  vinculantes: no cambia el contrato público; no altera resultados ni orden; no
  registra contenido sensible ni consultas completas; costo despreciable cuando
  está apagado; mide tiempos por canal, cantidad de candidatos y expansiones
  fuzzy (entre otros indicadores); **tests de equivalencia funcional con el
  diagnóstico apagado**; simple y mantenible.
- **APROBADO CON CONDICIÓN — Rango de benchmarks.** 1k/10k automáticos;
  **50k: al menos una medición real obligatoria antes de cerrar la optimización
  del fuzzy** (latencia de búsqueda, costo fuzzy, tamaño de índices, costo de
  escritura); 100k manual/opcional con proyecciones claramente identificadas;
  corpus sintéticos con diversidad razonable de vocabulario y longitudes (evitar
  repetitivos); benchmarks pesados fuera de tests/CI.

## Aprobación y consideraciones vinculantes (2026-10-17)

El plan fue **aprobado el 2026-10-17**; la ejecución T1–T5 está autorizada. Las
siguientes consideraciones (E1–E9) son **vinculantes** y prevalecen sobre
cualquier redacción previa de este documento.

- **E1 — Baseline v1 INMUTABLE.** El baseline original nunca se sobrescribe. Se
  conservan: baseline original, resultados del motor optimizado (baseline nuevo
  y versionado), comparación diferencial y justificación de diferencias. Los
  tests de requisitos funcionales conservan sus expectativas salvo corrección
  explícitamente justificada; los fixtures nuevos usan expectativas de relevancia
  **independientes del motor actual**.
- **E2 — D9 reinterpretado.** No se exige identidad de orden en el ranking. Cada
  cambio de ranking relevante debe: detectarse por diff, explicarse técnicamente,
  evaluarse por calidad y contrastarse con las expectativas de relevancia. Sólo
  se detiene por regresiones relevantes de precisión/recall/MRR/nDCG sin
  justificación. Fórmula, pesos, agreement, admission y buckets siguen
  intocables.
- **E3 — Fuzzy: prioridad = eliminar reconstrucción/normalización repetida**
  (`[MEDIDO]` normalización ~75,4 ms; expansión ~5,6 ms; OSA ~0,03 ms). El
  diccionario incremental es **candidato, no obligatorio**; comparar P-A y P-B;
  índices auxiliares sólo con evidencia (no un delete-2 de ~1M entradas sin
  justificar). Evaluar errores al inicio/medio/fin; eliminar la dependencia del
  prefijo-3 si es posible sin degradación inaceptable. `LIMIT 2000`: `ORDER BY`
  mejora determinismo pero no recall — si el diccionario lo permite, eliminar la
  dependencia; si se mantiene el límite, justificarlo y cuantificar su efecto
  sobre el recall. **Medir el costo persistido real** del diccionario (tablas,
  índices, frecuencias, update incremental, rebuild, impacto en
  inserciones/eliminaciones).
- **E4 — Trigram/R1: tests ampliados.** diacríticos, mayúsculas/minúsculas,
  combinantes y precompuestos, ES/EN, "año"/"ano", consultas cortas,
  update/delete de contenido acentuado. No asumir normalización Unicode
  universal.
- **E5 — `detail=none`: descartado para producción.** Documentar correctamente:
  **no** es "técnicamente inviable", sino que **el ahorro adicional no
  justifica, con la evidencia actual, la complejidad de modificar
  recuperación/verificación/ranking**. Conservar mediciones y prototipo como
  referencia; no dedicar más tiempo en T3 salvo evidencia nueva relevante.
- **E6 — Migración v10: pruebas ampliadas obligatorias.** v9→v10 sobre copia del
  corpus real; fresh v10; equivalencia funcional fresh vs migrada; inserción
  post-migración; update conservando id; términos viejos desaparecen y nuevos
  aparecen; eliminación de memorias; eliminación de espacios; importaciones;
  recuperación de índices inconsistentes; rollback ante fallo; interrupción
  durante la reconstrucción; nunca perder datos originales; rebuilds
  failure-safe (sin índices parcialmente poblados).
- **E7 — Evaluación.** Expectativas por **relevancia real** (no copiadas de la
  salida del motor); pruebas que favorezcan y desfavorezcan alternativas;
  conservar diffs por consulta (nuevos/perdidos/reordenados/cambios de
  score/confianza/FP nuevos/FN corregidos). No confundir mejoras de recall con
  regresiones.
- **E8 — Ejecución.** T1–T5 aprobadas (T3 condicionada a alternativa validada +
  migración segura); T4 incluye **corrida real de 50k**; T5 resultados
  reproducibles + conclusiones críticas. No se requiere nueva aprobación para
  elegir/implementar el ganador si cumple criterios; si ninguna alternativa
  supera convincentemente al baseline, conservar la actual + optimizaciones
  justificadas + documentar. QA valida cada fase sin bloquear automáticamente
  cambios legítimos de recall/ranking.
- **E9 — Criterio de cierre.** (1) R1 corregido/probado; (2) substring
  conservado; (3) fuzzy preserva/mejora typos; (4) costo fuzzy reducido
  demostrable o alternativas justifican conservar; (5) trigram reduce
  almacenamiento sin regresiones; (6) migraciones seguras/verificables; (7)
  calidad comparada con benchmarks reproducibles; (8) cambios de ranking
  documentados; (9) suite v1 disponible para comparación histórica; (10)
  informe final explica qué cambió/mejoró/empeoró/pendiente.

## Plan de ejecución

Orden: `T1 → QA → T2 → QA → T3 → QA → T4 → QA → T5 → QA`. Un worker por tarea;
QA tras cada una; sin paralelismo de devs.

> **Regla transversal:** el plan está aprobado (T1–T5 autorizadas); los cambios
> de producción sólo ocurren en sus tareas (T1: sink default-off; T3: migración
> v10 + fuzzy ganador). Los prototipos fuzzy corren **en copias** del repo
> (`/tmp/opencode/search-optimization/t2/repo-copy/`); ninguna migración
> experimental sobre `data/mind.db` vivo.

### T1 — Infra de evaluación y benchmarks

- **Objetivo:** suite **v2** versionada (~+250 casos, con adversariales
  anti-bias y negativos duros) + métricas MRR/nDCG@10 + `scripts/bench-search.ts`
  - `scripts/search-diff.ts` + make targets opt-in + **sink de diagnóstico
    default-off aprobado** (condiciones en "Decisiones resueltas"); baseline v1
    **inmutable** + baseline **nuevo y versionado** del motor optimizado.
- **Archivos clave:**
  `test/search-eval/{corpus.ts,cases.expanded.ts,ranking-metrics.ts}`,
  `test/search-eval/{evaluator.ts,baseline.fixture.v2.json}`,
  `test/search-scenarios.spec.ts`, `test/search-eval.spec.ts` (bloque v2),
  `scripts/bench-search.ts`, `scripts/search-diff.ts`, `Makefile`,
  `src/store/repositories/search-repository.ts` (sólo sink default-off,
  aprobado) + test de equivalencia funcional.
- **Checks/gates:** hash del baseline v1 `1f5bf98a…` **sin cambios**; v2
  determinista (dos corridas → mismo hash); taxonomía v2 completa; smoke
  estructural del bench; typecheck/lint/format; suite completa verde.
- **Escalación:** cualquier cambio de comportamiento con el sink apagado → STOP.
- **QA:** valida hash v1, determinismo v2 y que el sink es byte-equivalente.

### T2 — Prototipos fuzzy + benchmarks + recomendación

- **Objetivo:** implementar **P-A** y **P-B** (y P-D si el prototipo lo
  justifica) **en copia aislada**; benchmark comparativo contra el fuzzy actual
  (latencia p50/p95 por clase, recall de typos incluidos primeros-3-chars,
  espacio, costo de escritura, determinismo); recomendación con evidencia.
- **Archivos clave:** copia `/tmp/opencode/search-optimization/t2/repo-copy/**`
  (no toca el repo); scripts de benchmark reutilizando T1; artefactos en
  `/tmp/.../t2/**`.
- **Checks/gates:** reproducibilidad; métricas `[MEDIDO]`; comparación contra el
  baseline M1b; informe de decisión (ganador o "no reemplazar").
- **Escalación:** si el ganador exige tocar ranking/fusión → STOP.
- **QA:** verifica que los números provienen de artefactos y que no hay
  cambios en el repo de producción.

### T3 — Implementación productiva

- **Objetivo:** migración v10 consolidada (R1 + contentless [+ diccionario si
  aplica]) + `ensureIntegrity`/validación + implementación del **fuzzy ganador**
  (o P-A si es el ganador) + tests de regresión R1/contentless/fuzzy + baseline
  v1 **inmutable** + baseline **nuevo y versionado** del motor optimizado (E1).
- **Archivos clave:** `src/store/schema.ts`, `src/store/migration-safety.ts`,
  `src/store/sqlite-store.ts`, `src/store/repositories/search-repository.ts`,
  `src/store/repositories/{memory,space}-repository.ts` (sólo si diccionario),
  `src/store/shared/{fts-helpers.ts, matching-tokenizer.ts}` (si aplica);
  tests:
  `test/{trigram-search,migration-safety,uuid-migration,mind-store,search-fusion}.spec.ts`
  y nuevo `test/fuzzy-search.spec.ts`.
- **Checks/gates:** migración v9→v10 sobre copia real (versión, opciones,
  paridad, huérfanos, restore ante fallo); fresh vs migrada; sync
  post-migración; regresión R1; contentless; fuzzy (recall/latencia/noise);
  suite completa; `make search-eval` (v1 inmutable + v2);
  `make bench-search` antes/después.
- **Escalación:** cualquier cambio de ranking no explicable; cualquier pérdida
  de capacidades.
- **QA:** valida migración con restore y paridad; que los cambios de ranking se
  expliquen y evalúen por calidad (E2), no por identidad de orden.

### T4 — Validación integral (Fase 4)

- **Objetivo:** corrida completa de benchmarks reales/sintéticos (1k/10k
  automáticos; **50k real obligatorio** antes de cerrar la optimización del
  fuzzy; 100k manual/opcional con proyecciones identificadas), `search-diff`
  old-vs-new por consulta, migraciones sobre copias reales, verificación en
  CLI/MCP/API, artefactos commiteables (sólo agregados).
- **Archivos clave:** `scripts/bench-search.ts`, `scripts/search-diff.ts`,
  `test/search-eval/**` (v2), `Makefile`, artefactos de validación.
- **Checks/gates:** criterios de aceptación del pedido (abajo).
- **Escalación:** fallo de un criterio de aceptación / cambio de ranking no
  explicado / fallo de migración → STOP y reportar.
- **QA:** confirma reproducibilidad y ausencia de degradaciones injustificadas.

### T5 — Informe técnico + reflexión + docs

- **Objetivo:** `docs/search-optimization-report.md` (ES) con las 10 preguntas de
  reflexión obligatorias, etiquetas de evidencia, metodología de benchmarks y
  límites; el informe debe declarar explícitamente **qué cambió, qué mejoró, qué
  empeoró y qué queda pendiente** (E9); actualizar `AGENTS.md` y `CHANGELOG.md`.
- **Archivos clave:** `docs/search-optimization-report.md`,
  `docs/search-benchmarks.md` (si se usa), `AGENTS.md`, `CHANGELOG.md`.
- **Checks/gates:** QA factual (números vs artefactos, citas, estructura,
  honestidad).
- **Escalación:** si los docs revelan una inconsistencia en el código →
  reportar, no cambiar código.

### Riesgos y mitigaciones

- Migración v10 sobre base real → copias + wrapper de `migration-safety` + tests
  de restore.
- `ensureIntegrity` olvidado → test explícito de recuperación con `delete-all`.
- Cambios de recall por R1 → baseline regenerado con QA + diffs por consulta.
- Prototipos fuzzy que no superan → **no** reemplazar producción y documentar (es
  un criterio de aceptación, no un fracaso).
- Benchmarks dependientes de máquina → agregados + shares; opt-in fuera de CI.
- Sink de diagnóstico → default-null + test de byte-equivalencia; fallback a
  instrumentación en worktree.

### Criterios de aceptación (del pedido)

R1 corregido; substring preservado; typos preservados/mejorados (incluidos los
primeros 3 chars si el ganador lo permite); costo fuzzy reducido o documentado;
tamaño del trigram reducido sin regresiones; sin degradaciones injustificadas;
migraciones OK; contrato público intacto; fórmula/pesos intactos; benchmarks
reproducibles.

## Anexo

### Rutas de artefactos de evidencia

Los siguientes artefactos son **efímeros** (`/tmp`) y pueden no sobrevivir a un
reinicio; los números clave ya están transcritos en este documento y en el
`research-report.md` de la feature.

- `/tmp/opencode/search-optimization/m1a/summary.md` + `results.json` — sondas
  runtime de FTS5 (R1, contentless, combinación v10, `detail=none`).
- `/tmp/opencode/search-optimization/m1b/summary.md` + `measurements.json` —
  desglose de costo fuzzy, estadísticas de vocabulario, candidatos,
  determinismo, micro-optimizaciones, costo de escritura.
- `.pas/state/active/00004-search-optimization/research-report.md` — reporte
  consolidado (fuente primaria).
- `.pas/state/active/00004-search-optimization/plan.md` — plan v1.
- `docs/search-audit.md` — auditoría `00003` (contexto; no se duplica aquí).

### Resumen de reproducibilidad

- Todo se midió con `bun:sqlite` (SQLite 3.53.0) sobre copias read-only de
  `data/mind.db`; el DB vivo nunca se abrió en modo escritura y su `mtime` no
  cambió.
- La instrumentación (`MIND_FUZZY_DIAG=1`) vive sólo en la copia; con la
  variable sin setear, el motor es byte-equivalente (las suites
  `search-fusion`, `trigram-search` y `query-parser` pasan con la
  instrumentación presente).
- Los milisegundos son dependientes de máquina/disco; las **shares** y el
  **orden relativo** son la señal durable.

### Riesgos abiertos

- **Semántico offline no medible:** sin provider key ni embeddings en fixtures,
  el canal semántico es estructuralmente inalcanzable con RAG off. No se falseó.
- **Escalabilidad 50k/100k:** la generación de corpus es cara → `[PROYECTADO]`
  salvo corrida explícita.
- **R1 en scripts no latinos:** el fold de SQLite es sólo latino → asimetría
  residual conocida (fuera del alcance ES).
- **Determinismo del `LIMIT 2000` sin `ORDER BY`:** fijarlo es parte de la
  solución (D5); hoy la selección es estable-pero-arbitraria.
- **Prototipos fuzzy:** los números de M1b son estimaciones de costo, no la
  implementación final; la decisión requiere los prototipos de T2.
