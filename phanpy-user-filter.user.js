// ==UserScript==
// @name         Phanpy User Filter
// @namespace    https://github.com/nul800sebastiaan/tampermonkey-scripts
// @version      1.8.1
// @description  Hide posts from specific users in Phanpy (Mastodon web client). Manage the blocklist via the Tampermonkey menu.
// @author       you
// @updateURL    https://raw.githubusercontent.com/nul800sebastiaan/tampermonkey-scripts/main/phanpy-user-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/nul800sebastiaan/tampermonkey-scripts/main/phanpy-user-filter.user.js
// @match        https://phanpy.social/*
// @match        https://*.phanpy.social/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  // Always-on load banner so you can confirm in the console (F12) that this
  // script is actually running and which version Tampermonkey loaded.
  console.log('%c[Phanpy User Filter] v1.8.1 loaded', 'color:#0a0;font-weight:bold');

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  // ===========================================================================
  //  >>> EDIT THIS LIST <<<  — users you never want to see.
  // ===========================================================================
  // Take the profile URL, e.g.  https://mastodon.social/@dansup
  // and write it as            username@instance  ->  dansup@mastodon.social
  //
  // Forms accepted (all case-insensitive):
  //   "dansup@mastodon.social"         -> only that exact account (recommended)
  //   "dansup"                         -> @dansup on ANY instance
  //   "@dansup@mastodon.social"        -> leading @ is fine too
  const DEFAULT_BLOCKLIST = [
    // add users here, one per line:
  ];

  // Set to true (or use the menu toggle) to log scan results to the console.
  let DEBUG = GM_getValue('phanpy_uf_debug', false);

  // ---------------------------------------------------------------------------
  // Blocklist storage helpers
  // ---------------------------------------------------------------------------
  function normalize(entry) {
    return String(entry || '')
      .trim()
      .replace(/^@/, '')     // drop a single leading @
      .toLowerCase();
  }

  // The effective blocklist is always:  DEFAULT_BLOCKLIST (the editable list at
  // the top of this file) PLUS anything added via the menu, MINUS anything
  // removed via the menu. This means edits to the file ALWAYS take effect, and
  // the menu still works for live tweaks.
  const ADDED_KEY = 'phanpy_uf_added';
  const REMOVED_KEY = 'phanpy_uf_removed';

  function getList(key) {
    const v = GM_getValue(key, []);
    return (Array.isArray(v) ? v : []).map(normalize).filter(Boolean);
  }
  function setList(key, arr) {
    GM_setValue(key, Array.from(new Set(arr.map(normalize).filter(Boolean))));
  }

  function effectiveBlocklist() {
    const removed = new Set(getList(REMOVED_KEY));
    const all = new Set([
      ...DEFAULT_BLOCKLIST.map(normalize).filter(Boolean),
      ...getList(ADDED_KEY),
    ]);
    removed.forEach((r) => all.delete(r));
    return Array.from(all);
  }

  let blocklist = effectiveBlocklist();

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------
  // Parse a Mastodon profile URL like "https://mastodon.social/@dansup"
  // into the handle "dansup@mastodon.social". Returns null if it doesn't
  // look like a profile link.
  function handleFromProfileUrl(href) {
    let url;
    try {
      url = new URL(href, location.href);
    } catch (e) {
      return null;
    }
    // Last non-empty path segment is the username (often prefixed with @).
    const segs = url.pathname.split('/').filter(Boolean);
    if (!segs.length) return null;
    const last = segs[segs.length - 1].replace(/^@/, '');
    if (!last || last.includes('@')) return null; // not a simple /@user path
    if (!/^[a-z0-9_.-]+$/i.test(last)) return null;
    return (last + '@' + url.hostname).toLowerCase();
  }

  // Returns the set of handle strings (user@instance) for the people attached to
  // a status: the original author AND, for a boost/repost, the booster. Phanpy
  // renders each as an `a.name-text` whose href is the full profile URL — that
  // gives us the instance domain even when it's hidden in the visible text.
  //
  // We scope to the author (.meta-name) and the boost header (.status-pre-meta)
  // so inline @mentions in the post body don't trigger false hides.
  function getAuthorHandles(statusEl) {
    const handles = new Set();

    // For a boost, the booster's name lives in a sibling .status-pre-meta,
    // outside this article — so widen the scope to the reblog wrapper.
    const card = statusEl.closest('.status-reblog') || statusEl;
    const links = card.querySelectorAll(
      '.meta-name a.name-text, .status-pre-meta a.name-text, a.name-text'
    );

    links.forEach((link) => {
      const h = handleFromProfileUrl(link.getAttribute('href') || '');
      if (h) handles.add(h);

      // Fallback: the title attribute may hold "Display Name (user@instance)".
      const title = link.getAttribute('title') || '';
      const m = title.match(/@?([a-z0-9_.-]+@[a-z0-9.-]+)/i);
      if (m) handles.add(m[1].toLowerCase());
    });

    return handles;
  }

  // Does a single handle (user@instance) match the current blocklist?
  function handleMatchesBlock(h) {
    const userPart = h.split('@')[0];
    return blocklist.some((b) =>
      b.includes('@') ? h === b : userPart === b
    );
  }

  // If a status is blocked, return the handle that triggered it; else null.
  function blockedHandleFor(statusEl) {
    if (!blocklist.length) return null;
    for (const h of getAuthorHandles(statusEl)) {
      if (handleMatchesBlock(h)) return h;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Hiding
  // ---------------------------------------------------------------------------
  // We hide the closest timeline item wrapper so the whole card disappears
  // (including spacing), not just the inner status body.
  function timelineItemFor(statusEl) {
    return (
      statusEl.closest('li, .timeline-item') ||
      statusEl.closest('.status-reblog') ||
      statusEl
    );
  }

  // Idempotent full scan. Because Phanpy virtualizes/recycles DOM nodes, we
  // re-evaluate EVERY status each pass and set/clear the hidden flag accordingly
  // (no "only check once" cache — a recycled node may now show a blocked user).
  function scan() {
    const statuses = document.querySelectorAll('.status');
    let hidden = 0;
    const seen = DEBUG ? new Set() : null;
    statuses.forEach((statusEl) => {
      const item = timelineItemFor(statusEl);
      const handle = blockedHandleFor(statusEl);
      if (handle) {
        // If this (recycled) node now represents a different blocked user,
        // forget any previous "show" the user toggled.
        if (item.getAttribute('data-uf-handle') !== handle) {
          item.removeAttribute('data-uf-show');
        }
        item.setAttribute('data-uf-handle', handle);
        item.setAttribute('data-uf-hidden', '1');
        hidden++;
      } else {
        item.removeAttribute('data-uf-hidden');
        item.removeAttribute('data-uf-handle');
        item.removeAttribute('data-uf-show');
      }
      if (seen) getAuthorHandles(statusEl).forEach((h) => seen.add(h));
    });
    if (DEBUG) {
      console.log(
        '[Phanpy User Filter] scanned',
        statuses.length,
        'posts, hid',
        hidden,
        '\n  blocklist:',
        blocklist,
        '\n  handles detected on page:',
        Array.from(seen).sort()
      );
    }
  }

  // Coalesce a burst of DOM mutations into one scan that runs in the next
  // animation frame — i.e. just BEFORE the browser paints — so newly inserted
  // posts (infinite scroll) are hidden before they're ever visible (no flash).
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }

  // Re-evaluate everything (e.g. after the blocklist changes).
  function rescanAll() {
    scan();
  }

  // ---------------------------------------------------------------------------
  // Hover-to-filter button
  // ---------------------------------------------------------------------------
  // A floating button that appears next to a username on hover. Clicking it adds
  // that exact account to the blocklist. It lives on <body>, outside Phanpy's
  // (P)react tree, so re-renders can't remove or conflict with it.
  function setupHoverFilterButton() {
    const btn = document.createElement('button');
    btn.id = 'uf-filter-btn';
    btn.type = 'button';
    document.body.appendChild(btn);

    let currentHandle = null;
    let currentlyBlocked = false;
    let hideTimer = null;

    function hide() {
      btn.style.display = 'none';
      currentHandle = null;
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 350);
    }
    function showFor(link) {
      const h = handleFromProfileUrl(link.getAttribute('href') || '');
      if (!h) return;
      currentHandle = h;
      currentlyBlocked = handleMatchesBlock(h);
      btn.textContent = currentlyBlocked ? '✓ Unfilter' : '🚫 Filter';
      btn.classList.toggle('uf-unfilter', currentlyBlocked);
      btn.title = (currentlyBlocked ? 'Unfilter ' : 'Filter ') + h;
      const r = link.getBoundingClientRect();
      // Anchor to the top-right of the name, clamped to the viewport.
      const left = Math.min(r.right + 6, window.innerWidth - btn.offsetWidth - 6);
      btn.style.left = Math.max(6, left) + 'px';
      btn.style.top = Math.max(6, r.top - 2) + 'px';
      btn.style.display = 'block';
      clearTimeout(hideTimer);
    }

    document.addEventListener('mouseover', (e) => {
      const t = e.target;
      const link = t && t.closest ? t.closest('a.name-text') : null;
      if (link) showFor(link);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target;
      const link = t && t.closest ? t.closest('a.name-text') : null;
      if (link) scheduleHide();
    });
    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentHandle) return;
      if (currentlyBlocked) {
        // Unfilter: drop from added, and suppress any matching file default.
        setList(ADDED_KEY, getList(ADDED_KEY).filter((u) => u !== currentHandle));
        setList(REMOVED_KEY, [...getList(REMOVED_KEY), currentHandle]);
      } else {
        // Filter: add it, and clear any prior removal.
        setList(ADDED_KEY, [...getList(ADDED_KEY), currentHandle]);
        setList(REMOVED_KEY, getList(REMOVED_KEY).filter((u) => u !== currentHandle));
      }
      blocklist = effectiveBlocklist();
      scan();
      hide();
    });
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  GM_addStyle(`
    /* Collapsed placeholder: a thin labeled line instead of the post. */
    [data-uf-hidden="1"]:not([data-uf-show]) > * { display: none !important; }
    [data-uf-hidden="1"]:not([data-uf-show]) {
      cursor: pointer;
      min-height: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    [data-uf-hidden="1"]:not([data-uf-show])::before {
      content: "Hidden post from " attr(data-uf-handle) " — click to show";
      display: block;
      font: 500 11px/1 system-ui, sans-serif;
      color: var(--text-insignificant-color, #888);
      opacity: .5;
      padding: 7px 14px;
      border-top: 1px dashed rgba(128,128,128,.4);
      transition: opacity .12s;
    }
    [data-uf-hidden="1"]:not([data-uf-show]):hover::before { opacity: .95; }

    /* Expanded: show the post with a small notice on top. */
    [data-uf-hidden="1"][data-uf-show]::before {
      content: "Filtered: " attr(data-uf-handle) " — hover the name to unfilter";
      display: block;
      font: 600 11px/1 system-ui, sans-serif;
      color: #c0392b;
      opacity: .85;
      padding: 5px 14px;
    }
  `);
  GM_addStyle(`
    #uf-filter-btn {
      display: none;
      position: fixed;
      z-index: 2147483647;
      padding: 2px 8px;
      font: 600 12px/1.4 system-ui, sans-serif;
      color: #fff;
      background: #c0392b;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.35);
      white-space: nowrap;
    }
    #uf-filter-btn:hover { background: #a5281b; }
    #uf-filter-btn.uf-unfilter { background: #1e8449; }
    #uf-filter-btn.uf-unfilter:hover { background: #166b3a; }
  `);

  // ---------------------------------------------------------------------------
  // Observe the SPA (infinite scroll, route changes, node recycling)
  // ---------------------------------------------------------------------------
  function start() {
    scan();
    setupHoverFilterButton();

    // Click a collapsed placeholder to reveal the post. Capture phase + this
    // being the only visible part means we intercept before Phanpy navigates.
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        const item = t && t.closest ? t.closest('[data-uf-hidden="1"]') : null;
        if (!item || item.hasAttribute('data-uf-show')) return;
        e.preventDefault();
        e.stopPropagation();
        item.setAttribute('data-uf-show', '1');
      },
      true
    );

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Safety net for any mutation we don't observe (e.g. attribute-only swaps).
    setInterval(scan, 1500);
  }

  // ---------------------------------------------------------------------------
  // Tampermonkey menu commands  (registered FIRST so a scan error can't hide them)
  // ---------------------------------------------------------------------------
  GM_registerMenuCommand('Add user to filter…', () => {
    const input = prompt(
      'Hide posts from which user?\n\n' +
        'Examples:\n' +
        '  dansup                  (any instance)\n' +
        '  dansup@mastodon.social  (exact account)'
    );
    if (!input) return;
    const target = normalize(input);
    setList(ADDED_KEY, [...getList(ADDED_KEY), target]);
    setList(REMOVED_KEY, getList(REMOVED_KEY).filter((u) => u !== target)); // un-remove
    blocklist = effectiveBlocklist();
    rescanAll();
    alert('Now filtering: ' + target);
  });

  GM_registerMenuCommand('Remove user from filter…', () => {
    if (!blocklist.length) {
      alert('Blocklist is empty.');
      return;
    }
    const input = prompt(
      'Stop filtering which user?\n\nCurrently filtered:\n' +
        blocklist.join('\n')
    );
    if (!input) return;
    const target = normalize(input);
    setList(ADDED_KEY, getList(ADDED_KEY).filter((u) => u !== target));
    setList(REMOVED_KEY, [...getList(REMOVED_KEY), target]); // also suppress file defaults
    blocklist = effectiveBlocklist();
    rescanAll();
    alert('Updated. Now filtering:\n' + (blocklist.join('\n') || '(none)'));
  });

  GM_registerMenuCommand('Show filtered users', () => {
    alert('Currently filtering:\n\n' + (blocklist.join('\n') || '(none)'));
  });

  GM_registerMenuCommand('Export filtered users…', () => {
    const json = JSON.stringify(blocklist, null, 2);
    try {
      GM_setClipboard(json, 'text');
    } catch (e) {}
    // Prefilled prompt doubles as a fallback if the clipboard copy is blocked.
    prompt(
      'Copied to clipboard (' + blocklist.length + ' users). ' +
        'Paste into "Import filtered users…" on another browser.',
      json
    );
  });

  GM_registerMenuCommand('Import filtered users…', () => {
    const input = prompt(
      'Paste an exported list (JSON array, or one user per line / comma separated).\n' +
        'Users are merged into the current list.'
    );
    if (!input) return;
    let users;
    try {
      const parsed = JSON.parse(input);
      users = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      users = input.split(/[\s,]+/);
    }
    users = users.map(normalize).filter(Boolean);
    if (!users.length) {
      alert('No users found in the pasted text.');
      return;
    }
    setList(ADDED_KEY, [...getList(ADDED_KEY), ...users]);
    const imported = new Set(users);
    setList(REMOVED_KEY, getList(REMOVED_KEY).filter((u) => !imported.has(u)));
    blocklist = effectiveBlocklist();
    rescanAll();
    alert('Imported ' + users.length + ' users. Now filtering ' + blocklist.length + '.');
  });

  GM_registerMenuCommand('Toggle debug logging', () => {
    DEBUG = !DEBUG;
    GM_setValue('phanpy_uf_debug', DEBUG);
    scan();
    alert(
      'Debug logging is now ' +
        (DEBUG ? 'ON' : 'OFF') +
        '.\nOpen the browser console (F12) to see scan results.'
    );
  });

  // ---------------------------------------------------------------------------
  // Start (guarded so any error can't prevent the menu commands above)
  // ---------------------------------------------------------------------------
  function safeStart() {
    try {
      start();
    } catch (e) {
      console.error('[Phanpy User Filter] start error:', e);
    }
  }
  if (document.body) {
    safeStart();
  } else {
    document.addEventListener('DOMContentLoaded', safeStart);
  }
})();
