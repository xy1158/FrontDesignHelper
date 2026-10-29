# MCP 接入指南

AI 侧只需要一个 **stdio MCP 服务**：`src/mcp/server.js`。
它在应用运行时通过本地回环端口（`data/runtime.json`）连到桌面应用；应用没开时会降级为磁盘只读。

---

## 0. 本机状态：已接入

`C:\Users\<你的用户名>\.dsh\cordis.patch.yml` 已写入 `mcp-frontdesignhelper` 条目
（备份：`cordis.patch.yml.bak-20261029-112405`，追加方式写入，原文逐字节保留）。

- 已用真实 stdio 握手验证：`initialize` → `tools/list`（6 个工具）→ `list_captures` 正常。
- **尚未生效的唯一原因**：DSH 需要重启才会加载新的 MCP 服务。
- 重启后工具名通常带 `serverName` 前缀，形如 `frontdesignhelper_list_captures`。

## 1. DeepSeek Harness（本机在用的客户端）

配置文件：`C:\Users\<你>\.dsh\cordis.patch.yml`。
在已有的 `- insert:` 列表里追加一项（注意缩进与已有条目对齐，`id` 不要重复）：

```yaml
    - id: mcp-frontdesignhelper
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: frontdesignhelper
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args: ['E:\FrontDesignHelper\src\mcp\server.js']
        toolCallTimeoutMs: 120000
        reconnect:
          maxAttempts: 100
```

> 改完需要**重启 DSH**（或重新加载配置）才会出现 `frontdesignhelper` 的工具。
> 用 `where node` 确认 `command` 的真实路径（也可是 `node` 的绝对路径）。

## 2. Claude Desktop / Cursor / Codex 等（JSON 形式）

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

在项目目录跑 `npm run mcp:config` 会按本机实际路径打印这段。

## 3. 装好后的自检

让 AI 依次调用：

1. `list_captures` —— 应看到至少一个会话（没有就先让用户截一张）
2. `get_instructions` —— 应返回 Markdown + 结构化 JSON
3. `get_capture_image` —— 应返回一张 PNG（叠加意图图）

如果第 1 步就报「应用没有运行」，说明桌面应用没启动，或 `data/runtime.json` 位于别的目录（用 `FDH_DATA_DIR` 指过地址时两边要一致）。

---

## 4. 工具速查与推荐调用顺序

| 顺序 | 工具 | 何时调 |
| --- | --- | --- |
| 1 | `list_captures` | 每次开工先看有没有新标注 |
| 2 | `get_instructions` | 拿到坐标 + 提示词（这是主入口） |
| 3 | `get_capture_image` | 需要看整体意图图时（`which=annotated`） |
| 4 | `get_region_image` | 需要看清某条标注的细节时（可给 `annotation_id` 或任意矩形 + `pad`） |
| 5 | `ack_instruction` | **每改完一条就调一次**，`note` 写清实际改了什么 |
| 备 | `request_capture` | 用户说「看看现在的界面」时，按窗口名截一张 |

### 返回值形状

`get_instructions` 返回两个 text 块：
- 第一个是 Markdown（含坐标约定与每条提示词）
- 第二个是结构化 JSON（`annotations[].rect` 或 `from/to/dx/dy`）

`get_capture_image` / `get_region_image` 返回 `{type:'image', data:'<base64>', mimeType:'image/png'}`。

### 坐标换算要点

- 图片坐标原点 = 截图左上角，单位像素。
- 若返回的 `image.imageOrigin` 不是 `(0,0)`（窗口比屏幕大导致裁剪），
  真实窗口坐标 = 图片坐标 + `imageOrigin`。
- 换算到引擎坐标时（左下原点、锚点、缩放）必须整体变换后再套用。

## 5. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 工具列表里没有这 6 个工具 | 客户端没加载配置；重启客户端 |
| `调用失败：… 没有运行` | 应用没启动；先开应用 |
| `get_region_image` 报「应用未运行」 | 该工具需要应用进程做裁剪；其余工具可离线 |
| 叠加图是原图 | 应用还没打开过该会话并保存过；打开后改一下任一提示词即可生成 |
| 状态一直「待处理」 | AI 没有调 `ack_instruction`；或在界面点了「全部置为待处理」 |