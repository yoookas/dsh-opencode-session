# dsh-opencode-session

DeepSeek Harness 插件：**一个会话发出的模型请求，自动带上同一个 `x-opencode-session` 请求头**，用于适配 OpenCode Go / Zen 网关的按会话路由与提示缓存要求。

在 `dsh` 里启用后默认即可用，也可以在**设置页**里改配置、改完立即生效：

- **同一会话固定**：同一对话的多轮请求、续聊、压缩、重试都用同一个值；
- **不同会话不同**：新对话、分支、子代理各有自己的会话 id，互不干扰；
- **重启不变**：值直接复用会话自身的持久 id（`session-<uuid>`），插件不保存额外状态；
- **只影响 OpenCode 地址**：默认只命中 `opencode.ai` 及其子域，其他提供方与旁路请求原样放行；
- **不重复注入**：请求里已经有同名头时默认不覆盖，可与新版 pi-ai 自带的注入共存；
- **设置页即时生效**：保存后 Loader 重新装载该行，**不需要重启 dsh**。

## 兼容版本

在 DSH **0.2.2-rc.5** 上验证通过（宿主设置接口、`llm/stream` 监听、浏览器模块挂载都正常），所用的接口在 0.2.1 → 0.2.2 的升级指南里没有破坏性变更。

按 0.2.2 的显示规范，插件在 **Plugin Manager 的详情页**里带一张功能示意图（[`docs/DETAIL.md`](docs/DETAIL.md) / [`docs/DETAIL.zh.md`](docs/DETAIL.zh.md) + [`docs/preview.svg`](docs/preview.svg)）；详情页在插件未启用时也可查看。

## 一个包，两半

| 半边 | 作用 |
| --- | --- |
| `lib/`（宿主） | 会话识别、`llm/stream` 监听、`fetch` 注入，以及设置页读写的 HTTP 接口 |
| `client.js`（浏览器） | 设置面板里的「OpenCode 会话头」小节与配置表单 |

两半在同一个包里，靠 `package.json` 的 `dsh.client` 声明和 `./client` 导出连接；`index.js` 一行 Loader 同时挂起宿主插件与浏览器模块。

> 包名从早期的 `dsh-x-opencode-session` 改成了 `dsh-opencode-session`：`dsh-client-modules` 会把「某个 Loader 入口不是客户端包」的结论按 `baseUrl\0loaderName` 缓存到进程结束，早期纯宿主包的结论被缓存了；换一个新的入口名，浏览器端才能在**不重启 dsh** 的情况下被扫描到。设置页的行 id 仍是 `x-opencode-session`，旧的 profile 覆盖配置继续有效。

## 工作原理

请求头必须出现在真正的出站 HTTP 上，而适配器的 `GenerateOptions` 没有可写请求头的注入点，所以宿主插件分三层工作：

1. **`llm/stream` 瀑布监听**：从请求自带的 `options.sessionId` 取本会话 id，用 `AsyncLocalStorage` 把 id 包进下游流的每次迭代，该流内部后续的全部 `await`（包括发出 HTTP 的 `fetch`）都继承这个上下文。
2. **全局 `fetch` 补丁**：只对命中 `hosts` 的 URL 附加请求头；已经存在同名头时默认跳过；值不合法（含控制字符）时按未命中处理，绝不阻断请求；卸载插件时恢复原始 `fetch`。
3. **环境兜底**：没有 `sessionId` 的辅助请求，退回 `ctx.agents.currentInitiator()` 的会话 id，让它们在同一会话里也带上相同的值。

设置页的写路径是 `configEditor.edit()`：把配置写进 profile 的 `cordis.patch.yml`，再由 Loader 重新装载这一行 —— 这就是「保存即生效、不用重启」的来源。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-x-opencode-session
```

或在 Harness 的 **Plugin Manager** 里用 `install_bundle` 安装本目录（包的 `name` 是 `dsh-opencode-session`，目录名不影响安装）。

装好后**刷新一次浏览器页面**即可看到设置页；之后改配置都不用刷新、也不用重启。只有插件代码本身更新时，才需要刷新页面重新加载浏览器模块。

卸载：

```sh
dsh plugin --profile web remove dsh-opencode-session
```

## 设置页

打开 **设置 → 左侧「OpenCode 会话头」**，每个配置项都有标题和一段说明：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 生效主机 | `opencode.ai` | 只有发往这些主机的请求才附加请求头；子域自动包含（`opencode.ai` 命中 `go.opencode.ai`）。每行一个或用逗号分隔，`*` 表示所有主机；走自建 OpenCode 中转时把中转域名加进来。 |
| 请求头名称 | `x-opencode-session` | OpenCode 网关按这个名字识别会话，一般不用改。 |
| 取值方式 | 会话 id | `会话 id`：原样发送 `session-<uuid>`；`裸 UUID`：去掉 `session-` 前缀。 |
| 覆盖已有的同名头 | 关 | 关闭时保留请求里已有的同名头（与新版 pi-ai 自带的注入共存）；打开时一律用当前会话的值替换，可修正 profile 里写死的静态值。 |
| 调试日志 | 关 | 打开后每次注入写一条 debug 日志，插件启动时也会在控制台打一行，便于确认是否命中。 |

页面底部还有「保存并立即生效」「填入默认值」，以及当前生效状态和配置写入位置。

## 命令行配置

不经过设置页也可以，默认值写在 `cordis.patch.yml` 里；需要改时，在你自己的 profile 补丁层按行 id 覆盖：

```yaml
- id: x-opencode-session
  config:
    hosts: ["opencode.ai", "gw.example.com"]
    override: true
```

## 验证

1. 用 OpenCode Go / Zen 的模型发起对话；
2. 抓包或看网关日志，确认请求带 `x-opencode-session`；
3. 同一对话多次请求值一致；新开对话值不同；重启后再发消息值仍与之前一致。

把 `debug` 设为 `true` 时，插件挂载会在控制台打一行 `[x-opencode-session] 已启用：…`，方便确认它确实被加载。

本地自测：

```sh
node --test test/
```

测试用本地 HTTP 服务模拟网关，直接驱动真实插件代码，覆盖：主机匹配、取值模式、同会话稳定性、无会话不注入、非命中主机不注入、已有头不覆盖 / `override` 覆盖、`llm/stream` 瀑布下的端到端注入、设置页输入校验，以及浏览器端模块的注册（假 React + 假 ctx）。

已用真实 Host 进程做过端到端验证（headless profile + 本地 mock 网关）：

| 场景 | 结果 |
| --- | --- |
| 同一会话的两次模型请求（对话 + 会话标题） | 同一个 `x-opencode-session` 值 |
| 另起一个新会话 | 不同的值 |
| 进程重启后 `--session-id` 续聊同一会话 | 仍与重启前一致 |
| 设置页保存配置（运行中的 web 服务） | 立即重新装载，控制台出现新的 `已启用：…` 行；改回默认后补丁层自动清空 |
| 单包安装后浏览器模块 | 启动清单里出现 `dsh-opencode-session/client.js`，模块可正常下发 |
| 0.2.2-rc.5 上重新装载插件 | 设置接口仍 200（`hosts: ["*"]` 保留），浏览器模块仍在启动清单里 |
| 0.2.2-rc.5 详情文档解析（宿主同一套代码） | `zh` → `docs/DETAIL.zh.md`，`en` → `docs/DETAIL.md`，`ja` 回退到英文；预览图都解析为 `docs/preview.svg`（`image/svg+xml`） |

## License

MIT
