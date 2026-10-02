# Feed Decisions

> Snapshot of current consensus. Evolution: `git log --grep="MODULE: feed"`
> Last distilled: 2026-10-03 (HEAD = bcb06b4)

## Active

### D1: One yt-dlp helper for the feed, downloads and history

- **What**: `helper/yt.py` runs on the pipx yt-dlp's Python, patches `yt_dlp.cookies._find_files` to skip profile `Storage/` folders, downloads logged out first and retries logged in, and feeds from `reel_watch_sequence`, restarting from home-page seeds on a dead token and falling back to subscription Shorts.
- **Why**: The mod needs the endless logged-in Shorts feed, downloads and watch history from one place that reads the browser login correctly.
- **Tradeoffs**: It patches a private yt-dlp function, calls unofficial endpoints, and every call is a fresh process that re-reads cookies (about 4 s).
- **Watch out**: A yt-dlp rename of `_find_files` or a change to the reel endpoints breaks it, signed-in automated requests carry YouTube ToS account risk, and token lifetime across days is unverified.
- **Source**: 0d47b6d

### D2: Entry point first, then callees in call order

- **What**: yt.py reads top-down (docstring, constants, the import-time cookie patch, `ydl`/`short_url`, then `main`, `feed()` and `Feed`'s methods in the order they are tried, then the JSON helpers, `download`, `watched` and the `__main__` guard), formatted with ruff at 120 columns and single quotes.
- **Why**: yt.py should read the same way as the mod, with what runs first placed first.
- **Tradeoffs**: `main` sitting above the functions it dispatches to is unusual in Python.
- **Watch out**: A new module-level call that needs a function at import time must go below that function's definition.
- **Source**: cc938de

### D3: Likes through a signed `Api` base class

- **What**: `yt.py like ID` and `unlike ID` post `{ target: { videoId } }` through an `Api` base class (cookies, the home page's ytcfg, the signed InnerTube call) that `Feed` also extends, and exit non-zero without a request when signed out.
- **Why**: Liking from the pane needs a signed-in InnerTube write the helper did not have.
- **Tradeoffs**: Each call re-reads cookies and the home page (about 6–7 s), and a Short's existing like status is never read.
- **Watch out**: YouTube may change these unofficial endpoints or start gating them on `likeParams`, and likes are account writes under the same ToS risk as the feed.
- **Source**: 3a780ee

### D4: The person's browser, and cookie failures in plain words

- **What**: `CC_SHORTS_BROWSER` picks the cookie browser (Chrome when unset), `main()` walks the exception chain to yt-dlp's `CookieLoadError` and exits with "cannot read <browser>'s cookies: <cause>" (Safari's `PermissionError` pointing to Full Disk Access, worded as in D8), and `feed` exits "signed out" before trying subscriptions.
- **Why**: yt.py read only Chrome, and cookie or login failures surfaced as raw tracebacks or 401s.
- **Tradeoffs**: Messages use yt-dlp's browser ids rather than display names, and docstrings say "the browser's cookies" without naming the variable.
- **Watch out**: The chain walk depends on yt-dlp raising a `DownloadError` while handling `CookieLoadError`, and the `Storage/` patch still assumes a Chromium profile layout.
- **Source**: bed1bf0, 16deaa2, bcb06b4

### D5: A source-verified feed map pinned to yt-dlp 2026.8.19

- **What**: `.claude/maps/feed.md` is a full map from three research concerns, its claims verified against `helper/yt.py` and the yt-dlp 2026.8.19 source, and the registry's feed entry covers likes.
- **Why**: The Knowledge Loop's read-the-map-first rule had nothing to read for a helper that leans on private yt-dlp internals.
- **Tradeoffs**: The map pins yt-dlp internals to 2026.8.19.
- **Watch out**: A yt-dlp upgrade that moves those internals makes the map stale; the two problems it recorded were fixed in e3304ae (D6, D7).
- **Source**: f5d912c

### D6: A Keychain refusal is reported, not read as signed out

- **What**: `_YoutubeDL.report_warning` records every warning, `ydl()` loads cookies up front, and a failed `find-generic-password` raises `CookieLoadError` from a `PermissionError` whose hint says to allow the Keychain prompt (worded as in D8), with `cookie_failure` reading `__cause__` before `__context__` so the hint survives `download`'s retry.
- **Why**: A refused Keychain made yt-dlp silently drop the encrypted cookies, so the feed read as signed out and the pane wrongly suggested switching browsers.
- **Tradeoffs**: Cookies load when the YoutubeDL is built rather than at the first request, and the hint says Allow rather than Always Allow, so the prompt returns each time.
- **Watch out**: Detection matches yt-dlp's warning text, so a rewording silently brings back the false "signed out", it was checked only against a stubbed cookie reader, and `watched`, `like` and `unlike` now exit with the Keychain error.
- **Source**: e3304ae, bcb06b4

### D7: One batch budget per feed call

- **What**: `Feed.batches` starts at `MAX_BATCHES` (3) and is shared by every `scroll` in one `feed` call.
- **Why**: One call could make six `reel_watch_sequence` requests while the comment promised three, which keeps the rate near a person scrolling.
- **Tradeoffs**: A token path that spends the budget on already-seen ids returns the home page's seeds and an unread token instead of a fresh batch.
- **Watch out**: No risk of its own was recorded beyond D1's request-rate and account concerns.
- **Source**: e3304ae

### D8: Cookie hints name the fix and leave the browser switch to the player

- **What**: A refused Keychain exits "cannot read <browser>'s cookies: allow the macOS Keychain prompt for its key", Safari's `PermissionError` names only the Full Disk Access step, and the player's feed error that wraps them offers `/shorts browser`.
- **Why**: Both hints ended with `/shorts browser` and so did the player's feed error, so the pane said it twice.
- **Tradeoffs**: The helper's own message no longer mentions switching browsers, which shows only in the debug log for downloads, watch reports and likes.
- **Watch out**: A surface that shows the helper's error without the player's wrapper loses the switch hint, and `docs/research.md`'s verification log still quotes the older Keychain text.
- **Source**: bcb06b4

## Superseded

- ~~Cookie hints ending with "or pick another browser with /shorts browser" (D4's Safari hint, D6's Keychain hint)~~ → replaced by **D8** in bcb06b4 (2026-10-03)
