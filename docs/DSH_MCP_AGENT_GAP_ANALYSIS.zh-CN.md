# DSH、MCP 与 Agent 客户端能力核对

本次核对：2026-11-02 至 11-03。范围为当前仓库原生 VS Code 工作台与官方资料；功能存在不代表我们已经在每个商业客户端实际运行过，也不以宣传页推断所有平台都已交付。

## 版本与当前结论

- 修改前主分支：`@deepseek-ai/dsh@0.2.1-rc.3`。
- 本机已安装的 `skymecode.deepseek-harness-for-vscode-0.6.1`：内核为 `0.2.1-alpha.2`。源码、安装包及已安装扩展不是同一个更新渠道。
- 本次 dev：`0.2.1-rc.5`。核对时 npm `latest/next` 都指向该版本，官方发布于 2026-10-30。`0.2.2-alpha.2` 发布于 2026-10-28，是另一条实验分支，本次不采用。来源：[DSH rc.5 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)、[npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh)。
- 扩展版本号保留 `0.6.1`，此次提交到远程 dev，不更新既有 Release 或 Marketplace。

MCP 并非从零缺失：之前已有 Profile 注入和 stdio 端到端调用验证，但只能编辑 JSON 设置，坏配置会静默丢项。本次补齐可见管理入口、严格校验、启停、诊断入口和 HTTP 验证。模型继续通过 DSH 原生工具调用机制使用 MCP，不在扩展中另写一套 MCP 客户端。

## DSH 能力与工作台缺口

| 能力 | 当前扩展状态 | 后续实现方向 |
| --- | --- | --- |
| 聊天、工具调用、推理、审批、结构化提问 | 已接原生协议；保留问答顺序修复 | 持续验证流式、恢复和多窗口一致性 |
| MCP stdio / Streamable HTTP | 原生可调用；本次提供管理命令和更多菜单入口 | 继续完善专门面板与按服务器日志 |
| MCP 资源与模板列表、资源读取 | DSH 已挂载 `dsh-mcp-resources`，Agent 可通过原生资源工具读取；没有可视化资源浏览器 | 资源树和选取后引用，复用原生服务 |
| MCP 动态工具更新、重连、服务器指令 | 原生 client 处理 | UI 尚不能准确呈现每台服务器的实时连接健康；已注册工具列表不能当作在线检测 |
| MCP OAuth、提示词模板、资源订阅、要求 task-based execution 的工具 | 当前 DSH client 配置没有 OAuth 授权入口；其文档明确未支持后三类 | 优先等原生接口或贡献上游，不假装普通 header 能替代 OAuth |
| MCP 工具级启停与按会话授权 | 本次仅支持整台服务器启停；调用仍走 DSH 工具管线及模式；外部 MCP 程序不继承 Agent 文件沙箱 | 在原生 tool scope/restriction 上做 UI，不维护第二套执行器 |
| Plan / Goals / 子代理 / 后台任务 | 已接入相应服务与投影 | 更清晰的子代理关系、任务输出定位和中断恢复 |
| Schedule | 有部分展示、删除和历史入口；没有完整的 Host 任务目录、编辑器及 daily/weekly/cron 展示 | 迁移到原生 catalog/update/history，补全时区与冲突处理 |
| 历史搜索、置顶、归档恢复 | 已接原生 API；全文索引首次搜索才打开 | 长历史性能预算、检索结果定位 |
| 变更审阅 | 有原生历史 diff、双栏片段与 worktree 合并 | 逐 hunk 接受/拒绝、回滚需验证原生写入/恢复接口，不能把展示用历史片段当可逆补丁 |
| 工作树 | 扩展已有本地隔离与合并；官方也有可选 worktrees 插件 | 先核对任务归属、脏工作区、恢复和清理契约，再迁移，避免双重工作树管理 |
| 插件市场 | 当前 GitHub Topic / curated 目录；普通包安装走原生 Plugin Manager | 原生 pluginMarket 自定义索引源、更新/重装与诊断 UI；不能把普通 GitHub URL 当专用索引 |
| 终端、SSH、浏览器/电脑操作 | 部分运行时能力存在，缺少专用工作台体验 | 逐项接入原生终端和远端会话；MCP 浏览器服务可以补能力，但不等于完整桌面自动化 UI |
| Web UI 插件、Office/PDF 内嵌预览、语音、DevTools | 原生 VS Code 工作台不嵌入官方 Web UI；部分大体积资源被有意排除 | 按明确使用场景逐项启用，不重新打包所有 Web 资源 |

以上状态来自本仓库 `src/runtime`、`src/gateway`、`src/webview`、测试，以及 rc.5 随包公开声明。原生 MCP 范围参考 [client 文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/mcp/mcp-client/README.md) 和 [resources 文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/mcp/mcp-resources/README.md)。

## 近期客户端调研

下表比较可借鉴的交互与架构，不是模型能力排名。版本快照取对应仓库发布记录，文档可随产品继续更新。

| 客户端 | 核对到的能力 | 对本扩展的启示 |
| --- | --- | --- |
| VS Code / Copilot | 1.144（2026-10-28）强调独立 Agent Host、跨环境会话、模型比较、变更工作集与自动化。MCP 有启停、重启、输出和工具诊断入口 | 先做明确的运行状态、生命周期和审阅闭环；AHP/云连续性需要独立宿主架构，不是加按钮就能完成。来源：[1.144](https://code.visualstudio.com/updates/v1_144)、[MCP 管理](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers) |
| Cline | 核对到 v4.1.26（2026-10-26）；本地/远程 MCP 配置、服务器列表和管理入口，强调实际调用验证 | 管理入口与错误反馈要直观，测试不能只证明进程启动。来源：[发布](https://github.com/cline/cline/releases/tag/v4.1.26)、[MCP](https://docs.cline.bot/mcp/mcp-overview) |
| Kilo Code | 文档提供 MCP 增改、启停、删除，区分全局与项目配置 | 可以做显式导入与作用域；不要自动执行工作区里未经确认的 MCP 命令。来源：[MCP 配置](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) |
| Continue | 以 Agent 模式调用 MCP，允许在工作区配置服务器；另有聊天、编辑和补全产品面 | 工具模式和配置作用域要明确；行内补全是独立功能，不属于 MCP 协议。来源：[MCP](https://docs.continue.dev/customize/deep-dives/mcp) |
| Codex | CLI/IDE 可配置 stdio、HTTP；IDE 提供添加入口，支持启停、OAuth、工具允许/拒绝列表和超时项 | 可借鉴服务管理、权限粒度和配置共享；不能照搬它的 TOML/OAuth 参数为 DSH 已支持。来源：[官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| Claude Code | 核对到 v2.1.316（2026-10-31）；文档覆盖连接状态、配置警告、重连、作用域、OAuth 和 MCP 任务 | “注册、连接、调用成功”应分开呈现，不能用一个绿点混在一起。来源：[发布](https://github.com/anthropics/claude-code/releases/tag/v2.1.316)、[MCP](https://code.claude.com/docs/en/mcp) |
| Cursor | MCP 配置、HTTP/stdio 服务及远程 OAuth，界面还有 Agent Review、规划等独立功能 | OAuth 和配置格式兼容要单独设计；工具调用不自动带来文件审阅与回滚。来源：[MCP](https://cursor.com/docs/mcp) |
| OpenCode / Zed | OpenCode v1.19.5（2026-10-28）文档支持 MCP 开关、OAuth 和按 Agent 的工具控制；Zed 支持工具、提示词及工具列表动态更新，并可通过 ACP 转发 MCP | 原生可复用能力优先；需要关注大量工具占用上下文以及外部 Agent 的配置边界。来源：[OpenCode 发布](https://github.com/anomalyco/opencode/releases/tag/v1.19.5)、[MCP](https://opencode.ai/docs/mcp-servers/)、[Zed](https://zed.dev/docs/ai/mcp) |

## 本次实现与使用

1. 命令面板运行 **DeepSeek Harness：管理 MCP 服务**，或工作台“更多 → MCP 服务”。
2. 添加本地程序（stdio）或远程地址（Streamable HTTP），填入参数及环境变量/请求头。参数是 JSON 字符串数组，不会由扩展拼成 shell 命令。
3. 保存后在当前模型回合空闲时重载 DSH Host。重载不是单服务器热更新；已有后台进程不承诺跨 Host 重启继续运行。
4. 查看“已注册的 MCP 工具”，然后在对话里请求 Agent 调用具体工具。此列表是全局注册视图，不代表当前 Agent 的模式权限、实时连接或调用成功。
5. MCP 服务在 Agent 文件沙箱之外运行，`read-only` 不能替代服务器自己的权限隔离。只添加可信服务。
6. 配置错误会显示字段路径，不能保存覆盖有效配置；直接手改设置出现错误时不会自动重启运行时。坏配置应先通过管理器修复，再重载。

仍兼容 `deepseekHarness.mcpServers` JSON 数组；新增 `enabled:false` 可以保留配置并停用。普通配置与字面密钥保存在 VS Code 用户设置，本次不提供密钥保险库；建议用 `$env:NAME`。它只替换整个值，例如 `Authorization: "$env:MCP_AUTH"` 对应环境变量值 `Bearer ...`，不支持嵌入式 `${env:...}` 或 `Bearer $env:...`。环境来自 VS Code 扩展宿主启动环境；修改系统环境变量后通常需要重新启动 VS Code。

示例（自行替换地址，不会默认连接这些服务）：

```json
[
  {"serverName":"local","transport":"stdio","command":"node","args":["/absolute/path/server.mjs"]},
  {"serverName":"remote","transport":"streamable-http","url":"https://example.com/mcp","headers":{"Authorization":"$env:MCP_AUTH"}}
]
```

Windows 使用实际可启动的程序；对于需要 cmd 启动的 `.cmd` 工具，可显式使用 `cmd` 与参数 `["/c", "npx", "-y", "your-mcp-package"]`，不要把整条命令塞进 `command`。远程开发中的 stdio 在扩展宿主所在机器运行。

## 建议实施顺序

- **本次完成**：rc.5 升级、MCP 管理/校验/启停/目录、stdio 与 HTTP 调用回归、避免配置改动立即打断当前模型回合。
- **下一步优先**：原生连接状态与每服务器日志、MCP 凭据安全存储及 OAuth（需上游支持或明确扩展）、工具级权限、Schedule 全目录和编辑。
- **随后**：可复现的检查点/回滚、长会话定位、可视化子代理与任务树、显式导入其他客户端 MCP 配置。
- **需要单独设计**：AHP/ACP/远端宿主连续性、云自动化、完整电脑操作、Office 预览。不要把其他客户端的产品 UI 当作 DSH 已提供的 API。

## 测试与边界

本次增加严格配置、取消编辑、并发配置更新、只读目录鉴权、密钥不进入聊天 Webview 状态等回归。运行时测试使用真正的随包 DSH 加隔离的本地模拟模型/MCP 服务，验证工具发现 → 调用 → 结果回传。不会使用用户的真实密钥或生产 MCP 服务。跨平台结果以 dev 验证工作流为准；OAuth、真实账号及每个第三方 MCP 的兼容性不能由 fixture 测试推断。

依赖审计发现 rc.5 的固定传递依赖仍包含已公布问题，因此本扩展对 MCP HTTP 客户端、Zod 和 Undici 设置了显式修复版本覆盖；这不是修改 DSH 版本标识，需随每次升级重跑原生协议与安装包测试。MCP HTTP 重定向相关依据：[官方安全公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw)。
