# Auditoría técnica y revisión crítica del sistema de búsqueda

> **Estado del documento:** evaluación de diseño **previa a decidir cambios**. **No se
> modificó código**: las únicas escrituras de este trabajo son este documento y artefactos
> efímeros de medición en `/tmp/opencode/search-audit/`. El `data/mind.db` original nunca se
> abrió en modo escritura (los mtimes del DB vivo son churnados por procesos MCP activos; la
> auditoría trabajó sólo sobre copias y `git status` no mostró cambios).

- **Feature:** `00003-search-audit`
- **Repositorio:** `/home/gabrielmoran/Git/mind` (commit `678f58d` + el worktree `search-*` no
  commiteado que define el motor auditado)
- **Fecha:** 2026-10-17
- **Runtime:** Bun 1.3.14, SQLite 3.53.0 (`bun:sqlite`), `MIND_RAG=false` en todas las corridas
- **Fuentes primarias:** `research-report.md` (reporte consolidado) + artefactos crudos en
  `/tmp/opencode/search-audit/storage/` y `/tmp/opencode/search-audit/behavior/`

## Etiquetas de evidencia

Toda afirmación se etiqueta con una de estas marcas:

- `[CÓDIGO]` — hecho verificado leyendo el código fuente real (con archivo/función/línea).
- `[MEDIDO]` — observado en una corrida de medición registrada en un artefacto.
- `[CALCULADO]` — aritmética derivada de valores medidos.
- `[PROYECTADO]` — inferencia/extrapolación no medida directamente.
- `[LITERATURA]` — respaldado por referencias externas (RRF de Cormack 2009; calibración de
  Bruch et al.).
- `[HIPÓTESIS]` — conjetura razonada, sin medición.

Se distinguen explícitamente **hechos verificados**, **hipótesis** y **recomendaciones**.
Ninguna métrica de este documento fue inventada; donde algo **no** se pudo medir (canal
semántico offline, impacto corpus-wide de R1, proyección a 100k, ausencia de artefacto de
retuning de pesos) se dice de forma explícita.

---

## 1. Resumen ejecutivo

El sistema de búsqueda es un **pipeline único y unificado** (`searchMemories`,
`src/store/repositories/search-repository.ts:517-696`) que sirve a las tres superficies (CLI,
MCP, API) con un diseño de **fan-out lógico de canales** seguido de **fusión ponderada**
(`fuseCandidates`, `src/store/shared/search-fusion.ts:280-336`). La arquitectura objetivo —
ejecutar los mecanismos, recolectar candidatos con provenance y combinarlos— **está
implementada y es la que efectivamente corre**. No hay una búsqueda en cascada en producción:
`searchFallback` (la vieja cascada FTS5→LIKE→embeddings) existe pero es **código muerto** en
producción (`[MEDIDO]`, §4).

Los canales efectivos son seis lexicales (`phrase`, `all`, `any`, `trigram`, `fuzzy`, `like`),
uno de re-scoring (`token_set`) y uno opcional (`semantic`, sólo con RAG encendido). Cada uno
está correctamente implementado y sincronizado, y hay evidencia sólida de que **dos canales
son dueños únicos de recall**: `trigram` resuelve subcadenas (7/7 → 1/7 sin él) y `fuzzy`
resuelve typos (8/8 → 1/8 sin él) (`[MEDIDO]`, §7).

Sin embargo, la auditoría expone hallazgos incómodos:

1. **"Paralelo" no es paralelo.** La concurrencia es conceptual: la ejecución es
   **secuencial y síncrona** (`bun:sqlite`), y el único `await` es el fetch HTTP del canal
   semántico (`[CÓDIGO]`). El comentario `"True parallel retrieval"` describe independencia
   _lógica_, no concurrencia real.
2. **Redundancia lexical alta.** El **93,4 %** de los resultados trae ≥2 métodos y el
   **80,8 %** trae ≥3 (`[MEDIDO]`); la fusión suma + bonus de _agreement_ por canales
   correlacionados que ven la **misma** evidencia textual.
3. **El canal semántico está estructuralmente desfavorecido.** Un match semántico perfecto
   (peso 0.80) **no puede competir** con un match lexical fuerte (hasta 3.50) (`[CALCULADO]`),
   y el _admission gate_ literal puede descartar paráfrasis semánticas cuando hay solape lexical.
4. **R1 — recall silencioso con acentos.** El índice trigram guarda texto crudo (con acentos)
   mientras las queries se pliegan (`stripDiacritics`), así que **la búsqueda de subcadena falla
   en documentos acentuados** (`figuracio` no encuentra `configuración`) (`[MEDIDO]`). Las
   consultas de palabra completa no se ven afectadas.
5. **El trigram cuesta ~52 % de la DB** (26,18 MB, 5,17× el texto) y **≈2× la latencia de
   escritura**; no está optimizado (usa `detail=full` + copia de contenido).
6. **El fuzzy concentra ~75 % del tiempo de canales** (~95 ms/llamada), sobre cada consulta.
7. **Los pesos del ranking son idénticos a la propuesta inicial del plan**; el comentario
   `"Tuned against the fixture evaluation suite (see T4 report)"` (`search-fusion.ts:50-54`)
   **no tiene artefacto de retuning archivado**. `token_set` **no aporta nada** (0 flips).
8. **`score` es una heurística de ranking, no una probabilidad calibrada**; además es
   **relativo a la consulta** (el top siempre vale 1.0), por lo que no es comparable entre
   consultas distintas.

**Veredicto de alto nivel:** la arquitectura es defendible y funcional para el modo lexical
offline, pero está **sobredimensionada para su corpus actual**: la redundancia es alta, el
trigram es caro, y las palancas de mayor valor son **simples** (contentless trigram, fix de
plegado R1, optimizar fuzzy, quitar `token_set`) antes que añadir más mecanismos.

---

## 2. Implementación real

### 2.1 Qué está implementado

- **Pipeline unificado** `searchMemories` (`search-repository.ts:517-696`) usado por CLI
  (`src/cli/commands/search.ts:62`), MCP (`src/mcp/handlers/memories/query-memories.ts:91`) y
  API (`src/api/routes/search.ts:47`). `[CÓDIGO]`
- **Parser de consultas** (`src/store/shared/query-parser.ts`): AST con `"phrases"`, `OR`,
  `AND` implícito, `NOT` y prefijo `*`; entrada malformada degrada a AND literal y nunca
  lanza. `[CÓDIGO]`
- **Canales lexicales** (rungs `phrase`/`all`/`any` vía `MATCH` sobre `memories_fts`),
  **trigram** (`MATCH` sobre `memories_fts_trigram`), **fuzzy** (OSA ≤2), **like** (sub-3
  chars), **token_set** (re-scoring en TS) y **semantic** (RAG-only). `[CÓDIGO]`
- **Fusión** `fuseCandidates`: normalización min-max por canal y por consulta, suma ponderada,
  bonus de agreement, bucketing de confianza y provenance (`search-fusion.ts:280-336`).
  `[CÓDIGO]`
- **Índices FTS5**: `memories_fts` (`porter unicode61`) y `memories_fts_trigram`
  (`trigram`), ambos _standalone_, sincronizados manualmente por `FtsHelper`
  (`src/store/shared/fts-helpers.ts:13-48`) — sin triggers, por el bug conocido de
  `bun:sqlite`. `[CÓDIGO]`
- **Degradación del canal semántico**: `try/catch` + _breaker_ en memoria de ~5 min +
  reintentos (`src/helpers/rag.ts`). `[CÓDIGO]`

### 2.2 Qué está incompleto

- **Paginación en 3 capas**: el engine no tiene default de `limit`/`offset` (no-op sin
  parámetros), el CLI corta localmente, la API pasa params y MCP corta en el handler. Es
  funcional pero inconsistente. `[CÓDIGO]`
- **Retuning de pesos "fantasma"**: el comentario dice que fue tuneado contra la suite, pero no
  hay reporte T4 archivado; los pesos coinciden carácter por carácter con la propuesta inicial
  del plan. `[CÓDIGO]`
- **Desvío de `prefix-3`**: `FUZZY_PREFIX_LENGTH = TRIGRAM_MIN_LENGTH = 3`
  (`search-repository.ts:39-52`), mientras el plan D3 especificaba _prefix 2_. El código
  documenta la razón (el prefiltro trigram no puede recuperar menos de 3 chars), pero es un
  desvío registrado. `[CÓDIGO]`
- **R1 (plegado de acentos)**: asimetría de _plegado_ entre índice (raw) y query
  (`stripDiacritics`). Confirmado en probes, **impacto corpus-wide sin cuantificar**.
  `[MEDIDO]` + caveat.

### 2.3 Qué está sólo planificado (no implementado)

- **No hay paralelismo real**: sin `Promise.all`, sin workers, sin pool de conexiones; único
  `await` = fetch semántico. `[CÓDIGO]`
- **No hay calibración de confianza**: sin sigmoid/isotonic/ECE; la suite no mide calibración.
  `[CÓDIGO]`
- **No hay presupuestos de latencia por canal** ni _timeouts_ lexicales. `[CÓDIGO]`
- **`searchFallback`**: implementado y exportado, pero **ninguna superficie de producción lo
  llama** (sólo un test: `test/mind-store.spec.ts:669`). `[MEDIDO]`

### 2.4 Diagrama de flujo (real)

```
query → parseQuery → AST
      → buildRungs (phrase/all/any)
      → [secuencial en un hilo, bun:sqlite]:
           rungs MATCH (memories_fts)          → scores -rank(bm25)
           trigram MATCH (memories_fts_trigram) → scores -rank
           fuzzy: collectCandidateVocabulary (trigram, LIMIT 2000)
                  → expandFuzzyTokens (OSA ≤2, prefix 3, cap 50)
                  → MATCH (memories_fts)         → scores -rank
           like: LIKE %tok% (sub-3 chars)        → conteo entero
           token_set: cobertura sobre candidatos → fracción 0..1
           semantic: [await] scan + cosine       → cosine (RAG only)
      → NOT exclusions (todas las fuentes)
      → admission gate (documentSatisfiesQuery)
      → relaxed tier / last resort
      → fuseCandidates (min-max por canal + suma ponderada + bonus)
      → confidence bucket + methods
```

---

## 3. Respuestas por tema

### Tema 1 — Arquitectura general de búsqueda

**Mecanismos implementados y qué devuelve cada uno.** `[CÓDIGO]`

| Canal                    | Fuente/algoritmo                                     | Devuelve                   |
| ------------------------ | ---------------------------------------------------- | -------------------------- |
| `phrase` / `all` / `any` | `MATCH` sobre `memories_fts` (bm25, porter)          | candidatos + `-rank`       |
| `trigram`                | `MATCH` sobre `memories_fts_trigram`                 | candidatos + `-rank`       |
| `fuzzy`                  | prefiltro trigram + OSA ≤2 sobre vocabulario         | candidatos + `-rank`       |
| `like`                   | `LIKE '%tok%'` sobre `memories.name/content` (sub-3) | candidatos + conteo entero |
| `semantic`               | scan de filas + cosine en proceso (RAG-only)         | candidatos + cosine        |
| `token_set`              | cobertura de tokens en TS (no retrieval)             | cobertura 0..1             |

No se usan `snippet()`/`highlight()` (grep vacío). Los tags son post-filtro en JS, no
indexados en FTS.

**Paralelismo real vs secuencial.** **Secuencial.** `[CÓDIGO]` El comentario
`"True parallel retrieval (D3/D4)"` (`search-repository.ts:527-528`) describe independencia
_lógica_ de canales, no concurrencia. No hay `Promise.all` ni workers; `bun:sqlite` es
síncrono; el único `await` es el fetch HTTP del canal semántico (`sqlite-store.ts:250-253`,
`rag.ts:66`), que es la única razón por la que `searchMemories` es `async`.

**Mecanismos condicionales.** `[CÓDIGO]` El canal `any`-coverage sólo actúa con grupo único y
≥2 tokens; `trigram` sólo con token ≥3 chars; `like` sólo con token 1-2 chars; `semantic` sólo
con RAG-on y breaker cerrado; `token_set` sólo con filas presentes; las NOT-exclusions sólo si
hay `NOT`.

**Datos consultados / combinación / dedup.** `[CÓDIGO]` Los candidatos se acumulan en
`Map<UUID, SearchRow>` + `channels[]` con provenance; dedup por UUID; las NOT prunes aplican a
todas las fuentes.

**Límites de candidatos por método.** `[CÓDIGO]` Vocabulario fuzzy `LIMIT 2000`
(`FUZZY_CANDIDATE_LIMIT`, `search-repository.ts:56`); expansiones fuzzy ≤50
(`FUZZY_MAX_EXPANSIONS`); semántico floor 0.3 + top-50; cobertura con floors. **Los rungs,
trigram y LIKE no tienen `LIMIT` SQL** — traen todo lo que el índice devuelve.

¿Descartan resultados relevantes antes de la fusión? **Sí, en dos puntos.** `[CÓDIGO]`
(1) El vocabulario fuzzy topa a 2000 documentos → un typo cuya palabra correcta viva fuera de
ese conjunto es irrecuperable. (2) El _admission gate_ (`documentSatisfiesQuery`) descarta
candidatos encontrados por cualquier canal antes de fusionar.

**Comportamiento ante fallo/indisponibilidad.** `[CÓDIGO]` Sólo el canal semántico está
protegido (`try/catch` + breaker 5 min, reintentos 3, backoff 1s·n). **Los canales lexicales no
tienen guard**: una excepción se propagaría a la superficie (MCP/API sin `try/catch` externo),
degradando toda la búsqueda.

**Reflexión — ¿capacidades complementarias o redundantes?** `[MEDIDO]`/`[ANÁLISIS]` Ambos.
Estructuralmente, un token literal ≥3 chars es recuperable por `all`/`any` (porter), `trigram`
(substring) y `token_set` (cobertura) → **3-5 canales co-disparan por la misma evidencia**. Los
canales **genuinamente complementarios** son `fuzzy` (typos), `like` (sub-3) y `semantic`
(paráfrasis sin solape literal). La redundancia se confirma empíricamente (§6): 93,4 % de
resultados con ≥2 métodos.

---

### Tema 2 — Trigramas

**¿Tokenizer nativo o manual?** **Nativo FTS5.** `[CÓDIGO]`
`CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(name, content, tokenize='trigram')`
(`schema.ts:73-76`).

**¿Qué columnas/contenidos?** `name` + `content` (documento completo). **Los tags NO se
indexan.** `[CÓDIGO]`

**¿Normalización antes de indexar?** **No.** El índice escribe el texto **raw** (acentos
preservados). `[CÓDIGO]` Las _queries_ sí se pliegan (`stripDiacritics().toLowerCase()`), de
ahí la asimetría R1.

**Mayúsculas/acentos/Unicode/espacios/especiales.** `[CÓDIGO]`+`[MEDIDO]` El tokenizer trigram
de SQLite pliega mayúsculas, pero **no elimina diacríticos** ni unifica `ñ`↔`n`. Los espacios y
caracteres especiales se tokenizan por el tokenizer nativo. La comparación de cobertura
posterior usa texto plegado (`normalizeToken`), así que la falla es de **retrieval**, no de
cobertura.

**¿detail=full/column/none? ¿columnsize=0? ¿content= externo o copia?** `[CÓDIGO]` Sin
opciones en el DDL → **defaults FTS5: `detail=full`, `columnsize=1`, copia interna de
contenido** (shadow `_content`, **no** external-content). `[MEDIDO]` La copia de contenido pesa
5.064.954 B duplicados.

**Sincronización en inserciones/updates/deletes.** `[CÓDIGO]` Manual vía
`FtsHelper.insert/update/delete` (ambas tablas) invocado desde `addMemory`, `updateMemory`,
`move`, `patch`, `deleteMemory`, `deleteMemoryByName`, `importFromJson`, `deleteSpace`, además de
`ensureIntegrity`, migración v8→v9 (backfill) y validación de huérfanos.

**¿MATCH/LIKE/GLOB? ¿<3 caracteres?** `[CÓDIGO]` **Sólo `MATCH`** (tokens citados, escape de
`"`). No GLOB. Los términos **<3 chars** no pueden indexarse por trigram → el canal `like`
cubre ese hueco.

**Restricciones FTS5 que afectan.** `[CÓDIGO]` `tokenize='trigram'` requiere ≥3 chars;
`detail=none` rompe consultas >3 chars
(`fts5: phrase queries are not supported (detail!=full)`), por eso el canal usa `detail=full`.

**Reflexión — ¿uso eficiente de SQLite o costo innecesario?** `[MEDIDO]` **Costo
innecesario parcial.** La implementación es correcta y sincronizada, pero `detail=full` +
copia de contenido es la configuración más cara; un
`content='' + contentless_delete=1` preserva todo lo que la app usa y ahorra 6,27 MB (§5).

---

### Tema 3 — Tamaño y costo

**¿Cuánto antes y cuánto ahora? ¿% de índices trigram?** `[MEDIDO]` Sobre el corpus real
(4.493 documentos, 5.064.954 B de texto):

| Componente                   |                Bytes | × texto | % de la DB compacta |
| ---------------------------- | -------------------: | ------: | ------------------: |
| DB compacta (A, VACUUM INTO) |           49.942.528 |       — |               100 % |
| **Delta trigram** (A−B)      |       **26.177.536** |  5,169× |         **52,42 %** |
| Delta main FTS (B−C)         |            9.887.744 |  1,952× |             19,80 % |
| FTS combinadas (A−C)         |           36.065.280 |  7,121× |             72,21 % |
| Sin FTS (C)                  |           13.877.248 |       — |                   — |
| Logs (C−E)                   |              237.568 |       — |              0,48 % |
| Embeddings BLOB              | 1.339.392 (218/4493) |       — |              2,68 % |

Raw `data/mind.db` = **67.596.288 B** (16.503 × 4096); freelist 3.752 páginas =
15.368.192 B.

**¿Contenido duplicado/posiciones/auxiliares?** `[MEDIDO]` El trigram ≈ **19,42 MB postings +
5,06 MB copia de contenido (redundante) + 1,69 MB overhead**. La copia duplica texto ya
presente en `memories`.

**¿Crecimiento relativo vs contenido? ¿Escalado 1k/10k/100k?** `[MEDIDO]` Serie sintética ~1
KB/doc: 4.247,6 → 4.197,6 B/doc (1k→10k, −1,2 %, levemente sublineal). Serie ~300 B/doc:
1.581,1 → 1.557,7 B/doc (−1,5 %). **Real ≈ 5.826 B/doc** (el sintético subestima: reusa un
vocabulario de 40 palabras → menos trigramas distintos). `[PROYECTADO]` 100k docs ≈
**400–556 MiB** (banda lineal; puede desviar al alza por diversidad de vocabulario). **No
medido a 100k.**

**¿Impacto en inserciones/updates/deletes?** `[MEDIDO]` Overhead relativo mediano ≈ **2×**:

| op     | con trigram (mediana/p95 ms) | sin trigram |          overhead |
| ------ | ---------------------------: | ----------: | ----------------: |
| add    |                  2,36 / 6,46 | 1,55 / 3,66 |  +0,81 ms (+52 %) |
| update |                  3,87 / 9,00 | 1,80 / 5,52 | +2,06 ms (+114 %) |
| delete |                  1,64 / 5,86 | 0,83 / 3,12 |  +0,80 ms (+97 %) |

Los ms absolutos son dependientes de máquina; la señal robusta es el ~2× relativo.

**¿Datos obsoletos/fragmentación/compactación?** `[MEDIDO]` Raw 67.596.288 → compacta
49.942.528; **reclamable por VACUUM ≈ 17,65 MB** (15,37 MB freelist + 2,29 MB slack de b-tree).
Un WAL de 95 MB indica _churn_ no checkpointeado. **DELETE y `optimize` no liberan bytes de
archivo** (el `optimize` incluso creció el archivo 1,94 MB); sólo `VACUUM`/`auto_vacuum`
devuelven espacio al SO.

**¿Se evaluaron detail=none/content=/columnsize=0/optimize?** `[MEDIDO]`

| Variante                           |   Δ vs default | Capacidades                  |
| ---------------------------------- | -------------: | ---------------------------- |
| `detail=none`                      |    −16.568.320 | ❌ rompe toda query >3 chars |
| `columnsize=0`                     |        −57.344 | ✅ pero ahorro nulo          |
| `content=''`                       |     −6.279.168 | ❌ DELETE falla              |
| `content='', contentless_delete=1` | **−6.270.976** | ✅ todo lo que la app usa    |
| `optimize`                         |       −438.272 | ✅ pero transitorio          |

**¿dbstat/page_count/freelist?** `[CÓDIGO]`+`[MEDIDO]` `dbstat` **no está disponible** en este
build (`no such table: dbstat`); se usó el método por deltas de copias VACUUM +
`page_count/page_size/freelist_count`.

**Reflexión — ¿justificado el costo? ¿alternativa más compacta?** `[MEDIDO]` El trigram es el
dueño único del substring (§7), así que su valor funcional está probado; pero su **costo está
justificado sólo en parte**: `content='' + contentless_delete=1` da la **misma capacidad** por
−24 % del costo del trigram (−12,5 % de la DB). `detail=none` es más barato pero inviable.

---

### Tema 4 — Fuzzy

**¿Algoritmo real?** `[CÓDIGO]` `damerauLevenshtein` = **OSA (Damerau restringido)**: ins/del/sub
y transposición **adyacente** cuestan 1; **no** soporta transposiciones no-adyacentes múltiples.

**¿Rol de trigramas?** `[CÓDIGO]` Sólo **prefiltro de candidatos**: primeros 3 chars de cada
token → `MATCH` sobre trigram → vocabulario (`collectCandidateVocabulary`,
`search-repository.ts:378-402`), `LIMIT 2000`. Nunca similitud ni orden.

**¿Comparación posterior (Levenshtein/DL/Dice/Jaccard)?** `[CÓDIGO]` No hay comparación
secundaria: la aceptación es **pertenencia de conjunto** (palabra exacta o expansión). El
re-scoring `token_set`/admisión usa **fracciones de cobertura**, no Jaccard/Dice.

**Inserciones/borrados/sustituciones/transposiciones.** `[MEDIDO]` Resuelve los cuatro tras un
**prefijo compartido de 3 chars**, incluidas transposición simple y doble. **Errores en los
primeros 3 chars NO se recuperan**; palabras <3 chars sólo por LIKE exacto.

**¿Similitud a nivel documento/fragmento/término?** `[CÓDIGO]` A **nivel de término** (palabra
completa).

**¿Longitud del documento? ¿palabra pequeña en memoria extensa? ¿evitar matches accidentales de
docs largos?** `[MEDIDO]` El matching es por palabra, así que un doc largo **no diluye** el
recall (probe long-doc: sin pérdida). No hay penalización por longitud.

**¿Umbrales?** `[CÓDIGO]` `FUZZY_MAX_DISTANCE=2`, `FUZZY_PREFIX_LENGTH=3`,
`FUZZY_MAX_EXPANSIONS=50`, `FUZZY_CANDIDATE_LIMIT=2000`.

**Reflexión — ¿resuelve typos o confunde substring con fuzzy? ¿trigramas son la mejor
herramienta aquí?** `[CÓDIGO]`/`[MEDIDO]` No se confunden: son canales distintos — trigram =
subcadenas **exactas** ≥3 (typo-intolerante); fuzzy = variantes de **palabra completa** dentro
de OSA. El trigram como **prefiltro** es adecuado (acota el espacio de candidatos), pero su
acoplamiento al prefijo de 3 chars **es** la limitación de alcance (primeros 3 chars
irrecuperables). No es un bug del cálculo de distancia (que es correcto), sino un límite de
diseño.

---

### Tema 5 — Scores, ranking y confianza

**¿Qué puntuación por mecanismo? ¿rango/significado?** `[CÓDIGO]`

| Canal               | Score crudo   | Significado                  |
| ------------------- | ------------- | ---------------------------- |
| rungs/trigram/fuzzy | `-rank`       | bm25 negado (mayor = mejor)  |
| like                | conteo entero | nº de tokens presentes       |
| token_set           | fracción 0..1 | cobertura de tokens de query |
| semantic            | cosine        | similitud coseno             |

**¿Transformaciones antes de combinar?** `[CÓDIGO]` Min-max **por consulta y por canal**,
aplicada **dentro** de `fuseCandidates` y **después** del pruning de admisión. Guards: canal
vacío ⇒ ausente; todo-igual ⇒ 1,0; no-finitos ⇒ 0.

**¿BM25 (orden/escala)?** `[CÓDIGO]` Se usa `-rank` de FTS5 (bm25); importa el **orden** dentro
de cada canal, la escala se neutraliza con la normalización.

**¿Normalización por consulta o estable?** **Por consulta** (`[CÓDIGO]`). Consecuencia: las
magnitudes **no son comparables entre consultas distintas**.

**¿Fórmula exacta? ¿suma/máximos/RRF?** `[CÓDIGO]`
`fused = Σ w_c·norm_c(d) + min(0.15, (n_métodos−1)·0.05)`; `score = fused/maxFused`
(**relativo**: el top de cada consulta = 1.0). Es **suma ponderada con normalización por
consulta** + bonus de agreement. **No** es RRF.

**¿Pesos y cómo se determinaron?** `[CÓDIGO]` phrase 1.0, all 0.9, any 0.55, semantic 0.8,
trigram 0.6, fuzzy 0.4, like 0.5, token_set 0.3 (`search-fusion.ts:55-64`). **Idénticos a la
propuesta inicial del plan**; el tuning real de T4 ocurrió en admisión/cobertura, no en pesos.
El comentario `"Tuned against the fixture evaluation suite"` **no tiene reporte archivado** →
retuning de pesos **no documentado**.

**¿Semántico excelente vs lexical excelente?** `[CALCULADO]` semantic-only máx = 0.80; literal
realista (phrase+all+any+trigram+token_set) = 3.35 + 0.15 = **3.50** (4,4×); con semántico
co-disparando = 3.35 + 0.80 + 0.15 = 4.30 (5,4×). **Un match semántico excelente no compite con
uno lexical fuerte.**

**¿Un solo mecanismo? ¿todos?** `[CÓDIGO]` Cualquier combinación; los candidatos no producidos
por ningún canal se descartan.

**¿Ausencia = cero o falta de evidencia?** `[CÓDIGO]` Ausencia = sin término en la suma **+
sin crédito de agreement** = aritméticamente 0 **y** sin evidencia.

**¿Umbrales globales?** `[CÓDIGO]` **No hay cutoff post-fusión**: los candidatos débiles se
retornan con `confidence='low'`. El pruning real es el _admission gate_ pre-fusión.

**Reflexión — ¿magnitudes comparables? ¿interpretación consistente entre consultas?**
`[CÓDIGO]` No: la normalización por consulta hace que `score` sólo tenga sentido
**intra-consulta**. Un mismo match cambia de bucket según los pares de la consulta.

**Ranking vs confianza.** `[CÓDIGO]` `computeConfidence` (`search-fusion.ts:227-246`): phrase/
all ⇒ `high` si `score relativo ≥0.6`, si no `medium`; any/trigram/like/token_set ⇒ `medium`;
semántico único ⇒ `medium` si cosine ≥0.6, si no `low`; fuzzy-only ⇒ `low`. **Se mezclan
conceptos**: la confianza depende del **score relativo** y de una **clase de canal**, no de una
probabilidad. `[ANÁLISIS]` `score` **no es probabilidad calibrada** (no hay sigmoid/isotonic/
ECE; la suite sólo mide P/R/FP/FN/noise). `[LITERATURA]` La doc RAG (Bruch et al., reporte
archivado `00002`) respalda **buckets sobre números crudos**, no números "calibrados". Conviene
**separar ranking (orden) de confianza (interpretación)**.

---

### Tema 6 — Correlación y redundancia

**¿Recompensamos varias veces la misma evidencia?** `[CÓDIGO]`/`[MEDIDO]` **Sí.** Un token
literal ≥3 chars activa `all`/`any`/`trigram`/`token_set` por la **misma** evidencia; la suma
acumula y el bonus de agreement premia la co-ocurrencia. `[CALCULADO]` Un literal ≥3 chars
acumula hasta 3.50/5.20 ≈ **67 % del techo** con **una sola** evidencia textual.

**¿Coincidencia literal activa varios mecanismos automáticamente?** `[MEDIDO]` Sí: 93,4 % con
≥2 métodos, 80,8 % con ≥3.

**¿Perjudica a embeddings-only?** `[CALCULADO]` Sí, estructuralmente: el semántico (0.80) queda
por debajo de un literal fuerte (3.50) y el _admission gate_ literal puede excluirlo cuando hay
solape lexical.

**¿Conviene agrupar familias lexical/semántica/contextual y combinar lexicales primero?**
`[ANÁLISIS]` Es la mitigación conceptualmente más limpia: agrupar canales lexicales
correlacionados antes de fusionar con el semántico reduce el doble conteo. Implica re-tuning
completo (costo alto).

**¿RRF vs esquema actual?** `[LITERATURA]` RRF (Cormack 2009, k=60) es escala-libre pero
**descartaría las magnitudes** que hoy usan floors/confianza, y **no elimina por sí solo** la
redundancia multi-canal. Bruch et al. muestran que CC normalizada ≥ RRF y es más robusta. El
plan eligió CC; RRF queda como opción futura.

**Reflexión — ¿complementariedad real o favorecimiento artificial de multi-mecanismo?**
`[MEDIDO]`/`[ANÁLISIS]` Ambas: hay canales complementarios genuinos (fuzzy/trigram dueños
únicos), pero **sí hay favorecimiento artificial** — los documentos que activan más canales
lexicales correlacionados obtienen suma + bonus ("doble conteo" estructural).

---

### Tema 7 — Calidad real

**Conjunto representativo.** La suite fixture cubre 297 casos por tipo/segmento: `exact`,
`phrase`, `prefix`, `substring`, `typo`, `identifier`, `and`, `or`, `not`, `bilingual`,
`filter`, `negative` (noise). `[MEDIDO]`

**Baseline (RAG off).** `[MEDIDO]` 246/297 (82,8 %), P@k 97,9 %, R@k 91,6 %, noise 0/10, MRR
0,989, nDCG@10 0,936.

**Ablación.** `[MEDIDO]`

| config         | passed |  P@k |  R@k |  FP | noise |   MRR | nDCG@10 |
| -------------- | -----: | ---: | ---: | --: | ----: | ----: | ------: |
| baseline (all) |    246 | 97,9 | 91,6 |  17 |  0/10 | 0,989 |   0,936 |
| −trigram       |    236 | 95,8 | 88,8 |  20 |  0/10 | 0,966 |   0,908 |
| −fuzzy         |    238 | 95,5 | 89,1 |  17 |  0/10 | 0,964 |   0,911 |
| −both          |    224 | 93,8 | 85,7 |  14 |  0/10 | 0,942 |   0,877 |
| −token_set     |    246 | 97,9 | 91,6 |  17 |  0/10 | 0,989 |   0,936 |

**Deltas por segmento.** `[MEDIDO]` `typo`: 8/8 → **1/8** sin fuzzy. `substring`: 7/7 →
**1/7** sin trigram. `−both`: 22 flips (unión). `−token_set`: **0 flips**.

**Conclusión de ablación.** `[MEDIDO]` (1) `fuzzy` es **dueño único** del recall de typos.
(2) `trigram` es **dueño único** del substring. (3) Ambos son **complementarios**, no
redundantes. (4) `token_set` **no aporta nada**. (5) `negative`/noise 0/10 en toda
configuración.

**Sólo-semántico: NO medible offline.** `[PROYECTADO]`/documentado. Sin provider key y sin
embeddings en fixtures (sólo 218/4493 memorias reales tienen uno), el canal semántico es
estructuralmente inalcanzable con RAG off. No se falseó. **Qué haría falta:** provider key +
generar/almacenar embeddings para el corpus fixture + re-correr la suite RAG on vs off (corrida
online, no determinista).

**Long-doc small-match.** `[MEDIDO]` Sin pérdida de recall (`zebrafish` en 8.789 B → rank 1;
`w450 w451` → único resultado).

**Calibración.** `[ANÁLISIS]` No existe hoy. Haría falta un set etiquetado + curvas
reliability/ECE por bucket.

**Reflexión — ¿cuánto aporta cada método? ¿sacrificamos espacio/complejidad por margen?**
`[MEDIDO]` Fuzzy y trigram aportan de forma **decisiva** en su nicho (8/8 y 7/7 exclusivos). El
resto de los canales aporta poco marginal tras la redundancia; `token_set` aporta **cero**. Sí
se sacrifica espacio (52 % de la DB en trigram) y complejidad (7 canales) por un margen que, en
el corpus actual, es **alto en redundancia**.

---

### Tema 8 — Rendimiento, concurrencia y SQLite

**¿Paralelismo real o concurrencia de app?** `[CÓDIGO]` **Ni uno ni otro de forma útil**: no hay
paralelismo real; la "concurrencia" es conceptual (independencia lógica). Todo corre secuencial
en **un hilo**.

**¿Limitaciones de concurrencia SQLite? ¿conexiones/pool?** `[CÓDIGO]` El store usa una conexión
`bun:sqlite` síncrona; sin pool. SQLite serializa las escrituras; en lectura, todo queda en el
mismo hilo.

**¿Mejoras medibles del paralelismo? ¿competencia por recursos?** `[ANÁLISIS]` No hay
paralelismo que medir; la única mejora medible sería introducirlo (no implementado). No hay
competencia por recursos hoy porque no hay concurrencia.

**¿Tiempos individuales por mecanismo?** `[MEDIDO]` Share por canal sobre 675 búsquedas:

| canal     | total (ms) | calls | media (ms) |             share |
| --------- | ---------: | ----: | ---------: | ----------------: |
| **fuzzy** |     64.392 |   675 |      95,40 |        **74,9 %** |
| **like**  |     10.819 |   150 |      72,13 |        **12,6 %** |
| any       |      6.791 |   125 |      54,33 |             7,9 % |
| trigram   |      3.254 |   575 |       5,66 |             3,8 % |
| all       |        726 |   675 |       1,08 |             0,8 % |
| phrase    |         39 |   125 |       0,32 |              ~0 % |
| semantic  |          — |     0 |          — | skipped (RAG off) |

**¿Latencia total p95?** `[MEDIDO]` **p50 125,7 ms / p95 596,9 ms** (n=675). La
"contradicción" reportada con la clase 5+ términos NL (p50 ~798 ms) **se resuelve**: ver
§3.8 nota de latencia abajo.

**¿Espera a todos? ¿mecanismo lento?** `[CÓDIGO]`/`[MEDIDO]` Secuencial ⇒ espera a todos por
construcción. El **mecanismo lento es el fuzzy** (74,9 %), disparado en **cada** consulta no
vacía: reconstruye un vocabulario (≤2000 docs) y corre OSA contra todo el vocabulario.

**¿Índices/planes correctos?** `[CÓDIGO]` Los rungs/trigram usan índices FTS5 (`MATCH`); el
`like` es un **full-table scan** (`LIKE '%x%'`), inevitable para sub-3 chars. Los planes no
fueron inspeccionados con `EXPLAIN QUERY PLAN` (limitación).

**¿Costo CPU/memoria de la fusión?** `[ANÁLISIS]` La fusión (min-max + suma) es O(nº
candidatos × nº canales) y barata; el costo real está en los canales, no en la fusión. La
latencia **correlaciona con el tamaño del result set** (post-retrieval `rowsById`/token_set/
admisión), p.ej. `id` → 3732 resultados → 366 ms.

#### Nota de latencia (resolución de la inconsistencia)

El `behavior/summary.md` reporta simultáneamente "overall p50 125,7 ms / p95 596,9 ms (n=675)"
y "5+ term NL queries p50 ~798 ms". **No es una contradicción**; son dos poblaciones
distintas. `[MEDIDO]` (recalculado desde `artifacts/p3.json`):

- La clase `iv_long_nl` (5+ términos NL) tiene **n=50** de 675 (7,4 %) y su **p50 = 797,6 ms /
  p95 = 855,9 ms**.
- **Todas** las muestras de esa clase (mín. 570,7 ms) son más lentas que el máximo de **todas**
  las demás clases (máx. global de las otras = 381,2 ms). Por lo tanto ocupan **exactamente los
  50 ranks más lentos** (626-675) de la distribución ordenada.
- El **p95 global** (rank ≈ 642 de 675) cae dentro de esa cola lenta, concretamente en el
  extremo rápido de la clase iv, por eso da 596,9 ms — que es **menor** que el p50 de la clase
  iv.
- El **p50 global** (125,7 ms) refleja que el **92,6 %** de las consultas son más rápidas que la
  clase iv.

**Valores finales usados en este documento:** overall **p50 125,7 ms / p95 596,9 ms**; clase
5+ términos NL **p50 797,6 ms / p95 855,9 ms**. Caveat: ms absolutos dependientes de máquina y
disco; las **shares** y el **orden relativo de clases** son la señal durable.

**Reflexión — ¿la concurrencia mejora tiempos?** `[ANÁLISIS]` Como palanca de latencia, el
paralelismo real ofrecería poco: los canales comparten la misma conexión SQLite síncrona y el
cuello dominante (fuzzy) es **CPU/I-O secuencial en un hilo**, no espera de red. La palanca
correcta es **optimizar/limitar fuzzy** o introducir **presupuestos por canal**, no
paralelizar.

---

### Tema 9 — Alternativas y simplificación (sin reemplazar la arquitectura)

Ver la tabla comparativa en **§5 Alternativas**. Resumen de las palancas evaluadas:

- **Optimización del índice trigram**: `content='' + contentless_delete=1` (−6,27 MB, mismo
  comportamiento). `[MEDIDO]`
- **Indexación selectiva**: p.ej. sólo `name` (menos espacio, pierde substring en contenido) —
  **no medido**, recomendado evaluar. `[ANÁLISIS]`
- **Fuzzy sobre candidatos**: ya es sobre candidatos (prefiltro trigram); el límite vulnerable
  es el `LIMIT 2000` del vocabulario y el costo de OSA. `[CÓDIGO]`
- **Índices auxiliares**: no evaluados. `[ANÁLISIS]`
- **Agrupación de señales**: agrupar lexicales antes de fusionar con semántico reduce doble
  conteo; costo de re-tuning alto. `[ANÁLISIS]`
- **Ranking/calibración**: separar `score` de `confianza`; calibración real requiere datos
  etiquetados. `[ANÁLISIS]`
- **Reducción de duplicación**: quitar `token_set` (0 flips). `[MEDIDO]`
- **Desactivar mecanismos costosos**: fuzzy es el más caro; desactivarlo pierde typos. `[MEDIDO]`

---

### Tema 10 — Conclusión crítica

Ver **§7 Conclusión arquitectónica** para las 10 respuestas finales explícitas.

---

## 4. Hallazgos críticos

| #   | Hallazgo                                                                                                                         | Consecuencia                                                                                                     | Evidencia                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| H1  | **R1: recall silencioso con acentos.** Índice trigram guarda texto raw; query plegada. `figuracio` no encuentra `configuración`. | Substring/partial-word falla en docs acentuados, **sin error visible**. Impacto corpus-wide **no cuantificado**. | `[MEDIDO]` (`p1.json`; retrieval gap, no coverage gap) |
| H2  | **`score` relativo y no calibrado.** `score=fused/maxFused`; buckets desde el score relativo.                                    | Mismo match → distinto bucket según la consulta; "confianza" no es probabilidad; no comparable entre consultas.  | `[CÓDIGO]` `[ANÁLISIS]`                                |
| H3  | **Semántico estructuralmente desfavorecido.** Semántico máx 0.80 vs literal fuerte 3.50; admission gate literal puede excluirlo. | Paráfrasis sin solape literal quedan confinadas a escenarios "lexical vacío".                                    | `[CALCULADO]` `[CÓDIGO]`                               |
| H4  | **Redundancia lexical (93,4 % ≥2 métodos; 80,8 % ≥3)** + bonus de agreement.                                                     | Doble conteo estructural de la misma evidencia textual.                                                          | `[MEDIDO]` (`p1.json`, `p4.json`)                      |
| H5  | **Latencia fuzzy 74,9 % (~95 ms/llamada)**, en cada consulta; clase NL 5+ p50 797,6 ms.                                          | Cuello de latencia dominante; potenciales _timeouts_ en NL largas.                                               | `[MEDIDO]` (`p3.json`)                                 |
| H6  | **Trigram 52 % de la DB (26,18 MB, 5,17× texto)** con `detail=full` + copia de contenido; ~2× escritura.                         | Costo alto con alternativa compatible −24 %.                                                                     | `[MEDIDO]` (`measurements.json`)                       |
| H7  | **Pesos sin retuning documentado**; comentario "tuned" sin artefacto T4.                                                         | El claim de tuning es **engañoso**; no hay evidencia de optimización de pesos.                                   | `[CÓDIGO]`                                             |
| H8  | **`token_set` sin efecto** (0 flips, 0 sole-provenance).                                                                         | Canal puro de redundancia/cómputo.                                                                               | `[MEDIDO]` (`p2.json`, `p4.json`)                      |
| H9  | **"Paralelo" no es paralelo** (secuencial síncrono; async sólo por red).                                                         | El nombre/comentario sobrevende capacidades.                                                                     | `[CÓDIGO]`                                             |
| H10 | **`searchFallback` código muerto en producción.**                                                                                | Deuda/maintenance; confusión sobre la ruta real.                                                                 | `[MEDIDO]` (`behavior/summary.md` §P4)                 |
| H11 | **Migración de degradación lexical ausente**: sólo el semántico tiene try/catch.                                                 | Una excepción lexical tumba la búsqueda completa.                                                                | `[CÓDIGO]`                                             |
| H12 | **Fragmentación**: 17,65 MB reclamables; 95 MB de WAL.                                                                           | Espacio recuperable sólo con VACUUM; churn alto.                                                                 | `[MEDIDO]`                                             |

---

## 5. Alternativas

Comparación ganancia/pérdida/costo/evidencia (base: `research-report.md` §8):

| Alternativa                                                  | Ganancia                           | Pérdida                                                     | Costo impl.                | Evidencia               |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------- | -------------------------- | ----------------------- |
| `content='' + contentless_delete=1` en trigram               | −6,27 MB (−24 % del costo trigram) | columnas NULL (no usadas)                                   | Bajo (DDL + migración v10) | `[MEDIDO]` MC           |
| Fix de plegado R1 (indexar plegado o doble MATCH raw+folded) | Cierra gap de acentos en substring | Migración/rebuild                                           | Medio                      | `[MEDIDO]` R1           |
| Optimizar/limitar fuzzy (prefiltro, vocab cap, costo)        | −latencia (74,9 %)                 | Riesgo de recall marginal                                   | Medio                      | `[MEDIDO]` MD           |
| Quitar `token_set`                                           | Menos cómputo/ruido de diseño      | **Ninguna** en la suite                                     | Bajo                       | `[MEDIDO]` MD (0 flips) |
| Documentar (o re-hacer) el retuning de pesos                 | Honestidad + posible mejora        | Re-validar suite                                            | Bajo                       | `[CÓDIGO]` RB           |
| Admisión semántica separada (no gate literal para semántico) | Semántico compite                  | Riesgo de ruido si RAG mal calibrado                        | Medio                      | `[ANÁLISIS]` RB         |
| `detail=none`                                                | −16,57 MB                          | Rompe >3 chars ⇒ **NO viable**                              | —                          | `[MEDIDO]` MC           |
| Trigram selectivo (p.ej. sólo `name`)                        | Menos espacio                      | Pierde substring en contenido                               | Medio                      | No medido (evaluar)     |
| Agrupar lexicales y luego fusionar con semántico             | Menos doble conteo                 | Re-tuning completo                                          | Alto                       | `[ANÁLISIS]` RB         |
| RRF                                                          | Escala-libre                       | Pierde magnitud usada por floors/confianza; cambia baseline | Medio                      | `[LITERATURA]`          |
| Calibración (`score`→confianza real)                         | Interpretabilidad                  | Datos etiquetados + proceso                                 | Medio-alto                 | `[ANÁLISIS]`            |
| VACUUM/`auto_vacuum`                                         | −17,65 MB reclamables              | Bloqueo momentáneo                                          | Bajo (ops)                 | `[MEDIDO]` MC           |
| Presupuesto/timeout por canal                                | Protege latencia p95/colas         | Puede degradar recall en consultas caras                    | Medio                      | `[ANÁLISIS]`            |

---

## 6. Recomendaciones priorizadas

Ordenadas por relación impacto/esfuerzo. **Todas son recomendaciones** (no hechos); cada una se
justifica con la evidencia medida arriba.

| Prioridad | Recomendación                                                                  | Impacto                                        | Esfuerzo   | Riesgo                               | Justificación                    |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------- | ---------- | ------------------------------------ | -------------------------------- |
| P1        | Adoptar `content='' + contentless_delete=1` en trigram (migración v10)         | −6,27 MB (−12,5 % DB), 0 cambio funcional      | Bajo       | Bajo (sólo columnas NULL, no usadas) | `[MEDIDO]` capacidad equivalente |
| P1        | Arreglar R1 (indexar plegado o doble MATCH raw+folded)                         | Cierra recall silencioso de acentos            | Medio      | Medio (rebuild/migración)            | `[MEDIDO]` gap de retrieval puro |
| P1        | Optimizar/limitar el canal fuzzy (vocab cap, early-exit, costo OSA)            | Reduce el cuello del 74,9 %                    | Medio      | Medio (recall marginal)              | `[MEDIDO]` share dominante       |
| P2        | Quitar `token_set` (o degradarlo a desempate explícito)                        | Elimina cómputo y ruido de diseño              | Bajo       | Muy bajo (0 flips)                   | `[MEDIDO]` sin efecto            |
| P2        | Documentar que los pesos **no** fueron re-tuneados (o re-tunear con artefacto) | Corrige un claim engañoso                      | Bajo       | Bajo                                 | `[CÓDIGO]` sin artefacto T4      |
| P2        | Separar explícitamente ranking y confianza                                     | Claridad semántica; sienta base de calibración | Medio      | Bajo                                 | `[CÓDIGO]`/`[ANÁLISIS]`          |
| P3        | Considerar admisión semántica separada del gate literal                        | Permite que el semántico compita               | Medio      | Medio (ruido si RAG malo)            | `[ANÁLISIS]`                     |
| P3        | Añadir try/catch por canal lexical (degradación)                               | Evita tumbar la búsqueda completa              | Bajo       | Bajo                                 | `[CÓDIGO]` sin guard             |
| P3        | Añadir presupuesto/timeout por canal                                           | Protege latencia p95/colas                     | Medio      | Medio                                | `[ANÁLISIS]`                     |
| P4        | Evaluar trigram selectivo / agrupar familias lexicales                         | Menos espacio / menos doble conteo             | Medio-alto | Alto                                 | `[ANÁLISIS]` no medido           |
| P4        | Eliminar o aislar `searchFallback` muerto                                      | Reduce deuda                                   | Bajo       | Bajo                                 | `[MEDIDO]` sin callers           |
| P4        | Programar VACUUM/`auto_vacuum`                                                 | −17,65 MB                                      | Bajo (ops) | Bajo                                 | `[MEDIDO]` fragmentación         |

---

## 7. Conclusión arquitectónica

### Evaluación global

La arquitectura elegida —**canales independientes + fusión ponderada**— es **la adecuada para el
objetivo** y está **implementada de forma correcta y determinista**. El parser, los rungs, la
sincronización FTS, el dueño único de substring (trigram) y de typos (fuzzy), la degradación del
semántico y la suite de evaluación son activos sólidos. La crítica principal no es de corrección
sino de **proporción**: para el corpus y modo actuales, el sistema está **sobredimensionado**
(redundancia lexical alta, trigram caro, fuzzy costoso) y arrastra defectos **silenciosos**
(R1) y **claims sin respaldo** (pesos "tuned").

### Las 10 preguntas finales del auditor

1. **¿Bien diseñada?** **Sí en concepto, con reservas en ejecución.** `[CÓDIGO]`/`[MEDIDO]` El
   fan-out lógico + fusión es correcto; las reservas son la redundancia (93,4 %/80,8 %), el
   naming "paralelo" (no lo es) y el costo del trigram/fuzzy.
2. **¿Trigramas correctos y justificados?** **Correctos** (nativo, sync paritario, migración
   segura) y **funcionalmente justificados** (dueño único del substring, 7/7 → 1/7), pero
   **económicamente mejorables** (52 % de la DB; contentless viable −24 %). `[CÓDIGO]`/`[MEDIDO]`
3. **¿Fuzzy conceptualmente correcto?** **Sí** (OSA + prefiltro), con **alcance estrecho** (los
   primeros 3 chars son irrecuperables) y **costo alto** (74,9 % de latencia). `[CÓDIGO]`/`[MEDIDO]`
4. **¿Ranking combina bien?** **Razonablemente**, pero con **normalización por consulta** (no
   comparable entre consultas), **pesos sin retuning documentado**, `token_set` inútil y
   **semántico desfavorecido**. `[CÓDIGO]`/`[CALCULADO]`
5. **¿Score es confianza o heurística?** **Heurística de ranking.** No es probabilidad
   calibrada; los buckets son reglas sobre el score relativo. `[CÓDIGO]`/`[ANÁLISIS]`
6. **¿Sobredimensionado?** **Para el modo lexical offline actual, sí**: el trigram cuesta 52 %
   de la DB y la redundancia es alta; las palancas simples valen más que más mecanismos.
   `[MEDIDO]`
7. **¿Qué mantener y reconsiderar?** **Mantener:** pipeline unificado, parser/rungs,
   fuzzy/trigram como dueños únicos, degradación/breaker, determinismo, suite de evaluación.
   **Reconsiderar:** pesos sin tuning, `token_set`, admisión semántica, plegado R1, tamaño del
   trigram, latencia del fuzzy. `[ANÁLISIS]`
8. **¿Críticos/importantes/menores?** **Críticos:** R1 (recall silencioso), latencia fuzzy
   (75 %), admisión que anula el semántico. **Importantes:** redundancia/bonus, `score` no
   comparable, contentless, `token_set`, pesos sin tuning. **Menores:** comentario "tuned",
   `columnsize`, paginación en 3 capas, `searchFallback` muerto. `[MEDIDO]`/`[CÓDIGO]`
9. **¿Tres mejoras top costo/beneficio?** (a) **contentless_delete** (−6,27 MB, bajo costo);
   (b) **fix R1** (recall de acentos); (c) **optimizar/limitar fuzzy** (latencia) — con
   (d) **quitar `token_set`** casi gratis. `[MEDIDO]`
10. **¿Rediseño distinto respetando búsquedas paralelas?** **Sí, incremental** (no reemplazar
    la arquitectura): (i) agrupar canales lexicales antes de fusionar con el semántico; (ii)
    separar confianza del ranking; (iii) presupuesto de latencia por canal; (iv) trigram
    configurable (contentless); (v) calibración con set etiquetado. El resto se mantiene.
    `[ANÁLISIS]`

---

## Apéndice — Método y límites

### Método de medición de almacenamiento

- **`dbstat` no disponible** en este build (`bun:sqlite` 1.3.14 / SQLite 3.53.0):
  `SELECT ... FROM dbstat` → `no such table: dbstat`. Se usó el método por **deltas de tamaño
  de archivo** sobre copias `VACUUM INTO` independientes +
  `PRAGMA page_count/page_size/freelist_count`.
- **`sqlite3` CLI no instalado.**
- **Quirk de bun:** `new Database(p,{readonly:false})` lanza `SQLITE_MISUSE`; el constructor
  por defecto abre read-write. `{readonly:true}` funciona.
- El snapshot compacto `live.db` salió de `VACUUM INTO` sobre una conexión **read-only** al
  `data/mind.db` original (VACUUM INTO sólo escribe el destino). El original **nunca** se abrió
  en escritura.
- Postings FTS medidos directamente como `sum(length(block))` sobre `<fts>_data`; la copia
  interna de contenido sobre `<fts>_content`.

### Método de medición de comportamiento

- Todas las mediciones corren en una **copia** del repo
  (`/tmp/opencode/search-audit/behavior/repo-copy`) con instrumentación **env-gated**
  (`AUDIT_SKIP`/`AUDIT_TIMING`) — con ambas variables sin setear, el motor es byte-equivalente
  (hash de baseline y 246 passes sin cambios).
- Corpus real: **4.493 memorias, 86 spaces, 218 embebidas, schema v9** (copia read-only).
- MRR/nDCG@10 se computaron en el runner de auditoría sobre las refs ordenadas (el
  `evaluator.ts` stock no los expone y no se modificó).

### Límites explícitos

- **Semántico no medible offline**: sin provider key y sin embeddings en fixtures. Su análisis
  es estructural/aritmético, no medido. `[PROYECTADO]`/`[ANÁLISIS]`
- **R1 — impacto corpus-wide no cuantificado**: confirmado en stores craft; la concentración de
  acentos en el fixture real se desconoce.
- **Latencia dependiente de máquina/disco**: los ms absolutos son de una sola máquina; las
  **shares** y el **orden relativo de clases** son la señal durable.
- **Proyección a 100k no medida** (presupuesto): banda 400–556 MiB, `[PROYECTADO]`.
- **Artefactos efímeros en `/tmp`**: los números de este documento dependen de que
  `/tmp/opencode/search-audit/` no se borre; los valores clave están transcritos aquí.
- **Pesos sin artefacto de retuning**: no hay reporte T4 archivado.

### Comandos reproducibles (resumen)

```bash
# setup de la copia
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'data' <repo>/ /tmp/opencode/search-audit/behavior/repo-copy/
ln -sfn <repo>/node_modules /tmp/opencode/search-audit/behavior/repo-copy/node_modules

# probes / ablaciones / latencia / contribución
MIND_RAG=false bun run scripts/audit-p1-probes.ts
MIND_RAG=false bun run scripts/audit-accent-raw.ts
MIND_RAG=false AUDIT_SKIP=trigram bun run scripts/audit-p2-ablation.ts
MIND_RAG=false bun run scripts/audit-p2-ablation.ts
MIND_RAG=false AUDIT_TIMING=1 bun run scripts/audit-p3-latency.ts
MIND_RAG=false bun run scripts/audit-p4-contribution.ts
```

---

## Apéndice B — Verificación de números contra artefactos

Cada número de este documento se cotejó contra el artefacto crudo antes de usarse.

| Número en el documento                        | Fuente del artefacto                                         | Estado          |
| --------------------------------------------- | ------------------------------------------------------------ | --------------- |
| Delta trigram 26.177.536 B                    | `storage/measurements.json` → `trigram_delta_bytes`          | ✅ verificado   |
| Main FTS 9.887.744 B                          | `measurements.json` → `main_fts_delta_bytes`                 | ✅ verificado   |
| FTS combinadas 36.065.280 B                   | `measurements.json` → `combined_fts_delta_bytes`             | ✅ verificado   |
| Compacta 49.942.528 B                         | `measurements.json` → `live.db_bytes`                        | ✅ verificado   |
| Raw 67.596.288 B                              | `measurements.json` → `mind.db_bytes`                        | ✅ verificado   |
| Contentless delete Δ −6.270.976 B             | `measurements.json` → `contentless_delete1.delta_vs_default` | ✅ verificado   |
| `detail=none` Δ −16.568.320 B                 | `measurements.json` → `detail_none.delta_vs_default`         | ✅ verificado   |
| Escritura +52 %/+114 %/+97 %                  | `measurements.json` → `overhead_pct_median`                  | ✅ verificado   |
| Co-overlap 93,4 % ≥2 / 80,8 % ≥3              | `behavior/artifacts/p1.json` → `p1d_cooverlap`               | ✅ verificado   |
| Ablación typo 8/8 → 1/8                       | `p2.json` → `configs.minus_fuzzy.by_type.typo`               | ✅ verificado   |
| Ablación substring 7/7 → 1/7                  | `p2.json` → `by_type` (minus_trigram)                        | ✅ verificado   |
| `−token_set` 0 flips                          | `p2.json` → `configs.minus_token_set` = baseline             | ✅ verificado   |
| MRR 0,989 → 0,942                             | `p2.json` → `overall.mrr` (baseline / minus_both)            | ✅ verificado   |
| nDCG 0,936 → 0,877                            | `p2.json` → `overall.ndcg10`                                 | ✅ verificado   |
| Fuzzy share 74,9 %                            | `p3.json` → `channel_timing.share.fuzzy` = 0.7486            | ✅ verificado   |
| Latencia overall p50/p95                      | `p3.json` → `overall`                                        | ✅ verificado   |
| Clase 5+ NL p50 797,6 ms                      | `p3.json` → `per_class[iv_long_nl]`                          | ✅ verificado   |
| `token_set` sole-provenance 0                 | `p4.json` → `sole_provenance`                                | ✅ verificado   |
| R1 `figuracio`→`configuración`: no recuperado | `p1.json` → `p1a_accent.probes[acc-sub]`                     | ✅ verificado   |
| `detail=none` incompatibilidad >3 chars       | `measurements.json` → `capability_matrix_MEASURED`           | ✅ verificado   |
| Proyección 100k 400–556 MiB                   | `measurements.json` → `projection_100k_PROJECTED`            | ✅ (proyectado) |

**No verificados / mantenidos como declarados**: MRR/nDCG fueron computados por el runner de la
auditoría **y** figuran como literal en `p2.json` (`configs.*.overall.mrr|ndcg10`), verificado
(ver tabla arriba).
El impacto corpus-wide de R1, la ablación semántica y la proyección a 100k **no** son
verificables con la evidencia actual y se mantienen etiquetados como `[PROYECTADO]`/documentado.
