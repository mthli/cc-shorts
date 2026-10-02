# cc-shorts handoff

> Research and plan written on 2026-10-02; v1 was built from the plan the same day (commit `0d47b6d`), and this document has been updated to match the code. Next up is further optimization; the open items are under "Still to verify and optimize" at the end.

## Goal

A Claude Code mod that plays the **YouTube Shorts feed** in a pane beside the terminal (personalized, endlessly scrollable, with sound). For the user, the feed is the heart of this mod: playing a fixed list does not count as done.

## Decisions made

| Item | Decision |
|---|---|
| Content source | The user's own YouTube Shorts feed (signed in through the cookies of a browser they choose; Chrome at first) |
| When a Short ends | **Play the next one automatically** |
| Like | **`l` likes or unlikes the Short on screen** (added after v1) |
| Replay | **`r` plays the Short on screen again from the start** (added after v1) |
| Open | **`o` pauses and opens the Short on screen in the browser**, as the author does (added after v1) |
| Not interested / dislike | Not done |
| How it opens | **Only by hand with `/shorts`**; it does not open on its own at session start |
| Terminal | Mainly Ghostty (real pixels); **iTerm2 must work too** (character-block fallback) |
| Sound | Yes |
| Instagram Reels | No (see "Rejected approaches" for why) |
| Plugin directory | **The repo root is the plugin directory**; load it in development with `claude --plugin-dir ~/GitHub/cc-shorts` |
| Way of working | The user wants to see the plan and agree to it before any code is written. Conversation is in Simplified Chinese; code, comments and docs are in English |

## Research finding 1: the Claude Code mod API

Environment: Claude Code 2.1.287. The mod API is in EARLY ACCESS and may change. Full type definitions are generated when the `plugin-authoring` skill loads; after one load with `--plugin-dir`, the engine also puts the types in `.claude-plugin/types/` (with its own `.gitignore`) and generates a `tsconfig.json` at the repo root that extends them. **Load that skill before changing the mod**, then look up specific signatures by name.

Capabilities and limits that matter to this project:

- **Pane**: open it with `$.ui.open({ id, title })`; a `ui.render` hook matching `{ component: 'Pane', requestId: id }` draws it. When the user opens it (a slash command or a button), it shows at any width; when a program opens it on its own, the terminal needs ≥144 columns. `/shorts` counts as the user opening it. Read the usable size from `e.props.bodyColumns` and `e.props.scroll.bodyRows`; a change in height alone does not trigger a redraw.
- **The `Image` element** (terminal only): kitty and Ghostty show real pixels; **every other terminal (including iTerm2, and anything inside tmux) shows only the `alt` text**. Once it has a `key`, `$.ui.blit({ requestId, key, source })` swaps frames without a full redraw; it accepts at most 120 calls a second, and about 60 frames actually reach the screen.
  - An `ImageSource` can be `{ png }` (base64, at most 2 MiB), `{ rgba, width, height }`, `{ file, format: 'png' | 'rgb' | 'rgba', width, height, generation? }`, or `{ shm, ... }` (names of at most 30 characters on macOS).
  - With `file` or `shm`, **the terminal reads the file itself**, so the pixel data never passes through `$`: the cheapest option. `file` needs an absolute path; when the contents of the same path change, give it a new `generation`, or the terminal assumes nothing changed and does not read it again.
  - In a terminal without image support, `blit` returns `{ deny }`. The exact text seen in testing: `the Image draws its alt here: the terminal draws no placeholder images (env: inside tmux or screen)`. **The fallback to Raster is decided at runtime by matching the `alt` in it.** It is also refused right after opening, before anything is drawn (`no Raster of its own is mounted …`); that is not a reason to fall back, so try again on the next frame.
- **The `Raster` element** (terminal only): a fixed-size grid of characters. `cells` is base64 of little-endian u32 triples `[codePoint, fg 0x00RRGGBB, bg]`, one triple per cell. At most 1024 color pairs per screen; any beyond that take the closest color. It is also refreshed with `$.ui.blit`, but `columns × rows` must match what is already drawn, or the blit is refused. In iTerm2 it draws with `▀` (upper half block), each cell standing for 2 pixels, one above the other.
- **`$` cannot be stored in a module variable**: `claude plugin validate` reports "$ itself is assigned" and the module does not load at all. `$` can be passed as an argument to your own functions and used inside closures (a button's `onPress`, a timer callback), so every helper function in the code takes an explicit `$` parameter.
- **`$.process.run(argv, { stdin, timeoutMs })`**: runs once and returns when the process ends; stdout and stderr are each at most 4 MiB of text; the default timeout is 30 seconds, the longest 10 minutes.
- **`$.process.spawn`**: streams output, but only **UTF-8 text**, so it **cannot carry binary frames** (it suits reading ffmpeg's `-progress` text). The child process lives as long as the loop reading its output: ending the loop, calling `return()` on the stream, aborting through `next.signal`, or unloading the mod all kill it. **A stream ended with `return()` may never settle its `result`**, so the code does not wait on `result` for a player it stopped.
- **`$.fs.read`**: at most 4 MiB per call; `{ as: 'bytes' }` reads out `{ base64 }`. `$.fs.write` writes text only. **`$.fs` cannot delete or create directories**: deleting files and creating directories go through `$.process.run(['rm' | 'mkdir' | 'find', …])`.
- **`$.plugin.root`**: the absolute path of the plugin directory, used to find `helper/yt.py`.
- **`$.audio.play`**: takes `{ asset }`, `{ url }` or `{ base64, mime }`; on macOS it plays through `afplay` and **cannot start from a given position**; `shouldLoop` plus `signal` loops or stops playback partway. v1 does not use it: ffmpeg outputs the sound directly.
- **`$.clock.every / after / sleep`**: timers. A hot reload of the mod cancels every timer.
- **`$.store`** keeps data across sessions; **`$.state`** lasts only for the current session, **survives a hot reload**, and needs its type declared in `types/index.d.ts`. The module's own variables are reset by a hot reload.
- **`/clear`** (tested on 2.1.287 with a probe mod): it fires `session.end` with `reason: 'clear'` and **no `session.start` after it**; the session id changes and **the host empties `$.state`**. The process goes on, so the open pane, the registered `/shorts`, the module's variables, `$.clock` timers and `$.process.spawn` children all carry on. `classic.SessionStart` with `source: 'clear'` fires once the new session is in place, `$.state` already empty; a write there sticks.
- **`ui.close`**: a close by the user (ctrl+x x, the pane's close mark) fires the plugin's `ui.close` hook; **a `$.ui.close` the plugin calls itself does not fire its own hook** (the log says `skipped: re-entry`), so the plugin must clean up before it closes the pane itself.
- **A Button's `hotkey`** can only be a single digit or a single lowercase letter, and it works only while the pane has focus (`ctrl+x tab` or a mouse click; passing `focus: true` to `$.ui.open` gives it focus as it opens).
- **Input methods take the hotkeys** (tested 2026-10-02 on macOS with Simplified Pinyin): while a Chinese input method is on, the letter keys go into its candidate box and never reach the terminal, and some input methods take digits too, so no `hotkey` fires; mouse clicks are not affected. A mod has no rawer key event to catch them with. Tested with a probe mod: a pane's `isFocused` reaches its `ui.render` hook on every focus change (`ctrl+x tab`, a click, Esc), always before a 150 ms poll of `$.ui.panes()` saw it, and a render hook may call `$.process.run`. Selecting an input source (`TISSelectInputSource`) from a process the mod runs takes effect in the terminal at once, back to Pinyin as well: Chinese typed right after came out as Chinese, and 500 ms later the source was still the one selected.
- **CLI terminal only**: `$.process`, `Image` and `Raster` are all unavailable in the desktop app's Code tab.
- **Types**: TypeScript's es2023 standard library does not declare `Uint8Array.prototype.toBase64` or `Uint8Array.fromBase64`, but the runtime has them, so `hooks/globals.d.ts` adds the declarations.
- **Loading**: in development, `claude --plugin-dir <plugin dir>`; to load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` in the `env` of `~/.claude/settings.json`. An interactive session watches that directory and hot-reloads on file changes (a hot reload runs `register` and `session.start` again). The plugin is laid out as `.claude-plugin/plugin.json` + `hooks/hooks.json` + `hooks/register.tsx`. Check it with `claude plugin validate .`, `claude plugin test .` and `bunx -p typescript@5 tsc -p .`; format it with `bunx prettier@3 --write hooks tests types` and `uvx ruff format helper docs/probe_reel.py` (settings in `.prettierrc.json` and `ruff.toml`). The test environment has no fs, process or network, so only pure functions and the UI can be tested.

## Research finding 2: the feed (tested 2026-10-02, yt-dlp 2026.08.19)

| Source | Result |
|---|---|
| `yt-dlp ":ytrec"` (home page recommendations) | **0 Shorts** out of 150: yt-dlp drops the Shorts shelf |
| The home page's raw `ytInitialData` | Has a Shorts shelf (`shortsLockupViewModel`): **about 18** personalized Shorts **on the first page**, none on later pages |
| `https://www.youtube.com/feed/subscriptions/shorts` | Works and is all Shorts; used as the fallback. **Needs a brand-new `YoutubeDL` instance with `extract_flat`**; an instance that has already requested the home page gets a 401 |
| **`reel/reel_watch_sequence` (unofficial API)** | ✅ **Scrolls endlessly**: 10–19 Shorts per batch, all new, each batch carrying the way to the next; all 9:16 vertical, matching the interests of the account's home page |
| `instagram:user` | Marked CURRENTLY BROKEN by yt-dlp itself |

**How endless scrolling works** (a complete runnable probe script is in [`probe_reel.py`](./probe_reel.py); the real implementation is `Feed` in [`helper/yt.py`](../helper/yt.py)):

1. Request `https://www.youtube.com/` with cookies → get the page config and initial data with `extract_ytcfg` and `extract_yt_initial_data` → search them recursively for a `reelWatchEndpoint` to start from. It holds `videoId`, `playerParams`, `params`, `sequenceParams`, and `sequenceProvider: REEL_WATCH_SEQUENCE_PROVIDER_RPC`.
2. `POST reel/reel_item_watch` with body `{ playerRequest: { videoId, params: playerParams }, params, disablePlayerResponse: true }`, and find `sequenceContinuation` in the response.
3. `POST reel/reel_watch_sequence` with body `{ sequenceParams }`. The response's `entries[].command.reelWatchEndpoint.videoId` are this batch's videos; the `token` in `continuationEndpoint` is the next batch's `sequenceParams`, so just call it in a loop.
4. Sign-in signing and request headers come straight from yt-dlp: `ie._call_api(ep, body, id, context=ytcfg['INNERTUBE_CONTEXT'], headers=ie.generate_api_headers(ytcfg=ytcfg))`, where `ie = YoutubeDL({'cookiesfrombrowser': ('chrome',)}).get_info_extractor('YoutubeTab')`. Note that this runs on **the Python bundled with the pipx-installed yt-dlp**: `~/.local/pipx/venvs/yt-dlp/bin/python`; the system `python3` has no `yt_dlp`.

**No ads**: a fresh spot check of 3 batches, 41 Shorts in all, found only `reelWatchEndpoint`s with a `videoId`, no ads or other entries. The code still takes only entries that have a `videoId`. One `feed` call takes about 10 seconds (mostly reading cookies and requesting the home page).

**Root cause of the occasional signed-out feed (important)**: when yt-dlp reads Chrome cookies, it uses `os.walk` to search the Chrome directory recursively for **the most recently modified `Cookies` file**; even with a profile given, it still searches into subdirectories. A Chrome extension keeps its own cookie database at `Default/Storage/ext/glic/…/Cookies`, holding only Google cookies. yt-dlp reads whichever file was written last, so requests are sometimes signed in and sometimes not. On import, `helper/yt.py` wraps `yt_dlp.cookies._find_files` to skip files with `/Storage/` in their path. **Downloads and watch-history reports must also go through this patched Python**, never the yt-dlp command line.

**Metadata returned by the sequence**:

- Only 1–3 entries per batch carry `unserializedPrefetchData.playerResponse` (with `videoDetails.title`, `author`, `lengthSeconds`, and `streamingData`).
- The other entries have only a `videoId`, and no title in their `overlay`.
- **Title, author and duration all come from yt-dlp's metadata at download time**, since the download parses that information anyway. The public oEmbed (`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/<id>`) also works when tested, and needs no cookies.

**Likes** (tested 2026-10-02 on the user's account, liking one Short and taking the like back):

- `reel/reel_item_watch` carries the Short's like button: `likeButtonViewModel.likeStatusEntity.likeStatus` (`INDIFFERENT`, `LIKE`, `DISLIKE`), and `likeEndpoint`s with `likeParams` (to like) and `removeLikeParams` (to take it back).
- **`POST like/like` and `POST like/removelike` with only `{ target: { videoId } }` work**: no `likeParams` needed. Signed the same way as the feed (`Api` in `helper/yt.py`). `reel_item_watch` read `LIKE` right after the like and `INDIFFERENT` right after the removal.
- A call takes about 6–7 seconds (reading cookies and the home page, like `feed`). `removelike` on a Short not liked succeeds and changes nothing; an unknown video id answers HTTP 404.
- The pane does not ask a Short's status first: the feed hands out Shorts not seen before, so it counts every Short as not liked until liked from the pane. That saves a signed-in request per Short.

## Research finding 3: downloading and decoding (tested)

- **Download without cookies first**: without cookies a Short takes about 4–5 seconds; with cookies about 14 seconds, about 4 of them reading cookies, plus yt-dlp requests more client APIs (web creator, tv, and so on) when signed in. So download without cookies first, and retry with cookies only on failure (age restrictions, bot checks, and the like).
- **Pick the format by width**: a vertical video's `height` is its long side, so `height<=480` wrongly picks 240x426. The selector is `bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]/b`.
- **Do not convert a whole video to PNGs up front**: 50 seconds at 24fps and 360x640 comes to 1211 images, 312 MB, and 62 seconds of CPU.
- **One ffmpeg process can output both picture and sound**: `-re` decodes at real-time speed; the picture uses `-f image2 -update 1 -atomic_writing 1 frame.rgb` to overwrite the same file every frame (it writes a temporary file and renames it, so the reader never sees a half-written frame); the sound goes straight to the macOS speakers with `-f audiotoolbox -`. A 4-second clip took 4.18 seconds: the sound output did not slow the pace.
- **Restarting mid-video with `-ss` is fast**: the first frame comes out in 0.2 seconds, so resuming after a pause by restarting ffmpeg is workable.
- **The palette for the iTerm2 fallback**: each frame is squeezed to 32 colors with `palettegen=max_colors=32:stats_mode=single` plus `paletteuse=new=1:dither=none`, so a screen has at most 32×32=1024 color pairs, exactly Raster's limit. Small 48x96 frames run more than ten times faster than real time, and a single frame measured only 349 pairs.
- Converting to 48x84 raw rgb (for Raster) takes only 0.27 seconds; extracting the audio track (`-c:a copy`) only 0.03 seconds.
- This machine already has `ffmpeg` (9.0.2, with `audiotoolbox`), `ffprobe`, `yt-dlp` (pipx), plus `deno`, `node` and `bun` (yt-dlp uses deno to solve YouTube's JS challenges).
- **deno helps but is not required** (tested 2026-10-02, yt-dlp 2026.08.19): with no deno on the PATH a download still works and picks the same format, but yt-dlp warns that YouTube extraction without a JS runtime is deprecated and some formats may be missing.
- **Signed out there is no feed** (tested 2026-10-02): with no cookies the home page carries no Shorts shelf (0 seeds) and the subscriptions Shorts answer 401, so a browser signed in to YouTube is required; any yt-dlp reads will do (chrome, chromium, brave, edge, opera, vivaldi, whale, firefox, safari). yt-dlp reports a browser it cannot read as a `DownloadError` raised while handling a `CookieLoadError` ("failed to load cookies") raised while handling the real cause: Safari's `Cookies.binarycookies` sits where only an app with Full Disk Access reads (`PermissionError`), and a browser never used has no database (`could not find … cookies database`). Arc is Chromium-based but not among them.
- **Safari's cookies need Full Disk Access, not Files & Folders** (macOS 27.0, tested 2026-10-02): reading `~/Library/Containers/com.apple.Safari/Data/Library/Cookies` is denied by the kernel's System Policy (`System Policy: ls(…) deny(1) file-read-data …`, not Claude Code's sandbox), and the only TCC service sandboxd asked tccd about was `kTCCServiceSystemPolicyAllFiles`, attributed to the terminal (Ghostty) as the responsible process; in the ten minutes around it tccd saw no `kTCCServiceSystemPolicyAppData`/`AppDataDetailed` request, the per-app "data from other apps" grant macOS 27 manages in Files & Folders. So the grant goes to the terminal app and covers everything it runs; a CLI's own binary cannot hold it. The other browsers keep their cookies under `~/Library/Application Support`, which TCC does not guard (a Chromium-based one asks the Keychain for its "Safe Storage" key instead). The browser question says what Safari costs, and Safari's error names `/shorts browser` beside the setting.
- **Homebrew's tap trust** (Homebrew 7.0.7, tested 2026-10-02): `brew trust` exists, but only formulae, casks and commands from non-official taps need it (`Trust` skips `tap.official?`); yt-dlp, ffmpeg and deno are all in `homebrew/core`. Installing a formula not yet installed still prints a long warning listing every untrusted tap on the machine, with `brew trust …` and `brew untap …` lines to silence it; it does not stop the install (`brew install --dry-run hello`: the warning, then "Would install 1 formula", exit 0). Those lines are the person's call: trusting a tap lets Homebrew load its code, untapping removes it.
- **pipx's home moved**: a newer pipx on macOS installs into `~/Library/Application Support/pipx` (platformdirs), keeping `~/.local/pipx` only when that folder already exists, so a fresh `pipx install yt-dlp` does not land where the old hard-coded path looked. Homebrew's `yt-dlp` runs on its own Python in `libexec`, which imports `yt_dlp` too, and depends on `deno`.

## Where v1 stands

```
/shorts ──► Pane (focus, asks for 50 columns × 40 rows)
              │  ui.render: Image (Ghostty) or Raster (iTerm2) + author / title / progress + eight buttons
              ▼
  helper/yt.py feed ──► queue of video IDs ──► helper/yt.py download (preloads the next 5) ──► ffmpeg -re
     ▲  token and watched IDs kept in $.store                         │ picture: frame-N.rgb (atomic overwrite)
     └──────────────── refill at ≤5 left ◄───────────────────────────┘ sound: audiotoolbox
                                                                       progress: -progress pipe:1 → $.process.spawn
```

What each file does:

- `helper/yt.py`: Python with five subcommands, each printing one JSON line on stdout. The browser whose cookies it reads comes in `CC_SHORTS_BROWSER` (yt-dlp's name; Chrome's when unset); a browser it cannot read exits with "cannot read <browser>'s cookies: <cause>" (for Safari's `PermissionError`, the Full Disk Access setting to change), and a `feed` that finds no login and no Shorts exits with "signed out: no YouTube login in <browser>'s cookies" before trying the subscriptions, which need one too. The mod calls it through `$.process.run([the setup check's Python, '-B', yt.py, …])` (`-B` keeps `__pycache__` out of the repo).
  - `feed`: stdin takes `{ token, seen, want }`, returns `{ ids, token, source, loggedIn }`. It continues from the token first; if the token is dead it starts over from the home page; if neither gives anything it falls back to the subscriptions Shorts (and returns a null token). At most 3 batches per call.
  - `download ID DIR`: returns `{ id, title, author, duration, width, height, hasAudio, path }`.
  - `watched ID`: writes this Short to the account's watch history with yt-dlp's `mark_watched`.
  - `like ID` / `unlike ID`: likes the Short as the signed-in account, or takes the like back; exits non-zero when signed out. `feed` and these share `Api`: the chosen browser's cookies, the home page's `ytcfg`, and InnerTube calls signed with them.
- `helper/ime.py`: two subcommands, run the same way as `yt.py`, reaching macOS's Text Input Sources API through `ctypes` (about 70 ms a call).
  - `english`: switches to the ASCII-capable keyboard layout last used (ABC, US, Dvorak…) unless the current source is one, and returns `{ was }`, the source it switched away from, or null when it left things alone (and always off macOS).
  - `select ID`: selects that enabled input source; exits non-zero when there is none.
- `hooks/lib.ts`: pure functions with no `$`, fully covered by tests: picture size, ffmpeg arguments, progress parsing, frames to character blocks, time formatting, and the setup check's words (the toast, the question, the prompt for Claude, the `brew install` commands).
- `hooks/register.tsx`: the pane, queue and preloading, playback, the blit loop, the fallback, keys, cleanup.
- `types/index.d.ts`: the type of `cc-shorts.shorts` in `$.state` (queue, current position, each Short's metadata, playback status, mode, frame details, whether signed in, the input source to put back).

How it works:

0. **The setup check**: `checkSetup` looks, all at once, for a Python that imports `yt_dlp`, `ffmpeg` with the `audiotoolbox` output device (`ffmpeg -devices`), and `deno`. Each tool runs from Claude Code's own PATH, as playback runs it, so one installed outside that PATH counts as missing. The Python is the one the `yt-dlp` on the PATH runs on, read off its `#!` line (pipx's, Homebrew's, pip's), else pipx's own under `$PIPX_HOME`, `~/.local/pipx` or `~/Library/Application Support/pipx`; the first that runs `import yt_dlp` names the helpers' Python, and every helper call waits for the check.
   - `session.start` runs it unawaited (the first prompt waits for that hook) and toasts what is missing: "… are missing; /shorts offers to install them", or for deno alone, which only helps, its `brew install deno`.
   - `/shorts` runs it again until one passes, as something may have been installed since. With yt-dlp or ffmpeg missing it opens no pane and asks in the AskUserQuestion dialog ("Ask Claude to install" / "Not now"), the question naming the `brew install` commands. The yes submits a prompt as the person's own words (`$.prompt.submit` with `asUser`: they chose it): what is missing and why, the commands with a long timeout, to find out why a tool installed already cannot be seen, not to install Homebrew itself (its installer asks for a password; the person runs it), that the formulae need no tap trust and the untrusted-tap warning is to be left alone (no `brew trust`, no `brew untap`), to stop and report whatever needs sudo, a password or the person, and to say to run `/shorts` again. Claude's own commands go through the person's permission rules as any others.
   - **The browser**: the first `/shorts` (with `browser` unset in `$.store`), and `/shorts browser`, ask "Which browser are you signed in to YouTube with?" in the AskUserQuestion dialog. The choices are the browsers yt-dlp reads whose folder is under `~/Library/Application Support` (Safari, on every Mac, always), in a fixed order with the one in use first, four at most; the question names the rest, to type under Other, where any of yt-dlp's names, or one within a longer answer ("Google Chrome"), is taken, and one it cannot read gets a toast listing those it can. With Safari alone there is nothing to ask. The answer goes to `$.store` as `browser` and to every helper as `CC_SHORTS_BROWSER`; a different browser from the one before (Chrome when none was chosen) deletes the stored token, as the place in the sequence belongs to the old account. A dismissed dialog opens nothing. `session.start` reads `browser` back before anything resumes. The choice is not tried at once: the next `feed` is the test, and a failed one puts its reason in the pane ("Could not get the feed (<reason>). j retries; /shorts browser switches browser"). A `feed` signed out but with Shorts shows "Signed out: /shorts browser to switch" in the status line.
1. **The feed**: when ≤5 Shorts are left in the queue after the current one, call `feed` once to refill it (only one call at a time). The request's `seen` is the watched IDs in `$.store` (up to 1000 kept) plus the current queue, to avoid repeats. The new token goes back into `$.store`. A Short counts as "watched" only once it starts playing.
2. **Preloading**: the current Short and the next 5 stay downloaded; downloads queue up and run one after another, except that the Short to play now goes ahead of every one still waiting (the one already running finishes first), and a failed one may be tried again later. A skip drops the waiting ones no longer among the current Short and the 5 after it (going back with `k` downloads one again), and closing the pane drops every one that has not started. Video files older than the previous Short are deleted (one is kept for `k` to go back to). Downloads go to `$TMPDIR/cc-shorts/<session id>/`. After 3 downloads fail in a row it stops and says to check the network, then press `j` to retry.
3. **Playback**: one `ffmpeg -re` per Short, with arguments from `ffmpegArgs`.
   - The picture is written to `frame-<load>-N.rgb` (N goes up by 1 every time ffmpeg starts and counts from 1 again after a hot reload; `<load>` is the module load's start time in base 36, so a reload never picks a name the last load left behind, which ffmpeg would refuse to write over and exit), atomically overwritten every frame; when a new Short starts, `find` deletes every other frame file in the directory. They are not deleted on stop because the last frame must stay on screen while paused, and an old ffmpeg still being killed may write one more frame after the delete.
   - Progress comes out as text through `-progress pipe:1 -stats_period 0.25`; the mod reads `out_time_us` through `$.process.spawn` to work out the current position, and writes `$.state` once per whole second to refresh the progress display.
   - The mod blits the current frame file to the pane with `$.clock.every(33)`, one blit at a time.
   - **Pause**: stop ffmpeg and note the position; **resume**: start it again with `-ss <position>`. **Mute** and **a pane size change** also restart ffmpeg at the current position. A video with no audio track outputs no sound at all.
   - **Next Short when one ends**: on `progress=end` with ffmpeg exiting 0, move on to the next; anything else shows an error, and `j` skips.
4. **Display**:
   - The picture box is worked out at 9:16, assuming a 1:2 width-to-height character cell, so 8 rows for every 9 columns, with 6 rows left below for author, a two-row title, progress and two rows of four buttons (`videoBox`; eight buttons in one row outgrow the 50 columns `/shorts` asks for). Each button sits in a cell 9 columns wide (the widest, `r: Replay`, `l: Unlike`, `m: Unmute`, `o: Open ↗`) with 2 between, so the two rows' columns line up and a label that changes (Pause to Play) moves nothing. `↗` is an ambiguous-width character: a terminal set to draw those double-width (an iTerm2 option, off by default) pushes the Open cell one column over.
   - It first draws with `Image` and `{ file, format: 'rgb', width, height, generation }`; the frame is about columns × 10 pixels wide, at most 480 (`frameSize`).
   - When `blit` is refused with "draws its alt", record `mode: 'raster'` in `$.state` (Image is not tried again this session) and restart ffmpeg at the current position. In Raster mode ffmpeg outputs small 32-color frames of `columns × (rows × 2)`; the mod reads them with `$.fs.read`, turns them into `▀` blocks, and blits those.
   - A redraw reuses the source or cells of the last successful blit, so the picture does not flash blank.
5. **Interaction**: while the pane has focus, `j` next, `k` previous (from the start), `p` pause / resume, `r` replay (the Short on screen, from the start), `l` like / unlike, `m` mute, `o` open, `x` close. Below the video are the author (a Button: a click in the fullscreen terminal, or Tab then Enter, pauses here and opens the Short in the browser with `open`, as `o` does), the title (two rows), and a status line like "▶ 0:12 / 0:28 · Liked · Muted"; when the last `feed` call was signed out it says "Signed out: /shorts browser to switch".
   - **The input source**: while the pane holds the keyboard it is an English layout, so an input method cannot take the hotkeys. The render hook sees `isFocused` change and runs `ime.py english`, keeping the source it switched away from in `inputSource` in `$.state`; when the pane lets go, `ime.py select` puts that one back. A module variable makes each change act once (the pane draws every second while playing), and the switches go one at a time in a promise chain. An idle pane holds no keyboard: `shutDown` sets idle before the pane closes, and those last draws still say it has focus.
6. **Likes**: `l` flips the Short's id in `liked` in `$.state` (so a like lasts the session, through a `/clear` too), which the pane shows at once as "Unlike" and "Liked". The flip is read and written inside one `update`, so two presses landing in the same instant (it happens: tmux delivered `l l` as two presses in one millisecond) flip it twice instead of liking twice. The calls to `yt.py like` / `unlike` then go one at a time in a promise chain; when its turn comes, a call whose choice a later press has already overturned is skipped, so pressing `l` several times ends with YouTube on the last choice. A failed call puts the old state back (unless pressed again since) and toasts "like failed".
7. **Reporting watch history**: when a Short has played to `min(10 seconds, half its length)`, call `yt.py watched` once, at most once per Short (tracked in a module variable, so a hot reload may report one again, which is harmless). Preloading reports nothing.
8. **Cleanup**:
   - `x`: clean up first, then close the pane (a `$.ui.close` the plugin calls itself does not fire its own `ui.close` hook).
   - A close by the user: the `ui.close` hook cleans up.
   - Cleaning up means: stop ffmpeg and the timers, set the status back to idle, put the input source back, and delete the whole session temp directory. The queue, current position and mute setting stay, so the next `/shorts` carries on with the current Short from where it was closed.
   - Hot reload: the engine stops the old module's ffmpeg and timers itself. In `session.start`, if the pane is still open and was playing, it resumes from the noted position; if it is paused in Raster mode, it rebuilds the blocks from the paused frame's file and redraws (the blocks on screen live in a module variable, gone after a reload); if the pane is closed, it cleans up.
   - Session end: stop ffmpeg, put the input source back, and delete the temp directory.
   - The input source across a hot reload: `session.start` reads `inputSource` to know whether the last load still holds the keyboard, and puts it back when the pane is closed. A draw that comes before the setup check has named the helper's Python does nothing; a later draw acts.
   - `/clear`: not a session end for the player. `session.end` keeps a copy of `$.state` in a module variable and stops nothing; `classic.SessionStart` (`source: 'clear'`) writes it back, so the Short goes on playing in the same ffmpeg, with the same queue and temp directory.
   - Every `session.start` also deletes directories under `$TMPDIR/cc-shorts/` untouched for more than a day (left behind by sessions that crashed).

## Verification

Verified (2026-10-02):

- 33 tests (pure functions + UI), `claude plugin validate` and `tsc` all pass.
- **The browser**: `tests/pane.test.tsx` covers the question once with the browsers found (Chrome, Safari, Edge, Firefox), the answer stored and the old token deleted, the helpers run with `CC_SHORTS_BROWSER`, no question the next time, a failed feed's reason in the pane with `/shorts browser`, and `/shorts browser` asking again with the browser in use first. In tmux, `/shorts` asked with Chrome, Safari, Edge and Firefox and named Brave, Opera, Vivaldi and Chromium to type; Esc opened and stored nothing. `yt.py` by hand: `safari` exits with the Full Disk Access setting, `whale` (never used) with the missing database, `firefox` (a profile folder, no cookies) the same, and a feed signed out (cookies off) with "signed out: no YouTube login in chrome's cookies". No feed has run through a browser other than Chrome, and no answer has been picked in a running pane.
- **The setup check**: `tests/pane.test.tsx` covers the toast, the question, the prompt handed to Claude and "Not now" with yt-dlp and ffmpeg missing, and that with everything there `/shorts` opens the pane and the helpers run on the Python read off the `#!` line; both fail on the old module. In a Claude Code with `--plugin-dir` inside tmux and Homebrew off the PATH, the session toasted "ffmpeg and deno are missing", yt-dlp was found through pipx's folder, `/shorts` asked as designed with Homebrew missing, and "Not now" opened nothing; with the normal PATH there was no toast, and the debug log showed the Python read off `~/.local/bin/yt-dlp`'s `#!` line, `import yt_dlp` taking 157 ms. "Ask Claude to install" has not been pressed in a running session.
- **The input source**: the switch and the way back were tried with a probe mod (see "Input methods take the hotkeys" under research finding 1), and `ime.py` by hand from the shell. `tests/pane.test.tsx` covers switching once per focus change, putting the source back, nothing to put back when it was English already, and the close. In a running pane the user tried it (on Pinyin: into the pane, Esc out, close with `x`) and said the switching "works", without listing each step's result.
- **Likes against the real account**: `yt.py like` and `yt.py unlike` on one Short, checked with `reel_item_watch` before and after each (see "Likes" under research finding 2). `tests/pane.test.tsx` covers the button, the status line, the call and putting the state back after a failed call; `l` has not yet been pressed in a running pane.
- **Replay**: `tests/pane.test.tsx` covers the button and that a Short paused partway starts again with `-ss 0.00`, staying on the same Short. `r` has not yet been pressed in a running pane.
- **Open and the grid of keys**: `tests/pane.test.tsx` covers that `o` runs `open` as the author does. The test harness draws no text, so the columns lining up is worked out from the widths, not yet seen in a running pane, and `o` has not yet been pressed there.
- **Download order, skips and 5 preloaded**: `tests/pane.test.tsx` covers that the Short skipped to downloads right after the one running, ahead of those preloaded, that the ones skipped past never start, and that a close leaves the waiting ones unstarted; it fails on the old in-order chain, and without the drop on a skip. Not yet tried in a running pane.
- **A skip while ffmpeg is still starting**: `tests/pane.test.tsx` covers a `j` that lands while the Short before it is still making its folder. Only the Short skipped to spawns an ffmpeg. On the old `start`, which checked the epoch only before that wait, both Shorts spawned one, so two played at once. Not yet tried in a running pane.
- **End to end**: ran the whole flow in a Claude Code with `--plugin-dir` inside tmux. tmux does not support image protocols, which happens to cover "Image refused → fall back to Raster": the picture was real color frames, the progress moved, and the next Short played when one ended. `j`/`k`/`p`/`m`/`x` were all pressed; resuming after a pause picked up at the right position; during playback there was always exactly 1 frame file and 3–4 mp4s (then preloading 2); `watched` was called after 10 seconds of watching; after `x` and after a hot reload, ffmpeg was confirmed killed and the temp directory deleted. The screen was read with `tmux capture-pane -p` (add `-e` to see colors), and the plugin log with `--debug-file`.
- **Two hot reloads in a row mid-Short** (in tmux): playback goes on through both, each load writing frames under its own name. Before the load mark in frame names, the second reload restarted ffmpeg on the `frame-1.rgb` the first had left, and ffmpeg exited with `File … already exists`.
- **`/clear` mid-Short** (in tmux): the same ffmpeg played on and the progress kept moving through the `/clear`; when the Short ended the next one in the queue started on its own; after `/exit`, ffmpeg was gone and the temp directory deleted. `tests/pane.test.tsx` covers the copy and its one-time restore.
- After trying it, the user said it "works well", but which terminal it was tried in and what exactly was checked were not recorded item by item.

Status of the original "verify first while implementing" points:

1. **One ffmpeg outputting both the picture and `audiotoolbox`**: works, the pace is right, and an `-ss` restart takes 0.2 seconds. **Nobody has specifically confirmed that audio and video stay in sync.**
2. **Whether Ghostty `blit` reading `{ file, format: 'rgb' }` holds about 30fps steadily, and at what CPU cost**: **not verified.** Under iTerm2, blit is refused and the fallback kicks in; that was verified in tmux, and the exact refusal text is in research finding 1.
3. **How long a sequence token lasts**: **not verified**; that needs opening it the next day. When the token dies it starts over from the home page on its own, so nothing breaks.
4. **Whether the sequence contains ads**: none in 41 Shorts.
5. **Raster quality in iTerm2**: the picture shows correctly; whether the quality and frame rate are good enough needs the user to check in iTerm2 itself (tmux squeezes colors down to 256).

## Still to verify and optimize

- The three unverified items above: audio/video sync, Ghostty frame rate and CPU, and whether a token still works the next day.
- Pause, mute and pane size changes all restart ffmpeg, with a stall of about 0.2 seconds.
- In Image mode the terminal rereads the whole frame file every frame (about 400x712 under Ghostty, 850 KB a frame).
- Each `feed` takes about 10 seconds, and every call with cookies reads them again: every call is a new Python process.
- The setup check sees only Claude Code's own PATH (as playback does): a tool installed outside it counts as missing, and it is Claude, once asked, that finds out why. The install suggestions are Homebrew's alone, so macOS only.

## Risks

- `reel/reel_watch_sequence` is an **unofficial API** and breaks the moment YouTube changes it. Automated requests with a signed-in session violate YouTube's Terms of Service and carry some risk to the account; likes are writes to the account, made only when the person presses `l`. The request rate should stay close to a person scrolling normally (about 15 Shorts per batch, fetching the next batch only when nearly out, at most 3 batches per call).
- `helper/yt.py` wraps yt-dlp's **private function** `yt_dlp.cookies._find_files` and uses internal methods like `_call_api` and `_download_webpage`; upgrading yt-dlp may mean changes here.
- The mod API is in EARLY ACCESS; upgrading Claude Code may mean changes here.
- Reading a Chromium-based browser's cookies may pop up a macOS Keychain authorization prompt; Safari's need Full Disk Access for the terminal.
- A browser is offered when its folder exists, not when it holds a YouTube login (telling would read every browser's cookies, a Keychain prompt each); the first feed tells. A browser with several profiles goes through yt-dlp's own pick, the most recently used cookie database.

## Rejected approaches

- **Only `yt-dlp ":ytrec"`**: gets no Shorts.
- **Building our own recommendations** (channels and keywords as candidates, scored on local behavior): candidates and recommendation quality fall far short of YouTube's own algorithm, which does not meet the user's bar for the feed.
- **Instagram Reels**: the private API's anti-abuse checks are strict, the risk of a ban is high, and `instagram:user` is already broken.
- **Converting whole videos to PNGs up front**: too much disk and CPU; see research finding 3.
- **Passing frames through `$.process.spawn`**: it carries only UTF-8 text.
- **A ring of frame files overwritten in turn** (the original plan): `image2`'s `-atomic_writing` already guarantees no half-written frame is read, so one file is enough.
- **Playing an extracted audio track separately with `$.audio.play`**: having the same ffmpeg output the sound is simpler, and picture and sound naturally run on one clock.
- **Downloading and reporting watch history with the yt-dlp command line**: it reads the wrong cookie file (see research finding 2), and downloading with cookies is slow.
- **Detecting the terminal up front from an environment variable (`TERM_PROGRAM`)**: judging from a refused blit is more accurate, and Ghostty inside tmux also falls back correctly.
- **Storing `$` in a module variable**: validate does not allow it, and the module does not load.

## Related files

- [`helper/yt.py`](../helper/yt.py): the feed, downloads, and watch-history reports.
- [`hooks/register.tsx`](../hooks/register.tsx), [`hooks/lib.ts`](../hooks/lib.ts): the mod itself.
- [`types/index.d.ts`](../types/index.d.ts): the type of `$.state`.
- [`tests/`](../tests/): the tests `claude plugin test .` runs.
- [`probe_reel.py`](./probe_reel.py): the feed probe script, working. It writes raw responses to `$TMPDIR/cc-shorts-probe/`; since they hold account data, **keep them out of the repo**.
- [`../README.md`](../README.md): for people installing it: requirements, install, first run, keys, what it does with the account, troubleshooting.
- [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json): the repo as a one-plugin marketplace (`source: "./"`), for `/plugin marketplace add mthli/cc-shorts` and `/plugin install cc-shorts@cc-shorts`. With it in the repo, `claude plugin validate .` checks only the marketplace; the plugin and its hooks module are `claude plugin validate .claude-plugin/plugin.json`. Installed from a local path into an isolated `CLAUDE_CONFIG_DIR` (2026-10-02), the plugin installed and enabled, and the session's debug log said "hooks modules not loaded until workspace trust is accepted: cc-shorts", so an installed plugin's hooks module is picked up once the folder is trusted; the session stopped at onboarding (no login there), so nothing past that is seen, and installing from GitHub reads the default branch (master).
- [`../.claude/MODULES.md`](../.claude/MODULES.md): the module list (feed, player, docs); commits write Decisions per module.

## Recommended skills

- **`plugin-authoring` (required before changing the mod)**: gives this version's API type files and examples, and how to use `claude plugin validate`, `claude plugin test` and hot reload.
- **`fable-mind` (recommended)**: load before multi-step tasks with many unknowns.
- **`code-review` or `review-iterate` (after changes)**: focus on the cleanup logic (ffmpeg processes, temp files) and the fallback logic.
- **`commit-context` (for commits, only when the user asks)**: write Decisions per module from `.claude/MODULES.md`.
