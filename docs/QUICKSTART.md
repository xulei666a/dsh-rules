# dsh-rules 新用户上手（QUICKSTART）

> 目标：装好后 3 分钟内看到「准则列表」，并确认 agent 真的在读它。

## 1. 安装（二选一）

**A. 插件市场（推荐）**
DSH 侧栏 **Plugins → 市场**，搜索 `dsh-rules` 安装，装完**重启 DSH**。

**B. 本地开发版（link）**
在 `~/.dsh/profiles/<profile>/package.json` 里加：
```json
{ "dependencies": { "dsh-rules": "link:/path/to/dsh-rules" } }
```
并把 `dsh-rules` 加进 `dsh.profile.bundles`，重启 DSH。

## 2. 第一次打开

右栏 **统一准则** 页签，或浏览器打开 `http://127.0.0.1:<DSH端口>/dsh-rules/ui`。

首次打开会**自动初始化**：`~/.dsh/rules/rules.jsonl` 不存在时，写入 10 条内置默认准则（全部「常驻」），列表里立刻能看到——**不需要手动导入**。

## 3. 准则列表是怎么被「读」的

| 路径 | 谁在读 | 什么时候 |
|---|---|---|
| `GET /dsh-rules/list` | 面板 UI | 每次打开/刷新面板 |
| `~/.dsh/AGENTS.md` 顶部托管段 | **每个 DSH 会话**（宿主注入 AGENTS） | 新会话启动、每次 `sync` 后 |
| `rules_route` / `rules_query` / `rules_resolve` | agent | 干活时按任务/关键词取局部规则 |
| `rules_session` / `rules_bulk` | agent / 面板 | 把某批局部规则在本对话翻生效 |

- **默认规则** → 写进 AGENTS.md 托管段，永远在上下文里。
- **局部规则** → 不进 AGENTS；按任务域路由，或在面板里「当前对话生效」。
- 面板里的列表读的是 `rules.jsonl`（真实数据源），不是 AGENTS。

## 4. 日常用法

- **加规则**：面板「＋新建准则」，或对助手说「帮我记一条：下载一律放 D:/downloads」。
- **批量改**：对助手说「把 key 以 style.ppt 开头的规则都设成当前对话生效」——先预览再落库。
- **整理分类**：拖拽规则/文件夹；分类不写在规则字段里。
- **CLI 兜底**（不用重启）：
  ```
  node scripts/cli.mjs list
  node scripts/cli.mjs set paths.downloads "下载放 D:/downloads" --category paths
  node scripts/cli.mjs sync
  node scripts/cli.mjs audit
  ```

## 4.5 读取规则（收录系统现有准则）

工具栏「助手」旁边有 **读取规则** 按钮，右边显示「上次读取：MM-DD HH:mm」。

- 点一下：助手调用 `rules_collect`，扫描 `~/.dsh/AGENTS.md` 手写段、`EXPERIENCE.md`、项目 AGENTS.md、用户技能 `~/.dsh/skills`、`~/.agents/skills`、**插件自带技能**（`~/.dsh/profiles/*/node_modules/*/skills`）、`style-packs`。
- 质量处理：长条目按分号拆分、关键词加权分类、近重复去重（相似度 ≥0.86 跳过）；重复点不会重复收录。
- 技能/插件/风格包来源默认「待复核」（pending），AGENTS/EXPERIENCE 来源为「生效」。
- 删除过的收集规则会记入抑制清单，不会被再次读取复活；要恢复用 `collect --reset-suppressed` 后重读。
- 完成后助手回复两行：读取结果 + 问题汇总（见 4.6）。
- CLI 预览：`node scripts/cli.mjs collect --dry-run` / `collect --list-sources`。

## 4.6 问题台账（每个问题都有归属）

读取完成或你问「检查一下准则库」时，助手调用 `rules_issues` 按归属汇报：

| 归属 | 处理建议 |
|---|---|
| 待复核 | 说「帮我校准待复核」，助手给建议、你确认后执行 |
| 冲突 / 重复内容 | 确认保留哪条 |
| 同来源同标题多条 | 确认是否不同规则，重名可改标题 |
| 来源失效 | 删规则，或恢复来源文件后重读 |
| 抑制清单 | `collect --reset-suppressed` 可恢复 |
| 字段异常 / 适用面 | 补全、删除或 `rules_coverage review` |

助手只汇报、不自动改库；你说处理某一类才先 dryRun 再执行。CLI：`node scripts/cli.mjs issues`。

## 4.7 分类与个性化

内置基准分类（所有用户相同）：**产出交付 / 记忆与底线 / 工作方式 / 工具与环境 / 待复核**。

- 「工作方式」按关键词细分：沟通与回复、验证与证据、变更与审计、记忆维护、执行与流程。
- 收集来的 pending 规则自动进「待复核」；确认（状态改 active）后自动落到正式分类。
- 想按自己的习惯分：打开助手直接说「按学习/工作/生活重新分类」，助手会建节点并用 `rules_bulk op=move` 批量移入（先 dryRun）。
- 改坏了「恢复默认方案」可还原基准；自建方案不受影响。

## 4.8 助手对话

- 助手驱动一条真实 DSH 会话；**角色约束只在首条消息注入一次**，之后你发什么它就是什么。
- 输入框 Enter 换行、**Ctrl+Enter 发送**；往上翻历史不会被刷新拽回底部。
- 技能导入不需要按钮：直接说「我下载的技能在 D:\...，帮我装好并提取规则」。

## 5. 三分钟自查

1. `list` 能看到 10 条内置准则（首次，全部「默认生效」）。
2. `sync` 后 `~/.dsh/AGENTS.md` **顶部**出现 `<!-- dsh-rules:begin -->` 托管段。
3. 新开一个会话问 agent「有哪些准则生效？」→ 它能复述默认规则（来自 AGENTS）。
4. 面板里把一条局部规则设为「当前对话生效」→ 换个对话再看，它应为「当前对话未生效」。

## 6. 数据在哪（备份/迁移只需这几个）

```
~/.dsh/rules/rules.jsonl              规则本体（每行一条）
~/.dsh/rules/groups.json              分类方案/树
~/.dsh/rules/session-overrides.json   会话级生效（pins，7 天 TTL）
~/.dsh/rules/read-state.json          上次读取时间 + 指纹
~/.dsh/rules/collect-suppressed.json  删除抑制清单
~/.dsh/rules/history.jsonl            改动记录
~/.dsh/rules/coverage-map.json        适用面映射
```
