'use strict';

// Debug helpers (toggle DBG to silence logs)
const DBG = true;
function dlog(...args) {
  if (DBG && window && window.console) {
    console.debug('[SettingsBrowser]', ...args);
  }
}
// Surface async errors while iterating
window.addEventListener('unhandledrejection', e => {
  if (DBG) console.error('[SettingsBrowser] Unhandled rejection:', e.reason);
});
window.addEventListener('error', e => {
  if (DBG) console.error('[SettingsBrowser] Error:', e.error || e.message);
});

window.SettingsApp = (() => {
  let data = null;
  const els = {};
  // Track prior selection context to preserve user intent across scope changes
  let lastScopes = null; // Set of scope values
  let lastApplySubsysFilter = null; // boolean: whether a subsystem filter was applied previously

  function el(id) { return document.getElementById(id); }

  function fmtDefault(v) {
    return v ?? '';
  }

  function uniqueCategories(settings) {
    const set = new Set();
    settings.forEach(s => set.add(s.category || 'Uncategorized'));
    return Array.from(set).sort((a,b) => a.localeCompare(b));
  }

  function uniqueSubsystems(settings) {
    const set = new Set();
    settings.forEach(s => ((s.subsystems || s._subsystems) || []).forEach(x => set.add(x)));
    return Array.from(set).sort((a,b) => a.localeCompare(b));
  }

  function inferSubsystems(name, desc, scope) {
    const subs = new Set();
    const t = `${name} ${desc || ''}`.toLowerCase();
    const add = (x)=>subs.add(x);
    if (scope === 'mergetree') add('MergeTree');
    if (scope === 'format') add('Formats');
    if (t.includes('replica') || t.includes('replicat')) add('Replicated');
    if (t.includes('distributed')) add('Distributed');
    if (t.includes('kafka')) add('Kafka');
    if (t.includes('zookeeper') || t.includes('keeper')) add('ZooKeeper/Keeper');
    if (t.includes('mysql')) add('MySQL');
    if (t.includes('postgres') || t.includes('psql')) add('PostgreSQL');
    if (/(^|\b)s3(\b|_)/.test(t) || t.includes('minio')) add('S3');
    if (t.includes('azure')) add('Azure');
    if (t.includes('hdfs')) add('HDFS');
    if (t.includes('rocksdb')) add('RocksDB');
    if (t.includes('mutation') || t.includes('lightweight_update') || t.includes(' update') || t.includes(' delete')) add('Mutations');
    if (/(^|\b)merge(s)?(\b|_)/.test(t)) add('Merges');
    if (t.includes('thread') && t.includes('pool')) add('Thread Pools');
    if (t.includes('on cluster') || t.includes('distributed_ddl') || t.includes(' ddl')) add('Coordination/DDL');
    if (t.includes('mark_cache') || t.includes('uncompressed_cache') || t.includes('compiled_expression_cache') || t.includes('filesystem_cache')) add('Caches');
    if (t.includes('log') || t.includes('trace') || t.includes('profile') || t.includes('metrics') || t.includes('prometheus')) add('Observability');
    if (t.includes('max_') || t.includes('memory_') || t.includes('timeout') || t.includes('bandwidth') || t.includes('_pool_')) add('Resource Control');
    if (t.includes(' ssl') || t.includes('secure') || t.includes('password') || t.includes('auth')) add('Security');
    return Array.from(subs);
  }

  function parseTierFromFlags(flags) {
    if (!flags) return 'production';
    const tokens = String(flags).toLowerCase();
    if (tokens.includes('experimental')) return 'experimental';
    if (tokens.includes('beta')) return 'beta';
    // 'obsolete' may appear in the future
    return 'production';
  }

  function renderControls() {
    const { versions } = data;
    // Build scope toggles
    buildToggleGroup(els.scopeGroup, [
      { value: 'session', label: 'Session' },
      { value: 'mergetree', label: 'MergeTree' },
      { value: 'format', label: 'Formats' },
    ], getSelectedSet(els.scopeGroup) || new Set(['session','mergetree','format']));

    const settings = combinedDataset(getSelectedScopes());
    // Version select
    els.versionSelect.innerHTML = '';
    versions.slice().reverse().forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      els.versionSelect.appendChild(opt);
    });
    // Default to latest
    els.versionSelect.selectedIndex = 0;

    // Subsystem toggles (guarded)
    const subs = uniqueSubsystems(settings);
    if (els.subsystemGroup) {
      // Decide selection preservation based on previous scope state and whether a subsystem filter was applied
      const newScopes = getSelectedScopes();
      const prevScopes = lastScopes instanceof Set ? lastScopes : null;
      const isSuperset = !!(prevScopes && newScopes.length >= prevScopes.size && Array.from(prevScopes).every(v => newScopes.includes(v)) && newScopes.length > prevScopes.size);
      let sel = getSelectedSet(els.subsystemGroup);
      if (isSuperset && lastApplySubsysFilter === false) {
        // Previously no subsystem filter; expanding scopes should keep 'All' semantics
        sel = new Set(subs);
      }
      buildToggleGroup(
        els.subsystemGroup,
        subs.map(s => ({ value: s, label: s })),
        sel || new Set(subs)
      );
    }

    // Category toggles
    const cats = uniqueCategories(settings);
    buildToggleGroup(els.categoryGroup, cats.map(c => ({ value: c, label: c })), getSelectedSet(els.categoryGroup) || new Set(cats));

    // Tier toggles
    const tiers = [
      { value: 'production', label: 'Production' },
      { value: 'beta', label: 'Beta' },
      { value: 'experimental', label: 'Experimental' },
    ];
    buildToggleGroup(els.tierGroup, tiers, getSelectedSet(els.tierGroup) || new Set(tiers.map(t => t.value)));
    applyGroupTooltips();
    try { updateFacetCounts(); } catch (e) { dlog('updateFacetCounts error', e); }
  }

  function renderList() {
    const version = els.versionSelect.value;
    const scopes = getSelectedScopes();
    const categories = getSelectedValues(els.categoryGroup);
    const q = els.searchInput.value.trim().toLowerCase();
    const selectedTiers = new Set(getSelectedValues(els.tierGroup));
    const selectedSubsystems = new Set(getSelectedValues(els.subsystemGroup || { querySelectorAll: () => [] }));
    const allSubsCount = (els.subsystemGroup && els.subsystemGroup.querySelectorAll) ? els.subsystemGroup.querySelectorAll('.toggle').length : 0;
    const applySubsysFilter = selectedSubsystems.size > 0 && selectedSubsystems.size < allSubsCount;
    const cloudOnly = els.cloudOnly.checked;
    const changedOnly = els.changedOnly.checked;

    const items = combinedDataset(scopes).filter(s => {
      // Filter by category
      if (categories.length && !categories.includes(s.category || 'Uncategorized')) return false;
      if (cloudOnly && !s.cloud_only) return false;
      // Filter by version presence
      if (!s.versions || !s.versions[version]) return false;
      // Filter by tier for selected version
      const vinfo = s.versions[version];
      const stier = vinfo?.tier || parseTierFromFlags(s.flags) || 'production';
      if (selectedTiers.size && !selectedTiers.has(stier)) return false;
      // Subsystem any-match: if user selected any subsystems, item must have at least one of them
      const ssubs = (s._subsystems || s.subsystems || []);
      if (applySubsysFilter && !ssubs.some(x => selectedSubsystems.has(x))) return false;
      if (changedOnly && !vinfo?.changed_from_prev) return false;
      if (!q) return true;
      return (s._hayLower || '').includes(q);
    });

    // Stats
    const allTiers = ['production','beta','experimental'];
    const tiersArr = Array.from(selectedTiers.values());
    const tierLabel = (tiersArr.length === 0 || tiersArr.length === allTiers.length) ? '' : ` — Tiers: ${tiersArr.join(', ')}`;
    const changedLabel = changedOnly ? ' — Changed' : '';
    const scopeNames = scopes.map(s => s === 'mergetree' ? 'MergeTree' : (s === 'format' ? 'Formats' : 'Session'));
    const scopeLabel = scopeNames.length ? ` — Scopes: ${scopeNames.join(', ')}` : '';
    const catLabel = categories.length ? ` — Categories: ${categories.slice(0,3).join(', ')}${categories.length>3?'…':''}` : '';
    const subsLabel = applySubsysFilter ? ` — Subsystems: ${Array.from(selectedSubsystems).slice(0,3).join(', ')}${selectedSubsystems.size>3?'…':''}` : '';
    els.stats.textContent = `${items.length} settings — ${version}` + scopeLabel + subsLabel + catLabel + tierLabel + (cloudOnly ? ' — Cloud-only' : '') + changedLabel;

    // Subsystem map removed to reduce clutter

    // Render
    const frag = document.createDocumentFragment();
    items.forEach(s => {
      const row = document.createElement('div');
      row.className = 'setting';
      const def = s.versions[version]?.default ?? '';
      const stier = s.versions[version]?.tier || parseTierFromFlags(s.flags) || 'production';
      const history = s.history || [];
      // Use a short snippet for description to keep rendering fast
      const descSnippet = (s.description || '').substring(0, 240);
      const catName = s.category || 'Uncategorized';
      const catClass = 'v-' + String(catName).toLowerCase().replace(/[^a-z0-9_-]/g,'');
      const docUrl = s.docs_url || buildDocsUrl(s._scope, s.name);
      const subsystems = (s._subsystems || s.subsystems || []);
      const subsFirst = subsystems.slice(0,1);
      const subsExtra = subsystems.length > 1 ? subsystems.length - 1 : 0;
      row.innerHTML = `
        <div class="h">
          <div class="name">${s.name}
            ${docUrl ? `<a class="doclink" href="${docUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open docs for ${s.name}" title="Open docs">🔗</a>` : ''}
          </div>
          <div class="meta">
            <span class="chip">${s.type}</span>
            <span class="chip category ${catClass}">${catName}</span>
            <span class="chip scope">${s._scope === 'mergetree' ? 'MergeTree' : (s._scope === 'format' ? 'Formats' : 'Session')}</span>
            ${subsFirst.map(x => `<span class="chip subsys">${x}</span>`).join('')}
            ${subsExtra ? `<span class="chip subsys">+${subsExtra}</span>` : ''}
            ${stier === 'beta' ? `<span class="chip beta">Beta</span>` : ''}
            ${stier === 'experimental' ? `<span class="chip experimental">Experimental</span>` : ''}
            ${s.cloud_only ? `<span class="chip cloud">Cloud-only</span>` : ''}
            ${s.alias ? `<span class="chip alias">alias: ${s.alias}</span>` : ''}
          </div>
        </div>
        <div class="body">
          <div class="default"><span class="label">Default:</span> <code>${fmtDefault(def)}</code></div>
          <details>
            <summary>Description</summary>
            <div class="desc">${escapeHtml(descSnippet)}${s.description && s.description.length > 240 ? '…' : ''}</div>
          </details>
          ${history.length ? `<details><summary>Version history</summary>${history.map(h => `<div class="history-row"><span class="tag">${h.version_minor}</span> <code>${escapeHtml(h.new_default)}</code> — ${escapeHtml(h.comment)}</div>`).join('')}</details>` : ''}
        </div>
      `;
      frag.appendChild(row);
    });
    els.list.innerHTML = '';
    els.list.appendChild(frag);
    // Remember current state for next control rebuild
    try {
      lastScopes = new Set(scopes);
      lastApplySubsysFilter = applySubsysFilter;
    } catch {}
    try { updateFacetCounts(); } catch (e) { dlog('updateFacetCounts error', e); }
  }

  function renderSubsystemMap(items) {
    const mapEl = document.getElementById('subsysMap');
    if (!mapEl) return;
    const counts = new Map();
    items.forEach(s => (s._subsystems || s.subsystems || []).forEach(x => counts.set(x, (counts.get(x)||0)+1)));
    const selected = new Set(getSelectedValues(els.subsystemGroup || { querySelectorAll: () => [] }));
    const subs = Array.from(counts.keys()).sort((a,b)=>a.localeCompare(b));
    const frag = document.createDocumentFragment();
    subs.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'subsys-card' + (selected.has(name) ? ' selected' : '');
      btn.innerHTML = `<span>${name}</span><span class="count">${counts.get(name)}</span>`;
      btn.addEventListener('click', (ev) => toggleSubsystemFromExternal(name, ev));
      frag.appendChild(btn);
    });
    mapEl.innerHTML = '';
    mapEl.appendChild(frag);
  }

  // Toggle subsystem selection by simulating a click on the pill
  function toggleSubsystemFromExternal(name, ev) {
    if (!els.subsystemGroup) return;
    const all = Array.from(els.subsystemGroup.querySelectorAll('.toggle'));
    const pill = all.find(b => b.dataset.value === name);
    if (!pill) return; // Unknown subsystem (no pill present)
    if (ev && (ev.altKey || ev.metaKey || ev.shiftKey)) {
      all.forEach(b => { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); });
      pill.classList.add('selected');
      pill.setAttribute('aria-pressed', 'true');
    } else {
      pill.classList.toggle('selected');
      pill.setAttribute('aria-pressed', pill.classList.contains('selected') ? 'true' : 'false');
    }
    els.subsystemGroup.dispatchEvent(new Event('change'));
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  }

  function attachEvents() {
    els.scopeGroup.addEventListener('change', () => { renderControls(); renderList(); updateTitleVersion(); });
    els.versionSelect.addEventListener('change', () => { updateTitleVersion(); renderList(); });
    els.categoryGroup.addEventListener('change', renderList);
    if (els.subsystemGroup) els.subsystemGroup.addEventListener('change', renderList);
    els.tierGroup.addEventListener('change', renderList);
    const debounced = debounce(renderList, 200);
    els.searchInput.addEventListener('input', debounced);
    els.cloudOnly.addEventListener('change', renderList);
    els.changedOnly.addEventListener('change', renderList);
  }

  async function loadData() {
    const resp = await fetch('settings.json');
    if (!resp.ok) throw new Error('Failed to load settings.json');
    data = await resp.json();
    dlog('loadData:', {
      versions: (data.versions||[]).length,
      session: (data.settings||[]).length,
      mergetree: (data.merge_tree_settings||[]).length,
      formats: (data.format_settings||[]).length,
    });
    // Precompute lowercase haystacks for faster search
    const enrich = (arr, scope) => {
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        s._scope = scope || s._scope; // ensure scope if not set by combinedDataset
        s._hayLower = `${s.name} ${s.description || ''}`.toLowerCase();
        // Infer subsystems client-side so Subsystem pills can populate
        try {
          s._subsystems = inferSubsystems(s.name, s.description || '', scope);
        } catch (e) {
          dlog('inferSubsystems error for', s.name, 'scope', scope, e);
        }
      }
    };
    enrich(data.settings, 'session');
    enrich(data.merge_tree_settings, 'mergetree');
    enrich(data.format_settings, 'format');
  }

  async function init() {
    els.versionSelect = el('versionSelect');
    els.titleVersion = el('titleVersion');
    els.themeToggle = el('themeToggle');
    els.scopeGroup = el('scopeGroup');
    els.subsystemGroup = el('subsystemGroup');
    els.categoryGroup = el('categoryGroup');
    els.subAll = el('subAll');
    els.subNone = el('subNone');
    els.catAll = el('catAll');
    els.catNone = el('catNone');
    els.tierGroup = el('tierGroup');
    els.searchInput = el('searchInput');
    els.list = el('list');
    els.stats = el('stats');
    els.cloudOnly = el('cloudOnly');
    els.changedOnly = el('changedOnly');

    // Theme setup
    applySavedTheme();
    els.themeToggle.addEventListener('click', toggleTheme);

    await loadData();
    renderControls();
    updateTitleVersion();
    if (els.catAll) els.catAll.addEventListener('click', () => setAllSelected(els.categoryGroup, true));
    if (els.catNone) els.catNone.addEventListener('click', () => setAllSelected(els.categoryGroup, false));
    if (els.subAll && els.subsystemGroup) els.subAll.addEventListener('click', () => setAllSelected(els.subsystemGroup, true));
    if (els.subNone && els.subsystemGroup) els.subNone.addEventListener('click', () => setAllSelected(els.subsystemGroup, false));
    attachEvents();
    renderList();
  }

  function combinedDataset(scopes) {
    if (!data) return [];
    const arr = [];
    if (scopes.includes('session') && Array.isArray(data.settings)) {
      for (const s of data.settings) {
        const obj = Object.assign({}, s, { _scope: 'session' });
        if (!obj._hayLower) obj._hayLower = `${obj.name} ${obj.description || ''}`.toLowerCase();
        arr.push(obj);
      }
    }
    if (scopes.includes('mergetree') && Array.isArray(data.merge_tree_settings)) {
      for (const s of data.merge_tree_settings) {
        const obj = Object.assign({}, s, { _scope: 'mergetree' });
        if (!obj._hayLower) obj._hayLower = `${obj.name} ${obj.description || ''}`.toLowerCase();
        arr.push(obj);
      }
    }
    if (scopes.includes('format') && Array.isArray(data.format_settings)) {
      for (const s of data.format_settings) {
        const obj = Object.assign({}, s, { _scope: 'format' });
        if (!obj._hayLower) obj._hayLower = `${obj.name} ${obj.description || ''}`.toLowerCase();
        arr.push(obj);
      }
    }
    return arr;
  }

  function buildToggleGroup(container, options = [], selectedSet) {
    if (!container || typeof container.innerHTML !== 'string') {
      console.error('[SettingsBrowser] buildToggleGroup: invalid container', container);
      return;
    }
    container.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toggle v-' + String(opt.value).toLowerCase().replace(/[^a-z0-9_-]/g,'');
      if (selectedSet && selectedSet.has(opt.value)) btn.classList.add('selected');
      if (opt && typeof opt.count === 'number') {
        btn.innerHTML = `<span class="label">${opt.label}</span><span class="count" aria-hidden="true">${opt.count}</span>`;
      } else {
        btn.textContent = opt.label;
      }
      btn.dataset.value = opt.value;
      // Default title, overridden by applyGroupTooltips()
      btn.title = opt.label + ' — Alt-click: only this';
      btn.setAttribute('aria-pressed', selectedSet && selectedSet.has(opt.value) ? 'true' : 'false');
      btn.addEventListener('click', (ev) => {
        if (ev.altKey || ev.metaKey || ev.shiftKey) {
          // Solo selection: deselect siblings, select only this
          container.querySelectorAll('.toggle').forEach(b => {
            b.classList.remove('selected');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('selected');
          btn.setAttribute('aria-pressed', 'true');
          container.dispatchEvent(new Event('change'));
          return;
        }
        btn.classList.toggle('selected');
        btn.setAttribute('aria-pressed', btn.classList.contains('selected') ? 'true' : 'false');
        container.dispatchEvent(new Event('change'));
      });
      container.appendChild(btn);
    }
  }

  function applyGroupTooltips() {
    // Scope
    if (els.scopeGroup) {
      Array.from(els.scopeGroup.querySelectorAll('.toggle')).forEach(btn => {
        const v = btn.dataset.value;
        const soloHint = ' (Alt/⌥ or Cmd/⌘ or Shift-click: only this)';
        if (v === 'session') btn.title = 'Session/query settings (system.settings)' + soloHint;
        else if (v === 'mergetree') btn.title = 'MergeTree storage settings (table-level)' + soloHint;
        else if (v === 'format') btn.title = 'Input/Output format settings' + soloHint;
      });
    }
    // Category
    if (els.categoryGroup) {
      Array.from(els.categoryGroup.querySelectorAll('.toggle')).forEach(btn => {
        btn.title = `Category: ${btn.textContent} (Alt/⌥ or Cmd/⌘ or Shift-click: only this)`;
      });
    }
    // Tier with docs
    const tierDoc = 'https://clickhouse.com/docs/beta-and-experimental-features';
    if (els.tierGroup) {
      Array.from(els.tierGroup.querySelectorAll('.toggle')).forEach(btn => {
        const v = (btn.dataset.value || '').toLowerCase();
        const soloHint = ' (Alt/⌥ or Cmd/⌘ or Shift-click: only this)';
        if (v === 'production') btn.title = 'Production: safe to use with other production features' + soloHint;
        else if (v === 'beta') btn.title = `Beta: stable but interactions may be unknown — ${tierDoc}` + soloHint;
        else if (v === 'experimental') btn.title = `Experimental: in active development — ${tierDoc}` + soloHint;
      });
    }
  }

  // Facet counts on selectors (scope, subsystem, category, tier)
  function passFilters(s, opts = {}) {
    const version = els.versionSelect.value;
    const cloudOnly = els.cloudOnly.checked;
    const changedOnly = els.changedOnly.checked;
    const q = els.searchInput.value.trim().toLowerCase();
    const selectedCategories = new Set(getSelectedValues(els.categoryGroup));
    const selectedTiers = new Set(getSelectedValues(els.tierGroup));
    const selectedSubsystems = new Set(getSelectedValues(els.subsystemGroup || { querySelectorAll: () => [] }));
    const allSubsCount = (els.subsystemGroup && els.subsystemGroup.querySelectorAll) ? els.subsystemGroup.querySelectorAll('.toggle').length : 0;
    const applySubsysFilter = selectedSubsystems.size > 0 && selectedSubsystems.size < allSubsCount;

    // Version presence
    if (!s.versions || !s.versions[version]) return false;

    const vinfo = s.versions[version];
    const stier = vinfo?.tier || parseTierFromFlags(s.flags) || 'production';

    if (cloudOnly && !s.cloud_only) return false;
    if (!opts.ignoreTier && selectedTiers.size && !selectedTiers.has(stier)) return false;
    if (!opts.ignoreCategory && selectedCategories.size && !selectedCategories.has(s.category || 'Uncategorized')) return false;
    if (!opts.ignoreSubsystem && applySubsysFilter) {
      const ssubs = (s._subsystems || s.subsystems || []);
      if (!ssubs.some(x => selectedSubsystems.has(x))) return false;
    }
    if (changedOnly && !vinfo?.changed_from_prev) return false;
    if (q && !(s._hayLower || '').includes(q)) return false;
    return true;
  }

  function updateFacetCounts() {
    if (!data) return;
    const allItems = combinedDataset(['session','mergetree','format']);

    // Scope counts
    const scopeCounts = { session: 0, mergetree: 0, format: 0 };
    for (const s of allItems) {
      if (passFilters(s, { ignoreCategory: false, ignoreTier: false, ignoreSubsystem: false })) {
        scopeCounts[s._scope] = (scopeCounts[s._scope] || 0) + 1;
      }
    }
    // Rebuild scope group with counts
    const scopeSel = getSelectedSet(els.scopeGroup) || new Set(['session','mergetree','format']);
    buildToggleGroup(els.scopeGroup, [
      { value: 'session', label: 'Session', count: scopeCounts.session || 0 },
      { value: 'mergetree', label: 'MergeTree', count: scopeCounts.mergetree || 0 },
      { value: 'format', label: 'Formats', count: scopeCounts.format || 0 },
    ], scopeSel);

    // Subsystem counts within current scopes
    const currentScopes = getSelectedScopes();
    const itemsInScopes = combinedDataset(currentScopes);
    const subsCount = new Map();
    for (const s of itemsInScopes) {
      if (!passFilters(s, { ignoreSubsystem: true })) continue;
      (s._subsystems || s.subsystems || []).forEach(x => subsCount.set(x, (subsCount.get(x)||0)+1));
    }
    if (els.subsystemGroup) {
      // Determine previous selection state before rebuilding
      const prevVals = getSelectedValues(els.subsystemGroup);
      const prevAllCount = els.subsystemGroup.querySelectorAll ? els.subsystemGroup.querySelectorAll('.toggle').length : 0;
      const prevAll = prevVals.length === prevAllCount && prevAllCount > 0;
      const prevNone = prevVals.length === 0 && prevAllCount > 0;

      const subs = Array.from(new Set(itemsInScopes.flatMap(s => (s._subsystems || s.subsystems || [])))).sort((a,b)=>a.localeCompare(b));

      let subsSel;
      if (prevAll) {
        // Previously no filtering: select all new options
        subsSel = new Set(subs);
      } else if (prevNone) {
        // Previously explicitly none: keep none
        subsSel = new Set();
      } else {
        // Keep intersection of previous selection with new options
        const prevSet = new Set(prevVals);
        subsSel = new Set(subs.filter(x => prevSet.has(x)));
        // Safety: if intersection becomes empty but there are options, default to all to avoid accidental hidden filter
        if (subsSel.size === 0 && subs.length > 0) subsSel = new Set(subs);
      }

      buildToggleGroup(els.subsystemGroup, subs.map(name => ({ value: name, label: name, count: subsCount.get(name)||0 })), subsSel);
    }

    // Category counts
    const catCount = new Map();
    for (const s of itemsInScopes) {
      if (!passFilters(s, { ignoreCategory: true })) continue;
      const c = s.category || 'Uncategorized';
      catCount.set(c, (catCount.get(c)||0)+1);
    }
    const cats = Array.from(new Set(itemsInScopes.map(s => s.category || 'Uncategorized'))).sort((a,b)=>a.localeCompare(b));
    const catSel = getSelectedSet(els.categoryGroup) || new Set(cats);
    buildToggleGroup(els.categoryGroup, cats.map(c => ({ value: c, label: c, count: catCount.get(c)||0 })), catSel);

    // Tier counts
    const tierVals = ['production','beta','experimental'];
    const tierCount = { production: 0, beta: 0, experimental: 0 };
    for (const s of itemsInScopes) {
      if (!passFilters(s, { ignoreTier: true })) continue;
      const version = els.versionSelect.value;
      const vinfo = s.versions[version];
      const stier = vinfo?.tier || parseTierFromFlags(s.flags) || 'production';
      tierCount[stier] = (tierCount[stier]||0) + 1;
    }
    const tierSel = getSelectedSet(els.tierGroup) || new Set(tierVals);
    buildToggleGroup(els.tierGroup, [
      { value: 'production', label: 'Production', count: tierCount.production||0 },
      { value: 'beta', label: 'Beta', count: tierCount.beta||0 },
      { value: 'experimental', label: 'Experimental', count: tierCount.experimental||0 },
    ], tierSel);
    applyGroupTooltips();
  }

  // Bulk select helpers for category group
  function setAllSelected(container, selected) {
    container.querySelectorAll('.toggle').forEach(b => {
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    container.dispatchEvent(new Event('change'));
  }


  function getSelectedValues(container) {
    if (!container || !container.querySelectorAll) return [];
    return Array.from(container.querySelectorAll('.toggle.selected')).map(el => el.dataset.value);
  }

  function getSelectedSet(container) {
    if (!container) return null;
    const vals = getSelectedValues(container);
    return vals.length ? new Set(vals) : null;
  }

  function getSelectedScopes() {
    const vals = getSelectedValues(els.scopeGroup);
    return vals.length ? vals : ['session','mergetree','format'];
  }

  function debounce(fn, delay) {
    let t = null;
    return function(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function updateTitleVersion() {
    if (!els.titleVersion || !els.versionSelect) return;
    const v = els.versionSelect.value || '';
    els.titleVersion.textContent = v ? `— ${v}` : '';
  }

  function applySavedTheme() {
    const saved = localStorage.getItem('theme');
    const theme = saved === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    if (els.themeToggle) els.themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    if (els.themeToggle) els.themeToggle.textContent = next === 'light' ? '☀️' : '🌙';
  }

  function buildDocsUrl(scope, name) {
    if (!name) return '';
    const anchor = String(name);
    if (scope === 'mergetree') {
      return `https://clickhouse.com/docs/operations/settings/merge-tree-settings#${anchor}`;
    }
    if (scope === 'format') {
      return `https://clickhouse.com/docs/operations/settings/formats#${anchor}`;
    }
    // default to session settings page
    return `https://clickhouse.com/docs/operations/settings/settings#${anchor}`;
  }

  return { init };
})();
