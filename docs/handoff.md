# cc-shorts handoff

> Research and plan written on 2026-10-02; v1 was built from the plan the same day (commit `0d47b6d`), and this document has been updated to match the code. Next up is further optimization; the open items are under "Still to verify and optimize" at the end.

## Goal

A Claude Code mod that plays the **YouTube Shorts feed** in a pane beside the terminal (personalized, endlessly scrollable, with sound). For the user, the feed is the heart of this mod: playing a fixed list does not count as done.

## Decisions made

| Item | Decision |
|---|---|
| Content source | The user's own YouTube Shorts feed (signed in through Chrome cookies) |
| When a Short ends | **Play the next one automatically** |
| Like / not interested | **Not in v1** |
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
- **`ui.close`**: a close by the user (ctrl+x x, the pane's close mark) fires the plugin's `ui.close` hook; **a `$.ui.close` the plugin calls itself does not fire its own hook** (the log says `skipped: re-entry`), so the plugin must clean up before it closes the pane itself.
- **A Button's `hotkey`** can only be a single digit or a single lowercase letter, and it works only while the pane has focus (`ctrl+x tab` or a mouse click; passing `focus: true` to `$.ui.open` gives it focus as it opens).
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

## Research finding 3: downloading and decoding (tested)

- **Download without cookies first**: without cookies a Short takes about 4–5 seconds; with cookies about 14 seconds, about 4 of them reading cookies, plus yt-dlp requests more client APIs (web creator, tv, and so on) when signed in. So download without cookies first, and retry with cookies only on failure (age restrictions, bot checks, and the like).
- **Pick the format by width**: a vertical video's `height` is its long side, so `height<=480` wrongly picks 240x426. The selector is `bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]/b`.
- **Do not convert a whole video to PNGs up front**: 50 seconds at 24fps and 360x640 comes to 1211 images, 312 MB, and 62 seconds of CPU.
- **One ffmpeg process can output both picture and sound**: `-re` decodes at real-time speed; the picture uses `-f image2 -update 1 -atomic_writing 1 frame.rgb` to overwrite the same file every frame (it writes a temporary file and renames it, so the reader never sees a half-written frame); the sound goes straight to the macOS speakers with `-f audiotoolbox -`. A 4-second clip took 4.18 seconds: the sound output did not slow the pace.
- **Restarting mid-video with `-ss` is fast**: the first frame comes out in 0.2 seconds, so resuming after a pause by restarting ffmpeg is workable.
- **The palette for the iTerm2 fallback**: each frame is squeezed to 32 colors with `palettegen=max_colors=32:stats_mode=single` plus `paletteuse=new=1:dither=none`, so a screen has at most 32×32=1024 color pairs, exactly Raster's limit. Small 48x96 frames run more than ten times faster than real time, and a single frame measured only 349 pairs.
- Converting to 48x84 raw rgb (for Raster) takes only 0.27 seconds; extracting the audio track (`-c:a copy`) only 0.03 seconds.
- This machine already has `ffmpeg` (9.0.2, with `audiotoolbox`), `ffprobe`, `yt-dlp` (pipx), plus `deno`, `node` and `bun` (yt-dlp uses deno to solve YouTube's JS challenges).

## Where v1 stands

```
/shorts ──► Pane (focus, asks for 50 columns × 40 rows)
              │  ui.render: Image (Ghostty) or Raster (iTerm2) + author / title / progress + five buttons
              ▼
  helper/yt.py feed ──► queue of video IDs ──► helper/yt.py download (preloads the next 2) ──► ffmpeg -re
     ▲  token and watched IDs kept in $.store                         │ picture: frame-N.rgb (atomic overwrite)
     └──────────────── refill at ≤5 left ◄───────────────────────────┘ sound: audiotoolbox
                                                                       progress: -progress pipe:1 → $.process.spawn
```

What each file does:

- `helper/yt.py`: Python with three subcommands, each printing one JSON line on stdout. The mod calls it through `$.process.run([pipx's python, '-B', yt.py, …])` (`-B` keeps `__pycache__` out of the repo).
  - `feed`: stdin takes `{ token, seen, want }`, returns `{ ids, token, source, loggedIn }`. It continues from the token first; if the token is dead it starts over from the home page; if neither gives anything it falls back to the subscriptions Shorts (and returns a null token). At most 3 batches per call.
  - `download ID DIR`: returns `{ id, title, author, duration, width, height, hasAudio, path }`.
  - `watched ID`: writes this Short to the account's watch history with yt-dlp's `mark_watched`.
- `hooks/lib.ts`: pure functions with no `$`, fully covered by tests: picture size, ffmpeg arguments, progress parsing, frames to character blocks, time formatting.
- `hooks/register.tsx`: the pane, queue and preloading, playback, the blit loop, the fallback, keys, cleanup.
- `types/index.d.ts`: the type of `cc-shorts.shorts` in `$.state` (queue, current position, each Short's metadata, playback status, mode, frame details, whether signed in).

How it works:

1. **The feed**: when ≤5 Shorts are left in the queue after the current one, call `feed` once to refill it (only one call at a time). The request's `seen` is the watched IDs in `$.store` (up to 1000 kept) plus the current queue, to avoid repeats. The new token goes back into `$.store`. A Short counts as "watched" only once it starts playing.
2. **Preloading**: the current Short and the next 2 stay downloaded; downloads queue up and run one after another, and a failed one may be tried again later. Video files older than the previous Short are deleted (one is kept for `k` to go back to). Downloads go to `$TMPDIR/cc-shorts/<session id>/`. After 3 downloads fail in a row it stops and says to check the network, then press `j` to retry.
3. **Playback**: one `ffmpeg -re` per Short, with arguments from `ffmpegArgs`.
   - The picture is written to `frame-N.rgb` (N goes up by 1 every time ffmpeg starts), atomically overwritten every frame; when a new Short starts, `find` deletes every other frame file in the directory. They are not deleted on stop because the last frame must stay on screen while paused, and an old ffmpeg still being killed may write one more frame after the delete.
   - Progress comes out as text through `-progress pipe:1 -stats_period 0.25`; the mod reads `out_time_us` through `$.process.spawn` to work out the current position, and writes `$.state` once per whole second to refresh the progress display.
   - The mod blits the current frame file to the pane with `$.clock.every(33)`, one blit at a time.
   - **Pause**: stop ffmpeg and note the position; **resume**: start it again with `-ss <position>`. **Mute** and **a pane size change** also restart ffmpeg at the current position. A video with no audio track outputs no sound at all.
   - **Next Short when one ends**: on `progress=end` with ffmpeg exiting 0, move on to the next; anything else shows an error, and `j` skips.
4. **Display**:
   - The picture box is worked out at 9:16, assuming a 1:2 width-to-height character cell, so 8 rows for every 9 columns, with 4 rows left below for author, title, progress and buttons (`videoBox`).
   - It first draws with `Image` and `{ file, format: 'rgb', width, height, generation }`; the frame is about columns × 10 pixels wide, at most 480 (`frameSize`).
   - When `blit` is refused with "draws its alt", record `mode: 'raster'` in `$.state` (Image is not tried again this session) and restart ffmpeg at the current position. In Raster mode ffmpeg outputs small 32-color frames of `columns × (rows × 2)`; the mod reads them with `$.fs.read`, turns them into `▀` blocks, and blits those.
   - A redraw reuses the source or cells of the last successful blit, so the picture does not flash blank.
5. **Interaction**: while the pane has focus, `j` next, `k` previous (from the start), `p` pause / resume, `m` mute, `x` close. Below the video are the author, the title, and a status line like "▶ 0:12 / 0:28 · muted"; when the last `feed` call was signed out it says "signed out: not your feed".
6. **Reporting watch history**: when a Short has played to `min(10 seconds, half its length)`, call `yt.py watched` once, at most once per Short (tracked in a module variable, so a hot reload may report one again, which is harmless). Preloading reports nothing.
7. **Cleanup**:
   - `x`: clean up first, then close the pane (a `$.ui.close` the plugin calls itself does not fire its own `ui.close` hook).
   - A close by the user: the `ui.close` hook cleans up.
   - Cleaning up means: stop ffmpeg and the timers, set the status back to idle, and delete the whole session temp directory. The queue, current position and mute setting stay, so the next `/shorts` carries on with the current Short from where it was closed.
   - Hot reload: the engine stops the old module's ffmpeg and timers itself. In `session.start`, if the pane is still open and was playing, it resumes from the noted position; if it is paused in Raster mode, it rebuilds the blocks from the paused frame's file and redraws (the blocks on screen live in a module variable, gone after a reload); if the pane is closed, it cleans up.
   - Session end: stop ffmpeg and delete the temp directory.
   - Every `session.start` also deletes directories under `$TMPDIR/cc-shorts/` untouched for more than a day (left behind by sessions that crashed).

## Verification

Verified (2026-10-02):

- 15 tests (pure functions + UI), `claude plugin validate` and `tsc` all pass.
- **End to end**: ran the whole flow in a Claude Code with `--plugin-dir` inside tmux. tmux does not support image protocols, which happens to cover "Image refused → fall back to Raster": the picture was real color frames, the progress moved, and the next Short played when one ended. `j`/`k`/`p`/`m`/`x` were all pressed; resuming after a pause picked up at the right position; during playback there was always exactly 1 frame file and 3–4 mp4s; `watched` was called after 10 seconds of watching; after `x` and after a hot reload, ffmpeg was confirmed killed and the temp directory deleted. The screen was read with `tmux capture-pane -p` (add `-e` to see colors), and the plugin log with `--debug-file`.
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
- The Python path is hard-coded to pipx's `~/.local/pipx/venvs/yt-dlp/bin/python`; `ffmpeg` depends on the PATH of the Claude Code process.

## Risks

- `reel/reel_watch_sequence` is an **unofficial API** and breaks the moment YouTube changes it. Automated requests with a signed-in session violate YouTube's Terms of Service and carry some risk to the account. The request rate should stay close to a person scrolling normally (about 15 Shorts per batch, fetching the next batch only when nearly out, at most 3 batches per call).
- `helper/yt.py` wraps yt-dlp's **private function** `yt_dlp.cookies._find_files` and uses internal methods like `_call_api` and `_download_webpage`; upgrading yt-dlp may mean changes here.
- The mod API is in EARLY ACCESS; upgrading Claude Code may mean changes here.
- Reading Chrome cookies may pop up a macOS Keychain authorization prompt.

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
- [`../.claude/MODULES.md`](../.claude/MODULES.md): the module list (feed, player, docs); commits write Decisions per module.

## Recommended skills

- **`plugin-authoring` (required before changing the mod)**: gives this version's API type files and examples, and how to use `claude plugin validate`, `claude plugin test` and hot reload.
- **`fable-mind` (recommended)**: load before multi-step tasks with many unknowns.
- **`code-review` or `review-iterate` (after changes)**: focus on the cleanup logic (ffmpeg processes, temp files) and the fallback logic.
- **`commit-context` (for commits, only when the user asks)**: write Decisions per module from `.claude/MODULES.md`.
