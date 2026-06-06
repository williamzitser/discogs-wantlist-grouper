// popup.js

const CACHE_KEY = 'dg_cache';
const CACHE_TTL = 30 * 60 * 1000;

let scanning = false;

// ─── Condition grades ─────────────────────────────────────────────────────────

const CONDITION_GRADES = [
  { label: 'Mint (M)',             abbr: 'M'   },
  { label: 'Near Mint (NM or M-)', abbr: 'NM'  },
  { label: 'VG+',                  abbr: 'VG+' },
  { label: 'VG',                   abbr: 'VG'  },
  { label: 'Good Plus (G+)',       abbr: 'G+'  },
  { label: 'Good (G)',             abbr: 'G'   },
  { label: 'Fair (F)',             abbr: 'F'   },
  { label: 'Poor (P)',             abbr: 'P'   },
];

// ─── Country list: US + UK pinned first, then alphabetical ───────────────────

const PINNED_COUNTRIES = ['United States', 'United Kingdom'];

const OTHER_COUNTRIES = [
  'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil',
  'Canada', 'Chile', 'China', 'Colombia', 'Croatia',
  'Czech Republic', 'Denmark', 'Finland', 'France', 'Germany',
  'Greece', 'Hong Kong', 'Hungary', 'India', 'Indonesia',
  'Ireland', 'Israel', 'Italy', 'Japan', 'Malaysia',
  'Mexico', 'Netherlands', 'New Zealand', 'Norway', 'Philippines',
  'Poland', 'Portugal', 'Romania', 'Russia', 'Serbia',
  'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea',
  'Spain', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand',
  'Turkey', 'Ukraine', 'Uruguay',
];

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  buildConditionCheckboxes();
  buildCountryCheckboxes();

  document.getElementById('btn-scan').addEventListener('click', startScan);
  document.getElementById('btn-clear').addEventListener('click', clearCache);
  document.getElementById('btn-retry').addEventListener('click', () => showState('idle'));
  document.getElementById('btn-back').addEventListener('click', () => showState('idle'));

  // Progress messages streamed from the content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progress') updateProgress(msg.current, msg.total, msg.title);
  });

  // Open all links in a background tab so the popup stays open.
  // active:false prevents focus from shifting to the new tab, which is what
  // causes Chrome to close the popup.
  document.addEventListener('click', e => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const url = link.href;
    if (!url || !url.startsWith('http')) return;
    e.preventDefault();
    chrome.tabs.create({ url, active: false });
  });

  // Restore saved filter state.
  await restoreFilterState();

  // If a scan is already running (popup was closed and reopened mid-scan),
  // show the loading UI and wait for it to finish instead of the start screen.
  const resuming = await maybeResumeScan();
  if (!resuming) await loadAndDisplayCache();
});

// ─── Filter UI setup (runs once on load) ─────────────────────────────────────

function buildConditionCheckboxes() {
  const container = document.getElementById('condition-checks');
  CONDITION_GRADES.forEach(({ label, abbr }) =>
    container.appendChild(makeCheckbox('cond', abbr, label, false))
  );
  wireToggleAll('conditions', 'condition-checks', 'cond');
}

function buildCountryCheckboxes() {
  const container = document.getElementById('country-checks');

  // Pinned countries first
  PINNED_COUNTRIES.forEach(c =>
    container.appendChild(makeCheckbox('country', c, c, false))
  );

  // Visual divider
  const divider = document.createElement('div');
  divider.className = 'check-divider';
  container.appendChild(divider);

  // Remaining countries alphabetically
  OTHER_COUNTRIES.forEach(c =>
    container.appendChild(makeCheckbox('country', c, c, false))
  );

  wireToggleAll('countries', 'country-checks', 'country');
}

function makeCheckbox(name, value, label, checked) {
  const wrap = document.createElement('label');
  wrap.className = 'check-label';
  wrap.innerHTML =
    `<input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}> ` +
    `<span>${esc(label)}</span>`;
  return wrap;
}

function wireToggleAll(groupName, containerId, checkboxName) {
  const btn = document.querySelector(`.filter-toggle-all[data-target="${groupName}"]`);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const boxes = document.querySelectorAll(`#${containerId} input[name="${checkboxName}"]`);
    const anyChecked = [...boxes].some(b => b.checked);
    // If any are checked, clear all; otherwise check all
    boxes.forEach(b => { b.checked = !anyChecked; });
    btn.textContent = anyChecked ? 'Select all' : 'Deselect all';
    btn.dataset.state = anyChecked ? 'none' : 'all';
  });
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function startScan() {
  if (scanning) return;
  scanning = true;

  showState('loading');
  updateProgress(0, 100, 'Locating Discogs tab…');
  document.getElementById('btn-scan').disabled = true;
  await saveFilterState(); // persist selections so they survive popup close/reopen

  try {
    const tab = await getDiscogsTab();
    if (!tab) {
      showError('No Discogs tab found. Open discogs.com in a tab and try again.');
      return;
    }

    const alive = await pingContentScript(tab.id);
    if (!alive) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await sleep(300);
      } catch (e) {
        showError('Could not inject script into the Discogs tab. Try refreshing it.');
        return;
      }
    }

    const response = await sendTabMessage(tab.id, { action: 'scan', force: true }, 600_000);

    if (!response?.ok) {
      showError(response?.error || 'Unknown error during scan.');
    } else {
      // Re-read from the cache that was just written rather than using the
      // in-memory response object directly — this guarantees the same rendering
      // path as reopening the popup and eliminates the timing inconsistency.
      await loadAndDisplayCache();
    }

  } catch (err) {
    showError('Scan failed: ' + err.message);
  } finally {
    scanning = false;
    document.getElementById('btn-scan').disabled = false;
  }
}

async function clearCache() {
  chrome.storage.local.remove(CACHE_KEY, () => {
    showState('idle');
    showToast('Cache cleared.');
  });
}

// ─── Tab / Messaging ──────────────────────────────────────────────────────────

function getDiscogsTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://www.discogs.com/*' }, tabs => resolve(tabs[0] || null));
  });
}

function pingContentScript(tabId) {
  return sendTabMessage(tabId, { action: 'ping' }, 1500).then(r => !!r?.alive).catch(() => false);
}

function sendTabMessage(tabId, message, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Scan timed out')), timeout);
    chrome.tabs.sendMessage(tabId, message, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// ─── Filter persistence ───────────────────────────────────────────────────────

function saveFilterState() {
  const checkedConditions = [...document.querySelectorAll('#condition-checks input:checked')].map(b => b.value);
  const checkedCountries  = [...document.querySelectorAll('#country-checks  input:checked')].map(b => b.value);
  const currency          = document.getElementById('filter-currency').value;
  return new Promise(resolve =>
    chrome.storage.local.set({ dg_filters: { checkedConditions, checkedCountries, currency } }, resolve)
  );
}

async function restoreFilterState() {
  return new Promise(resolve => {
    chrome.storage.local.get('dg_filters', r => {
      const f = r.dg_filters;
      if (!f) return resolve();

      // Restore condition checkboxes
      document.querySelectorAll('#condition-checks input').forEach(cb => {
        cb.checked = f.checkedConditions.includes(cb.value);
      });

      // Restore country checkboxes
      document.querySelectorAll('#country-checks input').forEach(cb => {
        cb.checked = f.checkedCountries.includes(cb.value);
      });

      // Restore currency dropdown
      const currEl = document.getElementById('filter-currency');
      if (currEl && f.currency !== undefined) currEl.value = f.currency;

      // Sync toggle-all button labels to match restored state
      syncToggleAll('conditions', 'condition-checks', 'cond');
      syncToggleAll('countries',  'country-checks',   'country');

      resolve();
    });
  });
}

// Update a toggle-all button's label to reflect current checkbox state
function syncToggleAll(groupName, containerId, checkboxName) {
  const btn = document.querySelector(`.filter-toggle-all[data-target="${groupName}"]`);
  if (!btn) return;
  const anyChecked = document.querySelectorAll(`#${containerId} input[name="${checkboxName}"]:checked`).length > 0;
  btn.textContent   = anyChecked ? 'Deselect all' : 'Select all';
  btn.dataset.state = anyChecked ? 'all' : 'none';
}

// ─── Cache ────────────────────────────────────────────────────────────────────

async function loadAndDisplayCache() {
  return new Promise(resolve => {
    chrome.storage.local.get(CACHE_KEY, r => {
      const c = r[CACHE_KEY];
      if (c && Date.now() - c.ts < CACHE_TTL) {
        displayResults(c.data, true, c.ts);
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// If a scan was running when the popup was closed, restore the loading UI and
// wait for the content script to signal completion via storage.
async function maybeResumeScan() {
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(['dg_scanning', 'dg_scan_progress'], resolve)
  );
  if (!stored.dg_scanning) return false;

  // Show the loading screen with the last-known progress position.
  showState('loading');
  const p = stored.dg_scan_progress || {};
  updateProgress(p.current || 0, p.total || 0, p.label || 'Scanning…');

  // The content script removes dg_scanning from storage when it finishes
  // (or errors). Listen for that change and update the UI accordingly.
  const onScanDone = (changes, area) => {
    if (area !== 'local' || !('dg_scanning' in changes)) return;
    chrome.storage.onChanged.removeListener(onScanDone);
    // newValue is undefined when the key is removed (scan finished/failed).
    loadAndDisplayCache().then(found => {
      if (!found) showState('idle');
    });
  };
  chrome.storage.onChanged.addListener(onScanDone);

  return true;
}

// ─── UI State ─────────────────────────────────────────────────────────────────

function showState(name) {
  ['idle', 'loading', 'error', 'results'].forEach(s =>
    document.getElementById(`state-${s}`).classList.toggle('hidden', s !== name)
  );
}

function updateProgress(current, total, title) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent =
    current === 0 ? (title || 'Starting…') : `Scanning ${current} / ${total} — ${trunc(title, 44)}`;
}

function showError(msg) {
  showState('error');
  document.getElementById('error-msg').textContent = msg;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── Results ──────────────────────────────────────────────────────────────────

function displayResults(data, fromCache, scannedAt) {
  showState('results');

  // Apply the current pre-scan filter settings to the raw data
  const sellers = applyFiltersToData(data.sellers);
  const { stats } = data;
  const totalSellers = data.sellers.length; // all sellers scraped, before 2+ threshold

  document.getElementById('stats-bar').innerHTML =
    `Scanned <strong>${stats.scanned}</strong> of ${stats.wantlistTotal} wants &middot; ` +
    `<strong>${stats.listingsFound}</strong> listing${stats.listingsFound !== 1 ? 's' : ''} across ` +
    `<strong>${totalSellers}</strong> seller${totalSellers !== 1 ? 's' : ''} &middot; ` +
    `<strong>${sellers.length}</strong> with 2+ wants` +
    (fromCache ? ` <span class="cache-tag">cached ${timeAgo(scannedAt)}</span>` : '');

  renderSellers(sellers);
}

// ─── Filter application (runs once at display time) ──────────────────────────

function applyFiltersToData(allSellers) {
  const { condSet, countrySet, currency } = getCurrentFilters();

  // Normalise country filter set to lowercase+trimmed for fuzzy matching
  const countrySetNorm = countrySet
    ? new Set([...countrySet].map(c => c.trim().toLowerCase()))
    : null;

  return allSellers
    .map(seller => {
      const records = seller.records.filter(r => {
        const normCond    = normalizeCondition(r.mediaCondition);
        const normCountry = (r.shipsFrom || '').trim().toLowerCase();

        // If the scraped value is empty/unknown, don't penalise — let it through.
        const condPass    = !condSet        || !normCond    || condSet.has(normCond);
        const countryPass = !countrySetNorm || !normCountry || countrySetNorm.has(normCountry);
        const currPass    = !currency       || !r.currency  || r.currency === currency;

        return condPass && countryPass && currPass;
      });
      const totalPrice = records.reduce((sum, r) => sum + (r.price || 0), 0);
      return { ...seller, records, count: records.length, totalPrice };
    })
    .filter(s => s.count >= 2)
    .sort((a, b) => b.count !== a.count ? b.count - a.count : a.totalPrice - b.totalPrice);
}

function getCurrentFilters() {
  // Any checked boxes = "restrict to these grades/countries"
  // No boxes checked  = no filter (show everything)
  const checkedConds     = [...document.querySelectorAll('#condition-checks input:checked')].map(b => b.value);
  const condSet          = checkedConds.length > 0 ? new Set(checkedConds) : null;

  const checkedCountries = [...document.querySelectorAll('#country-checks input:checked')].map(b => b.value);
  const countrySet       = checkedCountries.length > 0 ? new Set(checkedCountries) : null;

  const currency         = document.getElementById('filter-currency')?.value || null;

  return { condSet, countrySet, currency };
}

// Map raw condition strings → grade abbreviations used on checkboxes
function normalizeCondition(str) {
  if (!str) return '';
  const s = str.trim();
  // "Near Mint (NM or M-)" → extract from parens → "NM"
  const m = s.match(/\(([^)]+)\)$/);
  if (m) return m[1].split(/\s+or\s+/i)[0].trim();
  if (s === 'M-') return 'NM';
  return s;
}

// ─── Seller / Record Rendering ────────────────────────────────────────────────

function renderSellers(sellers) {
  const container = document.getElementById('sellers-container');
  container.innerHTML = '';

  if (!sellers.length) {
    container.innerHTML = '<p class="empty">No sellers matched your filters. Try adjusting them and scanning again.</p>';
    return;
  }

  sellers.forEach((seller, i) => container.appendChild(buildSellerCard(seller, i + 1)));
}

function buildSellerCard(seller, rank) {
  const card = document.createElement('div');
  card.className = 'seller-card';

  const totalStr = seller.totalPrice > 0 ? `$${seller.totalPrice.toFixed(2)}` : 'N/A';

  card.innerHTML = `
    <div class="seller-header">
      <div class="rank">#${rank}</div>
      <div class="seller-info">
        <a href="${esc(seller.storeUrl)}" class="seller-name" target="_blank">${esc(seller.username)}</a>
        <div class="seller-badges">
          <span class="badge badge-count">${seller.count} record${seller.count !== 1 ? 's' : ''}</span>
          <span class="badge badge-price">~${totalStr} est. total</span>
        </div>
      </div>
      <button class="toggle-btn" aria-expanded="true" aria-label="Hide records">&#9650;</button>
    </div>
    <div class="record-list">
      ${seller.records.map(buildRecordRow).join('')}
    </div>
  `;

  const toggle = card.querySelector('.toggle-btn');
  const list   = card.querySelector('.record-list');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.innerHTML = open ? '&#9660;' : '&#9650;';
    list.classList.toggle('hidden', open);
  });

  return card;
}

function buildRecordRow(r) {
  const mediaCond = r.mediaCondition || '';
  const meta = [r.priceDisplay || 'N/A', r.shipsFrom].filter(Boolean).join(' · ');
  return `
    <div class="record-row">
      <div class="record-main">
        <a href="${esc(r.listingUrl)}" class="record-title" target="_blank">${esc(r.title || 'Untitled')}</a>
        <span class="record-artist">${esc(r.artist || '—')}</span>
      </div>
      <div class="record-aside">
        <span class="record-price">${esc(meta)}</span>
        ${mediaCond ? `<span class="record-cond" title="Media Condition">${esc(mediaCond)}</span>` : ''}
      </div>
    </div>
  `;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(str, max) {
  return str && str.length > max ? str.slice(0, max) + '…' : (str || '');
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
