# docs Map
> Static understanding snapshot, not a decision history.
> See `.claude/decisions/docs.md` for the paired decision history (not created yet; the `MODULE: docs`
> Decision blocks live only in commit messages so far).
> Verified: 2026-10-02 (3 research concerns; 10 drift claims checked against the code and git
> history at HEAD by an independent verifier: 10 confirmed, 4 of them misleading enough to count as
> debt)
> Maintained: 2026-10-02 (targeted verification: the handoff's test count and a new Verification line
> for the stale-`start` fix)

## Responsibilities

`docs/` holds the project's design and research record and one research probe. The mod never runs
anything in it.

- **`docs/handoff.md`** is the handoff for whoever picks the work up next, usually a later Claude
  session. It does two jobs:
  - **It mirrors the code.** The decisions table and "Where v1 stands" restate how the mod behaves.
    Here the code is the source of truth, and the doc can drift from it.
  - **It is the only record of some things.** These are the dated research findings on the mod API,
    the feed and decoding, measured timings and sizes, rejected approaches with their reasons, the
    manual verification log, open items, and risks. Code cannot show any of these.
- **`docs/probe_reel.py`** is a one-off script that showed the logged-in reel sequence API gives an
  endless feed. It is the research ancestor of `Api` and `Feed` in `helper/yt.py`, and is kept as an
  artifact.

## Key types

**`handoff.md` sections, in order:**

1. **Header note.** Written 2026-10-02; v1 is commit `0d47b6d`; points to the open items.
2. **Goal.** Play the personalized, endless Shorts feed with sound. A fixed list does not count.
3. **Decisions made.** A 12-row table of product decisions agreed with the user:
   - content source, when a Short ends, Like, Replay, Open, no dislike;
   - opened only by `/shorts`;
   - Ghostty pixels with an iTerm2 fallback, sound, no Instagram Reels;
   - the repo root is the plugin;
   - way of working.
4. **Research finding 1: the Claude Code mod API.** Pinned to Claude Code 2.1.287. Covers:
   - pane sizing and redraws;
   - `Image` versus `Raster` and the blit limits;
   - `$.process`, `$.fs` and `$.store` / `$.state` lifetimes;
   - hot reload, `/clear` and `ui.close` re-entry;
   - hotkeys and input methods;
   - the dev and format commands.
5. **Research finding 2: the feed.** Pinned to yt-dlp 2026.08.19. Covers:
   - a table of feed sources;
   - the four steps of endless scrolling;
   - the root cause of the Chrome `Storage/` cookie bug;
   - metadata and likes.
6. **Research finding 3: downloading and decoding.** Covers:
   - logged-out downloads first, and the width-based selector;
   - one ffmpeg with `-update 1 -atomic_writing 1`, `-ss` restarts, and the 32-colour palette;
   - environment findings: deno, signed out, Safari and TCC, Homebrew tap trust, pipx's home.
7. **Where v1 stands.** A pipeline diagram, each file's role, then steps 0–8:
   - setup and browser;
   - the feed and preloading;
   - playback and display;
   - keys and the input source;
   - likes and the watched report;
   - cleanup, hot reload, `/clear` and the stale-dir sweep.
8. **Verification.** A log dated 2026-10-02: 33 tests, plus manual tmux runs and checks by the user.
9. **Closing lists.** "Still to verify and optimize" (5 items), "Risks" (5), "Rejected approaches"
   (10), "Related files", and "Recommended skills".

**`probe_reel.py`:**

- It runs at module level and has no `__main__` guard.
- `OUT` is `$TMPDIR/cc-shorts-probe/`. Raw responses carry account data, so they stay out of the repo.
- Helpers: `dump`, `find_all`, `find_strings`, and `call`, which swallows errors.
- It writes `seed_endpoint.json`, `item_watch.json`, `sequence_0..2.json` and `ids.json`. Each run
  overwrites them, and nothing deletes them.

## Public entry points

- **README.** Its Development section links the handoff for "the design, the research behind it and
  what is verified so far".
- **"Recommended skills"** tells the next agent to:
  - load `plugin-authoring` before changing the mod;
  - use `fable-mind` and a review skill;
  - commit with `commit-context`.
- **`.claude/MODULES.md`** registers the module.
- **The probe** is run by hand from the repo root with
  `~/.local/pipx/venvs/yt-dlp/bin/python docs/probe_reel.py`, and needs a YouTube login in Chrome.
  Nothing imports, runs or tests it.
- **Formatting.** `uvx ruff format helper docs/probe_reel.py` is listed only in the handoff, and
  `ruff.toml` sets 120 columns and single quotes. Prettier covers `hooks tests types` only, so the
  markdown is not formatted.

## Data flow / lifecycle

**The handoff**

1. It was created in `0d47b6d`, in Chinese, as the research and the plan.
2. `94b3b48` rewrote it to match the v1 code. The plan became "Where v1 stands", and the replaced plan
   items moved to "Rejected approaches".
3. `3a886b4` translated it in place to English.
4. Since then, every `feat:` or `fix:` commit edits it in the same commit and records a
   `MODULE: docs` Decision. A commit typically touches the decisions table, a "Where v1 stands" rule,
   and a new "Verification" bullet. The 13 commits that touched it end at `bed1bf0`.
5. The later commits (`16deaa2`, a reorder; `4910eb2`, a cleanup) changed no documented behavior.

**The probe**

1. Added in `0d47b6d` and reformatted by ruff in `cc938de`. It has not changed since.
2. `yt.py` moved on without it: the cookie patch was already there in `0d47b6d`; `3a780ee` split out
   `Api`; `bed1bf0` added the browser choice and readable cookie errors.

**The probe's run**

1. It builds a `YoutubeDL` with Chrome cookies and takes the `YoutubeTab` extractor.
2. It fetches the home page and collects every `reelWatchEndpoint` seed. It exits when there are none.
3. It calls `reel/reel_item_watch` on the first seed. The token is any `sequenceContinuation`, or else
   the seed's `sequenceParams`.
4. It calls up to three `reel/reel_watch_sequence` batches and counts the new ids against the seeds.
5. It dumps each response and the final id lists.

## Dependencies (inbound / outbound)

- **Inbound**
  - The README link.
  - `.claude/MODULES.md`.
  - The commit-context workflow, through `MODULE: docs` Decisions in feature commits.
  - The handoff's own pointers to the probe and to `Feed`.
- **Outbound (what the handoff describes)**
  - The `player` and `feed` modules.
  - The mod API types under `.claude-plugin/types/`.
  - yt-dlp internals.
  - YouTube's InnerTube API.
  - macOS TCC, the Text Input Sources API, Homebrew and pipx.
- **Outbound (what the probe calls)**
  - yt-dlp internals that still exist in 2026.8.19: `get_info_extractor`, `_download_webpage`,
    `extract_ytcfg`, `extract_yt_initial_data`, `generate_api_headers` and `_call_api`.
  - YouTube's home page and `youtubei/v1/reel/*`, with Chrome's cookies.
- **Packaging.** The marketplace's `source` is `./`, so `docs/` ships inside an installed plugin.

## Invariants and gotchas

**What matches the code**

These restated numbers match HEAD:

- `PRELOAD` 5, refill at 5 left, watched at `min(10 s, duration / 2)`, `seen` capped at 1000;
- `MAX_BATCHES` 3, the 33 ms ticker, three failed downloads;
- 33 tests (22 in `tests/lib.test.ts`, 11 in `tests/pane.test.tsx`).

When code and the handoff disagree, trust the code and fix the handoff in the same change.

**Cosmetic or dated statements at HEAD** (the misleading ones are under Confirmed bugs)

- **Finding 1's dev commands** pin `typescript@5` where README does not.
- **Finding 2, step 4** hard-codes `cookiesfrombrowser: ('chrome',)` and the `~/.local/pipx` Python.
  - That is a dated research record matching the probe.
  - The mod uses `CC_SHORTS_BROWSER`, and finds Python by yt-dlp's `#!` line first.
  - The same handoff gives the current behavior in finding 3 and in step 0.
- **The pipeline diagram** names frames `frame-N.rgb`. The code uses `frame-<loadMark>-N.rgb`, which
  step 3 gets right.
- **Step 3** says `find` deletes the other frame files "when a new Short starts". It actually runs at
  every ffmpeg start, which includes pause and resume, mute, resize and the fallback. It has no
  practical effect.
- **Small wording drift.**
  - The header says the open items are "at the end", but more sections follow them.
  - The decisions table says "Chrome at first", but the first `/shorts` asks, or quietly picks Safari
    when it is the only browser.

**The probe**

- It differs from `yt.py` in several ways:
  - It lacks the `Storage/` cookie patch that the handoff says every request needs.
  - It hard-codes Chrome.
  - It computes the auth headers once.
  - It treats the seeds as seen.
  - On a failed call, step 2 exits 1, while step 3 stops quietly and still exits 0.
- So it can run signed out, even though the handoff calls it "working".
- Its docstring's pipx path is a single hard-coded location. `helper/yt.py`'s docstring explains the
  shebang lookup instead.

**Other gaps**

- "Related files" leaves out `helper/ime.py`, `hooks/hooks.json`, `hooks/globals.d.ts` and
  `.claude-plugin/plugin.json`.
- The handoff does not mention `/map-module` or `.claude/maps/`, which CLAUDE.md's Knowledge Loop
  relies on.

## Confirmed bugs / technical debt

These are stale statements in `handoff.md` that would mislead someone changing the code.

- **Finding 1's check command.** It says to check with `claude plugin validate .`. With
  `marketplace.json` in the repo, that validates only the marketplace and skips the hooks-module
  check. The right command is `claude plugin validate .claude-plugin/plugin.json`, as README and the
  handoff's own "Related files" say.
- **Finding 1 on testing.** It says that only pure functions and the UI can be tested. In fact the
  pane tests stub host calls as hooks and exercise setup, the browser, download order, the input
  source, likes and `/clear`. The handoff's own "Verification" section relies on that.
- **"At most 3 batches per call".** This appears in "Where v1 stands" and in "Risks", and the
  `MAX_BATCHES` comment repeats it. It understates the request rate: one `feed` call can make up to
  six sequence requests.
- **Step 8: the input source after a hot reload.** It says `session.start` gives the input source
  back when the pane is closed. That has been false since `bed1bf0`, and the stale text hides a
  regression in the player.

## Open questions

- Is the probe a frozen record of the research, or should it stay runnable and in step with
  `yt.py`?
- Is finding 2's step 4 a historical recipe, or a description of the current code?
- Should the "Verification" log stay dated 2026-10-02, or be refreshed with each change?
- Which is the single source for dev commands: README (no format commands, no TypeScript pin) or the
  handoff?
- Should `docs/` ship inside the installed plugin?

## To verify

- **Host behavior** recorded only from probe mods or tmux runs:
  - `/clear` semantics;
  - `ui.close` re-entry (the host types say every close raises `ui.close`);
  - `isFocused` reaching the render on each focus change;
  - a height-only change not redrawing;
  - `return()` possibly never settling a stream's `result`;
  - the exact blit deny strings;
  - `$.process` being unavailable in the desktop Code tab.
- **Measurements and environment facts** that no source can confirm:
  - the timings: feed about 10 s, like 6–7 s, download 4–5 s versus 14 s, the `-ss` restart, ime
    about 70 ms;
  - the counts: about 18 home-shelf Shorts, 10–19 per batch;
  - the tool versions, the Safari TCC trace, and Homebrew tap-trust behavior.
