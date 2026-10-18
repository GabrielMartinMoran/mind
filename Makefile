.PHONY: help web web-dev test test-web test-rag search-eval bench-search bench-scalability search-diff release-patch release-minor release-major release-simulate

CORPUS ?= 1k

help: ## Show available commands
	@echo "mind project tasks"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/; s/^/  /'

web: ## Run the web app in dev mode (alias for web-dev)
	$(MAKE) web-dev

web-dev: ## Run the web app locally with Bun
	cd web && bun run dev

test: ## Run unit tests
	bun test test/ web/test

test-web: ## Run web-only tests
	bun test web/test

test-rag: ## Run RAG E2E integration test (requires OPENAI_API_KEY)
	./scripts/test-rag.sh

search-eval: ## Run the fixture search evaluation suite (current-engine report)
	bun run scripts/search-eval.ts --mode fixture

bench-search: ## Run the fixture search benchmark (opt-in; NOT part of bun test)
	MIND_RAG=false bun run scripts/bench-search.ts --suite fixture --out /tmp/opencode/search-optimization/bench-fixture.json

bench-scalability: ## Run a scalability benchmark CORPUS=1k|10k|50k|100k (heavy: opt-in)
	MIND_RAG=false bun run scripts/bench-search.ts --suite scalability --corpus $(CORPUS) --allow-heavy --out /tmp/opencode/search-optimization/bench-scalability-$(CORPUS).json

search-diff: ## Emit + compare the current engine against the old-engine snapshot
	@mkdir -p /tmp/opencode/search-optimization
	cd /tmp/opencode/search-optimization/old-engine && MIND_RAG=false bun run scripts/search-diff.ts --emit /tmp/opencode/search-optimization/emit-old.json
	MIND_RAG=false bun run scripts/search-diff.ts --emit /tmp/opencode/search-optimization/emit-new.json
	MIND_RAG=false bun run scripts/search-diff.ts --compare /tmp/opencode/search-optimization/emit-old.json /tmp/opencode/search-optimization/emit-new.json --out /tmp/opencode/search-optimization/diff.json

release-patch: ## Create a patch release from main (real release)
	./scripts/release.sh patch

release-minor: ## Create a minor release from main (real release)
	./scripts/release.sh minor

release-major: ## Create a major release from main (real release)
	./scripts/release.sh major

release-simulate: ## Simulate release flow without changing anything (TYPE=patch|minor|major)
	@type=$${TYPE:-patch}; ./scripts/release.sh $$type --simulate
