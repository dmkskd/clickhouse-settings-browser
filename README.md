ClickHouse Settings Browser

Simple, local viewer for ClickHouse settings across versions. It parses the ClickHouse source code to extract settings, defaults, tier (Production/Beta/Experimental), Cloud‑only flags, and version history, and renders them in a compact UI with filters.

Live site
- Stable: https://dmkskd.github.io/clickhouse-settings-browser/
- Beta: https://dmkskd.github.io/clickhouse-settings-browser/beta/

Simple build commands
- Latest only, with Related populated (no network): `make site-all`
- Include Blogs & Release Notes too: `make site-all URLS=blogs.txt` (auto-detected if `blogs.txt` exists)
- Include Blogs & Release Notes + docs co‑mentions: `make site-all URLS=blogs.txt DOCS=clickhouse-docs` (docs auto-detected if `clickhouse-docs/` exists)
- Development is in the project root (`index.html`, `app.js`, `style.css`). The `docs/` folder is only updated by `make site*` targets for publishing.

Contents
- extract_settings.py — Python extractor (no external deps)
- index.html, app.js, style.css — single‑page UI
- categories.yaml — keyword/regex rules to group settings

Quick start
1) Ensure you have a local clone of ClickHouse (and optionally clickhouse-docs):
   - ClickHouse repo path: `ClickHouse/` (sibling folder in this project)
   - Optional docs repo: `clickhouse-docs/` (not required)

2) Generate data (example: latest two monthly releases via CHANGELOG):
   - `python3 extract_settings.py --repo ClickHouse --from-changelog ClickHouse/CHANGELOG.md --minors 2 --channel both --categories categories.yaml --out settings.json`

   Or specify tags explicitly:
   - `python3 extract_settings.py --repo ClickHouse --versions v25.8.2.29-lts v25.7.6.21-stable --categories categories.yaml --out settings.json`

3) Open the UI:
   - `python3 -m http.server` and browse to `http://localhost:8000/`
   - Or open `index.html` directly in a browser.

Enrichment (Related + Mentions)
- Adds relationships between settings (families, co-changes, co-mentions) and short documentation snippets.
- Requires a generated `settings.json` and optionally a local `clickhouse-docs` clone for docs co-mentions.

Steps
1) Generate data as above (root `settings.json`).
2) Enrich in place (no network):
   - `make enrich OUT=settings.json DOCS=clickhouse-docs`
   - This augments each setting with:
     - `related`: top related settings with reasons (e.g., token_overlap, min_max_pair, co_changed, docs_comention, blog_comention)
     - `mentions.docs`: list of `{url, excerpt}` from docs pages when available
     - `mentions.blogs`: list of `{url, title, excerpt}` from official blog / release notes when provided
3) Reload the UI. Rows show:
   - Colored Topic chips as before
   - A “Related” line with quick links + reason badges
   - An “Insights” section (expand) with docs + blog snippets when available

Notes
- To regenerate site data without copying UI assets, use `make site-data-only`.

Online enrichment (ClickHouse blog / release notes)
- You can augment enrichment with co-mentions from clickhouse.com/blog release posts and articles.
- Prepare a URLs file (one per line), e.g. `blog_urls.txt`, containing only clickhouse.com links (release posts or blogs).
- Run:
  - `make enrich-blogs OUT=settings.json URLS=blog_urls.txt` (you can use `blogs.txt` in this repo as a starting point)
- The script fetches each URL, extracts text, finds settings co-mentioned in the same paragraph, and adds:
  - mentions.blogs: `{ url, title, excerpt }`
  - related edges with reason `blog_comention` (merged into the existing Related list)
- The UI shows blog snippets under “Blogs & Release Notes” and reasons in the Related badges.

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
- Scope pills: Session, MergeTree, Formats (multi‑select)
- Topic pills: unified Topics (Categories ∪ inferred subsystems), color coded (multi‑select)
- Tier pills: Production, Beta, Experimental (multi‑select, color coded) — hover for details & link
- Special pills: Cloud‑only and Blog / Release Notes
- Search: filters by name/description (debounced), supports multi‑word AND and quoted phrases (e.g., `lazy materialization`), and syncs to `?q=`
- Deep links: each setting has a stable `#s-<name>` anchor; a ⧉ button copies a direct link
- Row chips: Type, Topic, Scope, Tier, Cloud‑only, alias, and a Docs link
- Help panel: link to official settings docs and a short "How this works" overview

Tips
- For GitHub Pages, you can commit a generated `settings.json`. For development, it’s fine to keep it ignored locally and regenerate as needed.
- Update `categories.yaml` to refine grouping; first matching rule wins, unmatched go to “Uncategorized”.
 - Development happens in the project root (index.html/app.js/style.css). The `docs/` folder is only for publishing.

Make targets (optional)
- `make generate` — from CHANGELOG (set MINORS/CHANNEL as needed)
- `make generate-tags` — specify VERSIONS="<tag1> <tag2> ..."
- `make serve` — run a local static server
 - `make enrich OUT=settings.json DOCS=clickhouse-docs` — enrich an existing JSON (DOCS optional)

Publishing to GitHub Pages
- This repo is set up to publish from the `docs/` folder.
- Build site assets and generate + enrich JSON into `docs/` (latest version only by default):
  - `make site` (copies UI, generates MINORS=1, and runs enrichment)
  - Blogs & Release Notes (optional): pass `URLS=blogs.txt` to also enrich with online co‑mentions (auto if `blogs.txt` present)
  - Docs co‑mentions (optional): pass `DOCS=clickhouse-docs` if you have a local clone (auto if `clickhouse-docs/` present)
- Preview only the site folder:
  - `make serve-site` (serves from `docs/`)
- Commit and push `docs/` so Pages can serve it.
- Note: `.gitignore` ignores the top-level `settings.json` but allows `docs/settings.json` to be committed.

Notes on enrichment in site builds
- `make site`, `make site-beta`, and `make site-data-only` now run enrichment automatically so “Related” is always populated.
- If you have a local clone of clickhouse-docs, you can pass `DOCS=clickhouse-docs` to include docs co-mentions (auto-detected if present).
- To include blog/release co-mentions, pass `URLS=blogs.txt` (auto-detected if present).
- You can disable auto-detection with `AUTO_BLOGS=0` and/or `AUTO_DOCS=0`.
