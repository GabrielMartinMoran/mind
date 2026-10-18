# Próximos pasos del motor de búsqueda — Informe de investigación (00005, Parte B)

- **Feature:** `00005-search-followup`
- **Repositorio:** `/home/gabrielmoran/Git/mind`
- **Commit base:** `678f58d3571642006803a4b729209f552e7ad154`
- **Fecha:** 2026-10-18
- **Runtime de medición:** Bun 1.3.14, `bun:sqlite` con SQLite 3.53.0, `MIND_RAG=false`
  en todas las corridas.
- **Alcance de este documento:** **solo la Parte B (investigación)**. La Parte B
  **NO modificó el motor de producción**: cada prototipo corrió en una copia aislada
  sin `.git` bajo `/tmp/opencode/search-followup/`, y la instrumentación fue aditiva
  y neutral por defecto. La Parte A (schema v10 definitivo + invalidación del caché
  cross-process) sí está implementada y se documenta por separado en
  [`search-optimization-followup.md`](search-optimization-followup.md).
- **Documentos relacionados:** informe de la iteración previa
  [`search-optimization-report.md`](search-optimization-report.md) (feature `00004`),
  auditoría [`search-audit.md`](search-audit.md) (feature `00003`), metodología de
  benchmarks [`search-benchmarks.md`](search-benchmarks.md), reporte consolidado de
  Parte B (`.pas/state/active/00005-search-followup/research-report.md`).

## Etiquetas de evidencia

Cada afirmación relevante lleva una etiqueta:

- `[MEDIDO]` — observado en una corrida registrada en un artefacto de
  `/tmp/opencode/search-followup/`.
- `[CALCULADO]` — aritmética derivada de valores medidos.
- `[PROYECTADO]` — extrapolación o estimación de diseño, no medida.
- `[CÓDIGO]` — hecho verificado leyendo el código de producción (con `archivo:línea`).
- `[HIPÓTESIS]` — conjetura razonada sin medición.

Ningún número de este informe fue inventado. Donde algo **no** se pudo verificar se
declara explícitamente. Las condiciones de carrera en la instrumentación y los
límites de la evidencia se detallan en cada sección.

---

## 1. Resumen ejecutivo

El motor de búsqueda es un **pipeline unificado** (`searchMemories`,
`src/store/repositories/search-repository.ts`) que sirve a CLI, MCP y API con fan-out
lógico de canales + fusión ponderada. Su estado actual (tras la Parte A) es
**correcto, determinista y consolidado**:

- **Schema v10 definitivo** (`SCHEMA_VERSION = 10`, `src/store/schema.ts`): trigram
  `contentless` con `remove_diacritics 1`; sin diccionario; migración directa
  v9→v10. `[CÓDIGO]`
- **Caché de vocabulario fuzzy (P-A)** invalidado por `{generation, dataVersion}`, de
  modo que una escritura de **otra** conexión/proceso ya no deja el vocabulario
  obsoleto. `[CÓDIGO]`

Las mediciones de la Parte B identifican un motor **sano para el uso lexical previsto**
(identificadores, substrings, frases) pero con **cuatro oportunidades claras** y dos
límites estructurales. En orden de relación beneficio/costo:

1. **La recuperación SQL no está acotada** y domina la latencia a escala: a 100k una
   consulta `long_nl` materializa **271 263 filas** (2,7× el corpus) para retener
   2 934. `[MEDIDO]` Las etapas de cobertura/admisión son proporcionales al volumen de
   candidatos. Es la palanca de latencia de mayor impacto.
2. **`expandFuzzyTokens` re-copia, deduplica y ordena todo el vocabulario en CADA
   consulta** (~158 ms a 100k; ~94–95 % de su costo). Cachear el vocabulario ordenado
   por generación es un cambio pequeño y localizado. `[MEDIDO]`
3. **Fuzzy prefix-free vía índice trigram sobre términos**: recupera los typos en los
   primeros 3 caracteres (first3 8,3 % → 86,1 %) con costo sub-ms por consulta a 50k.
   Reemplazo viable del full-scan, que no escala. `[MEDIDO]`
4. **Admission gate no consciente de expansiones**: un término corregido sólo por
   fuzzy nunca satisface el gate, y un host de subcadena suprime el fallback relajado.
   `[MEDIDO]`/`[CÓDIGO]`

Dos límites que la evidencia deja **explícitamente abiertos**: (a) no se conoce la
**distribución real de consultas** (proporción que realmente necesita fuzzy), y (b) el
canal **semántico queda fuera del alcance empírico** (RAG off). Ambos se marcan como
experimentos pendientes (§11, §12).

> **Nota de alcance.** La Parte B es investigación; **ninguna** de las alternativas
> de este documento está incorporada a producción. Las recomendaciones son propuestas
> sujetas a decisión humana y a una iteración con su propio contrato de aplicación y
> tests.

---

## 2. Hallazgos verificados

### 2.1 Baseline de calidad actual (motor en producción) `[MEDIDO]`

Suite v2 versionada (298 casos, 286 relevantes), RAG off, motor optimizado P-A v10:

| Métrica           | Valor             | Fuente                                  |
| ----------------- | ----------------- | --------------------------------------- |
| passed            | **237/298**       | `b1/measurements.json → v2.v2[prefix3]` |
| Precisión (P)     | **94,0 %**        | idem                                    |
| Recall (R)        | **88,5 %**        | idem                                    |
| MRR               | **0,9505**        | idem                                    |
| nDCG@10           | 0,9253            | idem                                    |
| FP                | **42**            | idem                                    |
| first3 recall     | **8,33 %** (1/12) | idem                                    |
| negativos (noise) | 3/12              | idem                                    |

Baseline v1 inmutable (297 casos) del informe previo: **246/297**, P 97,9 %, R 91,6 %
`[MEDIDO]` (`search-optimization-report.md` §4.6). El v2 optimizado **+1 caso** sobre el
baseline v2 histórico (236→237) con **FP 35→42**, impulsado por el nuevo recall de R1
(plegado de diacríticos). `[MEDIDO]`

### 2.2 Hechos de código relevantes `[CÓDIGO]`

- Regla de prefijo-3 vigente: `FUZZY_PREFIX_LENGTH = TRIGRAM_MIN_LENGTH`
  (`src/store/repositories/search-repository.ts:56`), `FUZZY_MAX_DISTANCE = 2`
  (`:44`). Un typo en los primeros 3 caracteres es irrecuperable.
- `expandFuzzyTokens` (`:211`) hace `const vocab = [...new Set(vocabulary)].sort()` en
  **cada** llamada (`:216`), aunque `globalVocabulary()` (`:476`) ya devuelve el
  vocabulario cacheado y ordenado.
- La admisión aplica `documentSatisfiesQuery` (`:836`) **después** de materializar
  todas las filas con `content`; el fallback relajado (`:843`) y el last-resort
  (`:852`, `finalRows = rowsById`) admiten por cobertura/provenance sin mirar
  expansiones fuzzy.
- El predicado de admisión (`documentSatisfiesQuery`,
  `src/store/shared/search-fusion.ts:217`) es **provenance-blind**: sólo usa
  literal/morph sobre el texto plegado; nunca recibe las expansiones fuzzy.
- La confianza (`computeConfidence`, `search-fusion.ts:227`) mezcla clase de canal +
  score relativo intra-consulta; no es una probabilidad calibrada.

### 2.3 Hechos de comportamiento medidos

- **`frequent` retiene legítimamente ~20 % de los documentos**: 2 136/10k, 10 624/50k,
  20 518/100k `[MEDIDO]` (`b5/analysis.json`). No debe truncarse a ciegas.
- **LIKE nunca disparó** en la carga de B5 (`like_raw_rows = 0`) porque todos los
  términos ≥3 caracteres. `[MEDIDO]`
- **El rebuild del caché es CPU-bound en el plegado** (`foldedWords`), ~82–84 % del
  costo total; el `SELECT` es 3–4 %. `[MEDIDO]` (`b2/rebuild-breakdown.json`).
- **Determinismo**: todas las estrategias de B1 produjeron hashes byte-idénticos entre
  dos corridas. `[MEDIDO]`

---

## 3. Fuzzy prefix-free (B1)

**Pregunta:** ¿se puede eliminar la dependencia del prefijo-3 sin el costo de P-D
(diccionario por documento), y a qué costo de recall/latencia/almacenamiento?

### 3.1 Prototipos comparados `[MEDIDO]`

Tres estrategias sobre el mismo corpus fixture (298 casos, 2 corridas cada una,
deterministas):

- **prefix3** — baseline P-A actual: vocabulario plegado cacheado + gate de prefijo
  compartido de 3 caracteres + OSA en banda.
- **prefixfree** — scan completo del vocabulario, sin gate de prefijo.
- **trigram-index** — índice invertido de **trigramas de términos** sobre el
  vocabulario único, que poda candidatos antes de la OSA en banda.

| Estrategia       | passed      | P        | R        | FP     | first3 recall     | noise neg | determinista |
| ---------------- | ----------- | -------- | -------- | ------ | ----------------- | --------- | ------------ |
| prefix3 (actual) | 237/298     | .940     | .885     | 42     | 8,3 % (1/12)      | 3/12      | sí           |
| prefixfree       | 244/298     | .969     | .916     | 47     | **86,1 %** (9/12) | 4/12      | sí           |
| trigram-index    | **245/298** | **.973** | **.916** | **44** | **86,1 %** (9/12) | **3/12**  | sí           |

Fuente: `/tmp/opencode/search-followup/b1/measurements.json` (`v2.v2[]`).
`[MEDIDO]`

**Lectura.** `prefixfree` recupera los typos de primeros-3 (`first3R` 0,861 vs 0,083)
pero añade FP (47 vs 42) y ruido de negativos (4/12 vs 3/12). `trigram-index` iguala el
recall first-3 de `prefixfree` con **menos FP (44)** y **ruido de negativos al nivel
baseline (3/12)** y el mayor número de casos aprobados (245).

### 3.2 Distancia d1 vs d2 `[MEDIDO]`

| Estrategia    | d   | passed      | P        | R    | FP  | first3 recall | noise neg |
| ------------- | --- | ----------- | -------- | ---- | --- | ------------- | --------- |
| prefixfree    | 1   | 243/298     | .976     | .912 | 31  | 9/12          | 3/12      |
| prefixfree    | 2   | 244/298     | .969     | .916 | 47  | 9/12          | 4/12      |
| trigram-index | 1   | 240/298     | .959     | .899 | 31  | 9/12          | 3/12      |
| trigram-index | 2   | **245/298** | **.973** | .916 | 44  | 9/12          | 3/12      |

Fuente: `b1/measurements.distance.json`. `[MEDIDO]` Un cap global d1 reduce FP ~30–34 %
sin perder recall first-3, pero **pierde recall de transposiciones** (ver §6 y B4). No es
el default seguro; la guarda recomendada es **distancia dependiente de longitud**
(d1 para tokens ≤5), no un d1 global.

### 3.3 Escalado `[MEDIDO]`

Presupuesto por celda; 40 consultas de escalabilidad × 3 reps tras un warmup.

| tamaño | estrategia    |         | V     |           | build vocab ms | build índice ms | entradas índice | scan/q    | OSA/q   | fuzzy p50 ms | full search p50 ms |
| ------ | ------------- | ------- | ----- | --------- | -------------- | --------------- | --------------- | --------- | ------- | ------------ | ------------------ |
| 1k     | prefix3       | 7 020   | 45    | —         | —              | 8 412           | 5               | 2,9       | 48,9    |
| 1k     | prefixfree    | 7 020   | 31    | —         | —              | 8 412           | 4 801           | 3,6       | 65,9    |
| 1k     | trigram-index | 7 020   | 35    | 10,6      | 37 176         | 267             | 110             | 0,12      | 63,8    |
| 10k    | prefix3       | 26 126  | 354   | —         | —              | 31 307          | 31              | 13,4      | 456,1   |
| 10k    | prefixfree    | 26 126  | 340   | —         | —              | 31 307          | 16 517          | 15,8      | 599,5   |
| 10k    | trigram-index | 26 126  | 327   | 30,5      | 107 048        | 277             | 119             | 0,22      | 471,5   |
| 50k    | prefix3       | 106 126 | 1 893 | —         | —              | 127 175         | 8               | 83,5      | 2 842,5 |
| 50k    | prefixfree    | 106 126 | 1 987 | —         | —              | 127 175         | 91 980          | 114,8     | 3 712,3 |
| 50k    | trigram-index | 106 126 | 1 870 | **175,9** | **430 271**    | 473             | 282             | **0,354** | 3 369,6 |

Fuente: `b1/summary.md` §4 y `b1/scaling-finish.json`. `[MEDIDO]`

- **El scan prefix-free no escala**: su costo es Ω(|V|) por token de consulta, sin gate
  que lo acote; las comparaciones OSA por consulta crecen con |V| (1k ~4,8k → 10k ~16,5k
  → 50k ~92k). Es un prototipo de corrección, no un diseño de producción. `[MEDIDO]`
- **El índice trigram sobre términos rompe la linealidad**: escanea ~0,4 % de |V| a 50k,
  con fuzzy p50 **0,354 ms** (~300× más rápido que prefixfree), a igual recall.
  `[MEDIDO]`
- **Caveat de medición**: el store reutiliza un único vocabulario entre estrategias
  dentro de cada tamaño, así que sólo `prefix3` paga el build (50k ~1,9 s). RSS es
  ruidoso (GC) y no aísla el pie del índice; el tamaño real del índice se caracteriza
  mejor por su número de postings (430 271 a 50k). `[MEDIDO]`
- **El fuzzy no es el cuello del full search a escala**: `full search p50` es
  casi idéntico entre estrategias porque lo dominan los canales base compartidos
  (rungs FTS, plegado de admisión, token-set). `[MEDIDO]`

### 3.4 Recomendación

**Adoptar el índice trigram sobre términos como candidato prefix-free** (si se decide
priorizar recall de typos): restaura first-3 (0,083 → 0,861) al **menor costo fuzzy** de
las tres, con el mejor conteo de la suite y el menor ruido entre los candidatos
prefix-free. **P-D (diccionario por documento) sigue rechazado** (almacenamiento/rebuild
no pagaron a escala en la iteración previa; ver `search-optimization-report.md` §8.1).

**Costos residuales que un diseño de producción debe asumir** `[CÓDIGO]`/`[PROYECTADO]`:
build e invalidación del índice junto al caché de vocabulario (`{generation,
dataVersion}`); fallback para términos cortos (<3 chars) que no tienen trigramas;
cubetas por longitud; tests de determinismo y de ausencia de falsos negativos por
umbral de trigramas. **Nota crítica de B4:** el prototipo trigram-index **tiene falsos
negativos en tokens cortos** (`como→cano`, d2, sin trigrama compartido) y **pierde
5/12 transposiciones a d1**; requiere un fallback a scan directo para términos con pocos
trigramas antes de poder reemplazar la generación prefix-free.

---

## 4. Caché y patrones de escritura (B2)

**Pregunta:** ¿cuánto cuesta el caché de vocabulario fuzzy bajo perfiles de escritura
realistas, y conviene un rebuild incremental?

### 4.1 Las 9 celdas `[MEDIDO]`

Corpus sintético determinista (`seed=20261017`), escrituras locales en un espacio
dedicado. `% cold` = fracción de búsquedas que reconstruyen el vocabulario.

| tamaño | perfil      | S   | W    | % cold | rebuild acum. (ms) | rebuild / tiempo búsqueda | search p50 (ms) | warm p50 (ms) | cold p50 (ms) | write p50 (ms) |
| ------ | ----------- | --- | ---- | ------ | ------------------ | ------------------------- | --------------- | ------------- | ------------- | -------------- |
| 1k     | read-heavy  | 400 | 4    | 1,0 %  | 147,5              | **0,9 %**                 | 41,8            | 41,6          | 94,6          | 0,63           |
| 1k     | mixed       | 400 | 400  | 50,0 % | 7 223,4            | 30,3 %                    | 62,1            | 45,4          | 73,2          | 0,40           |
| 1k     | write-heavy | 400 | 4000 | 100 %  | 15 284,0           | 47,5 %                    | 81,0            | —             | 81,0          | 0,20           |
| 10k    | read-heavy  | 150 | 1    | 1,3 %  | 744,1              | **1,2 %**                 | 368,6           | 367,9         | 832,0         | 0,79           |
| 10k    | mixed       | 150 | 150  | 50,0 % | 28 519,5           | 31,0 %                    | 610,7           | 431,3         | 752,2         | 0,60           |
| 10k    | write-heavy | 150 | 1500 | 100 %  | 56 808,4           | 47,4 %                    | 776,0           | —             | 776,0         | 0,24           |
| 50k    | read-heavy  | 30  | 1    | 3,3 %  | 1 939,7            | **2,5 %**                 | 2 536,5         | 2 478,3       | 2 594,8       | 1,06           |
| 50k    | mixed       | 30  | 30   | 50,0 % | 29 470,6           | 29,0 %                    | 3 492,9         | 2 696,8       | 4 318,9       | 0,62           |
| 50k    | write-heavy | 30  | 300  | 100 %  | 57 525,6           | 45,2 %                    | 4 193,4         | —             | 4 193,4       | 0,24           |

Fuente: `b2/measurements.json` → `sizes.<n>.profiles.*`. `[MEDIDO]`

### 4.2 Costo amortizado (read-heavy) `[CALCULADO]`

Rebuild amortizado por búsqueda y como fracción de una búsqueda **caliente**:

| tamaño | rebuild acum. / búsquedas | amortizado por búsqueda | % de warm p50 |
| ------ | ------------------------: | ----------------------: | ------------: |
| 1k     |            147,5 ms / 400 |             **0,37 ms** |     **0,9 %** |
| 10k    |            744,1 ms / 150 |             **4,96 ms** |     **1,3 %** |
| 50k    |           1 939,7 ms / 30 |             **64,7 ms** |     **2,6 %** |

`[CALCULADO]` a partir de `b2/measurements.json` (cumulative_rebuild_ms ÷ search_count;
÷ `search_ms_warm.p50`). En uso read-heavy (patrón de recall del agente con escrituras
ocasionales) el costo frío es **despreciable**: 1,0–3,3 % de las búsquedas son frías y
el rebuild es **0,9–2,5 %** del tiempo total de búsqueda. El diseño actual ya coalesce
una ráfaga de escrituras en **un** rebuild (las escrituras nunca reconstruyen; sólo la
siguiente búsqueda lo hace). `[MEDIDO]`

### 4.3 Desglose del rebuild `[MEDIDO]`

| tamaño |  filas | términos | SELECT (ms) | fold (ms) | Set build (ms) | sort (ms) | total (ms) | fold share |
| ------ | -----: | -------: | ----------: | --------: | -------------: | --------: | ---------: | ---------: |
| 1k     |  1 000 |    7 020 |         1,6 |      31,0 |            3,3 |       1,8 |       37,8 |     82,0 % |
| 10k    | 10 000 |   26 126 |        13,6 |     308,0 |           38,0 |       8,0 |      367,7 |     83,8 % |
| 50k    | 50 000 |  106 126 |        71,3 |   1 686,3 |          260,6 |      47,2 |    2 065,5 |     81,6 % |

`[MEDIDO]` (`b2/rebuild-breakdown.json`). El rebuild es **CPU-bound en el plegado**, no
en SQL. Fold ~0,031–0,034 ms/documento `[CALCULADO]`. Por esto, **ninguna compactación
de la estructura elimina el costo dominante**; el lever real sería no re-plegar (P-D,
ya rechazado e incompatible con la invalidación cross-process) o el incremental.

### 4.4 Micro-prototipo incremental `[MEDIDO]`/`[PROYECTADO]`

Actualizar un `Map<term, df>` por escritura costaría ~0,03–0,035 ms por escritura
(1 documento plegado + ops de Map). Eliminaría los rebuilds fríos **sólo para
escrituras locales**; las escrituras de otro proceso avanzan `PRAGMA data_version` sin
delta por documento y exigen rebuild completo. Riesgos: corrección transaccional
(seam post-commit en cada write path), cobertura de todos los write paths, un fallo
silencioso corrompe recall. `[PROYECTADO]`

### 4.5 Recomendación

**Mantener el full rebuild; no implementar incremental en esta feature.** En uso
read-heavy el costo frío es 0,9–2,5 % del tiempo de búsqueda (no vale nuevo riesgo). El
costo es material **sólo** en intercalado ajustado y sostenido búsqueda↔escritura en el
mismo proceso (mixed ~30 %, write-heavy ~45 % del tiempo de búsqueda, con ≥10k). Si un
workload futuro convierte "search-after-write" en un dolor medido, revisar el
incremental con `df` exacto, deltas post-commit, fallback a full rebuild para escrituras
externas y matriz de corrección de write paths. **Ganancia barata y de bajo riesgo
recomendada**: eliminar el `[...new Set(vocabulary)].sort()` redundante de
`expandFuzzyTokens` (ver §7).

---

## 5. Admission gate vs fuzzy (B3)

**Pregunta:** ¿qué descarta el gate, por qué, y cómo interactúa con AND/OR/NOT/frases/
prefijos cuando un término sólo fue corregido por fuzzy?

### 5.1 Hechos `[CÓDIGO]`

- El gate (`documentSatisfiesQuery`, `search-fusion.ts:217`) es **provenance-blind**:
  sólo evalúa literal/morph (`documentSatisfiesNode`) sobre `name`+`content` plegados.
  Las **expansiones fuzzy se usan únicamente en el prefilter del canal**, nunca en la
  admisión.
- La admisión corre en `search-repository.ts:836`; si `finalRows` queda vacío, el
  fallback relajado (`:843`) admite por cobertura literal; si aún queda vacío, el
  last-resort (`:852`) conserva **todo** candidato de canal.

### 5.2 Caso medido `[MEDIDO]`

**`v2-first3-accion`**: la consulta es el typo `eccion`, cuya corrección es `accion`. El
gate exige el token plegado literal `eccion`, así que no admite la corrección. Pero un
host de subcadena (`seccion` ⊃ `eccion`) sí contiene ese literal, de modo que **se
admite** y cuenta como FP: mantiene `finalRows` no vacío (6 FP) y **suprime** el
fallback relajado/last-resort que, al quedar vacío, habría admitido los dos documentos
`accion` esperados. Resultado: **tp 0 / fp 6 / fn 2**. Efecto perverso: la admisión es
provenance-blind y una subcadena coincidente puede bloquear los TP corregidos por
fuzzy.

En consultas multi-término, un nodo corregido rompe el AND del grupo; la recuperación
depende de coverage literal y no recibe crédito por expansión.

### 5.3 Propuesta (NO implementada) `[HIPÓTESIS]`

Un **admission gate consciente de evidencia**:

1. Pasar `expansions` + provenance a la admisión.
2. Un término se satisface si literal/morph **o** existe una expansión producida **en
   esta llamada** y presente en el documento.
3. **Ancla literal obligatoria** en grupos multi-término (evita que un documento
   fuzzy-only entre por cobertura de palabras funcionales).
4. Límite de nodos corregidos por grupo.
5. Sin crédito de expansión para tokens cortos/funcionales.
6. Crédito **sub-unidad** en coverage (una expansión vale menos que un literal).

**Riesgos**: ruido/FP, interacción con los fallbacks relajado/last-resort, contrato
engine↔labels, scope creep semántico. **Tests requeridos antes de implementar**:
predicate unitario con expansiones, regresión de la supresión-por-host, ablación del
gate (inexistente hoy), snapshots intencionales.

---

## 6. Falsos positivos por palabras funcionales (B4)

**Pregunta:** ¿cuánto del ruido de FP viene de palabras funcionales/tokens cortos, y qué
guardas lo contienen sin perder recall?

### 6.1 P-A actual casi no tiene FP de fuzzy funcional `[MEDIDO]`

En el motor P-A (`prefix3`) **sólo 3 de 107** expansiones tienen como target una
stopword: el gate de prefijo de 3 caracteres bloquea las expansiones de palabras cortas.
El sobre-recall léxico de palabras funcionales en el baseline (p.ej. `p-es-config`
devuelve 8 documentos sólo-funcionales) viene de los canales **léxico/coverage y LIKE**,
no del fuzzy. `queryHasStopword = 0` en los FP del baseline. `[MEDIDO]`

### 6.2 Un diseño prefix-free desata una explosión funcional `[MEDIDO]`

Sobre los 233 tokens distintos del fixture (`expansions.json`):

| variante           | expansiones | targets stopword | exp/token | tokens ≤3 que expanden       |
| ------------------ | ----------: | ---------------: | --------- | ---------------------------- |
| `prefix3-d2`       |         107 |        3 (2,8 %) | 0,46      | 1                            |
| `prefixfree-d2`    |   **2 375** | **505 (21,3 %)** | **10,19** | **1 864 desde 29 tokens ≤3** |
| `prefixfree-d1`    |         269 |       23 (8,6 %) | 1,15      | 175                          |
| `trigram-index-d2` |       1 843 |     418 (22,7 %) | 7,91      | —                            |
| `trigram-index-d1` |         246 |       19 (7,7 %) | 1,06      | —                            |

Ejemplos reproducidos: `es (len2) → 92` términos; `las (len3) → 29`;
`aves (len4) → {antes, es}`; `entre (len5) → {este}`; `como (len4) → 7`. El mecanismo
está dominado por la **longitud**: los 29 tokens ≤3 caracteres (12 % de los tokens)
generan **1 864/2 375 = 78 %** de todas las expansiones, porque el vecindario de edición
de un token de 2–3 caracteres sobre el vocabulario es enorme. `[MEDIDO]`

**Sólo se hace visible vía el last-resort de admisión**: en el fixture agrega **+1 caso
de ruido de negativos** (`v2-neg-semantic-gap`, `cómo migran las aves entre
continentes`) porque el gate cae al "last resort: conservar todo candidato de canal". El
canal fuzzy por sí solo **no** salta la admisión. Conclusión: **la suite v2 es un
instrumento pobre para FP funcional** (1 caso relevante de 298); extrapolar de ella
subestimaría el riesgo. `[MEDIDO]`/`[CALCULADO]`

### 6.3 Guardas — comparación `[MEDIDO]`

| configuración                |  passed | P        | R    | FP  | first3 | neg noise | recall positivo perdido vs prefix3 |
| ---------------------------- | ------: | -------- | ---- | --- | ------ | --------- | ---------------------------------- |
| **prefix3 baseline**         |     237 | .940     | .885 | 42  | 1/12   | 3/12      | —                                  |
| prefixfree d2                |     244 | .969     | .916 | 46  | 9/12   | 4/12      | 0                                  |
| prefixfree d2 + **d1short**  | **245** | **.972** | .916 | 45  | 9/12   | **3/12**  | **0**                              |
| prefixfree d2 + anchor       |     245 | .972     | .916 | 45  | 9/12   | 3/12      | 0                                  |
| prefixfree d2 + stopword     |     245 | .972     | .916 | 45  | 9/12   | 3/12      | 0                                  |
| prefixfree d2 + **dftarget** |     245 | .958     | .907 | 45  | 9/12   | 3/12      | **4** (`registro`)                 |
| prefixfree **d1** (global)   |     243 | .976     | .912 | 31  | 9/12   | 3/12      | 2                                  |
| trigram d1                   |     240 | .959     | .899 | 31  | 9/12   | 3/12      | **7** (5 transposiciones + 2)      |

> **Nota de arnés:** el FP de `prefixfree` difiere entre §3.1 (**47**, arnés B1) y §6.3
> (**46**, arnés B4, config `prefixfree-d2`). Son arneses/configuraciones distintos, cada
> uno con su fuente etiquetada; no es una contradicción.

**ADOPTAR**:

- **`d1short` — distancia dependiente de longitud (d1 para tokens ≤5)**: elimina el
  ruido funcional (noise 4→3; probes filas 1–2 → 0) **sin pérdida de recall** (0 casos
  positivos perdidos; first-3 sigue 9/12; typo recall 0,79). Preserva
  `xanaveral→canaveral`, `quntuacion→puntuacion` (≥7 chars, d2). `[MEDIDO]`
- **`anchor` — ancla literal informativa obligatoria** en consultas multi-término:
  mismo resultado que stopword, sin lista de stopwords, y **neutraliza directamente el
  leak del last-resort de B3**. Debe tener bypass para consultas de un solo token (donde
  no hay ancla posible). `[MEDIDO]`
- **`stopword`** (lista ES/EN curada pequeña, sólo para expansión fuzzy) como guarda de
  refuerzo, equivalente a `anchor` en esta suite. `[MEDIDO]`

**RECHAZAR tal como están**: `dftarget` (pierde recall en palabras reales frecuentes
como `registro`), **d1 global** como única regla (pérdidas grandes de recall positivo,
sobre todo transposiciones del trigram a d1), `dfskip` con umbral absoluto alto (inerte:
los tokens ofensores tienen df ≤4), `expcap` sola (inerte a cap razonable).

**Nota crítica para §3:** el prototipo **trigram-index tiene falsos negativos en tokens
cortos** (`como→cano` a d2 no comparte trigrama) y **`trigram-d1` pierde 5/12
transposiciones** — debe corregirse (fallback a scan directo para términos con pocos
trigramas) antes de adoptarlo como generación prefix-free.

---

## 7. Rendimiento y escalabilidad (B5)

**Pregunta:** ¿cuál es el cuello real y cómo se descompone por etapa a escala?

### 7.1 Cuello #1 — recuperación SQL sin límites `[MEDIDO]`/`[CÓDIGO]`

`runMatchQuery` (`search-repository.ts:369`) y `runTrigramMatch` (`:406`) corren `MATCH`
**sin `LIMIT`** y **seleccionan `m.content`**; el filtro de cobertura se aplica en JS
**después** de que cada fila (con contenido) cruza la frontera SQLite→JS
(`rows.filter(...)`, `:781`/`:816`/`:870`).

| corpus | clase    | rows_fetched | rows_by_id | trigram_raw | fuzzy_raw |      kept | dropped |
| ------ | -------- | -----------: | ---------: | ----------: | --------: | --------: | ------: |
| real   | long_nl  |       10 117 |        410 |       4 286 |     3 139 |         1 |     409 |
| 10k    | long_nl  |       26 544 |      4 000 |       9 144 |     7 908 |         2 |   3 998 |
| 50k    | long_nl  |      139 812 |     33 141 |      49 106 |    41 575 |        45 |  33 096 |
| 100k   | long_nl  |  **271 263** |     65 447 |      94 560 |    79 404 | **2 934** |  62 513 |
| 100k   | phrase   |      102 107 |     13 810 |      53 983 |    47 486 |       234 |  13 576 |
| 100k   | frequent |       41 037 |     20 518 |      20 518 |         0 |    20 518 |       0 |

A 100k `long_nl` se materializan **271 263 filas** (**2,71× el corpus**, `[CALCULADO]`)
para retener 2 934 (~1,1 %). El rung `any` es el peor: 94 564 filas crudas en `long_nl`
a 100k, por consulta. `[MEDIDO]`

### 7.2 Cuello #2 — etapas proporcionales al volumen de candidatos `[MEDIDO]`

Ranking de etapas por share medio (100k): `fuzzy_coverage` **23,9 %**, `token_set`
**17,0 %**, `admission` **16,5 %**, `rung_total` **14,4 %**, `fuzzy_expand` 9,1 %,
`trigram_sql` 8,6 %. `[MEDIDO]` (`b5/tables.md` §"Bottleneck ranking"). Todas las etapas
top excepto `fuzzy_expand` iteran las filas que devolvió el SQL; el problema es el
**volumen de candidatos sin acotar**, no el cableado. La memoria después de consultas
alcanza **3 451 MB a 100k** (556 MB tras seed), consistente con materializar cientos de
miles de filas con contenido. `[MEDIDO]`

### 7.3 `expandFuzzyTokens` re-copia/re-ordena por consulta `[MEDIDO]`

`expandFuzzyTokens` (`search-repository.ts:211`) hace
`[...new Set(vocabulary)].sort()` (`:216`) en cada consulta, aunque
`globalVocabulary()` (`:476`) ya devuelve un array ordenado y único.

| docs    |         |             V |           | set+sort redundante | expand full (1 token) | scan-only | share redundante |
| ------- | ------- | ------------: | --------: | ------------------: | --------------------: | --------- | ---------------- |
| 10 000  | 26 123  |       6,81 ms |   7,15 ms |             0,54 ms |              **95 %** |
| 50 000  | 106 123 |      45,91 ms |  49,07 ms |             3,50 ms |              **94 %** |
| 100 000 | 206 123 | **138,18 ms** | 147,38 ms |             9,92 ms |              **94 %** |

`[MEDIDO]` (`b5/raw/b5-micro-fuzzy-expand.json`). En-situ, `fuzzy_expand` a 100k p50 es
~158 ms (**99,8 %** de una consulta sin resultados; ~39 % de `exact`, 95–98 % de
`substring`/`rare`/`fuzzy_typo`). Es **recomputación pura**: el vocabulario subyacente ya
está cacheado por generación. Fix propuesto (sólo recomendación): cachear el array
ordenado/deduplicado junto a `globalVocabulary()`, invalidando con el mismo bump.

### 7.4 Metodología de percentiles (resolución de una aparente contradicción) `[MEDIDO]`

Los percentiles usan interpolación lineal sobre la muestra ascendente (misma definición
que `scripts/bench-search.ts`). **Nunca se comparan percentiles de poblaciones
distintas**: `total/wall`, `por-etapa` y `por-canal` son conjuntos de ejecuciones
diferentes, y `median(a) + median(b) ≠ median(a+b)`. Una mediana de canal mayor que la
mediana total de clase es un artefacto cruzado, no una contradicción (p.ej. a 100k
`irrelevant`, wall p50 = 158,9 ms y fuzzy p50 = 158,5 ms son muestras distintas; su
casi-igualdad es el punto). La **única** descomposición válida por ejecución es la
contabilidad de medias: `sum(medias de etapa)` vs media de `wall`, con **≤1,6 % sin
atribuir** en todo corpus/clase, lo que confirma que la instrumentación está completa.

### 7.5 Hechos negativos y positivos a conservar

- **LIKE nunca disparó** (`like_raw_rows = 0`, `like_sql_ms = 0`) en esta carga: todos
  los términos ≥3 chars. No optimizarlo con esta evidencia. `[MEDIDO]`
- **`frequent` retiene legítimamente ~20 %** de los documentos (20 518/100k): cualquier
  acotamiento de candidatos debe preservar esta clase; preferir pre-filtrado a un
  `LIMIT` global tosco. `[MEDIDO]`

---

## 8. Calidad general y arquitectura (B6)

**Evaluación cualitativa** basada en la evidencia de B1–B5 + la suite v2.

- **El recall es suficiente para el uso lexical previsto**: identifier R 100 %,
  substring R 94,8 %, phrase/and perfectos; los FN de `exact`/`frequent` son en su
  mayoría **truncamiento top-k** (p.ej. expected 18 con k=10). `[MEDIDO]`
- **FP 42 = 21 anti_bias + 6 negative (3 noise) + resto pequeño**; 18 de los 21
  anti_bias son efecto colateral de R1 (plegado `ñ→n`), no fuzzy ni function words.
  `[MEDIDO]`
- **La distribución real de consultas NO está medida**: el run real de la auditoría fue
  sólo latencia, así que la proporción de consultas reales que necesitan fuzzy es
  **U1 UNKNOWN** (§11/§12). `[MEDIDO]`/`[PROYECTADO]`
- **Cobertura de tests fuerte** en baselines/determinismo/caché/migración; faltan
  **distribución real, necesidad de fuzzy, semántico, calibración, ablación por canal
  como gate y atribución de FP por segmento**. `[MEDIDO]`
- **Confianza entrelazada con el ranking**: `score` es relativo intra-consulta;
  `computeConfidence` mezcla clase de canal + score relativo; **no calibrada**. Separar
  ranking (ordinal) de confianza (interpretación) es un rediseño futuro, no un fix.
  `[CÓDIGO]`
- **Semántico fuera del alcance empírico**: RAG off; 218/4493 embeddings en el corpus
  real. Un benchmark requeriría set con paráfrasis + embeddings del fixture + corrida
  on/off + calibración. `[MEDIDO]`

**Síntesis arquitectónica.** El motor no necesita una re-arquitectura: las palancas de
mayor valor son **simples y localizadas** (acotar SQL, cachear el vocabulario ordenado,
guarda d1-short/ancla, eventualmente el índice trigram de términos y un admission
consciente de expansiones). No se justifica una reescritura de fusión/pesos en esta
iteración.

---

## 9. Comparación de alternativas

Cada opción con beneficio, evidencia, impacto en recall/precisión, latencia,
almacenamiento, costo de escritura, complejidad y riesgo de mantenimiento. **Ninguna
está implementada.**

| Opción                                                                                                         | Beneficio                                                                               | Evidencia                         | Recall                                                                    | Precisión                              | Latencia                           | Almacenamiento                           | Costo escritura      | Complejidad | Riesgo maint.                                        |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------- | ---------------------------------------- | -------------------- | ----------- | ---------------------------------------------------- | ---- | ------------------------- |
| **Recuperación SQL acotada** (LIMIT/push-down de coverage, diferir `content`, cap finito en any/trigram/fuzzy) | Ataca el 75–80 % del tiempo de etapas y todos los cuellos proporcionales a candidatos   | `[MEDIDO]` B5 §7.1–7.2            | Sin cambio si el cap preserva el top page; riesgo si `frequent` se trunca | Sin cambio esperado                    | Multi-cientos-ms a segundos a 100k | Ninguno                                  | Ninguno              | Media       | Medio: preservar `frequent` (~20 %) y recall         |
| **Cachear vocabulario ordenado** (quitar `Set`+`sort` redundante)                                              | ~95 % de `expandFuzzyTokens` eliminado                                                  | `[MEDIDO]` B5 §7.3                | Sin cambio                                                                | Sin cambio                             | −10/−45/−140 ms (real/50k/100k)    | Ninguno                                  | Ninguno              | Baja        | Bajo: invalidar con mismo bump                       |
| **Fuzzy prefix-free vía índice trigram de términos**                                                           | first3 8,3 %→86,1 %                                                                     | `[MEDIDO]` B1 §3                  | +recall first-3 (9/12)                                                    | FP 42→44; resolver FN de tokens cortos | Sub-ms/consulta a 50k              | Índice 430k entradas a 50k; build 176 ms | Build por generación | Media-alta  | Medio-alto: fallback tokens cortos, invalidación     |
| **Admission consciente de expansiones** (evidencia + ancla + crédito sub-unidad)                               | Recupera `first3-accion` (tp0→>0) y arregla la supresión por host                       | `[MEDIDO]`/`[CÓDIGO]` B3 §5       | +recall fuzzy multi-término                                               | Riesgo de ruido si sin ancla           | Neutro                             | Ninguno                                  | Ninguno              | Alta        | Alto: contrato engine↔labels, fallbacks              |
| **Guardas d1short + anchor**                                                                                   | Contiene FP/ruido funcional prefix-free sin perder recall                               | `[MEDIDO]` B4 §6.3                | 0 perdido en suite                                                        | FP 46→45, noise 4→3                    | Neutro                             | Ninguno                                  | Ninguno              | Baja-media  | Medio: bypass single-token; validar corpus real      |
| **Incremental de vocabulario**                                                                                 | Elimina rebuilds fríos para escrituras locales (~1 200–5 700× menos CPU en write-heavy) | `[MEDIDO]`/`[PROYECTADO]` B2 §4.4 | Sin cambio si correcto                                                    | Sin cambio                             | cold→warm tras escritura local     | Ninguno                                  | ~0,03 ms/escritura   | Alta        | **Alto**: seam post-commit, corrupción silenciosa    |
| **Separar ranking de confianza + calibrar**                                                                    | Interpretabilidad, buckets consistentes                                                 | `[CÓDIGO]` B6 §8                  | Neutro                                                                    | Neutro                                 | Neutro                             | Ninguno                                  | Ninguno              | Alta        | Alto: datos etiquetados + proceso                    |
| **P-D diccionario por documento**                                                                              | Eliminaba prefijo-3 + plegado de cobertura                                              | `[MEDIDO]` previo §8.1            | first3 86,1 %                                                             | —                                      | Más lento a 50k                    | +255 MB (52 % DB)                        | +0,05–0,30 ms/op     | Alta        | **Descartado**: no paga                              |
| **Full-scan prefix-free**                                                                                      | first3 86,1 % sin estructura                                                            | `[MEDIDO]` B1 §3.3                | first3 86,1 %                                                             | FP 47                                  | Ω(                                 | V                                        | ), 115 ms/q a 50k    | Ninguno     | Ninguno                                              | Baja | **Descartado**: no escala |
| **`detail=none`**                                                                                              | −16,57 MB de trigram                                                                    | `[MEDIDO]` previo §8.3            | Rompe >3 chars                                                            | FP 5–8 %                               | —                                  | −16,57 MB                                | —                    | Alta        | **Descartado**: complejidad no justificada           |
| **delete-2 (SymSpell)**                                                                                        | Candidatos baratos                                                                      | `[LITERATURA]` previo §2.2        | Recupera más                                                              | —                                      | —                                  | ~1 M entradas                            | Build ~648 ms        | Alta        | **Descartado**: build/almacenamiento                 |
| **Reglas stopword/df**                                                                                         | Bajo ruido funcional                                                                    | `[MEDIDO]` B4 §6.3                | —                                                                         | FP 46→45                               | —                                  | Ninguno                                  | Ninguno              | Baja        | `stopword` útil; `dfskip`/`dftarget` inertes/dañinos |

---

## 10. Recomendaciones priorizadas

Separadas por naturaleza y con la marca de estado explícita. **Ninguna de las
recomendaciones de (b)–(d) está implementada; la Parte B no cambió producción.**

### (a) Correcciones funcionales necesarias — **YA HECHAS (Parte A)**

1. **Schema v10 definitivo** (`SCHEMA_VERSION = 10`; trigram contentless con
   `remove_diacritics 1`; sin diccionario; v9→v10 directa). `[CÓDIGO]`
2. **Invalidación del caché fuzzy cross-process** (`{generation, dataVersion}` con
   `PRAGMA data_version`; sin polling/hilos/deps). `[CÓDIGO]`

### (b) Optimizaciones de alto beneficio/costo — **próxima iteración, con aprobación**

1. **Acotar la recuperación SQL** (B5 §7.1–7.2): `LIMIT`/push-down de coverage en SQL,
   diferir `content` (dos fases), tope finito en `any`/trigram/fuzzy. **Mayor impacto de
   latencia a escala.** Preservar `frequent` legítimo.
2. **Cachear el vocabulario ordenado por generación** (B5 §7.3): elimina ~95 % de
   `expandFuzzyTokens` (~140 ms/consulta a 100k). Cambio pequeño y localizado.
3. **Fuzzy prefix-free vía índice trigram sobre términos** (B1 §3): first3 8,3→86,1 %;
   requiere diseño de build/incremental/invalidación, fallback de tokens cortos y tests.
4. **Admission consciente de expansiones + fix de la supresión por host** (B3 §5), con
   ancla literal y crédito sub-unidad; tests y regeneración de baselines.
5. **Guardas d1short (d1≤5) + ancla literal** (B4 §6.3) para acompañar el prefix-free.

### (c) Mejoras arquitectónicas opcionales

- Separar **ranking vs confianza** y calibrar (requiere datos etiquetados; fuera del
  alcance actual).
- Agrupar **familias lexicales** antes de fusionar con el semántico (reduce doble
  conteo; costo de re-tuning alto).
- Revisar **redundancia**: `token_set` tuvo 0 flips en la auditoría previa.
- **Incremental de vocabulario** sólo si un workload write-heavy ≥10k se vuelve objetivo
  medido (B2 §4.4).

### (d) Alternativas a descartar

- **P-D** diccionario por documento (storage/rebuild). `[MEDIDO]`
- **Full-scan prefix-free** (no escala; Ω(|V|)). `[MEDIDO]`
- **`detail=none`** (complejidad no justificada). `[MEDIDO]`
- **delete-2** (~1 M entradas, build caro). `[LITERATURA]`
- **Reglas de stopwords/df arbitrarias** como tuneadas (`dfskip`/`dftarget` inertes o
  dañinas). `[MEDIDO]`
- **Truncar resultados legítimos de `frequent`** (~20 % de los docs). `[MEDIDO]`
- **Optimizar LIKE** con esta evidencia (nunca disparó). `[MEDIDO]`

---

## 11. Decisiones pendientes (humanas)

Decisiones que requieren evaluación humana antes de tocar producción:

1. **¿Adoptar el índice trigram sobre términos para prefix-free?** Costo de
   mantenimiento/invalidación (build, fallback de tokens cortos, cubetas) frente al
   beneficio de recall first-3.
2. **Trade-off FP vs recall de first-3**: ¿se acepta subir FP (42→44) y el ruido de
   negativos acotado a cambio de recuperar typos en primeros-3? ¿Se adoptan las guardas
   d1-short/ancla como condición?
3. **¿Priorizar latencia a escala o recall?** El trabajo de SQL acotado + vocabulario
   cacheado (latencia, sin cambio de contrato) vs prefix-free + admission (recall,
   cambio de contrato de admisión).
4. **¿Se mide U1 (necesidad real de fuzzy) antes de invertir en prefix-free?** Si la
   proporción real de consultas con typos es baja, el ROI de prefix-free cae frente al
   de las optimizaciones de latencia.
5. **¿Se acepta la propuesta de admission consciente de expansiones** (cambio del
   contrato engine↔labels y de los fallbacks), o se mantiene el gate congelado?

---

## 12. Preguntas abiertas

Preguntas cuya respuesta exige datos/experimentos que **no** están hoy disponibles.

- **U1 — proporción real de consultas que necesitan fuzzy (typos).** No medida (el run
  real de la auditoría fue sólo latencia). **Experimento:** ablación `−fuzzy` sobre un
  log real de consultas; medir cuántos casos pierden recall. Determina el ROI de
  prefix-free frente a las optimizaciones de latencia.
- **U2 — composición de FP en uso real.** El fixture (1 caso funcional de 298) subestima
  el riesgo; hace falta atribución de FP por segmento sobre consultas reales.
- **U3 — calidad del canal semántico (offline hoy).** Requiere: set con paráfrasis,
  embeddings del fixture, corrida RAG on/off (online, no determinista) y calibración.
- **U4 — impacto corpus-wide de R1.** Confirmado en stores craft; la concentración de
  acentos en el corpus real y su efecto agregado no están cuantificados.
- **U5 — calibración (score→confianza real).** Requiere set etiquetado + curvas
  reliability/ECE por bucket; hoy `score` es relativo intra-consulta y no calibrado.

**Datos/experimentos necesarios para responderlas**: un log real de consultas
etiquetables; un corpus fixture con embeddings y set de paráfrasis; re-run de B4 §3–4
sobre los corpora real/10k/50k/100k de B5 para validar `d1short` y ancla frente a
palabras de dominio largas; y la medición de la frecuencia funcional real.

---

## Apéndice — Verificación y límites de la evidencia

### Verificación de los números clave

| Afirmación                          | Valor                                                                        | Artefacto                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| v2 optimizado passed                | 237/298                                                                      | `b1/measurements.json → v2.v2[prefix3]`                      |
| P / R / MRR / nDCG v2               | .940 / .885 / .9505 / .9253                                                  | idem                                                         |
| FP / first3 v2                      | 42 / 8,33 % (1/12)                                                           | idem                                                         |
| prefixfree first3                   | 86,1 % (9/12)                                                                | idem                                                         |
| trigram-index passed / FP / first3  | 245 / 44 / 86,1 %                                                            | idem                                                         |
| trigram-index build 50k / entradas  | 175,9 ms / 430 271                                                           | `b1/summary.md` §4, `b1/scaling-finish.json`                 |
| trigram-index fuzzy p50 50k         | 0,354 ms                                                                     | `b1/summary.md` §4                                           |
| 100k long_nl rows_fetched / kept    | 271 263 / 2 934                                                              | `b5/analysis.json` (`corpora.100k.classes.long_nl.counters`) |
| Shares top 100k                     | fuzzy_coverage 23,9 %, token_set 17,0 %, admission 16,5 %, rung_total 14,4 % | `b5/tables.md` §"Bottleneck ranking"                         |
| `expandFuzzyTokens` redundante 100k | 138,18 ms set+sort (94 % share)                                              | `b5/raw/b5-micro-fuzzy-expand.json`                          |
| Amortizado read-heavy               | 0,37 / 4,96 / 64,7 ms = 0,9 / 1,3 / 2,6 %                                    | `b2/measurements.json` (cum.÷S; ÷warm p50) [CALCULADO]       |
| Rebuild fold share                  | 82,0 / 83,8 / 81,6 %                                                         | `b2/rebuild-breakdown.json`                                  |
| B4 prefix-free stopword targets     | 505/2 375 (21,3 %)                                                           | `b4/expansions.json` / `b4/summary.md` §2                    |
| B4 `es→92`, ≤3-char expansions 78 % | 92 / 1 864/2 375                                                             | `b4/summary.md` §0–2                                         |

### No verificable con la evidencia actual

- **Distribución real de consultas (U1)** y proporción real de necesidad de fuzzy: no
  medida. `[PROYECTADO]`
- **Calidad semántica** (U3): fuera de alcance empírico (RAG off). `[PROYECTADO]`
- **Impacto corpus-wide de R1 (U4)**: concentración de acentos no cuantificada.
- **Calibración (U5)**: sin set etiquetado. `[PROYECTADO]`
- **Escala >100k**: no medida; las cifras a 100k son de un corpus sintético con
  vocabulario reutilizado, no del corpus real futuro.
- **B3**: análisis de código + caso medido (`v2-first3-accion`), sin prototipo
  end-to-end (la propuesta es `[HIPÓTESIS]`).

### Condiciones de la instrumentación

- Todos los prototipos corrieron en copias aisladas sin `.git` bajo
  `/tmp/opencode/search-followup/{b1,b2,b4,b5}/`; la instrumentación fue aditiva y
  neutral por defecto. `[MEDIDO]`
- La base viva `data/mind.db` nunca se abrió en escritura; los mtimes churnados
  corresponden a procesos `mind mcp` preexistentes. `[MEDIDO]`
- Los ms absolutos son de una sola máquina/disco; la señal durable son los **ratios**,
  las **shares** y el **orden relativo de poblaciones**. `[HIPÓTESIS]`
