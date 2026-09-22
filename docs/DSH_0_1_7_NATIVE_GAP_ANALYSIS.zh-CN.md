# DSH 0.1.7 原生能力差距清单

基线是 `@deepseek-ai/dsh@0.1.7-alpha.1`，对应上游发布 `dsh-v0.1.7-alpha.1`。核对日期：2026-09-23。核对时 npm 没有 `0.1.7` 正式包，因此不能把不存在的版本写入依赖；锁文件中的 DSH 家族包已统一到 `0.1.7-alpha.1`。

## 已接入

| 能力 | 接入方式 | 扩展仍保留的部分 |
| --- | --- | --- |
| 会话置顶 | `workspace/pinSession`、`workspace/unpinSession`、`workspace/follow` 的 `pinnedSessionIds` | 标签编辑和 VS Code 历史筛选仍是工作台偏好 |
| 后台任务列表与实时输出 | `job/list`、`job/follow`，按当前会话重连并更新任务状态、进度；输出按原生字节游标续接，折叠后停止订阅 | VS Code 详情面板的布局与输出保留上限 |
| 停止后台任务 | 详情面板调用原生 `job/kill` | 错误提示和按钮状态 |
| 运行中归档确认 | 捕获 `workspace/session-active`，逐项显示活动回合、子代理、任务和提醒，确认后以 `stopActivity: true` 重试 | 用户取消时不停止工作 |
| 会话归档/恢复 | `workspace/archiveSession`、`workspace/unarchiveSession`、`workspace/follow` | 侧栏分组、搜索和滚动行为 |
| Schedule 展示 | 读取原生 `schedule` projection，以紧凑卡片显示提醒（需用户的 Profile 已启用 Schedule） | 创建/删除仍由 DSH 的 Schedule 工具负责 |
| Agent Preset、模型、设置、凭据、目标、Skills、Plan | 已使用对应 Typert Remote 或官方投影 | VS Code 原生控件与本地工作区策略 |

## 可以直接复用、但当前还缺少的功能

| 优先级 | 原生能力 | 当前状态 | 建议 |
| --- | --- | --- | --- |
| P1 | Workspace 原生筛选、顺序和搜索恢复 | 搜索中同时展示普通和归档匹配，按条目显示归档/恢复；列表已采用原生置顶和 Workspace 顺序，没有手动排序控件 | 使用 `workspace/follow` 的顺序与 pin/archived 集合；补齐会话顺序操作 |
| P1 | Work Details、Performance and Usage、Developer Tools 设置 | 当前有运行环境、Token 和统计展示，但没有这些官方设置的切换项 | 读取 `settings/describe` 的官方字段，保留 VS Code 主题下的轻量设置面板 |
| P1 | 会话终端 | `terminal/*` 原生 Remote 已随 0.1.7 提供，扩展仍只使用 VS Code 终端 | 先接 `terminal/list/create/follow/write/resize/close`，再映射到 VS Code Pseudoterminal；明确其系统用户权限不等于 Agent 沙箱权限 |
| P1 | 文件和 Office 预览 | 当前可打开文本文件与 diff，没有原生 DSH 的 Office/电子表格/PDF 预览 | 通过 `session/openWorkspacePath` 或官方文件服务验证路径，再交给 VS Code 或关联应用；不要在 Webview 自己解析 Office |
| P1 | Schedule 创建/删除入口 | 工作台已展示原生 Schedule projection，但没有独立创建/删除控件 | 继续让 Agent 使用 `schedule_create/list/delete`；如增加控件，应复用 Host command/tool 契约 |
| P2 | 内置浏览器选择 | 当前所有链接交给 VS Code/系统外部浏览器 | 原生工作台可增加“内置浏览器/新标签”偏好；没有 WebView 容器时不要伪装成官方浏览器 |
| P2 | 实验性语音转写 | `@deepseek-ai/dsh-experimental-voice-input-bundle` 是可选插件，当前 Profile 未启用 | 先通过官方插件管理器安装和下载模型，再决定录音权限、跨平台实现和失败恢复 |
| P2 | 反馈入口、默认工作区/空白会话、Agent 模式说明 | 上游 Web UI 已有；VS Code 工作台尚未提供 | 分别映射到 VS Code 命令、首次启动流程和 Preset 说明卡，不复制官方 Web UI 的 Slot |

## 不应替换成原生 DSH 的部分

编辑器选区、`@` 文件检索、VS Code URI 跳转、工作树隔离与合并、系统通知、插件市场目录本地化，以及窄侧栏的响应式交互都依赖 VS Code 宿主。它们没有与 DSH Web UI 一一对应的可复用界面，应继续由扩展负责；只复用底层 Remote、投影和设置契约。

上游完整变更见 [DSH 0.1.7-alpha.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1)。

## 合入前验证

本地 macOS arm64：类型检查、lint（仅已有规模告警）、完整 Vitest 与真实 DSH 运行时冒烟测试、平台 VSIX 打包。运行时使用临时 Home 和本地模拟模型，验证升级后的协议、旧 `code` 模式兼容、原生置顶/任务列表、归档恢复、附件、历史迁移和插件管理。Windows/Linux 的构建与运行时验证由仓库的多平台构建工作流执行，不能用 macOS 结果替代。
