// content.js — runs on every discogs.com page

// Guard against double-injection when popup calls executeScript as a fallback
if (!window.__discogsGrouperLoaded) {
  window.__discogsGrouperLoaded = true;
  initDiscogsGrouper();
}

function initDiscogsGrouper() {
  console.log('[DiscogsGrouper] Content script ready on', window.location.href);

  const BASE = 'https://www.discogs.com';
  const DELAY_MS = 1000;
  const MAX_ITEMS = 50;
  const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  const CACHE_KEY = 'dg_cache';

  // ─── Message Listener ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log('[DiscogsGrouper] Message:', msg.action);

    if (msg.action === 'ping') {
      sendResponse({ alive: true });
      return false;
    }

    if (msg.action === 'scan') {
      performScan(sendResponse, msg.force === true);
      return true; // keep channel open for async
    }

    if (msg.action === 'clearCache') {
      chrome.storage.local.remove(CACHE_KEY, () => sendResponse({ ok: true }));
      return true;
    }
  });

  // ─── Orchestration ───────────────────────────────────────────────────────

  async function performScan(sendResponse, force = false) {
    try {
      if (!force) {
        const cached = await loadCache();
        if (cached) {
          console.log('[DiscogsGrouper] Serving cache from', new Date(cached.ts).toLocaleTimeString());
          sendResponse({ ok: true, data: cached.data, fromCache: true, cachedAt: cached.ts });
          return;
        }
      } else {
        console.log('[DiscogsGrouper] Force-scan requested, bypassing cache');
      }

      sendProgress(0, MAX_ITEMS, 'Fetching wantlist…');
      const wantlistItems = await fetchAllWantlistItems();

      if (!wantlistItems.length) {
        sendResponse({ ok: false, error: 'No wantlist items found. Make sure you are logged into Discogs.' });
        return;
      }

      const toScan = wantlistItems.slice(0, MAX_ITEMS);
      console.log(`[DiscogsGrouper] Wantlist has ${wantlistItems.length} items; scanning ${toScan.length}`);

      const allListings = [];
      for (let i = 0; i < toScan.length; i++) {
        const item = toScan[i];
        sendProgress(i + 1, toScan.length, item.title);
        console.log(`[DiscogsGrouper] [${i + 1}/${toScan.length}] ${item.title} (release ${item.releaseId})`);

        try {
          const listings = await fetchMarketplaceListings(item.releaseId);
          listings.forEach(l => allListings.push({ ...l, release: item }));
          console.log(`[DiscogsGrouper]   → ${listings.length} seller listing(s)`);
        } catch (e) {
          console.warn(`[DiscogsGrouper]   → Skipping (${e.message})`);
        }

        if (i < toScan.length - 1) await sleep(DELAY_MS);
      }

      const sellers = groupAndRank(allListings);
      const data = {
        sellers,
        stats: {
          wantlistTotal: wantlistItems.length,
          scanned: toScan.length,
          listingsFound: allListings.length,
          sellersFound: sellers.length,
        },
        scannedAt: Date.now(),
      };

      await saveCache(data);
      sendResponse({ ok: true, data, fromCache: false });

    } catch (err) {
      console.error('[DiscogsGrouper] Fatal error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  }

  function sendProgress(current, total, title) {
    try {
      chrome.runtime.sendMessage({ action: 'progress', current, total, title });
    } catch (_) {
      // Popup may have closed; ignore
    }
  }

  // ─── Wantlist Fetching ───────────────────────────────────────────────────

  async function fetchAllWantlistItems() {
    const items = [];
    let page = 1;
    let totalPages = 1;

    while (items.length < MAX_ITEMS) {
      const result = await fetchWantlistPage(page);
      items.push(...result.items);
      totalPages = result.totalPages;
      console.log(`[DiscogsGrouper] Wantlist page ${page}/${totalPages}: ${result.items.length} items`);

      if (page >= totalPages || result.items.length === 0) break;
      page++;
      await sleep(DELAY_MS);
    }

    return items;
  }

  async function fetchWantlistPage(page) {
    const url = `${BASE}/mywantlist?page=${page}&limit=25`;
    const html = await getHTML(url);
    const doc = domParse(html);

    if (isLoginPage(doc)) {
      throw new Error('Not logged into Discogs. Please log in and try again.');
    }

    const items = parseWantlistItems(doc);
    const totalPages = parseTotalPages(doc);
    return { items, totalPages };
  }

  function parseWantlistItems(doc) {
    const items = [];
    const seen = new Set();

    // Strategy 1: rows with data-object-id (classic Discogs table layout)
    const objRows = doc.querySelectorAll('tr[data-object-id]');
    if (objRows.length > 0) {
      objRows.forEach(row => {
        const id = row.dataset.objectId;
        if (!id || seen.has(id)) return;
        seen.add(id);

        const link = row.querySelector('a[href*="/release/"]');
        if (!link) return;

        const artistEl = row.querySelector('.want_list_artist a, a[href*="/artist/"]');
        const formatEl = row.querySelector('.format, [class*="format"]');

        items.push({
          releaseId: id,
          title: clean(link.textContent),
          artist: clean(artistEl?.textContent),
          format: clean(formatEl?.textContent),
          url: `${BASE}/release/${id}`,
        });
      });
      if (items.length) return items;
    }

    // Strategy 2: any release links with contextual containers (newer Discogs UI)
    const releaseLinks = doc.querySelectorAll('a[href*="/release/"]');
    releaseLinks.forEach(link => {
      const m = (link.pathname || link.href).match(/\/release\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;

      const text = clean(link.textContent);
      if (!text || text.length < 2) return;

      // Only pick links inside meaningful wantlist containers
      const container = link.closest('[class*="want"], [class*="release"], tr, li, article, .card, [class*="item"]');
      if (!container) return;

      seen.add(id);
      const artistEl = container.querySelector('a[href*="/artist/"]');
      items.push({
        releaseId: id,
        title: text,
        artist: clean(artistEl?.textContent),
        format: '',
        url: `${BASE}/release/${id}`,
      });
    });

    return items;
  }

  function parseTotalPages(doc) {
    // "of N items" pattern
    const summary = doc.querySelector(
      '.pagination_total, [class*="paginationInfo"], [class*="pagination"] span, .pagination span'
    );
    if (summary) {
      const m = summary.textContent.match(/of\s+([\d,]+)/i);
      if (m) return Math.ceil(parseInt(m[1].replace(/,/g, ''), 10) / 25);
    }

    // Explicit numbered page links
    let max = 1;
    doc.querySelectorAll('a.page_link, [class*="pagination"] a').forEach(a => {
      const n = parseInt(a.textContent.trim(), 10);
      if (!isNaN(n)) max = Math.max(max, n);
    });
    return max;
  }

  // ─── Marketplace Fetching ────────────────────────────────────────────────

  async function fetchMarketplaceListings(releaseId) {
    const allListings = [];
    const seenSeller = new Set(); // shared across pages — one listing per seller per release
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${BASE}/sell/release/${releaseId}?sort=price%2Basc&limit=25&page=${page}`;
      const html = await getHTML(url);
      const doc = domParse(html);

      const pageListings = parseListings(doc, releaseId, seenSeller);
      allListings.push(...pageListings);

      if (page === 1) {
        totalPages = parseTotalPages(doc);
        console.log(`[DiscogsGrouper]   Release ${releaseId}: ${totalPages} marketplace page(s)`);
      }

      if (page >= totalPages) break;
      page++;
      await sleep(DELAY_MS);
    } while (true);

    return allListings;
  }

  function parseListings(doc, releaseId, seenSeller) {
    const listings = [];
    const seenContainer = new WeakSet(); // prevent double-processing same DOM node

    function tryExtract(el) {
      if (!el || seenContainer.has(el)) return;
      seenContainer.add(el);
      const l = extractListing(el, releaseId);
      if (l && !seenSeller.has(l.sellerUsername)) {
        seenSeller.add(l.sellerUsername);
        listings.push(l);
      }
    }

    // Strategy 1: rows with explicit listing attribute
    doc.querySelectorAll('tr[data-listing-id], tr[data-object-id]').forEach(tryExtract);
    if (listings.length > 0) return listings;

    // Strategy 2: shortcut_navigable table rows
    doc.querySelectorAll('tr.shortcut_navigable').forEach(tryExtract);
    if (listings.length > 0) return listings;

    // Strategy 3: any table body row that contains a seller link and a price
    doc.querySelectorAll('tbody tr').forEach(tryExtract);
    if (listings.length > 0) return listings;

    // Strategy 4: generic containers — walk up from every seller link
    doc.querySelectorAll('a[href*="/seller/"]').forEach(link => {
      const container = link.closest('tr, li, article, [class*="listing"], [class*="Listing"], .mpitem');
      if (container) tryExtract(container);
    });

    return listings;
  }

  function extractListing(row, releaseId) {
    const sellerLink = row.querySelector('a[href*="/seller/"]');
    if (!sellerLink) return null;

    const m = sellerLink.href.match(/\/seller\/([^/?#]+)/);
    if (!m) return null;
    const username = m[1];
    if (username === 'help') return null;

    const price = extractPrice(row);
    const priceDisplay = getPriceText(row);
    const mediaCondition  = getConditionText(row, 'media');
    const sleeveCondition = getConditionText(row, 'sleeve');
    const shipsFrom       = getShipsFrom(row);
    const currency        = detectCurrency(priceDisplay);

    console.log(`[DiscogsGrouper] Listing — seller: "${username}"  media: "${mediaCondition}"  shipsFrom: "${shipsFrom}"  currency: "${currency}"  price: "${priceDisplay}"`);

    return {
      releaseId,
      sellerUsername: username,
      storeUrl: `${BASE}/seller/${username}`,
      price: price ?? 0,
      priceDisplay,
      currency,
      mediaCondition,
      sleeveCondition,
      shipsFrom,
      listingUrl: row.querySelector('a[href*="/sell/item/"]')?.href
        || `${BASE}/sell/release/${releaseId}`,
    };
  }

  function getShipsFrom(el) {
    // Explicit element
    const loc = el.querySelector(
      '.seller_location, .ships_from, [class*="ships_from"], [class*="shipsFrom"], [class*="seller_location"]'
    );
    if (loc) return clean(loc.textContent.replace(/ships\s+from:?/i, '').replace(/\(.*?\)/g, ''));

    // Scan for "Ships From:" text node pattern anywhere in the row
    const m = el.textContent.match(/ships\s+from:?\s*([A-Za-z ,]+?)(?:\n|$)/i);
    if (m) return m[1].trim();

    return '';
  }

  function detectCurrency(priceText) {
    const t = (priceText || '').trim();
    if (/^CA\$|^C\$/.test(t))          return 'CAD';
    if (/^AU\$|^A\$/.test(t))          return 'AUD';
    if (/^JP¥|^¥/.test(t))             return 'JPY';
    if (t.startsWith('$'))             return 'USD';
    if (t.startsWith('€'))             return 'EUR';
    if (t.startsWith('£'))             return 'GBP';
    return 'USD'; // fallback
  }

  function extractPrice(el) {
    const priceEl = el.querySelector(
      '.price, .converted_price, [class*="price"], [class*="Price"]'
    );
    if (!priceEl) return null;
    const m = priceEl.textContent.replace(/[,\s]/g, '').match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  function getPriceText(el) {
    return clean(el.querySelector(
      '.price, .converted_price, [class*="price"], [class*="Price"]'
    )?.textContent) || 'N/A';
  }

  function getConditionText(el, type) {
    const sel = type === 'media'
      ? '.media-condition, [class*="mediaCondition"], [title*="Media"], [class*="media_condition"]'
      : '.sleeve-condition, [class*="sleeveCondition"], [title*="Sleeve"], [class*="sleeve_condition"]';
    return clean(el.querySelector(sel)?.textContent);
  }

  // ─── Grouping & Ranking ──────────────────────────────────────────────────

  function groupAndRank(allListings) {
    const map = {};

    allListings.forEach(({ sellerUsername, storeUrl, price, priceDisplay, currency, mediaCondition, sleeveCondition, shipsFrom, listingUrl, release }) => {
      if (!map[sellerUsername]) {
        map[sellerUsername] = {
          username: sellerUsername,
          storeUrl,
          count: 0,
          totalPrice: 0,
          records: [],
        };
      }
      const s = map[sellerUsername];
      s.count++;
      s.totalPrice += price ?? 0;
      s.records.push({
        title: release.title,
        artist: release.artist,
        format: release.format,
        price,
        priceDisplay,
        currency,
        mediaCondition,
        sleeveCondition,
        shipsFrom,
        listingUrl,
        releaseUrl: release.url,
      });
    });

    // Rank: most wantlist records first; ties broken by lowest total price.
    // All sellers are returned — the popup applies the 2+ display threshold.
    return Object.values(map).sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.totalPrice - b.totalPrice
    );
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  async function getHTML(url) {
    console.log('[DiscogsGrouper] GET', url);
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }

  function domParse(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function isLoginPage(doc) {
    return !!(
      doc.querySelector('form#login_form, form[action*="/login"]') ||
      doc.querySelector('.login-box, [class*="loginForm"]')
    );
  }

  function clean(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function loadCache() {
    return new Promise(resolve => {
      chrome.storage.local.get(CACHE_KEY, r => {
        const c = r[CACHE_KEY];
        if (!c || Date.now() - c.ts > CACHE_TTL) return resolve(null);
        resolve(c);
      });
    });
  }

  async function saveCache(data) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [CACHE_KEY]: { data, ts: Date.now() } }, resolve);
    });
  }
}
