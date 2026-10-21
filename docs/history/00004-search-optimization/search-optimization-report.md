> **Historical report for feature 00004-search-optimization.** Frozen on 2026-10-20.
> Current behavior: [Search engine](../../search-engine.md).

# Informe técnico — Optimización del motor de búsqueda (00004)

- **Feature:** `00004-search-optimization`
- **Repositorio:** `/home/gabrielmoran/Git/mind`
- **Fecha:** 2026-10-17
- **Estado final:** R1 corregido + trigram contentless + fuzzy **P-A-only** (cache de
  vocabulario, plegado único, OSA en banda, `ORDER BY` determinista) + **schema v10
  definitivo**. Los esquemas intermedios dev v10 (con el diccionario `search_terms` /
  `memory_terms`) y dev v11 (sin diccionario) **nunca se publicaron**; el v10 final
  consolidado no tiene diccionario y es funcionalmente idéntico a aquel dev v11. Las
  etiquetas de motor «P-A v10» de este informe corresponden a ese estado (otrora
  rotulado «dev v11»).
- **Runtime de medición:** Bun 1.3.14, `bun:sqlite` con SQLite 3.53.0, `MIND_RAG=false`
  en todas las corridas.
- **Documentos relacionados:** comportamiento vigente en
  [`search-engine.md`](../../search-engine.md), metodología de benchmarks
  [`search-benchmarks.md`](../../search-benchmarks.md), e investigación posterior
  [`search-next-steps-research.md`](../00005-search-followup/search-next-steps-research.md).

## Etiquetas de evidencia

Cada afirmación numérica lleva una etiqueta:

- `[MEDIDO]` — observado en una corrida registrada en un artefacto (ver `search-benchmarks.md`).
- `[CALCULADO]` — aritmética derivada de valores medidos.
- `[PROYECTADO]` — extrapolación no medida directamente.
- `[CÓDIGO]` — hecho verificado leyendo el código de producción.
- `[LITERATURA]` — respaldado por fuentes externas o por documentos previos de la feature.

Las **conclusiones medidas** se separan explícitamente de las **recomendaciones**: el
cierre de cada sección marca qué es un hecho medido y qué es una propuesta para el
futuro. Ningún número de este informe fue inventado; donde algo no se pudo medir se
declara.

---

## 1. Problemas identificados

La auditoría previa de búsqueda (feature `00003`, retirada de `docs/`; su contexto
vigente está en [`search-engine.md`](../../search-engine.md)) dejó tres defectos
críticos y varias palancas de alto valor sobre este corpus (real, ~4 493 memorias /
86 espacios, schema v9):

1. **R1 — recall silencioso con acentos.** El índice trigram guardaba el texto **crudo**
   (con diacríticos) mientras las consultas se plegaban con `stripDiacritics`; así, una
   subcadena como `figuracio` no encontraba `configuración`. Era una pérdida de recuperación
   **sin error visible**. `[MEDIDO]` (auditoría §H1).
2. **Costo del fuzzy.** El canal fuzzy consumía ~**74,9 %** del tiempo de canales
   (~95 ms por llamada) en **cada** consulta no vacía. El desglose posterior (`m1b`)
   mostró que el 61 % de `store.search` (p50 ~75,4 ms) era el **re-plegado de hasta
   2 000 documentos** por consulta, no el cálculo de distancia (OSA ~0,03 ms). `[MEDIDO]`.
3. **Tamaño del trigram.** El índice trigram con `detail=full` y copia de contenido
   representaba ~**52 %** de la base compacta (26,18 MB; 5,17× el texto) y ~2× el costo
   de escritura. `[MEDIDO]`.

Además, dos defectos de corrección menores y una limitación de diseño:

4. **Dependencia del prefijo exacto de 3 caracteres.** El prefiltro fuzzy seleccionaba
   candidatos por los primeros 3 caracteres del token, de modo que **un error en los
   primeros 3 caracteres de una palabra era irrecuperable** (`[CÓDIGO]`, `FUZZY_PREFIX_LENGTH
= TRIGRAM_MIN_LENGTH = 3`). La auditoría lo documentó como límite de diseño.
5. **Determinismo.** El prefiltro `LIMIT 2000` del vocabulario fuzzy **no tenía `ORDER BY`**,
   así que la selección de candidatos era estable-pero-arbitraria ante escrituras
   concurrentes, `VACUUM` o cambios de plan. `[MEDIDO]` (24/62 consultas arquetípicas
   tocaban el límite).
6. **`detail=none` como candidato.** La Fase 3 pedía evaluar `detail=none` como alternativa
   de tamaño; requería verificación posterior en JS.

El objetivo de la iteración fue **actuar** sobre estos hallazgos con evidencia medida,
**sin cambiar** pesos, fórmula de fusión, agreement bonus, buckets de confianza, admission
gate ni el contrato público (CLI/MCP/API).

---

## 2. Soluciones investigadas

La investigación (`research-report.md`; sondas `m1a`/`m1b`) evaluó las siguientes líneas.

### 2.1 R1 y trigram

- **`tokenize='trigram remove_diacritics 1'`** (SQLite ≥ 3.45.0). `[LITERATURA]`/`[MEDIDO]`
  El plegado es bidireccional (query plegada ↔ documento acentuado y viceversa), `ñ→n`,
  y los **combinantes y precompuestos son equivalentes** (`cafe`+U+0301 ↔ `café`);
  mayúsculas/minúsculas se preservan. `[MEDIDO]` No es compatible con `case_sensitive 1`
  y desactiva el `LIKE`/`GLOB` indexado (mind sólo usa `MATCH`).
- **`content=''` + `contentless_delete=1`** (SQLite ≥ 3.43.0). `[MEDIDO]` Preserva
  `INSERT`/`DELETE`/`INSERT OR REPLACE`/`UPDATE` completo/`delete-all`/`bm25`/`rank`/`MATCH`;
  las columnas de contenido leídas son `NULL` (no usadas). `[MEDIDO]` Ahorra **−6,27 MB**
  en el corpus real. Consecuencia obligatoria: `ensureIntegrity` (`'rebuild'`) **debe**
  reworkarse a `delete-all` + repoblar (`[CÓDIGO]`).
- **`detail=none`.** `[MEDIDO]` Rompe toda query > 3 caracteres; descomponerla en `AND` de
  trigramas + verificación en JS daba recall exacto pero **FP 5–8 %**, sobre-admisión,
  pérdida del ranking por frase y complejidad alta.

### 2.2 Fuzzy

Cinco alternativas (R2):

- **P-A — micro-optimización**: cache del vocabulario plegado por store, plegado único,
  OSA en banda (early-exit), `ORDER BY` determinista. Barata y reversible.
- **P-B — diccionario persistente** `term+df` mantenido en escrituras + scan completo
  (sin prefijo de 3). Elimina el plegado por consulta y la dependencia del prefijo.
- **P-C — índice trigram de términos / SymSpell delete-2**: candidatos baratos pero build
  caro (~648 ms para delete-2, ~1 M entradas).
- **P-D — diccionario por-documento** (`search_terms` + `memory_terms`), mantenido
  transaccionalmente, para eliminar además el plegado de cobertura.
- **Umbral de distancia**: mantener `FUZZY_MAX_DISTANCE=2` sin cambiarlo a ciegas; medir
  FP primero.

### 2.3 Evaluación e infraestructura

Suite **v1 inmutable** (297 casos) + **v2 versionada** (298 casos: ~+250 con ejes exigidos,
adversariales anti-bias y negativos duros), métricas MRR/nDCG@10, `scripts/bench-search.ts`
y `scripts/search-diff.ts` (worktrees) commiteables, opt-in fuera de `bun test`.

---

## 3. Prototipos implementados

Se implementaron **en copia aislada** del repositorio (nunca sobre `data/mind.db` vivo;
instrumentación sólo en la copia) y luego se promovió **sólo el ganador** a producción.

- **P-A (ganadora, en producción).** `[CÓDIGO]` En `src/store/repositories/search-repository.ts`:
  - `globalVocabulary()` cachea el vocabulario plegado de **todos** los documentos,
    calculado una vez por store y **invalidado por la generación de escritura**
    (`storeGeneration`/`bumpStoreGeneration` en `src/store/shared/matching-tokenizer.ts`,
    `WeakMap<Database, number>`; `FtsHelper` incrementa la generación en cada
    insert/update/delete). Un search en régimen estable **no** paga round-trip SQL de
    generación de candidatos.
  - `expandFuzzyTokens()` pliega una sola vez, ordena tokens y vocabulario (determinista),
    y usa `bandedOsa()` (OSA con cota y salida temprana) con **banda de longitud** y la
    regla de prefijo-3 documentada.
  - `foldedWords()` en `matching-tokenizer.ts` es el **único** plegado compartido por el
    vocabulario de candidatos y la cobertura por documento (no pueden divergir).
- **P-D (prototipo, retirada).** `[CÓDIGO]` Tablas `search_terms(term, df)` +
  `memory_terms(memory_id, term)` mantenidas en escrituras, canal fuzzy sin prefijo-3.
  Se implementó en un esquema **dev-only** (nunca publicado) y **se retiró** al medir el
  costo a escala (ver §5 y §8). El esquema final v10 no las incluye.
- **P-B y P-C** quedaron como prototipos medidos, no adoptados.

---

## 4. Comparaciones cuantitativas

### 4.1 Costo del fuzzy en el corpus real (~4,5k)

| Medición                              | Valor                          | Etiqueta   |
| ------------------------------------- | ------------------------------ | ---------- |
| Fuzzy p50 baseline v9 (T2, 4 496 mem) | **104,9 ms**                   | `[MEDIDO]` |
| Fuzzy p50 prototipo P-A sobre v9      | **29,3 ms** (~3,6× más rápido) | `[MEDIDO]` |
| Fuzzy p50 producción P-A+P-D (v10)    | 68,3 ms (~1,5× vs baseline)    | `[MEDIDO]` |

El prototipo P-A aislado mostró que **eliminar el re-plegado por consulta** es la palanca
real: 104,9 → 29,3 ms. `[MEDIDO]`

### 4.2 Escalabilidad sintética (1k / 10k / 50k), motor viejo v9 vs P-A v10

Generador determinista `scripts/bench-search.ts --suite scalability` (seed `20261017`),
`--reps 2 --warmup 1`. Mediana (p50) en ms; almacenamiento por `VACUUM INTO`.

| Corpus | Motor       |   total p50 |   fuzzy p50 | trigram p50 |   DB compacta | índice trigram |
| -----: | :---------- | ----------: | ----------: | ----------: | ------------: | -------------: |
|     1k | old v9      |        56,7 |        55,8 |        50,2 |       5,67 MB |        3,10 MB |
|     1k | **P-A v10** |    **31,1** |    **30,7** |    **29,0** |   **4,89 MB** |    **2,31 MB** |
|    10k | old v9      |       335,5 |       406,4 |       311,6 |      53,82 MB |       29,95 MB |
|    10k | **P-A v10** |   **279,3** |   **356,7** |   **272,8** |  **46,26 MB** |   **22,39 MB** |
|    50k | old v9      |     1 742,1 |     1 754,9 |     1 618,2 |     268,37 MB |      149,44 MB |
|    50k | **P-A v10** | **1 676,3** | **1 664,2** | **1 614,1** | **230,63 MB** |  **111,70 MB** |

`[MEDIDO]` (t4f, `pa-{1k,10k,50k}.json` + t4a `old-*.json`).

A 50k, P-A v10 mejora al motor viejo en total p50 **−3,8 %** (1 676,3 vs 1 742,1 ms),
fuzzy p50 **−5,2 %** (1 664,2 vs 1 754,9 ms), base compacta **−14,1 %** (230,63 vs
268,37 MB) y **−25,3 %** en el índice trigram (111,70 vs 149,44 MB). La **base sin trigram
es idéntica** entre ambos (118,93 MB); toda la reducción de DB proviene del trigram
contentless. `[MEDIDO]`/`[CALCULADO]`

### 4.3 Costo de escritura y memoria

| Corpus | Motor       |      add/upd/del p50 (ms) | RSS delta |
| -----: | :---------- | ------------------------: | --------: |
|    50k | old v9      |     0,177 / 0,194 / 0,158 |  129,5 MB |
|    50k | **P-A v10** | **0,172 / 0,177 / 0,158** |  129,1 MB |

`[MEDIDO]` El camino de escritura es **igual o levemente mejor** (sin mantenimiento de
diccionario). El RSS es prácticamente plano.

### 4.4 Costo de primer acceso (cold cache) de P-A

P-A construye el vocabulario global en la primera consulta fuzzy **tras una escritura**;
la penalización equivale al `SELECT name, content` + plegado: `[MEDIDO]`

| Corpus | términos vocab | cold fuzzy − warm fuzzy p50 |
| -----: | -------------: | --------------------------: |
|     1k |          7 020 |                **+30,4 ms** |
|    10k |         26 126 |               **+280,7 ms** |
|    50k |        106 126 |             **+1 552,9 ms** |

Es un costo **por store, una vez tras la última escritura**, no por consulta: un servidor
MCP/web de vida larga lo paga una vez.

### 4.5 Proyección a 100k `[PROYECTADO]`

Extrapolación lineal 10k→50k (la escala observada es levemente **super-lineal**, así que
es una cota optimista):

| Motor       |      total p50 |      fuzzy p50 |  DB compacta |
| :---------- | -------------: | -------------: | -----------: |
| old v9      |     3 500,3 ms |     3 440,6 ms |     536,6 MB |
| P-D (dev)   |     5 008,8 ms |     5 463,8 ms |     971,7 MB |
| **P-A v10** | **3 422,5 ms** | **3 298,5 ms** | **461,1 MB** |

### 4.6 Calidad (suite v2, 298 casos / 286 relevantes)

| Motor                             |  passed |          P |          R |        MRR |    nDCG@10 |     FP |      FN |
| :-------------------------------- | ------: | ---------: | ---------: | ---------: | ---------: | -----: | ------: |
| baseline v1 congelado (297 casos) |     246 |     97,9 % |     91,6 % |          — |          — |     17 |     191 |
| historical v2 (motor viejo v9)    |     236 |     94,0 % |     88,2 % |     0,9505 |     0,9227 |     35 |     333 |
| **optimizado v2 (P-A v10)**       | **237** | **94,0 %** | **88,5 %** | **0,9505** | **0,9253** | **42** | **322** |

`[MEDIDO]` (`baseline.fixture.v2.json` y `baseline.fixture.v2.optimized.json`).

La mejora frente al baseline v2 es pequeña pero real: **+1 caso**, recall +0,3 pp, nDCG
+0,3 pp, y **R1** eleva el segmento `diacritics` de 12/14 → 13/14 y `substring` de R
93,6 % → 94,8 %. El precio es **FP 35 → 42** (ver §7).

---

## 5. Cambios efectivamente incorporados

### 5.1 R1 + trigram contentless

- `[CÓDIGO]` `src/store/schema.ts`: DDL del índice trigram =
  `tokenize='trigram remove_diacritics 1', content='', contentless_delete=1`.
- `[CÓDIGO]` Migración `MIGRATE_V9_TO_V10` hace `DROP` + `CREATE` + repoblar (verificado:
  `CREATE ... IF NOT EXISTS` **no** actualiza opciones).
- `[CÓDIGO]` `recoverTrigramIndex()` en `src/store/shared/fts-helpers.ts` reemplaza el
  `'rebuild'` insoportado por `delete-all` + reinsertar desde `memories`; `trigramIndexProblems()`
  valida paridad de conteo y huérfanos.

### 5.2 Fuzzy P-A-only

- `[CÓDIGO]` El canal fuzzy usa el **vocabulario plegado completo y cacheado por
  generación** (sin el `LIMIT 2000` no determinista), `bandedOsa` y `ORDER BY` determinista
  (tokens y vocabulario ordenados, coincidencias heredan el orden).
- `[CÓDIGO]` El diccionario P-D era un prototipo **dev-only** (nunca publicado). Se
  retiró del esquema consolidado: el `SCHEMA_SQL` v10 y `MIGRATE_V9_TO_V10` **no** crean
  `memory_terms`, `idx_memory_terms_term` ni `search_terms`. Las filas de `memories`
  nunca se modifican.
- `[MEDIDO]` Un hash de resultados de 1k de P-A v10 **es igual** al del motor viejo v9
  (`a32a66c1…`): a 1k la P-A preserva el ranking exacto; 10k/50k divergen coherentemente con
  la eliminación del prefiltro truncado por consulta. P-A 1k y 10k son **byte-idénticos
  entre procesos** (determinista).

### 5.3 Sink de diagnóstico (default-off)

- `[CÓDIGO]` `setSearchDiagnosticsSink` / `MIND_SEARCH_DIAG=1` en `search-repository.ts`:
  emite **sólo conteos y tiempos** (nunca contenido, nombres ni texto de consulta). Apagado
  el costo es un chequeo de slot + una lectura de env; no altera resultados ni orden
  (test de equivalencia en `test/search-diagnostics.spec.ts`).

### 5.4 Herramientas y evaluación

- `[CÓDIGO]` `scripts/bench-search.ts` (latencias por clase, telemetría por canal,
  escritura, tamaño por `VACUUM INTO`, RSS, determinismo; `--suite fixture|scalability`).
- `[CÓDIGO]` `scripts/search-diff.ts` (old-vs-new por consulta vía worktrees).
- `[CÓDIGO]` suite v2 + MRR/nDCG@10 (`test/search-eval/`, `test/search-scenarios.spec.ts`).
- `[CÓDIGO]` `test/fuzzy-search.spec.ts` fija la regla del prefijo-3 documentada.

### 5.5 Esquema v10 definitivo

- `[CÓDIGO]` `SCHEMA_VERSION = 10`. `MIGRATE_V9_TO_V10` construye **directo** el estado
  final: `DROP` + `CREATE` del trigram contentless (`remove_diacritics 1`,
  `content=''`, `contentless_delete=1`) + repoblar desde `memories`, y **no** hay
  diccionario. Un v9 corre `v9→v10` en la misma apertura y queda idéntico a un fresh v10.
  Los esquemas dev v10 (con diccionario) y dev v11 (sin diccionario) nunca se publicaron;
  la compatibilidad `v10→v11` se eliminó del motor. Las bases dev aún rotuladas `11` se
  normalizan a `10` con `scripts/normalize-dev-db.ts`.
- `[MEDIDO]` (histórico, dev-only) Migración desde una base dev previa con diccionario
  (86 espacios / 4 497 memorias): `search_terms`/`memory_terms`/índice quedan ausentes
  (29 891 `search_terms` y
  456 997 `memory_terms` en la base previa), los conteos de `spaces`/`memories`/`tags`/`links`
  se conservan **idénticos**, `quick_check=ok`, `fk_check=0`, y migrated-vs-fresh da el mismo
  conjunto de resultados (`max_score_delta` 2,85e-4). `[MEDIDO]`

---

## 6. Resultados antes/después

| Dimensión                        |                            Antes (v9) |                         Después (P-A v10) |                                          Δ |
| :------------------------------- | ------------------------------------: | ----------------------------------------: | -----------------------------------------: |
| R1 (subcadena con acentos)       | falla (`figuracio` ↛ `configuración`) |                                 encuentra |                                  corregido |
| Fuzzy p50 real (~4,5k)           |                104,9 ms (baseline T2) |                   29,3 ms (prototipo P-A) |                                      ~3,6× |
| total p50 @50k                   |                            1 742,1 ms |                                1 676,3 ms |                                     −3,8 % |
| fuzzy p50 @50k                   |                            1 754,9 ms |                                1 664,2 ms |                                     −5,2 % |
| DB compacta @50k                 |                             268,37 MB |                                 230,63 MB |                                    −14,1 % |
| índice trigram @50k              |                             149,44 MB |                                 111,70 MB |                                    −25,3 % |
| trigram real (v9)                |                              26,18 MB |                     ≈19,9 MB (`−6,27 MB`) | −24 % (sobre el corpus real) `[CALCULADO]` |
| escritura p50 @50k (add/upd/del) |                     0,177/0,194/0,158 |                         0,172/0,177/0,158 |                              sin regresión |
| calidad v2                       |                        236/298, FP 35 |                            237/298, FP 42 |                                 +1 / +7 FP |
| primera consulta tras escritura  |                                     — | +30,4 / +280,7 / +1 552,9 ms (1k/10k/50k) |                        costo nuevo acotado |

`[MEDIDO]` excepto donde se indique. El `−24 %` del trigram real es `[CALCULADO]` a partir
de la medición M1a (26,18 MB − 6,27 MB ≈ 19,9 MB).

**Qué mejoró:** R1 (recall de acentos), tamaño del trigram (y de la DB), latencia fuzzy
(modesta a escala, grande en el prototipo aislado), determinismo del fuzzy, y la
infraestructura de evaluación/benchmarks.

**Qué empeoró (documentado):** los falsos positivos de la suite v2 subieron de 35 a 42
(impulsados por el nuevo recall de R1, ver §7) y la recuperación de typos en los primeros
3 caracteres quedó en el nivel del baseline (8,3 %; ver §8).

**Qué queda pendiente:** recuperación de errores en los primeros 3 caracteres sin el costo
del diccionario (línea P-C); ver §9 y §10.

---

## 7. Regresiones encontradas y su resolución

### 7.1 FP 35 → 42 (impulsado por R1) — aceptado y documentado

`[MEDIDO]` Al activar `remove_diacritics`, subcadenas que antes no coincidían ahora sí, y
varias son ruido de baja confianza. El diff de la suite clasificó los nuevos FP:
`new_fp` = 14 refs — 2 por plegado R1, 2 por churn de FP, 5 por ruido residual de admisión,
2 por efecto colateral de una ganancia, **2 genuinos en una sola query** y 1 menor.

- **El único FP genuinamente ilimitado está acotado:** `v2-neg-semantic-gap` (control
  negativo, esperado vacío) pasa de `fp 0 → 2`; dos aciertos fuzzy de baja confianza llegan
  al piso de cobertura expandiendo palabras funcionales cortas (`las→{es,la}`, `aves→{es}`,
  `entre→{este}`). Está acotado (2 resultados, baja confianza, 1 de 12 negativos) y se
  compra con el plegado R1 que eleva recall de acentos. **Resolución:** aceptado; el
  agregado P/R/MRR/nDCG **mejora**.
- **Sin pérdidas de recuperación:** cada `lost_tp`/`removed` fue **desplazamiento de
  ranking** (el resultado sigue recuperado), no una pérdida.
- **[MEDIDO]** 8 cambios `high → medium` en un documento (`modal-config-configuration`),
  mismo orden relativo — consecuencia de R1, sin regresión de orden.

### 7.2 `v2-first3-accion` sin resolver en **ambos** motores

`[MEDIDO]` El término corregido `accion` no se admite porque `documentSatisfiesQuery`
exige el token plegado literal `eccion`; los hosts de subcadena (`seccion`) sí se
conservan. Es una **limitación preexistente de admisión**, no una regresión relativa. La
admission gate está fuera de alcance (congelada), así que se documenta como seguimiento.

### 7.3 "El prototipo v9 era más rápido que la producción v10"

`[MEDIDO]` La producción P-A+P-D sobre la copia real v10 resultó más lenta que el prototipo
P-D sobre v9 (total p50 131 vs 93 ms; fuzzy 68 vs 43 ms), **verificado independiente del
modo de apertura**. Se atribuyó al mayor tamaño de la DB v10 (88 MB + diccionario) y a
diferencias de build/entorno, no al harness. Se resolvió como parte de la decisión de
retirar P-D (§8). La cadena "+2 FP" de R1 y esta observación no se consideraron bloqueantes.

### 7.4 Migración

`[CÓDIGO]`/`[MEDIDO]` El `'rebuild'` no soportado en contentless se reworkó a `delete-all` +
repoblar. La migración **final v9→v10** sobre copia real pasó (versión, opciones, paridad de
conteo/rowids, huérfanos, `quick_check`, `fk_check`, equivalencia fresh-vs-migrada, rollback e
interrupción sin índices parciales). (Histórico, dev-only: la ahora **eliminada** migración
`v10→v11` sobre copia real también pasó en su momento; el motor ya no la incluye.) No se perdió
ningún dato original.

---

## 8. Decisiones descartadas y justificación

### 8.1 P-D (diccionario por-documento) — **rechazada por costo a escala**

Se había elegido **P-A + P-D combinados** tras T2 (first3typo recall 8,3 % → 86,1 %,
v2 236 → 244, MRR .9505 → .9825). La medición real de 50k (T4a) mostró que P-D **no es
aceptable a escala** `[MEDIDO]`:

| Métrica @50k        |     old v9 |                                        P-D (dev) |
| :------------------ | ---------: | -----------------------------------------------: |
| total p50           | 1 742,1 ms |                       **2 446,5 ms** (más lento) |
| fuzzy p50           | 1 754,9 ms |                                   **2 652,7 ms** |
| DB compacta         |   268,4 MB | **485,9 MB** (diccionario 255,3 MB = **52,5 %**) |
| rebuild diccionario |          — |                                       **15,3 s** |
| cold open           |          — |                                       **19,3 s** |

El cruce de latencia ya aparecía **entre 1k y 10k** (1k: P-D 42,9 vs old 56,7; 10k: P-D
396,6 vs old 335,5). **Decisión (fallback §8bis): entregar P-A-only y retirar el
diccionario** (entonces rotulado «dev v11»; consolidado en el `v10` final).
Pérdida aceptada y documentada: first3typo 86,1 % → 8,3 %,
v2 244 → 237, MRR .9825 → .9505. Línea futura: índice trigram sobre términos (P-C).

### 8.2 Min-prefix 1/2/3 — **descartado**

`[MEDIDO]` El barrido de T2 mostró que **cualquier piso de prefijo (< 3) hace colapsar**
la ganancia de first3typo: el prefiltro por prefijo es lo que limita el recall a errores
fuera de los primeros 3 caracteres. La eliminación del prefijo (P-D) era load-bearing;
sin ella, un min-prefix no recupera nada.

### 8.3 `detail=none` — **descartado para producción**

`[MEDIDO]` El ahorro adicional (`−16,57 MB`) **no justifica**, con la evidencia actual, la
complejidad de modificar recuperación/verificación/ranking: rompe toda query > 3 caracteres
y exige descomposición + post-verificación con FP 5–8 %. **No** es "técnicamente inviable"
(se documenta el prototipo), sino "complejidad no justificada".

### 8.4 Eliminar `token_set` y otras palancas

La auditoría mostró `token_set` con **0 flips**, pero la restricción de alcance prohibía
tocar la fórmula/pesos en esta iteración, así que **no se eliminó** (queda como
recomendación). La agrupación de canales lexicales antes de fusionar con el semántico, RRF
y la calibración de confianza también quedaron fuera de alcance.

---

## 9. Riesgos restantes

- **Pérdida de recall en los primeros 3 caracteres.** `[MEDIDO]` La regla de prefijo-3 de
  P-A deja `first3typo` en 8,3 % (1/12). Recuperarlo exige una estructura (P-C: trigram
  sobre términos) que no se implementó para no reintroducir el costo de P-D.
- **Costo de cold cache.** `[MEDIDO]` Tras una escritura, la primera consulta fuzzy paga
  el plegado del vocabulario (+1,55 s a 50k). Es por store y una vez; en servidores de
  vida larga con escrituras frecuentes podría notarse.
- **Ruido de palabras funcionales.** `[MEDIDO]` La expansión fuzzy de tokens cortos de
  alta frecuencia produce FP acotados (2 en un control negativo). Sin un filtro por
  `df`/longitud, el ruido persiste aunque acotado.
- **`first3-accion` (admisión).** `[MEDIDO]` La admission gate exige un token plegado
  literal; un término corregido sólo por fuzzy nunca la satisface. Límite preexistente.
- **Latencia absoluta dependiente de la máquina.** `[MEDIDO]` Los ms son de un host; la
  señal durable son los **ratios** y los **bytes**. `reps=2` → p95/p99 ruidosos.
- **`remove_diacritics` sólo latino.** `[LITERATURA]` El plegado de SQLite es sólo latino;
  `stripDiacritics` (NFD) quita marcas de todos los scripts → asimetría residual fuera del
  latino (fuera del alcance ES).
- **100k no medido.** `[PROYECTADO]` Sólo extrapolación; la escala observada es
  super-lineal, así que las proyecciones de latencia son cotas optimistas.
- **Escrituras concurrentes / VACUUM y determinismo.** `[CÓDIGO]` El vocabulario P-A se
  invalida por generación de escritura (correcto), pero el costo de recalcular tras cada
  escritura en workloads muy de escritura no se midió a escala.

---

## 10. Próximos pasos recomendados

Las siguientes son **recomendaciones**, no hechos medidos, y ninguna forma parte de esta
iteración (admission/fusión/pesos congelados):

1. **P-C — índice trigram de términos** para recuperar recall _prefix-free_ sin el costo
   de full-scan del diccionario. El build de delete-2 (~648 ms) y las ~1 M entradas deben
   medirse contra el corpus real antes de adoptarlo.
2. **Filtro de ruido fuzzy** por `df`/longitud: suprimir el crédito de cobertura a tokens
   funcionales cortos o exigir ≥1 token ancla largo antes de admitir por fuzzy multi-token.
3. **Admisión de candidatos corregidos por fuzzy**: revisar `documentSatisfiesQuery` para
   que un término corregido sólo por fuzzy pueda admitirse (hoy queda en 1/12).
4. **Costo de cold cache**: considerar warm-up perezoso o reconstrucción incremental del
   vocabulario si el patrón de escrituras lo justifica.
5. **Limpiar deuda de la auditoría** fuera de alcance aquí: `token_set` (0 flips), el
   comentario "tuned" sin artefacto, y la degradación lexical por canal (try/catch).
6. **Medir 100k** si el corpus real se acerca, para reemplazar la proyección lineal.

---

## Reflexión final obligatoria

Las 10 preguntas de la reflexión, respondidas explícitamente.

**1. ¿La solución de fuzzy elegida es la más apropiada o sólo una optimización de la
previa?**
Es una **optimización de la previa (P-A)**, no una re-arquitectura. `[MEDIDO]` Ataca el
driver real (el re-plegado por consulta) con un cache por store + plegado único + OSA en
banda, y preserva el resto del canal. Es la más apropiada **bajo las restricciones** de
esta iteración (sin tocar ranking, sin diccionario persistente); la alternativa que
eliminaba la dependencia del prefijo (P-D) resultó **inviable a escala** por costo, lo que
confirma que P-A es la elección correcta para el presupuesto actual.

**2. ¿Se eliminó la dependencia del prefijo-3? Si no, ¿por qué?**
**No.** `[CÓDIGO]` `FUZZY_PREFIX_LENGTH = 3` sigue vigente y documentado. Se intentó
eliminarla con P-D (que también eliminaba el `LIMIT 2000`), y funcionó a 1k/10k, pero a 50k
el diccionario costaba +255 MB de DB, rebuild 15,3 s y era **más lento** que el motor
viejo. Se revirtió a P-A y se aceptó la limitación: **first3typo 8,3 %**.

**3. ¿Qué costo introducen las estructuras adicionales?**
`[MEDIDO]` El cache de vocabulario P-A es **en memoria** (RSS plano, ~129 MB a 50k); su
costo es de **cold start** tras una escritura: +30,4 / +280,7 / +1 552,9 ms (1k/10k/50k).
El trigram contentless **reduce** el disco (−6,27 MB real; −25,3 % del índice a 50k). El
diccionario P-D (retirado) sumaba +5,22 / +51,03 / +255,26 MB y +0,05–0,30 ms/op de
escritura. `[MEDIDO]`

**4. ¿Tamaño mínimo razonable del trigram sin degradar?**
El trigram contentless **mide ≈19,9 MB** en el corpus real (~4,5k), `[CALCULADO]` desde
26,18 MB − 6,27 MB. Ese es el piso funcional con la capacidad actual (substring preservado
7/7 → sin trigram 1/7). Ir más abajo (`detail=none`) rompe queries > 3 caracteres, así
que **el piso razonable es el contentless**, no un piso de bytes arbitrario.

**5. ¿`detail=none` es inviable o no compensa?**
**No compensa.** `[MEDIDO]` Es técnicamente posible (recall exacto con post-verificación en
JS), pero el ahorro adicional (~−16,57 MB) no justifica el FP 5–8 %, la sobre-admisión, la
pérdida del ranking por frase ni la complejidad de tocar recuperación/verificación en todas
las superficies. Se documenta como prototipo, no se adopta.

**6. ¿Qué optimizaciones mejoran de verdad y cuáles apenas cambian métricas?**
**Mejoran de verdad:** R1 (recall de acentos, corrección funcional), el trigram contentless
(−14,1 % de DB a 50k, −25,3 % del índice), el cache de vocabulario P-A (fuzzy real 104,9 →
29,3 ms en el prototipo) y el determinismo del fuzzy. **Apenas cambian métricas:** la mejora
de latencia a 50k en producción es modesta (total p50 −3,8 %, p95 estadísticamente plano)
y la calidad v2 mejora sólo +1 caso (nDCG +0,3 pp) aunque baja FP estructuralmente por R1.

**7. ¿Qué comportamiento empeoró aunque las métricas globales mejoren?**
`[MEDIDO]` Los **FP subieron 35 → 42** (por R1) y aparecieron 2 FP genuinos en un control
negativo acotado; el `cold start` del fuzzy introdujo un costo nuevo +30/+281/+1 553 ms;
y se **perdió** el recall de first3typo que P-D había alcanzado (86,1 % → 8,3 %). Las
métricas globales de calidad mejoraron ligeramente (P/R/MRR/nDCG) pese a estos efectos.

**8. ¿Qué limitaciones de recuperación siguen sin resolverse?**
`[MEDIDO]`/`[CÓDIGO]` (a) errores en los **primeros 3 caracteres**; (b) admisión de
términos corregidos sólo por fuzzy (`first3-accion`); (c) ruido de palabras funcionales
cortas; (d) el canal semántico desfavorecido y no medible offline (RAG off, sin embeddings
en fixtures) — sin cambios en esta iteración.

**9. ¿Qué complejidad adicional se introduce y cómo se justifica?**
`[CÓDIGO]` Un contador de generación por store (`WeakMap`) para invalidar el cache; un
cache de vocabulario en memoria por instancia de repositorio; `bandedOsa` (OSA con cota y
salida temprana); un sink de diagnóstico default-off; y las tablas de diccionario que se
**añadieron y retiraron** durante el desarrollo (dev v10→dev v11, esquemas nunca publicados).
Se justifica: el cache/`bandedOsa` eliminan el driver
de latencia sin cambiar ranking; el sink permite medir sin alterar resultados; la retirada
del diccionario elimina la complejidad que no pagaba su costo a escala.

**10. ¿Qué harías diferente diseñando desde cero?**
`[RECOMENDACIÓN]` Diseñaría el fuzzy con un **índice de términos persistente pero mínimo**
(P-C: trigram sobre términos o delete-2 justificado con datos de recall reales) desde el
principio, para tener recuperación _prefix-free_ **sin** el full-scan del diccionario
por-documento que hizo inviable P-D. También mediría el **cold start** y el costo por
escritura como criterio de primer nivel para el fuzzy (no sólo p50 de consulta), y dejaría
la admission gate preparada para admitir candidatos corregidos sólo por fuzzy. Mantendría
la disciplina de esta iteración: canales medidos por ablación, baseline inmutable y diffs
por consulta.
