# Informe de implementación — Consolidación de migraciones y caché cross-process (00005, Parte A)

- **Feature:** `00005-search-followup`
- **Repositorio:** `/home/gabrielmoran/Git/mind`
- **Fecha:** 2026-10-18
- **Alcance de este documento:** **solo la Parte A implementada** (A1: schema v10
  definitivo; A2/A3: invalidación del caché fuzzy entre procesos y consistencia
  de todos los write paths). Este informe describe **código ya implementado y
  verificado**, no planes ni la investigación de la Parte B.
- **Runtime de medición:** Bun 1.3.14, `bun:sqlite` con SQLite 3.53.0,
  `MIND_RAG=false` en todas las corridas.
- **Documentos relacionados:** informe de la iteración previa
  [`search-optimization-report.md`](search-optimization-report.md) (feature
  `00004`), auditoría [`search-audit.md`](search-audit.md) (feature `00003`),
  handoff [`search-optimization-plan.md`](search-optimization-plan.md),
  metodología de benchmarks [`search-benchmarks.md`](search-benchmarks.md).

## Etiquetas de evidencia

Cada afirmación relevante lleva una etiqueta:

- `[MEDIDO]` — observado en una corrida registrada en un artefacto.
- `[CALCULADO]` — aritmética derivada de valores medidos.
- `[CÓDIGO]` — hecho verificado leyendo el código de producción o de tests.

Ningún número de este informe fue inventado; donde algo no se pudo verificar se
declara explícitamente.

---

## 1. Cambios implementados

### 1.1 Schema v10 final consolidado `[CÓDIGO]`

`src/store/schema.ts` define ahora **`SCHEMA_VERSION = 10`** como el único
esquema definitivo y publicable:

- La tabla virtual `memories_fts_trigram` se crea con
  `tokenize='trigram remove_diacritics 1'`, `content=''`,
  `contentless_delete=1` (plegado de diacríticos + índice _contentless_ con
  soporte de borrado). `[CÓDIGO]`
- `MIGRATE_V9_TO_V10` construye **directo** el estado final desde el v9
  publicado: `DROP TABLE memories_fts_trigram`, `CREATE VIRTUAL TABLE` con el DDL
  final y repoblación desde `memories`. No crea ni elimina ninguna tabla de
  diccionario. `[CÓDIGO]`
- No existe ningún diccionario `search_terms` / `memory_terms` /
  `idx_memory_terms_term` en la creación ni en la migración. `[CÓDIGO]`

El esquema v10 final es **funcionalmente idéntico** al dev v11 (que retiró un
diccionario previamente prototipado en un dev v10 igualmente no publicado).
Ambos esquemas intermedios fueron **de desarrollo y nunca se publicaron**.

### 1.2 Invalidación del caché fuzzy entre procesos `[CÓDIGO]`

El canal fuzzy (P-A) cachea en memoria el **vocabulario plegado global de todos
los documentos**. La clave de validez del caché pasó a ser
**`{ generation, dataVersion }`**:

- **`generation`** — contador de escritura por manija de `Database`
  (`storeGeneration` / `bumpStoreGeneration` en
  `src/store/shared/matching-tokenizer.ts`, en un `WeakMap`), incrementado por
  **cada** escritura de documento vía `FtsHelper`. Cubre las escrituras hechas
  por **esta** conexión. `[CÓDIGO]`
- **`dataVersion`** — `PRAGMA data_version` leído en **esta misma** conexión
  (nueva función `dataVersion` en `matching-tokenizer.ts`). SQLite lo avanza
  cuando **otra** conexión/proceso confirma un cambio, y lo deja **sin cambio**
  para las escrituras de la propia conexión. Cubre las escrituras externas.
  `[CÓDIGO]`

`SearchRepository.globalVocabulary()` (`src/store/repositories/search-repository.ts`)
lee `storeGeneration(db)` y `dataVersion(db)` **inmediatamente antes** de
consultar el caché; si cualquiera difiere, reconstruye el vocabulario y actualiza
la clave. El sink opcional de diagnóstico (por defecto apagado) expone
`fuzzy_cache_rebuilt` y `data_version`. `[CÓDIGO]`

No se añadieron dependencias, polling, hilos ni temporizadores. `[CÓDIGO]`

---

## 2. Problemas corregidos

1. **Esquemas dev v10/v11 nunca publicados.** El v10 intermedio (con el
   diccionario por documento `search_terms` / `memory_terms` /
   `idx_memory_terms_term`) y el dev v11 (diccionario retirado) eran esquemas de
   desarrollo que **nunca se publicaron**; el último esquema publicado fue v9. Se
   eliminó esa ambigüedad consolidando el v10 final (funcionalmente igual al dev
   v11) como el único esquema verdadero. `[CÓDIGO]`
2. **Tablas de diccionario eliminadas de la creación.** La creación de
   `search_terms` / `memory_terms` / `idx_memory_terms_term` ya no existe en
   ninguna ruta del motor: ni en `SCHEMA_SQL`, ni en las migraciones, ni en los
   write paths. `[CÓDIGO]` (verificado también por tests, §6).
3. **Ruta transitoria v10→v11 eliminada.** La migración dev `v10→v11` y su guard
   se borraron del motor en lugar de conservarse como compatibilidad permanente.
   El comentario del código deja constancia de que el v10 final ya **es** el
   estado funcional de aquel dev v11. `[CÓDIGO]`
4. **Vocabulario fuzzy obsoleto entre procesos.** Antes, el caché de vocabulario
   P-A se invalidaba únicamente por escrituras de la **propia** conexión
   (`storeGeneration`); una escritura confirmada por **otra** conexión/proceso
   podía dejar el vocabulario en memoria desactualizado indefinidamente. Ahora
   `PRAGMA data_version` detecta esos cambios externos y fuerza la
   reconstrucción. `[CÓDIGO]`
5. **Auditoría de invalidación en todos los write paths.** Se verificó que cada
   ruta que escribe documentos pasa por `FtsHelper` (que hace
   `bumpStoreGeneration`) y que la reconstrucción de índices
   (`repairSearchIndexes` → `recoverTrigramIndex` + `bumpStoreGeneration` en
   `src/store/sqlite-store.ts`) también invalida el caché. No quedó ningún
   mecanismo redundante. `[CÓDIGO]`

---

## 3. Archivos y componentes modificados

### 3.1 Código de producción

| Archivo                                       | Cambio                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store/schema.ts`                         | `SCHEMA_VERSION = 10`; `MIGRATE_V9_TO_V10` construye directo el DDL final; documentada y eliminada la ruta dev `v10→v11`; sin diccionario.                                 |
| `src/store/shared/matching-tokenizer.ts`      | `storeGeneration` / `bumpStoreGeneration` (contador por manija en `WeakMap`) y nueva `dataVersion(db)` que lee `PRAGMA data_version`.                                      |
| `src/store/repositories/search-repository.ts` | Clave de caché `{ generation, dataVersion }` en `globalVocabulary()`; diagnóstico `fuzzy_cache_rebuilt` / `data_version`; `dataVersion` importado de `matching-tokenizer`. |
| `src/store/shared/fts-helpers.ts`             | `FtsHelper.insert/delete` invocan `bumpStoreGeneration` (cubre add/update/delete/space-delete/import); recuperación contentless sin `'rebuild'`.                           |
| `src/store/sqlite-store.ts`                   | `repairSearchIndexes()` llama `recoverTrigramIndex` + `bumpStoreGeneration` tras una reparación de índices.                                                                |
| `src/store/shared/index.ts`                   | Re-exporta `storeGeneration` / `bumpStoreGeneration` (barrel); `dataVersion` se importa directo desde `matching-tokenizer`.                                                |

### 3.2 Scripts

| Archivo                       | Cambio                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/normalize-dev-db.ts` | Nuevo utilitario opt-in de normalización de bases dev rotuladas `schema_version = 11` (§4). Solo copias; rechaza `data/mind.db`.                 |
| `scripts/bench-search.ts`     | Comentario actualizado: el diccionario dev fue retirado antes del v10 consolidado, no hay huella ni rebuild de diccionario que medir. `[CÓDIGO]` |

### 3.3 Tests

| Archivo                         | Cambio                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/fuzzy-cache.spec.ts`      | Nuevo. 21 tests: invalidación cross-connection, cross-process (`Bun.spawn`), WAL y DELETE, sin reconstrucción sin escrituras, matriz completa de write paths y _seam_ de recuperación (§6). |
| `test/migration-safety.spec.ts` | v9→v10 directo: DDL final, sin diccionario, datos conservados, restauración ante fallo forzado, `ensureIntegrity`.                                                                          |
| `test/trigram-search.spec.ts`   | `SCHEMA_VERSION = 10`, base fresca y migrada sin diccionario, paridad de índices.                                                                                                           |
| `test/uuid-migration.spec.ts`   | Ajustado al v10 final.                                                                                                                                                                      |

### 3.4 Documentación y metadatos

- `AGENTS.md` — descripción del schema v10 definitivo y del caché P-A por
  generación de escritura. (Nota: el mecanismo `data_version` cross-process **no**
  está todavía reflejado de forma explícita en la línea del canal fuzzy; ver §8.)
- `CHANGELOG.md` — entrada `Unreleased` que consolida el v10 y describe
  `scripts/normalize-dev-db.ts`.
- `docs/search-optimization-report.md`, `docs/search-benchmarks.md` — contexto y
  metodología de la iteración previa, consistentes con el v10 final.
- `docs/search-optimization-followup.md` — **este documento (C2)**.

---

## 4. Estrategia definitiva de migración

### 4.1 Rutas soportadas `[CÓDIGO]`

| Punto de partida                        | Ruta                                      | Resultado                                                             |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Instalación nueva                       | Creación fresca con `SCHEMA_SQL`          | v10, con `memories_fts_trigram` final y sin diccionario.              |
| v9 **publicado**                        | `MIGRATE_V9_TO_V10` directa               | v10 en un solo paso (recrea el trigram en su forma final y repuebla). |
| Versiones publicadas anteriores (v1…v8) | Cadena histórica hasta v9, y luego v9→v10 | v10.                                                                  |

**No existe compatibilidad permanente con v11.** El dev v11 nunca se publicó, por
lo que no forma parte de las rutas soportadas; ninguna base publicada puede
estar rotulada 11. `[CÓDIGO]`

### 4.2 Normalización de bases dev rotuladas v11 `[CÓDIGO]`

Como el motor ya no revalida una base rotulada `11` (la trata como "más nueva"),
`scripts/normalize-dev-db.ts` repara una base dev de ese estado:

1. **Rechaza** ejecutarse sobre la base viva `data/mind.db` (solo copias).
2. **Verifica** que la base sea exactamente `schema_version = 11`, que **no**
   tenga tablas de diccionario (`search_terms`, `memory_terms`,
   `idx_memory_terms_term`) y que su `memories_fts_trigram` lleve el DDL final
   (`remove_diacritics 1` + `contentless_delete=1`).
3. **Respalda** con `VACUUM INTO` antes de cualquier cambio
   (`<db>.pre-normalize.<stamp>.db`).
4. Reescribe `meta.schema_version` a `10` (equivalencia funcional: dev v11 ≡ v10
   final).
5. **Valida** `PRAGMA quick_check`, foreign keys, recuentos de tablas y un
   `MATCH` de trigram; si algo falla, **restaura** el respaldo y sale con código
   distinto de cero.

Procedimiento recomendado `[CÓDIGO]`:

```
copiar → normalizar → validar → reemplazar
```

- **Estado actual:** la base viva `data/mind.db` está **rotulada dev-v11** y
  requiere esta normalización antes de reiniciar con el nuevo código. `[MEDIDO]`
  (lectura directa de `meta.schema_version` → `"11"`).
- **Nunca** se ejecuta el normalizador directamente sobre el archivo vivo: se
  normaliza una **copia** y luego se reemplaza.
- La normalización de la copia quedó registrada en
  `/tmp/opencode/search-followup/a1/`: `dev-v11-copy.db` pasó a
  `schema_version = 10` (sin diccionario, 4497 memorias) con un respaldo
  `dev-v11-copy.db.pre-normalize.<stamp>.db` que conserva `schema_version = 11`.
  `[MEDIDO]` (bun:sqlite, lectura directa de ambos archivos).

### 4.3 Cifras medidas de la migración v9→v10 `[MEDIDO]`

Medidas con `measure-migration.ts` sobre **copias**, con `VACUUM INTO` para el
tamaño compacto (`/tmp/opencode/search-followup/a1/migration-measurements.json` y
`migration-validation.json`):

| Corpus             | Memorias |  Migración | Compacto v9 | Compacto v10 |            Δ |
| ------------------ | -------: | ---------: | ----------: | -----------: | -----------: |
| Real (86 espacios) |    4 497 | **519 ms** |    49.98 MB | **43.77 MB** | **−6.20 MB** |
| Sintético 50k      |   50 000 | **711 ms** |    74.90 MB | **75.86 MB** | **+0.95 MB** |

`[CALCULADO]` a partir de los bytes crudos
(real `49 975 296 → 43 773 952`, Δ `−6 201 344`; sintético
`74 903 552 → 75 857 920`, Δ `+954 368`).

- **Interpretación honesta:** en el corpus **real** el v10 final reduce el
  compacto ~6.20 MB (el índice trigram _contentless_ pesa menos). En el corpus
  **sintético 50k** el compacto crece ~0.95 MB: la repoblación _contentless_ y el
  plegado de diacríticos tienen un costo de almacenamiento que, en ese corpus
  sintético, supera el ahorro del _contentless_. La validación confirmó para
  ambos: `version = 10`, `quick_check = ok`, `foreign_key_check = 0`, sin
  diccionario y DDL final, con paridad de recuentos (`memories = fts = trigram`).
  `[MEDIDO]`

---

## 5. Comportamiento de invalidación del caché

### 5.1 Mecanismo `[CÓDIGO]`

- **Generación local** — `storeGeneration(db)` / `bumpStoreGeneration(db)` viven
  en un `WeakMap<object, number>` por manija de `Database`; `FtsHelper` incrementa
  el contador en cada `insert`/`delete` (update = delete + insert). El
  `WeakMap` evita fugas entre stores. `[CÓDIGO]`
- **`PRAGMA data_version`** — `dataVersion(db)` se lee en la **misma** conexión
  inmediatamente antes de consultar el caché. Devuelve `0` de forma defensiva si
  el pragma no está disponible (el caché cae entonces a invalidación por
  generación local). `[CÓDIGO]`
- **Clave de caché** — `{ generation, dataVersion }`. Se **lee antes de usar** el
  caché: si la clave almacenada difiere de la actual, se reconstruye el
  vocabulario desde `memories` y se actualiza la clave. `[CÓDIGO]`

### 5.2 Semántica de carrera `[CÓDIGO]`

Una escritura que confirma **a mitad de una búsqueda** puede o no quedar incluida
en la reconstrucción iniciada en ese instante; en cualquier caso, la **siguiente**
búsqueda observará el `data_version` avanzado y reconstruirá de nuevo. Por tanto,
el caché **nunca queda permanentemente obsoleto**. `[CÓDIGO]` (comentario explícito
en `globalVocabulary()`).

### 5.3 Modos de journal, sin mecanismos extra

- **WAL** (modo por defecto del store) y **DELETE** (rollback journal): ambos
  verificados por tests (§6). `[CÓDIGO]`
- **Sin polling, hilos ni dependencias**: la detección es síncrona y por consulta
  del pragma combinada con el contador local. `[CÓDIGO]`
- **Diagnóstico por defecto apagado**: `fuzzy_cache_rebuilt` y `data_version` solo
  se emiten cuando hay un sink instalado (`setSearchDiagnosticsSink`) o
  `MIND_SEARCH_DIAG=1`; activarlo nunca cambia resultados, orden ni contrato.
  `[CÓDIGO]`

---

## 6. Pruebas ejecutadas

### 6.1 Suites dirigidas `[MEDIDO]`

`MIND_RAG=false bun test test/fuzzy-cache.spec.ts test/migration-safety.spec.ts test/trigram-search.spec.ts test/uuid-migration.spec.ts test/search-eval.spec.ts test/search-diagnostics.spec.ts`

→ **100 pass / 0 fail** (3 547 `expect()`, 6 archivos).

`test/fuzzy-cache.spec.ts` — **21 tests**:

- **Misma conexión / dos conexiones independientes**: inserción, update y delete
  externos detectados; sin reconstrucción repetida sin escrituras intercaladas
  (flags `[true, false, false]`); alternancia múltiple consistente.
- **Cross-process**: dos casos con `Bun.spawn` (un proceso hijo inserta / elimina
  y el padre lo detecta en la búsqueda siguiente).
- **Modos de journal**: WAL y DELETE.
- **Matriz de write paths**: add; update de contenido y de nombre; patch de
  contenido y de nombre; move con cambio de contenido; **relocación pura (solo
  espacio) NO invalida** (el vocabulario es global); delete; deleteByName;
  space-delete; importFromJson; y el _seam_ de recuperación
  (`recoverTrigramIndex` + `bumpStoreGeneration`).

`test/migration-safety.spec.ts` — equivalencia v9→v10 fresca vs migrada; migración
v9→v10 directa (DDL final, sin diccionario, datos conservados, `MATCH` de trigram);
restauración del respaldo v9 ante fallo de validación forzado; `ensureIntegrity`
repara un índice trigram desviado sin perder memorias.

`test/trigram-search.spec.ts` y `test/uuid-migration.spec.ts` — `SCHEMA_VERSION`
10, base fresca y migrada sin diccionario, paridad de índices FTS/trigram.

**Normalizador de copia:** verificado por ejecución sobre una **copia** en
`/tmp/opencode/search-followup/a1/` (§4.2). No existe (ni se añadió) un test
unitario automatizado para `scripts/normalize-dev-db.ts`; la evidencia es el
artefacto de la corrida sobre la copia. `[MEDIDO]`

### 6.2 Suite completa `[MEDIDO]`

`MIND_RAG=false bun test test/ web/test` → **846 pass / 0 fail** (9 547 `expect()`,
56 archivos, 23.64 s).

### 6.3 Chequeos estáticos `[MEDIDO]`

- `bun run typecheck` (`tsc --noEmit`) → exit 0.
- `bun run lint` (`eslint .`) → exit 0.
- `bun run format:check` (`prettier --check .`) → "All matched files use Prettier
  code style!".

### 6.4 Equivalencia de hashes con el sink apagado `[MEDIDO]`

`test/search-diagnostics.spec.ts` compara sink **encendido vs apagado sobre el
mismo motor** y exige snapshots byte-idénticos. Los hashes de referencia siguen
fijados y sin cambios:

- Baseline **v1 inmutable** `1f5bf98a5fc2d9c7ab46515cf6cfa250223897c117fc2fe754cebbc40e2c2a52`
  (`test/search-eval.spec.ts`, `test/search-eval/baseline.fixture.json`).
- **v2 optimizado** `4494b323dce79e410f768f87ff54d0bd306a29c7525387dc0c5a3b87f8e38419`
  (`test/search-scenarios.spec.ts`, `baseline.fixture.v2.optimized.json`).

---

## 7. Resultados obtenidos

- **Schema v10 definitivo** con `memories_fts_trigram` final (`remove_diacritics 1`,
  `content=''`, `contentless_delete=1`) y **sin diccionario**; migración directa
  v9→v10 y cadena histórica hasta v9 para versiones anteriores. `[CÓDIGO]`
- **Migración sobre copia real:** **519 ms**, compacto **49.98 → 43.77 MB**
  (−6.20 MB). **Sintético 50k:** **711 ms**, compacto **74.90 → 75.86 MB**
  (+0.95 MB, _trade-off_ de la repoblación _contentless_). `[MEDIDO]`
- **Sin diccionario, probado:** ninguna ruta crea `search_terms` / `memory_terms` /
  `idx_memory_terms_term`; verificado por código y tests. `[CÓDIGO]`
- **Invalidación del caché correcta:** reconstrucción ante cambio local o externo;
  **sin** reconstrucción en búsquedas repetidas sin escrituras. `[MEDIDO]`
- **La Parte A no cambia los resultados ni el contrato de búsqueda:** los hashes
  con el sink apagado (baseline v1 y v2 optimizado) permanecen idénticos; el sink
  encendido/apagado produce snapshots byte-idénticos. `[MEDIDO]`
- **La base viva está en dev-v11** y requiere normalización (§4.2) antes de
  reiniciar con el nuevo código. `[MEDIDO]`
- **Quick win `00006` (fuzzy vocab reuse):** el escaneo de expansión fuzzy
  reutiliza el vocabulario cacheado —ya único y ordenado— en lugar de
  recopiarlo/reordenarlo en cada consulta; expansiones, orden y resultados
  idénticos, con el escaneo ~18–20× más rápido en el corpus real
  (4 497 memorias, `|V|≈29 890`; p50 6.5 ms → 0.35 ms por token). `[MEDIDO]`

---

## 8. Posibles limitaciones restantes

1. **Base viva en dev-v11 pendiente de normalización.** `data/mind.db` está
   rotulada `schema_version = 11`; debe normalizarse mediante copia
   (`scripts/normalize-dev-db.ts`) antes de reiniciar con el nuevo código. Nunca
   debe ejecutarse el normalizador directamente sobre el archivo vivo. `[MEDIDO]`
2. **Semántica/limitación de `data_version`.** Se lee a nivel de conexión y solo
   cambia por escrituras externas; una escritura que confirme **a mitad** de una
   búsqueda puede o no incluirse en la reconstrucción en curso, pero la búsqueda
   siguiente la observa (nunca queda obsoleta de forma permanente). Si el pragma
   no está disponible, la invalidación cae a generación local (no cubre
   escrituras externas en ese caso excepcional). `[CÓDIGO]`
3. **Costo de reconstrucción en caché frío.** Tras cada escritura (local o
   externa), la primera búsqueda que use el canal fuzzy paga una reconstrucción
   del vocabulario de todos los documentos. Es un costo **de una sola vez por
   store** entre escrituras; el perfilado de escrituras/lectura se aborda en la
   Parte B (documento C3). `[CÓDIGO]`
4. **Limitación prefix-3 vigente.** El canal fuzzy conserva la regla documentada
   `FUZZY_PREFIX_LENGTH = 3`: un error de tecleo en los **primeros tres**
   caracteres de una palabra **no** es recuperable. Sigue en pie; su tratamiento
   es investigación de la Parte B (fuzzy prefix-free). `[CÓDIGO]`
5. **Menciones históricas a v11 en artefactos de desarrollo.** Persisten
   referencias a "dev v11" en `CHANGELOG.md`, `docs/search-optimization-report.md`
   y en los artefactos efímeros de `/tmp/opencode/search-followup/a1/`
   (p. ej. `dev-v11-copy.db` y su respaldo `pre-normalize` con `schema_version 11`).
   Son de desarrollo y no afectan a las rutas publicadas. `[CÓDIGO]`
6. **Comentario de `scripts/bench-search.ts` actualizado a v10.** El comentario
   que describía el diccionario dev fue reescrito para reflejar que fue retirado
   antes del v10 consolidado. `[CÓDIGO]`
7. **`AGENTS.md` no explicita el mecanismo `data_version`.** La línea del canal
   fuzzy describe el caché P-A por generación de escritura pero aún **no** nombra
   la invalidación cross-process por `PRAGMA data_version`. Es una discrepancia
   documental fuera del alcance de este informe (solo documental, no funcional).
   `[CÓDIGO]`

---

_Este documento refleja únicamente la Parte A implementada y verificada. La
investigación de la Parte B (fuzzy prefix-free, costo del caché con escrituras,
admission gate, falsos positivos, perfilado a escala, calidad/arquitectura) se
documenta por separado en `docs/search-next-steps-research.md` (C3) y no forma
parte de este informe._
