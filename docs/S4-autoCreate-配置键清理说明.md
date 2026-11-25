# S4 · autoCreate 配置键清理说明

> 版本：v1 · 状态：说明（无需自动/人工验收） · 日期：2026-11-26 · 权威范围：控制台重构 S4 的 autoCreate 项（计划书 §09 S4、§04 废弃处理、D5）

## 结论

UI 侧已无 autoCreate：`client.js` 中检索不到 `autoCreate`（无表单控件、无 DICT 文案键）。D5 方案 a「从 UI 移除」已落地，S4 无需再改 UI。

## 保留的配置键（不删、不迁移）

- `lib/config.js:69` — `DEFAULT_SINGLE_SESSION.autoCreate = true`（默认值保留）
- `lib/config.js:175` — `single.autoCreate = single.autoCreate !== false`（`normalizeConfig` 继续接受该键，旧 profile 不会因缺键报错）
- `lib/panel.js:218` — 设置白名单 `['enabled', 'aggressive', 'autoCreate']` 继续接受该布尔键

这些键视为 **deprecated**：只为兼容已装 profile 而保留，UI 不再显示、不再新增入口。真正清理（删键 + 迁移）需另开版本窗口，不在 S4。

## 为什么 S4 不改 lib 代码

S4 期间另有 worker 在改 `lib/config.js`、`lib/delegate.js`、`lib/single-session.js`；为避免写冲突，S4 只提交本说明，不给 lib 代码加 deprecated 注释。等该批改动落地后可补注释，行为不变。

## 自动护栏

`test/unit/console-s4.test.js`：

- 断言 `client.js` 中 `autoCreate` 零命中；
- 断言 `lib/config.js` 与 `lib/panel.js` 仍包含该键（防误删）。
