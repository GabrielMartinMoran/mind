# Análisis técnico — Mejora de la calidad de memoria y recall de Mind

- **Feature:** `00009-memory-recall-investigation`
- **Repositorio:** `mind` (monorepo local)
- **Fecha:** 2026-10-19
- **Estado:** investigación cerrada; **sin cambios funcionales en producción**
- **Alcance:** calidad de escritura y de recuperación de memoria para agentes, a partir del benchmark 00008 y de experimentos deterministas de replay sobre `conv-26`.
- **Artefactos relacionados:**
  - `benchmarks/agent-memory/REPORT.md` y `benchmarks/agent-memory/ANALYSIS.md` (contexto 00008)
  - `benchmarks/agent-memory/integrations/agent-memory-bench/{COMPARISON.md,comparison.json}`
  - `benchmarks/agent-memory/experiments/REPORTS/{false-negatives,query-strategies,representations,topk,rag-diff}/{report.md,results.json}`
  - Código real: `src/store/repositories/search-repository.ts`, `src/store/shared/search-fusion.ts`, `src/mcp/**`
- **Metodología (resumen):** 120 probes de `conv-26` (92 answerable + 28 adversarial), RAG OFF y ON en corridas separadas, evaluaciones **retrieval-only** (sin LLM de respuesta ni juez en los experimentos), replay exacto del `GET /api/search` del benchmark, DBs SQLite temporales (nunca la DB viva). Costo de los experimentos: **$0**; único costo: embeddings de query de E-RAG (~$0.00007 estimado, no facturado).

## Etiquetas de evidencia

Cada afirmación numérica se etiqueta para separar hechos de propuestas:

- `[MEDIDO]` — observado en una corrida y registrado en un artefacto.
- `[CALCULADO]` — aritmética derivada de valores medidos.
- `[CÓDIGO]` — verificado leyendo el código de producción o de los experimentos.
- `[HIPÓTESIS]` — conjetura explicativa o de mejora **no medida**.

**Regla de lectura:** un impacto `[MEDIDO]` no se mezcla con un impacto esperado. Los
números de retrieval de esta investigación no se comparan con el recall end-to-end del
reporte 00008: son protocolos distintos (retrieval-only vs respuesta + juez).

---

## 1. Resumen ejecutivo

El problema dominante de Mind no es el ranking fino ni los embeddings: es que **la
evidencia correcta no llega a ser candidata o es descartada antes de rankearse**. De
145 ítems de evidencia gold en `conv-26`, solo **65 (44.8 %)** quedan en el top-10;
**28 (19.3 %)** son descartados por la admisión y **35 (24.1 %)** nunca entran como
candidatos `[MEDIDO]`. El piso de coverage y la admisión AND explican el mecanismo: con
muchos tokens, el piso sube y la admisión exige **todos** los nodos de la consulta, de
modo que agregar palabras funcionales **endurece** la búsqueda en lugar de relajarla
`[CÓDIGO]`.

Dos palancas medidas y una habilitante, en orden de costo/beneficio:

1. **Expansión por vecinos de sesión:** +12.2 pp de evidencia completa en top-10 con
   **tokens planos** (461 → 461) y −1.4 pp de precisión, usando solo el nombre
   `D<sesión>:<turno>`; **no requiere grafo ni índice nuevo** `[MEDIDO]`.
2. **Drop conservador de palabras funcionales (S2):** +4.4 pp de evidencia completa y
   +3.3 pp de hit en `conv-26`, con −13 % de tokens; replica con efecto pequeño en
   `conv-44` (+0.8 pp / +1.6 pp) y introduce más probes sin resultados (2 → 6)
   `[MEDIDO]`.
3. **Higiene de escritura y captura de trazas:** costo cero o casi cero, impacto
   **esperado (no medido)**, pero habilitan medir el lado que hoy es invisible
   `[CÓDIGO]` + `[HIPÓTESIS]`.

Los embeddings **no** son la palanca principal: RAG ON gana +5.6 pp de evidencia
completa en top-10 a costa de **53.8×** de latencia p50 (14.3 → 767.8 ms) y no gana
precisión de forma clara `[MEDIDO]`. Agrupar por sesión (V3) sube el recall aparente,
pero está confundido por volumen (19 memorias; el top-10 cubre >50 % del corpus),
multiplica tokens ×14.6 y DB ×3.2, y destruye la referenciabilidad por turno
`[MEDIDO]`.

El lado de escritura por agentes **no está medido**. Lo que sí está verificado es un
**drift guía↔tools**: la guía ordena pinear, promover y mover a T3, pero esas tools no
existen; los checkpoints nacen en T1; la promoción solo ocurre vía `memory_read`
`[CÓDIGO]`. Antes de rediseñar la consolidación conviene corregir el protocolo y medir.

---

## 2. Diagnóstico de falsos negativos (E-WB2)

La clasificación se hizo sobre los dumps instrumentados de las 120 probes, con el cap
de ranking subido a 1000 para eliminar rangos ocultos. El gate de replay pasó:
120/120 conteos, determinismo y paridad instrumentado/plano `[MEDIDO]`.

### 2.1 Etiquetas por ítem (K = 10, primario)

| Etiqueta                       | Ítems |     % |
| ------------------------------ | ----: | ----: |
| `admitted_top10`               |    65 | 44.8% |
| `admitted_outside_top10`       |    17 | 11.7% |
| `dropped_by_admission`         |    28 | 19.3% |
| `dropped_by_coverage`          |     0 |  0.0% |
| `excluded_by_not`              |     0 |  0.0% |
| `ranked_beyond_cap_or_unknown` |     0 |  0.0% |
| `never_candidate`              |    35 | 24.1% |

`[MEDIDO]` Total: 145 ítems gold. En K=25 las etiquetas son 69 / 13 / 28 / 0 / 0 / 35:
subir el corte recupera 4 ítems que ya estaban admitidos, pero **no** rescata ningún
ítem descartado por admisión ni ningún `never_candidate`.

Restringido a los 116 ítems de probes answerable, el reparto en K=10 es 52 / 17 / 19 /
0 / 0 / 28 `[MEDIDO]`. La conclusión estructural no cambia: el cuello está **antes** del
top-10.

### 2.2 Funnel por probe (answerable)

| Estado             | Probes |     % |
| ------------------ | -----: | ----: |
| `ALL`              |     41 | 44.6% |
| `partial`          |     10 | 10.9% |
| `NONE`             |     39 | 42.4% |
| `no_evidence_gold` |      2 |  2.2% |

`[MEDIDO]` Sobre 92 probes answerable. En K=25 el funnel es 44 / 10 / 36 / 2. Los 39
probes sin evidencia concentran el problema: sin contexto recuperado, la respuesta casi
siempre falla.

### 2.3 Por categoría (K = 10)

| Categoría   | Probes | Answerable | top10 | outside10 | dropped_adm | never_cand | ALL | partial | NONE |
| ----------- | -----: | ---------: | ----: | --------: | ----------: | ---------: | --: | ------: | ---: |
| adversarial |     28 |          0 |    13 |         0 |           9 |          7 |  12 |       1 |   15 |
| multi-hop   |     17 |         17 |     9 |        10 |           4 |         13 |   0 |       8 |    9 |
| open-domain |      9 |          9 |     2 |         1 |           7 |          4 |   0 |       2 |    5 |
| single-hop  |     44 |         44 |    23 |         5 |           7 |          9 |  23 |       0 |   21 |
| temporal    |     22 |         22 |    18 |         1 |           1 |          2 |  18 |       0 |    4 |

`[MEDIDO]` Multi-hop y open-domain son los casos extremos: **0** probes con evidencia
completa en top-10 cada uno; en multi-hop, 13 de 17 ítems gold **nunca** fueron
candidatos. Temporal es el caso más sano (18/22 completos). Los adversariales no son
answerable y se excluyen del funnel principal.

### 2.4 Cruce con el veredicto del juez

| Fenómeno                     | Probes | Regla                                              |
| ---------------------------- | -----: | -------------------------------------------------- |
| `retrieved-but-model-failed` |     14 | Evidencia completa en top-10, pero `correct=false` |
| `abstained-with-no-evidence` |     28 | Sin evidencia en top-10 y `abstained=true`         |
| Answerable correctos         |     33 | `correct=true` sobre 92 answerable                 |

`[MEDIDO]` La recuperación no es el único cuello: 14 probes tenían toda la evidencia y
el modelo falló igual. A la inversa, 28 probes se abstuvieron sin evidencia (abstención
correcta). Mejorar retrieval ayuda a un subconjunto, no a todos.

### 2.5 Ejemplos con traza

- **`admitted_top10` — `conv-26:001` (single-hop).** Pregunta: _What creative project
  do Mel and her kids do together besides pottery?_ Gold `D8:5`; candidatos por any,
  trigram, fuzzy, like y token_set; rank final 0; admisión relaxed con 3 kept / 69
  dropped. El juez marca incorrecto por abstención. `[MEDIDO]`
- **`admitted_outside_top10` — `conv-26:000` (single-hop).** Gold `D17:10`; solo entra
  por like/token_set; tras coverage queda vacío; rank final **22** en tier
  `last_resort` (300 kept). El probe termina en `NONE`. `[MEDIDO]`
- **`dropped_by_admission` — `conv-26:002` (single-hop).** Gold `D2:15`; candidatos
  like/token_set; tras coverage vacío; no admitido; relaxed con 65 kept / **348
  dropped**. `[MEDIDO]`
- **`never_candidate` — `conv-26:005` (multi-hop).** Gold `D17:19, D15:13`; el ítem
  `D17:19` no aparece en **ningún** canal candidato. Es el fallo más profundo: no hay
  nada que rankear. `[MEDIDO]`

### 2.6 Caveats del diagnóstico

- **Coverage = 0 es específico de este corpus.** En `conv-26`, todo candidato filtrado
  por coverage también entraba por `like`/`token_set`, que no aplican ese piso. No se
  generaliza a otros corpus o longitudes de consulta `[MEDIDO]`.
- **`dropped_by_admission` no separa subcausas.** Es determinista respecto del dump,
  pero no distingue si el descarte vino del predicado booleano o de un piso interno
  `[MEDIDO]`.
- **Una sola conversación.** `conv-26`, RAG OFF. No se infiere generalización.
- **Sin NOT reales.** Las preguntas naturales no generan operadores NOT; el bucket es 0
  por ausencia de operador, no por corrección del motor `[MEDIDO]`.

---

## 3. Experimento A: consultas enfocadas (deterministas)

Se evaluaron seis estrategias puramente deterministas sobre las mismas 120 probes, sin
usar gold para construir consultas y preservando filtros de space/tag/tier. S1 reproduce
el baseline congelado (funnel y 65 ítems en top-10) `[MEDIDO]`.

| Estrategia                       | queries | hit@10 | full@10 | MRR   | P@10  | tok@10 | 0-res |
| -------------------------------- | ------: | -----: | ------: | ----- | ----- | -----: | ----: |
| S1 `original`                    |    1.00 |  0.567 |   0.456 | 0.382 | 0.094 |    461 |     1 |
| S2 `content-only`                |    1.00 |  0.600 |   0.500 | 0.435 | 0.095 |    401 |     2 |
| S3 `entities`                    |    1.00 |  0.100 |   0.067 | 0.070 | 0.033 |    227 |     0 |
| S4 `entities+content`            |    1.00 |  0.600 |   0.500 | 0.435 | 0.095 |    401 |     2 |
| S5 `two-query (entity∪content)`  |    1.98 |  0.100 |   0.067 | 0.070 | 0.017 |    234 |     0 |
| S6 `two-query (combined∪entity)` |    1.98 |  0.600 |   0.500 | 0.435 | 0.067 |    439 |     0 |

`[MEDIDO]` 92 probes answerable, K=10. S2 es la única estrategia de una consulta que
mejora: **+3.3 pp de hit** y **+4.4 pp de evidencia completa**, con **−13 % de tokens**
(461 → 401), 5 ganancias y 1 pérdida de full@10. S4 produce resultados idénticos a S2:
los tokens de entidad no cambian el ranking; no es una mejora adicional. S3 y S5 son
dañinas (−38.9 pp de full@10): una consulta solo-entidades es demasiado restrictiva y el
cap de K=10 trunca la unión. S6 iguala a S2 con dos consultas y peor precisión.

### 3.1 Réplica en `conv-44`

| Estrategia | hit@10 | full@10 | MRR   | P@10  | 0-res | #res medio |
| ---------- | -----: | ------: | ----- | ----- | ----: | ---------: |
| S1         |  0.537 |   0.439 | 0.355 | 0.083 |     2 |       8.15 |
| S2         |  0.553 |   0.447 | 0.382 | 0.111 |     6 |       6.89 |

`[MEDIDO]` Ingesta determinista de 675 turnos; 123 preguntas answerable. El efecto
conserva el signo pero es chico: **+1.6 pp hit** y **+0.8 pp full**. El costo de
robustez es real: las probes sin resultados pasan de **2 a 6** y bajan los resultados
medios.

### 3.2 Veredicto y caveats

**S2 es un candidato prometedor (efecto chico replicado), no un quick win demostrado.**
Relaja el piso de coverage al quitar palabras funcionales sin eliminar términos de
contenido, con una sola consulta y menos contexto. Pero la ganancia en `conv-44` es
pequeña y el filtro puede vaciar consultas cortas o dependientes de una palabra
funcional `[MEDIDO]` + `[HIPÓTESIS]`.

Caveats: una conversación principal y una réplica; retrieval-only (no mide respuesta ni
abstención); la DB congelada no tiene captions de foto, así que no es byte-comparable
con una ingesta actual.

---

## 4. Experimento B: representación de escritura

Se compararon cuatro representaciones sobre la misma conversación y las mismas 120
probes, con DBs SQLite frescas y RAG OFF.

| Variante                   | Memorias |   DB KB | hit@10 | full@10 | MRR   | P@10  | tok@10 | 0-res |
| -------------------------- | -------: | ------: | -----: | ------: | ----- | ----- | -----: | ----: |
| V1 turno                   |      419 |  4344.0 |  0.589 |   0.489 | 0.385 | 0.104 |    500 |     1 |
| V2 nombre descriptivo      |      419 |  4800.0 |  0.578 |   0.489 | 0.372 | 0.100 |    504 |     0 |
| V2n nombre sin tags nuevos |      419 |  4544.0 |  0.578 |   0.489 | 0.372 | 0.100 |    504 |     0 |
| V3 sesión                  |       19 | 14012.0 |  0.867 |   0.811 | 0.734 | 0.283 |   7282 |     0 |

`[MEDIDO]` K=10, 92 answerable. La DB V1 reportada pesa 4.3 MB; V3, 14.0 MB
(**×3.2**), y devuelve **×14.6** tokens por top-10. Los efectos separados son claros:

- **Nombre descriptivo (V2n − V1):** 0.0 pp de full@10, **−1.1 pp de hit@10** y +4
  tokens. Los metadatos no inventados (sesión, hablante, interlocutor, turno) no mejoran
  el ranking léxico.
- **Tags de procedencia (V2 − V2n):** 0.0 pp en todo. Los tags no participan del
  ranking; sirven para filtrar y mapear evidencia, no para recall.
- **Agrupación (V3 − V1):** +27.8 pp hit y +32.2 pp full, pero con un **confound de
  volumen**: 19 memorias hacen que un top-10 cubra más de la mitad del corpus. Además,
  V3 evalúa por contención de turno dentro de la memoria de sesión, no por una unidad
  atómica comparable.

### 4.1 Caveat de contenido congelado

La DB congelada del benchmark se ingirió **sin** captions `[Photo: ...]`. Una V1 fresca
con captions produce full@10 0.489 y funnel 44/9/37/2, frente a 0.456 y 41/10/39/2 de la
DB congelada `[MEDIDO]`. Por eso el gate se calibró sobre contenido congelado (V1F), y
los números de V1 **no** son directamente comparables con el reporte 00008 sin declarar
esa diferencia.

### 4.2 Lectura estratégica para memorias reales

Para memorias de agente (decisiones, bugs, preferencias, constraints, cambios de
decisión) la mejor base sigue siendo **memoria atómica con procedencia explícita**:
permite citar y leer exactamente lo recuperado `[MEDIDO]` + `[HIPÓTESIS]`. V2/V2n no
compran recall; sus metadatos valen por trazabilidad y filtrado. V3 solo tiene sentido
como **memoria resumen complementaria** para continuidad y multi-hop, nunca como
sustituto del turno atómico. No conviene inventar temas, sentimiento ni relaciones: los
experimentos no los usan y no hay evidencia de que aporten; exigirían un LLM y
agregarían riesgo de alucinación.

---

## 5. Experimento C: multi-evidencia, top-K y vecinos

### 5.1 Top-K

| K   | any   | full  | MRR   | P@K   | #res | tokens | p50 ms |
| --- | ----- | ----- | ----- | ----- | ---: | -----: | -----: |
| 10  | 0.567 | 0.456 | 0.382 | 0.094 |  8.6 |    461 |   16.3 |
| 20  | 0.578 | 0.467 | 0.383 | 0.072 | 15.8 |    842 |   16.5 |
| 30  | 0.611 | 0.500 | 0.385 | 0.067 | 22.2 |   1177 |   16.8 |

`[MEDIDO]` Subir K es monótono pero caro: +343 tokens por +1 pp de full de K=10 a 20, y
+100 tokens por +1 pp de K=20 a 30. Multi-hop apenas se mueve: **0/17 → 0/17 → 1/17**.

### 5.2 Dos consultas con presupuesto total 10

| Opción                          | any   | full  | MRR   | P@10  | tokens | multi-hop full |
| ------------------------------- | ----- | ----- | ----- | ----- | -----: | -------------: |
| S1 original                     | 0.567 | 0.456 | 0.382 | 0.094 |    461 |           0/17 |
| S2 content-only                 | 0.600 | 0.500 | 0.435 | 0.099 |    398 |           0/17 |
| 2 queries: mitades (interleave) | 0.500 | 0.444 | 0.260 | 0.108 |    361 |           4/17 |
| 2 queries: entidad+contenido    | 0.578 | 0.467 | 0.243 | 0.066 |    345 |           0/17 |

`[MEDIDO]` El interleave corrige el truncamiento de E-A, pero las dos consultas no
compensan: mitades baja full y **colapsa MRR** (0.382 → 0.260) aunque duplica multi-hop;
entidad+contenido mantiene full pero destruye MRR y precisión. **No recomendadas.**

### 5.3 Vecinos de sesión

| Opción        | any   | full  | MRR   | P@K   | tokens | multi-hop full |
| ------------- | ----- | ----- | ----- | ----- | -----: | -------------: |
| S1 top-10     | 0.567 | 0.456 | 0.382 | 0.094 |    461 |           0/17 |
| ±1, budget 10 | 0.678 | 0.578 | 0.408 | 0.080 |    461 |           1/17 |
| ±2, budget 10 | 0.667 | 0.578 | 0.404 | 0.073 |    464 |           1/17 |
| S1 top-20     | 0.578 | 0.467 | 0.383 | 0.072 |    842 |           0/17 |
| ±1, budget 20 | 0.689 | 0.589 | 0.409 | 0.051 |    884 |           1/17 |
| ±2, budget 20 | 0.767 | 0.656 | 0.411 | 0.050 |    894 |           2/17 |

`[MEDIDO]` **±1 con budget 10** es la mejor relación costo/beneficio: **+12.2 pp de
full** (0.456 → 0.578) y +11.1 pp de any, con **tokens planos** (461 → 461) y −1.4 pp de
precisión. **±2 con budget 20** logra la mayor ganancia absoluta (**+18.9 pp** vs top-20)
con +6 % de tokens (894 vs 842) y −2.2 pp de precisión; es la única variante que lleva
multi-hop a **2/17**.

La mitad del presupuesto son semillas del ranking y la otra mitad, vecinos de la misma
sesión derivados del nombre `D<sesión>:<turno>`. **No hay grafo persistente.** El
complemento por referencias verificables **no es factible** en esta DB: 0 links y 0
memorias que mencionen otro `dia_id` o sesión `[MEDIDO]`.

### 5.4 Caveats de vecinos

- Depende de la convención de nombres `D<sesión>:<turno>`; si el naming cambia, la
  expansión deja de ser aplicable.
- El orden de vecinos (+1, −1, +2, −2) es determinista pero arbitrario; otro orden
  puede cambiar qué entra al agotarse el presupuesto.
- K>30 y otros presupuestos de vecinos no se midieron.
- Una sola conversación; no mide si el agente usa mejor la evidencia.

---

## 6. Consumo de memoria por OpenCode

El run A2 registró **1418 llamadas** a tools con prefijo `mind_*` en 90 respuestas
(media 15.76; rep0 271, rep1 797, rep2 350) `[MEDIDO]`. Dos hechos limitan el análisis:

- **26/90 respuestas (28.9 %) no hicieron ninguna llamada** a memoria `[MEDIDO]`.
- Una sola respuesta (`conv-26#189`, rep1) concentra **459 llamadas (32 % del total)**;
  es un outlier que domina la media `[MEDIDO]`.
- **Las trazas no se persistieron.** El driver calculó `DriverToolCall{name,server}` en
  memoria y lo descartó salvo `.length`; no hay nombres, argumentos ni transcripts. Por
  lo tanto, la división `memory_query` vs `memory_read`, las redundancias, las queries
  usadas y el `limit` real por llamada son **UNKNOWN** `[CÓDIGO]`.

`memoryCalls` significa **todas** las tools `mind_*` (query, read, space_get, status,
checkpoint, etc.), no “búsquedas de memoria”. Cualquier lectura previa que lo
interpretara como query+read queda corregida `[CÓDIGO]`.

### 6.1 Contrato que ve el agente

`memory_query` devuelve `{name, space, tier, pinned, tags, changed_at, score?,
confidence?, methods?}` — **sin contenido** — con `limit` default 25 y
`readOnlyHint:true`. `memory_read` devuelve el contenido completo y **promueve por
defecto** (`noPromote:true` lo evita) `[CÓDIGO]`.

### 6.2 Hipótesis de preview (no implementada)

Con `estimateTokens = ceil(chars/4)` y una memoria media de ~58 tokens / 233 caracteres,
un preview de 160 / 200 / 240 caracteres costaría **1.000 / 1.250 / 1.500 tokens** por
página de 25 resultados, frente a ~1.446 tokens de una página con contenido completo
`[CALCULADO]`. El CLI ya ofrece un preview de 120 caracteres en `search --detail`.

Riesgos si se implementara: paridad exacta del YAML (hay test de contenido), truncado
unicode y de `[Photo:]`, fragmentos engañosos (la respuesta literal está verbatim en
solo 12 % de los chunks recuperados) y tentación de tocar ranking/score/confidence.
**No se recomienda preview sin datos de consumo.** La captura futura es baratísima:
persistir un histograma de `DriverToolCall.name` y `rawMessages()` redactado en
`result.json` (1–2 líneas, patrón ya usado en el worker de B).

---

## 7. Calidad de escritura por agentes

**Estado: no medida.** En A2 no hubo instrucción de escritura y la ingesta fue CLI
determinista; los escenarios B no se ejecutaron. Todo lo de esta sección es `[CÓDIGO]`
o `[HIPÓTESIS]`, no comportamiento observado.

### 7.1 Drift verificado guía ↔ tools

- La superficie MCP de escritura es `memory_add`, `memory_update`, `memory_delete`,
  `memory_read`. **No hay** `pin`, `promote` ni `demote` (fueron removidas)
  `[CÓDIGO]`.
- La guía ordena pinear, mover a T3 y despinear; el agente **no puede ejecutarlo**
  `[CÓDIGO]`.
- **Corrección:** sí existen `link_create` y `link_delete`; lo que falta es editar el
  label de un link existente `[CÓDIGO]`.
- Los checkpoints nacen en **T1** (`save-checkpoint.ts`), con límites T1=25 / T2=50;
  los reads de inspección también promueven `[CÓDIGO]`.
- La promoción solo ocurre por `memory_read` / CLI read (`recordAccess`). `memory_query`
  es read-only y no promueve `[CÓDIGO]`.
- La unicidad es solo `UNIQUE(space_id, name)`; no hay upsert semántico ni supersesión
  real. `memory_patch` existió, se removió, y el store conserva `patchMemory`
  `[CÓDIGO]`.

### 7.2 Easy wins de protocolo

| #   | Cambio propuesto                                                             | Problema que ataca                      | Esfuerzo |
| --- | ---------------------------------------------------------------------------- | --------------------------------------- | -------- |
| 1   | `memory_query` antes de `memory_add` + `memory_update` en vez de re-add      | Duplicados por nombre y staleness       | trivial  |
| 2   | Nombres estables kebab-case reutilizados                                     | Duplicados y referencias rotas          | trivial  |
| 3   | Checkpoint ≠ memoria durable; no contaminar T1                               | T1 lleno de estado efímero              | trivial  |
| 4   | `memory_query` para recuperar; `memory_read` solo al trabajar con la memoria | Promoción accidental por inspección     | trivial  |
| 5   | Eliminar de la guía pin/demote/T3 y otras instrucciones inejecutables        | Drift guía↔tools                        | trivial  |
| 6   | `links_to` + revisar `links_failed` + reintentar con `link_create{label}`    | Links perdidos silenciosamente          | trivial  |
| 7   | Supersesión en 2 pasos: tag `status:superseded` + link `contradicts`         | Memoria obsoleta sin reemplazo trazable | pequeña  |

### 7.3 Candidatos funcionales (rankeados por valor/costo)

1. Re-exponer `memory_patch` (el store ya está listo; impacto no medido).
2. Upsert/supersede semántico (medio).
3. Hints de dedupe en `memory_add` (pequeño-medio).
4. Validación write-time (nombre/tags/forma).
5. Higiene de checkpoints (no nacer en T1).
6. Links no best-effort.
7. Provenance/confidence en la escritura.
8. **Medir** `promote-on-read` **antes** de cambiar la política.

### 7.4 Esfuerzo de medición

Los escenarios B1/B4 están implementados y listos: 8 sesiones ≈ **$0.01–0.05**, sin juez
LLM, con aserciones deterministas `[CÓDIGO]` + `[CALCULADO]`. B3 (supersesión) requiere
≈0.5–1 día (escenario + fixture + registry + tests). El paquete W1–W5 está mapeado: W4
es trivial, W3 pequeño-medio, W1/W2 medios `[CÓDIGO]`.

---

## 8. Consolidación de memorias (conceptual)

Comparación de cuatro enfoques con costos reales de DeepSeek V4.1 Flash
(**$0.15/M input, $0.60/M output**). Los costos son `[CALCULADO]` a partir de tokens
estimados; no hay factura.

| Enfoque                          | Costo estimado/sesión | Latencia                      | Ventaja                       | Riesgo principal                        |
| -------------------------------- | --------------------- | ----------------------------- | ----------------------------- | --------------------------------------- |
| Escritura por agente (actual)    | ~$0.0017 (proxy A2)   | 0 extra                       | Simple; el agente decide      | Duplicados, staleness, baja cobertura   |
| Ingesta determinista             | $0                    | 141.7 ms/turno                | Reproducible; sin alucinación | Granularidad rompe multi-hop            |
| Consolidación al fin de sesión   | ~$0.0014–0.005        | 1 llamada (5–20k in/1–3k out) | Resume y conecta; barato      | Inventa hechos, pierde detalle, duplica |
| Extracción por turno (tipo Mem0) | ~$0.023–0.124         | +2.791 s/turno                | Hechos atómicos               | No determinista; costo alto             |

`[CALCULADO]` La consolidación por sesión es barata (~1 llamada por sesión) y ataca la
continuidad, pero **no** es ingesta: puede inventar, perder información o duplicar si no
hay upsert. La extracción por turno es la más cara y no determinista; no se recomienda
sin una razón medida. La ingesta determinista es la más segura, pero su granularidad por
turno es justamente lo que hoy rompe multi-hop. **Recomendación condicional:** probar
consolidación por sesión solo como memoria resumen complementaria, con upsert/supersede
y validación; no reemplazar la memoria atómica. **No implementado.**

---

## 9. Embeddings y admission gate (E-RAG)

RAG ON y OFF se ejecutaron por separado, con las mismas 120 preguntas y el mismo space.
La DB ON tiene 419/419 documentos embebidos `[MEDIDO]`. E-RAG es **una sola corrida, sin
intervalo de confianza**: no hay estimación de varianza ni repeticiones.

| K   | Jaccard | ON gana gold | OFF gana gold | full OFF | full ON | Δ full |
| --- | ------: | -----------: | ------------: | -------: | ------: | -----: |
| 10  |   0.726 |            6 |             0 |       41 |      46 | +5.6pp |
| 25  |   0.822 |            6 |             0 |       44 |      48 | +4.4pp |

`[MEDIDO]` La evidencia completa en K=10 pasa de 41/92 a 46/92; P@10 de 9.5 % a 10.1 %
(+0.7 pp) y MRR de 0.387 a 0.394. El desplazamiento es 202 ítems fuera / 227 dentro, con
**0 gold desplazados**. La atribución por ítem es 52 en ambos, **6 solo semánticos, 0
solo léxicos, 58 en ninguno** `[MEDIDO]`.

El costo es un embedding de query por búsqueda: p50 **14.3 → 767.8 ms (53.8×)**, p95
19.6 → 933.3 ms, con **99.9 %** del delta atribuible al embedding. Costo estimado
~**$0.00007** por 360 queries (no facturado) `[MEDIDO]` + `[CALCULADO]`.

### 9.1 Hallazgo estructural

`[CÓDIGO]` En `src/store/repositories/search-repository.ts`, el canal semántico agrega
candidatos a `rowsById` (~:797), pero después **todos** pasan por
`documentSatisfiesQuery(ast, ...)` (~:853). El único camino que admite un candidato
puramente parafrástico es el `last_resort` cuando `finalRows.size === 0` (~:869). Si
existe al menos un candidato léxico que satisface la consulta, el canal semántico **no
puede** introducir evidencia que no cumpla el predicado léxico. Esto explica que la
ganancia sea chica. Además, el costo no está condicionado a utilidad: no hay caché de
embeddings de query y el coseno es O(N) por búsqueda (~:576–623).

### 9.2 Guía de decisión

- **Default OFF para agentes interactivos:** 53.8× de latencia no se justifica por
  +5.6 pp de evidencia completa en un corpus de 419 memorias.
- **ON para batch/offline, corpus pequeños o cuando el usuario tolere ~768 ms.**
- **No usar como parche de precisión:** el desplazamiento de gold es 0 y entran 221
  no-gold; no hay base medida para subir su peso.
- **No ayuda en adversarial/abstención:** la corrida pareada 00008 reportó una caída de
  abstención de 96.4 % a 92.9 % (−3.5 pp). Mantener OFF para ese caso.
- **No tunear pesos** antes de corregir el orden admission-vs-semantic; ese es el cambio
  funcional con mayor probabilidad de hacer que el canal aporte evidencia distinta.

---

## 10. Comparación de alternativas

| Propuesta                             | Problema que resuelve                         | Evidencia                           | Impacto medido/esperado                                     | Esfuerzo | Riesgo                              |
| ------------------------------------- | --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- | -------- | ----------------------------------- |
| Vecinos ±1, budget 10                 | Evidencia multi-turno no recuperada           | E-C `[MEDIDO]`                      | +12.2 pp full, tokens planos, −1.4 pp P                     | pequeño  | Naming `D<sesión>:<turno>`          |
| Vecinos ±2, budget 20                 | Multi-hop y cobertura                         | E-C `[MEDIDO]`                      | +18.9 pp full, +6 % tokens, −2.2 pp P                       | pequeño  | Igual + más contexto                |
| S2 drop de palabras funcionales       | Consultas largas endurecidas por coverage/AND | E-A `[MEDIDO]`                      | +4.4 pp full / +3.3 pp hit en conv-26; +0.8/+1.6 en conv-44 | pequeño  | Más 0-results en conv-44 (2→6)      |
| Captura de trazas OpenCode            | Consumo real desconocido                      | R2 `[CÓDIGO]`                       | Esperado: habilita medición; no medido                      | trivial  | Ninguno relevante                   |
| Easy wins de protocolo                | Drift guía↔tools, duplicados, T1 contaminado  | R3 `[CÓDIGO]`                       | Esperado (no medido)                                        | trivial  | Bajo                                |
| `memory_patch` / upsert / supersede   | Actualización y obsolescencia                 | R3 `[CÓDIGO]` + `[HIPÓTESIS]`       | Esperado (no medido)                                        | medio    | Complejidad semántica               |
| RAG ON por defecto                    | Parafrasis léxica                             | E-RAG `[MEDIDO]` + 00008 `[MEDIDO]` | +5.6 pp full a 53.8× latencia                               | n/a      | Latencia, abstención                |
| Top-K 20 / 30                         | Más evidencia en ventana                      | E-C `[MEDIDO]`                      | +1.1/+4.4 pp full; ×1.83/×2.55 tokens                       | trivial  | Costo de contexto                   |
| Dos consultas budget 10               | Cobertura de evidencia                        | E-C `[MEDIDO]`                      | MRR 0.382→0.260/0.243                                       | medio    | Pierde ranking global               |
| V2/V2n nombres y tags                 | Representación descriptiva                    | E-B `[MEDIDO]`                      | 0 pp full; −1.1 pp hit (nombre)                             | pequeño  | Ninguno (no mejora)                 |
| V3 sesión como primaria               | Multi-hop / continuidad                       | E-B `[MEDIDO]`                      | +32.2 pp full, confundido por volumen; ×14.6 tokens         | grande   | Pérdida de referenciabilidad        |
| V3 sesión como resumen complementario | Continuidad y multi-hop                       | E-B `[MEDIDO]` + `[HIPÓTESIS]`      | Esperado; UNKNOWN a escala                                  | grande   | Duplicación y contexto              |
| Consolidación LLM por sesión          | Duplicados y staleness                        | R3 `[CALCULADO]`                    | Esperado ~$0.0014–0.005/sesión; no medido                   | medio    | Inventa hechos, pérdida de detalle  |
| Preview en `memory_query`             | Decidir qué abrir                             | R2 `[CALCULADO]`                    | UNKNOWN sin trazas                                          | pequeño  | Contrato YAML, fragmentos engañosos |

---

## 11. Quick wins y tabla de decisiones

Clasificación usada: **Quick win demostrado** (medido, barato, beneficio claro),
**Candidato prometedor** (medido o esperado, beneficio pequeño o con caveat),
**Cambio estratégico** (requiere diseño/medición adicional) y **No recomendado** (la
evidencia no lo justifica o el costo supera el beneficio).

| Propuesta                                      | Problema que resuelve                                  | Evidencia                                                                            | Impacto medido/esperado                                            | Esfuerzo                                   | Riesgo                                          | Recomendación            |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------- | ------------------------ |
| Expansión por vecinos ±1 con budget 10         | Evidencia multi-turno fuera del top-10; multi-hop 0/17 | E-C: full 0.456→0.578, tokens 461→461, P 0.094→0.080 `[MEDIDO]`                      | **Medido:** +12.2 pp full, −1.4 pp P, tokens planos                | Pequeño (leer nombres y añadir adyacentes) | Depende del naming; orden de vecinos arbitrario | **Quick win demostrado** |
| Vecinos ±2 con budget 20                       | Mayor cobertura multi-hop                              | E-C: full 0.656 vs 0.467, tokens 894 vs 842 `[MEDIDO]`                               | **Medido:** +18.9 pp full, +6 % tokens, −2.2 pp P                  | Pequeño                                    | Más contexto; mismo caveat de naming            | **Candidato prometedor** |
| S2: drop conservador de palabras funcionales   | Coverage/AND endurecen consultas largas                | E-A: conv-26 +4.4 pp full / +3.3 pp hit; conv-44 +0.8/+1.6 `[MEDIDO]`                | **Medido:** efecto chico replicado; −13 % tokens; más 0-results    | Pequeño (filtro determinista)              | Robustez en consultas cortas                    | **Candidato prometedor** |
| Captura de trazas de OpenCode                  | No se sabe qué tools/args usa el agente                | R2: solo conteos; nombres/args descartados `[CÓDIGO]`                                | **Esperado (no medido):** habilita decisiones de preview y consumo | Trivial (1–2 líneas en result.json)        | Redacción de datos                              | **Candidato prometedor** |
| Easy wins de protocolo (7 ítems)               | Drift guía↔tools, duplicados, T1 contaminado           | R3: sin pin/promote/demote; checkpoints T1 `[CÓDIGO]`                                | **Esperado (no medido):** menos duplicados y staleness             | Trivial (texto de guía)                    | Bajo                                            | **Candidato prometedor** |
| Re-exponer `memory_patch` / upsert / supersede | Actualización y obsolescencia                          | R3: `patchMemory` existe; `memory_patch` removido `[CÓDIGO]`                         | **Esperado (no medido):** reemplazo limpio de memoria obsoleta     | Medio                                      | Semántica de merge; validación                  | **Cambio estratégico**   |
| RAG ON por defecto                             | Parafrasis léxica                                      | E-RAG: +5.6 pp full, 53.8× p50, 0 gold desplazado `[MEDIDO]`                         | **Medido:** +5.6 pp full a 53.8× latencia; precisión +0.7 pp       | n/a (config)                               | Latencia; abstención adversarial                | **No recomendado**       |
| Top-K 20 como palanca principal                | Más evidencia en ventana                               | E-C: +1.1 pp full, ×1.83 tokens, multi-hop 0/17 `[MEDIDO]`                           | **Medido:** beneficio marginal caro                                | Trivial                                    | Contexto                                        | **No recomendado**       |
| Top-K 30                                       | Más evidencia en ventana                               | E-C: +4.4 pp full, ×2.55 tokens, multi-hop 1/17 `[MEDIDO]`                           | **Medido:** caro frente a vecinos                                  | Trivial                                    | Contexto                                        | **No recomendado**       |
| Dos consultas enfocadas budget 10              | Cobertura multi-evidencia                              | E-C: MRR 0.382→0.260/0.243 `[MEDIDO]`                                                | **Medido:** pierde ranking global                                  | Medio                                      | Complejidad y truncamiento                      | **No recomendado**       |
| V2/V2n como mejora de recall                   | Representación descriptiva                             | E-B: 0 pp full; −1.1 pp hit por nombre `[MEDIDO]`                                    | **Medido:** sin ganancia                                           | Pequeño                                    | Ninguno (nulo)                                  | **No recomendado**       |
| V3 sesión como representación primaria         | Multi-hop / continuidad                                | E-B: +32.2 pp full, confound de volumen, ×14.6 tokens, ×3.2 DB `[MEDIDO]`            | **Medido:** salto confundido; pérdida de referenciabilidad         | Grande                                     | No comparable a escala real                     | **No recomendado**       |
| V3 como resumen complementario                 | Continuidad y multi-hop                                | E-B `[MEDIDO]` + `[HIPÓTESIS]`                                                       | **Esperado:** UNKNOWN a escala                                     | Grande                                     | Duplicación, contexto                           | **Cambio estratégico**   |
| Consolidación LLM por sesión                   | Duplicados y staleness                                 | R3: ~$0.0014–0.005/sesión `[CALCULADO]`                                              | **Esperado (no medido):** resumen barato; fallos posibles          | Medio                                      | Inventa hechos, pérdida, duplicados             | **Cambio estratégico**   |
| Preview en `memory_query`                      | Decidir qué abrir sin leer todo                        | R2: math 1.000–1.500 tok/página; sin trazas (requiere instrumentación) `[CALCULADO]` | **UNKNOWN:** no hay datos de consumo                               | Pequeño                                    | Contrato YAML; fragmentos engañosos             | **No recomendado**       |

---

## 12. Recomendaciones priorizadas

### Implementar primero (barato, medido o habilitante)

1. **Expansión por vecinos ±1 con budget 10.** Es el único cambio con ganancia grande y
   tokens planos; no requiere índice ni grafo. Implementarlo detrás de una convención de
   nombres explícita y con tests de orden/presupuesto.
2. **Captura de trazas de OpenCode.** Persistir histograma de nombres de tools y
   `rawMessages()` redactado. Sin esto, el consumo y el preview siguen siendo UNKNOWN.
3. **Easy wins de protocolo.** Corregir el drift (pin/demote/T3), exigir
   `memory_query` antes de `memory_add`, promover `memory_update`, separar checkpoint de
   durable y documentar el flujo de supersesión en 2 pasos.

### Investigar después (prometedor con caveats)

4. **S2 (drop conservador de palabras funcionales)** en una tercera conversación y con
   presupuesto de robustez (evitar 0-results). Es un filtro determinista y barato, pero
   el efecto es chico.
5. **Vecinos ±2 / budget 20** si el contexto lo permite; medir multi-hop y precisión en
   más conversaciones.
6. **V3 como resumen complementario** a escala realista (muchas sesiones), no como
   reemplazo.
7. **Consolidación por sesión** con upsert/supersede y validación, midiendo invención y
   pérdida.
8. **RAG** solo en batch/offline o corpus chicos; antes, corregir el orden
   admission-vs-semantic.

### Descartar por ahora

9. **RAG ON por defecto**, **top-K 20/30 como palanca**, **dos consultas**, **V2/V2n
   como recall**, **V3 como primaria** y **preview sin instrumentación**. La evidencia
   medida no justifica el costo o el riesgo.

---

## 13. Preguntas abiertas

1. ¿V3 mantiene su ventaja con un número realista de sesiones (decenas o cientos), donde
   un top-10 de sesiones ya no cubre >50 % del corpus?
2. ¿RAG mejora respuesta, abstención y alucinación, o solo retrieval? Este experimento
   no ejecutó LLM de respuesta ni juez.
3. ¿Cómo escribe realmente un agente: cuándo crea, qué guarda, cómo nombra, cómo
   actualiza y cómo evita duplicados? El write-side sigue sin medir.
4. ¿Un preview de contenido cambia la decisión de abrir una memoria y reduce lecturas
   redundantes? Requiere trazas y un test de contrato YAML.
5. ¿La consolidación por sesión inventa hechos o pierde detalle en memorias reales, y
   cuánto cuesta a escala?
6. ¿K>30, presupuestos de vecinos distintos u otros órdenes de vecinos cambian la
   conclusión?
7. ¿S2 generaliza en uso real de agentes, donde las consultas no son preguntas de LoCoMo?
8. ¿La diferencia frozen-vs-current (captions) cambia el baseline lo suficiente para
   invalidar comparaciones con 00008?
9. ¿Una sola conversación (`conv-26`) y una réplica (`conv-44`) bastan para generalizar
   vecinos y S2?

---

## Metodología y límites

- **Mismas consultas y condiciones.** Todos los experimentos usan las 120 probes de
  `conv-26`, el mismo space (`locomo/membench`) y los mismos filtros; RAG OFF/ON se
  ejecutan por separado. RAG OFF es la condición principal salvo E-RAG.
- **E-RAG es una sola corrida.** El diff semántico-vs-léxico proviene de una única
  corrida por condición, sin repeticiones ni intervalo de confianza; no se estima
  varianza.
- **Gold solo para puntuar.** Nunca se usó gold para construir consultas, vecinos ni
  representaciones.
- **Retrieval-only.** Los experimentos no ejecutan LLM de respuesta ni juez; no miden
  alucinación, abstención ni calidad de respuesta final. Las cifras end-to-end citadas
  (35.9 %, 39.1 %, etc.) provienen del benchmark 00008 y no se mezclan con estos
  resultados.
- **Una sola conversación.** `conv-26`; la réplica de S2 en `conv-44` es puntual y no
  convierte un efecto chico en generalización.
- **DB congelada sin captions.** La DB histórica se ingirió sin `[Photo: ...]`; una
  ingesta actual con captions no reproduce byte a byte el baseline. Los números de V1 no
  son directamente comparables con el reporte 00008.
- **Costos estimados.** Los USD de consolidación y embeddings son cálculos a precio de
  lista, no facturas. Los tokens de contexto usan `ceil(chars/4)`, no un tokenizer real.
- **Sin cambios en producción.** No se tocó la DB viva, el gold ni código de producción;
  las DBs de experimento son copias scratch.

---

## ¿Cuáles son los dos o tres cambios más baratos y estratégicamente útiles?

**1. Expansión por vecinos de sesión (±1, budget 10) — el más barato con impacto
medido.** Cuesta leer el nombre `D<sesión>:<turno>` y añadir los turnos adyacentes al
presupuesto; no hay grafo, índice nuevo ni LLM. Medido: **+12.2 pp de evidencia completa
en top-10 con tokens planos** y −1.4 pp de precisión. Es el cambio que mejor ataca el
techo de multi-hop sin multiplicar contexto.

**2. Drop conservador de palabras funcionales (S2) — barato y replicado, pero efecto
chico.** Es un filtro determinista de una sola consulta: **+4.4 pp full / +3.3 pp hit**
en `conv-26`, **+0.8 / +1.6 pp** en `conv-44`, con −13 % de tokens. No es un quick win
generalizado: hay que vigilar las probes que quedan sin resultados (2 → 6 en `conv-44`).

**3. Easy wins de protocolo + captura de trazas — costo cero o casi cero, impacto
esperado (no medido).** Corregir el drift guía↔tools, exigir `memory_query` antes de
`memory_add`, usar `memory_update`/supersede y separar checkpoint de durable reduce
duplicados y staleness **por diseño**, pero hoy no hay medición. La captura de trazas
(histograma de tools + `rawMessages()` redactado) es la vía más barata para empezar a
medir consumo y decidir después si un preview tiene sentido.

Los tres son locales y reversibles. Ninguno requiere reescribir la arquitectura, cambiar
el schema ni tunear pesos de fusión. Los dos primeros están **medidos**; el tercero es
**esperado** y su valor principal es habilitar la medición que hoy falta.
