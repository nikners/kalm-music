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
| `GET /api/discover` | Carousel rows for the Browse page |
| `GET /api/artist?id=` | Artist summary and discography |
| `GET /api/album?id=` | Album detail, tracklist, credits and related artists |
| `GET /api/videos?artist=&title=` | Up to four YouTube videos for a release |

Unknown `/api/*` paths return a compact JSON 404 rather than the static file
server's HTML error page. Anything else falls through to the static handler.

## Current prototype

An album-art-first catalog with a vintage analogue feel — typed like printed
matter rather than a dashboard.

- **The Index is the front door.** A feed asks you to scroll; a catalogue lets
  you look something up. Index is a finite, text-first list ordered by title,
  each row a catalogue number, a 44px thumbnail, title, artist, year and format.
  It is seeded from the discover payload plus every album this browser has saved
  or opened, so it grows with use and needs no server support. `Browse` is the
  old Discover page — carousels and all — one tab in
- **Catalogue numbers** are `KALM` plus the Deezer album id, derived rather
  than stored: no migration, identical for every reader, and a saved record
  keeps its number permanently
- **Layout:** a single sticky topbar carrying brand, four navigation tabs and
  search. There is no sidebar; the 232px it occupied went
  back to the album grid. Labels collapse to icons below 940px
- **Corners:** radius scales with element size rather than being uniform —
  6px on the search field, toast and dialogs, 4px on controls, 3px on artwork,
  and circles left as circles on the shelf arrows, close buttons, play button and
  the brand tile
- **Type:** Figtree throughout, Azeret Mono uppercase and letterspaced for every
  micro-label (counts, years, formats, durations, metadata keys)
- **Palette:** "ink wash", and **there is only one theme.** Charcoal `#4a4a4a`,
  cool grey, soft ivory `#ffffe3`, slate blue `#6d8196` (darkened 25% to `#5a6978`
  for `--accent`)

  This palette is a light-theme palette, which is a measurement rather than a
  preference: the slate is darker than its own greys (L=0.212 against charcoal's
  0.069), so it works as an accent on a light ground and cannot on a dark one.
  The slate is 3.95:1 on ivory and 2.21:1 on charcoal, and no ground darker than
  `#161616` lets it clear 4.5 at all. Forcing it into a dark theme pushed the
  accent to `#dae5f1`, which is no longer slate. Rather than desaturate the
  palette in both directions, the dark theme was removed along with its toggle.

  The palette supplies four colours and this needs thirteen, so the rest are
  derived and then *solved* for contrast rather than eyeballed
- **Texture:** a faint ruled grid across the page, two `repeating-linear-gradient`
  layers, no JS and no network request, and static rather than animated
- Hairline rules instead of glows, near-square corners, green-tinted shadows
- Tabbed search results: **Top results** interleaves artists, tracks and albums,
  with separate **Artists**, **Tracks** and **Albums** tabs and live counts
- Artist pages with photo and discography; album pages with cover, a printed
  metadata table, tracklist, credits, videos and related artists
- Click any cover for a large centred view with 3D tilt
- A record peeks out from behind the album sleeve on hover or keyboard focus,
  and stops at the gap so it never sits behind the title
- Favorites and recently viewed stored locally
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

Every text and background pair clears WCAG AA (4.5:1) for body and small text —
**23 pairs, one theme**, verified by reading the tokens back out of `styles.css`
rather than from a draft. The tightest is 4.73:1 (`--accent` on `--surface-2`).

Two values are deliberately *not* the source palette's own:

- **`--accent` is `#5a6978`, not `#6D8196`.** The palette slate is 3.37:1 on
  `--surface-2`, and that is a live failure rather than a theoretical one:
  `.result-row:hover` paints `--surface` underneath accent-coloured type. Darkened
  25% it clears 4.73:1 there and keeps the blue.
- **`--muted` is `#5c5c5c`, not `#6e6e6e`**, which measured 4.28:1 on
  `--surface-2`. `--faint` is `#585858` rather than the previous solver's
  `#5d5d45`, which was technically passing but khaki.

**`--on-scrim` is a separate token.** The play button, close buttons and toast
draw light glyphs on near-black scrims. They cannot follow `--ink-strong`, which
is charcoal here and would disappear against a black overlay. Verified by
compositing each real scrim alpha over `--bg`; the worst case is 4.94:1.

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

The Browse carousels creep along on their own so the page does not read as a
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

Two faces, two jobs: **Figtree** for everything, **Azeret Mono** for the small
uppercase labels (counts, durations, years, format tags, metadata keys).

`--font-display` and `--font-body` both resolve to Figtree. That was not the
starting point: titles were Fraunces and body was Spectral, and moving to a
grotesque throughout was the change that decides whether Kalm reads as an
archival record sleeve or as a tool. Both references it was built against use a
grotesque throughout, and the specimens were measured rather than eyeballed —
Figtree wraps at 0.94x of Fraunces on the long-title case, so nothing reflowed.

The saving is the reason it was worth doing. Latin subset, measured from the
Google Fonts CSS:

| | Latin |
|---|---|
| Fraunces + Spectral + Azeret Mono | 182.6 KB |
| Figtree + Azeret Mono | 121.7 KB |

60.9 KB lighter, 33% of the Latin subset, and one family instead of two. Figtree's
70.6 KB *includes* the italic: `.artist-aliases` and `.empty` set
`font-style: italic` and used to inherit Spectral's. Without `ital` in the
request the browser synthesises a fake oblique. Only 400/500/600 are requested —
the stylesheet uses 600 nineteen times, 500 and 400 once each, and nothing uses
300 or 700.

Inter was the alternative and cost 141.4 KB against Figtree's 70.6 KB for a
visually similar result. What is given up is real: Fraunces has an optical-size
axis and develops hairlines at 42px, and a grotesque at 14px carries less
character than a serif does. That was the trade, taken deliberately.

Every rule reaches its family through `--font-display` / `--font-body` /
`--font-mono`; no rule hardcodes one, so the swap is complete by construction
rather than by having found every call site.

`--mono-weight` exists because those labels are a single role at a single
weight, and the family that came before it only shipped 400 and 700. Space Mono
forced the labels to 700, which read blunt at 10.5px, and cost 32.5 KB for two
weights. Azeret Mono has a real 500, so the token is back to the weight the
labels originally asked for, and only one weight is requested at all.

Weighted rather than bouncy — with one exception. Ease-out curves around 320ms,
restricted to `transform` and `opacity`. Views fade in on navigation, grids and
result rows stagger with a capped delay, artwork fades in once decoded, and cards
lift on hover. All of it is disabled under `prefers-reduced-motion: reduce`, and
the grid overlay is removed under `prefers-reduced-transparency: reduce`.

The exception is `--ease-spring`, `cubic-bezier(0.275, 0.6, 0.16, 1.24)`, which
overshoots its target and settles back. It is applied only to things that
**arrive** rather than depart — the three card lifts, the cover dialog, and the
staggered reveal — and never to the vinyl slide, which should stay predictable.
620ms rather than the reference site's 800ms: a spring arrives early so it reads
faster than its duration suggests, but Kalm staggers many items per shelf and the
delays compound. Note that `.shelf-card` carries the spring on the *card* while
the other two carry it on the artwork — on a shelf it is the whole card that
lifts, so a transition on `.shelf-art` would never have covered it.

Page texture is a ruled grid rather than film grain, which retires two animated
fixed full-viewport layers that were previously the most expensive thing in the
app. It is also a better metaphor: a catalogue of records is a grid of things.
The grid is drawn as two gradients rather than one image at `background-size`,
because a 1px image line lands on a fractional device pixel and shimmers on
scroll at fractional zoom.

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

### The vinyl disc

The album hero has a record peeking out from behind the sleeve, on hover and on
keyboard focus. It is decorative: `aria-hidden="true"`, `pointer-events: none`,
and no text for a screen reader to read. It does not spin.

Three things about it are load-bearing, and each one was a bug first.

**The disc is a sibling of `.cover-expand`, never a child.** Inside the button,
`.cover-expand:hover { transform: scale(1.015) }` creates a stacking context,
which traps the disc's `z-index: -1` inside the button. The button then paints
as one unit at `z-index: auto`, which is *above* `.album-hero-text`, so the disc
covered the album title and the artist name. It only broke on hover, because the
transform is what creates the context. A `.hero-cover` wrapper now sizes the
disc to the cover without putting it inside the button: it carries no transform,
so it creates no stacking context and the `-1` resolves to the root. Moving the
span back inside `.cover-expand` reintroduces the bug.

**`--hero-gap` must track `.album-hero`'s real grid gap.** `--vinyl-out` is
`calc(-100% + var(--hero-gap))`, which travels the disc exactly as far as the
clear space to the right of the sleeve, so it stops level with the text column
and never passes behind the title. It is 36px at the default 300px cover and
24px at the 210px one, so changing the grid gap without changing `--hero-gap`
makes the disc overshoot into the text.

**The reduced-motion rule has to read `var(--vinyl-out)`, not a literal.** Under
`prefers-reduced-motion: reduce` the disc rests at its out position instead of
sliding, which is the same value the hover rule uses.

There is one disc — `--disc-ring-a` / `--disc-ring-b` are declared on `:root`.
That is only safe because the disc is trimmed, and the reason is polarity: a
disc reads only when it is darker than the type in front of it, but this
theme's album title is charcoal (`#4a4a4a`), so a disc reaching the text column
landed at **1.01:1** and the title did not degrade, it vanished. No colour fixes
that with a full slide — `--accent` `#5a6978` needs a disc luminance of 0.728 to
stay readable, which is a disc invisible as a disc. Trimming means the disc sits
behind no text at all, which frees the colour completely. `--vinyl-out` is
restored to `-45%` at `max-width: 720px`, where the hero stacks and the text is
below the cover.

The disc stays a neutral grey (`#767b77` / `#868c87`) rather than joining the
palette. A record is not slate, and a tinted disc reads as decoration. The previous
warm grey was cooled rather than tinted, because it had enough brown in it to
look like a smudge on this background.

**Testing paint order with `elementFromPoint` will lie to you.** The disc is
`pointer-events: none`, so hit-testing skips it entirely and
`elementFromPoint` returns the album title even while the disc is on top of it.
To check the real paint order, set `pointer-events: auto` on the disc first and
sweep a grid of probe points across it, asserting that none return the disc.
Disabling `transition` during that sweep matters too: `getBoundingClientRect()`
immediately after changing `transform` samples the *start* of the transition, not
the settled value.

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