'use strict';

window.SettingsApp = (() => {
  let data = null;
  const els = {};

  function el(id) { return document.getElementById(id); }

  function fmtDefault(v) {
    return v ?? '';
  }

  function uniqueCategories(settings) {
    const set = new Set();
    settings.forEach(s => set.add(s.category || 'Uncategorized'));
    return Array.from(set).sort((a,b) => a.localeCompare(b));
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
  }

  function renderList() {
    const version = els.versionSelect.value;
    const scopes = getSelectedScopes();
    const categories = getSelectedValues(els.categoryGroup);
    const q = els.searchInput.value.trim().toLowerCase();
    const selectedTiers = new Set(getSelectedValues(els.tierGroup));
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
    els.stats.textContent = `${items.length} settings — ${version}` + scopeLabel + catLabel + tierLabel + (cloudOnly ? ' — Cloud-only' : '') + changedLabel;

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
      row.innerHTML = `
        <div class="h">
          <div class="name">${s.name}
            ${docUrl ? `<a class="doclink" href="${docUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open docs for ${s.name}" title="Open docs">🔗</a>` : ''}
          </div>
          <div class="meta">
            <span class="chip">${s.type}</span>
            <span class="chip category ${catClass}">${catName}</span>
            <span class="chip scope">${s._scope === 'mergetree' ? 'MergeTree' : (s._scope === 'format' ? 'Formats' : 'Session')}</span>
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
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  }

  function attachEvents() {
    els.scopeGroup.addEventListener('change', () => { renderControls(); renderList(); updateTitleVersion(); });
    els.versionSelect.addEventListener('change', () => { updateTitleVersion(); renderList(); });
    els.categoryGroup.addEventListener('change', renderList);
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
    // Precompute lowercase haystacks for faster search
    const enrich = (arr, scope) => {
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        s._scope = scope || s._scope; // ensure scope if not set by combinedDataset
        s._hayLower = `${s.name} ${s.description || ''}`.toLowerCase();
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
    els.categoryGroup = el('categoryGroup');
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

  function buildToggleGroup(container, options, selectedSet) {
    container.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toggle v-' + String(opt.value).toLowerCase().replace(/[^a-z0-9_-]/g,'');
      if (selectedSet && selectedSet.has(opt.value)) btn.classList.add('selected');
      btn.textContent = opt.label;
      btn.dataset.value = opt.value;
      btn.setAttribute('aria-pressed', selectedSet && selectedSet.has(opt.value) ? 'true' : 'false');
      btn.addEventListener('click', () => {
        btn.classList.toggle('selected');
        btn.setAttribute('aria-pressed', btn.classList.contains('selected') ? 'true' : 'false');
        // Notify listeners
        container.dispatchEvent(new Event('change'));
      });
      container.appendChild(btn);
    }
  }

  function getSelectedValues(container) {
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
