ClickHouse Settings Browser

Simple, local viewer for ClickHouse settings across versions. It parses the ClickHouse source code to extract settings, defaults, tier (Production/Beta/Experimental), Cloud‑only flags, and version history, and renders them in a compact UI with filters.

Contents
- extract_settings.py — Python extractor (no external deps)
- index.html, app.js, style.css — single‑page UI
- categories.yaml — keyword/regex rules to group settings

Quick start
1) Ensure you have a local clone of ClickHouse (and optionally clickhouse-docs):
   - ClickHouse repo path: `ClickHouse/` (sibling folder in this project)
   - Optional docs repo: `clickhouse-docs/` (not required)

2) Generate data (latest two monthly releases via CHANGELOG):
   - `python3 extract_settings.py --repo ClickHouse --from-changelog ClickHouse/CHANGELOG.md --minors 2 --channel both --categories categories.yaml --out settings.json`

   Or specify tags explicitly:
   - `python3 extract_settings.py --repo ClickHouse --versions v25.8.2.29-lts v25.7.6.21-stable --categories categories.yaml --out settings.json`

3) Open the UI:
   - `python3 -m http.server` and browse to `http://localhost:8000/`
   - Or open `index.html` directly in a browser.

Enrichment (Related + Docs Mentions)
- Add relationships between settings (families, co-changes, docs co-mentions) and short docs excerpts.
- Requires a generated `settings.json` and optionally a local `clickhouse-docs` clone for docs co-mentions.

Steps
1) Generate data as above (root `settings.json`).
2) Enrich in place (no network):
   - `make enrich OUT=settings.json DOCS=clickhouse-docs`
   - This augments each setting with:
     - `related`: top related settings with reasons (e.g., token_overlap, min_max_pair, co_changed, docs_comention)
     - `mentions.docs`: list of `{url, excerpt}` from docs pages when available
3) Reload the UI. Rows show:
   - Colored Topic chips as before
   - A “Related” line with quick links + reason badges
   - An “Insights” section (expand) with docs + blog snippets when available

Notes
- Enrichment is offline (no blog fetch). Phase 2 can add blog co-mentions if needed.
- To regenerate site data without copying UI assets, use `make site-data-only`.

Online enrichment (ClickHouse blog / release posts)
- You can augment enrichment with co-mentions from clickhouse.com/blog release posts and articles.
- Prepare a URLs file (one per line), e.g. `blog_urls.txt`, containing only clickhouse.com links (release posts or blogs).
- Run:
  - `make enrich-blogs OUT=settings.json URLS=blog_urls.txt`
- The script fetches each URL, extracts text, finds settings co-mentioned in the same paragraph, and adds:
  - mentions.blogs: `{ url, title, excerpt }`
  - related edges with reason `blog_comention` (merged into the existing Related list)
- The UI shows blog snippets under “Insights” and reasons in the Related badges.

Extractor features
- Parses session settings from `src/Core/Settings.cpp` (COMMON_SETTINGS)
- Parses MergeTree settings from `src/Storages/MergeTree/MergeTreeSettings.cpp` (MERGE_TREE_SETTINGS)
- Tiers and Important flag parsed from macro flags (production/beta/experimental)
- Cloud‑only detection via description phrases (e.g. “Only has an effect in ClickHouse Cloud”)
- Version history parsed from `src/Core/SettingsChangesHistory.cpp`
- Versions selected via:
  - `--from-changelog ClickHouse/CHANGELOG.md` with `--minors` and `--channel stable|lts|both`, or
  - `--versions`/`--versions-file`

UI features
- Scope pills: Session, MergeTree (multi‑select)
- Category pills: configurable via `categories.yaml` (multi‑select, color coded)
- Tier pills: Production, Beta, Experimental (multi‑select, color coded)
- Toggles: Cloud‑only, Changed in selected version
- Search: filters by name/description (debounced)
- Row chips: Type, Category (color), Scope, Tier, Cloud‑only, alias, and a Docs link

Tips
- For GitHub Pages, you can commit a generated `settings.json`. For development, it’s fine to keep it ignored locally and regenerate as needed.
- Update `categories.yaml` to refine grouping; first matching rule wins, unmatched go to “Uncategorized”.

Make targets (optional)
- `make generate` — from CHANGELOG (set MINORS/CHANNEL as needed)
- `make generate-tags` — specify VERSIONS="<tag1> <tag2> ..."
- `make serve` — run a local static server

Publishing to GitHub Pages
- This repo is set up to publish from the `docs/` folder.
- Build site assets and generate JSON into `docs/`:
  - `make site` (equivalent to `make site-static` + `make generate OUT=docs/settings.json`)
- Preview only the site folder:
  - `make serve-site` (serves from `docs/`)
- Commit and push `docs/` so Pages can serve it.
- Note: `.gitignore` ignores the top-level `settings.json` but allows `docs/settings.json` to be committed.
