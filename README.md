# ClickHouse Settings Browser

Simple, local viewer for ClickHouse settings across versions. It parses the ClickHouse source code to extract settings, defaults, tier (Production/Beta/Experimental), Cloud‑only flags, and version history, and renders them in a compact UI with filters.

## Contents
- [Highlights](#highlights)
- [Live Demo](#live-demo)
- [Quick Start](#quick-start)
- [Build & Publish](#build--publish)
- [Enrichment](#enrichment)
- [UI Features](#ui-features)
- [Tips](#tips)
- [Make Targets](#make-targets-optional)
- [Publishing to GitHub Pages](#publishing-to-github-pages)
- [Licensing](#licensing)

## Highlights
- Uses official ClickHouse source as the source of truth (Session, MergeTree, Formats) with defaults and version history.
- Enriches with Related suggestions (naming families, co‑changes, docs/blog co‑mentions) and short “Insights”.
- Clear filters: Scope, Topic, Tier, and Special (Cloud‑only, Blogs/Release Notes); deep‑link to any row.
- Search supports multi‑word AND and quoted phrases; results update live.
- Shareable URLs: querystring encodes full filter state (`q`, `v`, `scopes`, `topics`, `tiers`, `special`, `changed`); rows have `#s-<name>` anchors.
- GitHub Pages‑ready; site builds generate the latest version and auto‑run enrichment; optional auto‑detection for blogs/docs.

## Live Demo
- Stable: https://dmkskd.github.io/clickhouse-settings-browser/
- Beta: https://dmkskd.github.io/clickhouse-settings-browser/beta/

## Quick Start
1) Prepare repos (local clones):
   - ClickHouse: `ClickHouse/` (sibling folder)
   - Optional docs: `clickhouse-docs/` (not required)
2) Generate data (example from CHANGELOG):
   - `python3 extract_settings.py --repo ClickHouse --from-changelog ClickHouse/CHANGELOG.md --minors 2 --channel both --categories categories.yaml --out settings.json`
   - Or specify tags: `python3 extract_settings.py --repo ClickHouse --versions v25.8.2.29-lts v25.7.6.21-stable --categories categories.yaml --out settings.json`
3) Open the UI:
   - `python3 -m http.server` → `http://localhost:8000/` (or open `index.html` directly)

## Build & Publish
- Fast path (latest only): `make site-all`
  - Copies UI to `docs/` + generates and enriches JSON
  - Auto‑detects `blogs.txt` and `clickhouse-docs/` if present; disable via `AUTO_BLOGS=0` / `AUTO_DOCS=0`
- With blogs: `make site-all URLS=blogs.txt`
- With blogs + docs co‑mentions: `make site-all URLS=blogs.txt DOCS=clickhouse-docs`
- Pages publish: commit `docs/` and push; preview with `make serve-site`
- Development happens in the project root (`index.html`, `app.js`, `style.css`). The `docs/` folder is only for publishing.

## Enrichment
- What it adds
  - `related` suggestions (tokens/families, co‑changes, docs/blog co‑mentions)
  - `mentions.docs`: `{ url, excerpt }` when docs scan is enabled
  - `mentions.blogs`: `{ url, title, excerpt }` when blogs are enabled
- How to run
  - In place (root): `make enrich OUT=settings.json DOCS=clickhouse-docs`
  - Site builds auto‑run enrichment; pass `URLS=blogs.txt` and/or `DOCS=clickhouse-docs` to include mentions; auto‑detected if present
  - Skip data copy but refresh JSON: `make site-data-only`

## UI Features
- Scope pills: Session, MergeTree, Formats (multi‑select)
- Topic pills: unified Topics (Categories ∪ inferred subsystems), color coded (multi‑select)
- Tier pills: Production, Beta, Experimental (multi‑select) — hover for details & link
- Special pills: Cloud‑only and Blog / Release Notes
- Search: multi‑word AND + quoted phrases, debounced; syncs to `?q=`
- Deep links: stable `#s-<name>` anchors; copy‑link button
- Row chips: Type, Topic, Scope, Tier, Cloud‑only, alias, Docs link
- Help panel: official docs link + short “How this works” overview

## Tips
- You can commit `docs/settings.json` for Pages. For development, keep root `settings.json` ignored and regenerate.
- Update `categories.yaml` to refine grouping; first matching rule wins; unmatched → “Uncategorized”.

## Make Targets (optional)
- `make generate` — from CHANGELOG (MINORS/CHANNEL)
- `make generate-tags` — specify VERSIONS="<tag1> <tag2> ..."
- `make serve` — run a local static server
- `make enrich OUT=settings.json DOCS=clickhouse-docs` — enrich an existing JSON (DOCS optional)
- `make serve-site` — serve `docs/` at http://localhost:8000/

## Publishing to GitHub Pages
- Publishes from the `docs/` folder.
- Build site assets and generate + enrich JSON (latest by default):
  - `make site` (copies UI, generates MINORS=1, runs enrichment)
  - Optional: `URLS=blogs.txt` for blogs, `DOCS=clickhouse-docs` for docs (auto‑detected if present)
- Preview only the site folder: `make serve-site`
- Commit and push `docs/` so Pages can serve it.

## Licensing
- Code in this repository is licensed under the Apache License 2.0. See `LICENSE`.
- The project extracts and redistributes setting metadata (e.g., names, defaults, descriptions, version history) from the ClickHouse open‑source repository (https://github.com/ClickHouse/ClickHouse), which is licensed under the Apache License 2.0. No upstream source files are bundled; data is parsed into JSON and rendered by the UI.
- The generated data (e.g., `settings.json`) may include:
  - Short excerpts and links from the ClickHouse documentation (https://github.com/ClickHouse/clickhouse-docs), under Creative Commons CC BY‑NC‑SA 4.0. Excerpts are brief and include a source link. CC BY‑NC‑SA terms (attribution, non‑commercial, share‑alike for adaptations) apply to the quoted text only.
  - Short excerpts, titles, and links from clickhouse.com blog/release notes (© ClickHouse, Inc.).
- See `NOTICE` for attribution details.
- To avoid excerpts entirely (links only), do not pass `DOCS=` and `URLS=` (or disable auto‑detection via `AUTO_DOCS=0` / `AUTO_BLOGS=0`).
