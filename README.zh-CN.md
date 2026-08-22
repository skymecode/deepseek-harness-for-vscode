# DeepSeek Harness for VS Code

[English](README.md) | **简体中文**

在 VS Code 中原生运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI 编码助手扩展。无需克隆上游仓库、安装 Node/npm 或手动部署 Harness；安装匹配平台的 VSIX 即可使用。

> 当前为社区开发版本 `0.4.8`。DeepSeek Harness 仍处于 Developer Preview，本扩展固定使用官方 npm 包 `@deepseek-ai/dsh@0.1.1-rc.2`。

## 功能

- **原生 VS Code 工作台**：全部交互都在侧边栏完成；本地 Harness Gateway 只开放回环 API 传输，不再提供或嵌入官方 WebUI。
- **可分离工作台**：可在编辑器区打开同步的对话面板，需要更大空间时可将其移到另一个 VS Code 窗口。
- **完整会话管理**：持久化历史、新建、切换、重命名、分支、归档/恢复、导出，以及导入官方 DSH 会话 ZIP、ChatGPT 导出 ZIP 和其他 Agent 会话（通过 `dsh-chat-import`）。
- **Markdown 流式回复**：支持标题、列表、表格、代码块、一键复制、安全外链及可点击跳转的工作区文件引用。
- **稳定增量渲染**：流式更新保留推理/工具卡展开状态和用户滚动位置。
- **Claude 风格实时推理**：推理分片到达时自动展开并跟随最新内容，reasoning block 完成后自动收起。
- **编辑器上下文**：选中代码会显示为可移除的上下文卡片；在输入框键入 `@` 可模糊检索并附加工作区文件。
- **斜杠命令**：支持 Harness 官方命令及 `/model`、`/reasoning`、`/preset` 扩展命令。
- **Harness 原生能力**：推理过程、工具调用、审批、结构化问题、Todo、Skills、Goal、Plan 和后台任务。
- **模型与 Agent 设置**：DeepSeek V4 Flash / Pro、`off` / `low` / `high` / `max` 推理等级和四种官方 Agent Preset。
- **Token 用量**：在输入区显示当前会话输入和输出 Token。
- **原生 DSH 插件中心**：搜索精选目录、按分类筛选、查看已安装插件，或安装 npm/GitHub/本地/tarball 插件包。
- **自动本地化**：根据 VS Code 显示语言自动切换英文或简体中文。
- **免部署运行时**：官方 `dsh`、pnpm 和独立 Node 22.22.3 随平台 VSIX 分发，生命周期由扩展管理。

快捷键：Windows/Linux 使用 `Ctrl+Alt+H`，macOS 使用 `Cmd+Alt+H` 打开工作台。

## 界面预览

界面会自动跟随 VS Code 显示语言。点击缩略图可查看原始分辨率截图。

<table>
  <tr>
    <td align="center" width="58%">
      <a href="docs/images/workbench-preview.png">
        <img src="docs/images/workbench-preview.png" alt="DeepSeek Harness 原生 VS Code 工作台" width="460">
      </a>
    </td>
    <td align="center" width="42%">
      <a href="docs/images/model-and-effort.png">
        <img src="docs/images/model-and-effort.png" alt="模型、DSH 模式与推理等级设置" width="300">
      </a>
    </td>
  </tr>
  <tr>
    <td align="center"><sub>原生对话工作台 —— 流式回复、工具调用，输入框固定在底部</sub></td>
    <td align="center"><sub>模型、DSH 模式与推理等级</sub></td>
  </tr>
</table>

## 安装

1. 从 [Releases](https://github.com/skymecode/deepseek-harness-for-vscode/releases) 下载与你的平台匹配的 VSIX。
2. 打开 VS Code 扩展面板（`Cmd/Ctrl+Shift+X`）。
3. 点击右上角 `...` → **从 VSIX 安装...**，选择下载的文件。
4. 按提示重新加载 VS Code 窗口。

例如，Apple Silicon Mac 应选择 `darwin-arm64` 包。

## 快速开始

1. 打开要开发的代码项目。
2. 点击 Activity Bar 中的 **DeepSeek Harness** 图标。
3. 打开“连接设置”，配置 DeepSeek 官方来源或添加中转来源；也可以运行 `DeepSeek Harness: 设置 API Key` 为官方来源保存密钥。
4. 在输入框描述任务并发送。

无需执行任何 Harness 安装或启动命令。

## DSH 插件

点击工作台标题栏的 **⊞ 插件**，可以直接浏览 [`dsh-plugin` GitHub Topic](https://github.com/topics/dsh-plugin) 中的仓库。市场结果还会合并 [Awesome DSH Plugin](https://awesome-dsh-plugin.com/) 的精选分类、中文介绍和 npm 安装参数。在“已安装”页可直接输入 npm 包、`github:owner/repository`、不含 shell 元字符的本地路径或 tarball URL。

<p align="center">
  <a href="docs/images/plugin-marketplace.png">
    <img src="docs/images/plugin-marketplace.png" alt="原生 DSH 插件市场" width="500">
  </a>
  <br>
  <sub>插件发现、兼容性标识与受控安装</sub>
</p>

扩展严格使用官方 `dsh plugin --profile web add/remove` 流程。插件配置保存在扩展的 `globalStorageUri/harness-home/profiles/web`；pnpm 修改配置期间 Harness 会安全停止，完成后自动重启。pnpm 已随 VSIX 内置，无需安装系统包管理器。

插件提供的宿主工具、策略和运行时服务可以在本扩展中工作。部分插件还包含专门面向上游 DSH 浏览器应用的客户端 UI，这些界面无法由原生 VS Code 工作台通用渲染，因此会标记为 **官方 Web UI**。

市场卡片会把已知插件标记为 **Agent 功能兼容**、**Agent 功能可用 · Web UI 不可用** 或 **仅官方 Web UI**。纯主题、布局等 UI 插件不能改变原生工作台，因此安装按钮会被禁用；只有 GitHub 元数据、尚未进入精选目录的仓库会标记为 **兼容性未知**。

## 配置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `deepseekHarness.model` | `deepseek-v4-flash` | 新会话默认模型 |
| `deepseekHarness.reasoningEffort` | `high` | `off` / `low` / `high` / `max` |
| `deepseekHarness.agentPreset` | `standard` | 新会话默认 Agent Preset |
| `deepseekHarness.provider` | `deepseek-official` | 在扩展“连接设置”面板中选择的默认来源 |
| `deepseekHarness.permissionMode` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `deepseekHarness.autoAttachSelection` | `true` | 发送时自动附加当前编辑器选区 |

提供商端点与只写凭据引用统一交给内置 Harness 设置/凭据服务管理。API Key 保存在扩展私有的 Harness Home 中，不会回传给 Webview，也不会写入项目 `.vscode/settings.json`。旧版 `deepseekHarness.apiKey`、`baseUrl` 和 `providers` 会在首次连接时迁移并清除。

可在“连接设置”面板中新增、编辑、测试或移除 DeepSeek 中转来源。自定义来源通过上游 `llm-pi-ai` 适配器实时注册，并在模型面板中提供相同的 Flash/Pro 选择。

自动附加的选区最长为 16 KB，超出部分会截断。手动附加同一文件选区后，宿主不会再次自动附加。

## 命令

| 命令 | 说明 |
|---|---|
| `DeepSeek Harness: 打开工作台` | 打开侧边栏工作台 |
| `DeepSeek Harness: 在新窗口打开工作台` | 打开可分离的编辑器区工作台 |
| `DeepSeek Harness: 重新加载工作台` | 重启运行时并重新连接 |
| `DeepSeek Harness: 设置 API Key` | 保存 API Key |
| `DeepSeek Harness: 清除 API Key` | 清除 API Key |
| `DeepSeek Harness: 显示日志` | 打开诊断日志 |
| `DeepSeek Harness: 导入会话` | 导入 DSH ZIP、ChatGPT ZIP 或其他 Agent 会话 |

## 语言

扩展默认语言为英文，并提供简体中文语言包。命令、设置说明、宿主弹窗和对话工作台都会跟随 VS Code 的显示语言。修改显示语言后执行 **Developer: Reload Window** 即可生效。

## 安全与隐私

- Harness Gateway 只监听 `127.0.0.1` 随机端口。
- Webview 使用严格 CSP，不加载远程脚本或 iframe。
- 插件目录 JSON 由 Extension Host 获取并投影为严格校验的 UI 数据，文字统一通过 `textContent` 渲染。
- Markdown 原始 HTML 默认禁用，渲染结果经过 DOMPurify 白名单净化。
- Markdown 远程图片默认禁用；http(s) 外链会先经扩展宿主校验。
- 文件和命令访问由 `permissionMode` 与 Harness 审批策略控制。
- API Key 不发送给 Webview，也不会写入扩展日志。
- 第三方 DSH 插件属于受信任的 Extension Host 依赖，会在 Agent 沙箱之外运行；安装前请检查源码。

## 平台支持

扩展 ID 和 Marketplace 产品始终只有一个，但由于内置 Node、PTY 和 sandbox 包含原生二进制，需要分别构建平台 VSIX：

- macOS：`darwin-arm64`、`darwin-x64`
- Linux：`linux-arm64`、`linux-x64`
- Windows：`win32-arm64`、`win32-x64`

当前 GitHub Actions 托管矩阵覆盖 `darwin-arm64`、`linux-arm64`、`linux-x64` 和 `win32-x64`。其他架构需要自托管 runner 或本机打包。

## 开发与打包

```sh
npm install
npm run check-types
npm run lint
npm test
npm run compile
npm run package
```

`npm run package` 会根据当前操作系统和 CPU 架构生成对应 VSIX。`npm ci` 会执行原生依赖所需的生命周期脚本，因此请只在可信提交和锁文件上构建。

项目提交信息统一使用英文。架构与安全边界详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 许可证

扩展代码采用 [MIT License](LICENSE)。DeepSeek Harness、Node.js 和其他依赖的许可信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 及各依赖附带的许可证文件。
