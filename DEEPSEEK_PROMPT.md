# Kalm — Project Context for Deepseek

## What this is

**Kalm** is a music catalog web app — a local, Windows-first prototype for browsing artists, albums, tracklists, credits, and videos. **No audio playback.** It's designed to look and feel like a retro '70s printed-matter catalogue (hard shadows, 2px borders, Righteous display face, pill controls, halftone dot texture) rather than a modern dashboard.

The codebase is in `C:\Users\nik.muhamadazeem\Downloads\Music`. It's a git repo on `main` with ~10 commits.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Python (`server.py`), ThreadingHTTPServer, proxies Deezer API (no API key needed) |
| Frontend | Vanilla HTML/CSS/JS — no framework, no bundler |
| Fonts | Google Fonts: Azeret Mono (400/500), Figtree (400/500/600 + italic), Righteous (display) |
| Storage | localStorage (favorites, recent, album cache) |
| Python | `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` (not on PATH) |

**Server start (PowerShell):**
```powershell
$env:PORT='8800'
Start-Process "$env:LOCALAPPDATA\Python\pythoncore-3.14-64\python.exe" -ArgumentList 'server.py' -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\opencode\o.txt" -RedirectStandardError "$env:TEMP\opencode\e.txt"
```
Health check: `curl http://127.0.0.1:8800/health` → `{"ok":true,"service":"kalm"}`. Note: Chrome blocks port 10080 (unsafe port).

**Kill server:** Find the python.exe process matching `server.py` via `Get-CimInstance Win32_Process`.

## File structure

```
Music/
├── index.html          # Single-page app shell, topbar, views
├── styles.css          # All tokens, components, responsive rules
├── app.js              # All frontend logic
├── server.py           # Deezer proxy + static file server
├── type.html           # Standalone specimen page (own :root palette copy)
├── README.md           # Extensive design documentation
└── .git/
```

## Architecture

### Frontend (SPA)
- Single `index.html` with multiple `.view` sections toggled by `show(view)`.
- Views: `discover` (Browse), `results` (search), `album`, `artist`, `collection` (favorites/recent).
- State object holds current view, favorites (Set), recent (array), discover rows, search results.
- Navigation: sticky topbar with brand button + nav tabs + search field.
- Data flow: Deezer API → server proxy → frontend caches in localStorage.

### Backend (server.py)
- Serves static files + proxies Deezer endpoints.
- Routes: `/health`, `/api/search?q=`, `/api/discover`, `/api/artist?id=`, `/api/album?id=`, `/api/videos?artist=&title=`
- Rate-limited upstream calls (MIN_INTERVAL=0.35s), in-process cache (CACHE_TTL=3600s).
- `Cache-Control: no-store` on all responses (prototype is edited locally).
- Optional YouTube API key for video search; falls back to Piped instances.

## Design system (retro sunset palette)

### Color tokens (in styles.css `:root`)
```css
--bg: #f7f2e4;           /* warm cream ground */
--surface: #fdfaf0;       /* cards, topbar */
--surface-2: #f1ebd9;     /* hover states */
--surface-3: #e7e0cb;
--surface-4: #dcd4bc;     /* scrollbar thumb only */
--ink-strong: #2a2520;    /* headings */
--ink: #4a4238;           /* body */
--muted: #6b6154;
--faint: #716961;
--line: #d6cdb4;          /* borders */
--accent: #a1390c;        /* burnt orange — darkened from #b7410e for contrast */
--accent-ink: #f7f2e4;    /* text on accent fills */
--fill-mustard: #ffce1b;  /* fills ONLY, never text */
--fill-teal: #077979;     /* fills ONLY, never text */
--on-scrim: #fdfaf0;
```

### Typography
- **Display:** Righteous (400, single weight) — 1.01× Figtree width, zero layout risk
- **Body:** Figtree (400/500/600 + italic) — 70.6KB Latin subset
- **Mono:** Azeret Mono (400/500) — uppercase micro-labels
- `--display-weight: 400` — Righteous is single-weight; asking for 600 would synthesise faux bold
- `--font-display: 'Righteous', 'Figtree', system-ui, sans-serif`

### Shape & shadow
```css
--shadow: 3px 3px 0 rgba(74, 42, 20, 0.85);   /* hard, zero blur */
--shadow-lift: 6px 6px 0 var(--accent);
--radius-control: 999px;   /* pills */
--radius-art: 0;           /* square sleeves */
--radius-surface: 4px;
```

### Texture
- Halftone dots: `radial-gradient(rgba(74,42,20,0.085) 1px, transparent 1px)` on a 26px tile
- One `position: fixed` pseudo-element on `body::before`, `z-index: 9999`, `pointer-events: none`

### Key design rules
- Mustard and teal are **fills, never text** — they fail WCAG AA as text colors
- `--accent` is `#a1390c`, not the palette's `#b7410e` (3.76:1 on `--surface-2`; `.result-row:hover` paints that surface under accent type)
- Contrast pairs checked only against `--bg`/`--surface`/`--surface-2`. `--surface-4` excluded (scrollbar thumb only)
- All 16 text pairs clear WCAG AA 4.5:1, tightest is 4.52:1

## Current state (recent commits)

```
f008a67 feat: drop the Index page; Browse leads
f45411e fix: brand reveal is now a typewriter - hover on K types "Kalm"
c51b20c fix: brand was never actually collapsing - flexbox min-width:auto blocked it
9064c2a fix: hovering the logo shoved the whole navigation 23px sideways
bc93a4a fix: brand rests collapsed at K and opens to Kalm on hover; drop the breakpoint
f3268d6 feat: one box for the whole Kalm wordmark, pressable and staggered
c7733d9 fix: typewriter caret never travelled, and the run truncated on long titles
bf7a947 feat: full retro treatment, and a typewriter album title
1bddd4f feat: retro sunset palette, and a typewriter album title
e28e535 feat: ink wash palette, and one theme instead of two
f12b36b feat: spring/grid/tracking
a66742e feat: Index
7334512 feat: Figtree migration
c21bd63 feat: vinyl docs
88a729f initial
```

### Working tree: clean

### Last feature: brand logo typewriter
- Brand mark starts at "K", types "alm" on hover (70ms/char), collapses on mouse leave
- Consistent with album-title typewriter motion language
- Touch devices always show full "Kalm"; reduced motion shows immediately on hover
- JS-driven `textContent` change (no CSS width animation — all CSS approaches failed)

### The album title typewriter (app.js `typeTitle()`)
- Starts at `t=0` was wrong (hidden under 320ms viewIn fade). Now: 450ms delay, then `min(75ms, 2000/len)` per character
- "In Rainbows": first char at 450ms, last at 1.2s, done by 1.275s
- Caret travels with the text (inserted before each new character)
- Characters are plain text nodes (no spans) — ordinary text breaking, no inline-block wrapping issues
- Re-entrancy guarded by a run token
- `prefers-reduced-motion` → full text shown immediately

### Vinyl disc
- Built as a sibling of `.cover-expand` (never a child — hover transform traps `z-index:-1`)
- `--hero-gap` tracks `.album-hero`'s real gap
- Reduced-motion rule reads `var(--vinyl-out)`

## Key constraints and gotchas

### PowerShell file handling
- **Dangerous.** `Get-Content -Raw` + `WriteAllText` double-encoded UTF-8 and corrupted `styles.css`. Always use `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)` / `WriteAllText` with `UTF8Encoding($false)`. Measured at zero byte drift.
- `List[byte].AddRange()` with an `Object[]` silently dropped bytes. Cast to `[byte[]]`.
- Prefer the `edit` tool for comment text.

### Measurement environment
- **No frames render:** `requestAnimationFrame` fires 0 frames, `document.hidden === true`. All motion unverifiable via browser tools.
- **CSS transitions never advance** in a hidden tab, so transitioned colours read as stuck start values (disable transitions to read true computed colour).
- **Border widths snap to device pixels:** at `devicePixelRatio: 1.25`, `2px` computes to `1.6px`. Not a CSS bug.
- **No screenshots possible** — `browser.screenshot` requires a visible tab.

### Verification patterns
- Contrast claims must be verified by reading tokens back out of `styles.css`, never from a draft
- Reference sites are analysed by reading their shipped CSS, never from memory
- Inventory checks must parse rule blocks by brace depth, not proximity-based selector lookup (mis-attributed rules twice)
- `elementFromPoint` skips `pointer-events:none` elements

### Server
- Start: `$env:PORT='8800'; Start-Process ...` (see above)
- Kill: `Get-CimInstance Win32_Process -Filter "Name='python.exe'"` matching `server.py`
- Background servers **do die** — check `/health` before measuring
- Port 10080 is on Chrome's blocked list — use 8800+

## Key files and their roles

| File | Role |
|---|---|
| `styles.css` | All tokens, shadows, borders, radii, texture, component styles, responsive rules |
| `app.js` | State, navigation, rendering, typewriter, brand typewriter, event handlers |
| `index.html` | Single-page shell, topbar, views, font URL |
| `server.py` | Deezer proxy, static file server, video search |
| `README.md` | Extensive design documentation (contrast audits, measurements, decisions) |
| `type.html` | Standalone specimens with own `:root` palette copy — goes stale when tokens change |

## What's been tried and rejected

- **Four palettes in three turns:** warm brown → lush forest green → ink wash → retro sunset. Each cost a full token recompute.
- **Dark theme + toggle:** removed. Ink-wash slate (#6D8196, L=0.212) was darker than its own greys.
- **Typewriter spans as inline-block:** wraps a 48-char word to 5 lines vs 1 as inline. Rejected.
- **Hiding characters with base `opacity: 0`:** if animation never runs, title stays invisible. Instead, 0 comes from keyframe `from` with `both` fill.
- **Heavier retro fonts (Alfa Slab One, Archivo Black, Bungee):** 1.19–1.29× Figtree width, would push cards/long titles onto extra lines. Righteous chosen at 1.01×.
- **Grain → ruled grid → halftone dots:** two animated full-viewport layers retired; ruled grid shimmered on fractional zoom; dots don't.
- **8 tracking values → 3 tokens.**
- **CSS-width approach for brand reveal:** 4 attempts, 4 failure modes (flexbox min-width:auto, stalled transitions, pointer loss, dead space). Replaced with JS typewriter.

## Known limitations

- Upstream: search `limit=12`, no pagination anywhere, MusicBrainz is fallback only — no real browsable catalogue is possible
- `type.html` goes stale whenever tokens change (own `:root` copy)
- `Discover` hardcodes `'year': ''` and `'record_type': ''`
- Cannot verify motion visually (hidden tab, 0 frames)

## How the user works

- Prefers measurement-driven decisions. Every contrast claim, font metric, and layout claim was verified by reading values back out of the live CSS or measuring in the browser.
- Flagged repeatedly that they have only ever seen numbers, never the rendered page — so visual claims should be hedged honestly.
- PowerShell file handling is dangerous in this environment (see gotchas above).
- Uses `edit` tool for targeted changes, `write` for new files.
- Commits with conventional commit messages (`feat:`, `fix:`).

## Current user request

The user wants me to create a prompt for Deepseek with full context about the project. This file IS that prompt. Save it as `DEEPSEEK_PROMPT.md` in the project root.
```

Wait, the user said "save it as a file" and I'm in Plan mode so I can't write files. But the system reminder also says "You are NO LONGER in Plan mode" — wait, that was from earlier. Let me re-read.

Actually the last system reminder says "You are NO LONGER in Plan mode." So I CAN write files now. Let me write it.

But wait, the user said "okay save it as a file" — they want the prompt saved. Let me write it to the project root.<|end|><|start|><|start|>assistant to=write<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
C:\Users\nik.muhamadazeem\Downloads\Music\DEEPSEEK_PROMPT.md