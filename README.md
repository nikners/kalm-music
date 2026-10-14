# Kalm

A music catalog for browsing artists, albums, tracklists and detailed credits
without audio playback.

## Run locally

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:8000
```

No API key or account is required. Optional settings:

```powershell
$env:PORT = "8080"
$env:KALM_USER_AGENT = "KalmMusicCatalog/0.4 (https://example.com; you@example.com)"
python server.py
```

Setting `YOUTUBE_API_KEY` switches video search to the official YouTube Data
API. Without it, public Piped instances are used instead — see
[Video search](#video-search).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness check, returns `{"ok":true,"service":"kalm"}` |
| `GET /api/search?q=` | Artists, tracks and albums, plus an interleaved top list |
| `GET /api/discover` | Carousel rows for the Discover page |
| `GET /api/artist?id=` | Artist summary and discography |
| `GET /api/album?id=` | Album detail, tracklist, credits and related artists |
| `GET /api/videos?artist=&title=` | Up to four YouTube videos for a release |

Unknown `/api/*` paths return a compact JSON 404 rather than the static file
server's HTML error page. Anything else falls through to the static handler.

## Current prototype

An album-art-first catalog with a vintage analogue feel — typed like printed
matter rather than a dashboard.

- **Layout:** a single sticky topbar carrying brand, three navigation tabs,
  search and the theme toggle. There is no sidebar; the 232px it occupied went
  back to the album grid. Labels collapse to icons below 940px
- **Corners:** radius scales with element size rather than being uniform —
  6px on the search field, toast and dialogs, 4px on controls, 3px on artwork,
  and circles left as circles on the shelf arrows, close buttons, play button and
  the brand tile
- **Type:** Fraunces for titles and headings, Spectral for body and UI copy,
  IBM Plex Mono uppercase and letterspaced for every micro-label (counts, years,
  formats, durations, metadata keys)
- **Palette:** dark is a matte board sleeve (warm near-black, cream type, amber
  accent); light is aged liner paper (cream ground, brown-black ink, oxblood
  accent)
- **Texture:** a fine film-grain overlay across the page via an inline SVG
  turbulence filter, no JS and no network request
- Hairline rules instead of glows, near-square corners, warm-tinted shadows
- Tabbed search results: **Top results** interleaves artists, tracks and albums,
  with separate **Artists**, **Tracks** and **Albums** tabs and live counts
- Artist pages with photo and discography; album pages with cover, a printed
  metadata table, tracklist, credits, videos and related artists
- Click any cover for a large centred view with 3D tilt
- Favorites and recently viewed stored locally; themes remembered between visits
- Responsive down to icon-only navigation, with `?` for shortcuts and a card key

## Accessibility and recovery

The interface was audited against Nielsen's ten usability heuristics. What that
changed, and why:

- **Every result and card is keyboard reachable.** Album cards are real
  `<button>`s and result titles are buttons inside their rows. A click handler
  alone is not focusable, so search results and album grids were previously
  unreachable without a mouse. Rows keep their click-anywhere behaviour: the
  delegated handler uses `closest('[data-album]')`, so the nested title wins and
  one click still causes exactly one navigation.
- **One polite live region** (`#liveStatus`, `role="status"`) announces search
  progress and counts, album and artist loads, saves, and video results. One
  region for the whole app, rather than one per view, which screen readers
  handle unreliably.
- **Saves are undoable.** Removing a favourite raised a toast with an Undo
  action, since that is the only irreversible-feeling action in the app.
- **Failed loads offer a retry.** An album or artist that will not load used to
  be a dead end; there is now a **Try again** button alongside Back. The message
  says what failed and a retry is available.
- **`?` opens a shortcuts and card-key panel**, which explains that artist cards
  show a chart position because Deezer's artist feed carries no counts.
- **Eyebrows carry data, not mood.** The atmospheric eyebrows above section
  headings ("Watch and listen" above *Videos*, "The people behind it" above
  *Credits*) restated or obscured the heading and read as decoration competing
  with the data. They were removed. The one eyebrow that carries real
  information — record type and year on the album page — was kept.

Every text and background pair in both themes clears WCAG AA (4.5:1) for body
and small text. Micro-label tones were measured and adjusted rather than chosen
by eye, since warm palettes tend to fail on the faintest tier.

### Known limitations

- Deezer's album charts only expose six releases, so the "Albums you might
  enjoy" carousel is built from the albums behind the chart tracks instead.
- Roughly half of release groups lack cover art upstream and show a placeholder.
- Deezer's artist chart carries no fan or album count, only a position, so the
  "Artists to know" cards show `No. N` where the other shelves show a fan count.
- Video results are whatever the search returns, so compilations and live
  records can surface tribute acts or live versions. Nothing is silently
  filtered: an unwanted result is better than a missing one.

## Video search

The album page shows up to four YouTube videos between Credits and Similar
artists. Embedding a video and loading its poster image both work without a key;
only *searching* for videos needs one, which is why there are two providers.

| Condition | Source |
| --- | --- |
| `YOUTUBE_API_KEY` is set | YouTube Data API — official and stable |
| not set | Public Piped instances — free, unofficial, frequently unavailable |

`search_videos()` prefers the official API and silently falls back to Piped if
the key is rejected or the quota is spent, so setting a key never makes the
section disappear.

Behaviour worth knowing:

- **Posters, not embeds.** Four mounted iframes would pull in YouTube's player
  script and set tracking cookies before anyone asked to watch. Cards show a
  keyless `i.ytimg.com` thumbnail and the `youtube-nocookie.com` player is
  created on click. Closing it drops the iframe, which stops playback.
- **Separate endpoint.** Video search is deliberately not bundled into
  `/api/album`. It is slow and depends on a third party, and it is not worth
  delaying artwork, tracklist or credits for. The section streams in afterwards.
- **Ranks songs ahead of album rips.** Providers return relevance order, which
  tends to put a one-hour full-album stream above the official video for the
  record's best-known track. Clips at or under 15 minutes are ordered first;
  nothing is dropped, and relevance is preserved within each group.
- **Absent means absent.** If no source answers, the endpoint returns
  `{"videos": []}` with HTTP 200 and the section does not render. No error box,
  matching how missing artwork and credits already behave.
- Results are cached per album in `localStorage` for the session, including
  empty results, so a flaky provider is not hammered on every visit.

On the official path, `search.list` costs 100 units and the extra `videos.list`
call that supplies durations costs 1, against a 10,000/day free quota. That is
roughly 99 album pages a day.

## Data source

[Deezer](https://developers.deezer.com/api) allows anonymous access, so there is
nothing to sign up for. It supplies artist photos, artwork in four sizes, labels,
release dates, genres, tracklists, contributor credits, fan counts and a
related-artists endpoint.

Earlier builds used MusicBrainz with the Cover Art Archive. That was replaced for
two concrete reasons: roughly half of release groups had no front cover at all
(10 of 24 for Nina Simone, with no artwork anywhere upstream), and loading a
grid of covers straight from Cover Art Archive returned HTTP 500s under parallel
load. Deezer's CDN is reliable and its metadata is richer.

## Behavior notes

- Upstream calls are serialized behind a 350ms floor and cached in process, since
  Deezer answers 403 when pushed. Tune with `UPSTREAM_MIN_INTERVAL` and
  `CACHE_TTL`.
- Deezer reports some errors inside a 200 response body; those are detected and
  raised rather than treated as success.
- Discographies are ordered studio albums first, then by earliest release, so an
  artist's breakthrough record leads instead of demos or live sets.
- Artwork loads directly from Deezer's CDN, so there is no image proxy.
- Assets are served with `Cache-Control: no-store` so a reload always picks up
  local edits.
- Favorites, recently viewed and album snapshots are stored in local storage
  under `kalm-*` keys. Data written under the previous `sonora-*` keys is
  migrated once.

## Motion

### Ambient shelf drift

The Discover carousels creep along on their own so the page does not read as a
still image. One `requestAnimationFrame` loop drives every shelf, at 18 px/s for
albums and 22 px/s for tracks so the two long rows never move in lockstep. Each
shelf ping-pongs, so there is no terminal state to get stuck at.

**"Artists to know" does not drift.** It is a ranked chart with `No. 1` / `No. 2`
labels, and a ranked list reads as something to consult rather than a feed to
browse, so it stays put and is moved with the arrows. Shells are excluded by the
`data-kind` on the section, not by index, so Deezer reordering the rows cannot
change which ones drift. Its scroll-snap is never suspended either, so its
arrows keep snapping normally at all times.

Two things were needed before the drift read as drift rather than as steps, and
both are load-bearing:

- **Continuous motion.** An earlier version called `scrollTo()` every 7s by one
  card width, which was a slideshow: shift, pause, shift.
- **Snap suspended while moving.** `scroll-snap-type: x proximity` quantises
  every scroll position to a card boundary, so a smooth per-frame increment gets
  yanked back to the nearest card and the row visibly moves one card at a time
  no matter how small the increment. Snap is set to `none` on the drifting rows
  only, and restored on pause, which keeps the arrow buttons crisp.

Pausing is invisible and there is deliberately no button: hovering a shelf or
tabbing into one holds every shelf, which stops a row sliding out from under the
reader. Reduced motion never starts it. `dt` is clamped to 50ms so a
backgrounded tab does not resume with a large jump.

### Typography weight

Three faces, three jobs: **Fraunces** for titles, **Spectral** for reading copy,
**Azeret Mono** for the small uppercase labels (counts, durations, years, format
tags, metadata keys).

`--mono-weight` exists because those labels are a single role at a single
weight, and the family that came before it only shipped 400 and 700. Space Mono
forced the labels to 700, which read blunt at 10.5px, and cost 32.5 KB for two
weights. Azeret Mono has a real 500, so the token is back to the weight the
labels originally asked for, and only one weight is requested at all.

Weighted rather than bouncy: ease-out curves around 320ms, restricted to
`transform` and `opacity`. Views fade in on navigation, grids and result rows
stagger with a capped delay, artwork fades in once decoded, and cards lift on
hover. All of it is disabled under `prefers-reduced-motion: reduce`, and the
grain overlay is removed under `prefers-reduced-transparency: reduce`.

Artwork fades in via an opt-in `.art-pending` class applied per image by
`revealArt()`. Hiding lives behind that class rather than a global rule, so a
render path that forgets to call `revealArt()` gets an instant-loading image
instead of an invisible one.

### The expanded-cover sheen

The gloss sleeve highlight on the enlarged cover is a `::before` overlay that
slides with **`background-position`, never `transform`**, and it is sized at
300% so no gradient edge can enter view while it moves.

This is load-bearing. An earlier version used
`translate3d(..., 20px)`; inside the `preserve-3d` context that Z offset scaled
the overlay by roughly 2% and the X/Y offset slid it off the artwork, so the
sheen never lined up with the sleeve. Because the element stays exactly
`inset: 0` and is never transformed, the misalignment is now structurally
impossible rather than merely tuned away. Converting it back to a transform
would reintroduce the drift.

`.cover-tilt-inner::after` deliberately keeps its Z offset: that one is a drop
shadow, which *should* lag in the plane as the sleeve tilts, and being blurred
it has no hard edge to expose.

## Caching

Album payloads are cached in `localStorage` under `kalm-albums`, and video
results under `kalm-videos`, so revisiting a release renders instantly and a
provider is not re-queried.

Both caches are trusted over a refetch, which means a change to the `/api/album`
or `/api/videos` payload shape would otherwise strand every already-visited
album on stale data until LRU pressure evicted it. Because a renderer reading
an absent field receives an empty string rather than an error, that failure is
silent and reads as a styling fault rather than a data bug.

So both caches are versioned. Entries are stored as `{v, album}` / `{v, videos}`
and any entry whose version does not match is discarded on read, producing a
normal cache miss and refetch.

**Bump `ALBUM_CACHE_VERSION` or `VIDEO_CACHE_VERSION` in `app.js` whenever the
corresponding payload shape changes.**