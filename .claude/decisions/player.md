# Player Decisions

> Snapshot of current consensus. Evolution: `git log --grep="MODULE: player"`
> Last distilled: 2026-10-03 (HEAD = d261cd2)

## Active

### D1: ffmpeg frame files blitted as Image or Raster on a 33 ms tick

- **What**: One `ffmpeg -re` per Short writes an atomic frame file and plays sound through audiotoolbox, a 33 ms timer blits it as Image or Raster cells (falling back to Raster when an Image blit is denied), pause, mute and resize restart ffmpeg with `-ss`, and state lives in `$.state` so a hot reload resumes.
- **Why**: Play the feed with sound and auto-advance in a Claude Code pane on both Ghostty (pixels) and iTerm2 (cells).
- **Tradeoffs**: Pause and mute cost a ~0.2 s restart, the terminal re-reads a whole frame each tick, Raster has 32 colors, and since `$` cannot live in module state every helper takes it as a parameter.
- **Watch out**: Ghostty frame rate, CPU and A/V sync are unverified, a stopped spawn stream's result may never settle (`follow` returns early on purpose), and the mod API is early access.
- **Source**: 0d47b6d

### D2: Restore the paused Raster frame after a hot reload

- **What**: `session.start` with the pane open, paused, in Raster mode and holding a frame reads that frame file into `lastCells` through `frameCells` (which `tick` shares) and invalidates the render.
- **Why**: A hot reload empties the module-level `lastCells`, so the paused Raster redrew blank although the frame file was still on disk.
- **Tradeoffs**: One file read per reload, and the restored picture can be a frame past the one shown because a dying ffmpeg may write one more.
- **Watch out**: It relies on the paused frame file outliving the reload, which holds because it is deleted only when the next ffmpeg starts or at shutdown.
- **Source**: c9353c1

### D3: English UI text

- **What**: Buttons, status notes, loading, error and toast messages and the `/shorts` description are English, and `tests/pane.test.tsx` matches them.
- **Why**: An all-English project covers UI strings, not only comments and docs.
- **Tradeoffs**: No Chinese UI is left and there is no language switch.
- **Watch out**: Longer English messages may wrap differently in the 50-column pane, which only the UI tests have checked.
- **Source**: 3a886b4

### D4: Code reads in execution order

- **What**: register.tsx runs top-down (constants and state by section, shared plumbing, hooks in host firing order, then playback, feed, downloads, input source, keys, and `shutDown` last), lib.ts and both test files mirror it, and prettier formats it (120 columns, no semicolons, single quotes, `arrowParens: avoid`) with `// prettier-ignore` on the grouped ffmpeg and `find` argv.
- **Why**: Code appended where convenient twice stopped reading in the order it runs.
- **Tradeoffs**: Functions sit above the hoisted declarations they call, sections lead with their main function rather than strict call order, and `git blame` on moved lines points at the reorder.
- **Watch out**: There is no runtime effect, but new code must keep this order or it drifts again, and the `prettier-ignore` comments are kept up by hand.
- **Source**: cc938de, 16deaa2

### D5: Playback survives /clear

- **What**: `session.end` with reason `clear` copies `shorts` into the module variable `carried` and stops nothing, then `classic.SessionStart` with source `clear` writes it back once together with `dir`, which `session.start` reuses before naming a folder, while every other end reason stops ffmpeg and deletes the temp folder.
- **Why**: /clear fires `session.end` with no `session.start` after it and wipes `$.state` while the pane, ffmpeg and timers keep running, so treating it as an exit killed playback and lost the queue.
- **Tradeoffs**: State written between the copy and the restore is overwritten (at worst a feed batch or a stray mp4), `dir` stays the pre-/clear session's folder for as long as the state lives, and an in-app /resume still stops playback.
- **Watch out**: It rests on engine behavior seen only on 2.1.287 and tested in tmux Raster rather than Ghostty Image, and a Short ending within milliseconds of a /clear could play again.
- **Source**: 4226c08, e3304ae

### D6: Two-row title and an author Button that opens the Short

- **What**: The title wraps in a two-row `Box` with overflow hidden, and the author is a plain Button (`<author> ↗`) whose press pauses through `pause` (split out of `togglePause`) and runs `open https://www.youtube.com/shorts/<id>`.
- **Why**: One-row truncation lost most titles, and nothing in the pane led to the Short on YouTube.
- **Tradeoffs**: Titles clip after two rows with no ellipsis or marquee, a one-row title leaves a blank row, the video loses a row, and a Button replaces a Markdown link so the plugin hears the press and can pause.
- **Watch out**: Mouse clicks reach the Button only in the fullscreen terminal (inline panes need Tab then Enter), `open` is macOS-only, and a host change in how Buttons or wrapped Text measure rows can overflow the row budget.
- **Source**: 3b91bf9

### D7: Optimistic like on `l`

- **What**: `l` flips the Short's id in `$.state` `liked` in one update and shows the result at once, while calls run one at a time on `likeChain`, skip a call a later press overturned, and on failure restore the old state and toast.
- **Why**: The person wants to like Shorts without leaving the pane.
- **Tradeoffs**: Like state lasts the session only, every Short starts as not liked, and a quick double press may still send both calls.
- **Watch out**: A Short liked elsewhere shows as not liked, and a hot reload during a call may drop it with no toast while the pane keeps showing the press.
- **Source**: 3a780ee

### D8: Frame file names unique per module load

- **What**: Frame files are `frame-<load>-N.rgb`, `<load>` being `Date.now()` in base 36 at module load, and the cleanup `find` spares exactly the current name.
- **Why**: A reload's ffmpeg could be handed a frame file the previous load left, which it refuses to overwrite, so playback failed.
- **Tradeoffs**: Names are longer, and uniqueness assumes two loads never start in the same millisecond.
- **Watch out**: A frame a dying ffmpeg writes after the cleanup stays until the next start or shutdown deletes it.
- **Source**: 4b54ea8

### D9: English input source while the pane holds the keyboard

- **What**: `helper/ime.py` (ctypes over macOS Text Input Sources, ~70 ms on the yt-dlp venv's Python) selects the last-used ASCII-capable layout when the render hook sees `isFocused` turn true, keeps the replaced source in `$.state` `inputSource`, and restores it on blur, in `shutDown`, at session end, and from a closed-pane `session.start` once the setup check has named the Python.
- **Why**: Chinese and Japanese input methods swallow the letter and digit hotkeys before the terminal sees them, and the plugin API has no lower-level key event.
- **Tradeoffs**: A side effect runs from a render hook, it is macOS-only, a key within ~70 ms of focusing still goes to the input method, and a source changed by hand while focused is overridden on blur.
- **Watch out**: A crash or kill while focused, or a setup check that finds no Python, leaves the English layout selected, and a future engine may refuse `$.process.run` from a render hook.
- **Source**: 22f96cc, e3304ae

### D10: Replay and Open keys in a fixed key grid

- **What**: `r` replays the Short on screen from 0 through `skip($, 0)`, `o` opens it through `openInBrowser`, and a `cell` helper draws each key as a Button in a Box `KEY_COLUMNS` (9) wide, two rows of four with `KEY_GAP` 2: Next, Prev, Pause, Replay / Like, Mute, Open ↗, Close.
- **Why**: Replaying took two keys and played the previous Short in between, opening needed a fullscreen-only click, and centered rows of uneven width shifted whenever a label changed.
- **Tradeoffs**: There are two ways to open the browser, `KEY_COLUMNS` must be raised by hand for a longer label, and a pane narrower than the 42-column rows wraps them out of line.
- **Watch out**: `↗` is ambiguous-width, so a terminal drawing it double-width pushes the Open cell over, and the alignment was worked out from widths rather than seen in a running pane.
- **Source**: ecd14ec

### D11: The Short to play downloads first, five preloaded

- **What**: `waiting` and `downloadNext` run one download at a time, `play`'s `download(id, true)` goes to the front after dropping waiting entries outside `nextFew` (the current Short and the 5 after), `shutDown` drops all waiting ones, and `PRELOAD` is 5.
- **Why**: A fast skip made the Short to play wait behind preloads of Shorts already passed, and 2 preloaded fell behind a person scrolling.
- **Tradeoffs**: The running download is never cut short, so a skip can still wait ~5–14 s, up to ~7 mp4s sit on disk, yt-dlp runs more often, and going back with `k` downloads a dropped Short again.
- **Watch out**: Five preloads raise the request rate to YouTube (rate limits, account risk), serial downloads still starve on a slow network, and the download running at a close lands in the deleted temp folder.
- **Source**: 80beda5

### D12: Setup check, guided install, browser choice and marketplace

- **What**: Session start checks in the background for a Python that imports yt_dlp, ffmpeg with audiotoolbox and optional deno, `/shorts` re-checks and submits a Homebrew install prompt as the person's words when yt-dlp or ffmpeg is missing, the first `/shorts` and `/shorts browser` ask for a browser kept in `$.store` and passed as `CC_SHORTS_BROWSER`, and the repo is a one-plugin marketplace.
- **Why**: Let someone else install and start cc-shorts with whichever browser they are signed in with.
- **Tradeoffs**: Every session start runs a few unawaited processes (~200 ms), a wrong browser stays chosen until a feed fails, the brew rules are instructions rather than enforcement, browsers are offered by folder rather than login, and Safari costs Full Disk Access.
- **Watch out**: It is built on 2.1.287 alone, the marketplace install is seen only up to workspace trust, the install prompt and non-Chrome feeds are untried in a running session, and with marketplace.json present `claude plugin validate .` checks only the marketplace.
- **Source**: bed1bf0

### D13: Epoch guards against stale playback work

- **What**: Every stop (`play`, `pause`, `shutDown`, `session.end`) bumps `epoch`, `start` re-checks it after `mkdir` and after its `playing` write, `play` writes only through `setShortsAt` and re-checks before retrying a failed download, and `pause` with no player while loading or playing bumps `epoch` and holds the Short back as "Paused".
- **Why**: A skip, pause, close or Open landing during an awaited step could not stop the ffmpeg and ticker created afterwards, so two Shorts played at once or a Short started behind the browser.
- **Tradeoffs**: A stale start still pays for its `read` and `mkdir`, `p` while loading now pauses and shows "Paused" instead of a picture, and a press in the milliseconds before a play's first write is not caught.
- **Watch out**: A new stop path that does not bump `epoch` reopens these races, the write-window guard has no test of its own, and none of it has been tried in a running pane.
- **Source**: f5d912c, e3304ae

### D14: Pane messages in plain words that name the key to press

- **What**: The feed and playback errors end by naming the key to press ("Press j to retry, or switch browsers with /shorts browser"; "Playback failed (<stderr>). Press j for the next Short"), the off-terminal pane says to run Claude Code in a terminal, and the setup and browser questions lose vague or double-negative wording, while Buttons, status notes and the like and mute toasts stay terse.
- **Why**: Messages such as "j retries", "(j for next)", "Safari's need Full Disk Access" and "(and deno, which helps)" read as cryptic or vague.
- **Tradeoffs**: The longer errors wrap over more rows of the 50-column pane, and the tests pin the new wording.
- **Watch out**: The wrapping is checked only by UI tests, not in a running pane, and the README quotes "Could not get the feed (…)" and "Downloads keep failing", so a later rewording must update it too.
- **Source**: bcb06b4

## Superseded

- ~~lib.ts and the tests already followed pipeline order and needed only formatting (cc938de)~~ → replaced by **D4** in 16deaa2 (2026-10-02)
