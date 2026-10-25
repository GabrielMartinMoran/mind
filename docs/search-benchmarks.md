# Metodología de benchmarks de búsqueda

Este documento describe **cómo** se miden el motor de búsqueda, su tamaño y su calidad, y
**cómo reproducir** esas mediciones. Para el comportamiento actual del motor, consulta la
página viva [search-engine.md](search-engine.md). La evidencia histórica excepcional que
sostiene estas herramientas está congelada en el
[informe técnico 00004](history/00004-search-optimization/search-optimization-report.md) y
en la [investigación de próximos pasos 00005 B](history/00005-search-followup/search-next-steps-research.md).

Las herramientas viven en el repositorio (`scripts/bench-search.ts`,
`scripts/search-diff.ts`, `scripts/search-eval.ts`, `test/search-eval/**`), de modo que la
metodología **no depende de artefactos efímeros**: los dumps crudos van a `/tmp`, pero los
scripts y los artefactos agregados están commiteados.

## Evaluación externa de memoria

La evaluación de respuestas de LongMemEval-S se realiza exclusivamente mediante
[OmniMemEval](../benchmarks/omnimemeval/README.md), desde un workflow manual,
fuera de CI. El harness de búsqueda local descrito en esta página sigue siendo
independiente de esa evaluación externa.

## Política opt-in (fuera de CI)

Los benchmarks pesados **no** forman parte de `bun test` ni de CI. Se ejecutan con make
targets explícitos. La única cobertura automática del harness es un **smoke estructural**
(`test/search-bench-smoke.spec.ts`), que valida la forma de la salida (percentiles, clases,
telemetría) sobre un corpus diminuto sin medir tiempos absolutos.

## Cómo ejecutar

El harness fuerza `MIND_RAG=false` antes de cargar la configuración (la config captura
`MIND_RAG` en su primera carga), así que todas las corridas son lexicales y deterministas.

```bash
# Evaluación de relevancia (suite v2, sin clave de API) — rápida, sí apta para CI local
make search-eval

# Benchmark del corpus fixture (opt-in)
make bench-search

# Benchmark de escalabilidad (pesado; 50k/100k requieren --allow-heavy, ya incluido)
make bench-scalability CORPUS=1k     # o 10k | 50k | 100k

# Comparación diferencial motor viejo vs nuevo (por consulta)
make search-diff
```

Scripts directos, si se prefiere:

```bash
MIND_RAG=false bun run scripts/bench-search.ts --suite fixture [--reps 50] [--warmup 5]
MIND_RAG=false bun run scripts/bench-search.ts --suite scalability \
    --corpus 1k|10k|50k|100k [--allow-heavy] [--reps N] [--warmup W] \
    [--classes a,b] [--seed 20261017] [--budget-ms 300000] [--out archivo.json]
MIND_RAG=false bun run scripts/search-diff.ts --emit <out.json>
MIND_RAG=false bun run scripts/search-diff.ts --compare <old.json> <new.json> --out <diff.json>
```

El harness incluye un **presupuesto de tiempo** (`--budget-ms`, por defecto 300 000): si se
agota, la pasada de latencia se aborta limpiamente y el reporte queda marcado como
`aborted`.

## Generación del corpus sintético

La suite `scalability` genera un corpus **determinista y sembrado** (seed por defecto
`20261017`) con `mulberry32`, un generador PRNG reproducible:

- **Vocabulario diverso con sesgo Zipf.** Se construye un vocabulario sintético
  (`buildSyntheticVocabulary`, ~6 000 términos) más listas de palabras ES/EN; cada
  documento muestrea términos con un sesgo **Zipf-like** (potencia > 1 favorece la cabeza),
  evitando un corpus repetitivo que subestimaría el vocabulario y los trigramas distintos.
- **Tamaños** `CORPUS_SIZES`: `1k`, `10k`, `50k`, `100k` documentos.
- **Determinismo.** Misma seed y mismo tamaño ⇒ mismo corpus; el hash de resultados entre
  procesos es estable (ver "Determinismo").

Esto responde a la condición aprobada (PENDIENTE 2): corpus con diversidad razonable de
vocabulario y longitudes. Los documentos sintéticos **subestiman** la diversidad del
corpus real, por eso a 50k se usan **ambas** fuentes (real y sintética) en la validación.

## Clases de latencia

Las consultas se agrupan por clase para evitar promedios engañosos. Para la suite fixture,
`classOf()` deriva la clase del tipo de caso v2: los casos con filtro
(`space`/`tag`/`tier`) colapsan a `filter`; los negativos N0 a `irrelevant`; el resto
conserva su tipo. Las clases fuzzy-específicas son `typo`, `first3typo`, `transposition`,
`insertion`, `deletion`, `substring`; la clase trigram-específica es `substring`. La suite
de escalabilidad define un conjunto pequeño y determinista de consultas que cubre esas
clases.

## Repeticiones y warm-up

Cada consulta se ejecuta `--warmup` veces sin medir y luego `--reps` veces midiendo. La
validación de 50k usó `--reps 2 --warmup 1` (idéntico entre motores para comparaciones
apples-to-apples); con ese valor cada clase tiene n=16 y los **p95/p99 son ruidosos** — el
**p50** y los bytes son la señal fiable. Para corridas de fixture se pueden subir `reps` y
`warmup`.

Los percentiles son **interpolación lineal** sobre el arreglo ordenado
(`percentile()`), y se reportan `n`, `mean`, `min`, `max`, `p50`, `p95`, `p99`.

## Medición de tamaño

`dbstat` **no está disponible** en este build de `bun:sqlite` (`no such table: dbstat`), y el
`sqlite3` CLI no está instalado. El tamaño se mide por **`VACUUM INTO`** sobre una copia:

- `db_with_trigram_bytes`: base compacta con el índice trigram.
- `db_without_trigram_bytes`: base compacta tras retirar el índice trigram.
- `trigram_overhead_bytes` / `trigram_ratio`: diferencia y proporción.

Los megabytes del informe son **decimales** (bytes / 1e6). Las filas de distintos esquemas
**no** son byte-comparables entre sí (el trigram v9 guardaba contenido; v10 es contentless);
la base **sin** trigram sí lo es, y es lo que hace significativa la comparación del índice.

El costo de escritura se mide con `add`/`update`/`delete` sobre un store sembrado
(`write_{add,update,delete}_p50`). RSS se mide con `process.memoryUsage()` (delta tras
sembrar el corpus).

## Costo de cold cache

El canal fuzzy P-A construye el **vocabulario plegado global** en la primera consulta tras
una escritura. Se mide limpiamente calentando JIT, haciendo una escritura descartable (que
incrementa la generación y **invalida** el cache) y luego cronometrando la siguiente
consulta fuzzy (COLD) contra consultas en caliente (warm). El script es
`/tmp/opencode/search-optimization/t4f/cold-cache.ts`; los resultados se agregan en
`cold_cache_pa_only`. Es un costo **por store, una vez tras la última escritura**, no por
consulta.

Valores medidos del costo cold-cache de P-A: **+30,4 ms** a 1k, **+280,7 ms** a 10k y
**+1.552,9 ms** a 50k. Son mediciones de un host; la señal durable es que el costo es
único por store y crece con el vocabulario, no por consulta.

## Determinismo

El harness emite un **hash estable** de los resultados + scores por consulta
(ignora timestamps). Se compara entre **procesos separados**: dos corridas del mismo motor
deben producir el **mismo hash** (`stable: true`). Esto verifica que el canal fuzzy es
determinista (tokens y vocabulario ordenados, `ORDER BY` explícito). El hash también permite
detectar cuándo dos motores conservan ranking idéntico (por ejemplo, P-A v10 a 1k coincide
exactamente con old v9 a 1k).

## Comparación diferencial old-vs-new (`search-diff`)

`scripts/search-diff.ts` corre en **dos modos**:

- `--emit <out.json>`: ejecuta la suite v2 contra el motor del **directorio actual** y
  escribe un snapshot por caso (top-k, provenance por resultado, métricas agregadas).
- `--compare <old.json> <new.json> --out <diff.json>`: compara dos snapshots **por query**:
  refs añadidos/quitados/reordenados, cambios de score y confianza, FP nuevos, TP perdidos y
  corregidos, y deltas de métricas agrupados por origen/nivel/tipo.

Para comparar dos motores se ejecuta `--emit` una vez en **cada árbol** y luego `--compare`.
La copia de referencia pre-optimización vive en
`/tmp/opencode/search-optimization/old-engine/` (un worktree; sin ramas de entorno en
producción). Un **auto-diff** (viejo vs nuevo con el mismo motor) debe producir **cero
cambios**.

## Evaluación de relevancia (`search-eval`)

La suite versionada vive en `test/search-eval/` y `scripts/search-eval.ts`. Es
**determinista y offline** (RAG off) y no requiere clave de API.

- **Suite v1 (297 casos):** **inmutable** (`baseline.fixture.json`, hash interno
  `1f5bf98a…`). Ninguna tarea la sobrescribe; sirve de comparación histórica. El
  baseline v1 congelado acierta **246/297**.
- **Suite v2 (298 casos):** versionada (`baseline.fixture.v2.json`, historical/old-engine)
  y `baseline.fixture.v2.optimized.json` (motor optimizado), con MRR y nDCG@10. Es un gate
  de **estabilidad** de snapshots, no un piso de comportamiento deseado.
- **Baseline v2 del motor actual:** **237/298**, P **94,0 %**, R **88,5 %**, MRR
  **0,9505**, nDCG@10 **0,9253**, FP **42**. La suite mide también recall de errores en
  los primeros tres caracteres, que se mantiene en **8,3 % (1/12)**.
- **Métricas:** P@k, R@k, TP/FP/FN, noise rate, MRR y nDCG@10, más diffs por consulta.

## Rutas de artefactos

- **En el repo (commiteados):** `scripts/bench-search.ts`, `scripts/search-diff.ts`,
  `scripts/search-eval.ts`, `test/search-eval/**` (corpus, casos, baselines, métricas),
  `test/search-bench-smoke.spec.ts`, y las suites de regresión.
- **Agregados de la iteración 00004 (efímeros, `/tmp`):**
  - `/tmp/opencode/search-optimization/m1a/` — sondas runtime FTS5 (R1, contentless,
    `detail=none`), `summary.md` + `results.json`.
  - `/tmp/opencode/search-optimization/m1b/` — desglose de costo fuzzy, vocabulario,
    `summary.md` + `measurements.json`.
  - `/tmp/opencode/search-optimization/t3a/`, `t3b/` — migración v9→v10 y prototipos.
  - `/tmp/opencode/search-optimization/t4a/` — motores old v9 y P-D (dev) a 1k/10k/50k,
    `measurements.json`, `summary.md`.
  - `/tmp/opencode/search-optimization/t4f/` — P-A v10 a 1k/10k/50k, cold cache,
    migración dev v10→v11, `pa-*.json`, `cold-*.json`, `migration-evidence.json`,
    `measurements.json`, `summary.md`.

> Los artefactos de `/tmp` pueden no sobrevivir a un reinicio. Los números clave están
> transcritos en el [informe técnico histórico](history/00004-search-optimization/search-optimization-report.md);
> los **scripts** para regenerarlos están commiteados.

## Límites

- **Milisegundos dependientes de máquina/disco.** La señal durable son los ratios y los
  bytes, no los ms absolutos de un host.
- **`reps` bajo ⇒ p95/p99 ruidosos.** Interpretar p50 y tamaños.
- **RSS** es una medición de proceso, no de uso de página del sistema operativo.
- **100k de producción es una proyección**, no una medición (extrapolación lineal con
  escala observada super-lineal; cota optimista). La investigación 00005 B sí midió un
  **prototipo sintético** a 100k, pero sólo para comparar estrategias; no describe el
  corpus real de producción.
- **El canal semántico no es medible offline** (RAG off, sin embeddings en fixtures); no se
  falseó.
