<!--
本文件是 pi 在本仓库的项目上下文入口。
pi 的资源加载器在同目录发现 AGENTS.override.md 时会加载它并【忽略】AGENTS.md
（见 @earendil-works/pi-coding-agent dist/core/resource-loader.js 的 loadContextFileFromDir）。

仓库根的 AGENTS.md 保持与上游 agegr/pi-web 逐字一致 —— 因此它永不产生合并冲突，
但它也不再进入本仓库的上下文。上游新增/修改的规则需要手动并入本文件：

  git fetch upstream
  git diff HEAD upstream/main -- AGENTS.md   # 看上游新增了哪些规则
  git checkout upstream/main -- AGENTS.md    # 对齐后再继续同步规则

原则：只保留不可推导的内容（安全边界、会静默损坏状态的不变量、反直觉命令）。
能从代码/类型/ADR 查到的一律不留，背景叙述放进 docs/adr/。
-->

# Pi Web — Dev Notes

## 构建与部署（本机）
- 30141 = PM2 进程 `pi-web`（`~/.pm2/ecosystem.config.cjs` → `bin/pi-web.js`，cwd 本仓库），不是 `next dev`。
- 改完应用代码（含 `git restore/checkout/reset/revert` 还原应用代码）必须自己跑 `npm run build && pm2 restart pi-web` 再收工；30141 有监听不代表不用构建。
- 仅本地迭代时：`npm run dev` 与 PM2 冲突（先停 `pi-web`），且 `next dev` 运行期间绝不能 `npm run build`；Turbopack only；第二个 `next dev` 会抢 `.next/dev/lock`，复用已有的健康监听即可。
- 检查：`node_modules/.bin/tsc --noEmit`、`npm run lint`。

## 架构
浏览会话是只读的（SDK `SessionManager` + `lib/session-reader.ts`，无 `AgentSession`）；发消息走 `startRpcSession()`（`lib/rpc-manager.ts`）创建进程内 `AgentSession`。SSE：`GET /api/agent/[id]/events`。
关键文件：`lib/rpc-manager.ts`、`lib/session-reader.ts`、`lib/normalize.ts`、`lib/path-security.ts`、`lib/worktree.ts`、`lib/model-scope.ts`、`hooks/useAgentSession.ts`。

## 陷阱
- **AgentSession 生命周期**：每个 session id 一个 wrapper，存在 `globalThis.__piSessions`（模块级 `Map` 会被热重载清掉）；10 分钟空闲超时；并发启动共享 `globalThis.__piStartLocks`。
- **Fork 必须立刻销毁 wrapper**：`fork()` 原地改内部状态，`inner.sessionId` 变成新 id；`send("fork")` 要先取 `newSessionId` 再 `this.destroy()`，否则后续 fork / `parentSession` 会串。
- **两种分支别混**：fork（用户消息上的 "New session"）= 新 `.jsonl` + 侧栏 `parentSession` 子节点；会话内分支（"Edit from here" / BranchNavigator）= 同文件 `navigate_tree`，用 `/api/sessions/[id]/context?leafId=` 切换。
- **会话文件整文件重写是安全的**：`parentSession` 只是展示元数据（删除时级联重挂子节点就靠它）。
- **ToolCall 字段归一**：文件 `{type:"toolCall",id,name,arguments}` → UI `{toolCallId,toolName,input}`，统一走 `normalizeToolCalls()`（`lib/normalize.ts`），加载和流式两处都用。
- **工具预设**（`POST /api/agent/new` 的 `toolNames[]`，键 `pi-web:tool-selection`）：无记录 = Pi 默认；空数组 = Chat only（不加载 extensions/skills/prompts/themes，改用 context 文件拼 prompt）；进出 Chat-only 会重建 wrapper，其他预设变化原地更新。子代理快照 tools + skill/extension 开关；`Agent`/`get_subagent_result`/`steer_subagent` 为保留名。`localStorage` 预设只初始化全新 composer。见 ADR 0002。
- **模型默认值**：`GET /api/models` 的 `defaultModel` 来自 `~/.pi/agent/settings.json`；浏览器显式 model/thinking 在构造时原子应用，由 `lib/startup-preferences.ts` 持久化（绝不回放 `set_model`/`set_thinking_level`），隐式 fallback 和 thinking pin 不持久化。`enabledModels` 是 Pi `--models` 语法，用 `resolveModelScopeWithDiagnostics()`（`lib/model-scope.ts`）解析，**不要当字符串比**。
- **SSE / running 状态**：`ChatWindow` 挂载时 GET `/api/agent/[id]`，streaming 则重连 SSE；`compaction_*` 和 `auto_compaction_*` 都要接；手动 compact 是阻塞 POST。侧栏可见时每 2.5s 轮询 `/api/agent/running`。**不要**在第一个 `agent_end` 就关闭（重试/压缩/排队消息）；`agent_settled` 收尾扩展注入的运行；忽略旧 run id 的迟到事件。
- **Worktree**：`lib/worktree.ts` 把 linked worktree 顶层映射回主仓 `projectRoot` 以归组；新建路径 `<repoRoot>-worktrees/<sanitized-branch>`；dirty 删除 → `409 {dirty:true}`；cwd 已删的会话回落到主项目。Git 输出 POSIX 路径，过 `toNativePath()`，比较用 `samePath()`（**不要** `===`）。侧栏身份用服务端解析的 `currentWorktreePath`。
- **文件访问**：`/api/files` 不是通用 FS 浏览器 —— 根为会话 cwd、项目根、`~/pi-cwd-*`，加 `allowFileRoot()`。`isPathWithinRoots()`（`lib/path-security.ts`）是唯一安全边界。
- **插件/技能**：`/api/plugins`（Pi `SettingsManager` + `DefaultPackageManager`；禁用 = 写空 `extensions/skills/prompts/themes`），`/api/skills`（`DefaultResourceLoader`；只切 `disable-model-invocation`）。安装：`npx skills add … --agent pi`。
- **子代理**：`builtInEnabled` 在 `~/.pi/agent/agents/settings.json`，默认 false，格式错按 false，切换后需重载会话。Profile 文件与其他 runtime 共用：托管键仅 `description`、`display_name`、`tools`、`load_skills`、`load_extensions`、`enabled`、`inherit_context`、`run_in_background`、`model`、`thinking`、`max_turns`，其余原样回写，手写白名单（如 `extensions: pi-advisor-flow`）绝不改写。见 ADR 0003。
- **认证**：provider 列表按 capability 生成（`lib/provider-listing.ts`），不按 id，双认证 provider 只能出现一次；任何 auth 变更后两张列表都要刷新；`auth.json` 每 provider 一条，删除走 `removeStoredCredentialIfType()` 并在 Pi 文件锁内；状态接口绝不返回明文 key。测试路由是 `app/api/models-config/test/route.ts`。
- **提示音/导出**：`hooks/useAudio.ts`（`pi-sound-enabled`、单个 `AudioContext`、需用户手势解锁、在 `onAgentEnd` 播放）；导出把 Pi 的递归树助手改成迭代版。

## Pi 会话文件格式
`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` —— 条目类型：`session`（头，含 `parentSession`）、`model_change`、`message`、`compaction`、`session_info`。`SessionContext.entryIds[]` 与 `messages[]` 平行（fork / `navigate_tree` 用）。
