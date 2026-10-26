# Configuration

Most settings are optional. The [one-line installer](../README.md#get-started) creates
`.env` from `.env.example` inside the installed application directory when needed.
If you installed from source, run `cp .env.example .env` from the repository root.

Edit the application's `.env` to change storage paths, ports, or semantic search.

| Variable                     | Default   | Description                                                  |
| ---------------------------- | --------- | ------------------------------------------------------------ |
| `MIND_PORT`                  | `30303`   | Port for the web server                                      |
| `MIND_DATA_DIR`              | `data/`   | Directory for SQLite database and data                       |
| `MIND_LOG_RETENTION_MINUTES` | `10080`   | Log retention in minutes (default 7 days)                    |
| `MIND_RAG`                   | _(empty)_ | Set to `true` to enable semantic search                      |
| `MIND_EMBEDDING_PROVIDER`    | `openai`  | Embedding provider for RAG: `openai` or `openrouter`         |
| `OPENAI_API_KEY`             | _(empty)_ | Your OpenAI API key (required for RAG with `openai`)         |
| `OPENROUTER_API_KEY`         | _(empty)_ | Your OpenRouter API key (required for RAG with `openrouter`) |

**RAG / semantic search setup:**

To enable AI-powered semantic search, set `MIND_RAG=true` and provide the API
key for your embedding provider. Mind uses OpenAI by default.

OpenAI (default):

```bash
# In .env:
MIND_RAG=true
OPENAI_API_KEY=sk-your-key-here
```

OpenRouter:

```bash
# In .env:
MIND_RAG=true
MIND_EMBEDDING_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-your-key-here
```

Mind embeds memories with `text-embedding-3-small` (OpenAI) or
`openai/text-embedding-3-small` (OpenRouter) and combines the embeddings with
full-text search for hybrid retrieval. Both providers return 1536-dimension
vectors, so switching providers keeps existing stored embeddings valid; Mind
doesn't re-embed memories.

Provider values are matched case-insensitively. Mind uses only the selected
provider's key. If `MIND_EMBEDDING_PROVIDER` holds an unsupported value, RAG
stays disabled and Mind doesn't fall back to another provider. Run
`mind status` to see the active provider or the reason RAG is disabled.

## Storage and migration

Mind stores its primary database in SQLite and can also keep optional
autosync files in a versioned `.mind/` directory.

- Default DB path: `data/mind.db`
- Optional autosync config and exported files: `.mind/`
- Override directory: `MIND_DATA_DIR=/custom/path`
- Override full DB path: `MIND_DB_PATH=/custom/path/mind.db`

Legacy migration:

```bash
mind import
```
