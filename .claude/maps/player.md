# player Map
> Static understanding snapshot, not a decision history.
> See `.claude/decisions/player.md` for the paired decision history.
> Verified: 2026-10-02 (5 research concerns; 29 claims checked by 3 independent verifiers:
> 20 confirmed, 9 partial and corrected, 0 refuted; 4 bugs confirmed)
> Maintained: 2026-10-03 (targeted verification: the confirmed bugs are fixed and covered by pane
> tests. `start` and `play` write only while their epoch is current. `pause` holds back a Short still
> on its way. `session.start` gives the input source back after the setup check. `dir` lives in
> `shorts` once a `/clear` has passed. The host findings it cites now live in `docs/research.md`.
> Later the same day: the feed error, playback error and off-terminal texts were reworded.)

## Responsibilities

The mod itself: a Claude Code plugin of function hooks. It plays the logged-in YouTube Shorts feed in
a terminal pane opened with `/shorts`. It is responsible for:

- **Wiring and lifecycle.** The plugin manifests and the single hooks module. It sets up each load
  and session, survives a hot reload and a `/clear`, and cleans up on close and at session end.
- **Setup.** It checks for yt-dlp's Python, ffmpeg with `audiotoolbox`, and the optional deno. When a
  required one is missing, it offers to hand the install to Claude.
- **Browser choice.** It asks which browser holds the YouTube login, stores the answer, and passes it
  to the helpers.
- **Feed queue and downloads.** It refills the queue from `helper/yt.py feed`, downloads the current
  Short first and keeps 5 more ready, deletes old files, and keeps a local "seen" list. It also
  reports a Short watched to YouTube.
- **Playback.** One `ffmpeg -re` per Short writes a raw frame file and plays sound. A ~30 Hz ticker
  blits the frame to the pane as a pixel `Image`, or as half-block `Raster` cells where pictures
  are refused.
- **The pane.** It draws the picture, the author link, the title, a status and clock line, and a 2×4
  grid of hotkey buttons.
- **Keys and the input source.** `j k p r / l m o x`. While the pane holds the keyboard,
  `helper/ime.py` switches macOS to an ASCII layout so a CJK input method cannot swallow the hotkeys.

It does not talk to YouTube itself. That is `helper/yt.py` in the `feed` module, reached only
through `runHelper`.

## Key types

- **`Shorts`** (types/index.d.ts): the one value the host keeps across hot reloads, in the `shorts`
  atom (`$.state`, key `cc-shorts`/`shorts`, default `EMPTY`).
  - Its fields are `queue`, `cur`, `shorts` (id → `Short`), `status`, `message`, `pos`, `muted`,
    `liked?`, `mode?`, `frame?`, `isLoggedIn`, `inputSource?` and `dir?`.
  - `dir` is written only once a `/clear` has passed.
  - `EMPTY` is idle, with an empty queue and `isLoggedIn: true`.
  - The `PluginState` augmentation types it, and `plugin.json` points `types` at this file.
- **`Short`**: `{id, title, author, duration, hasAudio, path?}`. `path` is absent until the Short is
  downloaded, and again after cleanup.
- **`Status`**: one of `idle`, `loading`, `playing`, `paused` or `error`.
- **`Mode`**: `image` (real pixels: kitty, Ghostty) or `raster` (half blocks: iTerm2 and the rest).
  It stays undefined until decided, and `image` is tried first.
- **`Frame`**: `{file, width, height, columns, rows}`. The frame file the running ffmpeg rewrites, its
  pixel size, and the cell box it is drawn in.
- **`Player`** (module only): the running ffmpeg. `{id, stream, mode, frame, start, pos, stderr}`.
- **`Missing`**, **`Browser`** / **`BROWSERS`** (lib.ts).
  - `BROWSERS` lists nine entries, likeliest first: chrome, safari, edge, firefox, brave, opera,
    vivaldi, chromium and whale.
  - Each has a yt-dlp id, a display name, and a folder under `~/Library/Application Support`.
  - Safari has no folder and is always present.
- **`HelperReply<T>`** (`{value} | {error}`) and **`FeedReply`**: what `runHelper` returns, and the
  parsed `yt.py feed` reply.
- **Constants**:
  - `PANE = 'shorts'` and `VIDEO = 'video'` (the picture's element key);
  - `KEY_COLUMNS = 9` and `KEY_GAP = 2`;
  - `WATCHED_SECONDS = 10`, `SEEN_KEPT = 1000`, `PRELOAD = 5`, `LOW_WATER = 5`;
  - `CHROME_ROWS = 6`: author, two title rows, status, and two key rows.
- **`$.store` keys** (kept across sessions):
  - `browser`: the chosen yt-dlp browser id.
  - `token`: the feed's sequence continuation.
  - `seen`: ids that started playing, capped at the last 1000.
- **Module-level state**, which lasts one load of the module:
  - **Session**: `dir`.
  - **Setup**: `python`, `checking`, `isSetUp`, `browser`.
  - **Pane**: `layout`, `lastSource`, `lastCells`.
  - **`/clear`**: `carried`.
  - **Playback**: `epoch`, `player`, `ticker`, `failures`, `loadMark`, `frameSeq`, `isBlitting`,
    `generation`, `lastDeny`.
  - **Feed**: `marked`, `refilling`.
  - **Downloads**: `waiting`, `isDownloading`, `downloads`.
  - **Keys**: `hadKeys`, `keysChain`, `likeChain`.
- **lib.ts** holds the pure helpers, which take no `$`:
  - setup wording: `shebangPython`, `nameList`, `brewCommand`, `setupToast`, `installQuestion`,
    `installPrompt`;
  - browser lookup: `findBrowser`, `browserOptions`, `browserQuestion`;
  - sizing: `videoBox`, `frameSize`;
  - the ffmpeg argv: `ffmpegArgs`;
  - progress parsing: `parseProgress`;
  - cells: `toCells`, `blankCells`;
  - `clockTime` and `lastLine`.

## Public entry points

- **Loading.** `hooks/hooks.json` loads `hooks/register.tsx`, which exports `register`.
  `.claude-plugin/plugin.json` and `marketplace.json` publish the repo root as the plugin.
- **Host hooks in `register`:**
  - `session.start`;
  - `command.run` for `/shorts` (argument hint `[browser]`; only the literal `browser` is honored);
  - `ui.render` for the `Pane` with request id `shorts`;
  - `ui.close` for id `shorts`;
  - `session.end`;
  - `classic.SessionStart`.
- **Pane hotkeys** (plain Buttons, drawn on the terminal only):
  - Row 1: `j` Next, `k` Prev, `p` Pause/Play, `r` Replay.
  - Row 2: `l` Like/Unlike, `m` Mute/Unmute, `o` Open ↗, `x` Close.
  - An author Button, which has no hotkey, opens the Short in the browser.
- **`helper/ime.py`**:
  - `english` switches to the last-used ASCII-capable layout unless the current source already is
    one, and prints `{"was": id | null}`. Off macOS it prints `{"was": null}`.
  - `select ID` selects an enabled input source and prints `{"id": ID}`.
  - It reaches Carbon/HIToolbox TIS through ctypes, so any Python can run it.
- **Tests** run with `claude plugin test .`.
  - `tests/lib.test.ts` covers lib.ts.
  - `tests/pane.test.tsx` drives the hooks through the host's testing API: setup, browser, drawing,
    downloads, the input source (also after a hot reload with the pane closed), replay, a skip while
    ffmpeg is starting, likes, Open (also while a Short is downloading), `/clear`, and a hot reload
    after a `/clear`.
  - Other checks: `claude plugin validate .claude-plugin/plugin.json` and
    `bunx -p typescript tsc -p . --noEmit`.

## Data flow / lifecycle

### 1. Load and `session.start`

The first load and every hot reload run this. A `/clear` does not.

- Module state starts fresh, and `loadMark` (the load time in base 36) is fixed for this load.
- `session.start` calls `next` first. Then it:
  1. sets `dir` to the state's `dir`, or else to `$TMPDIR/cc-shorts/<session id>`;
  2. reads `browser` from the store;
  3. starts `checkSetup` without awaiting it, and toasts what is missing when it settles;
  4. registers `/shorts`;
  5. sweeps old session dirs (`find … -mtime +1 -exec rm -rf`) without awaiting it.
- It then reads the panes and the state, and rebuilds `hadKeys` from `inputSource`.
- If the pane is not open, it calls `holdKeys(false)` once the setup check it started has settled. No
  draw comes to a closed pane, and until the check names `python`, `holdKeys` does nothing.
- Then exactly one of:
  - **Pane open and `playing` or `loading`:** `play(pos)` resumes after the reload.
  - **Pane open, `paused`, raster, with a frame:** it rebuilds `lastCells` from the frame file still
    on disk and invalidates the render.
  - **Pane closed and status not `idle`:** `shutDown`.

### 2. `/shorts`

1. Until a check has passed, it awaits `checkSetup`.
   - If a required tool is missing, it calls `offerInstall` and returns without opening the pane.
   - It asks the install question again on every `/shorts` until the tools are there.
2. If no browser is chosen yet, or the argument is `browser`, it runs `chooseBrowser`. A dismissed or
   unknown answer returns without opening the pane.
3. It opens the pane: `{id: 'shorts', title: 'Shorts', focus: true, columns: 50, rows: 40}`.
4. It calls `play(pos)` only from `idle` or `error`. Otherwise it only refocuses the pane.

### 3. Setup

- **`checkSetup`.** It runs three probes in parallel:
  - `findPython`: the `#!` interpreter of the `yt-dlp` on PATH, then `$PIPX_HOME`,
    `~/.local/pipx`, and `~/Library/Application Support/pipx` venvs. It takes the first that passes
    `import yt_dlp`.
  - `ffmpeg -hide_banner -devices`, which must exit 0 and list `audiotoolbox`.
  - `deno --version`, which is optional.

  It then sets `python` and `isSetUp`. `isSetUp` stays true for the rest of the load once no required
  tool is missing.
- **`offerInstall`.** It asks through `$.ui.ask`. Only an exact `Ask Claude to install` answer
  submits `installPrompt` with `$.prompt.submit({asUser: true})`. The prompt names the brew command,
  says to leave tap-trust warnings alone, and says to stop on sudo or a password.
- **`chooseBrowser`.**
  - It offers the browsers whose folders exist, at most four, with the current one first. The
    question names the others that are present. Any of the nine can be typed in, even one whose folder
    is missing.
  - With only Safari present, it picks Safari without asking, even on `/shorts browser`.
  - A dismissal, or an answer it does not recognize, returns false. An unrecognized answer also
    toasts the supported list. In both cases `/shorts` does not open the pane, even when a browser was
    already stored.
  - When the chosen id differs from `browser || 'chrome'`, it deletes the stored `token`, since the
    feed position belongs to the old account.
  - It stores `browser` in the store and in the module.
- **`runHelper`.**
  - Every helper call awaits the latest `checking`.
  - It runs `[python, -B, <root>/helper/<script>, …]` with `CC_SHORTS_BROWSER` set when a browser has
    been chosen.
  - On exit 0 it parses the last stdout line as JSON. Otherwise the error is the last stderr line, or
    `exit N`.
  - It logs failures to the debug log and never rejects. `helper` returns only the value.

### 4. `play(from)`: the pipeline per Short

1. It bumps `epoch` (the stale-work guard) and stops the player.
   - Each of its state writes goes through `setShortsAt`, which writes only while that epoch is
     current. So a play that a newer action overtook cannot write over that action, even on a
     compare-and-set retry.
   - It checks `epoch` again before it recurses after a failed download.
2. If the queue is used up, it sets `loading` ("Fetching the feed…") and awaits `refill`. If the queue
   is still used up, it sets `error`: "Could not get the feed (…). Press j to retry, or switch
   browsers with /shorts browser".
3. If the current Short has no file, it sets `loading` ("Downloading…").
4. It drops waiting downloads outside the current Short and the 5 after it, then awaits the urgent
   download of the current one.
5. If the download failed:
   - The failure counted is the download `play` awaited for the current Short. That may be a preload
     job that was already queued or running. A `play` that has gone stale counts nothing.
   - After three in a row it resets the counter and sets `error` ("Downloads keep failing…").
   - Otherwise it toasts and skips to the next Short.
   - Skips and closes do not reset `failures`.
6. If it succeeded, it resets `failures`, fires `prepare`, and awaits `start`.

### 5. Feed and downloads

- **`refill`.** It is single-flight: concurrent callers share one call.
  - It sends `{token, seen: stored seen + the whole queue, want: 10}` to `yt.py feed`, with a 120 s
    timeout.
  - It stores the returned token, deleting it when the reply's token is null.
  - It appends the ids that are not already queued and sets `isLoggedIn`.
  - On failure it resolves with the error text.
- **`download(id, isUrgent)`.**
  - `downloads` (id → promise) dedupes calls and caches results.
  - Urgent jobs go to the front of `waiting`. A job already running is never pre-empted.
  - A result of `undefined` (a failure or a drop) evicts the entry, so a later call retries.
  - `downloadNext` is the single serial worker.
- **`fetchShort`.** It reuses a stored `path` when the file still exists. Otherwise it runs
  `yt.py download ID dir` (180 s) and stores the reply as the Short.
- **`prepare`.** It runs after each successful urgent download.
  - It refills without awaiting when 5 or fewer Shorts are left after the current one.
  - It queues non-urgent downloads for the next 5.
  - It deletes the files more than one behind `cur`, clearing their `downloads` entries and `path`.
    The one just behind stays, for `k`.
- **Seen vs watched.**
  - `markSeen` runs at every `start` and appends the id to the stored `seen` list, which keeps the
    last 1000.
  - Separately, `follow` sends `yt.py watched` once per load, after `min(10 s, duration / 2)` of
    play. The id goes into `marked` before the call.

### 6. Playback: `start`, `tick`, `follow`

**`start`**

1. It waits up to 2 s for the first draw to set `layout`, then checks `epoch`.
2. It takes `mode = s.mode ?? 'image'` and the box (`layout`, or `videoBox(50, 40)`).
3. It runs `mkdir -p dir`, then checks `epoch` again.
   - From this check to `player = p`, nothing is awaited.
   - So any later `play`, `pause` or `shutDown` finds this player and stops it.
4. It names the frame `frame-<loadMark>-<seq>.rgb`, so a reload never reuses a name ffmpeg would
   refuse to overwrite.
5. It spawns ffmpeg with `ffmpegArgs`, sets `player`, and deletes every other `frame-*` in `dir`.
6. It clears `lastSource` and `lastCells` and writes `playing`, `pos` and `frame`.
   - The updater writes only while `epoch` is still this one.
   - So a compare-and-set retry cannot draw over a newer `play` or `pause`.
7. It checks `epoch` a third time. A stop that landed during the write has already stopped this
   player, so it returns.
8. Otherwise it calls `markSeen`, starts `ticker = $.clock.every(33, tick)`, and starts `follow`.

**The ffmpeg command** is
`-progress pipe:1 -stats_period 0.25 -ss <start> -re -i <file> -map 0:v:0 -vf <scale,pad[,palette]>,format=rgb24 -c:v rawvideo -f image2 -update 1 -atomic_writing 1 <frame file>`.

- It appends `-map 0:a:0 -f audiotoolbox -` unless the Short is muted or has no audio.
- Raster frames are one pixel per column and two per row, reduced to a 32-colour palette per frame
  (Raster allows 1024 colour pairs).
- Image frames are about 10 px per column, 9:16, and at most 480 px wide.

**`tick`** handles one blit at a time (`isBlitting`).

- If `layout` no longer matches the frame box, it restarts at `p.pos` in the new box.
- **Image:** it blits `{file, format: 'rgb', width, height, generation: ++generation}`.
- **Raster:** it reads the file as bytes, encodes `▀` cells (upper pixel as fg, lower as bg), and
  blits the cells.
- A successful blit is kept in `lastSource` or `lastCells`, so a redraw shows the same picture.
- A deny goes to `denied`. Throws are swallowed, because the first frame may not be written yet.

**`denied`**

- An Image deny whose reason contains the word `alt` writes `mode: 'raster'` and restarts at the same
  position.
- Any other deny is logged only when its text differs from the previous deny (`lastDeny`), and is
  retried on the next tick. A Raster deny has no further fallback.

**`follow`** reads the progress stream.

- `pos = start + out_time`, written to state only when the whole second changes, so the clock
  redraws about once a second.
- It sends the watched report at its threshold.
- **Clean end** (`progress=end` and exit 0): it moves to the next Short.
- **Otherwise:** it sets `error` with "Playback failed (<last stderr line>). Press j for the next
  Short", leaving out the parentheses when stderr is empty, and keeps `pos`.
- It returns early once `player` is no longer this player. It never awaits the `result` of a stream
  it stopped.

**`stopPlayer`** clears `player`, cancels `ticker`, and ends the ffmpeg through `stream.return()`.

### 7. Rendering (`ui.render`)

- **Off the terminal:** it draws only "Run Claude Code in a terminal to play Shorts.". There are no
  keys, no `holdKeys`, and no `layout`.
- **On the terminal:**
  - It calls `holdKeys(isFocused && status !== 'idle')` without awaiting it.
  - It sets `layout = videoBox(bodyColumns, bodyRows)`. That is the widest 9:8 box that leaves
    `CHROME_ROWS`, at most 255 columns.
- **Picture:**
  - With a frame while `playing` or `paused`, it draws one of two elements, both keyed `video` and
    sized from the stored `frame`:
    - a `Raster` (`lastCells`, or blank cells);
    - an `Image` (`lastSource`, or the bare frame file). Its alt text is the title, or `' '` when
      there is none.
  - Otherwise it draws a box the size of `layout`, holding a centred message: `message`, or "Run
    /shorts to start".
- **Below the picture:**
  - the author Button, one row;
  - the title, two rows;
  - a status line: `▶`/`⏸ m:ss / m:ss`, plus Liked, Muted, and "Signed out: /shorts browser to
    switch";
  - the two rows of four 9-column key cells with a 2-column gap.
- **Redraws:** `tick` swaps the picture through `$.ui.blit` with no redraw. Redraws come from state
  writes.

### 8. Keys

- **`j` / `k` / `r`:** `skip(+1 / -1 / 0)` clamps `cur` to `[0, queue length]`, sets `pos = 0`, and
  calls `play`. `k` on the first Short replays it. `j` past the end refills.
- **`p`:** resumes with `play(pos)` when paused. Otherwise it calls `pause`:
  - **With a running player:** it bumps `epoch`, stops the player, and keeps `frame` and `p.pos`.
  - **With no player, but `loading` or `playing`:** a Short is on its way (being fetched, downloaded
    or started). It bumps `epoch` so that Short never starts, then writes `paused` with the message
    "Paused" and no `frame`, so no picture of the Short before shows.
    - If ffmpeg started while `pause` read the state, it pauses that player instead.
    - Pressing `p` again plays the Short from `pos`, reusing the download.
  - **In any other status:** it does nothing.
- **`l`:**
  - It flips `liked` at once, in one `update`.
  - The call is queued on `likeChain` and skipped if a later press overturned it.
  - It runs `yt.py like` or `unlike`. On failure it reverts, unless pressed again since, and toasts
    `like failed` or `unlike failed` on every failure.
  - `liked` is never read back from YouTube.
- **`m`:** flips `muted`, restarts through `play(player.pos)` when a player is running, and toasts
  muted or unmuted.
- **`o` / author:** calls `pause`, then runs `open https://www.youtube.com/shorts/<id>`, which uses
  the system default browser, not the cookie browser. So a Short still on its way also waits, paused,
  instead of playing behind the browser.
- **`x`:** `shutDown`, then `$.ui.close`.

### 9. Input source

- **`holdKeys(isHeld)`** acts only when the value changed since the last call and `python` is known.
  It queues `toEnglish` or `giveBackInput` on `keysChain`.
- **`toEnglish`** stores `was` as `inputSource` when `ime.py english` switched something.
  `ime.py` exits non-zero when the select fails, and `select ID` searches enabled sources only.
- **`giveBackInput`** runs `ime.py select <inputSource>` and then clears `inputSource`, even if the
  select failed.
- The source is given back when:
  - the pane loses focus;
  - the status becomes `idle`;
  - `shutDown` runs;
  - a non-`/clear` session ends;
  - a hot reload finds the pane closed, once the setup check has named `python`.

### 10. Close, end, `/clear`, hot reload

- **`shutDown`** runs from `x`, from the person's close (`ui.close`), and from `session.start` with
  the pane closed. It:
  1. bumps `epoch` and stops the player;
  2. drops every waiting download and clears `downloads` and `layout`;
  3. sets `idle` and clears `frame` and every `path`;
  4. gives back the input source;
  5. runs `rm -rf dir`.

  It keeps everything else (`queue`, `cur`, `pos`, `muted`, `liked`, `mode`, `message`), so the next
  `/shorts` resumes. It writes no position of its own:
  - while playing, `pos` is `follow`'s last write, up to about a second behind;
  - while paused, it is `pause`'s exact position.

  Its `rm -rf` has no catch. If it rejected, `x` would not go on to close the pane.

  A download already running is not cancelled. If it finishes afterwards, it writes its `path` back,
  and the file may land in a folder yt-dlp recreates. Commit 80beda5 records this as an accepted
  trade-off. The stale path is harmless, because `fetchShort` checks that the file exists.
- **`session.end` with any reason but `clear`:**
  - It bumps `epoch`, stops the player, gives back the input source, and runs `rm -rf dir` (2 s
    timeout).
  - It does not set `idle`, drop or clear downloads, or close the pane.
  - The host bounds the whole chain to 1.5 s by default and aborts any `$` call still in flight. In
    the worst case the `rm` is cut short and the folder is left to the sweep.
- **`/clear`:**
  1. `session.end` (`clear`) only snapshots `shorts` into `carried`.
  2. The host empties `$.state` and fires no `session.start`. The pane, ffmpeg, timers and module
     state carry on.
  3. `classic.SessionStart` takes `carried` and clears it on every source. Only with source
     `clear` does it write the snapshot back, together with the current `dir`.
  4. `dir` keeps the id of the session before the `/clear`; commit 4226c08 records this trade-off.
     Because `dir` is now in `shorts`, a later hot reload keeps using it instead of naming one after
     the new session id.
- **Hot reload:** the host kills the old load's children and cancels its timers. `$.state` and
  `$.store` survive, and `session.start` picks up as in section 1.

## Dependencies (inbound / outbound)

- **Inbound:** the Claude Code host.
  - Events: `session.start`, `command.run`, `ui.render`, `ui.close`, `session.end`,
    `classic.SessionStart`.
  - Button presses dispatched to `onPress`.
  - The host testing API, used by the tests.
- **Outbound, host APIs:**
  - `atom` / `read` / `update` (`$.state`; `update` is a compare-and-set with retry) and `$.store`;
  - `$.env.get` (`TMPDIR`, `HOME`, `PIPX_HOME`), `$.session.id` and `$.command.register`;
  - `$.ui.open` / `close` / `panes` / `ask` / `toast` / `log` / `blit` / `invalidate`;
  - `$.prompt.submit`;
  - `$.process.run` / `spawn` (no shell; `env` is laid over the host environment; `timeoutMs` kills
    and rejects);
  - `$.clock.every` / `sleep`;
  - `$.fs.read` (bytes, at most 4 MiB) and `$.fs.exists`;
  - `$.plugin.root`.
- **Outbound, the `feed` module:** `helper/yt.py` `feed`, `download`, `watched`, `like` and `unlike`,
  run with the yt-dlp Python and `CC_SHORTS_BROWSER`.
- **Outbound, external tools:**
  - ffmpeg with the `audiotoolbox` output device and the `palettegen` / `paletteuse` filters;
  - `find`, `rm`, `mkdir`, `which`, `head` and `open`;
  - `deno` and `brew`, which are only probed;
  - the macOS Text Input Sources API, through `helper/ime.py`.
- **Outbound, terminal:** a graphics protocol for `Image` (kitty, Ghostty). `Raster` everywhere else
  in the terminal. The desktop Code tab has neither element.
- **Type wiring:**
  - `tsconfig.json` extends the host-generated, gitignored `.claude-plugin/types/tsconfig.json`.
  - `hooks/globals.d.ts` declares `Uint8Array` base64 methods.

## Invariants and gotchas

**State and lifetimes**

- Only `$.state` (`shorts`) and `$.store` survive a hot reload. Every module variable resets.
- `mode` lives in `$.state`, so a new Claude Code session tries `image` again.
- Every async step that changes what plays is guarded by `epoch` (in `play` and `start`) or by
  `player === p` (in `tick`, `denied` and `follow`).
  - `play` and `start` also write state only while their epoch is current (`setShortsAt`).
  - Every stop (`play`, `pause`, `shutDown`, `session.end`) must bump `epoch` for these guards to
    hold.
- Helpers never reject (`runHelper`), and `downloadNext` relies on `fetchShort` never rejecting. If a
  job rejected, `isDownloading` would stay true and no download would run again.

**`session.start` and setup**

- `session.start` is deliberately not held up by the setup check: the first prompt waits for this
  hook, and helpers wait for the check instead.
- A `/shorts` during the session-start check starts a second check, and whichever check finishes last
  sets `python`.
- `isSetUp` is never re-checked once true. A Homebrew upgrade that moves the versioned Cellar Python
  breaks helpers until the next load.

**Feed and downloads**

- The stored `seen` list is feed exclusion, written when a Short starts. `watched` is YouTube watch
  history, sent at the threshold. They are separate.
- `refill` sends the whole session queue as `seen`, and the queue never shrinks, so the stdin
  payload grows with the session.
- Only urgent, current-Short failures count toward the three-failure stop. A failed preload is silent
  and is retried as urgent when that Short comes up.
- `prepare` deletes only files behind `cur - 1`. After going back with `k`, files beyond the preload
  window stay until `shutDown` or session end.
- `prepare` ignores the result of the `refill` it fires, so a failure goes only to the debug log. A
  feed error reaches the pane only through `play` awaiting a refill on an empty queue. That may be the
  same in-flight refill, shared through the single-flight promise.
- The stored `seen` list is updated by a non-atomic read-modify-write. The store is shared by every
  session of the plugin, so a concurrent write can be lost. The worst case is a Short served again
  later.
- `chooseBrowser` deletes the stored token, but a `refill` still in flight can write the old
  account's token back when it lands.

**`/clear`**

- Any `shorts` write between the snapshot and the restore is overwritten. That includes a finished
  download, a refill or a position tick.
- While `$.state` is empty, a draw shows the idle hint.

**Rendering and hotkeys**

- The picture element is sized from the stored `frame`, not from `layout`. After a resize it keeps the
  old size until `tick` restarts playback. While paused there is no ticker, so it waits for resume.
- `CHROME_ROWS` assumes the key grid fits in two rows, which needs 4 × 9 + 3 × 2 = 42 columns.
- `↗` is ambiguous-width in some terminals.
- Hotkeys fire only while the plugin's pane holds focus, and they are lowercased, so Shift+J is `j`.
- No Button is ever disabled. Keys that do not apply in a status are no-ops.
- Image mode makes the terminal re-read the whole frame file on every tick (about 850 KB for a
  40-column picture, per `docs/research.md`).

**Input source and cleanup**

- The input source is system-wide. If the person switches source by hand while the pane is focused,
  the old source still comes back on release.
- A failed `select` loses the remembered source, with only a debug log.
- The stale-dir sweep's `-mtime +1` means "untouched for more than 24 hours" on macOS, because BSD
  `find` rounds up to whole days.
  - It runs on every `session.start`, hot reloads included.
  - It does not exclude the current session's folder.
- `dir` falls back to `/tmp` only when `TMPDIR` is unset.
- The non-`/clear` `session.end` path allows its `ime.py` call 5 s and its `rm` 2 s, but the host
  gives the whole end chain 1.5 s by default. A dir left over that way is left to the sweep.

## Open questions

- Does the plugin's own `$.ui.close` from `x` reach its own `ui.close` hook? The code comment's "no"
  rests on a probe recorded in `docs/research.md` (`skipped: re-entry`). The host types only say that
  every close raises `ui.close`, and that the calling hook is skipped. If the hook does run,
  `shutDown` runs twice, which is harmless.
- Is it intended that `session.end` for `resume` or `logout` stops playback without setting `idle` or
  closing the pane?
- Should `/shorts <name>` pick a browser directly, given the `[browser]` argument hint?
- Should a browser switch also clear the queue, the `seen` list or `isLoggedIn`, as it does the token?
- Was opening Open and the author in the system default browser, instead of the browser chosen for
  cookies, deliberate?
- Is a 33 ms ticker that ignores the video's frame rate deliberate, given the host shows about 60
  blits a second?

## To verify

- Host behavior asserted only by comments, `docs/research.md`, or commit notes:
  - `/clear` empties `$.state`, and `classic.SessionStart` fires after the wipe.
  - `$.plugin.root` is the repo root, not `.claude-plugin/`.
- ffmpeg and terminal behavior:
  - `out_time_us` restarts from 0 after an input `-ss`.
  - `-atomic_writing` temp names start with the frame file's name.
  - Whether a not-yet-written frame file can draw an Image's `alt` and trigger the raster fallback on
    Ghostty.
