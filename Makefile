.PHONY: help web web-dev test test-web test-rag search-eval bench-search bench-scalability search-diff release-patch release-minor release-major release-simulate bench-agent-memory-test bench-agent-memory-probe bench-agent-memory-smoke bench-agent-memory-locomo bench-agent-memory-scenarios bench-agent-memory-answers bench-agent-memory-full bench-agent-memory-report bench-agent-memory-clean

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

# ── Agent memory benchmark (independent Bun subproject) ──
#
# Install the subproject's own dependencies once:
#   cd benchmarks/agent-memory && bun install
# These targets are convenience wrappers; the subproject scripts are
# authoritative. The root package does not install benchmark dependencies.

bench-agent-memory-test: ## Run agent-memory harness unit + contract tests, then experiment specs (integration skipped)
	cd benchmarks/agent-memory && bun test test
	cd benchmarks/agent-memory && bun test experiments

bench-agent-memory-probe: ## Run the free T1 platform/isolation probes (no LLM calls)
	cd benchmarks/agent-memory && bun run probe

bench-agent-memory-smoke: ## Paid credential smoke (ONE minimal prompt; reads key at runtime)
	cd benchmarks/agent-memory && bun run smoke

bench-agent-memory-locomo: ## Free LoCoMo A1 retrieval run (no LLM; SUBSET=pilot|full)
	cd benchmarks/agent-memory && bun run locomo --subset $(if $(SUBSET),$(SUBSET),pilot) --conditions mind-v9,mind-v10

bench-agent-memory-scenarios: ## Paid agent scenario run (requires --budget; SCENARIOS=b1,b4)
	cd benchmarks/agent-memory && bun run scenarios \
		$(if $(CONDITIONS),--conditions $(CONDITIONS),) \
		$(if $(SCENARIOS),--scenarios $(SCENARIOS),) \
		$(if $(BUDGET),--budget $(BUDGET),) \
		$(if $(CONFIRM),--confirm,)

bench-agent-memory-answers: ## Paid A2 answering + judge for a prepared run (RUN=<id> required; CONDITIONS, REPS, BUDGET, CONFIRM)
	@if [ -z "$(RUN)" ]; then \
		echo "bench-agent-memory-answers: RUN is required" >&2; \
		exit 2; \
	fi
	cd benchmarks/agent-memory && bun run locomo --answers \
		--run-id $(RUN) \
		--conditions $(if $(CONDITIONS),$(CONDITIONS),no-memory,mind-v10) \
		--reps $(if $(REPS),$(REPS),1) \
		$(if $(BUDGET),--budget $(BUDGET),) \
		$(if $(CONFIRM),--confirm,)

bench-agent-memory-full: ## Free A1 always; paid A2+scenarios with BUDGET=<usd> CONFIRM=1; then REPORT
	cd benchmarks/agent-memory && bun run full \
		$(if $(SUBSET),--subset $(SUBSET),) \
		$(if $(BUDGET),--budget $(BUDGET),) \
		$(if $(REPS),--reps $(REPS),) \
		$(if $(CONFIRM),--confirm,) \
		$(if $(SCENARIOS),--scenarios $(SCENARIOS),)

bench-agent-memory-report: ## Generate REPORT.md from stored results (RUN=<run-id> required; OUT=<path> optional)
	@if [ -z "$(RUN)" ]; then \
		echo "bench-agent-memory-report: RUN is required, e.g. make bench-agent-memory-report RUN=run-20261018-154202-xxxx" >&2; \
		exit 2; \
	fi
	cd benchmarks/agent-memory && bun run report --run-id $(RUN) $(if $(OUT),--out $(OUT),)

bench-agent-memory-clean: ## Remove benchmark run dirs (ALL=1 also removes .work/ worktrees + cache)
	cd benchmarks/agent-memory && bun run clean $(if $(filter 1,$(ALL)),--all,)
