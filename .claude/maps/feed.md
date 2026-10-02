# feed Map
> Static understanding snapshot, not a decision history.
> See `.claude/decisions/feed.md` for the paired decision history.
> Verified: 2026-10-02 (3 research concerns; 10 claims checked against helper/yt.py and the installed
> yt-dlp 2026.8.19 source by an independent verifier: 7 confirmed, 3 partial and corrected, 0 refuted)
> Maintained: 2026-10-03 (targeted verification: `ydl` reports a refused Keychain as a cookie
> failure, and `MAX_BATCHES` is shared by every scroll of one `feed` call. Checked by an offline
> script that stubs yt-dlp's cookie reader. The research probe is gone from the tree; its findings
> stay in `docs/research.md`.)

## Responsibilities

- `helper/yt.py` is a one-shot Python CLI that the player spawns for everything that touches YouTube:
  scrolling the logged-in Shorts feed, downloading one Short, reporting it watched, and liking or
  unliking it.
- It drives yt-dlp's Python API: the public `YoutubeDL.extract_info` for downloads, watch reports and
  the subscriptions fallback, and private YouTube extractor internals for direct InnerTube calls (the
  reel sequence and likes).
- It reads cookies from the browser that `CC_SHORTS_BROWSER` names, and patches yt-dlp's Chromium
  cookie-file lookup.
- It turns cookie-load failures and signed-out states into one-line reasons the pane can show.
- It keeps no state between calls. The continuation token, the seen list, the download queue and
  every retry or preload policy belong to the player.

## Key types

- Module constants:
  - `BROWSER`: `CC_SHORTS_BROWSER`, or `chrome` when unset or empty; read once at import.
  - `HOME` (`https://www.youtube.com/`) and `SUBSCRIPTIONS` (`/feed/subscriptions/shorts`).
  - `MAX_BATCHES = 3`: the most `reel_watch_sequence` calls one `feed` call makes. Its scrolls
    share the budget through `Feed.batches`.
  - `FORMAT = bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]/b`: limited by width, because a
    vertical video's height is its long side.
- `_profile_files`: wraps yt-dlp's private `cookies._find_files` and skips any path containing
  `/Storage/`. It is installed at import by rebinding the module attribute.
- `ydl(cookies=True, **params)`: the only `YoutubeDL` factory.
  - It sets `quiet`, `no_warnings` and `noprogress`, adds `cookiesfrombrowser=(BROWSER,)` unless
    `cookies=False`, and lets caller params override.
  - It builds a `_YoutubeDL`, which records every warning in `.warnings`, including the ones
    `no_warnings` hides.
  - With cookies, it reads them at once rather than at the first request. If yt-dlp warned that
    `find-generic-password` failed (the Keychain refused a Chromium browser's key), it raises a
    `CookieLoadError` from a `PermissionError` that carries the hint.
- `Api`: one InnerTube session. It holds the `YoutubeTab` extractor of a cookie-bearing `YoutubeDL`,
  the home page HTML, its first `ytcfg`, and `logged_in` (the page's `ytcfg.LOGGED_IN`).
  `call(endpoint, body)` goes through `_call_api` with ytcfg's `INNERTUBE_CONTEXT`. Auth headers,
  including a fresh timestamped SAPISIDHASH, are generated on every call: once by `Api.call` and
  again inside `_call_api`.
- `Feed(Api)`: the accumulator for one `feed` call: a `seen` set, `want`, and ordered, de-duplicated
  `ids`; methods `scroll`, `from_home`, `from_subscriptions` and `add`.
- `video_ids`, `find_strings`, `find_all`: recursive key searches through InnerTube JSON.

## Public entry points

`python -B helper/yt.py <command>`, run on the Python the player's setup check found (one that imports
`yt_dlp`). Every success prints one JSON line on stdout and exits 0.

| Command | Input | Output |
|---|---|---|
| `feed` | stdin `{token, seen, want}` | `{ids, token, source, loggedIn}`; `source` is `sequence`, `home` or `subscriptions` |
| `download ID DIR` | argv | `{id, title, author, duration, width, height, hasAudio, path}` |
| `watched ID` | argv | `{id}` |
| `like ID`, `unlike ID` | argv | `{id}` |

Failure contract:

- Clean one-line exits:
  - `cannot read <browser>'s cookies: <cause>`, for any cookie-load failure.
    - For Safari with a `PermissionError`, the cause is replaced by a Full Disk Access hint.
    - For a Chromium browser whose key the Keychain refused, the cause is
      `the macOS Keychain did not hand over the browser's key: answer its prompt with Allow, …`.
    - `cookie_failure` reads a `CookieLoadError`'s `__cause__` before its `__context__`. So that
      hint survives being raised inside `download`'s retry.
  - `signed out: no YouTube login in <browser>'s cookies`: `feed` found no ids and the page is signed
    out.
  - `<endpoint>: logged out, nothing to like with`: `like` or `unlike` while signed out.
- Everything else is an uncaught traceback with exit 1, and the player shows only its last line. That
  covers a missing or unknown command, wrong arity, bad stdin JSON, non-cookie yt-dlp errors, and a
  failure in the subscriptions fallback.
- On a cookie failure, yt-dlp's own `ERROR: …` line comes before the helper's line. The player reads
  only the last line.
- Recoverable notes also go to stderr while the command still exits 0: `feed: token failed…`,
  `feed: home sequence failed…`, and `download: logged out failed, retrying logged in…`.

## Data flow / lifecycle

1. **Import.** `BROWSER` is read and the `_find_files` patch is installed, for every command.
2. **`main`.** It takes `argv[1]` as the command and dispatches through a dict. It catches only
   `yt_dlp.utils.YoutubeDLError`. `cookie_failure` walks the `__context__` chain to a
   `CookieLoadError` and returns its cause; any other yt-dlp error is re-raised. On success it writes
   `json.dump(out)` plus a newline.
3. **`feed`.**
   1. It parses stdin, makes `seen` a set, and sets `want = max(1, int(want or 10))`.
   2. `Feed()` builds an `Api`, which runs on every call, even with a valid token: it makes a
      cookie-bearing `YoutubeDL`, takes the `YoutubeTab` extractor (never `initialize()`d), GETs the
      home page, and parses its first `ytcfg`. A cookie failure here propagates to `main`.
   3. **With a token**, it calls `scroll(token)`.
      - While the call's batch budget lasts, it POSTs `reel/reel_watch_sequence` with
        `{sequenceParams: token}` and adds the ids under `entries`. The budget is `MAX_BATCHES`,
        shared with the home path.
      - The next token comes from `continuationEndpoint`. When there is none, it returns `None`
        (end of the sequence).
      - It stops once `ids >= want`, checked after each batch.
      - Any exception writes a stderr note and drops the token.
   4. **With no ids yet**, `source = home` and it calls `from_home`:
      - Every `reelWatchEndpoint` with a `videoId` anywhere in the home page's `ytInitialData` becomes
        a seed, not only those on the Shorts shelf. The seeds themselves are added to `ids`.
      - It POSTs `reel/reel_item_watch` for the first seed.
      - The token is the first `sequenceContinuation` in that reply, or else the seed's
        `sequenceParams`.
      - Then it calls `scroll(token)` with whatever budget the token path left. With none left, it
        returns that token unread, and the next call scrolls from there.
      - Any exception drops the token. If `reel_item_watch` fails, the seeds alone come back with a
        null token.
   5. **Still no ids.**
      - Signed out: it exits with the signed-out message.
      - Otherwise `source = subscriptions` and `token = None`. A fresh
        `ydl(extract_flat=True, playlist_items='1:30')` extracts `SUBSCRIPTIONS`. According to the code
        comment, the home page's instance gets a 401. This step is not wrapped in a try.
   6. It returns `{ids, token, source, loggedIn}`.
4. **`download ID DIR`.**
   - It downloads without cookies first. On any `DownloadError`, it retries with the browser's
     cookies.
   - Download options: `FORMAT`, `merge_output_format='mp4'`, and output template
     `DIR/%(id)s.%(ext)s`.
   - Reply fields:
     - `author`: `uploader`, else `channel`, else `''`.
     - `duration`: or `0`.
     - `width`, `height`: of the selected format.
     - `hasAudio`: `acodec` is neither `None` nor `'none'`.
     - `path`: `requested_downloads[0].filepath`.
5. **`watched ID`.** It runs a full cookie-bearing extraction with
   `mark_watched=True, simulate=True, skip_download=True`. yt-dlp's `_mark_watched` then GETs the
   player response's `playbackTracking` videostats playback and watchtime URLs, with `fatal=False`.
6. **`like ID` / `unlike ID`.** `rate()` builds an `Api` and exits when the page is signed out.
   Otherwise it POSTs `like/like` or `like/removelike` with `{target: {videoId}}`. Success means "no
   exception"; the response body is ignored.

## Dependencies (inbound / outbound)

- **Inbound: the player only, through `runHelper` in `hooks/register.tsx`.**
  - Call sites:
    - `refill` runs `feed`.
    - `fetchShort` runs `download` into the session temp dir.
    - `follow` runs `watched`.
    - `toggleLike` runs `like` / `unlike`.
  - Timeouts: `feed` 120 s, `download` 180 s, every other command 60 s.
  - The argv is `[python, -B, <plugin root>/helper/yt.py, …]`.
  - `CC_SHORTS_BROWSER` is set only once a browser was chosen. Before that, Claude Code's own
    environment, and failing that `chrome`, applies.
  - The player parses only the last stdout line, and takes the last stderr line as the error.
- **Outbound: yt-dlp 2026.8.19, installed in the pipx or Homebrew venv the setup check finds.**
  - Public: `YoutubeDL`, `extract_info`, `utils.YoutubeDLError` / `DownloadError`, and
    `cookies.CookieLoadError`.
  - Private: `cookies._find_files`, `get_info_extractor('YoutubeTab')`, `_download_webpage`,
    `extract_ytcfg`, `extract_yt_initial_data`, `_call_api` and `generate_api_headers`.
  - Behavior relied on:
    - `report_warning`, which `_YoutubeDL` overrides;
    - the lazily loaded `cookiejar` property;
    - the text of yt-dlp's Keychain warning (`find-generic-password failed`, or
      `exception running find-generic-password: …`).
  - `_mark_watched`, reached through the `mark_watched` param.
- **Outbound: YouTube.**
  - The home page HTML.
  - `youtubei/v1/reel/reel_watch_sequence`, `reel/reel_item_watch`, `like/like` and `like/removelike`.
  - The subscriptions Shorts tab.
  - The `/shorts/<id>` player APIs and the videostats URLs.
- **Outbound: browser cookie stores.**
  - Chromium browsers decrypt through the macOS Keychain (`security`).
  - Safari needs Full Disk Access for the terminal.
  - Firefox uses its profiles.
- **Outbound: tools on PATH.** ffmpeg merges `bv*+ba`. deno is optional and is yt-dlp's default
  runtime for YouTube's JS challenges.
- **Related:** `docs/research.md` records the probe that found the reel sequence, the research
  ancestor of `Api` and `Feed`. The probe script itself is only in git history (`cc938de`).

## Invariants and gotchas

**Output and environment**

- stdout must carry exactly one JSON line, because the player reads the last line. `quiet` keeps
  yt-dlp's own output on stderr.
- `cookiesfrombrowser=(BROWSER,)` passes no profile or keyring, so the newest `Cookies` file across
  every profile wins. A `chrome:Profile 1` style value is not supported.

**The `_find_files` patch**

- It only matters for Chromium browsers: Firefox finds its databases by glob and Safari by fixed
  paths.
- It is a plain substring test for `/Storage/`. `Guest Profile/Cookies` and `Snapshots/…/Cookies`
  stay candidates for "newest".
- If yt-dlp renames `_find_files`, the import fails and every command breaks.

**Signed-out cases**

- `loggedIn` is the server's view, the home page's `ytcfg.LOGGED_IN`, not whether cookies are
  present. Three outcomes:
  - Signed out with ids: exit 0 with `loggedIn: false`.
  - Signed out with no ids: exit with the signed-out message.
  - Signed in with every source empty, where the subscriptions tab returned no entries: exit 0 with
    empty `ids`.
  - If the subscriptions extraction itself fails, it is not caught. The result is a traceback, or the
    `cannot read … cookies` exit.
- A `ytcfg` that fails to parse counts as `{}`, so it also reads as signed out.

**Feed request volume**

- One `feed` call makes at most `MAX_BATCHES` sequence POSTs, plus one `reel_item_watch` and the home
  page. That holds even when the token path yields nothing new and the home path runs after it.
- `want` is checked only after a whole batch, and `add` does not cap. Replies routinely exceed
  `want`: a home reply is every seed plus at least one batch.

**Feed tokens**

- If the token path adds no new ids (all already seen, or an error), its advanced token is always
  discarded. The reply carries the home path's token instead, or null when that failed or when the
  subscriptions fallback ran.
- A null `token` in the reply makes the player start from the home page next time. That happens:
  - on the subscriptions source;
  - when the sequence ended;
  - when both the token and the home paths failed;
  - when home gave seeds but no continuation;
  - when `scroll` raised after adding ids.

**Cost per call**

- Every `Api` re-reads the browser's cookies and re-fetches the home page. That is once per `feed`
  and once per like, plus a second cookie read in the subscriptions fallback.
- The extractor is never `initialize()`d, so the `PREF` hl/tz, consent, and cookie-rotation setup
  are skipped. The InnerTube context is ytcfg's, passed verbatim.

**`download`**

- The cookie retry fires on any `DownloadError`, network failures and a missing ffmpeg included.
- Format selection does not check for ffmpeg. Without ffmpeg, the `bv*+ba` merge aborts in
  `process_info` instead of falling back to `b`. Both attempts fail, and the call ends as a
  traceback.
- A fallback format can give a path that does not end in `.mp4`. The player uses the reply's `path`
  verbatim.
- The reply's `width` and `height` are not in the player's `Short` type and nothing reads them.

**`watched`**

- It cannot report a failed ping: the pings are `fatal=False` and warnings are suppressed. It can
  still exit non-zero after the pings went out, when the later format selection finds no usable
  format. The player ignores the result either way.
- It fires whenever cookies were passed, even with no login.
- yt-dlp reports a watch to nearly the end (`cmt = length - 1`), although the player sends it after
  `min(10 s, duration / 2)`.
- Each call is a full logged-in extraction.

**`like` / `unlike`**

- No `likeParams` is sent, and no response field is checked.

## Open questions

- Should a token path that returned only seen ids, or that raised after adding ids, keep its last
  good continuation instead of restarting from home?
- Is reporting a near-complete watch after about 10 s of play acceptable for how YouTube personalizes
  the next batches?
- Should the cookie filter also skip `Guest Profile`, `Snapshots` and other profiles, which still
  compete for "newest"?
- Are raw tracebacks for non-cookie errors an accepted part of the contract?

## To verify

- External YouTube behavior that no source can prove:
  - `LOGGED_IN` sits in the home page's first `ytcfg.set` block.
  - A dead sequence token raises an error rather than returning an empty 200.
  - Reusing the home page's `YoutubeDL` for the subscriptions tab gets a 401.
  - `like/like` and `like/removelike` with only `{target}` change the account's state.
  - The videostats pings land in the account's Shorts watch history.
- Safari without Full Disk Access fails at `open` with a `PermissionError`, rather than earlier with
  a `FileNotFoundError`.
- The Keychain report has been checked only against a stub of yt-dlp's cookie reader. Still
  untested:
  - a real Deny on the macOS prompt;
  - whether a newer yt-dlp keeps the `find-generic-password` warning text it matches.
