@core @product/rag @embeddings
Feature: Embedding provider selection

  RAG semantic search can use OpenAI or OpenRouter as its embedding provider.
  The provider is selected with MIND_EMBEDDING_PROVIDER (default: openai) and the
  embedding model stays text-embedding-3-small (1536 dims) so existing stored
  vectors remain valid without re-embedding.

  Background:
    Given MIND_RAG is enabled

  Rule: Provider selection

    @unit
    Scenario: provider defaults to openai when unset
      Given MIND_EMBEDDING_PROVIDER is not set
      And OPENAI_API_KEY is set
      When the embedding runtime is resolved
      Then the active provider is "openai"
      And the request target is "https://api.openai.com/v1/embeddings"
      And the request model is "text-embedding-3-small"

    @unit
    Scenario: openrouter is selected explicitly
      Given MIND_EMBEDDING_PROVIDER is "openrouter"
      And OPENROUTER_API_KEY is set
      When the embedding runtime is resolved
      Then the active provider is "openrouter"
      And the request target is "https://openrouter.ai/api/v1/embeddings"
      And the request model is "openai/text-embedding-3-small"

    @unit
    Scenario: provider value is normalized before matching
      Given MIND_EMBEDDING_PROVIDER is " OpenRouter "
      And OPENROUTER_API_KEY is set
      When the embedding runtime is resolved
      Then the active provider is "openrouter"

    @unit
    Scenario: unknown provider value disables RAG without fallback
      Given MIND_EMBEDDING_PROVIDER is "huggingface"
      And OPENAI_API_KEY is set
      When the embedding runtime is resolved
      Then RAG is disabled
      And no embedding request is attempted

  Rule: Key gating per provider

    @unit
    Scenario: selected provider without its key disables RAG
      Given MIND_EMBEDDING_PROVIDER is "openrouter"
      And OPENROUTER_API_KEY is not set
      And OPENAI_API_KEY is set
      When the embedding runtime is resolved
      Then RAG is disabled

    @unit
    Scenario: unset provider keeps existing OpenAI behavior
      Given MIND_EMBEDDING_PROVIDER is not set
      And OPENAI_API_KEY is not set
      When the embedding runtime is resolved
      Then RAG is disabled

  Rule: Embedding request shape

    @unit
    Scenario: requests pin float encoding
      Given an embedding runtime for provider "openrouter"
      When an embedding is requested for "hello world"
      Then the request body contains encoding_format "float"
      And the request model is "openai/text-embedding-3-small"

    @unit
    Scenario: embedding responses become float vectors
      Given an embedding runtime for provider "openrouter"
      When an embedding is requested for "hello world"
      Then a Float32Array embedding is returned

    @unit
    Scenario: embedding failure returns null without breaking the caller
      Given an embedding runtime for provider "openai"
      And the embeddings endpoint keeps failing
      When an embedding is requested for "hello world"
      Then the result is null

  Rule: Status reporting

    @unit @status
    Scenario: status reports the active provider
      Given RAG is enabled with provider "openrouter" and its key
      When running "./mind status"
      Then the RAG status line names provider "openrouter"

    @unit @status
    Scenario: status hints the missing key for the selected provider
      Given RAG is enabled with provider "openrouter" and no key
      When running "./mind status"
      Then the RAG status hint names "OPENROUTER_API_KEY"

    @unit @status
    Scenario: status reports an invalid provider value
      Given MIND_EMBEDDING_PROVIDER is "huggingface"
      When running "./mind status"
      Then the RAG status hint reports the invalid value

  Rule: Vector compatibility

    @regression
    Scenario: provider switch does not re-embed stored memories
      Given memories with stored OpenAI embeddings
      When RAG runs with provider "openrouter"
      Then existing embeddings are kept unchanged
      And no schema or migration change is required
