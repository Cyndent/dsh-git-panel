# Changelog

## 0.4.0 — 2026-11-08

- 会话标题栏右侧新增 Git 快捷图标（`conversation.session.header.utilities`，与 forge 变更请求图标同一排）。
- 点击图标打开 / 聚焦右侧栏 Git 标签；Git 标签已在当前面板时再次点击收起右栏。

## 0.3.0 — 2026-11-07

- 新增审批提示音：新审批单出现时播放合成双音提示。
- 使用 Web Audio 合成，不新增音频资源；首次点击/按键解锁 AudioContext（同 whale-widget 的自动播放处理）。
- 面板右上角新增喇叭开关，可静音；选择保存在浏览器 `localStorage`。
- `README` 补充 `use_worktree` 与提示音说明。

## 0.2.0 — 2026-11-07

- `git_panel_submit` 新增 `use_worktree`：省略 `patch` 或传 `use_worktree: true` 时，宿主直接读取工作区 diff（含未跟踪文件），补丁不经过模型上下文，避免大补丁被上下文截断。
- 新增 `staged: true`，可只读取已暂存变更，便于分批提交。
- 工作区 diff / 审批单存储上限从 3 MB 提升到 12 MB；界面仍只渲染前 5000 行以保持流畅。
- 审批单新增 `source`（`patch` / `worktree`），界面显示「工作区」来源，不再对已落地的工作区变更做 `git apply --check`。
- 修复审批详情一直停在「正在读取审批单…」的 effect 死循环。
- 修复 `for-each-ref` 字段分隔符被当成字面量，分支名显示成 `%x1f...`。
- 历史页在外部 `git reset` / `rebase` 后，如果当前打开的提交已不在分支上，自动退回历史列表。
- 宿主半区不再依赖 `@deepseek-ai/dsh-typert-protocol` 的裸导入，改为本地注册 `gitPanel` 服务，本地 link 安装也能加载。
- 新增一键安装 / pnpm store 迁移脚本。

## 0.1.0 — 2026-11-07

- 首个版本：右侧栏 Git 标签页，工作树变更、diff、历史、工作树列表。
- Agent 工具：`git_panel_status`、`git_panel_diff`、`git_panel_submit`、`git_panel_wait`、`git_panel_reviews`。
- 审批只标记通过 / 需要修改，不自动 commit。
