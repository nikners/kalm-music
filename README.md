# Kalm — Music Catalog Prototype

**Disclaimer:** This project is a local, Windows-first prototype and a placeholder for a future music catalogue project. It is not intended for production use. It does not include audio playback.

## About
Kalm is a local web app for browsing artists, albums, tracklists, credits, and videos. It uses a custom Python backend to proxy the Deezer API (no API key required) and curates specific genres (70s/80s Classic Rock and Progressive Rock) for its Discover shelves.

## Features
- **Clean Editorial UI:** Warm paper aesthetic, dramatic typography, and a responsive CSS Bento Grid.
- **Motion System:** Snappy, mechanical CSS animations (respects `prefers-reduced-motion`).
- **Curation Engine:** Backend filters Deezer's catalog for specific eras and genres, ignoring tribute bands and compilations.
- **Disk Caching:** Persists the Discover shelves to `discover_cache.json` for instant load times on server restart.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS (No frameworks or bundlers).
- **Backend:** Python (`server.py` using `ThreadingHTTPServer`).
- **Data Source:** Deezer API.

## How to Run
1. Ensure Python is installed.
2. Start the server:
   ```bash
   py server.py
   ```
3. Open http://127.0.0.1:8000 in your browser.