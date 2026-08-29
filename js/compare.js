/**
 * PricePulse — Compare Prices Module (Premium UI, Stage A)
 * API calls, data contract, and the window.PricePulse.runComparePrefill
 * handoff used by AI Find are all unchanged — only presentation/markup here.
 */
(function () {
  const urlInput = document.getElementById('compare-url');
  const compareBtn = document.getElementById('compare-btn');
  const textInput = document.getElementById('compare-text');
  const textBtn = document.getElementById('compare-text-btn');
  const loadingEl = document.getElementById('compare-loading');
  const resultsEl = document.getElementById('compare-results');
  const recentEl = document.getElementById('cp-recent');
  const quickChips = document.querySelectorAll('.cp-quick-chip');
  const platformDots = loadingEl.querySelectorAll('.cp-platform-dots span');
  const compareViewEl = document.getElementById('view-compare');
  const backBtn = compareViewEl ? compareViewEl.querySelector('[data-back]') : null;
  // Landing-only content (spec Phase 8.1 Section 14/17): hidden smoothly
  // once a comparison starts, restored only by resetComparisonState().
  const landingCollapseEls = compareViewEl
    ? compareViewEl.querySelectorAll('.cp-hero, .cp-section')
    : [];

  const RECENT_KEY = 'pricepulse_recent_compares';
  const RECENT_MAX = 6;

  /* ---------------- Explicit state model (Phase 8.1 Section 13) ----------------
   * IDLE: landing content visible, no loading/results.
   * COMPARING: landing content collapsed, loading UI visible.
   * RESULTS: loading hidden, trusted-mode results visible.
   * FULL_INTERNET: loading hidden, full-internet-mode results visible.
   * A single setState() is the only place that touches loading/results/
   * landing visibility — no other function should toggle those classes
   * directly, so the UI can never end up in a mixed/stale combination.
   */
  const COMPARE_STATE = { IDLE: 'idle', COMPARING: 'comparing', RESULTS: 'results', FULL_INTERNET: 'full_internet' };
  let compareState = COMPARE_STATE.IDLE;
  let lastComparisonData = null; // the already-fetched response; reused by Search Full Internet (no 2nd API call)

  function setState(next) {
    compareState = next;
    const isIdle = next === COMPARE_STATE.IDLE;
    landingCollapseEls.forEach(el => el.classList.toggle('cp-collapsed', !isIdle));

    switch (next) {
      case COMPARE_STATE.IDLE:
        loadingEl.classList.add('hidden');
        resultsEl.classList.add('hidden');
        break;
      case COMPARE_STATE.COMPARING:
        loadingEl.classList.remove('hidden');
        resultsEl.classList.add('hidden');
        break;
      case COMPARE_STATE.RESULTS:
      case COMPARE_STATE.FULL_INTERNET:
        loadingEl.classList.add('hidden');
        resultsEl.classList.remove('hidden');
        break;
    }
  }

  // Centralized reset (spec Phase 8.1 Section 21) — every piece of stale
  // per-comparison state is cleared here, and ONLY here, so Back can never
  // leave a partial/mixed view behind. Recent-comparisons history in
  // localStorage is deliberately NOT touched — that's persistent user data,
  // not transient comparison state.
  function resetComparisonState() {
    lastComparisonData = null;
    delete resultsEl.dataset.cpMode;
    resultsEl.innerHTML = '';
    loadingEl.querySelectorAll('.cp-platform-dots span').forEach(dot => dot.classList.remove('scanning', 'done'));
    urlInput.value = '';
    if (textInput) textInput.value = '';
    compareBtn.disabled = false;
    compareBtn.classList.remove('is-loading');
    setState(COMPARE_STATE.IDLE);
  }

  if (backBtn) {
    // Runs alongside app.js's own [data-back] -> navigateHome() listener
    // (unchanged, untouched) — this one only clears Compare's internal
    // state so a later return to this view starts fresh instead of
    // showing whatever was last rendered (spec Phase 8.1 Section 20).
    backBtn.addEventListener('click', resetComparisonState);
  }

  function formatPrice(amount) {
    if (!amount) return 'Price unavailable';
    return '₹' + amount.toLocaleString('en-IN');
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------------- Recent comparisons (on-device, real history only) ---------------- */

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch { return []; }
  }

  function saveRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
    catch { /* storage unavailable — recent list just won't persist */ }
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 18 ? u.pathname.slice(0, 18) + '…' : u.pathname;
      return u.hostname.replace('www.', '') + path;
    } catch { return url; }
  }

  function pushRecent(entry) {
    const list = getRecent().filter(e => e.value !== entry.value);
    list.unshift(entry);
    saveRecent(list);
    renderRecent();
  }

  function renderRecent() {
    if (!recentEl) return;
    const list = getRecent();
    if (list.length === 0) {
      recentEl.innerHTML = `
        <div class="cp-recent-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.5 10.5a5 5 0 007.07 0l1.41-1.41a5 5 0 00-1.68-8.14M13.5 13.5a5 5 0 01-7.07 0L5.02 12.09a5 5 0 011.68-8.14"/></svg>
          Your recent comparisons will appear here.
        </div>`;
      return;
    }
    recentEl.innerHTML = list.map((e, i) => `
      <button type="button" class="cp-recent-pill" data-recent-index="${i}" title="${escapeHtml(e.label)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 007.07 0l1.41-1.41a5 5 0 00-7.07-7.07L10 5.51" stroke-linecap="round"/><path d="M14 11a5 5 0 00-7.07 0L5.51 12.41a5 5 0 007.07 7.07L14 18.49" stroke-linecap="round"/></svg>
        <span>${escapeHtml(e.label)}</span>
      </button>
    `).join('');
    recentEl.querySelectorAll('[data-recent-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = list[Number(btn.dataset.recentIndex)];
        if (!entry) return;
        if (entry.type === 'url') {
          urlInput.value = entry.value;
          runComparison({ skipHistory: true });
        } else {
          runComparisonByText(entry.value, { skipHistory: true });
        }
      });
    });
  }

  /* ---------------- Loading state ---------------- */

  function showError(message) {
    resultsEl.innerHTML = `
      <div class="cp-error-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <p>${escapeHtml(message)}</p>
        <p class="cp-error-hint">Check that the PricePulse Node server is running, and paste a direct product page link.</p>
      </div>
    `;
    resultsEl.classList.remove('hidden');
  }

  function availabilityTag(item) {
    if (item.availability === 'out_of_stock') return `<span class="cp-tag out-of-stock">Out of stock</span>`;
    if (item.availability === 'in_stock') return `<span class="cp-tag in-stock">In stock</span>`;
    // Unknown availability is never guessed at — say nothing rather than fabricate a status.
    return '';
  }

  // Wording tiers keyed to the real thresholds compareService.js uses
  // (BEST_OFFER_MATCH_THRESHOLD=0.75). A strong (0.90+) match shows no badge —
  // only offers that genuinely need a second look get flagged.
  const ISSUE_LABELS = {
    accessory: 'Accessory, not the product',
    variant_mismatch: 'Variant mismatch',
    storage_mismatch: 'Storage mismatch',
    ram_mismatch: 'RAM mismatch',
    generation_mismatch: 'Generation mismatch',
    model_number_mismatch: 'Different model',
    brand_mismatch: 'Brand mismatch',
  };

  function confidenceBadge(item) {
    if (item.isPossibleMatch) return { text: ISSUE_LABELS[item.matchIssue] || 'Low confidence', cls: 'uncertain-match' };
    if (item.matchConfidence >= 0.90) return null;
    if (item.matchConfidence >= 0.75) {
      if (item.matchIssue === 'storage_unconfirmed') return { text: 'Verify storage', cls: 'good-match' };
      return { text: 'Good match', cls: 'good-match' };
    }
    return { text: ISSUE_LABELS[item.matchIssue] || 'Possible match', cls: 'uncertain-match' };
  }

  function actionLabel(item, isBest) {
    if (!item.url) return 'Unavailable';
    if (item.isPossibleMatch) return 'Check →';
    if (item.isGoogleRedirect) return isBest ? 'Best Deal — View on Google Shopping →' : 'View on Google Shopping →';
    return isBest ? 'Best Deal →' : 'View Deal →';
  }

  function merchantCard(item, i, opts) {
    opts = opts || {};
    const isBest = !!opts.isBest;
    const bestPrice = opts.bestPrice || null;
    const priceLabel = item.availability === 'out_of_stock' ? 'Price unavailable' : formatPrice(item.price);
    const tag = item.url ? 'a' : 'div';
    const hrefAttr = item.url ? `href="${item.url}" target="_blank" rel="noopener"` : '';
    const badge = confidenceBadge(item);
    const diff = (!isBest && bestPrice && item.price > bestPrice && item.availability !== 'out_of_stock')
      ? `<div class="cp-price-diff">${formatPrice(item.price - bestPrice)} more than best price</div>` : '';

    return `
      <${tag} ${hrefAttr} class="cp-merchant-card ${isBest ? 'is-best' : ''} ${item.isPossibleMatch ? 'is-possible' : ''} ${!item.url ? 'no-link' : ''}" style="animation-delay:${Math.min(i * 0.06, 0.4)}s">
        <div class="cp-merchant-badge ${item.color || 'default'}">${escapeHtml(item.platform).charAt(0)}</div>
        <div class="cp-merchant-info">
          <div class="cp-merchant-name">${escapeHtml(item.platform)}${item.isSource ? ' <span class="cp-tag other-seller">Your link</span>' : ''}${!item.isMajorRetailer && !item.isSource ? ' <span class="cp-tag other-seller">Other seller</span>' : ''}</div>
          ${item.title && !item.isSource ? `<div class="cp-merchant-title">${escapeHtml(item.title)}</div>` : ''}
          <div class="cp-merchant-price-row">
            <span class="cp-merchant-price">${priceLabel}</span>
            ${item.mrp && item.mrp > item.price ? `<span class="cp-merchant-mrp">${formatPrice(item.mrp)}</span>` : ''}
            ${item.discount > 0 ? `<span class="cp-merchant-discount">${item.discount}% off</span>` : ''}
          </div>
          ${diff}
          <div class="cp-tag-row">
            ${availabilityTag(item)}
            ${badge ? `<span class="cp-tag ${badge.cls}">${badge.text}</span>` : ''}
            ${item.isGoogleRedirect && item.url ? `<span class="cp-tag google-redirect">via Google Shopping</span>` : ''}
          </div>
        </div>
        <span class="cp-merchant-cta">${actionLabel(item, isBest)}</span>
      </${tag}>
    `;
  }

  function priceVizRow(item, maxPrice, isBest) {
    if (!item.price) return '';
    const pct = Math.max(6, Math.round((item.price / maxPrice) * 100));
    return `
      <div class="cp-viz-row ${isBest ? 'is-best' : ''}">
        <div class="cp-viz-name">${escapeHtml(item.platform)}</div>
        <div class="cp-viz-track"><div class="cp-viz-bar" style="width:${pct}%"></div></div>
        <div class="cp-viz-price">${formatPrice(item.price)}</div>
      </div>
    `;
  }

  function renderResults(data) {
    // Phase 8 — Trusted Retailers first. `trustedOffers`/`bestTrustedOffer`/
    // `trustedSavings` are additive fields from the backend (a strict
    // subset of `results`/`bestOffer` below — nothing is removed from the
    // full-internet pool, it's just not shown until the user asks for it).
    // Older backends that don't send these yet simply produce
    // trustedAvailable=false, and the view falls back to today's behavior
    // exactly as before Phase 8.
    const trustedOffers = data.trustedOffers || [];
    const trustedAvailable = Array.isArray(data.trustedOffers);
    const showFullInternet = !trustedAvailable || trustedOffers.length === 0 || resultsEl.dataset.cpMode === 'internet';
    // Phase 8.1 — drives the RESULTS/FULL_INTERNET halves of the explicit
    // state model. renderResults() is also how the "Search Full Internet"/
    // "Back to trusted retailers" toggle re-renders — no new API call
    // either way (spec Section 19), just a different state + the same
    // already-fetched `data`.
    setState(showFullInternet ? COMPARE_STATE.FULL_INTERNET : COMPARE_STATE.RESULTS);

    const bestOffer = data.bestOffer || null;
    const bestDirectOffer = data.bestDirectOffer || null;
    const bestTrustedOffer = data.bestTrustedOffer || null;
    const bestTrustedDirectOffer = data.bestTrustedDirectOffer || null;

    // Prefer the best directly-actionable merchant offer for the headline —
    // a cheaper Google Shopping redirect never auto-becomes the recommendation
    // just for being cheaper. Falls back to bestOffer only when no direct
    // offer exists at all. In trusted mode, use the trusted-pool equivalents.
    const primaryBest = showFullInternet ? (bestDirectOffer || bestOffer) : (bestTrustedDirectOffer || bestTrustedOffer);
    const hasCheaperGoogleAlternative = showFullInternet && !!(bestDirectOffer && bestOffer && bestOffer.url !== bestDirectOffer.url && bestOffer.price < bestDirectOffer.price);
    const savings = showFullInternet ? data.savings : data.trustedSavings;

    const allResults = showFullInternet ? (data.results || []) : trustedOffers;
    const confidentResults = allResults.filter(r => !r.isPossibleMatch);
    const possibleResults = allResults.filter(r => r.isPossibleMatch);

    // Hierarchy: BEST PRICE -> Recommended (major/known retailers) -> Other
    // sellers -> Possible matches. Backend already tier-sorts confidentResults.
    // Only relevant in full-internet mode — the trusted view is, by
    // definition, already all "recommended" retailers.
    const recommendedResults = confidentResults.filter(r => r.retailerTier === 'major_retailer' || r.retailerTier === 'known_retailer');
    const otherSellerResults = confidentResults.filter(r => r.retailerTier === 'other_seller' || !r.retailerTier);
    const showTierHeadings = showFullInternet && recommendedResults.length > 0 && otherSellerResults.length > 0;

    let html = `
      <div class="cp-product-card">
        <img src="${data.product.image || 'assets/logo.png'}" alt="${escapeHtml(data.product.name)}" onerror="this.src='assets/logo.png'" />
        <div class="cp-product-info">
          <h3>${escapeHtml(data.product.name)}</h3>
          <div class="cp-product-meta">Found on ${allResults.length} platform${allResults.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
    `;

    // Trusted vs. full-internet mode indicator + toggle. Only shown when
    // the backend actually sent trustedOffers (older API responses just
    // skip this and behave exactly as before Phase 8).
    if (trustedAvailable) {
      if (showFullInternet && trustedOffers.length > 0 && resultsEl.dataset.cpMode === 'internet') {
        html += `
          <div class="cp-mode-banner">
            Showing results from across the web. <button type="button" class="cp-mode-link" id="cp-show-trusted">Back to trusted retailers</button>
          </div>
        `;
      } else if (!showFullInternet) {
        const count = trustedOffers.length;
        html += `
          <div class="cp-mode-banner">
            Showing ${count} trusted retailer${count !== 1 ? 's' : ''} first. Prices may be lower elsewhere.
          </div>
        `;
      }
    }

    if (primaryBest) {
      const isDirectLink = !primaryBest.isGoogleRedirect;
      html += `
        <div class="cp-best-card">
          <span class="cp-best-badge">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.7L20 12l-6.2 1.3L12 18l-1.8-6.7L4 12l6.2-1.3z"/></svg>
            ${showFullInternet ? 'Best price' : 'Best trusted price'}
          </span>
          <div class="cp-best-row">
            <div class="cp-best-price-block">
              <div class="cp-best-price">${formatPrice(primaryBest.price)}</div>
              <div class="cp-best-merchant">${escapeHtml(primaryBest.platform)}</div>
            </div>
            ${savings > 0 ? `<span class="cp-best-savings">You save ${formatPrice(savings)}</span>` : ''}
          </div>
          ${primaryBest.url ? `<a href="${primaryBest.url}" target="_blank" rel="noopener" class="cp-best-cta">${isDirectLink ? 'View Deal' : 'View on Google Shopping'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>` : ''}
          ${hasCheaperGoogleAlternative ? `<div class="cp-google-alt-note">Google Shopping shows ${formatPrice(bestOffer.price)} on ${escapeHtml(bestOffer.platform)}, but no verified direct link was found for it.</div>` : ''}
          ${!showFullInternet && trustedAvailable && bestOffer && bestOffer.price < primaryBest.price ? `<div class="cp-google-alt-note">A lower price (${formatPrice(bestOffer.price)} on ${escapeHtml(bestOffer.platform)}) was found across the wider internet — not a trusted retailer.</div>` : ''}
        </div>
      `;

      // PricePulse Insight — generated only from real result data, nothing fabricated.
      const totalStores = allResults.length;
      let insight = '';
      if (totalStores > 1 && savings > 0) {
        insight = `${escapeHtml(primaryBest.platform)} currently has the lowest listed price among the ${totalStores} stores we found — ${formatPrice(savings)} less than the highest.`;
      } else if (totalStores > 1) {
        insight = `${escapeHtml(primaryBest.platform)} currently has the lowest listed price among the ${totalStores} stores we found.`;
      } else {
        insight = `This is the only listing we found for this product right now.`;
      }
      html += `
        <div class="cp-insight-card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 6.7L20 12l-6.2 1.3L12 20l-1.8-6.7L4 12l6.2-1.3z"/></svg>
          <div><span class="cp-insight-label">PricePulse Insight</span><span class="cp-insight-text">${insight}</span></div>
        </div>
      `;
    }

    // Small price-comparison visualization — only when there's more than one
    // priced result worth comparing.
    const pricedResults = confidentResults.filter(r => r.price);
    if (pricedResults.length > 1) {
      const maxPrice = Math.max(...pricedResults.map(r => r.price));
      html += `<div class="cp-viz">` + pricedResults.map((item) => {
        const isBest = !!primaryBest && item.url === primaryBest.url;
        return priceVizRow(item, maxPrice, isBest);
      }).join('') + `</div>`;
    }

    if (allResults.length > 0) {
      html += `
        <div class="cp-toolbar">
          <span class="cp-toolbar-count">${allResults.length} store${allResults.length !== 1 ? 's' : ''}</span>
          <select class="cp-sort-select" id="cp-sort-select">
            <option value="price">Sort: Lowest price</option>
            <option value="rating">Sort: Highest rated</option>
          </select>
        </div>
      `;
    }

    const renderGroup = (items) => {
      let group = '<div class="cp-merchant-list">';
      items.forEach((item, i) => {
        const isBest = !!primaryBest && item.url === primaryBest.url;
        group += merchantCard(item, i, { isBest: isBest, bestPrice: primaryBest ? primaryBest.price : null });
      });
      return group + '</div>';
    };

    html += `<div id="cp-merchant-groups">`;
    if (showTierHeadings) {
      html += `<div class="cp-group-heading">Recommended retailers</div>`;
      html += renderGroup(recommendedResults);
      html += `<div class="cp-group-heading">Other sellers</div>`;
      html += renderGroup(otherSellerResults);
    } else {
      html += renderGroup(confidentResults);
    }
    html += `</div>`;

    if (savings > 0) {
      html += `<div class="cp-savings-banner">Save up to ${formatPrice(savings)} by choosing the best deal!</div>`;
    }

    if (!showFullInternet && confidentResults.length === 0 && possibleResults.length === 0) {
      // Phase 8 — empty trusted-result case: never a blank page, always a
      // clear explanation + the path to full-internet results (spec
      // Section 14). Not fabricating a trusted retailer just to fill the
      // gap.
      html += `<div class="cp-empty-state">No trusted retailers found for this product yet.</div>`;
    } else if (!bestOffer && confidentResults.length === 0 && possibleResults.length === 0) {
      html += `<div class="cp-empty-state">No comparable offers found for this product yet.</div>`;
    }

    // Phase 8 — "Search Full Internet" CTA (spec Section 13): reveals the
    // already-collected broader results rather than firing a second
    // search. Only offered when there's actually something to expand to.
    if (trustedAvailable && !showFullInternet) {
      // Phase 8.1 fix (spec Section 23): this MUST be the count of stores
      // full-internet mode would ADD beyond what's already shown here, not
      // the full-internet pool's TOTAL — using internetOfferCount (a
      // total that already includes every trusted retailer above) made
      // this label overstate how many *additional* stores exist. Prefer
      // the backend's own delta (additionalOfferCount); fall back to
      // computing it client-side only for older backend responses that
      // predate this field.
      const additionalCount = data.additionalOfferCount != null
        ? data.additionalOfferCount
        : Math.max(0, (data.internetOfferCount != null ? data.internetOfferCount : (data.results || []).length) - trustedOffers.length);
      html += `
        <div class="cp-full-internet-cta">
          <button type="button" class="cp-full-internet-btn" id="cp-search-full-internet">
            Search Full Internet${additionalCount > 0 ? ` (${additionalCount} more store${additionalCount !== 1 ? 's' : ''})` : ''} →
          </button>
          <div class="cp-full-internet-hint">Includes smaller/unverified sellers we don't independently vouch for.</div>
        </div>
      `;
    }

    if (possibleResults.length > 0) {
      html += `
        <div class="cp-possible-section">
          <div class="cp-possible-heading">Possible matches — not confident enough to include in the best price</div>
          <div class="cp-merchant-list">
      `;
      possibleResults.forEach((item, i) => {
        html += merchantCard(item, i, { isBest: false });
      });
      html += `</div></div>`;
    }

    resultsEl.innerHTML = html;
    resultsEl.classList.remove('hidden');

    // Phase 8 — mode toggle: re-renders the SAME already-fetched `data`
    // with a different resultsEl.dataset.cpMode, never a new API call
    // (spec Section 13: "Prefer revealing already-collected results").
    const fullInternetBtn = document.getElementById('cp-search-full-internet');
    if (fullInternetBtn) {
      fullInternetBtn.addEventListener('click', () => {
        resultsEl.dataset.cpMode = 'internet';
        renderResults(data);
      });
    }
    const showTrustedBtn = document.getElementById('cp-show-trusted');
    if (showTrustedBtn) {
      showTrustedBtn.addEventListener('click', () => {
        resultsEl.dataset.cpMode = 'trusted';
        renderResults(data);
      });
    }

    // Client-side sort — operates only on data already fetched, no new API calls.
    const sortSelect = document.getElementById('cp-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        const groupsEl = document.getElementById('cp-merchant-groups');
        if (!groupsEl) return;
        const sortFn = sortSelect.value === 'rating'
          ? (a, b) => (b.rating || 0) - (a.rating || 0)
          : (a, b) => (a.price || Infinity) - (b.price || Infinity);
        const sortedConfident = confidentResults.slice().sort(sortFn);
        if (showTierHeadings) {
          const sr = sortedConfident.filter(r => r.retailerTier === 'major_retailer' || r.retailerTier === 'known_retailer');
          const so = sortedConfident.filter(r => r.retailerTier === 'other_seller' || !r.retailerTier);
          groupsEl.innerHTML = `<div class="cp-group-heading">Recommended retailers</div>${renderGroup(sr)}<div class="cp-group-heading">Other sellers</div>${renderGroup(so)}`;
        } else {
          groupsEl.innerHTML = renderGroup(sortedConfident);
        }
      });
    }
  }

  async function runShoppingCompare(dataPromise, initialLabel) {
    // Phase 8 — always start a fresh comparison in trusted mode; a
    // previous "Search Full Internet" click must not carry over to a new
    // product search.
    delete resultsEl.dataset.cpMode;
    lastComparisonData = null;
    setState(COMPARE_STATE.COMPARING);
    loadingEl.querySelector('p').textContent = initialLabel || 'Fetching product details…';

    platformDots.forEach(dot => dot.classList.remove('scanning', 'done'));

    try {
      for (let i = 0; i < platformDots.length; i++) {
        platformDots[i].classList.add('scanning');
        loadingEl.querySelector('p').textContent = `Searching ${platformDots[i].textContent}…`;
        await new Promise(r => setTimeout(r, 600));
        platformDots[i].classList.remove('scanning');
        platformDots[i].classList.add('done');
      }

      const data = await dataPromise;
      lastComparisonData = data;
      renderResults(data);
    } catch (err) {
      setState(COMPARE_STATE.RESULTS);
      showError(err.message);
    }
  }

  function flagInputError(el) {
    el.classList.add('cp-input-error');
    el.focus();
    setTimeout(() => el.classList.remove('cp-input-error'), 1500);
  }

  async function runComparison(opts) {
    opts = opts || {};
    const url = urlInput.value.trim();
    if (!url) { flagInputError(urlInput); return; }
    try { new URL(url); } catch (e) { flagInputError(urlInput); return; }

    compareBtn.disabled = true;
    compareBtn.classList.add('is-loading');
    if (!opts.skipHistory) pushRecent({ type: 'url', value: url, label: shortenUrl(url) });
    const dataPromise = PricePulseAPI.comparePrices(url);
    await runShoppingCompare(dataPromise);
    compareBtn.disabled = false;
    compareBtn.classList.remove('is-loading');
  }

  // Text-query variant: used for the secondary search box, quick-start chips,
  // recent-history pills, and when AI Find hands off a plain string.
  async function runComparisonByText(query, opts) {
    opts = opts || {};
    compareBtn.disabled = true;
    urlInput.value = '';
    if (!opts.skipHistory) pushRecent({ type: 'text', value: query, label: query });
    const dataPromise = PricePulseAPI.compareByText(query);
    await runShoppingCompare(dataPromise, `Searching for "${query}"…`);
    compareBtn.disabled = false;
  }

  // Structured-product variant: used when arriving from AI Find's image
  // flow, where brand/model/storage/color are known.
  async function runComparisonByProduct(product) {
    compareBtn.disabled = true;
    urlInput.value = '';
    const label = product.name || [product.brand, product.productName || product.model].filter(Boolean).join(' ');
    if (label) pushRecent({ type: 'text', value: label, label: label });
    const dataPromise = PricePulseAPI.compareByProduct(product);
    await runShoppingCompare(dataPromise, `Searching for "${label}"…`);
    compareBtn.disabled = false;
  }

  compareBtn.addEventListener('click', () => runComparison());
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runComparison(); });

  if (textBtn && textInput) {
    const submitText = () => {
      const q = textInput.value.trim();
      if (!q) { flagInputError(textInput); return; }
      runComparisonByText(q);
    };
    textBtn.addEventListener('click', submitText);
    textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });
  }

  quickChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.query;
      if (q) runComparisonByText(q);
    });
  });

  renderRecent();

  // Exposed so AI Find can hand off a detected/typed product without the user
  // re-pasting a URL. Reuses this module's existing loading UI and renderResults().
  // Accepts either a plain string (text search) or a structured product object
  // (image search result: { name, brand, productName, model, storage, color, category }).
  window.PricePulse = window.PricePulse || {};
  window.PricePulse.runComparePrefill = function (queryOrProduct) {
    if (!queryOrProduct) return;
    if (typeof queryOrProduct === 'object') {
      runComparisonByProduct(queryOrProduct);
    } else {
      runComparisonByText(queryOrProduct);
    }
  };
})();
