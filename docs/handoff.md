# cc-shorts 交接文档

> 2026-10-02 写成调研和方案；同日按方案实现了 v1（commit `0d47b6d`），本文档已更新到和代码一致。下一步是继续优化，待办见文末“待验证与待优化”。

## 目标

做一个 Claude Code mod：在终端侧边的 Pane 里播放 **YouTube Shorts 推荐流**（个性化、可以一直往下刷、有声音）。对用户来说，推荐流是这个 mod 最核心的部分，只放一个固定列表不算完成。

## 已确定的决策

| 项目 | 决定 |
|---|---|
| 内容来源 | 用户自己账号的 YouTube Shorts 推荐流（登录态取自 Chrome cookie） |
| 放完一条 | **自动播下一条** |
| 点赞 / 不感兴趣 | **v1 不做** |
| 打开方式 | **只能用 `/shorts` 手动打开**，不在 session 开始时自动打开 |
| 终端 | 主要用 Ghostty（真像素），**iTerm2 也要支持**（字符块降级） |
| 声音 | 要 |
| Instagram Reels | 不做（理由见“已否决的方案”） |
| 插件目录 | **仓库根目录就是插件目录**，开发时用 `claude --plugin-dir ~/GitHub/cc-shorts` 加载 |
| 协作方式 | 用户希望先看方案、同意后再写代码；沟通用简体中文 |

## 调研结论一：Claude Code mod API

环境：Claude Code 2.1.287，mod API 处于 EARLY ACCESS，可能变动。详细的类型定义在加载 `plugin-authoring` skill 时会生成；用 `--plugin-dir` 加载过一次之后，引擎还会把类型放到 `.claude-plugin/types/`（自带 `.gitignore`），并在仓库根目录生成 `tsconfig.json` 继承它。**改 mod 前先加载这个 skill**，再按名字去查具体签名。

和本项目相关的能力和限制：

- **Pane**：调用 `$.ui.open({ id, title })` 打开，由 `ui.render` hook 匹配 `{ component: 'Pane', requestId: id }` 来画。用户主动打开（slash command 或按钮）时任何宽度都能显示；程序自动打开时终端要 ≥144 列才显示。`/shorts` 属于用户主动打开。可用的大小从 `e.props.bodyColumns` 和 `e.props.scroll.bodyRows` 读；只改变高度不会触发重画。
- **`Image` 元素**（只在终端）：kitty 和 Ghostty 显示真像素，**其他终端（包括 iTerm2、tmux 里）只显示 `alt` 文字**。给它设 `key` 之后，可以用 `$.ui.blit({ requestId, key, source })` 换帧，不用整个重画；每秒最多接受 120 次，实际约 60 帧上屏。
  - `ImageSource` 可以是 `{ png }`（base64，最大 2 MiB）、`{ rgba, width, height }`、`{ file, format: 'png' | 'rgb' | 'rgba', width, height, generation? }`，或 `{ shm, ... }`（macOS 上名字不超过 30 字符）。
  - 用 `file` 或 `shm` 时，**终端自己去读文件**，像素数据不经过 `$`，开销最小。`file` 要用绝对路径；同一路径内容变了，要换一个 `generation`，否则终端认为没变、不会重读。
  - 在不支持图片的终端里，`blit` 会返回 `{ deny }`。实测原文是 `the Image draws its alt here: the terminal draws no placeholder images (env: inside tmux or screen)`。**靠匹配其中的 `alt` 在运行时判断要不要降级到 Raster。** 刚打开、还没画出来时也会被拒（`no Raster of its own is mounted …`），这种不算降级，下一帧再试。
- **`Raster` 元素**（只在终端）：一个固定大小的字符网格。`cells` 是 base64 编码的 little-endian u32 三元组 `[codePoint, fg 0x00RRGGBB, bg]`，一个格子一组。同屏最多 1024 种颜色组合，超出的取最接近的颜色。也用 `$.ui.blit` 刷新，但 `columns × rows` 必须和已经画出来的一致，否则被拒。在 iTerm2 里用 `▀`（上半块）画，每个格子表示上下 2 个像素。
- **`$` 不能存进模块变量**：`claude plugin validate` 会报 “$ itself is assigned”，模块根本加载不了。可以把 `$` 当参数传给自己的函数，也可以在闭包里用（按钮的 `onPress`、定时器回调都可以），所以代码里每个辅助函数都显式带一个 `$` 参数。
- **`$.process.run(argv, { stdin, timeoutMs })`**：跑一次、等它结束才返回；stdout 和 stderr 各最多 4 MiB 文本；默认超时 30 秒，最长 10 分钟。
- **`$.process.spawn`**：可以流式读输出，但只能读 **UTF-8 文本**，**不能用来传二进制帧**（用来读 ffmpeg 的 `-progress` 文本正合适）。子进程的生命周期跟读输出的循环绑定：循环结束、对 stream 调 `return()`、`next.signal` 中止、或 mod 卸载，都会杀掉子进程。**被主动 `return()` 掉的 stream，它的 `result` 不一定会 settle**，所以代码里停掉的播放器不去等 `result`。
- **`$.fs.read`**：单次最多 4 MiB，用 `{ as: 'bytes' }` 读出 `{ base64 }`。`$.fs.write` 只能写文本。**`$.fs` 没有删除和建目录**：删文件、建目录都用 `$.process.run(['rm' | 'mkdir' | 'find', …])`。
- **`$.plugin.root`**：插件目录的绝对路径，用来定位 `helper/yt.py`。
- **`$.audio.play`**：参数可以是 `{ asset }`、`{ url }` 或 `{ base64, mime }`；macOS 上用 `afplay` 播放，**不能跳到指定位置播**；`shouldLoop` 加 `signal` 可以循环播放或中途停止。v1 没用它，声音由 ffmpeg 直接输出。
- **`$.clock.every / after / sleep`**：定时器。mod 热重载时，所有定时器都会被取消。
- **`$.store`** 跨 session 保存数据；**`$.state`** 只在当前 session 内有效、**热重载后还在**，要在 `types/index.d.ts` 里声明类型。模块自己的变量在热重载后会清空。
- **`ui.close`**：用户手动关闭（ctrl+x x、Pane 的关闭标记）会触发插件的 `ui.close` hook；**插件自己调用 `$.ui.close` 不会触发自己的 hook**（日志里写 `skipped: re-entry`），所以自己关闭前要先自己清理。
- **Button 的 `hotkey`** 只能是一个数字或一个小写字母，而且只在 Pane 有焦点时生效（`ctrl+x tab` 或鼠标点一下；`$.ui.open` 时传 `focus: true` 可以一打开就拿到焦点）。
- **只能在 CLI 终端版用**：`$.process`、`Image`、`Raster` 在桌面版的 Code 标签页里都不可用。
- **类型**：TypeScript 的 es2023 标准库里没有 `Uint8Array.prototype.toBase64` 和 `Uint8Array.fromBase64` 的声明，但运行环境里有，所以在 `hooks/globals.d.ts` 里补了声明。
- **加载方式**：开发时用 `claude --plugin-dir <插件目录>`；想每个 session 都加载，就在 `~/.claude/settings.json` 的 `env` 里设 `CLAUDE_CODE_PLUGIN_DIRS`。交互式 session 会监听这个目录，改了文件会自动热重载（热重载时 `register` 和 `session.start` 都会重新跑）。插件结构是 `.claude-plugin/plugin.json` + `hooks/hooks.json` + `hooks/register.tsx`。检查用 `claude plugin validate .`、`claude plugin test .` 和 `bunx -p typescript@5 tsc -p .`。测试环境里没有 fs、process 和网络，只能测纯函数和界面。

## 调研结论二：推荐流（2026-10-02 实测，yt-dlp 2026.08.19）

| 来源 | 结果 |
|---|---|
| `yt-dlp ":ytrec"`（首页推荐） | 150 条里 **0 条 Shorts**：yt-dlp 把 Shorts 栏丢掉了 |
| 首页原始的 `ytInitialData` | 有一个 Shorts 栏（`shortsLockupViewModel`），**第一页约 18 条**个性化 Shorts，后面几页没有 |
| `https://www.youtube.com/feed/subscriptions/shorts` | 可用，全是 Shorts，当兜底。**要用一个全新的 `YoutubeDL` 实例加 `extract_flat`**；用请求过首页的那个实例会返回 401 |
| **`reel/reel_watch_sequence`（非官方接口）** | ✅ **能无限刷**：每批 10–19 条，全是新的，每批都带下一批的入口；全是 9:16 竖屏，内容和账号首页的兴趣一致 |
| `instagram:user` | yt-dlp 自己标记为 CURRENTLY BROKEN |

**无限刷的调用流程**（完整可运行的探测脚本见 [`probe_reel.py`](./probe_reel.py)，正式实现在 [`helper/yt.py`](../helper/yt.py) 的 `Feed`）：

1. 带 cookie 请求 `https://www.youtube.com/` → 用 `extract_ytcfg` 和 `extract_yt_initial_data` 拿到页面配置和初始数据 → 在里面递归找 `reelWatchEndpoint`，作为起点。起点里有 `videoId`、`playerParams`、`params`、`sequenceParams`，以及 `sequenceProvider: REEL_WATCH_SEQUENCE_PROVIDER_RPC`。
2. `POST reel/reel_item_watch`，body 是 `{ playerRequest: { videoId, params: playerParams }, params, disablePlayerResponse: true }`，从响应里找 `sequenceContinuation`。
3. `POST reel/reel_watch_sequence`，body 是 `{ sequenceParams }`。响应里 `entries[].command.reelWatchEndpoint.videoId` 就是这一批视频；`continuationEndpoint` 里的 `token` 作为下一批的 `sequenceParams`，循环调用即可。
4. 登录签名和请求头直接复用 yt-dlp：`ie._call_api(ep, body, id, context=ytcfg['INNERTUBE_CONTEXT'], headers=ie.generate_api_headers(ytcfg=ytcfg))`，其中 `ie = YoutubeDL({'cookiesfrombrowser': ('chrome',)}).get_info_extractor('YoutubeTab')`。注意它用的是 **pipx 安装的 yt-dlp 自带的 Python**：`~/.local/pipx/venvs/yt-dlp/bin/python`，系统的 `python3` 里没装 `yt_dlp`。

**没有广告**：重新抽查 3 批共 41 条，全是带 `videoId` 的 `reelWatchEndpoint`，没有广告或其他条目。代码里仍然只收带 `videoId` 的条目。一次 `feed` 调用约 10 秒（大部分是读 cookie 和请求首页）。

**偶尔变成未登录的根因（重要）**：yt-dlp 读 Chrome cookie 时，会在 Chrome 目录下用 `os.walk` 递归找**最近修改过的 `Cookies` 文件**；就算指定了 profile，也照样会搜进子目录。Chrome 里有个扩展在 `Default/Storage/ext/glic/…/Cookies` 有自己的一份 cookie 数据库，里面只有 google 的 cookie。哪个文件刚被写过，yt-dlp 就读哪个，所以请求时有时是登录状态、有时不是。`helper/yt.py` 在 import 时把 `yt_dlp.cookies._find_files` 包了一层，跳过路径里带 `/Storage/` 的文件。**下载和回传观看记录也必须走这个打过补丁的 Python**，不能直接调用 yt-dlp 命令行。

**续推返回的元数据**：

- 每批只有 1–3 条带 `unserializedPrefetchData.playerResponse`（里面有 `videoDetails.title`、`author`、`lengthSeconds`，以及 `streamingData`）。
- 其余条目只有 `videoId`，`overlay` 里没有标题。
- **标题、作者、时长统一在下载时从 yt-dlp 的元数据里取**，下载本来就要解析这些信息。也可以用公开的 oEmbed（`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/<id>`），实测可用，不需要 cookie。

## 调研结论三：下载与解码（实测）

- **下载先不带 cookie**：不带 cookie 一条约 4–5 秒；带 cookie 约 14 秒，其中读 cookie 约 4 秒，另外登录状态下 yt-dlp 会多请求几种客户端接口（web creator、tv 等）。所以先不带 cookie 下载，失败了（年龄限制、机器人校验等）再带 cookie 重试。
- **挑格式要按宽度筛**：竖屏视频的 `height` 是长边，用 `height<=480` 会错拿成 240x426。用的是 `bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]/b`。
- **不能预先把整条视频转成 PNG**：50 秒、24fps、360x640 转完是 1211 张图、312 MB，耗 62 秒 CPU。
- **一个 ffmpeg 进程能同时出画面和声音**：`-re` 按真实速度解码；画面用 `-f image2 -update 1 -atomic_writing 1 frame.rgb` 每帧覆盖同一个文件（先写临时文件再改名，读的一方不会读到写了一半的帧）；声音用 `-f audiotoolbox -` 直接从 macOS 扬声器出。4 秒的片段用 4.18 秒，节奏没被声音输出拖慢。
- **用 `-ss` 跳到中间重启很快**：0.2 秒就出第一帧，所以暂停后靠重启 ffmpeg 来继续是可行的。
- **iTerm2 降级的调色板**：每帧用 `palettegen=max_colors=32:stats_mode=single` 加 `paletteuse=new=1:dither=none` 压到 32 色，这样同屏颜色组合最多 32×32=1024 种，正好在 Raster 的上限内。48x96 的小帧比实时快十几倍，单帧实测只有 349 种组合。
- 转成 48x84 的原始 rgb（给 Raster 用）只要 0.27 秒；抽音轨（`-c:a copy`）只要 0.03 秒。
- 本机已经装了 `ffmpeg`（9.0.2，带 `audiotoolbox`）、`ffprobe`、`yt-dlp`（pipx），以及 `deno`、`node`、`bun`（yt-dlp 解 YouTube 的 JS 校验时会用 deno）。

## v1 实现现状

```
/shorts ──► Pane（focus，请求 50 列 × 40 行）
              │  ui.render: Image（Ghostty）或 Raster（iTerm2）+ 作者 / 标题 / 进度 + 五个按钮
              ▼
  helper/yt.py feed ──► 视频 ID 队列 ──► helper/yt.py download（预下载后面 2 条）──► ffmpeg -re
     ▲  token 和看过的 ID 存在 $.store                                │ 画面：frame-N.rgb（原子覆盖）
     └──────────────── 剩 ≤5 条时补货 ◄──────────────────────────────┘ 声音：audiotoolbox
                                                                       进度：-progress pipe:1 → $.process.spawn
```

文件分工：

- `helper/yt.py`：Python，三个子命令，每个都在 stdout 打印一行 JSON。mod 通过 `$.process.run([pipx 的 python, '-B', yt.py, …])` 调用（`-B` 避免在仓库里生成 `__pycache__`）。
  - `feed`：stdin 传 `{ token, seen, want }`，返回 `{ ids, token, source, loggedIn }`。先用 token 续推；token 失效就从首页起点重新开始；都拿不到就退回订阅频道的 Shorts（这时 token 返回 null）。一次最多拉 3 批。
  - `download ID DIR`：返回 `{ id, title, author, duration, width, height, hasAudio, path }`。
  - `watched ID`：用 yt-dlp 的 `mark_watched` 把这一条写进账号的观看记录。
- `hooks/lib.ts`：纯函数，没有 `$`，测试能全覆盖：画面尺寸、ffmpeg 参数、进度解析、帧转字符块、时间格式。
- `hooks/register.tsx`：Pane、队列和预下载、播放、blit 循环、降级、按键、清理。
- `types/index.d.ts`：`$.state` 里 `cc-shorts.shorts` 的类型（队列、当前位置、每条的元数据、播放状态、模式、帧信息、是否已登录）。

具体做法：

1. **推荐流**：队列里当前这条之后剩 ≤5 条时，调一次 `feed` 补货（同一时间只跑一个）。请求里的 `seen` 是 `$.store` 里看过的 ID（最多保留 1000 个）加上当前队列，避免重复。新的 token 存回 `$.store`。一条视频开始播放时才记为“看过”。
2. **预下载**：当前这条和后面 2 条保持已下载；下载一个接一个排队跑，失败的允许以后再试。比上一条更早的视频文件会被删掉（留一条给 `k` 回看）。下载目录是 `$TMPDIR/cc-shorts/<session id>/`。连续 3 条下载失败就停下来，提示检查网络后按 `j` 重试。
3. **播放**：每条一个 `ffmpeg -re`，参数见 `ffmpegArgs`。
   - 画面写到 `frame-N.rgb`（N 每启动一次 ffmpeg 加 1），每帧原子覆盖；新的一条开始时，用 `find` 删掉目录里其他所有帧文件。不在停止时删，是因为暂停期间画面还要显示最后那一帧，而且正在被杀掉的旧 ffmpeg 可能在删除之后又写进一帧。
   - 进度用 `-progress pipe:1 -stats_period 0.25` 输出文本，mod 通过 `$.process.spawn` 读 `out_time_us` 算出当前位置；每过一整秒写一次 `$.state`，用来刷新进度显示。
   - mod 用 `$.clock.every(33)` 把当前帧文件 blit 到 Pane 上，同一时间只有一次 blit 在进行。
   - **暂停**：停掉 ffmpeg，记下位置；**继续**：用 `-ss <位置>` 重新启动。**静音**和 **Pane 大小变化**也是在当前位置重启 ffmpeg。没有音轨的视频直接不输出声音。
   - **放完自动下一条**：读到 `progress=end` 且 ffmpeg 退出码为 0，就切到下一条；其他情况显示错误信息，按 `j` 跳过。
4. **显示**：
   - 画面框按 9:16、假设字符格宽高比 1:2 计算，即每 9 列配 8 行，下面留 4 行放作者、标题、进度和按钮（`videoBox`）。
   - 先用 `Image` 加 `{ file, format: 'rgb', width, height, generation }` 画，帧宽约为列数 × 10 像素，最大 480（`frameSize`）。
   - `blit` 因为“draws its alt”被拒，就把 `mode: 'raster'` 记进 `$.state`（这个 session 里不再尝试 Image），在当前位置重启 ffmpeg。Raster 模式下 ffmpeg 输出 `列数 × (行数 × 2)` 的 32 色小帧，mod 用 `$.fs.read` 读出来，转成 `▀` 字符块再 blit。
   - 重画时沿用上一次 blit 成功的 source 或 cells，避免画面闪成空白。
5. **交互**：Pane 有焦点时，`j` 下一条、`k` 上一条（从头播）、`p` 暂停 / 继续、`m` 静音、`x` 关闭。视频下方显示作者、标题，以及“▶ 0:12 / 0:28 · 静音”这样的状态行；最后一次 `feed` 是未登录时会提示“未登录，推荐不是你的”。
6. **回传观看记录**：一条播放到 `min(10 秒, 时长的一半)` 时，调一次 `yt.py watched`，每条只回传一次（记录在模块变量里，热重载后可能重复回传一次，无害）。预下载不会回传。
7. **清理**：
   - 按 `x`：先自己清理再关 Pane（插件自己调用 `$.ui.close` 不会触发自己的 `ui.close` hook）。
   - 用户手动关闭：`ui.close` hook 清理。
   - 清理指：停掉 ffmpeg 和定时器，把状态设回 idle，删除整个 session 临时目录。队列、当前位置和静音设置保留，再次 `/shorts` 会从当前这条、关闭时的位置接着播。
   - 热重载：旧模块的 ffmpeg 和定时器由引擎自动停掉。`session.start` 里如果 Pane 还开着且原来在播放，就从记下的位置接着播；如果正处于暂停且是 Raster 模式，就从暂停那一帧的文件重新算出字符块再重画（屏幕上的字符块存在模块变量里，重载后就没了）；如果 Pane 已经关了，就清理。
   - session 结束：停掉 ffmpeg，删除临时目录。
   - 每次 `session.start` 还会删掉 `$TMPDIR/cc-shorts/` 下超过一天没动过的目录（之前 session 崩溃留下的）。

## 验证情况

已经验证（2026-10-02）：

- 15 个测试（纯函数 + 界面）、`claude plugin validate`、`tsc` 都通过。
- **端到端**：在 tmux 里开一个带 `--plugin-dir` 的 Claude Code 跑了完整流程。tmux 不支持图片协议，正好覆盖了“Image 被拒 → 降级成 Raster”：画面是真实彩色帧，进度在走，放完自动切下一条。`j`/`k`/`p`/`m`/`x` 都按过；暂停后继续能接上原来的位置；播放期间帧文件始终只有 1 个，mp4 保持 3～4 个；看满 10 秒后调用了 `watched`；按 `x`、热重载后都确认 ffmpeg 被杀、临时目录被删。用 `tmux capture-pane -p`（加 `-e` 可看颜色）读画面，用 `--debug-file` 看插件日志。
- 用户试用后反馈“效果不错”，但没有逐项记录在哪个终端试的、具体看了哪些点。

原计划“实现时先验证的点”的状态：

1. **一个 ffmpeg 同时输出画面和 `audiotoolbox`**：能跑，节奏正常，`-ss` 重启 0.2 秒。**音画是否同步还没有人专门确认过。**
2. **Ghostty 用 `blit` 读 `{ file, format: 'rgb' }` 能不能稳定到大约 30fps、CPU 占用多少**：**未验证。** iTerm2 下 blit 被拒并触发降级，在 tmux 里验证过，拒绝原因原文见调研结论一。
3. **续推 token 能存多久**：**未验证**，要隔天打开才知道。token 失效时会自动从首页重新开始，不影响使用。
4. **续推结果里有没有广告**：41 条里没有。
5. **iTerm2 的 Raster 效果**：画面能正常显示；画质和帧率是否满意，需要用户在 iTerm2 本身里确认（tmux 会把颜色压成 256 色）。

## 待验证与待优化

- 上面没验证的三项：音画同步、Ghostty 帧率和 CPU、token 隔天还能不能用。
- 暂停、静音、Pane 大小变化都要重启 ffmpeg，有约 0.2 秒的停顿。
- Image 模式下，终端每帧都要重读一次整个帧文件（Ghostty 下约 400x712，每帧 850 KB）。
- 每次 `feed` 约 10 秒、每次带 cookie 的调用都要重新读 cookie：每次都是一个新的 Python 进程。
- Python 路径写死成 pipx 的 `~/.local/pipx/venvs/yt-dlp/bin/python`；`ffmpeg` 依赖 Claude Code 进程的 PATH。

## 风险

- `reel/reel_watch_sequence` 是**非官方接口**，YouTube 一改就会失效。用登录态自动请求违反 YouTube 服务条款，有一定账号风险。请求频率应该接近人正常刷视频的速度（一批约 15 条，快用完才去拉下一批，一次最多 3 批）。
- `helper/yt.py` 包了 yt-dlp 的**私有函数** `yt_dlp.cookies._find_files`，还用了 `_call_api`、`_download_webpage` 等内部方法；升级 yt-dlp 后可能要跟着改。
- mod API 处于 EARLY ACCESS，升级 Claude Code 后可能要跟着改。
- 读 Chrome cookie 时，macOS 可能会弹钥匙串授权框。

## 已否决的方案

- **只用 `yt-dlp ":ytrec"`**：拿不到 Shorts。
- **完全自己做推荐**（用频道、关键词当候选，根据本地行为打分）：候选内容和推荐质量都远不如 YouTube 自己的算法，不符合用户对推荐流的要求。
- **Instagram Reels**：私有接口风控很严，封号风险高，`instagram:user` 也已经坏了。
- **预先把整条视频转成 PNG**：太占磁盘和 CPU，见调研结论三。
- **用 `$.process.spawn` 传帧**：它只能传 UTF-8 文本。
- **一圈循环覆盖的帧文件**（原方案）：`image2` 的 `-atomic_writing` 已经保证读不到写了一半的帧，一个文件就够了。
- **`$.audio.play` 单独放抽出来的音轨**：同一个 ffmpeg 直接出声更简单，音画天然按同一个时钟走。
- **下载和回传观看记录直接用 yt-dlp 命令行**：会读错 cookie 文件（见调研结论二），而且带 cookie 下载慢。
- **按环境变量（`TERM_PROGRAM`）提前判断终端**：用 blit 被拒的结果判断更准，tmux 里的 Ghostty 也能正确降级。
- **把 `$` 存进模块变量**：validate 不允许，模块加载不了。

## 相关文件

- [`helper/yt.py`](../helper/yt.py)：推荐流、下载、回传观看记录。
- [`hooks/register.tsx`](../hooks/register.tsx)、[`hooks/lib.ts`](../hooks/lib.ts)：mod 本体。
- [`types/index.d.ts`](../types/index.d.ts)：`$.state` 的类型。
- [`tests/`](../tests/)：`claude plugin test .` 跑的测试。
- [`probe_reel.py`](./probe_reel.py)：推荐流的探测脚本，已经跑通。原始响应写到 `$TMPDIR/cc-shorts-probe/`，因为里面带账号数据，**不要放进仓库**。
- [`../.claude/MODULES.md`](../.claude/MODULES.md)：模块清单（feed、player、docs），提交时按模块写 Decision。

## 建议使用的 skills

- **`plugin-authoring`（改 mod 前必须）**：给出这个版本 API 的类型文件和示例，以及 `claude plugin validate`、`claude plugin test`、热重载的用法。
- **`fable-mind`（建议）**：多步骤、有不少未知数的任务开始前加载。
- **`code-review` 或 `review-iterate`（改完之后）**：重点检查清理逻辑（ffmpeg 进程、临时文件）和降级逻辑。
- **`commit-context`（提交时，用户要求才用）**：按 `.claude/MODULES.md` 的模块写 Decision。
