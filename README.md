# FrontDesignHelper · 视觉标注工作台

> 给 AI 一双眼睛：把「界面哪里不对、要挪到哪」用**框选 + 提示词 + 区块挪动**画出来，
> 让 AI 通过 MCP 读到精确的文字指令、坐标和图片，再去改 Godot / Unity / 网页的界面。
**第一次安装 / 初始化？先看 [`INSTALL.md`](INSTALL.md)** —— 安装方式、首次初始化清单、MCP 接入、目录与配置项、常见问题。

AI 只靠文字描述改界面时，最常见的翻车就是「UI、图标、物体放错位置」。
这个软件把「位置」变成可测量的数据：截图 → 画框/拖块 → 填提示词 → AI 读指令落地。

---

## 一条完整工作流

```
 ① 打开 Godot / Unity，把要改的界面显示出来
        │
 ② 点「截取窗口」，选中那个窗口 ─────────────► data/sessions/<id>/base.png
        │
 ③ 左侧图片区：用「框选」圈出问题区域，右侧提示词区自动出现一条待填条目
    用「挪动」把某个区块拖到它该在的位置（源位置 + 目标位置 + 位移量都会被记录）
        │
 ④ 每次修改自动保存 ────────────────────────► session.json / instructions.md / annotated.png
        │
 ⑤ AI 通过 MCP 调用 get_instructions / get_capture_image / get_region_image
        │
 ⑥ AI 改完一处就 ack_instruction 回写，界面 3 秒内显示「已完成 + 备注」
```

## 怎么打开（重要）

| 方式 | 说明 |
| --- | --- |
| **桌面「FrontDesign Helper」快捷方式** | 最快；也加进了开始菜单，可搜 FrontDesignHelper 后固定到任务栏 |
| `E:\FrontDesignHelper\app\FrontDesignHelper.exe` | 安装目录里直接双击 |
| `启动 FrontDesignHelper.cmd` | 没有 app/ 时回退到源码方式启动（等价 npm start） |

**只能开一个实例。** 如果软件已经在跑（包括最小化或被别的窗口挡住），再双击会弹提示框
「FrontDesignHelper 已在运行」，并自动把原有窗口切到前台、闪任务栏。
早期版本这里会**静默退出**，表现就是「双击没反应」——这是最常被误认为「打不开」的原因，已修。

安装与分布：

- `app/` —— **已安装**的便携版（289 MB，解压即用，快捷方式指向这里）
- `dist/FrontDesignHelper-1.0.0-win.zip` —— 可分发的压缩包
- `dist/win-unpacked/` —— 构建中间产物，可删

## 5 分钟上手

1. **启动应用**（双击桌面快捷方式；或 app\FrontDesignHelper.exe；或在项目目录跑 npm start）。
2. 把要改的编辑器窗口露出来，点左上角 **「截取窗口」**，在列表里选中它（可按标题/进程过滤）。
   截取时应用会把目标窗口短暂切到前台，完成后自己回到前台。
3. 图片区用 **「框选」**（快捷键 `B`）拖出一个区域 —— 右侧提示词区会**立刻生成一条对应条目**并聚焦输入框，直接写清楚「这里要改成什么样」。
4. 要表达「挪位置」，用 **「挪动」**（`M`）：拖出一个区块 → 松开 → 移动鼠标到目标位置 → 再单击一次。会记录源区域、目标位置和 dx/dy。
5. 让 AI 读取。AI 侧只需要接入一个 stdio MCP 服务（见下节），然后说一句「读一下 FrontDesignHelper 的标注，按提示词把界面改掉」。

## 一键让 AI 开始修改（不用回 DSH 发消息）

提示词区底部有 **「让 AI 开始修改」** 按钮，点开是一个确认弹窗：

| 字段 | 作用 |
| --- | --- |
| **投递方式** | 见下表：默认「在 DSH 当前对话里执行」，也可切「后台任务」。 |
| **DSH 窗口标题包含** | 用来定位要投递的窗口（默认 `DeepSeek Harness`）。**只按标题匹配**，不会碰其它窗口。 |
| **自动粘贴并回车** | 关掉的话只把指令复制到剪贴板，由你自己按 Ctrl+V。 |
| **工作区** | 写进指令里（headless 模式下同时是它的工作目录）。 |
| **对话** | 仅 headless 模式可用：`＋ 新建对话` 或选某条历史对话（会把它最近的内容作为上下文）。 |
| **发给 AI 的指令** | 自动生成、可编辑。已写明：调 `get_instructions` 读标注、坐标约定、用 godot-ai 改界面、每改完一条立刻 `ack_instruction`。 |

三种投递方式：

| 方式 | 行为 | 适用 |
| --- | --- | --- |
| **投递到选中的 DSH 对话并自动开始**（默认） | 走 DSH web 宿主的**官方 RPC**（`session/prompt`）：把指令作为一条用户消息投进选中的对话，DSH 立刻开始这一轮并在界面上显示出来。**不需要切窗口、不需要粘贴** | 绝大多数情况 |
| **备用：粘贴到 DSH 窗口** | 复制到剪贴板 → 本窗口最小化 → 切到标题匹配的 DSH 窗口 → `Ctrl+V` + 回车（需要输入框已聚焦） | 官方接口不可用时（DSH 版本变化、凭证被吊销） |
| **后台任务（headless）** | 起一个 `dsh --profile headless` 子进程，不打开 DSH，日志落 `data/logs/agent-*.log` | 不想被打断、批量跑 |

**默认目标怎么定的**：打开弹窗时会读 DSH 窗口标题里带的对话名，匹配出你**界面上正打开的那条对话**并默认选中它
（猜不到才退到该工作区最近一条）。所以直接点「投递并开始」，消息就会出现在你眼前的对话里。
选「＋ 新建对话」会新建一条——那条对话在 DSH 侧边栏里可能要点一下或按 F5 才出现，所以不是默认。

官方接口是怎么连上的（内置实现，无需你配置）：

1. 自动探测 DSH web 端口（3080/3000/8080/…）；
2. 用本机 `~/.dsh/.credentials.yaml` 里的 `client-connection/browser-session` 密钥，签一个
   `dsh-auth-*` cookie（与浏览器用的是同一套机制）；
3. `POST http://127.0.0.1:<port>/api/session/prompt`，body 为
   `{type:'client-request', rpcId, method:'session/prompt', payload:{args:{request:{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}}}}`。

> 依赖 DSH 的内部协议（cookie 方案 + `/api` RPC）。DSH 升级若改了这些，接口模式会失效并给出错误，
> 此时切到「复制 + 自动粘贴」即可。界面里会显示「DSH 接口已连接（端口 x，N 个对话）」或失败原因。

点「开始」后：

- 后台起一个 **headless DSH 任务**（会消耗 API 额度），日志写在 `%APPDATA%\FrontDesignHelper\data\logs\agent-*.log`
- 左下角实时显示 `AI 修改中… 12s`；每改完一条，对应卡片立刻变「已完成 + AI 备注」
- 运行中再点该按钮 = **停止**；同一时刻只允许一个任务
- 工作区与对话选择会被记住，下次打开弹窗自动带出
## 接入 AI（MCP）

在 MCP 客户端里加入这一段（路径按你的实际位置）：

```json
{
  "mcpServers": {
    "front-design-helper": {
      "command": "node",
      "args": ["E:\\FrontDesignHelper\\src\\mcp\\server.js"]
    }
  }
}
```

用 `npm run mcp:config` 可打印本机已就绪的配置片段。

### 提供的 6 个工具

| 工具 | 作用 |
| --- | --- |
| `list_captures` | 列出截图会话（ID、来源窗口、尺寸、标注数/待处理数），最新在前 |
| `get_instructions` | 读取会话的标注指令：每条的区域或挪动坐标、提示词、状态 + 一段 Markdown + 结构化 JSON |
| `get_capture_image` | 取**叠加意图图**（框选编号、箭头、挪动预览位置都已画上）或原始截图 |
| `get_region_image` | 取某条标注（或任意矩形）的局部图，用来精确看细节 |
| `request_capture` | 让应用立刻按窗口名截一张（用于「我看下现在的界面」），截完界面自动切过去 |
| `ack_instruction` | 回写处理结果 + 一句备注，用户在界面上立刻看到 |

**降级**：应用没启动时，`list_captures` / `get_instructions` / `get_capture_image` / `ack_instruction` 仍可直接读磁盘、
直接回写，并在结果里注明是磁盘只读模式；`request_capture` 与 `get_region_image` 会明确告诉 AI 需要先启动应用。

## 键盘 / 鼠标

| 操作 | 说明 |
| --- | --- |
| `V` / `B` / `M` | 选择 / 框选 / 挪动 |
| 滚轮 | 以光标为中心缩放 |
| 空白处左键拖 / 中键拖 / 空格 + 拖 | 平移画布 |
| `方向键` / `Shift + 方向键` | 微调选中标注 1px / 10px |
| `Delete` | 删除选中标注 |
| `Ctrl + Z` / `Ctrl + Shift + Z` | 撤销 / 重做 |
| `Ctrl + S` | 立即保存 |
| `Ctrl + Enter`（在提示词框内） | 保存，准备让 AI 读取 |
| `F` / `1` | 适应窗口 / 100% |
| `Ctrl + N` | 打开截取窗口对话框 |
| `Esc` | 取消当前操作 / 取消选中 |

## 数据在哪

```
data/
├─ runtime.json            应用运行时的本地桥接端口与 token（关闭即删除）
├─ app.log                 应用日志（异常排查用）
└─ sessions/<会话ID>/
   ├─ base.png             原始截图
   ├─ annotated.png        叠加意图图（由界面渲染后回存，AI 默认取这张）
   ├─ instructions.md      人能直接读的指令文档（坐标 + 提示词 + 状态）
   └─ session.json         结构化数据（标注、状态、来源窗口信息）
```

用 `FDH_DATA_DIR` 环境变量可把数据目录指到别处。**不要把 `data/` 提交到版本库**（里面有你的屏幕内容）。

## 已知限制（先说清楚）

- **仅 Windows**：窗口枚举/置前依赖 Win32 + PowerShell；mac/linux 上只能整屏截取（未适配）。
- **需要目标窗口在屏幕上**：最小化窗口会先被还原；若系统拒绝把窗口切到前台（例如权限或前台锁），
  截图可能包含遮挡，此时界面会明确弹出警告。
- **窗口直取优先、屏幕裁剪兜底**：窗口画面拿不到时会退化为「置前后抓屏再裁剪」。
  多显示器且各屏缩放比例不同时，兜底路径的坐标换算可能不准；窗口直取路径不受影响。
- **叠加图需要界面渲染过**：只有应用打开过该会话才会生成 `annotated.png`；否则 AI 拿到的是原图（工具会说明）。
- 单个会话最多 500 条标注，单条提示词最多 4000 字。
- 它**不改引擎**：改动仍然由 AI 通过你自己的 Godot/Unity MCP（或手写脚本）执行；本软件只负责把「视觉意图」讲清楚。

## 自检

```bash
node test/smoke.js --offline   # 数据层 + MCP 协议 + 磁盘降级（不需要应用在跑）
node test/smoke.js             # 追加端到端：真实截图、标注、区图、回写、MCP 工具链
node test/mcp-stdio-check.js   # 用真实 stdio 子进程模拟 MCP 客户端，含真实窗口截取
node test/ui-flow-check.js     # 合成指针事件驱动真实交互：框选→自动生成条目→保存→挪动→撤销
node tools/stop.js             # 安全停止本应用（按 PID 校验，不误伤其它程序）
```

## 打包与交付物

已产出并验证：`dist/FrontDesignHelper-1.0.0-win.zip`（约 112 MB，**解压即用**）。
解压后双击 `FrontDesignHelper.exe` 即可；打包版数据落在 `%APPDATA%\FrontDesignHelper\data`。

重新构建：

```bash
npx electron-builder --win zip \
  --config.electronDist=node_modules/electron/dist \
  --config.npmRebuild=false \
  --config.win.signAndEditExecutable=false
```

- 用 `electronDist` 指向本机已装好的 Electron，避免构建时重新下载 100+ MB。
- 用 `zip` 目标而不是 `portable`：单文件 exe 需要从 GitHub 拉 NSIS/winCodeSign，网络不通时会卡死；
  zip 只用本机缓存的 7zip。等网络可用后可换回 `--win portable`。
- 刻意**零原生依赖**（不用 better-sqlite3 之类），避免 Electron 与 Node 的 ABI 不一致问题。
- 刻意 `asar: false`：`src/main/win-helper.ps1` 必须能被 `powershell.exe -File` 直接执行。

## 安全边界（请勿破坏）

本软件只操作**用户明确选中的那一个窗口**，绝不批量动系统里的其它程序：

| 行为 | 说明 |
| --- | --- |
| 枚举窗口 | 只读，不改任何窗口状态 |
| 置前 | 只对用户选中的目标窗口；**不合成任何按键/鼠标事件** |
| 置前失败时 | 用 `SetWindowPos(..., SWP_NOACTIVATE)` 临时置顶，截完立即恢复；不改变你的焦点 |
| 截取时隐藏自身 | 只隐藏本应用自己的窗口，220ms 后恢复 |
| 关闭进程 | 应用本身不关闭任何其它进程；开发脚本 `tools/stop.js` 只按 PID 停止本应用，并校验命令行归属 |

> 开发提醒：**不要用 `Stop-Process -Name electron` 之类的按名批量杀进程**——会误伤机器上所有 Electron 应用。
> 正确做法：`node tools/stop.js`（读 runtime.json 的 PID，校验后再停）。

## 开发注意（踩过的坑）

- **`src/main/win-helper.ps1` 必须保持纯 ASCII，或带 UTF-8 BOM**。`powershell.exe` 5.1 会用系统 GBK 解码
  无 BOM 的 UTF-8 脚本，中文注释会吃掉换行/大括号，导致 `Add-Type` 编译失败、窗口枚举整体失效。
- 数据层（`store.js`）与 MCP 服务（`src/mcp/server.js`）都是纯 Node，可脱离 Electron 单独跑测试。
- 自检脚本支持 `FDH_DATA_DIR`，因此能直接验证打包版（数据在 `%APPDATA%`）：
  `set FDH_DATA_DIR=%APPDATA%\FrontDesignHelper\data && node test/smoke.js`