# Docs Decisions

> Snapshot of current consensus. Evolution: `git log --grep="MODULE: docs"`
> Last distilled: 2026-10-03 (HEAD = 9efdc77)
> `docs/handoff.md` was renamed `docs/research.md` in 9efdc77 (D8); entries that say "the handoff" mean that file.

## Active

### D3: The verification record says what each check covered

- **What**: The handoff's Verification section marks each behavior verified or open and says how it was checked (tests, a tmux run, the user's report, or not yet in a running pane), along with the current test count.
- **Why**: The next session needs to know which claims are proven and which checks are still owed.
- **Tradeoffs**: Some observations are annotated rather than re-run, such as the end-to-end mp4 count from the 2-preload days, and the user's live checks are recorded only as reported.
- **Watch out**: Many lines still say not yet tried in a running pane (A/V sync, Ghostty frame rate and CPU, token lifetime, skips and preloads, the e3304ae fixes).
- **Source**: 94b3b48, 22f96cc, ecd14ec, 80beda5, f5d912c, e3304ae, 9efdc77

### D4: English-only documents

- **What**: The handoff was translated in place with its sections, tables, diagram and details intact, and its "Way of working" row records the convention of conversation in Simplified Chinese and code, comments and docs in English.
- **Why**: The user wants an all-English project, and the handoff was the last document in Chinese.
- **Tradeoffs**: The Chinese original remains only in history (94b3b48), with no side-by-side copy.
- **Watch out**: Some nuance may have shifted in translation, and edits drafted from a Chinese conversation can slip back into Chinese.
- **Source**: 3a886b4

### D6: Measured findings are recorded with the versions they came from

- **What**: Findings that took a probe or experiment, such as what /clear does to a mod, the like endpoints, input methods taking the hotkeys, and the setup findings (deno optional, a newer pipx home, no Shorts signed out, Safari needing Full Disk Access, Homebrew 7 tap trust, the marketplace install, the Keychain refusal), go into the handoff's research findings with dates and versions.
- **Why**: Nobody should have to rerun the same probe.
- **Tradeoffs**: The handoff grows longer.
- **Watch out**: The findings are tied to Claude Code 2.1.287, macOS 27.0, Homebrew 7.0.7 and yt-dlp 2026.08.19, and the early-access mod API may change them.
- **Source**: 4226c08, 3a780ee, 22f96cc, bed1bf0, e3304ae

### D7: The docs map triages drift: misleading statements get fixed, cosmetic drift stays recorded

- **What**: `.claude/maps/docs.md` lists handoff statements that no longer match the code, the misleading ones have been corrected in the handoff (the plugin.json validate command, the hooks-based test environment, the shared three-batch budget, step 8 waiting for the setup check), and cosmetic drift stays recorded in the map.
- **Why**: Mapping the docs found statements that would mislead a reader, such as a validate command that skips the hooks-module check and a step that hid an input-source regression.
- **Tradeoffs**: Dated or imprecise statements that do not mislead, such as finding 2's probe recipe, stay in the research record and are listed in the docs map.
- **Watch out**: The remaining drift is listed only in the docs map, so the map needs a refresh when the handoff changes.
- **Source**: 4b54ea8, f5d912c, e3304ae, 9efdc77

### D8: research.md keeps only what the code cannot show

- **What**: `docs/handoff.md` became `docs/research.md`, which keeps the product decisions, dated findings, the verification log, open items, risks and rejected approaches and points to the maps and decisions for the code, while the check and format commands moved to the README and the probe was deleted, leaving a `git show cc938de:docs/probe_reel.py` pointer and its account-data warning.
- **Why**: The maps and decision snapshots now describe the code, so the handoff's walk through the code duplicated them and drifted, and the probe had diverged from `yt.py`.
- **Tradeoffs**: The verification log uses terms only the maps define, the probe can no longer run from the tree, and findings still end in clauses on what the code does, which can drift.
- **Watch out**: Feature commits may keep writing code descriptions into research.md, CLAUDE.md's Knowledge Loop never routes a reader to it, and `origin/master` ships the old handoff and probe until this change lands.
- **Source**: 9efdc77

## Superseded

- ~~Commit the handoff as written, partly stale against v1 (0d47b6d)~~ → replaced by **D1** in 94b3b48 (2026-10-02)
- ~~Open item: the paused Raster frame redraws blank after a hot reload (listed in 94b3b48)~~ → closed in c9353c1 (2026-10-02), under **D1**
- ~~D1: The handoff describes the code as it stands, rewritten with each behavior change~~ → replaced by **D8** in 9efdc77 (2026-10-03)
- ~~D2: Probe output stays out of the repo, with the probe committed~~ → replaced by **D8** in 9efdc77 (2026-10-03)
- ~~D5: Formatter commands in the handoff, and the probe formatted to match~~ → replaced by **D8** in 9efdc77 (2026-10-03)
