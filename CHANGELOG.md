# Changelog

## 0.5.2

- 内置运行时升级为官方 `@deepseek-ai/dsh@0.1.1-rc.2`：恢复 `prepareCall` 链路的 `contextWindow` 供给（上下文占用环数据更可靠）；纯文本模型收到图片时降级为文本占位而非报错。`dsh-llm-pi-ai` 补丁脚本同时兼容 rc.1 与 rc.2 两种源码形态。
- 修复所有主机斜杠命令（/permission、/model、/compact 等）报错 `missing "images"` 的问题：`commands/execute` 的 typert 描述符自 dsh 0.1.1 起要求显式携带 images 字段，现按描述符发送空列表。
- 新增可逆归档：历史面板行内（悬停显示）可归档/恢复会话，默认列表隐藏已归档项，「已归档」筛选可查看并恢复。归档走官方 `workspace.archiveSession`；Harness 暂无 unarchive RPC，恢复是工作台侧的持久化覆盖。

## 0.5.1

- 修复 0.5.0 在部分机器上无法启动的问题：旧版本扩展遗留在 Harness Profile 里的过期 @deepseek-ai 运行时包（如 rc.6 时代的 dsh-llm-deepseek，不认识 low 推理档）会遮蔽 VSIX 内置运行时，导致 Gateway 启动崩溃（`reasoningEffort expected "off" | "high" | "max" but got "low"`）。启动前现在会自动清理版本不匹配的遗留包，受影响用户重新加载窗口即可自愈。

## 0.5.0

- 内置运行时升级为官方 `@deepseek-ai/dsh@0.1.1-rc.1`：纳入 rc.8 对自定义 OpenAI 兼容网关的修复（请求格式差异、推理内容回传缺失），上下文占用环与 token 实时统计在中转网关下恢复；`dsh-llm-pi-ai` 兼容补丁重定，`supportsDeveloperRole` 已由上游原生收录。
- 模型选择器：模型行改为扁平 Codex 风格（选中仅 ✓、hover 圆角底色、单行显示）；多个提供商时为左右双栏（左提供商、右模型），单提供商直接列出；面板按内容自适应高度，不再出现滚动条。
- 推理控件压缩为单行 Codex 尺寸（20px 分段药丸 + 14px 旋钮 + 丸内档位圆点），保留拖动跟随与档位特效。
- 内置插件目录移除 DSH Vision Router，不再随扩展默认安装。
- 新增会话导入：历史面板与标题栏可导入 DSH 官方会话 ZIP、ChatGPT 导出 ZIP、JSONL/文件夹，以及本机 Claude Code / Codex / Cursor 等 Agent 会话。
- 首次启动会补装 `dsh-chat-import`（默认插件种子升至 v2）；导入后刷新会话列表并打开新导入的会话。
- 权限安全门：选择 Full Access 时弹出确认对话框（Codex 与官方 Web UI 同款），取消、Esc 或点击外部均不生效。
- 模型显示：右下角模型名完整显示不再省略号截断，图标颜色跟随当前推理档位（off / low / high / max 同色板）。
- 输入区对齐：权限选择器宽度自适应内容、⌄ 紧贴档位名；两行布局下 token 统计、上下文环与压缩按钮归拢左侧。
- 推理滑块：特效文字改为档位名（LOW / HIGH / MAX，大写音游判定风）；拖动时旋钮与填充实时跟随手指，松手平滑吸附档位。
- 新增原生视觉模型 `deepseek-v4-flash-vision-exp`（图像理解：描述图片、识别截图文字、分析图表），自定义中转未配置模型时的默认清单同步收录。
- 模型选择器按提供商分组折叠：配置多个提供商时先选提供商再展开其模型（手风琴式，当前所选所在提供商默认展开），只有一个提供商时直接列出模型。
- 结论中的文件引用带类型图标并可点击在编辑器中打开（裸文件名按工作区索引精确匹配兜底）；网页链接均在外部浏览器打开。
- 新增可折叠的更改汇总条：智能体改完文件后在输入框上方显示 "N Changed +X −Y"，展开按文件列出行数统计、点击可打开文件，Keep All 仅收起不改动文件（不支持 Undo：harness 在扩展进程外修改文件，无可靠快照）。

## 0.4.9

- 工作台 WebView 脚本改为 TypeScript 模块打包（`src/webview/chat`），替代手写的 `media/chat.js` 整包。
- 配置面板：模型与 DSH 模式分组默认折叠并在标题处显示当前选择，/model、/preset 定向打开时自动展开。
- 推理滑块拖动手感修复：拖动全程保持抓取光标，新增进度填充，旋钮在档位间平滑滑动。
- 推理档位切换新增音游风格判定特效：切换时弹出当前档位名（如 LOW / HIGH / MAX），max 档位为金色渐变 + 扩散圆环，并遵循 prefers-reduced-motion。
- 配置面板对比度提升：分组标题、Provider 头、图标与描述文字从说明灰提升为前景色混合，面板加高、模型行更紧凑，减少滚动。

## 0.4.8

- 内置运行时升级为官方 `@deepseek-ai/dsh@0.1.0-rc.7`（含 node-pty 1.2 beta），`dsh-llm-pi-ai` 兼容补丁适配新的回放机制。
- 新增 `low` 推理档位：扩展设置、推理滑块（off / low / high / max）、自定义中继映射与中英文案同步支持。
- 自定义中继源自愈：扩展升级后自动为存量 relay 配置补齐新增的推理档位，无需手动重新保存。
- 工作台 UI：DeepSeek 鲸鱼“Working...”状态条（喷水动画并贴近输入框）、Claude Code 风格单条累计回合计时、推理 token 实时计数、工具调用与结果合并为单张可折叠卡片、卡片间距与细滚动条优化、发送后乐观回显用户消息、回合运行期间可排队输入并通过 QueueDock 编辑。
- 修复：Gateway 改为从 harness home 启动，避免工作区 `.env` 中的保留变量导致拒绝引导；工作时长与复制按钮只出现在正确的消息气泡上；QueueDock 编辑框在流式输出期间保持可用。
- Phase 0 工作台能力：会话导出、compact 按钮、联网搜索开关；工具卡改用按工具区分的图标；自定义中继支持任意模型 ID。

## 0.4.7

- 新增可分离工作台：可从侧边栏标题栏或命令面板在编辑器区新窗口打开 DeepSeek Harness，并在重复打开时复用现有面板。
- 侧边栏与可分离面板共享 Gateway 状态、会话、编辑器选区、插件状态和连接测试结果，保持两个工作台同步。
- 修复 Windows 下 Gateway Runtime 插件的启动路径，统一转换为标准 `file://` URL；从独立面板首次打开时也会主动启动 Gateway。

## 0.4.6

- Harness 后台改为真正的无界面 Gateway：保留官方 `/api` 与事件传输，但禁用官方 SPA 静态 fallback；访问回环端口根路径现在返回 404，不再提供 WebUI。
- 修复 VS Code 侧边栏拖动后工作台不重排的问题：根网格、消息区和输入区恢复可收缩边界，窄窗口下工具、Token 与发送操作自动分行，权限、模型与推理选择仍可用。

## 0.4.5

- 新增原生连接设置面板：支持 DeepSeek 官方服务与多个 OpenAI 兼容中转站，并可为各提供商配置 Base URL、只写 API Key 和连通性测试。
- Provider 设置与凭据统一通过 Harness 本地控制面管理；旧版 VS Code `apiKey`、`baseUrl` 与 `providers` 配置会在首次连接后安全迁移。
- 模型选择器改为读取 Harness 实时模型目录，自动显示不同 Provider 提供的模型、来源名称及对应推理等级。
- 插件中心新增扩展内置目录与受控安装配方；支持一键安装 DSH Routing Suite、Vision Router 和 Super Injector。
- Routing Suite 安装固定到已审查的 Release 与 Git 提交，对安装包和 Agent Preset 执行 SHA-256 校验，并保护用户已有的自定义预设。
- 默认插件只在首次缺失时自动安装，安装状态、受控套件卸载和运行时重启继续由独立插件管理服务负责。
- 输入框重新支持粘贴 PNG、JPEG、WebP 与 GIF 图片，提供缩略图、移除和大图预览，并通过 Harness 原生图片消息发送。
- 新增结论时间线与最新结论复制按钮，可快速跳转到历史回复；工具卡补充运行状态、参数摘要及 JSON、Diff、代码格式化展示。
- 优化启动页、流式思考与工作时长更新，减少初次连接和长回复期间的布局跳动。

## 0.4.4

- 新增 Codex 风格的 `@文件` 能力：输入 `@` 后模糊检索工作区文件，选择后显示可移除、可点击的上下文卡片，并在发送时由扩展宿主安全读取文件内容。
- VS Code 编辑器选区改为实时上下文卡片，不再把代码块直接插入输入框；选区正文仅保存在 Extension Host，并通过不透明 ID 附加到下一条消息。
- 模型回复中的 Markdown 文件链接、行内代码路径和普通文本路径支持点击跳转，并可定位到 `path:line:column` 或 `path#Lline`；所有路径均限制在当前工作区。
- 编辑器上下文、文件检索、模糊排序、`@` 候选菜单和文件引用解析按宿主服务、业务模型与 Webview 组件分层实现。

- 将运行中的三点指示器改为 Claude 风格的顺序跳动：第一、第二、第三个点依次上跳回落，不再三个点同时闪烁。
- 三点指示器抽为独立 ActivityIndicator 组件，并支持系统“减少动态效果”设置。

- 推理过程改为 Claude Code 风格：reasoning block 开始时自动展开并逐帧平滑追加，收到 block-end 后自动收起，历史推理默认折叠但仍可手动查看。
- 正文和推理流式输出使用独立 StreamingMessageComponent 原位更新，不再每 16ms 重建整段 Markdown DOM；大分片会分帧追赶并保持底部滚动稳定。

- 修复插件市场没有显示 GitHub Topic 仓库的问题：市场现在直接读取 `topic:dsh-plugin` 搜索结果，而不再仅提供外部链接。
- 将市场数据拆分为 GitHub Topic、精选目录和合并服务；任一来源不可用时自动降级到另一个来源，避免市场整页为空。
- GitHub 仓库自动生成 `github:owner/repository` 安装参数，精选目录继续补充分类、中文介绍、npm 包名和固定版本命令。
- 市场底部显示本次已加载数量和 GitHub Topic 仓库总数，卡片标明数据来自 GitHub Topic 或精选目录。
- 新增 Agent、混合、仅官方 Web UI 和未知四类兼容性标识；纯主题/布局插件不会再被误导性地显示为原生工作台可用。
- 插件中心业务抽出为独立 Controller，Webview Provider 只保留消息桥接，数据源、安装管理、运行时重启和 UI 组件各自分层。

- 新增原生 DSH 插件中心，直接读取 `dsh-plugin` GitHub Topic，并合并精选目录的分类、翻译和安装元数据；支持筛选、搜索、已安装列表和自定义安装。
- 插件安装与移除严格调用官方 `dsh plugin --profile web` 流程，并在配置变更期间安全停止和重启 Harness Gateway。
- VSIX 内置 pnpm 及 Windows/POSIX 启动包装器，安装插件不再依赖用户预装 Node、npm、pnpm 或本地 Harness。
- 支持 npm 包、GitHub spec、本地路径和 tarball URL；安装参数按单一安全参数校验，避免 Windows shell 转发发生参数注入。
- 插件目录跟随 VS Code 语言显示英文或简体中文，并明确标注仅面向官方 DSH Web 客户端的 UI 扩展。
- 增加第三方插件沙箱边界警告、源码确认弹窗、目录数据白名单投影和插件管理专项测试。

## 0.4.3

- 新增 Claude Code 风格的输入框模型配置组件，模型、DSH 模式与推理等级会在发送下一条消息时统一生效。
- 推理等级改为三档可见的胶囊滑杆，支持拖动、滚轮与直接点击，并为不同档位提供独立颜色。
- 模型与模式浮层改为紧凑右对齐布局，同时放大输入区文字并统一工作台圆角风格。
- 模型卡片与输入框右下角的当前模型名称改为完整显示，不再截断为省略号。
- 输入区改为响应式工具、状态与操作分区；窄窗口会自动换行并调整模型面板，Token 左侧不再重复显示模型名称。
- 对话每轮会在最后一个可见结果底部显示工作时长；运行中按秒更新，完成后使用 Harness 的 `turn/start` 与 `turn/end` 事件固定真实耗时。
- 移除图片输入和附件传输，只保留编辑器选区作为显式消息上下文。
- Token 统计旁新增上下文占用圆环，基于 Harness `contextPressure` 投影显示压缩后的实时占用率。
- Agent Preset 在已有对话中切换时自动创建新会话，遵守 Harness 对已启动会话锁定 Preset 的协议约束。
- 修复权限下拉框字段适配和运行时覆盖配置错误；三种官方权限预设现在会完整显示、真实切换当前会话的沙箱与审批策略，并保存为新会话默认值。
- GitHub tag 工作流只构建四个平台 VSIX 并附加到 GitHub Release；不会自动发布到 VS Code Marketplace。
- Marketplace 图标改为透明背景的官方黑色 DeepSeek 标志。
- 使用官方 DeepSeek Harness 图标，并补充相应的第三方资源说明。

## 0.4.2

- 新增英文与简体中文本地化；命令、设置、宿主提示和原生对话工作台会自动跟随 VS Code 显示语言。
- README 改为英文 GitHub 主页，并新增完整的 `README.zh-CN.md` 中文说明。
- 对话正文与推理过程支持 Markdown：标题、列表、引用、代码、表格、删除线和链接均按 VS Code 主题渲染。
- 代码块支持一键复制，http(s) 链接经扩展宿主校验后再交给系统浏览器打开。
- 流式分片继续更新原消息块，Markdown 重排不会替换整条消息，保留展开状态与滚动位置。
- 原始 HTML 默认禁用，渲染结果经过 DOMPurify 白名单净化；远程 Markdown 图片默认禁用，避免不可信内容执行或发起隐私请求。
- 新增编辑器选区自动/手动附加、Token 用量显示及 `Ctrl/Cmd+Alt+H` 工作台快捷键。
- 修复 Windows VSIX 打包与运行时进程树清理，新增 macOS、Linux、Windows 多平台 CI 构建发布。

## 0.4.1

- 修复冷会话恢复时 `skills.list` 抢先执行导致的 `session not found (not attached)` 启动异常；可选目录失败不再拖垮整个工作台。
- 对话消息改为按 ID 增量更新，流式文本在原节点内追加；推理和工具卡的展开状态、用户滚动位置不再因新分片丢失。
- 修复斜杠命令传输协议：官方命令改走 `commands/execute`，不再被误发给模型，并在对话中显示持久命令回执。
- 权限选择现在真实写入 `permission/preset`、`sandbox/mode` 与 `approval/policy`，同时保存为本机新会话默认值。

## 0.4.0

- 输入框支持 `/` 斜杠命令菜单：输入 `/` 弹出官方命令列表（`/compact`、`/feedback`、`/goal`、`/permission`、`/plan`），支持过滤、键盘导航与一键插入。
- 新增扩展级斜杠命令 `/model`、`/reasoning`、`/preset`，通过原生快速选择器切换会话模型、推理等级与 Agent Preset。
- 命令列表从运行时 `commands/list` 动态获取，随会话切换刷新。

## 0.3.0

- 移除官方 WebUI iframe，改为原生 VS Code 对话工作台。
- 接入 Harness Gateway RPC、Mux/Host WebSocket 与自动重连。
- 增加会话历史、流式消息、推理、工具、审批、问题、Todo、Skills 和任务视图。
- 模型、推理与 Agent Preset 改为会话级 Gateway 操作。

## 0.2.0

- 改为一个统一的官方 Harness Web 工作台，覆盖完整会话与工具功能。
- 内置 `@deepseek-ai/dsh` 和平台独立 Node，不再要求本地部署、Node 或 npm。
- 增加 Flash/Pro、推理等级和四种官方 Agent Preset 选择器。
- API Key 改为本机 VS Code 用户 `settings.json` 配置，并迁移旧 SecretStorage 值。
- 使用随机回环端口、严格 Webview CSP 和平台目标 VSIX。

## 0.1.0

- 首个 VS Code 扩展版本。
- 通过官方 stdio JSON-RPC SDK 协议连接 DeepSeek Harness。
- 支持侧边栏聊天、流式输出、思考过程、工具活动和多轮会话。
- 支持安全 API Key 存储、托管运行时安装和自定义运行时。
- 支持文件权限策略、停止任务、新建会话和编辑器选区上下文。
