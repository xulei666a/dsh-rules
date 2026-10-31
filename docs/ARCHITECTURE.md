# 架构说明（v1.0.0）

## 目标

把 agent 可用的「准则」集中成可管理、可审计、可路由的数据层，并保证：

1. 常驻规则体积可控（只把默认规则放进 AGENTS.md 托管段）。
2. 局部规则按任务域按需取，不进入常驻上下文。
3. 所有写操作可回滚、有改动记录。
4. 分类、适用面、来源、读取状态相互正交，不互相污染。

## 模块地图

```
lib/index.js      插件入口：注册 23 个工具、23 条宿主路由、23 个 UI 相关接口
lib/client.js     右栏「统一准则」页签（iframe 指向 /dsh-rules/ui）
lib/store.js      规则存储与解析：load/upsert/remove、resolve、audit、AGENTS 摘要/备份/回滚、
                  会话覆盖、读取状态、删除抑制清单
lib/collect.js    「读取规则」：扫描来源 → 提取候选 → 分类/拆分/去重 → 收录
lib/issues.js     问题台账：按归属分组扫描并给建议
lib/tree.js       分类方案/分类树：schemes、nodes、placements、order、分配与移动
lib/routing.js    语义路由：A 档（标签/同义词/二元组）与 B 档（embedding）
lib/tags.js       标签推断（key/title/value → tags）
lib/topology.js   单条规则 → 所属流程的上下游
lib/sources.js    来源闸口：来源登记、差异检查、采集计划
lib/skill-import.js 技能检查/安装/提取候选准则
lib/coverage.js   适用面推断与统计
lib/embedding.js  本地 embedding 的安装/构建/增量缓存
lib/assistant.js  面板助手会话：状态、消息读取、投递（首条注角色）
lib/ui.html       管理页（单文件 HTML + 内联 JS，无构建）
lib/search.js     管理页搜索
```

## 数据流

```
                   ┌──────────── 读取规则（collect）───────────┐
AGENTS.md 手写段 ──┤ EXPERIENCE.md / 项目 AGENTS.md             │
用户技能 / 插件技能 ┤ style-packs                                ├─→ 候选 ─→ 分类/拆分/去重 ─→ rules.jsonl
                   └────────────────────────────────────────────┘

rules.jsonl ─→ resolve（active + priority/scope）─→ AGENTS.md 托管段（默认规则）
            ├─→ rules_route / rules_query（局部规则按任务域）
            ├─→ 管理页 / 右栏面板（读 /list、/tree）
            ├─→ 问题台账（issues.js）
            └─→ 助手会话（写入走 rules_* 工具）
```

## 关键约定

- **单一事实源**：`rules.jsonl`。AGENTS.md 托管段与面板列表都从它派生。
- **托管段**：`<!-- dsh-rules:begin ... end -->`，插件维护；手写内容放在段外。每次写入前备份到 `AGENTS.md.bak-dsh-rules-*`。
- **解析**：同 key 只取一条 active；priority 高者胜，其次 scopeRank（project > user > global）；冲突进 `rules_audit`。
- **适用面**：`coverage=default` 才进 AGENTS；`local` 必须带 `appliesTo` 任务域，由 `rules_route` 命中。
- **分类**：`groups.json` v2（schemes → nodes → placements）；规则在一套方案里至多属于一个节点；移动而非复制。
- **读取状态**：`read-state.json` 记录上次读取时间 + 每条规则的指纹（updatedAt），用于未读/增量。
- **删除抑制**：删除 `*.collect_*` 规则时写入 `collect-suppressed.json`（来源|标题 指纹），之后读取跳过。
- **助手**：一条真实 DSH 会话；角色约束只在会话首条消息注入，之后原样收发。

## 扩展点

- 新增规则来源：`lib/collect.js` 的 `collectCandidates()` 增加扫描器，返回 `{ value,title,category,source,status }`。
- 新增问题类型：`lib/issues.js` 的 `scanIssues()` 增加分组（owner/kind/severity/items/suggestion）。
- 新增工具/路由：`lib/index.js` 中 `vTool({...})`、`routes.push({...})`。
- 新增分类：`lib/tree.js` 的 `DEFAULT_SCHEME`，或在 UI 里建方案；`select` 支持 `categories/tags/keys/keyPrefixes/keywords/status`。

## 测试

- `scripts/selftest.mjs`：110 项离线自检（临时 HOME，不碰真实数据）。
- `scripts/selftest-client.mjs`：client bundle 契约。
- 手工回归：`cli.mjs list|audit|issues|collect --dry-run|sync`，与管理页/右栏。
