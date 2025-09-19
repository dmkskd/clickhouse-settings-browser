REPO ?= ClickHouse
CATEGORIES ?= categories.yaml
OUT ?= settings.json
MINORS ?= 2
CHANNEL ?= both
VERSIONS ?=
SITE_DIR ?= docs
BETA_MINORS ?= 1
BETA_CHANNEL ?= both

.DEFAULT_GOAL := help
.PHONY: help bootstrap refresh generate generate-tags serve clean deep-clean site site-static serve-site clean-site site-beta site-all site-data-only promote-ui enrich

help: ## Show this help with target descriptions
	@echo "Usage: make [target] [VAR=val ...]"; \
	 echo; \
	 echo "Targets:"; \
	 awk 'BEGIN {FS=":.*## "} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST); \
	 echo; \
	 echo "Common variables:"; \
	 printf "  %-18s %s\n" REPO "ClickHouse repo path (default: $(REPO))"; \
	 printf "  %-18s %s\n" MINORS "Number of minors from changelog (default: $(MINORS))"; \
	 printf "  %-18s %s\n" CHANNEL "stable|lts|both (default: $(CHANNEL))"; \
	 printf "  %-18s %s\n" VERSIONS "Space-separated tags for generate-tags"; \
	 printf "  %-18s %s\n" SITE_DIR "Site output directory (default: $(SITE_DIR))";

generate: ## Generate settings.json from CHANGELOG (MINORS, CHANNEL)
	python3 extract_settings.py --repo $(REPO) --from-changelog $(REPO)/CHANGELOG.md --minors $(MINORS) --channel $(CHANNEL) --categories $(CATEGORIES) --out $(OUT)

generate-tags: ## Generate settings.json for explicit VERSIONS
	@if [ -z "$(VERSIONS)" ]; then echo "Set VERSIONS=\"vX.Y.Z ...\""; exit 1; fi
	python3 extract_settings.py --repo $(REPO) --versions $(VERSIONS) --categories $(CATEGORIES) --out $(OUT)

serve: ## Serve project root at http://localhost:8000/
	python3 -m http.server

clean: ## Remove root-level settings.json
	rm -f $(OUT)

# Clone or update ClickHouse (and optionally clickhouse-docs)
bootstrap: ## Clone or update ClickHouse repo into $(REPO)
	@if [ ! -d "$(REPO)/.git" ]; then \
		git clone --filter=blob:none --tags https://github.com/ClickHouse/ClickHouse.git $(REPO); \
	else \
		cd $(REPO) && git fetch --tags --prune && cd ..; \
	fi
	@echo "OK: ClickHouse repo ready at $(REPO)"

refresh: ## Remove $(REPO) and re-bootstrap
	rm -rf $(REPO)
	$(MAKE) bootstrap

deep-clean: ## Remove local clones and generated artifacts
	rm -rf $(REPO) clickhouse-docs settings.json settings_from_changelog.json UNKNOWN.egg-info .venv .vscode scripts_settings_dir.json docs_*.sql docs_*.sh

site-static: ## Copy static assets to $(SITE_DIR)/
	mkdir -p $(SITE_DIR)
	cp -f index.html app.js style.css $(SITE_DIR)/
	@if [ -f subsystems.png ]; then cp -f subsystems.png $(SITE_DIR)/; fi

site: site-static ## Build site assets, generate JSON (latest), then enrich (+blogs if URLS is set)
	$(MAKE) generate OUT=$(SITE_DIR)/settings.json MINORS=1 CHANNEL=$(CHANNEL)
	$(MAKE) enrich OUT=$(SITE_DIR)/settings.json DOCS=$(DOCS)
	$(if $(URLS),$(MAKE) enrich-blogs OUT=$(SITE_DIR)/settings.json URLS=$(URLS),)

site-beta: ## Build beta site under $(SITE_DIR)/beta, generate JSON (latest), then enrich (+blogs if URLS is set)
	mkdir -p $(SITE_DIR)/beta
	cp -f index.html app.js style.css $(SITE_DIR)/beta/
	@if [ -f subsystems.png ]; then cp -f subsystems.png $(SITE_DIR)/beta/; fi
	$(MAKE) generate OUT=$(SITE_DIR)/beta/settings.json MINORS=$(BETA_MINORS) CHANNEL=$(BETA_CHANNEL)
	$(MAKE) enrich OUT=$(SITE_DIR)/beta/settings.json DOCS=$(DOCS)
	$(if $(URLS),$(MAKE) enrich-blogs OUT=$(SITE_DIR)/beta/settings.json URLS=$(URLS),)

site-all: site site-beta ## Build both stable (/) and beta (/beta) sites

# Generate only JSON data in docs/ (no UI asset copies)
site-data-only: ## Generate + enrich docs/settings.json (and docs/beta/settings.json); both latest only (+blogs if URLS set)
	$(MAKE) generate OUT=$(SITE_DIR)/settings.json MINORS=1 CHANNEL=$(CHANNEL)
	$(MAKE) enrich OUT=$(SITE_DIR)/settings.json DOCS=$(DOCS)
	$(if $(URLS),$(MAKE) enrich-blogs OUT=$(SITE_DIR)/settings.json URLS=$(URLS),)
	$(MAKE) generate OUT=$(SITE_DIR)/beta/settings.json MINORS=$(BETA_MINORS) CHANNEL=$(BETA_CHANNEL)
	$(MAKE) enrich OUT=$(SITE_DIR)/beta/settings.json DOCS=$(DOCS)
	$(if $(URLS),$(MAKE) enrich-blogs OUT=$(SITE_DIR)/beta/settings.json URLS=$(URLS),)

# Promote current root UI to docs/ without regenerating data
promote-ui: ## Copy index.html/app.js/style.css to docs/ and docs/beta without touching settings.json files
	mkdir -p $(SITE_DIR) $(SITE_DIR)/beta
	cp -f index.html app.js style.css $(SITE_DIR)/
	cp -f index.html app.js style.css $(SITE_DIR)/beta/

enrich: ## Enrich OUT=settings.json with related edges and docs mentions (DOCS=clickhouse-docs)
	python3 enrich_settings.py --in $(OUT) --out $(OUT) $(if $(DOCS),--docs $(DOCS),)

enrich-blogs: ## Enrich OUT=settings.json using blog/release URLs (URLS=blog_urls.txt)
	@if [ -z "$(URLS)" ]; then echo "Set URLS=path/to/urls.txt"; exit 1; fi
	python3 enrich_settings.py --in $(OUT) --out $(OUT) --blog-urls $(URLS)

serve-site: ## Serve $(SITE_DIR)/ at http://localhost:8000/
	python3 -m http.server -d $(SITE_DIR)

clean-site: ## Remove $(SITE_DIR)/settings.json
	rm -f $(SITE_DIR)/settings.json
