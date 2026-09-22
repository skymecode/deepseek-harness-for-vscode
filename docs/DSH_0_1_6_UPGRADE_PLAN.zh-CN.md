# DSH 0.1.6-alpha.2 升级与官方能力接入清单

实施日期：2026-09-20。升级已在本地分支 `codex/upgrade-dsh-0.1.6-alpha.2` 实施。以下先记录实际改动及兼容边界，再保留逐项契约核对。

## 版本与范围

- 扩展基线：本地 `main`，`79541d3ee2e1fbf557c4cc85f9a92006dbd81df3`，扩展版本 `0.6.1-dev`，工作区核查时干净。
- 依赖从 `@deepseek-ai/dsh@0.1.5-alpha.1` 升至精确版本 `0.1.6-alpha.2`；锁文件中的 250 个 DSH 包均为该版本。
- npm 实时 dist-tags：`alpha=0.1.6-alpha.2`，`latest=next=0.1.5-rc.2`。不能用 `@latest` 表达本次目标。
- 上游依据：公开 release `dsh-v0.1.6-alpha.2`，源码提交 `ddefc45fbc7f8e46dd73185e68295696d1297887`；发布于 2026-09-17。
- 已完成依赖安装、类型检查、生产构建和 17 项隔离真实后端回归；VSIX 验收结果见验证记录。

## 最终实现

| 领域 | 已采用的实现 |
| --- | --- |
| 协议与模型 | 官方 DeepSeek Messages 默认；迁移旧官方根地址，保留显式 Chat Completions 和自定义协议；设置表单支持 Anthropic。删除独立容量表和视觉名称猜测，读取官方 LLM 能力及 `contextPressure`，不制造未知模型的推理档位。 |
| 会话与历史 | 官方 Inbox 投影提供排队/Steer 状态；控制快照只更新对应会话，模型选择以官方投影为准。恢复归档调用 `workspace/unarchiveSession`，旧本地恢复意图成功同步后才清除。自动标题交给官方。 |
| 老 PTC 会话 | 新默认使用 `ptc`；不存在 `code` 时通过官方 `agentPresets/copy` 创建兼容预设，不改写旧日志或覆盖用户同名预设。 |
| 插件 | 普通 bundle 使用官方安装、取消、启停、卸载接口，报告只读/覆盖/重启状态；导入插件同样在线安装。pnpm 包装脚本写入可信可执行文件路径，适配官方对子进程环境的过滤。停止自动安装 Super Injector，保留已有插件和可选 Routing Suite。 |
| 文件与交付 | 普通会话附件使用官方二进制上传入口和持久 receipt；`deliverables/presented` 显示可打开的文件引用。选区仍由 VS Code 提供。 |
| 文件变更 | 优先读取官方 `workspace/changes` 摘要及逐文件 diff，覆盖 shell 产生的变更；空官方摘要不会被旧统计覆盖。快照 404 时保留有标注的工具统计；移除把整个 worktree 丢弃当作逐轮撤销的按钮。 |
| 隐私 | 明确禁用 `session-log-deepseek`、`plugin-package-inventory-deepseek` 和 OTel。合成 Messages 请求断言没有附带日志/插件清单或 API key；正常消息、上下文和所选附件仍发送给用户选择的服务。 |
| 运行时与补丁 | 官方 resolver 优先，旧目录修复仅在特定错误时有备份地重试。删除投影缓存及 tool replay 补丁，采用官方兼容配置。 |

### 保留的适配与边界

- **保存密钥的端点探测补丁**：上游对已保存 provider 的发现会返回目录，不能验证表单中改过的 URL。继续保留精确版本约束的凭据探测适配；密钥不送到 Webview。
- **模型元数据桥**：官方 `session/modelCatalog` 不返回输入能力和窗口信息。受官方 cookie 鉴权的 `/api/vscode.models` 只转发 `llm.listModels/resolveModelInfo` 的白名单字段。
- **共享历史编排**：多来源日志合并、冲突副本和平台交互保留；解码、迁移和锁使用官方实现。旧 fork 路径的一处官方 `snapshotEvents()` 暂留：该 API 仍可用但已废弃，后续须在等价观察接口验证后替换。
- **旧回合 diff**：官方快照随 Session 释放而消失，重启后不保证可用。纯文本回合没有工具结果时，上游不产生工具变更快照。
- **VS Code 能力**：编辑器、主题、滚动定位、通知、Git worktree、Auto 策略与未保存选区保留。普通附件每个 20 MiB、一次 40 MiB/8 个；子代理二进制附件暂不支持。
- **Web 专属界面**：不嵌入官方 SPA，因此 Office 浏览器预览、会话终端恢复、SSH 与 Browser/Computer Use 专用面板不会自动出现。交付文件打开 VS Code/已有查看器；MCP 资源使用官方运行时和工具界面，没有新增独立资源浏览器。
- **平台范围**：本轮实测 Windows x64。macOS/Linux 仍需对应平台验证。测试使用临时目录和回环假模型，不读取或迁移用户真实密钥、历史。

### 验证记录

- 类型检查和生产构建通过；全量 ESLint 0 错误、11 条文件/函数长度提示。
- 真实后端回归 17/17 通过：V2/V3 历史迁移、锁竞争、附件冲突、双后端共享历史、Messages、文件凭据、diff、归档恢复、PTC、插件及交互请求。
- 实测官方 Plugin Manager 安装/启停/卸载合成 bundle，并在线安装随包 `dsh-chat-import`、调用其发现接口。
- `npm run package` 全量单元回归 780/780 通过；17 项显式开启的运行时测试另行执行。最后清除旧撤销消息入口后，相关 60 项定向回归通过。
- Windows x64 VSIX 解包后再次通过全部 17 项真实后端测试。新增官方 LibreOffice 依赖使压缩体积约 205 MB；保留完整运行依赖。包内没有 `.agents`、测试文件或工作树数据。

以下保留实施前逐项核对；Web 专属 UI 的实际范围以上述边界为准。

## 接入原则

1. DSH 已提供的模型、会话、队列、归档、插件和文件协议，由官方服务负责。扩展只做字段映射、VS Code 交互和必要的传输适配。
2. 同一业务事实只有一个权威来源；不再用本地 Memento、模型名称猜测或工具文本解析覆盖官方状态。
3. 官方 Web UI 组件依赖浏览器、Cordis 客户端、资源注册或 Sidebar slot 时，先复用其 Host API 和可独立导出的纯函数，保留 Webview 展示；接入官方协议不要求整页嵌入官方 SPA。
4. 只有确认等价、且历史兼容及回归通过后，才删除旧实现。官方缺少的能力继续保留，并明确适用条件。
5. 停用旧默认安装策略与删除用户已经安装的第三方插件是两件事；升级不能顺手卸载用户插件。

## 一、升级必须改动

| 优先级 | 模块与当前入口 | 改动内容 | 验收依据 |
| --- | --- | --- | --- |
| 必须 | `package.json`、`package-lock.json`、构建脚本 | 精确升级 DSH，检查整个传递依赖图、新导出、Node/原生模块要求、安装脚本许可和平台 VSIX 内容。当前直接依赖只有总包 DSH，不需要凭空增加一组手工 pin 的配套包。 | 干净环境安装、类型检查、打包与平台启动通过；锁文件中不存在非预期旧版 DSH 服务副本。 |
| 必须 | `scripts/patch-dsh-llm-pi-ai.mjs` | 分别判断工具历史重放补丁和连接探测补丁是否仍必要；不能只把版本加进 `SUPPORTED_VERSIONS`。新版 discovery 仍可能在给定 provider 时优先返回内置 catalog，不能把“发现模型成功”视为网络连通性验证。 | 官方未修改的 transport 下验证真实请求目标、历史工具调用、reasoning 重放；能走官方契约就移除补丁，缺口被证实时才保留最小兼容处理。 |
| 必须 | `scripts/patch-dsh-session-projection-cache.mjs`、`projection-cache-recovery.ts` | 新版 `checkpointIdentity` 的 lineage 字段已可选，并包含 format generation；优先删除旧字符串替换脚本及 postinstall 钩子。缓存恢复只针对可重建派生缓存。 | 用旧缓存启动，验证正常失效重建；保留历史日志原件，不以扩大错误正则或清空历史来解决启动失败。 |
| 必须 | `runtime/web-runtime.ts`、`runtime/runtime-overlay.ts`、`runtime/gateway-runtime-plugin.ts` | 对照新版 `web` profile 检查行 ID、依赖、加载就绪和鉴权握手；使用官方 `ptc-runtime` / `workflow-ptc` 组合；保留回环绑定和 Extension Host 鉴权适配。配置改用安全 YAML 序列化，至少安全引用模型等动态字符串。 | Gateway 能启动；模型名不能注入 YAML patch 或 `!!js`；禁用 SPA 后所需 API 仍挂载、鉴权有效。 |
| 必须 | `runtime/prepare-module-fallback.ts`、`module-fallback-recovery.ts`、`fallback-package-catalog.ts`、`profile-scope-prune.ts` | 新版官方使用运行时 profile resolution。先让官方负责模块解析与管理自有旧链接，收缩扩展扫描、移动、修补和清理 `node_modules` 的逻辑。 | 旧 profile、第三方插件、共享目录、路径含空格和 Windows junction 场景可启动；不破坏用户包，不制造不同版本服务实例。 |
| 必须 | `gateway/node-gateway-client.ts`、`gateway/domain-api.ts`、`gateway/gateway-wire.ts`、`gateway/remote-event-protocol.ts` | 核对新版 Typert Remote 的方法、参数名称、取消、事件及错误形状；评估直接复用官方 Remote/Journal/Snapshot stream 实现。官方浏览器 transport 用到浏览器 WebSocket/页面位置，不能未经适配直接塞进 Extension Host。 | 带 cookie 的 Node transport 正常；流重连、分页基线、去重、取消和业务错误与官方一致。 |
| 必须 | `gateway/harness-gateway-service.ts`、`assistant-stream-state.ts`、`pending-queue.ts`、`pending-interactions.ts` | 对接 SessionAddress、follow/control 和多实例 Session 契约；主会话和子会话按官方地址订阅。已有队列/审批调用继续由官方处理，清理被官方状态覆盖的本地补偿。 | 运行中切换任务、双 Webview、后台完成通知、断线恢复、Steer/Stop、审批不会串会话或重复提交。 |
| 必须 | `runtime/shared-history/*`、`runtime/harness-home.ts`、历史 smoke tests | 按官方 SessionHandle、persistence 和 SessionQuery 适配迁移。当前 `migration.ts:131` 仍有 `fork.snapshotEvents()`；新版只是弃用，尚未删除，不能把它误报成确定的编译失败。迁移到官方观察/读取接口前须确认 fork 的观察与持久化时机。 | V2/V3、压缩/非压缩、fork lineage、被其他实例占用、附件引用、迁移中断重试和原件保留均验证。V3 相同不等于所有记录和读写行为相同。 |
| 必须 | `services/connection-settings-service.ts`、`services/connection-settings/mapping.ts`、`services/connection-settings/migrations.ts`、`domain/provider.ts` | 官方 provider 遵循 `llm-deepseek` 默认 `protocol: messages` 及 `/anthropic` 根地址；优先取消扩展以前写入的旧官方根地址覆盖，让官方选择默认值。自定义 provider 保留其显式协议和 URL，不批量转换为 Messages。 | 原官方凭据仍可用；旧官方设置可迁移；OpenAI-compatible/Anthropic 自定义源、空 key 和有 key 的新增/编辑均正常。 |
| 必须 | `config/configuration.ts`、`domain/options.ts`、`model-capacity.ts`、`model-modalities.ts`、`model-profile.ts`、composer | 从官方 catalog、resolved model、contextPressure 读取模型名、输入能力、上下文、输出与推理档位；停止把本地容量表和名称猜测作为权威。新的默认值遵循 `deepseek-flash`；旧用户显式选择不能因为目录移除就无提示重写。 | 当前模型真实 contextPressure 不被 UI 候选值覆盖；新模型可选；显式自定义能力保留；未知模型不被猜成支持视觉。 |
| 必须 | `runtime/runtime-overlay.ts`、设置与隐私说明 | 显式关闭 `session-log-deepseek.config.enabled` 和 `plugin-package-inventory-deepseek.config.enabled`，默认不增加请求附带数据；继续保留 OTel 禁用。若提供开关，应说明附带字段和范围。 | 用合成消息拦截出站请求，默认没有 `dsh_session_log`、`dsh_plugin_packages`；密钥不进入 Webview/日志；升级前后的额外数据发送范围不扩大。 |

### 隐私配置为什么必须单独处理

上游 `session-log-deepseek` 默认 `enabled: true`，会生成 `dsh_session_log`，包含会话头信息和事件增量；头信息可含 `cwd`。`plugin-package-inventory-deepseek` 也默认开启，生成 `dsh_plugin_packages`，内容是活动插件的包名和版本。

`app-boot/src/profile-context.ts` 的 `resolveTelemetryPatch()` 只禁用 `session-telemetry-otel` 行。因此当前扩展的 `DSH_TELEMETRY_DISABLED=1` 不能替代这两个配置。这是源码确认的独立开关，不仅是 release notes 推测。

## 二、已有功能改由官方接管

| 当前扩展实现 | 官方能力/契约 | 本次处理 | 保留条件 |
| --- | --- | --- | --- |
| `ArchiveState.restore()` 把恢复 ID 写入 `sessionArchive.restoredIds`，仅本地覆盖归档状态 | `workspace/unarchiveSession({ sessionId })`、`workspace/follow` | **确定替换。** 老恢复 ID 一次性逐项同步到官方；收到成功和权威快照后移除对应旧 ID，失败保留并可重试。 | 列表 UI、过滤和滚动位置保留；不再长期维护两套归档事实。 |
| `DshPluginManager` 读取 profile manifest、停止 runtime 后跑 CLI/pnpm；Super Injector 默认种子安装 | `pluginManager/listPlugins`、`listBundles`、`inspect`、`installBundle`、`cancelInstall`、`setPluginEnabled`、`setBundleEnabled`、`removeBundle`；安装进度、changed 事件 | **确定替换普通插件管理。** 安装状态、依赖、启停、卸载、只读原因、重启要求以官方结果为准；设置通过官方配置控制面。停止把 Injector 当成普通插件管理的必需前置。 | 市场搜索、分类/翻译、VS Code 展示可保留；官方未覆盖的 Routing Suite 预设安装和第三方插件保留，单独验证兼容，不擅自卸载。 |
| 从 `tool/call` / `tool/result` 推导改动文件、增删行和每轮卡片 | `workspace/changes` 事件，`/api/changes.summary`、`/api/changes.diff`，`dsh-workspace-changes` | **新回合优先官方。** 用官方摘要/比较数据渲染卡片与逐文件审阅，覆盖 shell 等非编辑工具造成的变化。 | **不能全部删除旧历史投影。** 官方摘要和 diff 只保留到 Session disposed；重启或从未记录该回合的 Host 返回 404。旧日志用现有工具事件作有限统计并注明缺少完整 diff；不拿当前工作区差异冒充历史。 |
| 自定义模型容量大表、视觉命名规则、固定模型与推理枚举 | 官方 model catalog / resolved model / `inputModalities` / `contextPressure`；自定义模型声明 | **确定改权威来源。** 用户显式覆盖写进官方 profile，由运行时统一解析，再回显；本地表最多作为经验证的缺失值兼容，不能覆盖官方或用户设置。 | Auto 模型选择/Auto effort 的产品策略暂留，因为未确认存在等价官方选型策略；其输入改读官方能力。 |
| 文件正文拼接、图片处理、文件引用和“交付文件”展示 | 官方附件/PromptContentPart、文件提交与资源地址、`tool-present`、`workspaceFiles`、Files API | 接入官方持久附件和交付语义，支持任意文件；Host 保管附件引用与实际路径，避免私造 provider payload、上传缓存与图片复用机制。 | 未保存编辑器选区、文件 ID 校验、剪贴板入口、VS Code URI/编辑器跳转继续由扩展负责。 |
| 自定义会话标题、排序和 pin/tags 等本地元数据 | 官方标题事件、workspace 顺序操作及会话状态 | 标题和官方已有的顺序尽量接管；梳理本地自动标题是否会抢写官方结果。迁移必须保留手动重命名和用户顺序。 | pin/tags/Auto intent 只有确认对应持久化字段后迁移；未覆盖的展示偏好保留本地。 |
| 子代理列表与续聊操作、自定义消息可视化 | 官方 subagent 与 SessionAddress、队列、运行和投影契约 | 同步新版参数、取消和父子会话边界；可独立复用的解析/状态模块优先复用。 | Webview 消息布局、滚动锚定、VS Code 主题、中文文案与动画继续保留，不把官方 Sidebar slot 当作 VS Code slot。 |
| 自有跨版本共享历史迁移、格式恢复和插件导入桥 | 官方 Session persistence、格式转换、SessionQuery、session 导出 | 格式解码、版本迁移、fork 和锁使用官方实现；扩展只保留数据目录选择、冲突编排和平台交互。 | 多根旧历史合并没有确认到等价官方入口；`dsh-chat-import` 的跨产品导入也不能仅因 DSH 新版就删除。 |
| 模块 fallback 和 profile 包修复 | 官方 runtime profile resolution、legacy link 识别 | 以官方 resolver 为主，验证后撤销重复修复路径。 | 只有旧 VSIX 遗留文件的可复现问题仍需要扩展处理时，保留有备份、范围明确的一次性迁移。 |

## 三、新版新增能力与 VS Code 的落点

| 新能力 | 本次接入方式 | 限制/边界 |
| --- | --- | --- |
| MCP 资源发现、读取和 URI 模板 | 使用官方 `dsh-mcp-resources` 与工具/资源契约，不另写 MCP 客户端；补资源结果和引用的 UI 支持。 | MCP 的 HTTP/stdio、分页、授权由官方处理。 |
| Office/PDF/HTML/图片预览、文件交付、计划预览 | 复用官方文件和资源语义；评估可打包的预览器，代码文件优先 VS Code 原生打开，其他格式使用受控 Webview/原生可用能力。 | 不能为了复用预览器放开整个 Webview CSP；不能承诺仅升级依赖就自动出现官方 Sidebar UI。 |
| 会话终端、多标签、恢复 | 需要会话终端时采用 `terminal` 官方服务；展示可接 VS Code Terminal/Pseudoterminal，评估终端保留和重连契约。 | 用户终端是系统用户权限，必须与 Agent 的沙箱工具区分。缺少会话级入口时，原生 VS Code 终端可继续保留，但不能声称具有官方会话终端恢复语义。 |
| SSH 工作区 | 官方远端执行走 DSH SSH/文件系统协议；VS Code Remote 则保留 Extension Host 路径与 URI 适配。 | 两种远端模式不是同一层；不能把本机路径直接当远端路径。 |
| Browser Use、Computer Use、Auto review 等实验能力 | 通过官方插件/配置显式启用，先做可选兼容，默认不扩大现有能力。 | 不能因升级自动开启新的浏览器/桌面访问。 |

明确继续保留：VS Code Webview 宿主、编辑器选区/未保存内容、工作区安全跳转、原生通知、主题与布局、平台打包、Git worktree 创建/审阅/合并/恢复等。此次源码核查未确认 DSH 有与扩展 worktree 工作流等价的实现。

## 四、实施顺序

1. **基础运行与隐私**：隔离升级分支，更新依赖和锁文件；解决补丁、overlay、默认协议、模型、profile resolver 和独立隐私开关；先让空数据目录中的 Gateway 正常工作。
2. **会话和数据兼容**：迁移老数据副本；适配 Session/投影/事件/队列；验证共享历史、旧 provider 凭据、附件与插件配置。
3. **替换重复业务**：归档恢复 → 插件管理 → 模型能力 → 文件改动/交付 → 可复用官方流管理；每替换一项，用官方结果验证后再撤掉旧入口。
4. **新增 UI 与发行**：资源/预览/终端等入口，更新英文/中文说明与架构文档，完成平台 VSIX smoke。不要只跑单元测试便宣布升级完成。

## 五、发布前验收

- 新用户：无历史、无凭据启动；配置官方/自定义/本地空 key 服务；首次流式请求、图片和文件请求可用。
- 旧用户：旧 provider 的 API key 保留，空输入编辑不会覆盖已有 key；更换协议/地址不会误复用不相关凭据；官方旧地址迁移不改第三方地址。
- 历史：旧版本全部会话可列出、续聊、分叉、导出；原日志和附件不丢失；被锁定会话不抢占；迁移失败/重跑可恢复。
- UI 并发：流式运行中切换会话、双视图、后台任务结束通知、断线重连、运行计时和滚动展开都验证。
- 官方一致性：扩展恢复归档后官方也恢复；插件启停、模型能力和队列状态与官方一致；不会再次被本地状态覆盖。
- 变更卡片：新回合读官方摘要和 diff；旧历史与重启后数据不可用时明确降级；不把工具调用次数或当前 git diff 当作官方历史。
- 隐私：合成数据出站断言没有新增日志/插件清单字段；日志与 Webview 不含密钥；模型 YAML 注入回归；回环 Gateway 与外部代理分别验证。
- 工具链：类型检查、必要单测、官方运行时 smoke、安装/更新/重启测试；Windows/macOS/Linux 对应可用平台的 Node、PTY、shell、沙箱和 VSIX 验证。

## 核查来源

- [npm DSH 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)：dist-tags 和版本依赖。
- [0.1.6-alpha.2 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)。
- [workspace/unarchiveSession](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/workspace-controller/src/index.ts#L118)。
- [PluginManager 官方实现](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/plugin-manager/src/index.ts)。
- [文件改动摘要与存活期](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/deliverables/workspace-changes/src/types.ts)、[HTTP 路由](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-deliverables/src/changes.ts)。
- [官方 Session transport](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/session-controller/src/client/transport.ts)。
- [DeepSeek 协议和地址配置](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/llm-deepseek/src/config.ts)。
- [会话日志请求扩展](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-log-deepseek/src/index.ts)、[插件清单请求扩展](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/plugin-package-inventory-deepseek/src/index.ts)、[OTel 禁用范围](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/app-boot/src/profile-context.ts)。
- [新版投影缓存 schema](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-projection-cache/src/spec.ts)、[运行时包解析](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/app-boot/src/profile-resolution/service.ts)。
