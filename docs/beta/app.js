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
  let lastApplyTopicFilter = null; // boolean: whether a unified topic filter was applied previously
  // Topics we don't want duplicated as filters because they are primary scopes
  const TOPIC_BLOCKLIST = new Set(['Formats', 'MergeTree', 'Session']);
  // Human-friendly explanations for relationship reasons
  const REASON_TIPS = {
    token_overlap: 'Names share meaningful tokens (same feature family).',
    min_max_pair: 'Pair of min_* and max_* parameters for the same feature.',
    initial_max_pair: 'Pair of initial_* and max_* parameters for the same feature.',
    bytes_rows_pair: 'Two variants of the same limit: *_bytes vs *_rows.',
    threads_pools: 'Threads and pools configuration that typically go together.',
    co_changed: 'Settings changed in the same release (co-change signal).',
    docs_comention: 'Settings co-mentioned together in ClickHouse docs.',
  };

  function topicColorIndex(name) {
    if (!name) return 0;
    let h = 0;
    const s = String(name);
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return h % 7; // 7-color palette
  }

  // Cache for search tokens to avoid re-parsing on every filter call
  let __qCachedRaw = null;
  let __qCachedTokens = [];
  function getSearchTokens() {
    const raw = String(els.searchInput && els.searchInput.value || '').toLowerCase().trim();
    if (raw !== __qCachedRaw) {
      __qCachedRaw = raw;
      __qCachedTokens = parseQueryToTokens(raw);
    }
    return __qCachedTokens;
  }
  function topicColorClass(name) {
    return 'tc-' + topicColorIndex(name);
  }

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
    versions.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      els.versionSelect.appendChild(opt);
    });
    // Default to latest
    els.versionSelect.selectedIndex = 0;

    // Unified Topic toggles (Categories ∪ Subsystems)
    const cats = uniqueCategories(settings).filter(t => !TOPIC_BLOCKLIST.has(t));
    const subs = uniqueSubsystems(settings).filter(t => !TOPIC_BLOCKLIST.has(t));
    const topics = Array.from(new Set([...cats, ...subs])).sort((a,b)=>a.localeCompare(b));
    if (els.topicGroup) {
      const newScopes = getSelectedScopes();
      const prevScopes = lastScopes instanceof Set ? lastScopes : null;
      const isSuperset = !!(prevScopes && newScopes.length >= prevScopes.size && Array.from(prevScopes).every(v => newScopes.includes(v)) && newScopes.length > prevScopes.size);
      let sel = getSelectedSet(els.topicGroup);
      if (isSuperset && lastApplyTopicFilter === false) {
        sel = new Set(topics);
      }
      buildToggleGroup(
        els.topicGroup,
        topics.map(t => ({ value: t, label: t, extraClass: 'topic ' + topicColorClass(t) })),
        sel || new Set(topics)
      );
    }

    // Tier toggles
    const tiers = [
      { value: 'production', label: 'Production' },
      { value: 'beta', label: 'Beta' },
      { value: 'experimental', label: 'Experimental' },
    ];
    buildToggleGroup(els.tierGroup, tiers, getSelectedSet(els.tierGroup) || new Set(tiers.map(t => t.value)));
    applyGroupTooltips();
    // Build special toggles
    if (els.specialGroup) {
      buildToggleGroup(els.specialGroup, [
        { value: 'cloud', label: 'Cloud-only' },
        { value: 'refs', label: 'Blog / Release Notes' },
      ], getSelectedSet(els.specialGroup) || new Set());
    }
    try { updateFacetCounts(); } catch (e) { dlog('updateFacetCounts error', e); }
  }

  function renderList(updateFacets = true) {
    const version = els.versionSelect.value;
    const scopes = getSelectedScopes();
    const selectedTopics = new Set(getSelectedValues(els.topicGroup || { querySelectorAll: () => [] }));
    const qTokens = getSearchTokens();
    const selectedTiers = new Set(getSelectedValues(els.tierGroup));
    const specialSel = new Set(getSelectedValues(els.specialGroup || { querySelectorAll: () => [] }));
    const allTopicCount = (els.topicGroup && els.topicGroup.querySelectorAll) ? els.topicGroup.querySelectorAll('.toggle').length : 0;
    const applyTopicFilter = selectedTopics.size > 0 && selectedTopics.size < allTopicCount;
    const changedOnly = els.changedOnly.checked;

    const items = combinedDataset(scopes).filter(s => {
      // Filter by topic (category or subsystem)
      if (applyTopicFilter) {
        const cat = s.category || 'Uncategorized';
        const subs = (s._subsystems || s.subsystems || []);
        const ok = selectedTopics.has(cat) || subs.some(x => selectedTopics.has(x));
        if (!ok) return false;
      }
      // Cloud-only handled via Special pills
      // Filter by version presence
      if (!s.versions || !s.versions[version]) return false;
      // Filter by tier for selected version
      const vinfo = s.versions[version];
      const stier = vinfo?.tier || parseTierFromFlags(s.flags) || 'production';
      if (selectedTiers.size && !selectedTiers.has(stier)) return false;
      // Topic filter already applied above
      if (changedOnly && !vinfo?.changed_from_prev) return false;
      if (specialSel.has('cloud') && !s.cloud_only) return false;
      if (specialSel.has('refs')) {
        const md = s.mentions && (Array.isArray(s.mentions.docs) ? s.mentions.docs.length : 0);
        const mb = s.mentions && (Array.isArray(s.mentions.blogs) ? s.mentions.blogs.length : 0);
        if (!md && !mb) return false;
      }
      if (!qTokens.length) return true;
      return matchesQuery(s._hayLower, qTokens);
    });

    // Stats
    const allTiers = ['production','beta','experimental'];
    const tiersArr = Array.from(selectedTiers.values());
    const tierLabel = (tiersArr.length === 0 || tiersArr.length === allTiers.length) ? '' : ` — Tiers: ${tiersArr.join(', ')}`;
    const changedLabel = changedOnly ? ' — Changed' : '';
    const scopeNames = scopes.map(s => s === 'mergetree' ? 'MergeTree' : (s === 'format' ? 'Formats' : 'Session'));
    const scopeLabel = scopeNames.length ? ` — Scopes: ${scopeNames.join(', ')}` : '';
    const topicsLabel = applyTopicFilter ? ` — Topics: ${Array.from(selectedTopics).slice(0,3).join(', ')}${selectedTopics.size>3?'…':''}` : '';
    const specialBadges = [];
    if (specialSel.has('cloud')) specialBadges.push('Cloud-only');
    if (specialSel.has('refs')) specialBadges.push('Blogs/Release Notes');
    const specialLabel = specialBadges.length ? ` — ${specialBadges.join(' + ')}` : '';
    els.stats.textContent = `${items.length} settings — ${version}` + scopeLabel + topicsLabel + tierLabel + specialLabel + changedLabel;

    // Subsystem map removed to reduce clutter

    // Render
    const frag = document.createDocumentFragment();
    items.forEach(s => {
      const row = document.createElement('div');
      row.className = 'setting';
      try { row.id = 's-' + String(s.name).toLowerCase().replace(/[^a-z0-9_-]/g,'-'); } catch {}
      const def = s.versions[version]?.default ?? '';
      const stier = s.versions[version]?.tier || parseTierFromFlags(s.flags) || 'production';
      const history = s.history || [];
      // Use a short snippet for description to keep rendering fast
      const descFull = s.description || '';
      const descSnippet = descFull.substring(0, 240);
      const catName = s.category || 'Uncategorized';
      const catClass = 'v-' + String(catName).toLowerCase().replace(/[^a-z0-9_-]/g,'');
      const catColor = topicColorClass(catName);
      const docUrl = s.docs_url || buildDocsUrl(s._scope, s.name);
      const subsystems = (s._subsystems || s.subsystems || []);
      const subsFirst = subsystems.slice(0,1);
      const subsExtra = subsystems.length > 1 ? subsystems.length - 1 : 0;
      const subsHiddenCSV = subsystems.slice(1).join(', ').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/"/g,'&quot;');
      row.innerHTML = `
        <div class="h">
          <div class="name">${s.name}
            ${docUrl ? `<a class="doclink" href="${docUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open docs for ${s.name}" title="Open docs">🔗</a>` : ''}
            <button class="copylink" type="button" title="Copy link to this setting" aria-label="Copy link">⧉</button>
          </div>
          <div class="meta">
            <span class="chip">${s.type}</span>
            <span class="chip category topic ${catClass} ${catColor}">${catName}</span>
            <span class="chip scope">${s._scope === 'mergetree' ? 'MergeTree' : (s._scope === 'format' ? 'Formats' : 'Session')}</span>
            ${subsFirst.map(x => `<span class="chip subsys topic ${topicColorClass(x)}">${x}</span>`).join('')}
            ${subsExtra ? `<span class="chip subsys more">+${subsExtra}</span>` : ''}
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
            <div class="desc">${escapeHtml(descSnippet)}${descFull.length > 240 ? (docUrl ? ` <a class="ellipsis-link" href="${docUrl}" target="_blank" rel="noopener noreferrer" title="Open docs for ${s.name}">…</a>` : '…') : ''}</div>
          </details>
          ${history.length ? `<details><summary>Version history</summary>${history.map(h => `<div class="history-row"><span class="tag">${h.version_minor}</span> <code>${escapeHtml(h.new_default)}</code> — ${escapeHtml(h.comment)}</div>`).join('')}</details>` : ''}
        </div>
      `;
      // Copy-link handled via delegated click listener on the list container
      // Attach hidden subsystems list to "+N" chip for tooltip
      try {
        const more = row.querySelector('.chip.subsys.more');
        if (more) {
          const csv = (subsystems.slice(1).join(', ')).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
          more.setAttribute('data-hidden', csv);
          more.setAttribute('title', csv);
        }
      } catch {}
      // Expand details sections by default (Description, Version history)
      try { row.querySelectorAll('.body details').forEach(d => { d.open = true; }); } catch {}
      // Append enriched Related and Insights blocks if available
      try {
        const body = row.querySelector('.body');
        if (Array.isArray(s.related) && s.related.length) {
          const wrap = document.createElement('div');
          wrap.className = 'related';
          const title = document.createElement('span');
          title.className = 'rel-title';
          title.textContent = 'Related:';
          wrap.appendChild(title);
          s.related.slice(0,5).forEach(r => {
            if (!r || !r.name) return;
            const rid = 's-' + String(r.name).toLowerCase().replace(/[^a-z0-9_-]/g,'-');
            const a = document.createElement('a');
            a.className = 'chip link related-chip';
            a.href = '#' + rid;
            a.textContent = r.name;
            if (Array.isArray(r.reasons)) a.title = r.reasons.slice(0,3).join(', ');
            wrap.appendChild(a);
            if (Array.isArray(r.reasons)) {
              r.reasons.slice(0,2).forEach(rv => {
                const b = document.createElement('span');
                b.className = 'reason';
                b.textContent = rv;
                try { b.title = REASON_TIPS[rv] || rv; } catch {}
                wrap.appendChild(b);
              });
            }
          });
          body.appendChild(wrap);
        }
        if (s.mentions && (Array.isArray(s.mentions.docs) || Array.isArray(s.mentions.blogs))) {
          const det = document.createElement('details');
          const sum = document.createElement('summary');
          sum.textContent = 'Blogs & Release Notes';
          det.appendChild(sum);
          const docsList = Array.isArray(s.mentions.docs) ? s.mentions.docs.slice(0,2) : [];
          const blogList = Array.isArray(s.mentions.blogs) ? s.mentions.blogs.slice(0,2) : [];
          docsList.forEach(m => {
            const div = document.createElement('div');
            div.className = 'mention';
            const link = document.createElement('a');
            link.href = m.url || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Docs';
            const txt = document.createTextNode(' — ' + (m.excerpt || ''));
            div.appendChild(link);
            div.appendChild(txt);
            det.appendChild(div);
          });
          blogList.forEach(m => {
            const div = document.createElement('div');
            div.className = 'mention';
            const link = document.createElement('a');
            link.href = m.url || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = (m.title || 'Blog');
            div.appendChild(link);
            det.appendChild(div);
          });
          // Expand by default and ensure this section appears before the Related block
          det.open = true;
          const relNode = body.querySelector('.related');
          if (relNode) body.insertBefore(det, relNode); else body.appendChild(det);
        }
      } catch {}
      frag.appendChild(row);
    });
    els.list.innerHTML = '';
    els.list.appendChild(frag);
    try { attachSubsysChipTooltips(); } catch {}
    // Remember current state for next control rebuild
    try {
      lastScopes = new Set(scopes);
      lastApplyTopicFilter = applyTopicFilter;
    } catch {}
    if (updateFacets) {
      try { updateFacetCounts(); } catch (e) { dlog('updateFacetCounts error', e); }
    }

    // If a hash is present, try to focus the corresponding row
    try {
      const h = (window.location.hash || '').replace(/^#/, '');
      if (h) focusRowById(h);
    } catch {}
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
    els.scopeGroup.addEventListener('change', () => { renderControls(); renderList(); updateTitleVersion(); updateUrlFromState(); });
    els.versionSelect.addEventListener('change', () => { updateTitleVersion(); renderList(); updateUrlFromState(); });
    if (els.topicGroup) els.topicGroup.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    els.tierGroup.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    // Search: render list quickly without recomputing facet counts, then update counts after idle
    const quickList = debounce(() => { updateUrlFromState(); renderList(false); }, 80);
    const slowFacets = debounce(() => { renderList(true); }, 280);
    els.searchInput.addEventListener('input', () => { quickList(); slowFacets(); });
    if (els.cloudOnly) els.cloudOnly.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    if (els.changedOnly) els.changedOnly.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    const sg = el('specialGroup');
    if (sg) sg.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    const refs = el('referencesOnly');
    if (refs) refs.addEventListener('change', () => { renderList(); updateUrlFromState(); });
    // Focus search with '/'
    window.addEventListener('keydown', (ev) => {
      if (ev.key === '/' && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        const t = ev.target;
        const isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!isInput) {
          ev.preventDefault();
          try { els.searchInput.focus(); els.searchInput.select(); } catch {}
        }
      }
    });
    // React to hash navigation
    window.addEventListener('hashchange', () => {
      const h = (window.location.hash || '').replace(/^#/, '');
      if (h) focusRowById(h);
    });
    // Delegated click for copy-link buttons
    if (els.list) {
      els.list.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('.copylink');
        if (!btn) return;
        const row = btn.closest('.setting');
        if (!row || !row.id) return;
        ev.preventDefault();
        const base = String(window.location.href).split('#')[0];
        const url = `${base}#${row.id}`;
        const done = () => {
          const prev = btn.title;
          btn.title = 'Copied!';
          setTimeout(() => { try { btn.title = prev; } catch {} }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(done);
        } else {
          try { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch {}
          done();
        }
      });
    }
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
    els.topicGroup = el('topicGroup');
    els.topicAll = el('topicAll');
    els.topicNone = el('topicNone');
    els.tierGroup = el('tierGroup');
    els.searchInput = el('searchInput');
    els.list = el('list');
    els.stats = el('stats');
    els.cloudOnly = el('cloudOnly');
    els.changedOnly = el('changedOnly');
    els.specialGroup = el('specialGroup');

    // Theme setup
    applySavedTheme();
    els.themeToggle.addEventListener('click', toggleTheme);

    // Restore state from URL (q may be set before data load)
    try {
      const st = parseStateFromUrl();
      if (st.q) els.searchInput.value = st.q;
    } catch {}
    await loadData();
    renderControls();
    // Apply full state to controls before wiring events
    try {
      const st = parseStateFromUrl();
      // Version
      if (st.v && els.versionSelect && Array.from(els.versionSelect.options).some(o => o.value === st.v)) {
        els.versionSelect.value = st.v;
      }
      const applySet = (container, vals) => {
        if (!container || !Array.isArray(vals)) return;
        const set = new Set(vals);
        Array.from(container.querySelectorAll('.toggle')).forEach(b => {
          const sel = set.has(b.dataset.value);
          b.classList.toggle('selected', sel);
          b.setAttribute('aria-pressed', sel ? 'true' : 'false');
        });
      };
      if (st.scopes) applySet(els.scopeGroup, st.scopes);
      if (st.tiers) applySet(els.tierGroup, st.tiers);
      if (st.special) applySet(els.specialGroup, st.special);
      if (st.topics) applySet(els.topicGroup, st.topics);
      if (typeof st.changed === 'boolean' && els.changedOnly) {
        els.changedOnly.checked = !!st.changed;
      }
    } catch {}
    updateTitleVersion();
    if (els.topicAll && els.topicGroup) els.topicAll.addEventListener('click', () => setAllSelected(els.topicGroup, true));
    if (els.topicNone && els.topicGroup) els.topicNone.addEventListener('click', () => setAllSelected(els.topicGroup, false));
    attachEvents();
    renderList();
    updateUrlFromState();
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
      const norm = String(opt.value).toLowerCase().replace(/[^a-z0-9_-]/g,'');
      btn.className = 'toggle v-' + norm + (opt.extraClass ? (' ' + opt.extraClass) : '');
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
    // Attach rich tooltips to pills (Scope, Topic, Tier)
    attachPillTooltips(els.scopeGroup, (btn) => {
      const v = (btn.dataset.value || '').toLowerCase();
      const label = (btn.querySelector('.label')?.textContent || btn.textContent || '').trim();
      const cnt = Number((btn.querySelector('.count')?.textContent || '').trim() || '0');
      const desc = v === 'session' ? 'Session/query settings (system.settings)'
        : v === 'mergetree' ? 'MergeTree storage settings (table-level)'
        : v === 'format' ? 'Input/Output format settings'
        : '';
      const href = v === 'session' ? 'https://clickhouse.com/docs/operations/settings/settings'
        : v === 'mergetree' ? 'https://clickhouse.com/docs/operations/settings/merge-tree-settings'
        : v === 'format' ? 'https://clickhouse.com/docs/operations/settings/formats'
        : '';
      const link = href ? { href, label: 'Open docs' } : null;
      const meta = [desc, cnt ? `${cnt} setting${cnt===1?'':'s'}` : ''].filter(Boolean).join('<br>');
      return { title: `Scope: ${label}`, meta, link };
    });
    attachPillTooltips(els.topicGroup, (btn) => {
      const name = btn.dataset.value;
      const cnt = Number(btn.getAttribute('data-count') || '0');
      const ex = btn.getAttribute('data-examples') || '';
      const classes = Array.from(btn.classList).filter(c => /^tc-\d+$/.test(c));
      return { title: `Topic: ${name}`, meta: `${cnt} setting${cnt===1?'':'s'}`, examples: ex, classes: ['topic', ...classes] };
    });
    const tierDoc = 'https://clickhouse.com/docs/beta-and-experimental-features';
    attachPillTooltips(els.tierGroup, (btn) => {
      const v = (btn.dataset.value || '').toLowerCase();
      const label = (btn.querySelector('.label')?.textContent || btn.textContent || '').trim();
      const cnt = Number((btn.querySelector('.count')?.textContent || '').trim() || '0');
      const desc = v === 'production' ? 'Safe with other production features'
        : v === 'beta' ? 'Stable but interactions may be unknown'
        : v === 'experimental' ? 'In active development'
        : '';
      const meta = [desc, cnt ? `${cnt} setting${cnt===1?'':'s'}` : ''].filter(Boolean).join('<br>');
      return { title: `Tier: ${label}`, meta, link: { href: tierDoc, label: 'About Beta & Experimental' } };
    });
    // Special pills: Cloud-only and Blog/Release Notes
    attachPillTooltips(els.specialGroup, (btn) => {
      const v = (btn.dataset.value || '').toLowerCase();
      const desc = v === 'cloud' ? 'Settings that only take effect in ClickHouse Cloud'
        : v === 'refs' ? 'Settings mentioned in docs or official release/blog posts'
        : '';
      return { title: `Special: ${btn.textContent}`, meta: desc };
    });
  }

  // Global custom tooltip
  let tooltipEl = null;
  let tooltipHideTimer = null;
  let tooltipShowTimer = null;
  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'tooltip';
      tooltipEl.style.display = 'none';
      document.body.appendChild(tooltipEl);
      // Keep tooltip visible while mouse is over it
      tooltipEl.addEventListener('mouseenter', () => {
        if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
      });
      tooltipEl.addEventListener('mouseleave', () => {
        scheduleHideTooltip(200);
      });
    }
    return tooltipEl;
  }
  function showTooltipNear(el, content, extraClasses=[]) {
    const t = ensureTooltip();
    t.className = 'tooltip ' + extraClasses.join(' ');
    t.innerHTML = content;
    t.style.display = 'block';
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - t.offsetWidth - 12, r.left + window.scrollX + 8);
    const y = r.bottom + window.scrollY + 8;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }
  function scheduleHideTooltip(delayMs) {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    tooltipHideTimer = setTimeout(() => { hideTooltip(); tooltipHideTimer = null; }, delayMs);
  }
  function cancelHideTooltip() {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  }
  function scheduleShowTooltip(btn, builder, delayMs = 500) {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
    tooltipShowTimer = setTimeout(() => {
      try {
        const info = builder(btn) || {};
        const metaLine = info.meta ? `<div class=\"meta\">${info.meta}</div>` : '';
        const linkLine = (info.link && info.link.href) ? `<div class=\"meta\"><a href=\"${info.link.href}\" target=\"_blank\" rel=\"noopener noreferrer\">${info.link.label || 'Open docs'}</a></div>` : '';
        const exLine = info.examples ? `<div class=\"ex\">Examples: ${info.examples}</div>` : '';
        const hint = `<div class=\"hint\">Alt/⌥ or Cmd/⌘ or Shift-click: only this — Esc to close</div>`;
        const html = `<div class=\"h\">${info.title || ''}</div>${metaLine}${linkLine}${exLine}${hint}`;
        showTooltipNear(btn, html, info.classes || []);
      } catch {}
      tooltipShowTimer = null;
    }, delayMs);
  }
  function cancelShowTooltip() {
    if (tooltipShowTimer) { clearTimeout(tooltipShowTimer); tooltipShowTimer = null; }
  }
  function attachPillTooltips(container, builder) {
    if (!container) return;
    const pills = Array.from(container.querySelectorAll('.toggle'));
    pills.forEach(btn => {
      if (btn.hasAttribute('title')) btn.removeAttribute('title');
      btn.addEventListener('mouseenter', () => { cancelHideTooltip(); scheduleShowTooltip(btn, builder, 100); });
      btn.addEventListener('mouseleave', () => { cancelShowTooltip(); scheduleHideTooltip(250); });
      btn.addEventListener('click', () => { cancelShowTooltip(); hideTooltip(); });
    });
  }

  // Show full list of hidden subsystems when hovering "+N" chip
  function attachSubsysChipTooltips() {
    if (!els.list) return;
    const chips = Array.from(els.list.querySelectorAll('.chip.subsys.more'));
    chips.forEach(chip => {
      // Leave native title as fallback but prefer custom tooltip
      chip.addEventListener('mouseenter', () => {
        cancelHideTooltip();
        const raw = chip.getAttribute('data-hidden') || '';
        const names = raw.split(/\s*,\s*/).filter(Boolean);
        const html = `<div class=\"h\">More topics</div>` +
          (names.length ? `<div class=\"ex\">${names.join(', ')}</div>` : '') +
          `<div class=\"hint\">Hover to copy — Esc to close</div>`;
        showTooltipNear(chip, html, []);
      });
      chip.addEventListener('mouseleave', () => scheduleHideTooltip(250));
      chip.addEventListener('click', hideTooltip);
    });
  }

  // Allow closing tooltip with Escape key
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      cancelHideTooltip();
      hideTooltip();
    }
  });

  // Facet counts on selectors (scope, topics, tier)
  function passFilters(s, opts = {}) {
    const version = els.versionSelect.value;
    const cloudOnly = false; // cloud-only filtering handled via Special pills
    const changedOnly = els.changedOnly.checked;
    const qTokens = getSearchTokens();
    const selectedTiers = new Set(getSelectedValues(els.tierGroup));
    const selectedTopics = new Set(getSelectedValues(els.topicGroup || { querySelectorAll: () => [] }));
    const allTopicCount = (els.topicGroup && els.topicGroup.querySelectorAll) ? els.topicGroup.querySelectorAll('.toggle').length : 0;
    const applyTopicFilter = selectedTopics.size > 0 && selectedTopics.size < allTopicCount;

    // Version presence
    if (!s.versions || !s.versions[version]) return false;

    const vinfo = s.versions[version];
    const stier = vinfo?.tier || parseTierFromFlags(s.flags) || 'production';

    // cloudOnly handled via Special pills
    if (!opts.ignoreTier && selectedTiers.size && !selectedTiers.has(stier)) return false;
    if (!opts.ignoreTopics && applyTopicFilter) {
      const cat = s.category || 'Uncategorized';
      const subs = (s._subsystems || s.subsystems || []);
      if (!(selectedTopics.has(cat) || subs.some(x => selectedTopics.has(x)))) return false;
    }
    if (changedOnly && !vinfo?.changed_from_prev) return false;
    if (!matchesQuery(s._hayLower, qTokens)) return false;
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

    // Topic counts
    const currentScopes = getSelectedScopes();
    const itemsInScopes = combinedDataset(currentScopes);
    const topicCount = new Map();
    for (const s of itemsInScopes) {
      if (!passFilters(s, { ignoreTopics: true })) continue;
      const cat = s.category || 'Uncategorized';
      if (!TOPIC_BLOCKLIST.has(cat)) {
        topicCount.set(cat, (topicCount.get(cat)||0)+1);
      }
      (s._subsystems || s.subsystems || []).forEach(x => {
        if (!TOPIC_BLOCKLIST.has(x)) topicCount.set(x, (topicCount.get(x)||0)+1);
      });
    }
    if (els.topicGroup) {
      const topics = Array.from(new Set(itemsInScopes.flatMap(s => {
        const arr = [];
        const cat = s.category || 'Uncategorized';
        if (!TOPIC_BLOCKLIST.has(cat)) arr.push(cat);
        for (const x of (s._subsystems || s.subsystems || [])) {
          if (!TOPIC_BLOCKLIST.has(x)) arr.push(x);
        }
        return arr;
      }))).sort((a,b)=>a.localeCompare(b));
      const prevVals = getSelectedValues(els.topicGroup);
      const prevAllCount = els.topicGroup.querySelectorAll ? els.topicGroup.querySelectorAll('.toggle').length : 0;
      const prevAll = prevVals.length === prevAllCount && prevAllCount > 0;
      const prevNone = prevVals.length === 0 && prevAllCount > 0;
      let topicSel;
      if (prevAll) topicSel = new Set(topics);
      else if (prevNone) topicSel = new Set();
      else {
        const prevSet = new Set(prevVals);
        topicSel = new Set(topics.filter(x => prevSet.has(x)));
        if (topicSel.size === 0 && topics.length > 0) topicSel = new Set(topics);
      }
      buildToggleGroup(els.topicGroup, topics.map(t => ({ value: t, label: t, count: topicCount.get(t)||0, extraClass: 'topic ' + topicColorClass(t) })), topicSel);
      // Add counts/examples as data-* for tooltips
      const btns = Array.from(els.topicGroup.querySelectorAll('.toggle'));
      const examplesByTopic = new Map();
      // Build examples list per topic (up to 3 names)
      for (const t of topics) {
        const ex = [];
        for (const s of itemsInScopes) {
          if (!passFilters(s, { ignoreTopics: true })) continue;
          const cat = s.category || 'Uncategorized';
          const subs = (s._subsystems || s.subsystems || []);
          if (cat === t || subs.includes(t)) {
            ex.push(s.name);
            if (ex.length >= 3) break;
          }
        }
        examplesByTopic.set(t, ex.join(', '));
      }
      btns.forEach(btn => {
        const name = btn.dataset.value;
        const cnt = topicCount.get(name) || 0;
        btn.setAttribute('data-count', String(cnt));
        const ex = examplesByTopic.get(name) || '';
        if (ex) btn.setAttribute('data-examples', ex);
      });
    }

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
    // Special pills: do not recompute with counts here; keep selection from renderControls
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

  // Parse search query into tokens: quoted phrases or space-separated words (AND semantics)
  function parseQueryToTokens(qraw) {
    const q = String(qraw || '').toLowerCase().trim();
    if (!q) return [];
    const toks = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      const tok = (m[1] || m[2] || '').trim();
      if (tok) toks.push(tok);
    }
    return toks;
  }
  function matchesQuery(hayLower, tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return true;
    const hay = String(hayLower || '');
    for (const t of tokens) {
      if (!hay.includes(t)) return false;
    }
    return true;
  }

  function updateTitleVersion() {
    if (!els.titleVersion || !els.versionSelect) return;
    const v = els.versionSelect.value || '';
    els.titleVersion.textContent = v ? `— ${v}` : '';
  }

  // Highlight and scroll to a row by element id (e.g., 's-setting_name')
  function focusRowById(id) {
    if (!id) return false;
    const node = document.getElementById(id);
    if (!node) return false;
    try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { node.scrollIntoView({ block: 'center' }); }
    try {
      node.classList.add('highlight');
      setTimeout(() => { try { node.classList.remove('highlight'); } catch {} }, 1600);
    } catch {}
    return true;
  }

  // Parse full filter state from URL
  function parseStateFromUrl() {
    const out = {};
    try {
      const sp = new URL(window.location.href).searchParams;
      const getList = (k) => {
        const v = sp.get(k);
        if (!v) return null;
        return v.split(',').map(s => s.trim()).filter(Boolean);
      };
      out.q = sp.get('q') || '';
      out.v = sp.get('v') || '';
      out.scopes = getList('scopes');
      out.topics = getList('topics');
      out.tiers = getList('tiers');
      out.special = getList('special');
      out.changed = sp.get('changed') === '1';
    } catch {}
    return out;
  }

  // Write full filter state to URL (preserve hash)
  function updateUrlFromState() {
    try {
      const url = new URL(window.location.href);
      const setList = (k, arr) => {
        if (Array.isArray(arr) && arr.length) url.searchParams.set(k, arr.join(','));
        else url.searchParams.delete(k);
      };
      const q = (els.searchInput && els.searchInput.value) || '';
      if (q && q.trim()) url.searchParams.set('q', q.trim()); else url.searchParams.delete('q');
      const v = (els.versionSelect && els.versionSelect.value) || '';
      if (v) url.searchParams.set('v', v); else url.searchParams.delete('v');
      setList('scopes', getSelectedValues(els.scopeGroup));
      setList('topics', getSelectedValues(els.topicGroup || { querySelectorAll: () => [] }));
      setList('tiers', getSelectedValues(els.tierGroup));
      setList('special', getSelectedValues(els.specialGroup || { querySelectorAll: () => [] }));
      const changed = !!(els.changedOnly && els.changedOnly.checked);
      if (changed) url.searchParams.set('changed', '1'); else url.searchParams.delete('changed');
      const next = url.toString();
      if (next !== window.location.href) window.history.replaceState(null, '', next);
    } catch {}
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
