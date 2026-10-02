# cc-shorts

Play YouTube Shorts in your Claude Code 💃

`/shorts` opens a pane beside the conversation and plays your own Shorts feed in it, sound included, while Claude keeps working.

> **Early.** Built and tested on Claude Code 2.1.287. The plugin API it uses (hooks modules) is early access and changes between releases, so another version may not load it.

## Requirements

- **macOS.** Sound goes out through ffmpeg's AudioToolbox device, and the pane switches the macOS input source.
- **Claude Code in a terminal.** The pane plays only there, not in the desktop app or an IDE. Terminals with the kitty graphics protocol (Ghostty, kitty) show real pixels; the rest (iTerm2, tmux, …) get half-block characters.
- **yt-dlp**, installed with Homebrew, pipx or pip.
- **ffmpeg** with the `audiotoolbox` output device. Homebrew's ffmpeg has it.
- **deno**, recommended: yt-dlp solves YouTube's JavaScript challenges with it, and may miss formats without it.
- **A browser signed in to YouTube**: Chrome, Safari, Edge, Firefox, Brave, Opera, Vivaldi, Chromium or Whale. The feed comes through its cookies; signed out, YouTube serves no Shorts feed. Arc is not supported.

The first `/shorts` checks for the tools and offers to install what is missing (see [First run](#first-run)), so the quickest start is Homebrew alone:

```sh
brew install yt-dlp ffmpeg   # Homebrew's yt-dlp brings deno along
```

## Install

From Claude Code:

```
/plugin marketplace add mthli/cc-shorts
/plugin install cc-shorts@cc-shorts
```

Then start a new session. Claude Code loads the plugin once you trust the folder the session runs in.

Or run it from a clone:

```sh
git clone https://github.com/mthli/cc-shorts.git
claude --plugin-dir /path/to/cc-shorts
```

## First run

1. **The setup check.** Every session checks, in the background, for yt-dlp, ffmpeg and deno, and toasts what is missing. While yt-dlp or ffmpeg is missing, `/shorts` asks whether Claude should install them (with `brew install …`) instead of opening the pane. Claude's commands go through your permission settings like any others. It is told to leave Homebrew's "taps are not trusted" warning alone (no `brew trust`, no `brew untap`), and to stop and tell you whenever something needs `sudo` or your password.
2. **The browser.** The first `/shorts` asks which browser you are signed in to YouTube with, offering the ones used on this Mac. Run `/shorts browser` to change it later.
3. **Access to the cookies.**
   - Chrome, Edge, Brave and the other Chromium browsers: macOS asks to let the `security` tool, which yt-dlp runs, read the browser's "Safe Storage" key from the Keychain. **Allow** answers once, and the question comes back on every feed, like and watch-history report. **Always Allow** ends the questions, but from then on any program that runs `security` can read that key without asking.
   - Firefox needs no grant.
   - Safari keeps its cookies where only an app with **Full Disk Access** can read them (System Settings › Privacy & Security), and the grant goes to your terminal app, for everything it runs. Files & Folders does not cover them. If that is too broad, pick another browser.

## Keys

While the pane has the keyboard (the pane switches to an English layout meanwhile, so an input method cannot swallow the keys):

| Key | Does                                     |
| --- | ---------------------------------------- |
| `j` | Next Short                               |
| `k` | Previous Short, from the start           |
| `p` | Pause / play                             |
| `r` | Replay from the start                    |
| `l` | Like / unlike, on your account           |
| `m` | Mute / unmute                            |
| `o` | Pause and open the Short in your browser |
| `x` | Close the pane                           |

The author's name under the video opens the Short too. Closing the pane keeps your place for the rest of the session: the next `/shorts` resumes the same Short.

## What it does with your account

- **It reads your feed** through YouTube's internal web API (the Shorts sequence the website scrolls), with your browser's cookies. That API is unofficial and may break whenever YouTube changes it.
- **It writes to your account.** A Short you watch for 10 seconds (or half of a shorter one) goes into your watch history, as on the website. `l` likes and unlikes.
- **It goes against YouTube's Terms of Service**, as any automated client signed in with your session does, and that carries some risk to the account. Requests stay close to a person scrolling: about 15 Shorts per batch, the next batch only when 5 are left.
- **Your cookies stay on your Mac.** yt-dlp reads them locally and sends them only to YouTube. Shorts download at most 480 pixels wide to a temporary folder (`$TMPDIR/cc-shorts/`), five ahead of the one playing, and are deleted when the pane closes or the session ends.

## When something goes wrong

The pane says what failed:

- **"Could not get the feed (signed out: no YouTube login in …)"**: sign in to YouTube in that browser, or switch with `/shorts browser`.
- **"Could not get the feed (cannot read …'s cookies: …)"**: the browser has no cookies here, (Safari) the terminal lacks Full Disk Access, or (Chrome and the other Chromium browsers) the Keychain prompt was denied or went unanswered; press `j` and answer it with **Allow**.
- **"Downloads keep failing"**: check the network, then press `j`.
- **A tool reported missing although it is installed**: cc-shorts runs tools from Claude Code's own `PATH`, so a tool outside it counts as missing.

YouTube changes often, and yt-dlp follows with releases: `brew upgrade yt-dlp` (or `pipx upgrade yt-dlp`) fixes most breakage. cc-shorts also uses some of yt-dlp's internals, so now and then a new yt-dlp needs a cc-shorts update instead.

## Development

```sh
claude plugin test .                              # tests
claude plugin validate .claude-plugin/plugin.json # the plugin and its hooks module
claude plugin validate .                          # the marketplace: with marketplace.json here, `.` checks only that
bunx -p typescript tsc -p . --noEmit              # types; .claude-plugin/types/ appears once Claude Code has loaded the plugin
bunx prettier@3 --write hooks tests types         # format TypeScript (.prettierrc.json)
uvx ruff format helper                            # format Python (ruff.toml)
```

`claude --plugin-dir .` reloads the plugin on every save. [`docs/research.md`](docs/research.md) has the product decisions, the research behind them and what is verified so far; how the code works is in `.claude/maps/`.

## License

```
MIT License

Copyright (c) 2026 Matthew Lee
```
