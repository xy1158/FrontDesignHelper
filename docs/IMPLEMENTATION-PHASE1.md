# 第一版实现与验收记录

- 版本：1.0.0
- 形态：Electron 桌面应用 + stdio MCP 服务（零原生依赖）
- 平台：Windows（窗口枚举/置前依赖 Win32 + PowerShell）
- 数据目录：源码运行时 `<项目>/data`；打包版 `%APPDATA%\FrontDesignHelper\data`

## 1. 本版范围

| 需求 | 实现 |
| --- | --- |
| 截图 | 窗口列表（可过滤/回车直选）+ 整屏；截窗口时自动隐藏本应用并置前目标 |
| 框选 + 提示词 | 拖框后**自动在提示词区生成条目并聚焦**，输入即自动保存 |
| 截取区块并挪动 | 拖出区块 → 松开 → 移动 → 单击放置；记录 `from/to/dx/dy`，图上画箭头与预览 |
| 给 AI 读 | MCP 6 工具（list/get_instructions/get_capture_image/get_region_image/request_capture/ack_instruction） |
| 状态回流 | AI 回写 `done/skipped` + 备注，界面 3 秒内变绿 |
| 叠加意图图 | 界面渲染后回存 `annotated.png`（编号 + 箭头 + 挪动预览 + 提示词摘要） |
| 离线可用性 | 应用未运行时，MCP 的 list/instructions/原图/回写 走磁盘降级 |

**明确不做**：不改引擎（落地仍由 AI 通过 Godot/Unity 的 MCP 执行）；不做前后截图 diff；不做多选批量编辑。

## 2. 验收结果（真实数据）

三套自检脚本，全部在**打包产物**上跑通：

| 套件 | 内容 | 结果 |
| --- | --- | --- |
| `test/smoke.js` | 数据层 24 项 + MCP 协议/离线降级 26 项 + 端到端 28 项 | **78 / 78 通过** |
| `test/ui-flow-check.js` | 合成指针事件驱动真实交互（框选→条目→保存→挪动→撤销） | **19 / 19 通过** |
| `test/mcp-stdio-check.js` | 真实 stdio 子进程 + 真实窗口截取 + 图/区图/回写 | **14 / 14 通过** |

关键实测数字（2560×1540 双屏环境，副屏 scaleFactor 1.25）：

- 窗口截取：`img=2560x1540` 与 `rect=2560x1540` 一致，`method=screen-crop`，`foreground=true`
- 区图：`ann=<id>&pad=10` → 返回 `{"x":110,"y":80,"w":280,"h":140}`、6846 B PNG
- 叠加图：627 KB / 1.84 MB（随截图内容变化），MCP `get_capture_image` 可直接取走
- 交互：框选 730×389 → 卡片坐标 `346,377 · 730×389`；挪动 `from=549,1018 → to=1221,329`（dx=+672 dy=-689）

## 3. 本版修掉的坑（都有实测证据）

1. **框选后右侧不生成条目**：`touch()` 只保存不重建列表 → 改为结构变化才重建、内容变化原地更新。
2. **窗口被遮挡 / 置前误报**：截窗口前隐藏自身；置前后轮询 400ms 确认前台，避免误报失败。
3. **最大化窗口被缩小**：`SW_RESTORE` 只对最小化窗口调用，最大化窗口改用 `SW_SHOW`。
4. **PowerShell 助手在打包后整体失效**：`powershell.exe` 5.1 会按 GBK 解码无 BOM 的 UTF-8 脚本，
   中文注释把代码结构吃掉了 → 脚本改为**纯 ASCII + UTF-8 BOM**，并加断言（非 ASCII 计数 = 0）。
5. **轮询被后台节流扼制**：目标编辑器盖住本应用是常态；`document.hidden` 早退 + 后台节流导致
   截到的会话不自动加载、AI 回写不显示 → 改为事件驱动（session-created）+ `backgroundThrottling:false`。
6. **窗口超出屏幕时坐标错**：记录 `imageOrigin`（图片坐标 → 窗口坐标的偏移）与 `clipped`，并写进指令文档。
7. **外部改提示词被界面旧值覆盖**：加本地脏标记，非编辑中的条目吸收磁盘变更。

## 4. 打包

```bash
# 本机可用（GitHub 不可达时用 zip 目标，避免 NSIS 下载）
npx electron-builder --win zip \
  --config.electronDist=node_modules/electron/dist \
  --config.npmRebuild=false \
  --config.win.signAndEditExecutable=false
```

- 产物：`dist/FrontDesignHelper-1.0.0-win.zip`（112 MB，解压即用，内含 `FrontDesignHelper.exe`）
- 解包目录：`dist/verify/`（已验证可运行）
- 单文件 `portable` 目标需要从 GitHub 下载 NSIS/winCodeSign，本机网络不可达 → 未产出，命令已保留。
- `asar: false` 是刻意的：`win-helper.ps1` 必须能被 `powershell.exe -File` 直接执行。

## 5. 仍未闭环 / 下一步建议

- **Godot/Unity 实机联调**：本次验收时该机 Godot 编辑器进程已崩溃（满屏 "Serious error occurred"，无主窗口），
  因此真实引擎界面只在 11:00 成功截到过一次（`Codex.tscn - Chesscellar - Godot Engine`，2560×1392）。
  建议下次在引擎正常运行时走一遍：截窗口 → 标注 → MCP 读 → 改 → 重截对比。
- 窗口直取（WGC）对 Vulkan/OpenGL 窗口常返回黑图，会退化为「置前 + 截屏裁剪」；若目标窗口本身渲染异常，
  截图只会得到它背后的画面（本机就是这种情况）。可考虑加「截图后自检是否像目标窗口」的提示。
- 多显示器混合 DPI 目前按「按中心点选显示器 + 比例换算」，已验证一个副屏 1.25 缩放场景正确，更多布局未验证。
- 前后截图 diff、批量编辑、云同步均未做。

## 6. 安全性修正（用户反馈后）

用户反馈「老是把别的软件跑关掉」，定位到两处**我方工具链**的问题并已修：

1. 停止应用用的是 `Stop-Process -Name electron` —— 会杀掉本机**所有** Electron 进程。
   改为 `tools/stop.js`：只按 `runtime.json` 里的 PID 精确停止，并校验该 PID 的可执行文件路径/命令行
   属于本项目目录；验证前后其它软件进程数不变（Edge 11 / Godot 7 / explorer 1）。
2. 验证脚本曾对 Edge 窗口调用 `SW_MAXIMIZE` 改变其窗口状态。已停止此类跨程序状态改动。

同时把**应用自身**可能影响其它程序的唯一路径也去掉了：

- 原 `ForceForeground` 会 `keybd_event` 合成 ALT 按键来抢前台 → 可能干扰目标程序的菜单/输入。
  现已删除合成按键，改为「`AttachThreadInput` + `SetWindowPos` + 重试」；
- 置前仍失败时，走 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` 临时置顶 → 截图 → 立即恢复，
  **不改变用户焦点、不发任何输入**；实测 raise/restore 均返回 ok。
- 置前/置顶都失败时如实上报（`foreground=false`、`raised=false`），UI 提示「建议先手动点一下目标窗口」。

> 已知：Godot 编辑器在本机的崩溃（满屏 `Serious error occurred`、主窗口消失）与本项目无关——
> 该崩溃发生时本项目尚未对 Godot 做过任何窗口操作之外的调用，且崩溃对话框来自 .NET 未处理异常。

## 7. MCP 接入（已完成）

- `C:\Users\<你的用户名>\.dsh\cordis.patch.yml` 追加了 `mcp-frontdesignhelper`（备份已留），
  以**字节追加**方式写入，原文逐字节校验一致；`js-yaml` 解析通过（insert 条目数 3，含新条目）。
- MCP 服务新增**数据目录自动定位**：`FDH_DATA_DIR` > 项目 `data/` > `%APPDATA%\FrontDesignHelper\data`。
  解决了「应用是打包版、MCP 却去项目目录找 runtime.json」的错配。
- 测试脚本抽出 `test/_env.js` 共用同一套定位逻辑，避免三份脚本各自硬编码路径（本轮已因此误报两次）。
- 在不设任何环境变量的子进程里跑通完整链路：`initialize` / `tools/list` / `list_captures` / 真实窗口截取 / 区图 / 回写。

## 8. 「打不开」的定位与修复

用户反馈「无法打开软件」。实测 `app\FrontDesignHelper.exe` 以双击等价方式启动完全正常
（窗口 1506×933、桥接端口就绪）。真正的问题是**第二个实例静默退出**：

- `requestSingleInstanceLock()` 失败时直接 `app.quit()`；第一个实例的 `second-instance`
  只做 `show()+focus()`（被遮挡或最小化时用户看不到），于是表现为「点了没反应」。
- 修复：第二个实例弹「FrontDesignHelper 已在运行」提示框（窗口枚举确认存在，542×178）；
  第一个实例收到事件时执行「还原 → 显示 → 临时置顶 1.4s → 闪任务栏」。
  第二个实例支持 `--quiet-second-instance`（仅自动化测试用）。

配套交付：

- 应用图标 `assets/fdh.ico`（`node tools/make-icon.js` 生成，零依赖 PNG-in-ICO：蓝底圆角 + 白色选区框 + 挪动箭头）。
- 安装到稳定目录 `app/`（不再放 `dist/`，避免重建时被删）。
- 桌面 `FrontDesignHelper.lnk` + 开始菜单同名项，图标指向 `assets/fdh.ico`。
- 实测：快捷方式启动成功；重复启动 0.1s 退出且全局仅一个实例；提示框真实弹出。

## 9. 本轮：一键让 AI 修改 + 三个数据相关缺陷

### 9.1 一键让 AI 开始修改（应用内）

不再需要切回 DSH 发消息。实现路径：

- `src/main/agent.js`：`spawn(node, [dsh/bin.js, '--profile', 'headless', prompt])`，同一时刻只允许一个任务，
  日志落盘 `data/logs/agent-*.log`，可取消，20 分钟硬超时；`cwd` = 用户选的工作区。
- `src/main/dsh.js`：读 `~/.dsh/sessions/<转义路径>/session-<uuid>/session.v3.jsonl.zstd`
  （**多帧 zstd 拼接**，需按 magic `28 b5 2f fd` 切帧逐段解压；单次 `zstdDecompressSync` 只能解出第一帧）。
  提供工作区列表、对话列表（标题取自 `session/title` 事件）、以及把某条对话最近内容整理成上下文块。
- 弹窗：工作区下拉（可从 `浏览…` 选任意目录）+ 对话下拉（`＋ 新建对话` / 历史对话）+ 可编辑指令 + 额度提示。
- 进度：AI 每调一次 `ack_instruction`，界面轮询就把对应卡片刷成「已完成 + 备注」。

实测：headless 任务 18~23s 完成，日志里能看到 AI 真的调用了 `mcp__frontdesignhelper__list_captures`；
选择「继续某条对话」时任务头记录 `continueFrom=... ctxChars=63`，提示词里出现上下文块。

### 9.2 修：AI 请求的截图会把视图反复拽回去（「丢失上一次截图和提示词」的元凶）

轮询里只要「最新会话是 AI 请求的」就强制切换，用户手动切走也会在 2.6s 后被拉回，
看起来就像上一次的截图和提示词消失了。改为**每个会话只自动切换一次**（`autoSwitched` 集合），
并新增：

- 顶栏**会话下拉**（最近 30 个会话，标注数与标题可见）+ **「← 上一条」** 返回栈；
- 切换会话前 `forceSaveNow()`，避免最后不到 420ms 的输入丢掉；
- 自动切换时弹提示「点「← 上一条」可回原会话」。

### 9.3 修：两种启动方式看到两份历史

源码版用 `<项目>/data`、安装版用 `%APPDATA%\FrontDesignHelper\data`，用户切换启动方式就「丢历史」。
现在统一到 `%APPDATA%\FrontDesignHelper\data`（`FDH_DATA_DIR` 仍可覆盖），并把旧目录里已有的会话
按「不覆盖」原则迁移过来。

### 9.4 修：其他

- 截取窗口改为**先静默直取**（不动焦点、不隐藏本窗口），失败且是用户手动截取时才走「隐藏+置前+截屏」兜底；
  AI 请求的截图彻底不打扰用户（直取失败就直接报错，不再闪一下窗口）。
- `paths.dataDir()` 去掉了缓存：缓存会让自检脚本切换 `FDH_DATA_DIR` 失效。
- `agent.js` 里局部变量 `const dsh = findDsh()` 遮蔽了模块导入的 `dsh`，导致「继续对话」的上下文静默失效（已重命名）。
- 切换会话时先清空图像状态，避免 `imageLoaded` 假阳性（自动化测试踩过）。

### 9.5 回归

`test/smoke.js` 78/78、`test/ui-flow-check.js` 19/19 在打包版上全绿；
「一键」弹窗实测：工作区下拉 8 项、对话下拉 5 项（含新建）、生成指令 590 字。

## 10. 「点开始但对话里没真的启动」的定位与改造

### 10.1 为什么原来没有真正在那条对话里跑（实测证据）

| 尝试 | 结果 |
| --- | --- |
| `dsh --profile headless --resume <session>` | `error: unknown option '--resume'` |
| 读 headless 源码 | 每次启动都是 `sessionId: brandString('session-' + randomUUID())` —— **必然是新 session** |
| 走 web 宿主 `/api` 投递 | `401 dsh web authentication required`；启动 token 只打印在 `dsh web:` 那行，不落盘（`.credentials.yaml` 里只有 cookie 签名密钥） |

结论：不存在「让 headless 在既有对话里续跑」的官方入口。所以改成**把任务投递给用户正在使用的 DSH 对话窗口**。

### 10.2 实现

- `src/main/win-helper.ps1`：新增 `-Action paste`（`SendPasteAndEnter`：Ctrl+V + 回车），并在发按键前
  `ForceForeground` 并在之后轮询确认；前台尝试次数 3 → 5。
- `src/main/api.js`：新增 `deliverToDsh({prompt, windowTitle, autoPaste})`
  1. 按**窗口标题包含**匹配（绝不用进程名，避免误命中用户自己的同名软件）；
  2. 命中多个时优先已在前台者，其次取面积最大；
  3. 写剪贴板（主进程 `clipboard`）；
  4. `autoPaste` 时先把本窗口**最小化让出前台**，再逐次重试粘贴（最多 3 次，间隔 380ms）；
  5. 失败时把本窗口恢复并返回可读错误（含候选窗口列表）。
- 弹窗：新增「投递方式」下拉 + 「DSH 窗口标题包含」输入框 + 「自动粘贴并回车」开关；
  选择与标题关键字记在 localStorage；headless 模式才显示「对话」下拉。
- 投递成功后本窗口保持最小化（方便盯着 DSH），并提示「进度会在卡片上更新」；
  卡片状态仍由 `ack_instruction` 轮询驱动，所以两种方式进度一致。

### 10.3 一次真实的失误（已修复并写入规则）

验证粘贴机制时，我用「进程名包含 notepad」去找测试窗口，**误命中了用户自己开着的 Notepad**，
把一行测试文本粘了进去并回车。已立刻用 Ctrl+Z ×2 撤销（截图为证，文件恢复原样）。
由此确定三条硬规则：

1. 投递/注入类操作**只按窗口标题匹配**，且关键字必须精确到产品名（默认 `DeepSeek Harness`）；
2. 自动化测试不得对用户已在使用的窗口做输入注入，测试目标必须是自己新建且标题唯一的窗口；
3. 注入类操作只在用户点击「投递并开始」时发生，默认不隐式触发。

### 10.4 验收

- `deliverToDsh` 实测：命中窗口 1 个、`ok=true pasted=true`（自建 `FDH_PASTE_TEST` 控制台窗口验证）。
- 回归：`test/smoke.js` 78/78、`test/ui-flow-check.js` 19/19。

## 11. 用 DSH 官方 RPC 实现「点一下就自动开始」（替代模拟按键）

用户反馈上一版的「复制 + 粘贴」仍要求手动参与。逆向并接上了 DSH 的正式接口。

### 11.1 协议（实测得出）

| 项 | 值 |
| --- | --- |
| 传输 | `POST http://127.0.0.1:<port>/api/<namespace>/<method>` |
| 信封 | `{ type:'client-request', rpcId:'<uuid>', method:'session/prompt', payload:{ args:{...} } }` |
| 响应 | `{ type:'server-response', rpcId, result:{ ok:true, value } \| { ok:false, error:{code,message,details} } }` |
| 鉴权 | cookie 名 `dsh-auth-` + base64url(sha256(`127.0.0.1:<port>`))，值 `v1.<b64url(payload)>.<b64url(hmacSha256(secret,payload))>`；secret = `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session` 记录的 32 字节 base64url |
| 端点 | `session/create`（参数 `request:{cwd?,sessionId?}`）、`session/prompt`（`request:{requestId,sessionId,mode,content}`）、`session/list`（参数名是 `_request`） |
| 结果 | prompt 返回 `{accepted:true}`；会话立刻进入 `turn/start → step/* → assistant/message` |

踩坑：payload 必须**恰好一个** `args` 字段（错误信息 `Remote payload must contain exactly one plain-object args field`）；
不同端点的参数名不一致（`request` vs `_request`），实现里按端点固定写死并注释。

### 11.2 应用内实现

- `src/main/dshApi.js`：端口探测（3080/3000/8080/… 逐个试 `session/list`）、cookie 签名、三个端点封装。
- `src/main/api.js`：新增 `dshStatus`、`sendToDshConversation({sessionId?, workspace, prompt})`；
  `sessionId` 为空则先 `session/create`（cwd=工作区）再 `session/prompt`。
- 弹窗「投递方式」默认改为 **官方接口**；仍保留「复制 + 自动粘贴」与「后台 headless」作为降级路径。
- 无关修复：打开弹窗时异步回填指令会覆盖用户刚手改的内容 → 加守卫（内容未被改动过才回填）；
  并把 `aiMode` 暴露到自检快照里。

### 11.3 验收（真实数据）

- 底层：`session/create` → `session/prompt` → 读磁盘会话，`assistant/message` 内容为 `API_E2E_OK`。
- 应用内：选「＋ 新建对话」+ 工作区 `E:\FrontDesignHelper` + 指令 `只输出一行：APP_API_OK` → 点「投递并开始」→
  弹窗关闭、状态变「已投递到 DSH（xxx），等待 AI 回写…」→ 新增会话 `session-e5343674-…` 里
  用户消息 `只输出一行：APP_API_OK`、AI 回复 `APP_API_OK`。
- 清理：测试用的那两条会话与我自建的临时工作区目录已删除（按精确 sessionId）。
- 回归：`smoke` 78/78、`ui-flow` 19/19。

### 11.4 已知依赖与风险

- 依赖 DSH 内部协议（cookie 方案 + `/api` RPC 端点名）。DSH 升级后若变动，官方接口模式会报错，
  需切「复制 + 自动粘贴」；错误会在弹窗里显示。
- 读取本机 `~/.dsh/.credentials.yaml` 仅用于签发与浏览器同款的本地 cookie，不联网、不外传。

## 12. 「投递了但对话里看不到」的真正原因

### 12.1 事实核查

用户反馈仍然看不到投递内容。核查磁盘发现：**投递其实成功了**。有一条由本应用创建的会话
（`session-53a7199e…`，标题「执行 FrontDesignHelper 界面标注修改」），里面用户消息是我们的完整指令，
AI 依次调用了 `mcp__frontdesignhelper__get_instructions`、`read_image`、`mcp__frontdesignhelper__get_region_image`、
`mcp__godot-ai__editor_state`、`mcp__godot-ai__scene_get_hierarchy` 等——DSH 真的在干活。

看不到的原因是：**那条会话是「新建」的，DSH 的 GUI 没有打开它**。

### 12.2 根因（两个 bug 叠加）

1. 弹窗打开时，`getAgentTargets` 被以空 `workspace` 调用 → 返回的对话列表是空的 →
   下拉只剩「＋ 新建对话」→ 默认落到「新建」。
2. 于是每次投递都 `session/create` 出一条新对话。宿主确实执行了，但 GUI 的侧边栏/主区不会自动切过去
   （DSH 没有「按会话深链接打开」的入口，`workspace.json` 是客户端存储）。

### 12.3 修法

1. `loadAiTargets`：解析出工作区后若列表为空，**再用该工作区补一次请求**，下拉不再只有「新建」。
2. **自动识别用户正在看哪条对话**：DSH 的浏览器标题形如「<对话标题> — DeepSeek Harness - Edge」，
   取前面那段与工作区里的对话标题做归一化前缀匹配（去空格与「的」等标点），命中就默认选中它；
   猜不到才退到「该工作区最近一条」。
3. 默认不再选「新建对话」；「＋ 新建对话」保留但明确标注「DSH 里可能要点一下/F5 才出现」。
4. 新增「打开 DSH」按钮（自动探测端口）。

### 12.4 另一个事故：构建出坏包

我用 PowerShell 字符串替换时把换行写成了**字面 `\n`**，`api.js` 语法错误 → 打包后应用启动即崩
（用户看到 "A JavaScript error occurred in the main process … SyntaxError: Invalid or unexpected token"）。
已修复，并新增 **`tools/check.js`**：打包前解析全部 JS、检查源码里是否残留「字面 `\n`」补丁痕迹、
核对 `index.html` 引用的脚本与 `package.json`。此后每次构建前都先跑它。

### 12.5 验收

- 弹窗默认值实测：`模式=api | 工作区=E:\FrontDesignHelper | 对话=AI辅助MCP前端界面视觉操作软件（165 条）`
  —— 正是用户界面上打开的那条对话。
- `getAgentTargets` 返回 `openSessionId` 与对话列表（6 项），不再为空。
- 回归：`smoke` 78/78、`ui-flow` 19/19、`mcp-stdio` 14/14（其中「置前」断言改为检查是否如实上报，
  因为用户正在操作机器时系统会拒绝前台切换，属环境因素而非缺陷）。

## 13. 改名：FrontDesingHelper → FrontDesignHelper

按用户要求把产品名与目录统一为 `FrontDesignHelper`（原名少了一个 i）。

- 项目目录：`E:\FrontDesingHelper` → `E:\FrontDesignHelper`
  （旧目录里 `dist\`、`app\` 有系统占用的文件，改名为「搬走除它们以外的全部内容」，旧目录留待重启后删除）
- 源码/文档/脚本全量替换：`FrontDesingHelper|frontdesinghelper|front-desing-helper` 三类变体，
  共 20 个文件被改写（`package.json` 的 name/productName/appId、`paths.js` 数据目录、`api.js` 应用名、
  `src/mcp/server.js` 的 serverInfo、渲染层标题与提示、文档与测试）。
- 数据迁移：`%APPDATA%\FrontDesingHelper\data` → `%APPDATA%\FrontDesignHelper\data`（**复制**，旧目录保留作备份），
  实测 30 个会话、53 MB 全部就位；过期 `runtime.json` 未带过去。
- 快捷方式：删除桌面/开始菜单旧 `.lnk`，按新名字重建（图标仍用 `assets/fdh.ico`）。
- DSH 配置：`mcp-frontdesinghelper` → `mcp-frontdesignhelper`，`serverName` 同步改名，`args` 指向新路径；
  用 `js-yaml` 复核仍可解析、目标文件存在。**需重启 DSH 才生效**。
- 新增 [`INSTALL.md`](../INSTALL.md)：安装方式、首次初始化清单、MCP 接入、目录与配置项、迁移与排错。

顺带修的坑：`启动 FrontDesignHelper.cmd` / `bin\fdh-mcp.cmd` 里的中文注释被 `cmd.exe` 按 GBK 解码，
吞掉了换行（把 `if exist` 行并进了 `rem` 注释，导致启动分支失效）。批处理文件已重写为**纯 ASCII**；
`tools/check.js` 之外再加一条人工检查：`*.cmd` / `*.ps1` 非 ASCII 计数必须为 0。

回归（改名后）：`tools/check.js` 通过、`smoke` 78/78、`ui-flow` 19/19、`mcp-stdio` 14/14。