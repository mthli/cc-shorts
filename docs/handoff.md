# cc-shorts 交接文档

> 写于 2026-10-02。到目前为止只做了调研和方案设计，**还没有写任何 mod 代码**。下一步是按本文档实现第一版。

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
| 协作方式 | 用户希望先看方案、同意后再写代码；沟通用简体中文 |

## 调研结论一：Claude Code mod API

环境：Claude Code 2.1.287，mod API 处于 EARLY ACCESS，可能变动。详细的类型定义在加载 `plugin-authoring` skill 时会生成，**实现前必须先加载这个 skill**，再按名字去查具体签名。

和本项目相关的能力和限制：

- **Pane**：调用 `$.ui.open({ id, title })` 打开，由 `ui.render` hook 匹配 `{ component: 'Pane', requestId: id }` 来画。用户主动打开（slash command 或按钮）时任何宽度都能显示；程序自动打开时终端要 ≥144 列才显示。`/shorts` 属于用户主动打开。
- **`Image` 元素**（只在终端）：kitty 和 Ghostty 显示真像素，**其他终端（包括 iTerm2）只显示 `alt` 文字**。给它设 `key` 之后，可以用 `$.ui.blit({ requestId, key, source })` 换帧，不用整个重画；每秒最多接受 120 次，实际约 60 帧上屏。
  - `ImageSource` 可以是 `{ png }`（base64，最大 2 MiB）、`{ rgba, width, height }`、`{ file, format: 'png' | 'rgb' | 'rgba', width, height, generation? }`，或 `{ shm, ... }`（macOS 上名字不超过 30 字符）。
  - 用 `file` 或 `shm` 时，**终端自己去读文件**，像素数据不经过 `$`，开销最小。
  - 在不支持图片的终端里，`blit` 会返回 `{ deny }`，原因里带 “an Image drawing its alt there”。**靠这个在运行时判断要不要降级到 Raster。**
- **`Raster` 元素**（只在终端）：一个固定大小的字符网格。`cells` 是 base64 编码的 little-endian u32 三元组 `[codePoint, fg 0x00RRGGBB, bg]`，一个格子一组。同屏最多 1024 种颜色组合，超出的取最接近的颜色。也用 `$.ui.blit` 刷新。在 iTerm2 里用 `▀`（上半块）画，每个格子表示上下 2 个像素。
- **`$.process.run(argv, { timeoutMs })`**：跑一次、等它结束才返回；stdout 和 stderr 各最多 4 MiB 文本；默认超时 30 秒，最长 10 分钟。
- **`$.process.spawn`**：可以流式读输出，但只能读 **UTF-8 文本**，**不能用来传二进制帧**。子进程的生命周期跟读输出的循环绑定：循环结束、`next.signal` 中止、或 mod 卸载，都会杀掉子进程。
- **`$.fs.read`**：单次最多 4 MiB，用 `{ as: 'bytes' }` 读出 `{ base64 }`。`$.fs.write` 只能写文本。
- **`$.audio.play`**：参数可以是 `{ asset }`、`{ url }` 或 `{ base64, mime }`；macOS 上用 `afplay` 播放，**不能跳到指定位置播**；`shouldLoop` 加 `signal` 可以循环播放或中途停止。
- **`$.clock.every / after`**：定时器。mod 热重载时，所有定时器都会被取消。
- **`$.store`** 跨 session 保存数据；**`$.state`** 只在当前 session 内有效，要在 `types/index.d.ts` 里声明类型。
- **Button 的 `hotkey`** 只能是一个数字或一个小写字母，而且只在 Pane 有焦点时生效（`ctrl+x tab` 或鼠标点一下）。
- **只能在 CLI 终端版用**：`$.process`、`Image`、`Raster` 在桌面版的 Code 标签页里都不可用。
- **加载方式**：开发时可以用 `claude --plugin-dir <插件目录>`；想每个 session 都加载，就在 `~/.claude/settings.json` 的 `env` 里设 `CLAUDE_CODE_PLUGIN_DIRS`。交互式 session 会监听这个目录，改了文件会自动热重载。插件结构是 `.claude-plugin/plugin.json` + `hooks/hooks.json` + `hooks/register.tsx`。检查用 `claude plugin validate` 和 `claude plugin test`。

## 调研结论二：推荐流（2026-10-02 实测，yt-dlp 2026.08.19）

| 来源 | 结果 |
|---|---|
| `yt-dlp ":ytrec"`（首页推荐） | 150 条里 **0 条 Shorts**：yt-dlp 把 Shorts 栏丢掉了 |
| 首页原始的 `ytInitialData` | 有一个 Shorts 栏（`shortsLockupViewModel`），**第一页约 18 条**个性化 Shorts，后面几页没有 |
| `https://www.youtube.com/feed/subscriptions/shorts` | 可用，60 条全是 Shorts。可以当兜底 |
| **`reel/reel_watch_sequence`（非官方接口）** | ✅ **能无限刷**：连拉 3 批，每批 13–17 条，全是新的，每批都带下一批的入口；全是 9:16 竖屏，内容和账号首页的兴趣一致 |
| `instagram:user` | yt-dlp 自己标记为 CURRENTLY BROKEN |

**无限刷的调用流程**（完整可运行的脚本见 [`probe_reel.py`](./probe_reel.py)）：

1. 带 cookie 请求 `https://www.youtube.com/` → 用 `extract_ytcfg` 和 `extract_yt_initial_data` 拿到页面配置和初始数据 → 在里面递归找 `reelWatchEndpoint`，作为起点。起点里有 `videoId`、`playerParams`、`params`、`sequenceParams`，以及 `sequenceProvider: REEL_WATCH_SEQUENCE_PROVIDER_RPC`。
2. `POST reel/reel_item_watch`，body 是 `{ playerRequest: { videoId, params: playerParams }, params, disablePlayerResponse: true }`，从响应里找 `sequenceContinuation`。
3. `POST reel/reel_watch_sequence`，body 是 `{ sequenceParams }`。响应里 `entries[].command.reelWatchEndpoint.videoId` 就是这一批视频；`continuationEndpoint` 里的 `token` 作为下一批的 `sequenceParams`，循环调用即可。
4. 登录签名和请求头直接复用 yt-dlp：`ie._call_api(ep, body, id, context=ytcfg['INNERTUBE_CONTEXT'], headers=ie.generate_api_headers(ytcfg=ytcfg))`，其中 `ie = YoutubeDL({'cookiesfrombrowser': ('chrome',)}).get_info_extractor('YoutubeTab')`。注意它用的是 **pipx 安装的 yt-dlp 自带的 Python**：`~/.local/pipx/venvs/yt-dlp/bin/python`，系统的 `python3` 里没装 `yt_dlp`。

**续推返回的元数据**：

- 每批只有 1–3 条带 `unserializedPrefetchData.playerResponse`（里面有 `videoDetails.title`、`author`、`lengthSeconds`，以及 `streamingData`）。
- 其余条目只有 `videoId`，`overlay` 里没有标题。
- **标题、作者、时长统一在下载时从 yt-dlp 的元数据里取**，下载本来就要解析这些信息。也可以用公开的 oEmbed（`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/<id>`），实测可用，不需要 cookie。

## 调研结论三：下载与解码（实测）

- 下载一条 50 秒的 Short（视频流加音频流，合并成 mp4）**约 5.5 秒**，大部分时间花在读 cookie 和解析页面上。
- **挑格式要按宽度筛**：竖屏视频的 `height` 是长边，用 `height<=480` 会错拿成 240x426。应该用类似 `bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]` 的写法。
- **不能预先把整条视频转成 PNG**：50 秒、24fps、360x640 转完是 1211 张图、312 MB，耗 62 秒 CPU。
- 转成 48x84 的原始 rgb（给 Raster 用）只要 0.27 秒；抽音轨（`-c:a copy`）只要 0.03 秒。
- 本机的 ffmpeg **支持 `audiotoolbox` 音频输出设备**（直接从 macOS 扬声器出声），所以一个 ffmpeg 进程可以同时出画面和声音。
- 本机已经装了 `ffmpeg`、`ffprobe`、`yt-dlp`（pipx），以及 `deno`、`node`、`bun`（yt-dlp 解 YouTube 的 JS 校验时会用到）。

## v1 设计方案

```
/shorts ──► Pane
              │  ui.render: Image（Ghostty）或 Raster（iTerm2）+ 作者 / 标题 + 按钮
              ▼
  feed helper（Python + yt-dlp）──► 视频 ID 队列 ──► 预下载后面 2 条 ──► player（ffmpeg -re）
     ▲  续推 token 和看过的 ID 存在 $.store                          │ 画面：一圈循环覆盖的原始 rgb 帧文件
     └──────────────────── 队列快用完时补货 ◄────────────────────────┘ 声音：audiotoolbox
```

1. **feed helper**：放在仓库里的一个 Python 脚本，由 mod 通过 `$.process.run` 调用 pipx 的 Python 执行。负责从首页取起点和续推，输出 JSON。
   - 续推 token 和看过的视频 ID 由 mod 保存在 `$.store`，调用时作为参数传进去。
   - token 失效，或者用户想换一批时，就重新从首页取起点。
   - 过滤掉看过的。如果续推接口不可用，就退回订阅频道的 Shorts。
2. **预加载**：队列里始终保持后面 2 条已经下载好（用上面那条按宽度筛的格式），下载结果放在系统临时目录下 `cc-shorts/` 里。
3. **player**：一个 `ffmpeg -re` 进程，按真实速度解码：
   - 画面按 Pane 的大小缩放，写成原始 rgb 帧，循环覆盖一小圈文件（大约保留 2 秒的帧）。
   - 声音从 `audiotoolbox` 直接输出。
   - mod 用 `$.clock.every`（约 30 ms 一次），把**最新已经写完的那一帧**（最新帧号减 1，避免读到写了一半的文件）blit 到 Pane 上。画面跟着 ffmpeg 的进度走，所以音画天然同步。
   - **暂停**：停掉 ffmpeg 并记下播到的位置；**继续**：用 `-ss <位置>` 重新启动。
   - **放完自动下一条**：ffmpeg 正常退出就切到下一条。
4. **显示**：
   - 先用 `Image` 加 `{ file, format: 'rgb', width, height }` 画；如果 `blit` 被拒（原因是正在显示 alt），就切到 `Raster` 模式。
   - Raster 模式下，ffmpeg 输出 `列数 × (行数 × 2)` 的小帧，mod 用 `$.fs.read` 读出来，转成 `▀` 字符块。
   - 画面大小根据 render hook 拿到的 `e.viewport` 计算，按 9:16 的比例，并假设一个字符格的宽高比约为 1:2。
5. **交互**：Pane 有焦点时，`j` 下一条、`k` 上一条、`p` 暂停 / 继续、`m` 静音、`x` 关闭。视频下方显示作者和标题。
6. **回传观看记录**：一条**真正看过一段时间之后**，才用 `yt-dlp --mark-watched --simulate <url>` 标记为已观看。不要在下载时直接加 `--mark-watched`，否则预加载的视频也会被算成已看。
7. **清理**：关闭 Pane、mod 重新加载、session 结束时，停掉 ffmpeg 并删除临时帧文件和下载的视频。

## 实现时先验证的点

1. **一个 ffmpeg 进程同时输出 image2 原始帧和 audiotoolbox**：`-re` 下音画会不会错开；暂停后用 `-ss` 重启要多久。如果不行，退回用 `$.audio.play` 单独放抽出来的音轨。
2. **Ghostty 用 `blit` 读 `{ file, format: 'rgb' }` 能不能稳定 24fps**，CPU 占用多少；在 iTerm2 里 `blit` 是否确实会被拒，从而触发降级。
3. **续推 token 能存多久**：今天存的 token 第二天还能不能用；不能的话，每次打开都重新从首页取起点。
4. **续推结果里有没有广告**或其他非视频条目，需要过滤。
5. **iTerm2 的 Raster 效果**：1024 色上限下画质能不能接受，帧率定多少合适。

## 风险

- `reel/reel_watch_sequence` 是**非官方接口**，YouTube 一改就会失效。用登录态自动请求违反 YouTube 服务条款，有一定账号风险。请求频率应该接近人正常刷视频的速度（一批大约 15 条，用完才去拉下一批）。
- mod API 处于 EARLY ACCESS，升级 Claude Code 后可能要跟着改。
- 读 Chrome cookie 时，macOS 可能会弹钥匙串授权框。

## 已否决的方案

- **只用 `yt-dlp ":ytrec"`**：拿不到 Shorts。
- **完全自己做推荐**（用频道、关键词当候选，根据本地行为打分）：候选内容和推荐质量都远不如 YouTube 自己的算法，不符合用户对推荐流的要求。
- **Instagram Reels**：私有接口风控很严，封号风险高，`instagram:user` 也已经坏了。
- **预先把整条视频转成 PNG**：太占磁盘和 CPU，见调研结论三。
- **用 `$.process.spawn` 传帧**：它只能传 UTF-8 文本。

## 相关文件

- [`docs/probe_reel.py`](./probe_reel.py)：推荐流的探测脚本，已经跑通。原始响应写到 `$TMPDIR/cc-shorts-probe/`，因为里面带账号数据，**不要放进仓库**。

## 建议使用的 skills

- **`plugin-authoring`（必须）**：写 mod 之前先加载。它会给出这个版本 API 的类型文件路径和示例，以及 `claude plugin validate`、`claude plugin test`、热重载的用法。还要先决定：mod 是直接以仓库根目录作为插件目录，用 `--plugin-dir` 加载；还是先在 skill 指定的 dev-mods 目录里开发。
- **`fable-mind`（建议）**：这是一个多步骤、有不少未知数的实现任务，开始前加载。
- **`code-review` 或 `review-iterate`（实现后）**：重点检查清理逻辑（ffmpeg 进程、临时文件）和降级逻辑。
- **`commit-context`（提交时，用户要求才用）**：把这份文档里的决策一起写进 commit。
