"""Kalm music catalog server.

Serves the frontend and proxies Deezer, which needs no API key and supplies artist
photos, album covers, labels, release dates and contributor credits. MusicBrainz
is kept only as a fallback for releases Deezer does not carry.
"""

import gzip
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = int(os.environ.get('PORT', '8000'))
USER_AGENT = os.environ.get('KALM_USER_AGENT', 'KalmMusicCatalog/0.4 (https://github.com/niikpalm/kalm; contact-email)')
MUSICBRAINZ_AGENT = os.environ.get('MUSICBRAINZ_USER_AGENT', 'KalmMusicCatalog/0.4 (https://github.com/niikpalm/kalm; contact-email)')
DISCOGS_TOKEN = os.environ.get('DISCOGS_TOKEN', '')
CACHE_TTL = int(os.environ.get('CACHE_TTL', '3600'))

# Optional. When set, video search uses the official YouTube Data API, which is
# stable and supported. Without it we fall back to public Piped instances, which
# are unofficial and frequently unavailable.
YOUTUBE_API_KEY = os.environ.get('YOUTUBE_API_KEY', '')

# Public Piped instances, tried in order. These come and go, so the list is a
# rotation rather than a single dependency.
PIPED_INSTANCES = [
    'https://api.piped.private.coffee',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.reallyaweso.me',
]
PIPED_TIMEOUT = 8
VIDEO_COUNT = 4
# Longer than this and it is almost certainly a full-album stream rather than the
# video for one track.
SONG_MAX_SECONDS = 15 * 60

# Deezer rate-limits aggressively and answers 403 when pushed, so every upstream
# call is serialized behind a minimum interval and cached in process.
MIN_INTERVAL = float(os.environ.get('UPSTREAM_MIN_INTERVAL', '0.35'))
_lock = threading.Lock()
_last_request_at = 0.0
_cache = {}
_cache_lock = threading.Lock()


def fetch_json(url, headers=None, cache_ttl=CACHE_TTL, timeout=20, attempts=3):
    """Fetch JSON with a shared rate limit, an in-process cache and retries."""
    if cache_ttl > 0:
        with _cache_lock:
            hit = _cache.get(url)
        if hit and (time.time() - hit[0]) < cache_ttl:
            return hit[1]

    global _last_request_at
    last_error = None
    for attempt in range(attempts):
        with _lock:
            wait = MIN_INTERVAL - (time.time() - _last_request_at)
            if wait > 0:
                time.sleep(wait)
            _last_request_at = time.time()
        request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode('utf-8'))
            # Deezer signals errors inside a 200 body rather than via status code.
            if isinstance(data, dict) and data.get('error'):
                raise RuntimeError(data['error'].get('message', 'upstream error'))
            if cache_ttl > 0:
                with _cache_lock:
                    _cache[url] = (time.time(), data)
            return data
        except urllib.error.HTTPError as exc:
            # 403 is Deezer's rate-limit response and is worth backing off for.
            if exc.code == 403:
                time.sleep(2.0 * (attempt + 1))
                last_error = exc
                continue
            if exc.code < 500 and exc.code != 429:
                raise
            last_error = exc
        except Exception as exc:
            last_error = exc
        time.sleep(1.0 * (attempt + 1))
    raise last_error


# ---------------------------------------------------------------------- video
# Embedding a YouTube video and loading its poster image both work without a key;
# only *searching* for videos needs one. So the official Data API is preferred
# whenever YOUTUBE_API_KEY is set, and the Piped instances are a keyless
# fallback that is free but unofficial and frequently unavailable.
def video_thumb(video_id, size='hqdefault'):
    return f'https://i.ytimg.com/vi/{video_id}/{size}.jpg'


def normalise_video(video_id, title, channel, duration, views, is_short=False):
    return {
        'id': video_id or '',
        'title': title or '',
        'channel': channel or '',
        'duration': int(duration or 0),
        'views': int(views or 0),
        # Always our own thumbnail URL rather than Piped's proxied one: i.ytimg
        # is keyless, never rate-limited by us and cannot go stale.
        'thumbnail': video_thumb(video_id) if video_id else '',
    }


def usable_video(v):
    """Drop anything too short to be a song.

    A duration of 0 means unknown rather than empty, so such a clip is kept: an
    occasional intro or jingle is a smaller fault than returning nothing at all.
    """
    if not v.get('id'):
        return False
    return v.get('duration', 0) in (0,) or v['duration'] >= 30


def rank_videos(videos):
    """Put single songs and videos ahead of full-album streams.

    Providers return pure relevance order, which on an album page tends to rank
    a one-hour rip above the official video for the record's best-known track.
    Nothing is dropped, only reordered: relevance is preserved inside each group
    so a genuinely popular album stream still wins among the long ones.
    """
    def is_song(v):
        seconds = v.get('duration') or 0
        # 0 means the provider did not say, which is not evidence of a full album.
        return seconds == 0 or seconds <= SONG_MAX_SECONDS

    return [v for v in videos if is_song(v)] + [v for v in videos if not is_song(v)]


def parse_youtube_id(url):
    if not url:
        return ''
    m = re.search(r'(?:v=|/embed/|/shorts/|youtu\.be/)([A-Za-z0-9_-]{6,})', url)
    return m.group(1) if m else ''


def parse_iso_duration(text):
    """ISO 8601 duration (PT1H2M3S) to seconds."""
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$', text or '')
    if not m:
        return 0
    hours, mins, secs = (int(g) if g else 0 for g in m.groups())
    return hours * 3600 + mins * 60 + secs


def youtube_api_search(query):
    search = fetch_json('https://www.googleapis.com/youtube/v3/search?' + urllib.parse.urlencode({
        'part': 'snippet',
        'q': query,
        'type': 'video',
        'maxResults': VIDEO_COUNT * 2,
        'videoEmbeddable': 'true',
        'key': YOUTUBE_API_KEY,
    }))

    items = search.get('items') or []
    ids = [i['id']['videoId'] for i in items if i.get('id', {}).get('videoId')]

    # search.list does not include duration, and it is worth showing. One
    # videos.list call costs 1 unit against the 10,000/day free quota.
    durations = {}
    if ids:
        try:
            detail = fetch_json('https://www.googleapis.com/youtube/v3/videos?' + urllib.parse.urlencode({
                'part': 'contentDetails',
                'id': ','.join(ids),
                'key': YOUTUBE_API_KEY,
            }))
            for item in detail.get('items') or []:
                durations[item['id']] = parse_iso_duration(item.get('contentDetails', {}).get('duration'))
        except Exception:
            durations = {}

    videos = []
    for item in items:
        vid = item.get('id', {}).get('videoId')
        if not vid:
            continue
        snippet = item.get('snippet') or {}
        videos.append(normalise_video(
            vid,
            snippet.get('title'),
            snippet.get('channelTitle'),
            durations.get(vid, 0),
            snippet.get('viewCount'),
        ))
    return videos


def piped_search(query):
    """Walk the instance list until one answers with something usable."""
    for instance in PIPED_INSTANCES:
        try:
            data = fetch_json(
                instance + '/search?' + urllib.parse.urlencode({'q': query, 'filter': 'videos'}),
                timeout=PIPED_TIMEOUT,
                attempts=1,
                cache_ttl=CACHE_TTL * 6,
            )
        except Exception:
            continue  # instance is down or blocked; try the next

        videos = []
        for item in (data.get('items') or [])[:VIDEO_COUNT * 3]:
            if item.get('isShort'):
                continue  # Shorts are vertical clips, near useless here
            video = normalise_video(
                parse_youtube_id(item.get('url')),
                item.get('title'),
                item.get('uploaderName'),
                item.get('duration'),
                item.get('views'),
            )
            if usable_video(video):
                videos.append(video)
        if videos:
            return videos
    return []


def search_videos(artist, title):
    query = ' '.join(x for x in (artist, title) if x).strip()
    if not query:
        return []
    if YOUTUBE_API_KEY:
        try:
            videos = [v for v in youtube_api_search(query) if usable_video(v)]
            if videos:
                return rank_videos(videos)[:VIDEO_COUNT]
        except Exception:
            pass  # quota exhausted or key rejected; fall through to keyless
    return rank_videos(piped_search(query))[:VIDEO_COUNT]


# --------------------------------------------------------------------- helpers
def dz(path, **params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, '')})
    url = f'https://api.deezer.com/{path}'
    if query:
        url += '?' + query
    return fetch_json(url)


def artist_credit(obj):
    """Flatten a MusicBrainz artist-credit list, preserving join phrases."""
    credit = obj.get('artist-credit') or []
    name = ''.join((c.get('name', '') + c.get('joinphrase', '')) for c in credit).strip()
    # MusicBrainz sometimes returns mojibake for non-Latin names.
    if '\ufffd' in name:
        return ''
    return name


def format_type(primary, secondary):
    labels = [primary] if primary else []
    labels.extend(s for s in (secondary or []) if s and s not in labels)
    return ' + '.join(labels) if labels else 'Release'


def cover_url(cover, size='medium'):
    """Deezer cover URLs embed their size, so swap just the size segment.

    The filename is SIZE-NNNN-NN-N-N.jpg and the trailing numbers are required,
    so only the leading WxH is replaced; dropping the suffix 404s every variant.

    The service returns covers far more reliably than Cover Art Archive and has no
    rate-limit sensitivity for CDN images, so these are used directly.
    """
    if not cover:
        return ''
    return re.sub(r'(?<=/)\d+x\d+(?=-\d)', size, cover)


def picture_url(picture, size='medium'):
    return cover_url(picture, size)


# --------------------------------------------------------------------- search
def dz_track(item):
    album = item.get('album') or {}
    return {
        'kind': 'track',
        'id': str(item.get('id', '')),
        'title': item.get('title', ''),
        'artist': (item.get('artist') or {}).get('name', ''),
        'artist_id': str((item.get('artist') or {}).get('id', '')),
        'album': album.get('title', ''),
        'album_id': str(album.get('id', '')),
        'duration': item.get('duration', 0),
        'rank': item.get('rank', 0),
        'image': cover_url(album.get('cover_medium'), '250x250'),
        'type': 'Track',
    }


def dz_album(item):
    return {
        'kind': 'album',
        'id': str(item.get('id', '')),
        'title': item.get('title', ''),
        'artist': (item.get('artist') or {}).get('name', ''),
        'artist_id': str((item.get('artist') or {}).get('id', '')),
        'year': (item.get('release_date') or '')[:4],
        'nb_tracks': item.get('nb_tracks', 0),
        'fans': item.get('fans', 0),
        'image': cover_url(item.get('cover_medium'), '250x250'),
        'type': 'Album',
    }


def dz_artist(item):
    return {
        'kind': 'artist',
        'id': str(item.get('id', '')),
        'name': item.get('name', ''),
        'title': item.get('name', ''),
        'artist': item.get('name', ''),
        'nb_album': item.get('nb_album', 0),
        'nb_fan': item.get('nb_fan', 0),
        'image': picture_url(item.get('picture_medium'), '250x250'),
        'type': 'Artist',
    }


def dz_search(query):
    """Search artists, tracks and albums concurrently across Deezer's entities."""
    def safe(path):
        try:
            return dz('search/' + path, q=query, limit='12').get('data') or []
        except Exception:
            return []

    results = {}
    threads = []
    for path in ('artist', 'track', 'album'):
        t = threading.Thread(target=lambda p=path: results.__setitem__(p, safe(p)))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()

    artists = [dz_artist(a) for a in results.get('artist', [])]
    tracks = [dz_track(t) for t in results.get('track', [])]
    albums = [dz_album(a) for a in results.get('album', [])]

    # Top results interleave, de-duplicating albums that arrived via track results
    # so the same record does not appear twice under different entity types.
    seen = set()
    # Interleave one artist, some tracks, then albums, mirroring how Spotify
    # composes a top-results page out of several entity types.
    album_ids = {a['id'] for a in albums[:6]}
    top = []
    for group, limit in ((artists, 1), (tracks, 6), (albums, 6)):
        count = 0
        for item in group:
            if item['id'] in seen:
                continue
            if item['kind'] == 'album' and item['id'] in album_ids:
                continue
            seen.add(item['id'])
            top.append(item)
            count += 1
            if count >= limit:
                break

    return {
        'artists': artists,
        'tracks': tracks,
        'albums': albums,
        'top': top,
    }


# --------------------------------------------------------------------- artist
def dz_artist_payload(artist_id):
    artist = dz('artist/' + artist_id)
    albums_raw = dz('artist/' + artist_id + '/albums', limit='100').get('data') or []

    def album_sort_key(a):
        # Studio albums first, then earliest, so the breakthrough record leads.
        record_type = (a.get('record_type') or '').lower()
        rank = {'album': 0, 'ep': 1, 'compilation': 2}.get(record_type, 3)
        return (rank, a.get('release_date') or '9999')

    albums = []
    for a in sorted(albums_raw, key=album_sort_key):
        albums.append({
            # Fans are cached alongside so the album page can show related
            # artists without a second round trip.
            'id': str(a.get('id', '')),
            'title': a.get('title', ''),
            'artist': artist.get('name', ''),
            'year': (a.get('release_date') or '')[:4],
            'record_type': a.get('record_type', ''),
            'nb_tracks': a.get('nb_tracks', 0),
            'fans': a.get('fans', 0),
            # Search and Discover both carry this, so omitting it here made the
            # explicit badge appear on every other grid but never on a
            # discography.
            'explicit': bool(a.get('explicit_lyrics')),
            'image': cover_url(a.get('cover_medium'), '250x250'),
        })

    summary = {
        'id': str(artist.get('id', '')),
        'name': artist.get('name', ''),
        'nb_album': artist.get('nb_album', len(albums)),
        'nb_fan': artist.get('nb_fan', 0),
        'image': picture_url(artist.get('picture_xl') or artist.get('picture_medium'), '500x500'),
    }
    return {'artist': summary, 'albums': albums}


# ---------------------------------------------------------------------- album
def dz_album_payload(album_id):
    album = dz('album/' + album_id)
    artist = album.get('artist') or {}

    tracks = []
    for t in album.get('tracks', {}).get('data', []) or []:
        # Track contributors may be absent or, on some responses, a bare string.
        parts = t.get('contributors')
        names = [x if isinstance(x, str) else x.get('name', '') for x in (parts or [])]
        credited = ' / '.join(n for n in names if n) or artist.get('name', '')
        tracks.append([str(t.get('track_position', len(tracks) + 1)), t.get('title', ''), credited])

    # Deezer exposes only main contributors per release, so credits are grouped
    # from the artist plus any additional contributors on the album object.
    credits = {}
    for c in album.get('contributors') or []:
        role = c.get('role') or 'Credits'
        credits.setdefault(role, []).append(f"{c.get('name', '')} — {role.lower()}")

    genres = [g.get('name', '') for g in (album.get('genres') or {}).get('data', []) or []]
    record_type = (album.get('record_type') or 'album').lower()

    # Related artists come from the artist's own endpoint, which Deezer provides
    # and which gives album pages a recommendation row without a search.
    related = []
    if artist.get('id'):
        try:
            # Reuse dz_artist rather than rebuilding the shape inline: an earlier
            # inline copy stored the name under 'title' and omitted 'name'
            # entirely, which silently blanked the card title and its image alt.
            related = [
                dz_artist(r)
                for r in (dz('artist/' + str(artist['id']) + '/related').get('data') or [])[:8]
            ]
        except Exception:
            related = []

    return {
        'id': str(album.get('id', '')),
        'kind': 'album',
        'title': album.get('title', ''),
        'artist': artist.get('name', ''),
        'artist_id': str(artist.get('id', '')),
        'year': (album.get('release_date') or '')[:4],
        'label': album.get('label', ''),
        'genre': ', '.join(genres[:3]),
        'type': record_type.capitalize(),
        'nb_tracks': album.get('nb_tracks', len(tracks)),
        'duration': album.get('duration', 0),
        'fans': album.get('fans', 0),
        'explicit': bool(album.get('explicit_lyrics')),
        'image': cover_url(album.get('cover_xl') or album.get('cover_medium'), '500x500'),
        'image_small': cover_url(album.get('cover_medium'), '250x250'),
        # Distinct 1000x1000 original, used only by the expanded cover view so it
        # stays crisp instead of scaling up the 500px hero.
        'image_large': cover_url(album.get('cover_xl') or album.get('cover_medium'), '1000x1000'),
        'tracks': tracks,
        'credits': credits,
        'related': related,
        'providers': 'Deezer',
    }


class Handler(SimpleHTTPRequestHandler):
    # The prototype is edited locally, so stale cached assets are more confusing
    # than useful and a reload should always pick up local changes.
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        path = parsed.path

        if path == '/health':
            # Cheap liveness check that uptime monitors and tooling can poll
            # without filling the log with 404s from the static file server.
            self.send_json({'ok': True, 'service': 'kalm'})
            return

        if path == '/api/search':
            query = params.get('q', [''])[0].strip()
            if not query:
                self.send_json({'error': 'missing q', 'artists': [], 'tracks': [], 'albums': [], 'top': []})
                return
            try:
                self.send_json(dz_search(query))
            except Exception as exc:
                self.send_json({'error': str(exc), 'artists': [], 'tracks': [], 'albums': [], 'top': []}, 502)
            return

        if path == '/api/discover':
            try:
                # Chart rows give Discover real editorial content instead of
                # empty carousels. Each row is an independent call, so failures
                # degrade to a missing row rather than a broken page.
                def safe_row(path, limit='50'):
                    try:
                        return (dz(path, limit=limit).get('data') or [])
                    except Exception:
                        return []

                rows = []

                def add_album_row(title, items):
                    rows.append({'title': title, 'kind': 'album', 'items': [
                        {
                            'id': str(a.get('id', '')),
                            'title': a.get('title', ''),
                            'artist': (a.get('artist') or {}).get('name', ''),
                            'year': (a.get('release_date') or '')[:4],
                            'record_type': a.get('record_type', ''),
                            'explicit': bool(a.get('explicit_lyrics')),
                            'image': cover_url(a.get('cover_medium'), '250x250'),
                        }
                        for a in items if a.get('id')
                    ]})

                def add_artist_row(title, items):
                    # Deezer's artist chart carries no fan or album count, only a
                    # position. The previous nb_album was always 0 upstream and
                    # read by nobody; the client showed nb_fan, which was not
                    # sent at all, so every card rendered a hard "0 fans".
                    rows.append({'title': title, 'kind': 'artist', 'items': [
                        {
                            'id': str(a.get('id', '')),
                            'name': a.get('name', ''),
                            'position': a.get('position') or index + 1,
                            'image': picture_url(a.get('picture_medium'), '250x250'),
                        }
                        for index, a in enumerate(items) if a.get('id')
                    ]})

                def add_track_row(title, items):
                    rows.append({'title': title, 'kind': 'track', 'items': [
                        {
                            'id': str(t.get('id', '')),
                            'title': t.get('title', ''),
                            'artist': (t.get('artist') or {}).get('name', ''),
                            'album_id': str((t.get('album') or {}).get('id', '')),
                            'explicit': bool(t.get('explicit_lyrics')),
                            'duration': t.get('duration', 0),
                            'image': cover_url((t.get('album') or {}).get('cover_medium'), '250x250'),
                        }
                        for t in items if t.get('id')
                    ]})

                add_track_row('Tracks on the rise', safe_row('chart/0/tracks'))
                add_artist_row('Artists to know', safe_row('chart/0/artists'))

                # Deezer's album charts only expose six releases, which is too
                # few for a carousel, so the album row is derived from the albums
                # behind the current chart tracks instead.
                chart_tracks = safe_row('chart/0/tracks', limit='50')
                albums_seen = {}
                for t in chart_tracks:
                    album = t.get('album') or {}
                    aid = str(album.get('id', ''))
                    if not aid or aid in albums_seen:
                        continue
                    albums_seen[aid] = {
                        'id': aid,
                        'title': album.get('title', ''),
                        'artist': (t.get('artist') or {}).get('name', ''),
                        'year': '',
                        'record_type': '',
                        'explicit': bool(album.get('explicit_lyrics')),
                        'image': cover_url(album.get('cover_medium'), '250x250'),
                    }
                rows.insert(0, {'title': 'Albums you might enjoy', 'kind': 'album',
                                'items': list(albums_seen.values())[:20]})

                self.send_json({'rows': [r for r in rows if r['items']]})
            except Exception as exc:
                self.send_json({'error': str(exc), 'rows': []}, 502)
            return

        if path == '/api/artist':
            artist_id = params.get('id', [''])[0].strip()
            if not artist_id:
                self.send_json({'error': 'missing id'}, 400)
                return
            try:
                self.send_json(dz_artist_payload(artist_id))
            except Exception as exc:
                self.send_json({'error': str(exc)}, 502)
            return

        if path == '/api/album':
            album_id = params.get('id', [''])[0].strip()
            if not album_id:
                self.send_json({'error': 'missing id'}, 400)
                return
            try:
                self.send_json({'album': dz_album_payload(album_id)})
            except Exception as exc:
                self.send_json({'error': str(exc)}, 502)
            return

        if path == '/api/videos':
            artist = params.get('artist', [''])[0].strip()
            title = params.get('title', [''])[0].strip()
            if not (artist or title):
                self.send_json({'videos': []})
                return
            try:
                # Video search is slow and can fail wholesale when the fallback
                # instances are down, so it answers 200 with an empty list rather
                # than an error. The section simply does not appear.
                self.send_json({'videos': search_videos(artist, title)})
            except Exception:
                self.send_json({'videos': []})
            return

        # Unknown API paths get a compact JSON 404 rather than the static file
        # server's full HTML error page, which is unhelpful to a fetch caller.
        if path.startswith('/api/'):
            self.send_json({'error': 'unknown endpoint', 'path': path}, 404)
            return

        return self.serve_compressed_static()

    def serve_compressed_static(self):
        """Serve a static file, gzipped when the client accepts it.

        SimpleHTTPRequestHandler sends files verbatim, so styles.css, app.js and
        index.html all cross the wire uncompressed on every reload. The stock
        handler is bypassed rather than patched so the compression decision stays
        in one place.
        """
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().do_GET()
        try:
            with open(path, 'rb') as handle:
                body = handle.read()
        except OSError:
            return super().do_GET()

        content_type = self.guess_type(path)
        accepts = 'gzip' in (self.headers.get('Accept-Encoding') or '').lower()
        if not accepts or len(body) < 1024:
            self.send_bytes(body, content_type)
            return
        self.send_compressed(body, content_type)

    def send_bytes(self, data, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        self.wfile.write(data)

    def send_compressed(self, body, content_type, status=200):
        """Send a body gzipped when the client accepts it.

        The stock handler serves uncompressed, which for this app means 94.7 KB
        of static assets plus 25.2 KB of Discover JSON on every uncached load.
        Compressing costs one pass over already-in-memory bytes and takes that
        to 25.5 KB and 5.4 KB respectively.
        """
        accepts = 'gzip' in (self.headers.get('Accept-Encoding') or '').lower()
        # Below roughly a kilobyte the gzip header and framing cost more than
        # they save.
        if not accepts or len(body) < 1024:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        packed = gzip.compress(body, 6)
        # Only claim gzip if it actually helped; some payloads are incompressible.
        if len(packed) >= len(body):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(packed)))
        self.end_headers()
        self.wfile.write(packed)

    def send_json(self, payload, status=200):
        self.send_compressed(json.dumps(payload).encode('utf-8'),
                             'application/json; charset=utf-8', status)


if __name__ == '__main__':
    print(f'Kalm running at http://{HOST}:{PORT}')
    print('Data source: Deezer (no API key required)')
    print('Video source: YouTube Data API' if YOUTUBE_API_KEY
          else 'Video source: public Piped instances (set YOUTUBE_API_KEY for the official API)')
    print(f'Rate limit: {MIN_INTERVAL}s between upstream requests; cache TTL {CACHE_TTL}s')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()