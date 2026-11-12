/* Kalm — music catalog front end.
   Data comes from Deezer via the local server. Album covers are Deezer CDN URLs,
   so no image proxying is needed. */

const FAVORITES_KEY = 'kalm-favorites';
const RECENT_KEY = 'kalm-recent';
const ALBUM_CACHE_KEY = 'kalm-albums';
const RECENT_LIMIT = 8;
const ALBUM_CACHE_LIMIT = 40;

// Keys written before the rename from Sonora. Copied across once so the rename
// did not silently discard an existing collection.
const LEGACY_KEYS = {
  [FAVORITES_KEY]: 'sonora-favorites',
  [RECENT_KEY]: 'sonora-recent',
  [ALBUM_CACHE_KEY]: 'sonora-albums'
};

function migrateLegacyStorage(){
  for (const [current, legacy] of Object.entries(LEGACY_KEYS)) {
    if (localStorage.getItem(current) !== null) continue;
    const old = localStorage.getItem(legacy);
    if (old === null) continue;
    localStorage.setItem(current, old);
    localStorage.removeItem(legacy);
  }
}

const state = {
  view: 'discover',
  tab: 'top',
  favorites: new Set(),
  recent: [],
  // Seeded by loadShelves; kept so the catalogue payload is reused.
  discoverRows: null,
  search: { artists: [], tracks: [], albums: [], top: [] }
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escapeHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The breadcrumb is gone: always-visible nav tabs make it redundant for
// navigation, and the album and artist pages already carry their own title and
// a Back button.

/* ------------------------------------------------------- status announcing */
// One polite live region for the whole app. Per-view regions are announced
// unreliably and duplicate content across views, so every status change funnels
// through here instead.
function announce(message){
  const region = $('#liveStatus');
  if (!region) return;
  // Reassigning identical text does not re-announce, so clear first.
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message || ''; }, 40);
}

/* ------------------------------------------------------------- art helpers */
// Deezer always returns artwork for its catalogue, but keep a graceful fallback.
function artHtml(image, title, extraClass){
  const base = extraClass || 'album-art';
  return image
    ? `<img class="${base}" src="${escapeHtml(image)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
    : `<div class="${base} art-placeholder" role="img" aria-label="No artwork"></div>`;
}

// Fade covers in once decoded so a grid settles rather than flashing.
//
// Each image is marked .art-pending immediately before its load handler is bound,
// and .is-loaded clears it. CSS only hides .art-pending, so a render path that
// forgets this call degrades to an instant-loading image rather than an invisible
// one. That previously bit the expanded cover view, which injected an <img>
// directly and never called this.
function revealArt(root){
  const scope = root || document.body || document;
  $$('img.album-art, img.result-thumb, img.artist-photo, img.disco-art, img.shelf-art, img.related-photo, img.video-thumb', scope).forEach(img => {
    if (img.dataset.revealBound) return;
    img.dataset.revealBound = '1';
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('is-loaded');
      return;
    }
    img.classList.add('art-pending');
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    // An image that fails must not stay invisible; the placeholder path handles
    // the missing-artwork case.
    img.addEventListener('error', () => img.classList.add('is-loaded'), { once: true });
  });
}

/* -------------------------------------------------------------- navigation */
function navGroupFor(view){
  if (view === 'results' || view === 'album' || view === 'artist') return 'discover';
  if (view === 'collection') return state.collectionType || 'favorites';
  return view;
}

// Derived from state rather than left to the markup, so it cannot disagree with
// the view actually on screen. Boot calls this too: the initial Discover tab is
// hardcoded in the HTML as a pre-script default, not as the source of truth.
function syncNavTabs(view){
  const group = navGroupFor(view);
  $$('.nav-tab').forEach(n => {
    const active = n.dataset.view === group;
    n.classList.toggle('active', active);
    // aria-current is what actually communicates selection to assistive tech;
    // the class only carries the styling.
    if (active) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
}

function show(view){
  state.view = view;
  $$('.view').forEach(v => v.classList.remove('active-view'));
  const section = $('#' + view + 'View');
  if (section) {
    section.classList.add('active-view');
    section.classList.remove('view-enter');
    void section.offsetWidth;
    section.classList.add('view-enter');
  }
  syncNavTabs(view);
  if (view === 'discover') renderDiscover();
  // The drift only ever runs on Browse, and renderDiscover restarts it, so
  // leaving that view should stop the timer outright rather than leave it
  // idling against a hidden host.
  else if (view === 'collection') stopShelfDrift();
}

// Staggers children so grids and lists cascade in. Capped so long lists stay quick.
function stagger(container){
  if (!container) return;
  const items = [...container.children];
  const step = Math.min(40, 400 / Math.max(items.length, 1));
  items.forEach((el, i) => {
    el.classList.add('stagger-item');
    el.style.setProperty('--stagger-delay', Math.round(i * step) + 'ms');
  });
}

/* ------------------------------------------------------------------ storage */
function readList(key, fallback){
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeList(key, value){
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Storage can be unavailable; the UI still works without persistence.
  }
}

function readObjectMap(key){
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeObjectMap(key, value){
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Storage can be unavailable; the UI still works without persistence.
  }
}

// Album summaries cached so Favorites and Recently viewed render on reload
// without waiting on the network.
//
// Cache keys are prefixed with 'a' so they are not integer-like. Plain Deezer IDs
// are all-digit strings, and Object.keys returns integer-like keys in ascending
// NUMERIC order rather than insertion order, which made eviction keep the largest
// IDs instead of the newest and silently drop saved albums.
//
// Bump ALBUM_CACHE_VERSION whenever the /api/album payload shape changes.
// Cached payloads are stored verbatim and a hit suppresses the refetch, so a
// changed shape would otherwise strand every already-visited album on the old
// data until LRU pressure happened to evict it. Because a renderer reading an
// absent field gets an empty string rather than an error, that failure is silent
// and looks like a styling fault.
const ALBUM_CACHE_VERSION = 2;
const CACHE_PREFIX = 'a';
const cacheKey = id => CACHE_PREFIX + id;
const bareKey = key => key.startsWith(CACHE_PREFIX) ? key.slice(CACHE_PREFIX.length) : key;

const albumCache = readObjectMap(ALBUM_CACHE_KEY);

// Re-key any entries written before the prefix existed, otherwise every saved
// album cached by an earlier build would read as a cache miss. Must run after
// cacheKey/bareKey are declared, which are used here.
let migratedCache = false;
Object.keys(albumCache).forEach(key => {
  if (key.startsWith(CACHE_PREFIX)) return;
  albumCache[cacheKey(bareKey(key))] = albumCache[key];
  delete albumCache[key];
  migratedCache = true;
});

// IDs that must never be evicted, regardless of cache pressure.
function pinnedIds(){
  return new Set([...state.favorites, ...state.recent].map(String));
}

// Evict least-recently-used entries that are not saved or in history.
function evictCache(){
  const keys = Object.keys(albumCache);
  if (keys.length <= ALBUM_CACHE_LIMIT) return;
  const pinned = pinnedIds();
  const drop = [];
  let excess = keys.length - ALBUM_CACHE_LIMIT;
  for (const key of keys) {
    if (excess <= 0) break;
    if (pinned.has(bareKey(key))) continue;
    drop.push(key);
    excess--;
  }
  drop.forEach(k => delete albumCache[k]);
}

function cacheAlbum(id, album){
  if (!id || !album) return;
  const key = cacheKey(id);
  // Delete first so re-caching moves the entry to the most-recent end.
  delete albumCache[key];
  // Wrapped rather than stamped onto the payload, so the cached value stays
  // identical to what the server sent and no client-only field can reach a
  // renderer.
  albumCache[key] = { v: ALBUM_CACHE_VERSION, album };
  evictCache();
  scheduleCacheWrite();
}

// Serialising the whole cache on every call was wasteful: the Discover shelves
// call this once per item. Coalesce the writes instead.
let cacheWriteTimer = null;
function scheduleCacheWrite(){
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null;
    writeList(ALBUM_CACHE_KEY, albumCache);
  }, 250);
}

function cachedAlbum(id){
  const key = cacheKey(id);
  const entry = albumCache[key];
  if (!entry) return null;
  // Entries written before versioning existed have no wrapper at all, so they
  // fail the check and are discarded rather than rendered.
  if (entry.v !== ALBUM_CACHE_VERSION || !entry.album) {
    delete albumCache[key];
    scheduleCacheWrite();
    return null;
  }
  return entry.album;
}

/* ------------------------------------------------------------ card renderers */
function card(album){
  if (!album) return '';
  const title = album.title || 'Untitled release';
  const artist = album.artist || 'Unknown artist';
  // A real <button>, not an <article>: cards are navigation targets, and a
  // click handler alone leaves them unreachable by keyboard.
  return `<button class="album-card" data-album="${escapeHtml(album.id)}" aria-label="${escapeHtml(artist + ' — ' + title)}">
      ${artHtml(album.image, title)}
      <div class="album-meta"><strong>${escapeHtml(artist)}</strong><span>${escapeHtml(title)}</span></div>
    </button>`;
}

function cardsFor(albums){
  return albums.filter(Boolean).map(card).join('');
}

/* --------------------------------------------------------------- discover */
/* -------------------------------------------------------- the catalogue index

   The front door. A feed asks you to scroll; a catalogue lets you look
   something up, so this is a finite, ordered, text-first list rather than
   carousels of square covers.

   Its contents are the discover pool plus every album this browser has saved
   or opened, resolved out of albumCache. favorites and recent are stored as
   bare id lists, so the cache is the only place a full payload can come from.
   That means the index grows as it is used and needs no server support. */

function renderDiscover(){
  const grid = $('#recentAlbums');
  const ids = state.recent.map(String);
  const albums = ids.map(cachedAlbum).filter(Boolean);
  const missing = ids.filter(id => !cachedAlbum(id));
  // The heading is hidden until there is history, so a first-time visitor does
  // not see an empty "Jump back in" section above the shelves.
  $('#recentHeading').hidden = ids.length === 0;
  grid.innerHTML = ids.length
    ? cardsFor(albums) + missing.map(id => missingCard(id)).join('')
    : '';
  // Bento spans: every third tile (0, 3, 6, ...) is wide; the rest are normal.
  // Classes are additive - .album-card and its content markup are untouched.
  const canWide = grid.querySelectorAll('.album-card').length % 3 === 0;
  grid.querySelectorAll('.album-card').forEach((card, i) => {
    card.classList.add('bento-tile');
    if (canWide && i % 3 === 0) card.classList.add('bento-wide');
  });
  stagger(grid);
  revealArt(grid);
  if (missing.length) resolveMissingAlbums(missing, 'recent');
}

/* --------------------------------------------------- discover carousels */
const SHELF_PAGE = 5;
// Declared here rather than beside the cover tilt, because the ambient shelf
// drift below is the first thing to read it and a const in the temporal dead
// zone would throw on load.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function shelfCard(item, kind){
  if (kind === 'artist') {
    // Deezer's artist chart supplies no fan or album count, so this shows the
    // chart position rather than a hard "0 fans" from a field that is never
    // populated.
    const rank = item.position ? 'No. ' + item.position : '';
    return `<button class="shelf-card round" data-artist="${escapeHtml(item.id)}" data-artist-name="${escapeHtml(item.name)}">
        ${artHtml(item.image, item.name, 'shelf-art')}
        <span class="shelf-title-line"><span class="shelf-name">${escapeHtml(item.name)}</span></span>
        <span class="shelf-sub">${escapeHtml(rank)}</span>
      </button>`;
  }
  if (kind === 'track') {
    const duration = item.duration
      ? Math.floor(item.duration / 60) + ':' + String(item.duration % 60).padStart(2, '0')
      : '';
    return `<button class="shelf-card" data-album="${escapeHtml(item.album_id)}">
        ${artHtml(item.image, item.title, 'shelf-art')}
        <span class="shelf-title-line">
          <span class="shelf-name">${escapeHtml(item.title)}</span>
          ${item.explicit ? '<span class="explicit" title="Explicit">E</span>' : ''}
        </span>
        <span class="shelf-sub">${escapeHtml([duration, item.artist].filter(Boolean).join(' · '))}</span>
      </button>`;
  }
  const sub = [item.year, item.record_type].filter(Boolean).join(' · ');
  return `<button class="shelf-card" data-album="${escapeHtml(item.id)}">
      ${artHtml(item.image, item.title, 'shelf-art')}
      <span class="shelf-title-line">
        <span class="shelf-name">${escapeHtml(item.title)}</span>
        ${item.explicit ? '<span class="explicit" title="Explicit">E</span>' : ''}
      </span>
      <span class="shelf-sub">${escapeHtml(sub || item.artist)}</span>
    </button>`;
}

function renderShelves(rows){
  const host = $('#discoverRows');
  if (!rows || !rows.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = rows.map((row, i) => `
    <section class="shelf" data-shelf="${i}" data-kind="${escapeHtml(row.kind || '')}">
      <div class="shelf-head">
        <h2 class="shelf-title">${escapeHtml(row.title)}</h2>
        <div class="shelf-controls">
          <button class="shelf-arrow" data-dir="-1" aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <button class="shelf-arrow" data-dir="1" aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
      <div class="shelf-track">
        ${row.items.map(item => shelfCard(item, row.kind)).join('')}
      </div>
    </section>`).join('');
  // Cache albums so clicking a carousel card then going back still resolves it.
  rows.filter(r => r.kind === 'album').forEach(r => {
    r.items.forEach(item => { if (item.id && item.title) cacheAlbum(item.id, item); });
  });
  revealArt(host);
  syncShelfArrows();
  startShelfDrift();
  // Artwork loading changes the scroll width, so observe each track and keep
  // the arrow states honest as that happens.
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => syncShelfArrows());
    $$('.shelf-track', host).forEach(t => observer.observe(t));
  }
}

/* ------------------------------------------------------- ambient shelf drift
   Shelves creep along on their own so the page does not read as a still image.
   One requestAnimationFrame loop drives every shelf rather than one timer each,
   because per-shelf loops with independent pause state are how you end up with
   one row creeping while someone reads another.

   Two things had to be true before this looked like drift at all:

   1. Continuous motion, not steps. An earlier version fired scrollTo() every 7s
      by one card width, which read as a slideshow: shift, pause, shift.
   2. Snap suspended while moving. scroll-snap-type: x proximity quantises every
      scroll position to a card boundary, so a smooth per-frame increment gets
      yanked back to the nearest card and the row moves one card at a time
      regardless of how small the increment is. Snap is therefore switched off
      for the duration of the drift and restored on pause, which keeps the arrow
      buttons feeling crisp.

   Each shelf ping-pongs, so there is no terminal state to get stuck at. Speeds
   differ per shelf so the two long shelves never move in lockstep.

   Pausing is invisible and there is no button: hovering a shelf or tabbing into
   one holds everything, which stops a row sliding out from under the reader.
   Reduced motion never starts it at all.

   Only the album and track rows drift. "Artists to know" is a ranked chart with
   No. 1 / No. 2 labels and stays put, moved with the arrows, because a ranked
   list reads as something to consult rather than a feed to browse. */
const SHELF_DRIFT_SPEEDS = { album: 45, track: 55 };   // px per second, by kind
let shelfDriftFrame = null;
let shelfDriftLast = 0;

// Only the album and track rows drift. "Artists to know" is a ranked chart with
// No. 1 / No. 2 labels, and a ranked list reads as something to consult rather
// than a feed to browse, so it stays put and is moved with the arrows. Excluded
// by kind rather than by index, so it does not matter what order the rows come
// back from Deezer in.
function driftingShelves(){
  return $$('#discoverRows .shelf').filter(
    shelf => SHELF_DRIFT_SPEEDS[shelf.dataset.kind] != null
  );
}

// Snap is what made the old version look like steps, so it is suspended while
// the row is actually moving.
function setShelfSnapping(track, on){
  track.style.scrollSnapType = on ? '' : 'none';
}

function shelvesIdle(){
  if (reducedMotion.matches) return false;
  if (state.view !== 'discover') return false;
  const host = $('#discoverRows');
  if (!host || !host.offsetParent) return false;
  if (host.querySelector('.shelf:hover') || host.querySelector('.shelf:focus-within')) return false;
  return true;
}

function stepShelves(now){
  const shelves = driftingShelves();
  if (!shelves.length) return;
  // Pure deltaTime: the same distance per millisecond on 60Hz, 144Hz or any
  // other rate. The 50ms value is now a per-frame ceiling rather than a tick
  // gate, so it still stops a backgrounded tab resuming with a huge jump but
  // no longer quantises the drift to a 20fps grid.
  const dt = Math.min(50, now - shelfDriftLast) / 1000;
  shelfDriftLast = now;

  shelves.forEach(shelf => {
    const track = shelf.querySelector('.shelf-track');
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    if (max <= 4) return;
    const speed = SHELF_DRIFT_SPEEDS[shelf.dataset.kind];
    if (track.dataset.driftDir !== '-1') track.dataset.driftDir = '1';
    let dir = Number(track.dataset.driftDir);
    let next = track.scrollLeft + dir * speed * dt;
    if (next >= max) { dir = -1; next = max; }
    else if (next <= 0) { dir = 1; next = 0; }
    track.dataset.driftDir = String(dir);
    track.scrollLeft = next;
  });
}

function shelfDriffLoop(now){
  if (reducedMotion.matches) return;
  shelfDriftFrame = window.requestAnimationFrame(shelfDriffLoop);
  // Only the drifting shelves have their snap touched. The static artist row is
  // never suspended, so its arrows keep snapping normally at all times.
  if (!shelvesIdle()) {
    driftingShelves().forEach(s => {
      const track = s.querySelector('.shelf-track');
      if (track) setShelfSnapping(track, true);
    });
    shelfDriftLast = now;
    return;
  }
  driftingShelves().forEach(s => {
    const track = s.querySelector('.shelf-track');
    if (track) setShelfSnapping(track, false);
  });
  stepShelves(now);
}

function startShelfDrift(){
  stopShelfDrift();
  if (reducedMotion.matches) return;
  shelfDriftLast = performance.now();
  shelfDriftFrame = window.requestAnimationFrame(shelfDriffLoop);
}

function stopShelfDrift(){
  if (shelfDriftFrame) window.cancelAnimationFrame(shelfDriftFrame);
  shelfDriftFrame = null;
}

// Track width changes as artwork loads, so keep the arrows in step.
function syncShelfArrows(){
  $$('.shelf').forEach(shelf => {
    const track = shelf.querySelector('.shelf-track');
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    const [left, right] = shelf.querySelectorAll('.shelf-arrow');
    // While artwork is still loading scrollWidth is unreliable, so disable both
    // rather than latching one into a wrong state.
    if (max <= 4) {
      left.disabled = true;
      right.disabled = true;
      return;
    }
    left.disabled = track.scrollLeft <= 4;
    right.disabled = track.scrollLeft >= max - 4;
  });
}

$('#discoverRows').addEventListener('click', e => {
  const arrow = e.target.closest('.shelf-arrow');
  if (!arrow) return;
  const track = arrow.closest('.shelf').querySelector('.shelf-track');
  // Advance by a whole "page" of cards rather than a fixed pixel distance.
  const card = track.querySelector('.shelf-card');
  const step = card ? (card.offsetWidth + 16) * SHELF_PAGE : track.clientWidth * 0.8;
  track.scrollBy({ left: step * Number(arrow.dataset.dir), behavior: 'smooth' });
});

$('#discoverRows').addEventListener('scroll', e => {
  if (!e.target.classList.contains('shelf-track')) return;
  syncShelfArrows();
  // Re-sync rather than stop. A hand-scrolled shelf means the reader is browsing
  // that row, so the drift resumes from where they left it and keeps its own
  // direction. The earlier version latched off permanently here, which is part
  // of why the shelves looked dead.
}, true);

/* Discover fallback. When /api/discover is unreachable or comes back empty,
   degrade to a hardcoded pool of Deezer artist IDs for the era the shelves are
   curated around - 70s/80s progressive rock, classic rock, progressive pop -
   rather than to empty shelves. Names ship with the IDs so the cards render
   without a round trip; artwork is deliberately left empty so artHtml() shows
   the placeholder tile and the real photo loads when the artist page opens.
   IDs resolved against the Deezer API. */
const DISCOVER_FALLBACK_ARTISTS = [
  { id: '860', name: 'Pink Floyd' },
  { id: '1994', name: 'King Crimson' },
  { id: '2711', name: 'Yes' },
  { id: '3037', name: 'Genesis' },
  { id: '8686', name: 'Rush' },
  { id: '848', name: 'Led Zeppelin' },
  { id: '847', name: 'The Doors' },
];

function fallbackDiscoverRows(){
  return [{
    title: 'Artists to know',
    kind: 'artist',
    items: DISCOVER_FALLBACK_ARTISTS.map(a => ({ id: a.id, name: a.name, image: '' })),
  }];
}

async function loadShelves(){
  const host = $('#discoverRows');
  host.innerHTML = '<div class="shelf-skeleton"></div><div class="shelf-skeleton" style="margin-top:16px"></div>';
  try {
    const response = await fetch('/api/discover');
    const data = await response.json();
    state.discoverRows = data.rows || [];
  } catch (error) {
    state.discoverRows = [];
  }
  // A failed or empty feed degrades to the curated artist fallback rather
  // than to empty shelves.
  if (!state.discoverRows.length) {
    state.discoverRows = fallbackDiscoverRows();
  }
  renderShelves(state.discoverRows);
}

/* ---------------------------------------------------------------- search */
function trackRow(track){
  const sub = [track.album, track.artist].filter(Boolean).join(' · ');
  const duration = track.duration
    ? Math.floor(track.duration / 60) + ':' + String(track.duration % 60).padStart(2, '0')
    : '';
  return `<div class="result-row" data-album="${escapeHtml(track.album_id)}">
      ${artHtml(track.image, track.title, 'result-thumb')}
      <div class="result-text">
        <button class="result-title" data-album="${escapeHtml(track.album_id)}">${escapeHtml(track.title)}</button>
        <div class="result-sub"><button class="inline-link" data-artist="${escapeHtml(track.artist_id)}" data-artist-name="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button></div>
      </div>
      <span class="result-kind">Track</span>
      <span class="result-meta">${escapeHtml(duration)}</span>
    </div>`;
}

function albumRow(album){
  return `<div class="result-row" data-album="${escapeHtml(album.id)}">
      ${artHtml(album.image, album.title, 'result-thumb')}
      <div class="result-text">
        <button class="result-title" data-album="${escapeHtml(album.id)}">${escapeHtml(album.title)}</button>
        <div class="result-sub"><button class="inline-link" data-artist="${escapeHtml(album.artist_id)}" data-artist-name="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button></div>
      </div>
      <span class="result-kind">${escapeHtml(album.type || 'Album')}</span>
      <span class="result-meta">${escapeHtml(album.year || '')}</span>
    </div>`;
}

function artistRow(artist){
  // data-artist-row, not data-artist: rows are navigable targets, while
  // data-artist is reserved for inline links so the two do not collide.
  return `<div class="result-row" data-artist-row="${escapeHtml(artist.id)}" data-artist-name="${escapeHtml(artist.name)}">
      ${artHtml(artist.image, artist.name, 'result-thumb round')}
      <div class="result-text">
        <button class="result-title" data-artist-row="${escapeHtml(artist.id)}" data-artist-name="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</button>
        <div class="result-sub">Artist · ${Number(artist.nb_album || 0).toLocaleString()} albums</div>
      </div>
      <span class="result-kind">Artist</span>
      <span class="result-meta">${compactNumber(artist.nb_fan)} fans</span>
    </div>`;
}

function compactNumber(n){
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
  return String(v);
}

const TABS = [
  ['top', 'Top results'],
  ['artists', 'Artists'],
  ['tracks', 'Tracks'],
  ['albums', 'Albums']
];

function currentResults(){
  const s = state.search;
  return s[state.tab] || [];
}

function renderResults(){
  const list = currentResults();
  const container = $('#resultsList');
  const counts = {
    top: state.search.top.length,
    artists: state.search.artists.length,
    tracks: state.search.tracks.length,
    albums: state.search.albums.length
  };

  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  TABS.forEach(([key, label]) => {
    const btn = $('.tab[data-tab="' + key + '"]');
    if (btn) btn.querySelector('.tab-count').textContent = counts[key];
  });

  let markup;
  if (!list.length) {
    markup = '<div class="empty">Nothing here. Try another search.</div>';
  } else if (state.tab === 'artists') {
    markup = list.map(artistRow).join('');
  } else if (state.tab === 'tracks') {
    markup = list.map(trackRow).join('');
  } else if (state.tab === 'albums') {
    markup = list.map(albumRow).join('');
  } else {
    markup = list.map(item =>
      item.kind === 'artist' ? artistRow(item)
      : item.kind === 'track' ? trackRow(item)
      : albumRow(item)).join('');
  }
  container.innerHTML = markup;
  stagger(container);
  revealArt(container);
}

async function search(query){
  const q = query.trim();
  if (!q) return;
  const token = beginNav();
  $('#resultsTitle').textContent = q;
  $('#resultsSubtitle').textContent = 'Searching Deezer';
  $('#resultsList').innerHTML = '<div class="empty">Searching…</div>';
  announce('Searching for ' + q);
  show('results');
  try {
    const response = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await response.json();
    if (navStale(token)) return;
    if (data.error) throw new Error(data.error);
    state.search = {
      artists: data.artists || [],
      tracks: data.tracks || [],
      albums: data.albums || [],
      top: data.top || []
    };
    // Remember albums so they can appear in the collection views later.
    state.search.albums.slice(0, 20).forEach(a => cacheAlbum(a.id, a));
    $('#resultsSubtitle').textContent = state.search.top.length
      ? 'From Deezer'
      : 'No matches in the Deezer catalog';
    const counts = [`${state.search.artists.length} artists`,
      `${state.search.albums.length} albums`,
      `${state.search.tracks.length} tracks`];
    announce(state.search.top.length
      ? `${state.search.top.length} results for ${q}: ${counts.join(', ')}.`
      : `No matches for ${q}.`);
  } catch (error) {
    state.search = { artists: [], tracks: [], albums: [], top: [] };
    $('#resultsSubtitle').textContent = 'Search failed. Is the local API server running?';
    announce('Search failed. The local API server may not be running.');
  }
  renderResults();
}

/* ----------------------------------------------------------- album detail */
/* A slow album or artist load must not hijack navigation: if the user has
   already moved on by the time the response lands, the result is discarded. */
let navToken = 0;
function beginNav(){ return ++navToken; }
function navStale(token){ return token !== navToken; }

async function openAlbum(id, retry){
  if (!id) return;
  const token = beginNav();
  if (!retry) pushRecent(id);
  show('album');
  $('#albumView .page').innerHTML = '<div class="empty">Loading album…</div>';
  announce('Loading album');

  let album = cachedAlbum(id);
  if (!album || !album.tracks) {
    try {
      const response = await fetch('/api/album?id=' + encodeURIComponent(id));
      const data = await response.json();
      if (navStale(token)) return;
      if (data.error || !data.album) throw new Error(data.error || 'not found');
      album = data.album;
      cacheAlbum(id, album);
    } catch (error) {
      if (navStale(token)) return;
      // A dead end is not a recovery path: say what failed, why it might have,
      // and offer the one action that can help.
      $('#albumView .page').innerHTML = `<div class="page-heading"><h1>Unavailable</h1></div>
        <div class="empty">This release could not be loaded.</div>
        <div class="error-recovery">
          <button class="action-button" data-retry-album="${escapeHtml(id)}">Try again</button>
          <button class="action-button secondary" data-back>← Back</button>
        </div>`;
      announce('This release could not be loaded. A retry button is available.');
      return;
    }
  }
  if (navStale(token)) return;
  $('#albumView .page').innerHTML = albumPage(album);
  revealArt($('#albumView .page'));
  typeTitle($('#albumTitle'));
  bindCoverExpand(album);
  show('album');
  announce(`${album.title} by ${album.artist}. ${(album.tracks || []).length} tracks.`);
  // Not awaited: the album page is complete without it, and this is the one
  // call on the page that depends on a third party.
  loadVideos(album, token);
}

/* --------------------------------------------------- typewriter album title

   This used to be a pure-CSS reveal: one opacity-animated span per character,
   staggered by animation-delay, every span occupying its layout space from t=0
   so nothing below it ever moved. That part worked and was verified. The caret
   did not, and it was the thing you actually see.

   The caret was a single inline-block appended after the LAST span, so it was
   pinned to the right-hand edge of the finished title for the entire run and
   never travelled with the text. Measured mid-run on "In Rainbows": at t=800ms
   the visible characters ended at x=53 while the caret sat at x=172 - 119px to
   the right of the character actually being typed. Before the first character
   landed there was a 450ms window in which the only thing on screen was a
   stray bar floating in the title's future space.

   Driving the reveal from a timer instead fixes that for free, because the caret
   is inserted before each new character and therefore always sits immediately
   after the last one typed. Two other things improve with it:

   - Characters are plain text nodes rather than one span apiece, so line
     breaking is ordinary text breaking. The measurement that previously forced
     the spans to stay display:inline - a 48-character word wrapping to 5 lines
     as inline-block - no longer constrains anything, because there are no boxes
     at all to make breakable.
   - Nothing is waiting on a keyframe. At any instant the heading contains
     exactly the characters typed so far, so a dropped frame or a stalled
     animation cannot leave a title stuck half-invisible.

   The trade is deliberate and worth stating: the title now grows as it types, so
   content below shifts during the run. That is what a typewriter does, it is
   bounded by the same ~2s cap, and the hero's text column is a grid track with
   min-width:0, so a long unbroken title cannot widen the layout.

   Array.from, not split(''), so an accented character is not cut in half. The
   characters go in as text nodes, so no escaping question arises at all.

   aria-label on the <h1> carries the full title, so assistive tech reads the
   whole thing regardless of how far the run has got.

   Re-entrancy: opening a second album while a run is still going must not leave
   the old timer appending characters to a heading that has been replaced. The
   token below retires the previous run, and tick() also bails if the node was
   torn out of the document by a view change. */
let typeRunToken = 0;

function typeTitle(el){
  if (!el) return;
  const full = el.getAttribute('aria-label') || el.textContent;
  // Handled here rather than by the stylesheet's global duration override,
  // because the reveal is no longer an animation. A plain return leaves the
  // heading as the server-rendered markup already had it: the whole title.
  if (reducedMotion.matches) return;

  const token = ++typeRunToken;
  const chars = Array.from(full);
  // Slower than the first pass, which typed 11 characters in 495ms starting at
  // t=0 - i.e. entirely underneath the 320ms viewIn fade, so it was never
  // actually seen. The run is capped near 2s and held back until the page has
  // finished settling.
  const step = Math.min(75, Math.round(2000 / Math.max(chars.length, 1)));
  // Outlasts the 320ms viewIn fade. The first character also waits one more step
  // so the caret is the first thing to appear, sitting at position zero.
  const startDelay = 450;

  el.textContent = '';
  const caret = document.createElement('span');
  caret.className = 'type-caret';
  caret.setAttribute('aria-hidden', 'true');
  el.appendChild(caret);

  let i = 0;
  const finish = () => { if (token === typeRunToken) caret.remove(); };
  const tick = () => {
    if (token !== typeRunToken || !el.isConnected) return;
    // Checked before the insert, and the caret is only ever removed from inside
    // this branch. A separate timer used to do the removal, which raced the run:
    // once the caret left the tree, the next tick's insertBefore(caret) had a
    // detached reference and threw, silently truncating the title. Measured that
    // way, "In Rainbows" stopped at "In Rainbo".
    if (i >= chars.length) { finish(); return; }
    el.insertBefore(document.createTextNode(chars[i]), caret);
    i += 1;
    window.setTimeout(tick, step);
  };

  window.setTimeout(tick, startDelay + step);
}

function albumPage(a){
  const title = a.title || 'Untitled release';
  const artist = a.artist || 'Unknown artist';
  const saved = state.favorites.has(a.id);
  const genres = (a.genre || '').split(',').map(s => s.trim()).filter(Boolean);
  const duration = a.duration
    ? Math.floor(a.duration / 60) + ' min'
    : '';
  const facts = [
    ['Artist', `<button class="inline-link strong" data-artist="${escapeHtml(a.artist_id || '')}" data-artist-name="${escapeHtml(artist)}">${escapeHtml(artist)}</button>`],
    ['Released', escapeHtml(a.year || 'Undated')],
    ['Label', escapeHtml(a.label || 'Unknown label')],
    ['Format', escapeHtml([a.type, a.nb_tracks ? a.nb_tracks + ' tracks' : null].filter(Boolean).join(' · ') || 'Release')],
    ['Genre', genres.length ? genres.map(g => `<span class="fact-tag">${escapeHtml(g)}</span>`).join('') : 'Not tagged'],
    ['Runtime', escapeHtml(duration || '—')],
    ['Source', 'Deezer']
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

  const tracks = (a.tracks || []).filter(Boolean);
  const trackRows = tracks.length
    ? tracks.map(t => `<div class="track"><span class="track-number">${escapeHtml(t[0])}</span><span class="track-name">${escapeHtml(t[1])}</span><span class="track-credit">${escapeHtml(t[2] || '')}</span></div>`).join('')
    : '<div class="empty compact">Tracklist is not available for this release.</div>';

  // The hero cover is this page's largest contentful paint and competes with up
  // to 120 lazy carousel images for bandwidth, so it is the one image here that
  // should not be lazy and should ask for priority.
  const heroArt = a.image
    ? `<img class="album-art" src="${escapeHtml(a.image)}" alt="${escapeHtml(title)}" decoding="async" fetchpriority="high">`
    : artHtml('', title, 'album-art');

  const creditGroups = Object.entries(a.credits || {}).filter(([, items]) => items && items.length);
  const creditMarkup = creditGroups.length
    ? `<div class="credits-grid">${creditGroups.map(([group, items]) =>
        `<div class="credit-group"><h3>${escapeHtml(group)}</h3>${items.map(x => `<p>${escapeHtml(x)}</p>`).join('')}</div>`).join('')}</div>`
    : '<div class="empty compact">Detailed credits are not published for this release.</div>';

  const related = (a.related || []).filter(Boolean);
  const relatedMarkup = related.length
    ? `<div class="related-grid">${related.map(x => `<button class="related-card" data-artist="${escapeHtml(x.id)}">
            ${artHtml(x.image, x.name, 'related-photo')}
            <span class="related-name">${escapeHtml(x.name)}</span>
            <span class="related-sub">${compactNumber(x.nb_fan)} fans</span>
          </button>`).join('')}</div>`
    : '';

  return `<div class="album-hero">
      ${a.image
        ? `<div class="hero-cover">
             <button class="cover-expand" id="coverExpand" aria-label="Expand cover of ${title}">
               ${heroArt}
               <span class="cover-expand-hint" aria-hidden="true">
                 <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                 </svg>
               </span>
             </button>
             <span class="vinyl" aria-hidden="true"></span>
           </div>`
        : artHtml('', title, 'album-art')}
      <div class="album-hero-text">
        <p class="eyebrow">${escapeHtml(a.type || 'Album')}${a.year ? ' · ' + escapeHtml(a.year) : ''}</p>
        <h1 class="album-title" id="albumTitle" aria-label="${escapeHtml(title)}">${escapeHtml(title)}</h1>
        <button class="album-artist" data-artist="${escapeHtml(a.artist_id || '')}" data-artist-name="${escapeHtml(artist)}">${escapeHtml(artist)}</button>
        <table class="album-facts"><tbody>${facts}</tbody></table>
        <div class="album-actions">
          <button class="action-button" id="favoriteButton" data-album="${escapeHtml(a.id)}">${saved ? '♥ Saved' : '♡ Save album'}</button>
          <button class="action-button secondary" data-back>← Back</button>
        </div>
      </div>
    </div>
    <div class="album-body">
      <section><h2>Tracklist</h2><div class="track-list">${trackRows}</div></section>
      <section><div class="section-heading"><div><h2>Credits</h2></div></div>${creditMarkup}</section>
      <div id="videoSlot"></div>
      ${relatedMarkup ? `<section><div class="section-heading"><div><h2>Similar artists</h2></div></div>${relatedMarkup}</section>` : ''}
    </div>`;
}

/* ------------------------------------------------------------ album videos */
/* Videos are fetched after the page renders rather than bundled into /api/album.
   The search is slow and depends on a third party, and video search is never
   worth delaying artwork, tracklist or credits for. If it comes back empty the
   slot renders nothing at all, matching how missing artwork and credits behave. */
const VIDEO_KEY = 'kalm-videos';
// Same reasoning as ALBUM_CACHE_VERSION: the cache is trusted over a refetch, so
// a change to the /api/videos payload shape would strand old entries instead of
// correcting them.
const VIDEO_CACHE_VERSION = 1;

function formatDuration(seconds){
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function videoCard(v){
  const meta = [v.channel, v.views ? compactNumber(v.views) + ' views' : ''].filter(Boolean).join(' · ');
  return `<button class="video-card" data-video="${escapeHtml(v.id)}" data-title="${escapeHtml(v.title)}">
      <span class="video-poster">
        <img class="video-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" decoding="async" />
        <span class="video-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
        ${v.duration ? `<span class="video-duration">${formatDuration(v.duration)}</span>` : ''}
      </span>
      <span class="video-name">${escapeHtml(v.title)}</span>
      <span class="video-meta">${escapeHtml(meta)}</span>
    </button>`;
}

async function loadVideos(album, token){
  const slot = $('#videoSlot');
  if (!slot || !album || !(album.artist || album.title)) return;
  const key = `${album.artist}|${album.title}`;

  // Cached for the session so re-opening an album does not re-hit the provider.
  // An empty result caches as [] too, and [] is truthy, so a genuine "no videos"
  // is remembered without being re-queried on every visit.
  const entry = readObjectMap(VIDEO_KEY)[key];
  let videos = entry && entry.v === VIDEO_CACHE_VERSION ? entry.videos : null;
  if (!videos) {
    slot.innerHTML = '<div class="video-pending"><span class="eyebrow">Looking for videos</span></div>';
    try {
      const response = await fetch('/api/videos?artist=' + encodeURIComponent(album.artist || '')
        + '&title=' + encodeURIComponent(album.title || ''));
      const data = await response.json();
      if (navStale(token)) return;
      videos = data.videos || [];
      writeObjectMap(VIDEO_KEY, { ...readObjectMap(VIDEO_KEY), [key]: { v: VIDEO_CACHE_VERSION, videos } });
    } catch (error) {
      if (navStale(token)) return;
      videos = [];
    }
  }

  if (navStale(token) || !$('#videoSlot')) return;
  if (!videos.length) { $('#videoSlot').innerHTML = ''; return; }
  announce(`${videos.length} videos for ${album.title}`);

  $('#videoSlot').innerHTML = `<section>
      <div class="section-heading"><div><h2>Videos</h2></div></div>
      <div class="video-grid">${videos.map(videoCard).join('')}</div>
    </section>`;
  revealArt($('#videoSlot'));
}

/* Clicking a poster swaps in the player rather than mounting four up front:
   nothing is requested from Google until the reader actually asks to watch. The
   original markup is parked on the element so closing restores exactly what was
   there, which avoids rebuilding the card from data attributes and drifting out
   of sync with videoCard(). */
function playVideo(card){
  const id = card.dataset.video;
  if (!id || card.classList.contains('is-playing')) return;
  card.classList.add('is-playing');
  card.dataset.posterHtml = card.innerHTML;
  card.innerHTML = `<iframe class="video-frame"
      src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0"
      title="${escapeHtml(card.dataset.title || 'Video')}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
    <span class="video-close" role="button" tabindex="0" aria-label="Close video">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </span>`;
}

function closeVideo(card){
  if (!card || !card.classList.contains('is-playing')) return;
  const poster = card.dataset.posterHtml || '';
  // Clearing first drops the iframe, which stops playback immediately.
  card.classList.remove('is-playing');
  card.innerHTML = poster;
  revealArt(card);
}

/* ------------------------------------------------------- expanded cover */
/* Clicking the hero cover opens a large centred view in a native <dialog>. The
   3D tilt lives only in here, so it never fires while reading the album page.
   showModal() gives the top layer, Esc handling, a focus trap and background
   inertness without any of it being hand-rolled. */
const coverDialog = $('#coverDialog');
const coverTiltInner = $('#coverTiltInner');

function bindCoverExpand(album){
  const trigger = $('#coverExpand');
  if (!trigger || !album || !album.image) return;
  trigger.onclick = () => openCover(album);
}

function openCover(album){
  if (!coverDialog || !album || !album.image) return;
  // Prefer the 1000px original so the enlarged view is not upscaled.
  const src = album.image_large || album.image;
  coverTiltInner.innerHTML =
    `<img class="album-art" src="${escapeHtml(src)}" alt="${escapeHtml(album.title || 'Album')} cover" decoding="async">`;
  // Required: without this the injected image never gets `is-loaded` and stays
  // invisible, because revealArt() is what applies the reveal opt-in class.
  revealArt(coverTiltInner);
  coverDialog.showModal();
  attachTilt(coverDialog);
  // The dialog only animates in when motion is welcome.
  if (reducedMotion.matches) coverDialog.setAttribute('data-no-motion', '');
}

function closeCover(){
  if (!coverDialog || !coverDialog.open) return;
  coverDialog.close();
  // Clean up synchronously rather than relying solely on the close event, which
  // is queued as a task and can be delayed. The listener below still covers the
  // Esc path, which cannot be intercepted synchronously.
  clearCover();
}

function clearCover(){
  coverDialog.removeAttribute('data-no-motion');
  resetTilt(coverDialog);
  // Drop the 1000px image so it is not retained in memory after dismissal.
  coverTiltInner.innerHTML = '';
}

// Esc is handled natively by showModal. The backdrop click registers on the
// dialog element itself, so matching e.target === dialog closes only genuine
// backdrop clicks and not clicks on the artwork nested inside.
coverDialog.addEventListener('click', e => {
  if (e.target === coverDialog) closeCover();
});
$('#coverClose').addEventListener('click', closeCover);

coverDialog.addEventListener('close', clearCover);

/* -------------------------------------------------------------- cover tilt */
/* The expanded cover leans toward the cursor in 3D.

   JS writes two unitless fractions (--nx, --ny) in the range -1..1 and CSS
   derives everything else from them: the rotation from --tilt (11deg, where
   anything larger shows visible edge distortion on a square cover rather than
   reading as a solid object) and the glare/shadow offsets in pixels. Keeping the
   numbers unitless is what lets one pair of variables drive both angles and
   lengths, since translate3d() cannot take an angle.

   While the pointer moves the rotation must have no transition, or the cover
   lags behind the cursor and feels rubbery. The .is-active class removes it on
   enter and restores it on leave so the cover eases back to rest. */

// Stored so resetTilt() can be called later (on dialog close) without holding a
// closure over the DOM nodes.
let tiltRefs = null;

function resetTilt(root){
  const wrap = $('.cover-tilt', root);
  const inner = $('.cover-tilt-inner', wrap);
  if (!wrap || !inner) return;
  wrap.classList.remove('is-active');
  inner.style.setProperty('--nx', '0');
  inner.style.setProperty('--ny', '0');
  tiltRefs = null;
}

function attachTilt(root){
  const wrap = $('.cover-tilt', root);
  if (!wrap) return;
  const inner = $('.cover-tilt-inner', wrap);
  if (!inner) return;
  // Already wired (the dialog is persistent), so avoid stacking listeners.
  if (tiltRefs && tiltRefs.wrap === wrap) return;

  const set = (nx, ny) => {
    inner.style.setProperty('--nx', nx.toFixed(3));
    inner.style.setProperty('--ny', ny.toFixed(3));
  };
  const reset = () => {
    wrap.classList.remove('is-active');
    set(0, 0);
  };

  // Touch has no hover and nothing to tilt toward, so this stays pointer-only.
  const onMove = e => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (reducedMotion.matches) return;
    const box = wrap.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Normalise the cursor to -1..1 across the cover, clamped at the edges.
    const clamp = v => Math.max(-1, Math.min(1, v));
    const nx = clamp((e.clientX - box.left) / box.width * 2 - 1);
    const ny = clamp((e.clientY - box.top) / box.height * 2 - 1);
    wrap.classList.add('is-active');
    set(nx, ny);
  };

  wrap.addEventListener('pointerenter', onMove);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerleave', reset);
  wrap.addEventListener('pointercancel', reset);
  tiltRefs = { wrap, inner, reset };
  // Reset if the OS setting flips while the page is open.
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', reset);
}

/* ----------------------------------------------------------- artist detail */
async function openArtist(id, name){
  if (!id) return;
  const token = beginNav();
  $('#artistView .page').innerHTML = '<div class="empty">Loading artist…</div>';
  announce('Loading artist');
  show('artist');
  try {
    const response = await fetch('/api/artist?id=' + encodeURIComponent(id));
    const data = await response.json();
    if (navStale(token)) return;
    if (data.error || !data.artist) throw new Error(data.error || 'not found');
    $('#artistView .page').innerHTML = artistPage(data.artist, data.albums || []);
    revealArt($('#artistView .page'));
    show('artist');
    announce(`${data.artist.name}. ${(data.albums || []).length} releases.`);
  } catch (error) {
    if (navStale(token)) return;
    $('#artistView .page').innerHTML = `<div class="page-heading"><h1>${escapeHtml(name || 'Unavailable')}</h1></div>
      <div class="empty">This artist could not be loaded.</div>
      <div class="error-recovery">
        <button class="action-button" data-retry-artist="${escapeHtml(id)}" data-retry-name="${escapeHtml(name || '')}">Try again</button>
        <button class="action-button secondary" data-back>← Back</button>
      </div>`;
    announce('This artist could not be loaded. A retry button is available.');
  }
}

function artistPage(a, albums){
  const facts = [
    ['Albums', Number(a.nb_album || albums.length).toLocaleString()],
    ['Fans', compactNumber(a.nb_fan)],
    ['Source', 'Deezer']
  ].map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`).join('');

  // Discography as an artwork grid: artwork, title with an explicit badge, then
  // year and release type underneath.
  const cards = albums.length
    ? albums.map(al => {
        const sub = [al.year || (al.record_type || 'album'), al.record_type && al.year ? al.record_type : '']
          .filter(Boolean).join(' · ');
        return `<button class="disco-card" data-album="${escapeHtml(al.id)}">
            ${artHtml(al.image, al.title, 'disco-art')}
            <span class="disco-title-line">
              <span class="disco-name">${escapeHtml(al.title)}</span>
              ${al.explicit ? '<span class="explicit" title="Explicit">E</span>' : ''}
            </span>
            <span class="disco-meta">${escapeHtml(sub)}</span>
          </button>`;
      }).join('')
    : '<div class="empty">No releases are listed for this artist.</div>';

  return `<div class="artist-hero">
      ${artHtml(a.image, a.name, 'artist-photo')}
      <div class="album-hero-text">
        <h1 class="artist-name">${escapeHtml(a.name)}</h1>
        <table class="album-facts"><tbody>${facts}</tbody></table>
        <div class="album-actions"><button class="action-button secondary" data-back>← Back</button></div>
      </div>
    </div>
    <div class="album-body">
      <section>
        <div class="section-heading">
          <div><h2>Albums</h2></div>
          <span class="result-count">${albums.length} releases</span>
        </div>
        <div class="disco-grid">${cards}</div>
      </section>
    </div>`;
}

/* ------------------------------------------------------------- collections */
/* Removing a save is the only irreversible-feeling action in the app, so it is
   the only one that needs an undo. The toast is announced through the shared
   live region rather than carrying aria-live itself. */
let toastTimer = null;

function showToast(text, actionLabel, onAction){
  const toast = $('#toast');
  const action = $('#toastAction');
  if (!toast || !action) return;
  $('#toastText').textContent = text;
  action.textContent = actionLabel;
  action.hidden = !actionLabel;
  action.onclick = () => {
    hideToast();
    onAction && onAction();
  };
  toast.hidden = false;
  announce(text + (actionLabel ? '. ' + actionLabel + ' is available.' : ''));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 6000);
}

function hideToast(){
  const toast = $('#toast');
  if (!toast) return;
  toast.hidden = true;
  $('#toastAction').onclick = null;
}

function toggleFavorite(id){
  const wasSaved = state.favorites.has(id);
  if (wasSaved) state.favorites.delete(id);
  else state.favorites.add(id);
  writeList(FAVORITES_KEY, [...state.favorites]);
  const album = cachedAlbum(id);
  if (album && state.view === 'album') {
    $('#favoriteButton').textContent = state.favorites.has(id) ? '♥ Saved' : '♡ Save album';
  }
  if (wasSaved) {
    showToast(`Removed ${album ? album.title : 'album'} from Favorites`, 'Undo', () => {
      state.favorites.add(id);
      writeList(FAVORITES_KEY, [...state.favorites]);
      if (state.view === 'album') $('#favoriteButton').textContent = '♥ Saved';
      if (state.view === 'collection' && state.collectionType === 'favorites') renderCollection('favorites');
      announce('Restored to Favorites');
    });
  } else {
    announce(`Saved ${album ? album.title : 'album'} to Favorites`);
  }
}

function pushRecent(id){
  state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, RECENT_LIMIT);
  writeList(RECENT_KEY, state.recent);
}

function renderCollection(type){
  state.collectionType = type;
  const isFavorites = type === 'favorites';
  const ids = (isFavorites ? [...state.favorites] : state.recent).map(String);
  const albums = ids.map(cachedAlbum).filter(Boolean);
  const missing = ids.filter(id => !cachedAlbum(id));
  const heading = isFavorites ? 'Favorites' : 'Recently viewed';
  $('#collectionView .page').innerHTML = `
    <div class="page-heading"><h1>${heading}</h1></div>
    <div class="album-grid">${albums.length || missing.length
      ? cardsFor(albums) + missing.map(id => missingCard(id)).join('')
      : `<div class="empty">${isFavorites ? 'Save an album to see it here.' : 'Albums you open will appear here.'}</div>`}</div>`;
  const grid = $('#collectionView .album-grid');
  stagger(grid);
  revealArt(grid);
  show('collection');
  // Anything missing from the cache is fetched rather than dropped, so a saved
  // album can never silently disappear from the view.
  if (missing.length) resolveMissingAlbums(missing, type);
}

// Placeholder shown while a cached-miss album is being re-fetched.
function missingCard(id){
  return `<article class="album-card is-loading" data-album="${escapeHtml(id)}">
      <div class="album-art art-placeholder" aria-hidden="true"></div>
      <div class="album-meta"><strong>Loading…</strong><span>&nbsp;</span></div>
    </article>`;
}

async function resolveMissingAlbums(ids, type){
  for (const id of ids) {
    try {
      const response = await fetch('/api/album?id=' + encodeURIComponent(id));
      const data = await response.json();
      if (!data.album) continue;
      cacheAlbum(id, data.album);
    } catch (error) {
      // Leave the placeholder in place rather than dropping the entry.
    }
    // Bail out if the user navigated to a different view mid-fetch.
    if (state.view !== 'collection' || state.collectionType !== type) return;
  }
  if (state.view === 'collection' && state.collectionType === type) renderCollection(type);
}

/* ------------------------------------------------------------------- boot */
migrateLegacyStorage();
state.favorites = new Set(readList(FAVORITES_KEY, []).map(String));
state.recent = readList(RECENT_KEY, []).map(String).slice(0, RECENT_LIMIT);
if (migratedCache) writeList(ALBUM_CACHE_KEY, albumCache);
// There is one theme, so there is nothing to apply and nothing to store. The
// key any earlier version wrote is dropped rather than left orphaned.
localStorage.removeItem('kalm-theme');

$('#tabBar').innerHTML = TABS.map(([key, label], i) =>
  `<button class="tab${i === 0 ? ' active' : ''}" data-tab="${key}">${label}<span class="tab-count"></span></button>`).join('');

syncNavTabs(state.view || 'discover');
renderDiscover();
revealArt(document.body);
loadShelves();

// Suggestion chips on Discover.
$$('[data-query]').forEach(b => b.onclick = () => {
  $('#searchInput').value = b.dataset.query;
  search(b.dataset.query);
});

$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') search(e.target.value);
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    show('discover');
    const input = $('#searchInput');
    input.focus();
    input.select();
    return;
  }
  // '?' opens the shortcuts panel, but only outside a text field where it is
  // just a character.
  if (e.key === '?' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    e.preventDefault();
    openHelp();
  }
});

$$('.nav-tab').forEach(b => b.onclick = () => {
  beginNav();
  if (b.dataset.view === 'discover') show(b.dataset.view);
  else renderCollection(b.dataset.view);
});

$('#brandHome').onclick = () => {
  beginNav();
  show('discover');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.addEventListener('resize', syncShelfArrows);

$('#tabBar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  renderResults();
});

document.addEventListener('click', e => {
  const fav = e.target.closest('#favoriteButton');
  if (fav) {
    e.stopPropagation();
    toggleFavorite(fav.dataset.album);
    return;
  }
  const retryAlbum = e.target.closest('[data-retry-album]');
  if (retryAlbum) {
    // Bypass the recent list: a failed load is not a visit, and retrying should
    // not push the album to the top of history.
    openAlbum(retryAlbum.dataset.retryAlbum, true);
    return;
  }
  const retryArtist = e.target.closest('[data-retry-artist]');
  if (retryArtist) {
    openArtist(retryArtist.dataset.retryArtist, retryArtist.dataset.retryName || '');
    return;
  }
  const back = e.target.closest('[data-back]');
  if (back) {
    show(state.search.top.length || state.search.albums.length ? 'results' : 'discover');
    return;
  }
  const videoClose = e.target.closest('.video-close');
  if (videoClose) {
    e.stopPropagation();
    closeVideo(videoClose.closest('.video-card'));
    return;
  }
  const videoCardEl = e.target.closest('.video-card');
  if (videoCardEl) {
    e.stopPropagation();
    playVideo(videoCardEl);
    return;
  }
  const artistRowTarget = e.target.closest('[data-artist-row]');
  if (artistRowTarget) {
    openArtist(artistRowTarget.dataset.artistRow, artistRowTarget.dataset.artistName);
    return;
  }
  const artistLink = e.target.closest('[data-artist]');
  if (artistLink && artistLink.dataset.artist) {
    e.preventDefault();
    e.stopPropagation();
    openArtist(artistLink.dataset.artist, artistLink.dataset.artistName || artistLink.textContent);
    return;
  }
  const albumTarget = e.target.closest('[data-album]');
  if (albumTarget) openAlbum(albumTarget.dataset.album);
});

/* ------------------------------------------------------------ brand typewriter

   The brand mark rests at "K" and types "Kalm" one character at a time on hover,
   collapsing back to "K" on mouse leave. This replaces the CSS width-animation
   approach, which had three failure modes: flexbox min-width:auto blocked the
   collapse, max-width transitions on flex containers stalled, and growing a box
   under a stationary pointer dropped :hover and snapped it shut.

   A JS-driven textContent change has none of those problems: the box simply
   sizes to its content, the nav shifts by the width of the appearing letters
   over ~200ms (gradual, not a jump), and there is no CSS animation to stall in
   a backgrounded tab.

   Touch devices and reduced motion: on touch, always show the full "Kalm" (no
   hover to reveal it); under reduced motion, show it immediately on hover. */
(function initBrandTypewriter(){
  const brand = document.getElementById('brandHome');
  const mark = brand ? brand.querySelector('.brand-mark') : null;
  if (!brand || !mark) return;
  const full = 'Kalm';
  const supportsHover = window.matchMedia('(hover: hover)').matches;
  if (!supportsHover) { mark.textContent = full; return; }
  mark.textContent = 'K';
  let timer = null;
  const show = () => {
    clearTimeout(timer);
    if (reducedMotion.matches) { mark.textContent = full; return; }
    mark.textContent = 'K';
    let i = 1;
    const tick = () => {
      if (i >= full.length) return;
      mark.textContent = full.slice(0, i + 1);
      i += 1;
      timer = setTimeout(tick, 50);
    };
    timer = setTimeout(tick, 50);
  };
  const hide = () => { clearTimeout(timer); mark.textContent = 'K'; };
  brand.addEventListener('mouseenter', show);
  brand.addEventListener('mouseleave', hide);
  brand.addEventListener('focus', show);
  brand.addEventListener('blur', hide);
})();

/* --------------------------------------------------------------- help panel */
const helpDialog = $('#helpDialog');

function openHelp(){
  if (!helpDialog || helpDialog.open) return;
  // Cover dialog owns Esc while it is open; do not stack two modals.
  if (coverDialog && coverDialog.open) return;
  helpDialog.showModal();
}

if (helpDialog) {
  $('#helpClose').onclick = () => helpDialog.close();
  // Click outside the panel dismisses, matching the expanded cover view.
  helpDialog.addEventListener('click', e => {
    if (e.target === helpDialog) helpDialog.close();
  });
  helpDialog.addEventListener('close', () => $('#searchInput').focus());
}
