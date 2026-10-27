# Análisis de handoff — Benchmark de memoria para agentes (00008)

- **Feature:** `00008-agent-memory-benchmark`
- **Repositorio:** `benchmarks/agent-memory`
- **Fecha:** 2026-10-19
- **Estado:** análisis de cierre (documento de handoff, no una corrida nueva)
- **Audiencia:** un agente más potente que deba analizar estos resultados y proponer
  mejoras. El documento es autocontenido: hechos medidos, huecos declarados y
  experimentos priorizados, separados explícitamente.
- **Alcance de evidencia:** sólo números ya registrados en los artefactos citados
  en la sección 10. No se ejecutó ninguna medición nueva para escribir este
  documento.
- **Documentos fuente:**
  [`REPORT.md`](REPORT.md) ·
  [`results/run-benchmark-v10-20261018-171402/`](results/run-benchmark-v10-20261018-171402/) ·
  [`integrations/agent-memory-bench/COMPARISON.md`](integrations/agent-memory-bench/COMPARISON.md) ·
  [`integrations/agent-memory-bench/comparison.json`](integrations/agent-memory-bench/comparison.json) ·
  [`.work/diag-mind-recall-20261019.md`](.work/diag-mind-recall-20261019.md)

## Etiquetas de evidencia

Cada afirmación numérica lleva una etiqueta:

- `[MEDIDO]` — observado en una corrida y registrado en un artefacto.
- `[CALCULADO]` — aritmética derivada de valores medidos (deltas, medias, ratios).
- `[CÓDIGO]` — hecho verificado leyendo el código del harness o de Mind.
- `[LITERATURA]` — respaldado por documentación previa del repo o fuentes externas.
- `[HIPÓTESIS]` — conjetura explicativa o de mejora **no medida**: no es un hecho.

**Regla de lectura.** Los hechos medidos se separan de las recomendaciones y
hipótesis. Ningún número fue inventado; donde algo no se midió se declara como
hueco. **No se comparan cifras de distintos protocolos/hosts** (ver sección 5 y 11).

---

## 1. Resumen ejecutivo

**Qué se midió.** Tres bloques de evidencia, cada uno con su propio protocolo:

1. **Benchmark propio (LoCoMo `conv-26`, 30 preguntas × 3 reps).** Condiciones
   `no-memory` y `mind-v10`; A1 retrieval (sin LLM) y A2 answering real con juez
   ciego. `mind-v9` no se ejecutó.
2. **Comparación cross-sistema (`agent-memory-bench`, `conv-26`, 120 probes).**
   Mind v10 bajo el harness de un tercero, en dos condiciones: **RAG OFF** y
   **RAG ON** (embeddings). Más una fila de **Mem0** re-corrida en el mismo host.
3. **Diagnóstico sin costo** de por qué el recall de Mind es bajo (replay de 120
   consultas, 0 llamadas LLM).

**Qué NO se midió (huecos, no conclusiones).**

- El **lado escritura** del agente: en A2 no hubo ninguna escritura del agente
  (`a2.ts` no instruye escribir) y la ingestión fue CLI determinista. Los
  escenarios **B no se ejecutaron**. Por lo tanto, ningún resultado describe cómo
  un agente _escribe_, consolida o promueve memorias (sección 7).
- **`mind-v9`** en A1/A2 y la comparación v9↔v10 (sección 3).
- **Múltiples conversaciones**: todo el análisis es sobre `conv-26` (sección 11).
- El **costo del benchmark B** y de v9 (no ejecutados).

**Conclusiones honestas.**

- `[MEDIDO]` Mind **aporta frente a no usar memoria** en el benchmark propio: el
  juez ciego pasa de **0.200 → 0.594** (+0.394; **+197 %**) y el F1 medio de
  **0.019 → 0.339**. El costo observable es de $0.2312 de un tope de $5.
- `[MEDIDO]` El **techo está en el retrieval y en su granularidad**, no en el
  modelo: el recall de 35.9 % (agent-memory-bench) se descompone en hit@10 de
  **55.4 %** (51/92) por respuesta correcta con evidencia completa de **65.9 %**
  (27/41). **39/92** preguntas no traen ninguna evidencia en el top-10.
- `[MEDIDO]` **`embeddings` no es la palanca #1.** Encender RAG movió el recall
  sólo **35.9 % → 39.1 % (+3.2 pp)** a **~34× de latencia** de búsqueda y **~7.3×**
  de ingestión, con multi-hop **plano** (17.6 % → 17.6 %) y temporal **bajando**
  (54.5 % → 50.0 %). Esto **refuta** la hipótesis de que activar embeddings sea la
  mejora de mayor impacto. La palanca #1 es la **granularidad de evidencia/vecinos**
  `[HIPÓTESIS]` (una memoria T3 por turno no puede cubrir preguntas multi-evidencia:
  **0/20** multi-hop tuvieron toda la evidencia en el top-10).
- `[MEDIDO]` El gate de admisión se comporta como un **AND de todos los términos**:
  la consulta abstracta `conv-26:080` devuelve **0 resultados**, mientras que
  agregar una entidad concreta recupera 9–10.
- `[MEDIDO]` Regresión adversarial: Mind **cae de 18 a 15** abstenciones correctas
  (3 alucinaciones), juez adversarial 1.000 → 0.833.

**Recomendación para el agente analista.** Atacar **primero la granularidad de
evidencia** (E1) y el **lado escritura** (E2), que hoy es una superficie no medida
y con drift guía↔tools; los embeddings van últimos (E5). Ver secciones 6–8.

---

## 2. Protocolos y procedencia

Cada bloque de evidencia tiene su propio protocolo. **No se mezclan entre sí**
(salvo las aclaraciones explícitas).

| Bloque                               | Dataset / workload                                                                              | Modelo (answer/judge)                              | Host       | Juez                    | Reps                       | SHA                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- | ----------------------- | -------------------------- | -------------------------------------------------------- |
| Benchmark propio (A1+A2)             | LoCoMo `conv-26`, 30 preguntas, seed `20261018`                                                 | `deepseek/deepseek-v4.1-flash` (variant `default`) | OpenRouter | LLM ciego, mismo modelo | 3 por (condición×pregunta) | v10 `c7029b34f20311b81382838de417555941376a8b`; v9 `n/a` |
| Cross-sistema (`agent-memory-bench`) | `conv-26`, 419 turnos, 120 probes (92 respondibles + 28 adversariales), top-10, seed `20260923` | `openai/gpt-4o-mini`, temp 0.0                     | OpenRouter | mismo modelo            | 1                          | harness `0d5d225504865e81467b7d8cb4724c15c1f41664`       |
| Diagnóstico                          | mismos 120 probes del run anterior                                                              | ninguno (0 llamadas LLM)                           | —          | —                       | replay exacto              | misma DB del run                                         |

Datos de entorno comunes al benchmark propio `[MEDIDO]`: OpenCode `2.0.28`, SDK
`2.0.28`, Bun `1.3.14`; dataset LoCoMo sha256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.

**Límites operativos del benchmark propio** `[MEDIDO]`: 30 pasos de sesión y
600 000 ms de timeout por unidad; aislamiento _fail-closed_ (180 dumps de
verificación, 90 por condición); una DB Mind fresca por pregunta; juez ciego con
candidatos anonimizados y orden aleatorizado.

**Costos** `[MEDIDO]`:

| Concepto                                | Costo                   | Base                         |
| --------------------------------------- | ----------------------- | ---------------------------- |
| Benchmark propio (A1+A2), total corrida | $0.2312 / $5.00 de tope | `meta.json`                  |
| — de eso, juez ciego                    | $0.0487                 | `meta.json`                  |
| Cross-sistema RAG OFF                   | ~$0.012 `[ESTIMADO]`    | tokens registrados           |
| Cross-sistema RAG ON                    | ~$0.015 `[ESTIMADO]`    | + ~$0.0004 de embeddings     |
| Mem0 (mismo host)                       | ~$0.65 `[ESTIMADO]`     | per-turn LLM extraction      |
| LangMem re-run                          | $0.00                   | bloqueado en el primer write |

**Caveat del juez** `[LITERATURA]`: el juez del benchmark propio corre en la misma
familia de modelo que el agente medido, así que puede compartir sus puntos ciegos;
se reporta **junto** al scoring determinista, nunca en su lugar.

---

## 3. Benchmark propio (LoCoMo `conv-26`, 30Q × 3 reps)

### 3.1 A1 retrieval (sin LLM) — categorías 1–4 agrupadas

| condition | hit@5 | hit@10 | recall@10 | MRR   | p50 ms | ctx tok@25 |
| --------- | ----- | ------ | --------- | ----- | ------ | ---------- |
| mind-v9   | n/a   | n/a    | n/a       | n/a   | n/a    | n/a        |
| mind-v10  | 0.391 | 0.435  | 0.457     | 0.378 | 26.7   | 1116.9     |

`[MEDIDO]` Denominador evaluable A1 cat1–4 (excluye preguntas sin evidencia):
`mind-v10` **23/24**. Por categoría `[MEDIDO]`: temporal hit@10 **0.833**,
single-hop hit@10 **0.833**; **multi-hop 0.000** y **open-domain 0.000** (n=6 por
categoría).

### 3.2 A2 answering

| condition | n   | reps | correct | partial | incorrect | abst. | halluc. | F1 mean | judge mean |
| --------- | --- | ---- | ------- | ------- | --------- | ----- | ------- | ------- | ---------- |
| no-memory | 90  | 3    | 0       | 9       | 63        | 18    | 0       | 0.019   | 0.200      |
| mind-v9   | n/a | n/a  | n/a     | n/a     | n/a       | n/a   | n/a     | n/a     | n/a        |
| mind-v10  | 90  | 3    | 21      | 28      | 23        | 15    | 3       | 0.339   | 0.594      |

### 3.3 Delta vs baseline (`no-memory`) `[CALCULADO]`

| métrica            | baseline | mind-v10 | abs       | rel          |
| ------------------ | -------- | -------- | --------- | ------------ |
| judgeScoreMean     | 0.200    | 0.594    | +0.394    | **+196.9 %** |
| f1Mean             | 0.019    | 0.339    | +0.320    | +1678.1 %    |
| correctAbstentions | 18.000   | 15.000   | −3.000    | −16.7 %      |
| hallucination      | 0.000    | 3.000    | +3.000    | n/a          |
| memoryCalls        | 0.000    | 1418.000 | +1418.000 | n/a          |

### 3.4 A2 por categoría `[MEDIDO]` (juez medio)

| categoría   | no-memory | mind-v10  |
| ----------- | --------- | --------- |
| multi-hop   | 0.000     | **0.469** |
| temporal    | 0.000     | **0.556** |
| open-domain | 0.000     | 0.417     |
| single-hop  | 0.000     | **0.694** |
| adversarial | **1.000** | 0.833     |

### 3.5 Regresión adversarial `[MEDIDO]`

- `no-memory`: 18/18 abstenciones correctas, 0 alucinaciones, juez 1.000.
- `mind-v10`: 15/18 abstenciones correctas, **3 alucinaciones**, juez 0.833.
- `[CALCULADO]` Es la **única** métrica donde Mind queda por debajo del baseline
  (−0.167). Leer esto junto a 3.2: Mind mejora las categorías respondibles a
  costa de una regresión pequeña y medible en la abstención adversarial.

### 3.6 Uso y costo `[MEDIDO]`

- Llamadas a memoria: `mind-v10` **1418** vs `no-memory` **0**.
- Tokens: `mind-v10` 1 300 273 in / 43 745 out; `no-memory` 564 435 in / 3 723 out.
- Latencia p50 de A2: `mind-v10` **10.2 s** vs `no-memory` 2.95 s.
- Ingestión: 419 turnos en 59 391 ms (~141.7 ms/turno) `[CALCULADO]`.

> **Nota v9↔v10.** Esta corrida **no** ejecutó `mind-v9`; no hay comparación v9↔v10
> en A1 ni en A2. La diferencia de motor entre versiones (v9: cascada
> FTS5→LIKE→embeddings; v10: pipeline multicanal con fusión) es la comparación
> pedida originalmente, pero quedó fuera de esta corrida. Documentarla es un hueco,
> no un resultado.

---

## 4. Embeddings ON vs OFF (`agent-memory-bench`, mismo host)

Mismo harness, mismo host, mismo modelo, mismo workload, mismo día; las dos filas
de Mind difieren **sólo** en `--rag off|on` `[MEDIDO]`.

| Sistema           | Recall | Refused adv. | p50 búsqueda | p95 búsqueda | Tokens mem. | Ingest/turno |   Costo |
| ----------------- | -----: | -----------: | -----------: | -----------: | ----------: | -----------: | ------: |
| Mind v10, RAG OFF | 35.9 % |       96.4 % |      22.0 ms |      52.8 ms |         497 |      0.129 s | ~$0.012 |
| Mind v10, RAG ON  | 39.1 % |       92.9 % |     740.1 ms |     979.0 ms |         503 |      0.939 s | ~$0.015 |
| Mem0 (mismo host) | 57.6 % |       89.3 % |      73.7 ms |     433.6 ms |         360 |      2.791 s |  ~$0.65 |

`[CALCULADO]` Delta RAG ON vs OFF: recall **+3.2 pp** (7 ganadas / 4 perdidas entre
las 92 respondibles), refusal **−3.5 pp**, p50 **+718 ms (~33.6×)**, ingesta
**+0.810 s/turno (~7.3×)**, tokens mem. +6.

`[MEDIDO]` Recall por categoría (mismas 92 respondibles): single-hop 38.6 % → 45.5 %;
**multi-hop 17.6 % → 17.6 % (plano)**; **temporal 54.5 % → 50.0 % (baja)**;
open-domain 11.1 % → 22.2 % (n=9).

`[MEDIDO]` Verificación de indexado: **419/419** memorias embebidas antes de
evaluar, con evidencia dedicada; un índice parcial **aborta** el run en lugar de
degradar en silencio.

**Interpretación.** `[MEDIDO]` La ganancia es modesta y mixta a un costo grande de
latencia. `[CALCULADO]` El provider de embeddings es OpenRouter,
`openai/text-embedding-3-small` (1536 dims). La aserción 419/419 cubre sólo los
embeddings de documentos en ingesta, **no** un fallo de embedding en tiempo de
consulta; sin embargo las latencias RAG ON (740 ms p50 vs 22 ms) muestran que los
embeddings de query sí corrieron. **Conclusión:** encender RAG **no** resuelve el
techo de retrieval; ver sección 6.

---

## 5. Comparativa cross-sistema

Dos tablas con estatus de comparabilidad **distinto**. Leerlas juntas induce error.

### 5.1 Filas mismo-host — comparables entre sí `[MEDIDO]`

Mismo clone, host, modelo, workload, flags y día (sección 4). Sólo Mind y Mem0
tienen fila; **LangMem no tiene fila**: su manager requiere tool calling y el
endpoint tool-capable de `gpt-4o-mini` está excluido por el guardrail de
privacidad/ZDR de la cuenta, por lo que el primer write devolvió HTTP 404 ZDR. Hizo
**0 llamadas LLM** y costó **$0.00** `[MEDIDO]`.

### 5.2 Tabla publicada — **contexto, NO comparable** `[LITERATURA]`

Del run upstream 2026-09-23, con modelo en `api.openai.com` (host distinto al
nuestro). Se reproduce **sólo como contexto**. Ningún número de esta tabla se
compara con las filas de 5.1.

| Sistema (publicado)   | Recall | Refused adv. | p50 búsqueda | Tokens mem. | Ingest/turno |
| --------------------- | -----: | -----------: | -----------: | ----------: | -----------: |
| GoodMem (recommended) | 57.6 % |       82.1 % |       754 ms |         504 |      0.276 s |
| GoodMem (defaults)    | 53.3 % |       92.9 % |       633 ms |         503 |       0.28 s |
| Letta 0.11.7          | 52.2 % |       92.9 % |       318 ms |         503 |       0.37 s |
| Mem0 2.1.0            | 50.0 % |       92.9 % |        38 ms |         353 |       1.52 s |
| LangMem 0.0.30        | 45.7 % |       85.7 % |        68 ms |         884 |       4.15 s |
| Zep / Graphiti 0.30.2 | 37.0 % |       92.9 % |       163 ms |         212 |       3.65 s |

> **Caveat de la fuente publicada** `[LITERATURA]`: el `RESULTS.md` del upstream
> nombra `gpt-4o-mini` en `api.openai.com`, mientras que su README "Models" nombra
> `openai/gpt-oss-120b` vía Groq. El upstream es internamente inconsistente sobre
> su propio run publicado. De cualquier forma es otro modelo y/u host: la tabla
> queda como contexto.

**Reglas de no-mezcla `[LITERATURA]`:** (a) las filas mismo-host son comparables
entre sí; (b) la tabla publicada **no** es comparable con ellas (host y fecha
distintos); (c) nunca se produce un porcentaje global que mezcle protocolos.

---

## 6. Análisis de causas (por qué el recall es 35.9 %)

Todo lo de esta sección es `[MEDIDO]` en el run `run-mind-20261019` y su misma DB
(419 memorias T3, una por turno, `name = dia_id`), por el mismo `GET /api/search`
del adaptador. El replay reprodujo los `context_chunks` de las 120 consultas
exactamente. **No** se compara con la tabla publicada.

### 6.1 Descomposición en dos etapas

El recall 35.9 % se separa en retrieval y respuesta:

| Etapa     | Métrica                            |              Valor |
| --------- | ---------------------------------- | -----------------: |
| Retrieval | hit@10 (alguna evidencia)          | **55.4 %** (51/92) |
| Retrieval | preguntas sin evidencia en top-10  |          **39/92** |
| Retrieval | preguntas con evidencia parcial    |              10/92 |
| Retrieval | preguntas con gold sin evidencia   |               2/92 |
| Respuesta | acierto con evidencia **completa** | **65.9 %** (27/41) |
| Final     | recall                             | **35.9 %** (33/92) |

`[CALCULADO]` Las filas de retrieval particionan las 92 respondibles:
41 completas + 10 parciales (= 51 con alguna evidencia) + 39 sin evidencia + 2 sin
gold = 92.

`[MEDIDO]` Los 39 casos sin evidencia aportan sólo **3 aciertos** (0.077): cuando
el retrieval falla, la respuesta casi siempre falla. Con evidencia completa, se
acierta ~2 de cada 3.

### 6.2 Por categoría (recall / hit@10 / acierto-con-evidencia-completa)

`[MEDIDO]`

| categoría   | recall | hit@10 | acierto con evidencia completa |
| ----------- | -----: | -----: | -----------------------------: |
| single-hop  |  0.386 |  0.523 |                          0.523 |
| multi-hop   |  0.176 |  0.471 |                      **0.000** |
| temporal    |  0.545 |  0.818 |                          0.818 |
| open-domain |  0.111 |  0.222 |                      **0.000** |

### 6.3 Multi-hop (causa estructural)

`[MEDIDO]` **20/92** preguntas requieren más de un turno de evidencia;
**0/20** tuvieron TODA la evidencia en el top-10 (8 parciales). La causa es
estructural: **una memoria T3 por turno + un único fetch top-10** no puede cubrir
preguntas multi-evidencia. La precisión top-10 es **0.087**. Ejemplo:
`conv-26:005` tiene gold `D17:19, D15:13` pero el top-10 trae `D13:1, D14:12,
D14:13, …` (8 chunks) → respuesta incorrecta.

### 6.4 Open-domain y el gate de admisión

`[MEDIDO]` hit@10 open-domain **0.222**. Caso `conv-26:080` ("What personality
traits might Melanie say Caroline has?"): **0 resultados**. Variantes:
"personality traits Caroline" → 9, "Melanie personality Caroline" → 10,
"Caroline personality" → 1. El gate de admisión se comporta como **AND de todos
los términos**: una frase abstracta/metadato cae a 0 mientras que agregar una
entidad concreta la recupera.

`[MEDIDO]` 26/120 probes devolvieron <10 chunks y 2 devolvieron 0 (1 respondible,
1 adversarial).

### 6.5 Granularidad de evidencia

`[MEDIDO]` La respuesta correcta aparece **verbatim** (case-insensitive) en los
chunks recuperados sólo **11/92 = 0.120**; de esas, 8 se juzgaron correctas (3
extraíbles pero no usadas). `[HIPÓTESIS]` Indexar por sesión/tema (en vez de un
turno por memoria) o expandir vecinos co-ubicados haría caer juntos los turnos de
una misma respuesta.

**Ranking de causas (del diagnóstico, `[MEDIDO]`):** (1) recall de retrieval 0.554,
con multi-hop 0 ALL y open-domain 0.222; (2) pérdida en answering/judge aun con
evidencia completa (14/41 fallan); (3) fragilidad de admisión lexical para consultas
abstractas; (4) granularidad de evidencia (una memoria por turno).

---

## 7. Lado escritura (WRITE SIDE)

> **Estado:** sección basada en **inspección de código** `[CÓDIGO]` y en el
> análisis del researcher; **no** en una medición con agente. La escritura por
> agente **nunca se midió**: en A2 no hubo instrucción de escritura, la ingestión
> fue CLI determinista y los escenarios B no corrieron. Todo lo de esta sección son
> hallazgos de diseño y **hipótesis** de impacto, no resultados medidos.

### 7.1 Hallazgos verificados en código

- `[CÓDIGO]` La superficie MCP de escritura es mínima: sólo
  `memory_add`, `memory_update`, `memory_delete`, `memory_read`
  (`src/mcp/tools/memories.ts`). No hay tools de **pin / promote / demote /
  link-edit**.
- `[CÓDIGO]` `memory_query` está anotado `readOnlyHint: true` → **no muta**. El
  protocolo empuja a usar `memory_query` para recuperar; por lo tanto la
  promoción no se dispara al consultar.
- `[CÓDIGO]` La promoción ocurre **sólo** por `memory_read`, que llama a
  `store.recordAccess` (`src/mcp/handlers/memories/read-memory.ts`). `noPromote`
  existe, pero hay que recordarlo.
- `[CÓDIGO]` Los checkpoints nacen directamente en **T1**
  (`src/mcp/handlers/checkpoint/save-checkpoint.ts`, `tier: 1`).
- `[CÓDIGO]` Límites: **T1 = 25**, **T2 = 50** por espacio (`src/config.ts`
  `TIER_LIMITS`); T3 ilimitado.
- `[CÓDIGO]` El store **sí** tiene `patchMemory` interno
  (`src/store/repositories/memory-repository.ts`), pero no está expuesto por MCP:
  `memory_patch` fue **agregado y luego removido** (CHANGELOG) y un test afirma su
  ausencia (`test/mcp-memories-redesign.spec.ts`).

### 7.2 Drift guía ↔ tools

- `[CÓDIGO]` La guía (`src/resources/skill-mind-management.md`, también
  `mind-system-instructions.md` y el template del protocolo) instruye pinear y
  promover memoria; las skills/AGENTS.md repiten esas directivas.
- `[CÓDIGO]` Pero **no existen tools** para pinear/promover/demotear/editar links
  (7.1). El agente **no puede ejecutar** lo que la guía le ordena: drift
  guía↔superficie.
- `[CÓDIGO]` La guía está **duplicada en 4 sitios** (template del protocolo,
  system-instructions, skill-mind-management, AGENTS.md) con drift entre ellos; el
  dedupe es sólo cualitativo ("Novelty", gate de 4 preguntas), sin upsert/supersede
  real (`status:*` es convención). La unicidad es sólo por `(space_id, name)`
  (`src/store/schema.ts`, `UNIQUE(space_id, name)`).

### 7.3 Hipótesis H1–H12 `[HIPÓTESIS]`

| id  | Hipótesis                                                               | Evidencia que la motivaría            |
| --- | ----------------------------------------------------------------------- | ------------------------------------- |
| H1  | La promoción está poco ejercida (sólo `memory_read` promueve).          | 7.1; T1 probablemente infrautilizado. |
| H2  | La guía es **inejecutable** tal como está (pide pin/promote sin tools). | 7.2.                                  |
| H3  | Duplicación de memorias por nombre (UNIQUE sólo por nombre).            | 7.2.                                  |
| H4  | Contaminación de T1 (checkpoints nacen T1 + reads de inspección).       | 7.1.                                  |
| H5  | `promote-on-read` no equivale a importancia/utilidad.                   | sin medir.                            |
| H6  | Staleness sin supersesión real (no hay upsert semántico).               | 7.2.                                  |
| H7  | Naming/tags inconsistentes entre escrituras.                            | sin medir.                            |
| H9  | Sin provenance/confidence en la escritura.                              | 7.1.                                  |
| H10 | Sin merge/TTL de memorias.                                              | 7.2.                                  |
| H11 | Links best-effort (fallos no bloquean la escritura).                    | sin medir el impacto.                 |
| H12 | Proactividad de escritura del agente desconocida.                       | B no ejecutado.                       |

### 7.4 Diseños de medición W1–W5 `[HIPÓTESIS]` (no implementados)

| id  | Qué mediría                                                      | Base                                     |
| --- | ---------------------------------------------------------------- | ---------------------------------------- |
| W1  | Precisión/recall de escritura vs gold.                           | extiende el escenario B1.                |
| W2  | Duplicación / supersesión.                                       | requiere implementar B3 (hoy no existe). |
| W3  | Corrección de promoción (precisión/recall T1; daño de eviction). | 7.1.                                     |
| W4  | Costo/latencia de escritura.                                     | harness actual.                          |
| W5  | Proactividad de escritura.                                       | extiende B4.                             |

### 7.5 Mejoras rankeadas (valor/costo) `[HIPÓTESIS]`

1. Consolidar la guía en **una** fuente ejecutable.
2. Exponer tier/pin/link-edit por MCP (`memory_patch`; el store ya tiene
   `patchMemory`).
3. Hints de dedupe en write-time.
4. `memory_upsert` / supersesión semántica.
5. **Medir** `promote-on-read` **antes** de cambiar la política.
6. Validación write-time (nombre/tags/forma).
7. Higiene de checkpoints (no nacer en T1).
8. Links no best-effort.
9. Provenance / confidence.

---

## 8. Experimentos priorizados `[HIPÓTESIS]`

Esfuerzo e impacto son **estimaciones**, no mediciones. Orden recomendado por
relación impacto/costo; E1 y E2 primero.

| id     | Experimento                                                                                                                             | Ataca                         | Esfuerzo | Impacto esperado                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- | -------------------------------- |
| **E1** | Granularidad de evidencia + vecinos: indexar por sesión/tema o expandir turnos co-ubicados para que la evidencia multi-hop caiga junta. | multi-hop 0/20, hit@10 55.4 % | medio    | **alto** (ataca el techo medido) |
| **E2** | Write-side W1–W5: medir y luego consolidar guía, exponer `memory_patch`, dedupe, upsert.                                                | drift guía↔tools, H1–H12      | medio    | alto (superficie hoy invisible)  |
| **E3** | Gate de admisión / fallback OR para consultas metadato (caso 0-result `conv-26:080`).                                                   | open-domain 0.222             | bajo     | medio                            |
| **E4** | Query rewriting / expansión de entidades y sinónimos antes del search.                                                                  | consultas abstractas          | medio    | medio                            |
| **E5** | Latencia / caché de embeddings: reducir el costo ~34× de RAG sin perder el +3.2 pp.                                                     | p50 22 → 740 ms               | alto     | bajo-medio                       |

**Nota:** E1–E5 son **dirección de iteraciones futuras**, no cambios a este
benchmark. La regla de la feature prohíbe optimizar el motor con estos resultados
dentro de esta corrida.

---

## 9. Preguntas abiertas para el agente analista

5 preguntas heredadas del análisis write-side, sin respuesta medida:

1. ¿El agente usa **`memory_read`** o sólo **`memory_query`**? (Si sólo usa
   `memory_query`, H1 es fuerte: la promoción casi nunca se dispara).
2. ¿Cuál es la **tasa real de duplicación / staleness** de memorias escritas por
   agente? (W2; hoy no medible sin B3).
3. ¿`promote-on-read` **predice utilidad**? (H5; no medir una política no es
   evidencia a favor ni en contra).
4. ¿Qué parte de la guía es **accionable** con la superficie de tools actual?
   (H2; el drift sugiere que mucha no lo es).
5. ¿Está **calibrada** la distinción checkpoint vs memoria durable? (Los
   checkpoints nacen en T1 y son efímeros).

---

## 10. Reproducción

Artefactos y comandos. **Ningún secreto ni path de usuario.** Las credenciales se
leen en runtime desde el almacén del usuario y nunca se imprimen ni persisten.

### 10.1 Benchmark propio

```sh
# Etapa 1 (GRATIS): worktrees + dataset + ingest + A1 (subset completo, 30Q)
bun run benchmarks/agent-memory/src/cli.ts locomo \
  --subset full --conditions mind-v10 --run-id <RUN_ID>

# Etapa 2 (PAGA, tope $5): A2 answering + juez ciego, 3 reps, v10 + baseline
bun run benchmarks/agent-memory/src/cli.ts locomo --answers \
  --run-id <RUN_ID> --conditions no-memory,mind-v10 --reps 3 --budget 5 --confirm

# Etapa 3 (GRATIS): REPORT.md + export curado
bun run benchmarks/agent-memory/src/cli.ts report --run-id <RUN_ID>
```

- **Run ID de los números de la sección 3:** `run-benchmark-v10-20261018-171402`.
- **Export curado:** `benchmarks/agent-memory/results/run-benchmark-v10-20261018-171402/{summary.json,per-question.json}`.
- **Informe:** `benchmarks/agent-memory/REPORT.md`.

### 10.2 Cross-sistema y diagnóstico

- **COMPARISON:** `benchmarks/agent-memory/integrations/agent-memory-bench/COMPARISON.md`
  (y `comparison.json`); runs `run-mind-20261019` (RAG OFF) y
  `run-mind-rag-20261019` (RAG ON). El harness de terceros es
  `agent-memory-bench` @ `0d5d225504865e81467b7d8cb4724c15c1f41664`.
- **Diagnóstico:** `benchmarks/agent-memory/.work/diag-mind-recall-20261019.md`
  (replay sin costo; reproduce `context_chunks` de las 120 consultas).

### 10.3 Nota de esquema v9/v10

Los rótulos "v9"/"v10" son de rama del usuario; el **schema real** de `main` es 8 y
el de `develop` es 10. Documentarlo evita confusión.

---

## 11. Limitaciones

`[LITERATURA]` Limitaciones estáticas del diseño y `[MEDIDO]` hechos específicos.

- **Muestra única.** Todo el análisis cross-sistema es sobre una sola conversación
  (`conv-26`); las diferencias de pocos puntos caen dentro del ruido declarado del
  harness. El benchmark propio también usa `conv-26`.
- **Ruido de pocos puntos.** `n` por categoría es chico (6 en A1; 9–44 en
  agent-memory-bench según categoría). Los ceros de A1 (multi-hop, open-domain) son
  `n=6`.
- **Host ≠ tabla publicada.** Nuestras filas corren el answer/judge en OpenRouter;
  la tabla publicada usó `api.openai.com`. **No comparables.**
- **Juez del mismo modelo.** El juez comparte familia con el agente medido:
  posible sesgo de auto-preferencia. Se reporta junto al scoring determinista.
- **Costos estimados.** Los costos cross-sistema son `[ESTIMADO]` a partir de
  tokens registrados + perfiles de extracción documentados; el harness no factura
  directamente. Sólo el benchmark propio tiene costo real registrado.
- **Benchmark B no ejecutado.** Los escenarios de agente (decisión, bug, cambio de
  decisión, transferencia, información distribuida, ausencia) quedaron `not_run`.
- **Write-side no medido.** Ninguna afirmación de la sección 7 describe
  comportamiento real de escritura; son hallazgos de código + hipótesis.
- **v9 no ejecutado.** No hay comparación v9↔v10 en A1/A2.
- **`mind-v9` y B como opcionales** (~$0.3 y ~$0.3–0.6 estimados) quedaron sin
  autorizar dentro de esta feature.
