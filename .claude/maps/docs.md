# docs Map
> Static understanding snapshot, not a decision history.
> See `.claude/decisions/docs.md` for the paired decision history. It is distilled through e3304ae,
> so it still describes the handoff and the probe until the change that removed them is committed
> and distilled.
> Verified: 2026-10-03 (3 research concerns; 15 claims checked against research.md, the code, the
> other maps and git by 2 independent verifiers: 13 confirmed, 2 partial and corrected, 0 refuted)

## Responsibilities

`docs/` holds one file, `docs/research.md`: the record of what the code cannot show. The mod never
reads or runs anything in it.

- **Product decisions** agreed with the user, and the goal they serve.
- **Dated research findings** from probes and experiments: the Claude Code mod API, the logged-in
  feed, downloading and decoding, and the machine (TCC, Homebrew, pipx).
- **The verification log**: how each behavior was checked (tests, a tmux run, the user's report, a
  stub script) or that it has not been tried in a running pane.
- **Open items, risks and rejected approaches**, each with its reason.

It does not describe how the code works. Its header sends that to `.claude/maps/<module>.md`, and
why the code is built that way to `.claude/decisions/<module>.md`.

## Key types

**`research.md` sections, in order:**

1. **Header note.** Begun 2026-10-02 as the research and plan for v1, the plan being in `0d47b6d`.
   It points to the maps, the decisions and `.claude/MODULES.md`.
2. **Goal.** Play the personalized, endless Shorts feed with sound. A fixed list does not count.
3. **Decisions made.** A 12-row table:
   - content source, when a Short ends, Like, Replay, Open, no dislike;
   - opened only by `/shorts`;
   - Ghostty pixels with an iTerm2 fallback, sound, no Instagram Reels;
   - the repo root is the plugin;
   - way of working.
4. **Research finding 1: the Claude Code mod API.** Pinned to Claude Code 2.1.287. Covers:
   - pane sizing and redraws;
   - `Image` versus `Raster`, the blit limits and the exact deny strings;
   - `$` not storable in a module variable;
   - `$.process`, `$.fs`, `$.plugin.root`, `$.audio`, `$.clock`, and `$.store` / `$.state` lifetimes;
   - `/clear` and `ui.close` re-entry;
   - hotkeys and input methods;
   - CLI-only APIs, missing base64 types, loading and the test harness;
   - installing from a marketplace.
5. **Research finding 2: the feed.** Pinned to yt-dlp 2026.08.19. Covers:
   - a table of five feed sources;
   - the four steps of endless scrolling, as probed;
   - no ads in 41 Shorts;
   - the root cause of the Chrome `Storage/` cookie bug;
   - metadata and likes.
6. **Research finding 3: downloading and decoding.** Covers:
   - logged-out downloads first, and the width-based selector;
   - one ffmpeg with `-update 1 -atomic_writing 1` and audiotoolbox, `-ss` restarts, and the
     32-colour palette;
   - the machine: deno optional, no feed signed out, cookie and Keychain failures, Safari and TCC,
     Homebrew tap trust, pipx's home.
7. **Verification.** "Verified (2026-10-02 to 2026-10-03)": the test count, then each behavior and
   how it was checked, then the status of the five points the plan said to verify first.
8. **Closing lists.** "Still to verify and optimize" (5 items), "Risks" (5) and "Rejected
   approaches" (10).

## Public entry points

- **README.** Its Development section links research.md for "the product decisions, the research
  behind them and what is verified so far", next to the check and format commands.
- **`.claude/MODULES.md`** registers `docs` with research.md as its one file.
- **The feed and player maps** cite it for host findings and measurements: the 850 KB frame reread,
  `ui.close` re-entry, `/clear` semantics, and the probe behind `Feed`.
- **CLAUDE.md's Knowledge Loop** never names it. A reader reaches it through the registry, the maps
  or the README.
- Nothing runs, imports or tests anything under `docs/`.

## Data flow / lifecycle

1. `0d47b6d` created `docs/handoff.md` in Chinese, as the research and the v1 plan, together with
   `docs/probe_reel.py`, the probe that found the endless reel sequence.
2. `94b3b48` rewrote the handoff to match v1 as built. The plan became "Where v1 stands", the
   replaced plan items moved to "Rejected approaches", and "Verification" and "Still to verify"
   were added.
3. `3a886b4` translated it in place to English. `cc938de` added the format commands and
   ruff-formatted the probe.
4. Ten `feat:` or `fix:` commits, `4226c08` to `e3304ae`, edited the handoff in the same commit as
   the code: decision rows, dated findings, "Where v1 stands" steps and verification lines. The test
   count went from 15 to 36.
5. The current change (uncommitted at this snapshot):
   - renames the file to `docs/research.md`;
   - drops "Where v1 stands", "Related files" and "Recommended skills", which the maps now cover;
   - keeps the `plugin-authoring` advice in finding 1;
   - moves the check and format commands to the README;
   - moves the marketplace-install finding into finding 1;
   - deletes the probe, which `git show cc938de:docs/probe_reel.py` still prints;
   - corrects the statements that had drifted from the code.
6. By its header, research.md changes when a finding, a verification, an open item, a risk or a
   rejected approach does. A code change alone goes to the maps.

## Dependencies (inbound / outbound)

- **Inbound**
  - The README link.
  - `.claude/MODULES.md`.
  - The feed and player maps.
  - The commit-context workflow, through `MODULE: docs` Decisions.
- **Outbound (what it points to)**
  - `.claude/maps/`, `.claude/decisions/` and `.claude/MODULES.md`.
  - The README's Development section.
  - `Feed` in `helper/yt.py`.
  - Git history: `0d47b6d` for the plan, `cc938de` for the probe.
  - The `plugin-authoring` skill.
- **Outbound (what it describes)**
  - The `player` and `feed` modules, and the mod API types under `.claude-plugin/types/`.
  - yt-dlp internals and YouTube's InnerTube API.
  - macOS TCC, the Text Input Sources API, Homebrew and pipx.
- **Packaging.** The marketplace's `source` is `./` with no file list, so `docs/` ships inside an
  installed plugin. `origin/master` still ships the handoff and the probe until this change lands.

## Invariants and gotchas

**Code is the source of truth**

- Many findings end in a clause on what the code does because of them. Examples are the fallback
  chosen by the deny's `alt` text, not awaiting a stopped stream's `result`, the `Storage/` patch,
  downloading signed out first, the format selector, the ffmpeg flags, the palette, and `ydl()`
  reading cookies at once. At this snapshot they match the code.
- When code and research.md disagree, trust the code and fix the clause in the same change.
- Numbers it restates that match the code:
  - 36 tests (22 in `tests/lib.test.ts`, 14 in `tests/pane.test.tsx`);
  - `MAX_BATCHES` 3 per `feed` call, about 15 Shorts a batch;
  - the format selector, and the palette with `reserve_transparent=0`;
  - 400x712, which is `frameSize` for a 40-column box.

**Dated or partial statements**

- **Finding 2's four steps are the probe's recipe.**
  - Step 4 hard-codes Chrome and `~/.local/pipx`.
  - Steps 2 and 3 leave out that `params` and `playerParams` are sent only when the seed has them,
    and that the seed's `sequenceParams` stands in when `reel_item_watch` returns no continuation.
    The probe and `Feed` both do this.
  - `Feed` differs from the probe: it reads the browser `CC_SHORTS_BROWSER` names, patches
    `_find_files`, adds the home-page seeds to the ids it returns, and shares a budget of three
    batches per call that stops once enough ids are in.
  - The current browser choice and Python lookup are only in the maps.
- **Terms defined only in the maps.** The verification log uses several: the setup check, the
  browser question, `CC_SHORTS_BROWSER`, `ime.py`, the load mark in frame names, the `/clear` copy,
  and "the old `start`", `pause` and `session.start`.
- **Observations not rerun.** "3–4 mp4s (then preloading 2)" dates from when two were preloaded.
  Finding 3's "tested 2026-10-02" bullet on signed-out feeds also holds the Keychain sentence, added
  on 2026-10-03 and checked only with a stub.
- **Pins.** Claude Code 2.1.287, yt-dlp 2026.08.19, macOS 27.0, Homebrew 7.0.7 and ffmpeg 9.0.2. The
  pipx bullet has no date or version, and finding 3's heading has no date.
- **The frame-size example.** 400x712 assumes a 40-column picture box, which needs a pane body of
  at least 42 rows. `/shorts` asks for 40 rows, which gives a 38-column box (380x676) when the host
  grants exactly that.

**Other**

- **`$` and module state.** Finding 1 says no module variable holds `$`. Module variables still
  hold host handles and closures over `$`: the player's spawn stream, the ticker's timer and the
  queued download jobs. That is how `stopPlayer` and `downloadNext` reach the host without a `$` of
  their own.
- The probe's warning now sits in finding 2's pointer: its raw responses carry account data and
  stay under `$TMPDIR`.
- No formatter covers `docs/`. Prettier covers `hooks tests types`, and ruff covers `helper`.

## Confirmed bugs / technical debt

- **`.claude/decisions/docs.md` describes the state before this change.**
  - D1 keeps the handoff rewritten with each behavior change, which research.md no longer does.
  - D2 names the deleted probe.
  - D5 puts the format commands in the handoff's "Loading" bullet; they are in the README now.
  - D7 cites a step that was removed.
  - It is refreshed when this change is committed with a `MODULE: docs` Decision and distilled.

## Open questions

- Should `docs/` ship inside the installed plugin?
- Should the verification log carry a date per entry?

## To verify

- **Host behavior** recorded only from probe mods or tmux runs:
  - `/clear` semantics;
  - `ui.close` re-entry (the host types say every close raises `ui.close`);
  - `isFocused` reaching the render on each focus change;
  - a height-only change not redrawing;
  - `return()` possibly never settling a stream's `result`;
  - the exact blit deny strings;
  - `$.process` being unavailable in the desktop Code tab;
  - the workspace-trust log line for an installed plugin.
- **Measurements and environment facts** that no source can confirm:
  - the timings: feed about 10 s, like 6–7 s, download 4–5 s versus 14 s, the `-ss` restart, ime
    about 70 ms;
  - the counts: about 18 home-shelf Shorts, 10–19 per batch, 41 Shorts with no ads;
  - the tool versions, the Safari TCC trace, and Homebrew tap-trust behavior.
- **History after the commit.** Whether `git log --follow -- docs/research.md` reaches the handoff's
  history once the rename is committed.
