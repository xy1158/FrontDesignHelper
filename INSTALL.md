# FrontDesignHelper · 安装与初始化配置

> 给 AI 一双眼睛：截取 Godot / Unity / 网页界面 → 框选或挪动区块并写提示词 → AI 通过 MCP 读到精确坐标后改界面。

本文只讲**怎么装、怎么初始化、怎么配置**。功能怎么用见 [`docs/USAGE.md`](docs/USAGE.md)，
为什么这么设计见 [`docs/DESIGN.md`](docs/DESIGN.md)，AI 侧接入细节见 [`docs/MCP-SETUP.md`](docs/MCP-SETUP.md)。

---

## 1. 系统要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（x64）。窗口枚举与置前依赖 Win32，暂不支持 macOS / Linux |
| 权限 | 普通用户即可。**不要**用管理员运行（否则会被 UIPI 限制，反而抓不到普通权限的编辑器窗口） |
| 磁盘 | 便携版约 300 MB；数据另算（每张截图 1~3 MB） |
| Node.js | **仅两种情况需要**：① 以源码方式运行；② 使用「一键让 AI 修改」功能（它会调 `node` 启动任务）。建议 Node 20+ |
| DSH | 「一键让 AI 修改」需要本机已安装并使用 DeepSeek Harness（`dsh` 命令可用） |

---

## 2. 安装（两种方式，任选一种）

### 方式 A：便携版（推荐，免安装）

1. 解压 `dist/FrontDesignHelper-1.0.0-win.zip` 到任意目录，例如 `E:\FrontDesignHelper\app\`。
   > 仓库里已有一份解压好的：`app\FrontDesignHelper.exe`。
2. 双击 `app\FrontDesignHelper.exe`，或双击桌面快捷方式 **FrontDesignHelper**。
3. 想固定到任务栏：右键任务栏图标 → 固定。

> 便携版不需要管理员权限、不写注册表；卸载 = 删掉 `app\` 目录 + 删掉数据目录（见第 6 节）。

### 方式 B：源码运行（改代码 / 想用最新改动）

```powershell
cd E:\FrontDesignHelper
npm install            # 首次安装依赖（含 Electron 运行时，约 300 MB）
npm start              # 启动应用
```

若 `npm install` 下载 Electron 卡住或失败：

```powershell
# 用国内镜像
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm install
```

若公司/本机不允许写 npm 全局缓存，把缓存指到项目内：

```powershell
$env:npm_config_cache = 'E:\FrontDesignHelper\.npm-cache'
$env:ELECTRON_CACHE   = 'E:\FrontDesignHelper\.electron-cache'
npm install
```

启动也可用根目录的 `启动 FrontDesignHelper.cmd`（有 `app\` 时优先用便携版，否则回退源码方式）。

---

## 3. 首次初始化清单（按顺序做完即可）

### 第 1 步：启动并确认状态

启动后会看到顶栏右侧有一个状态标签：

- **绿色 `MCP 就绪 · 端口 xxxxx`** → 本地桥接已起来，AI 可以连。✅
- **红色 `MCP 未启动`** → 端口被占或启动失败，看 `%APPDATA%\FrontDesignHelper\data\app.log`。

这个端口是自动分配的，不需要手动配置；MCP 服务会自己读取
`%APPDATA%\FrontDesignHelper\data\runtime.json` 找到它。

### 第 2 步：确认数据目录

```
%APPDATA%\FrontDesignHelper\data\
├─ runtime.json              运行态（端口 + token），退出即删除
├─ app.log                   应用日志
├─ sessions\<会话ID>\        每张截图一个目录
│   ├─ base.png              原始截图
│   ├─ annotated.png         叠加意图图（AI 默认读这张）
│   ├─ instructions.md       可直接阅读的指令文档
│   └─ session.json          结构化数据
└─ logs\agent-*.log          「一键让 AI 修改」的任务日志
```

想换位置：设置环境变量 `FDH_DATA_DIR` 后再启动（源码版和便携版都会遵守）。

### 第 3 步：截第一张图

1. 把 Godot / Unity 编辑器窗口显示出来（**不要最小化**，最小化会先被还原）。
2. 点左上角 **「截取窗口」**（或 `Ctrl+N`）。
3. 在列表里按标题/进程名过滤，选中目标窗口，回车或点击即可。
   - 截取时本窗口会**短暂隐藏**并让目标窗口到前台，截完自动回来（这是为了不让本应用挡住目标）。
   - 若提示「目标窗口未能置前」，说明系统拦了前台切换，截图可能含遮挡 —— 先把目标窗口点到前面再截。
4. 也可以用 **「整屏」** 直接抓主显示器。

### 第 4 步：框选 + 写提示词

1. 按 `B`（或点「框选」），在图片上拖出一个矩形。
2. 右侧提示词区会**自动出现一条对应条目并聚焦输入框**，直接写清楚要改成什么样。
3. 要表达「位置错了」用 `M`（挪动）：拖出区块 → 松开 → 移到目标位置 → 再单击一次确认。
4. 提示词写「结果」而不是「过程」，例如：`改成深色卡片、宽度 320、圆角 8、锚点居中`。

### 第 5 步：把本软件接给 AI（MCP）

AI 侧只需要一个 stdio MCP 服务：`E:\FrontDesignHelper\src\mcp\server.js`。

**DSH（本机最常用）**：编辑 `C:\Users\<你>\.dsh\cordis.patch.yml`，在已有 `- insert:` 列表里追加：

```yaml
    - id: mcp-frontdesignhelper
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: frontdesignhelper
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args: ['E:\FrontDesignHelper\src\mcp\server.js']
        toolCallTimeoutMs: 120000
        reconnect:
          maxAttempts: 100
```

改完**重启 DSH**，工具会以 `mcp__frontdesignhelper__*` 的名字出现（6 个）。

**其它客户端（Claude Desktop / Cursor / Codex …）**：

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

用 `npm run mcp:config` 可打印按本机路径生成好的片段。

### 第 6 步：一键让 AI 修改（可选但推荐）

前置条件（缺一不可）：

1. **DSH 正在运行**（`dsh web` 那个进程在跑），并且你在 DSH 里**打开着目标对话**。
2. 本机装了 Node（应用会用 `node` 启动任务；也可用 `FDH_NODE` 指定路径）。
3. 应用能找到 DSH：默认探测 `127.0.0.1:3080`，也自动试 3000/8080 等端口。

操作：

1. 写好标注后点提示词区底部 **「让 AI 开始修改」**。
2. 弹窗顶部应显示 `DSH 接口已连接（端口 3080，N 个对话）`。
3. 「对话」默认已选中**你界面上正在看的那条对话**（按 DSH 窗口标题匹配得出）；不是的话手动选。
4. 点 **「投递并开始」**。预期：那条对话里立刻多出一条用户消息（就是生成的指令），
   DSH 当场开始调 `get_instructions` / godot-ai 的工具；卡片会一条条变绿。

失败时弹窗/提示会写明原因，可直接切「备用：粘贴到 DSH 窗口」方式，或「后台任务（headless）」。

---

## 4. 目录结构

```
E:\FrontDesignHelper\
├─ app\                     ← 已解压的便携版（快捷方式指向这里）
├─ dist\
│   └─ FrontDesignHelper-1.0.0-win.zip   可分发的压缩包
├─ src\
│   ├─ main\                主进程：窗口枚举/截图、会话存储、本地桥接、AI 任务
│   ├─ preload\             渲染进程白名单桥
│   ├─ renderer\            界面：图片区 + 提示词区
│   └─ mcp\                 MCP stdio 服务（AI 侧的入口）
├─ tools\                   check.js（构建前检查）、stop.js（安全停止）、make-icon.js
├─ test\                    三套自检脚本
├─ docs\                    使用手册 / 设计文档 / MCP 接入 / 实现记录
├─ assets\                  fdh.ico
├─ package.json
└─ 启动 FrontDesignHelper.cmd
```

---

## 5. 可配置项

| 变量 / 选项 | 默认 | 作用 |
| --- | --- | --- |
| `FDH_DATA_DIR` | `%APPDATA%\FrontDesignHelper\data` | 数据目录（源码版与便携版共用同一份历史） |
| `FDH_NODE` | 自动查找 | 一键修改时使用的 `node.exe` 路径 |
| `FDH_DSH` | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | 一键修改使用的 DSH 入口 |
| 弹窗「DSH 窗口标题包含」 | `DeepSeek Harness` | 备用粘贴方式用来定位窗口的关键字 |
| 弹窗「投递方式」 | 官方接口 | 官方接口 / 粘贴到窗口 / 后台 headless |

---

## 6. 备份、升级、卸载

- **备份**：拷走 `%APPDATA%\FrontDesignHelper\data` 即可（里面有截图、标注、指令文档）。
- **升级**：用新 zip 覆盖 `app\` 目录（先关掉应用）；数据不受影响。
- **卸载**：删除 `app\`、桌面/开始菜单快捷方式，以及 `%APPDATA%\FrontDesignHelper`。
- **只清历史**：在应用「历史」里逐条删，或删除 `data\sessions\` 下的对应目录。

### 从旧名字迁移（FrontDesingHelper → FrontDesignHelper）

旧版本拼写是 `FrontDesingHelper`（少一个 i）。本版本已统一改名，并做了：

- 项目目录：`E:\FrontDesingHelper` → `E:\FrontDesignHelper`；
- 数据目录：`%APPDATA%\FrontDesingHelper\data` → `%APPDATA%\FrontDesignHelper\data`（**已复制**，旧目录保留作备份）；
- 快捷方式：已重建为新名字；
- DSH 配置：条目已改为 `mcp-frontdesignhelper`（**需重启 DSH 生效**）。

旧目录 `E:\FrontDesingHelper\` 里可能还残留 `dist\`、`app\`（被系统占用无法立即删除），
**重启电脑后**直接删掉即可，不影响新版本。确认新版本一切正常后，也可以删除
`%APPDATA%\FrontDesingHelper`。

---

## 7. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 双击快捷方式「没反应」 | 已有一个实例在跑（会弹「已在运行」提示并顶到前台）。彻底重启：`node tools/stop.js` 后重新双击 |
| 顶栏显示 `MCP 未启动` | 端口被占/启动失败；看 `data\app.log`，或重启应用 |
| AI 说「找不到 frontdesignhelper」 | MCP 配置没生效：确认 YAML 缩进、`args` 指向真实存在的 `server.js`，然后**重启 DSH** |
| 投递后 DSH 里看不到 | 确认「对话」选的是你正在看的那条（默认已自动选中）；若是「＋ 新建对话」，该对话要在 DSH 侧边栏点开或按 F5 才出现 |
| 截图里有本应用/别的窗口 | 目标窗口未能置前；先把目标窗口点到前面，或改用「整屏」 |
| 截图是黑的 | 个别 GPU 窗口（Vulkan/OpenGL）无法直取；应用会退化为「置前 + 截屏裁剪」，请保证目标窗口在前台 |
| 标注坐标和引擎里对不上 | `get_instructions` 返回的 `imageOrigin` 不为 (0,0) 时，窗口坐标 = 图片坐标 + imageOrigin |
| 卡片一直「待处理」 | AI 还没回写。它每改完一条应调 `ack_instruction`；也可在界面点「全部置为待处理」重来 |

---

## 8. 自检（装完/改完代码后跑一遍）

```powershell
cd E:\FrontDesignHelper
node tools/check.js          # 打包前必跑：全部 JS 可解析、无补丁残留、脚本引用齐全
node test/smoke.js           # 数据层 + MCP 协议 + 端到端（需要应用在运行）
node test/ui-flow-check.js   # 真实交互：框选→自动生成条目→保存→挪动→撤销
node test/mcp-stdio-check.js # 用真实 stdio 子进程模拟 MCP 客户端
node tools/stop.js           # 安全停止本应用（按 PID 校验，不误伤其它程序）
```

三套脚本都支持 `FDH_DATA_DIR`，可直接验证便携版：

```powershell
$env:FDH_DATA_DIR = "$env:APPDATA\FrontDesignHelper\data"
node test/smoke.js
```