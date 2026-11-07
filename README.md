# dsh-git-panel

DSH 右侧栏的本地 Git 面板：查看当前工作树的变更、历史、工作树列表，并让 Agent 通过工具把 unified diff / patch 发给你，在 DSH 里直接审批。

> 审批只表示「认可这次改动」，插件不会 stage、commit 或 push。通过之后由 Agent（或你自己）决定下一步。

## 功能

- **右侧栏 Git 标签页**：从右侧栏的「Git 变更」入口打开，或由 Agent 提交审批时自动打开。
- **工作树变更**：按文件列出改动，显示已暂存 / 未跟踪标记与增删行数；点击文件查看逐行 diff。
- **历史**：最近提交列表，点进任意提交查看提交信息、作者、时间和完整 diff。
- **工作树列表**：`git worktree list` 的只读展示，标出当前所在工作树。
- **审批**：
  - Agent 调用 `git_panel_submit` 提交补丁，生成审批单；
  - 面板自动打开并选中该单，显示标题、说明、补丁能否干净应用、逐文件 diff；
  - 用户点「通过」或「需要修改」，可附意见；
  - Agent 用 `git_panel_wait` 等待并拿到结果。
- **只读安全边界**：宿主只执行读取类 Git 命令；唯一接近写操作的是 `git apply --check`，只校验补丁，不落盘。
- **仓库可切换**：默认使用当前会话工作目录；点击右上角 `⌂` 可填写任意本地仓库绝对路径。

## 安装

### 从本地目录安装（开发）

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-git-panel
```

或在 DSH 的插件管理页选择「安装组合包」，填入该目录的绝对路径。

### 从 tarball 安装

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-git-panel-0.2.0.tgz
```

安装后重启 DSH 宿主；浏览器半区改完只需刷新页面。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `git_panel_status` | 读取当前工作树状态、行数统计、待审批单 |
| `git_panel_diff` | 读取当前工作树 unified diff，可按文件过滤 |
| `git_panel_submit` | 提交审批。可传 patch，也可省略 patch 并传 `use_worktree: true`，由宿主直接读取工作区 diff（大改动不经过模型上下文） |
| `git_panel_wait` | 等待用户决定，返回 `approved` / `rejected` / `expired` / `pending` |
| `git_panel_reviews` | 列出最近的审批单 |

大改动推荐：

```json
{
  "title": "重构登录流程",
  "description": "改了 20 个文件，补丁约 2 MB",
  "use_worktree": true
}
```

此时 `patch` 可以完全省略；插件在宿主里执行 `git diff`，不把补丁塞进模型上下文，因此不会被上下文长度截断。如果只想提交已暂存内容，加 `"staged": true`。

典型流程：

1. Agent 改完代码，调用 `git_panel_submit`，大改动用 `use_worktree: true`；
2. DSH 右侧栏自动切到「Git 变更 → 审批」，用户看 diff；
3. 用户点「通过」；
4. Agent 调 `git_panel_wait`，拿到 `approved` 后继续。

`git_panel_submit` 自带 `openUrl`（形如 `http://127.0.0.1:<port>/?dsh-git=<id>`），可以直接贴在回复里。

## 数据位置

审批单保存在：

```
$DSH_HOME/git-panel/reviews.json
```

不写进仓库，也不会修改 Git 索引。待审批单 7 天后自动过期，最多保留 200 条。

## 限制

- 只读：不支持 stage / commit / push / 分支切换 / worktree 增删。
- 补丁展示上限约 3 MB；更大的补丁请拆分提交。
- 工作树 diff 上限约 4 MB，超过后界面显示截断提示。
- 非 Git 仓库或没有 `git` 可执行文件时，面板会显示可重试的错误。
- 审批单的「补丁可应用」只是 `git apply --check` 的结果；补丁可能已经应用或上下文已变化，所以不阻止审批。

## 开发

```sh
npm run typecheck
npm run build
```

`src/client.ts` 必须是经典脚本（不能 import/export），构建脚本会剥掉 tsc 可能补的 `export {}`。
