# 安装到本机 DSH

当前目标 profile：

```
D:\GodotProject\TOOLS\.dsh\profiles\desktop
```

插件目录：

```
D:\Git\DSH-plugin\dsh-git-panel
```

已打好 tarball：

```
D:\Git\DSH-plugin\dsh-git-panel\dsh-git-panel-0.3.0.tgz
```

## 方案 B：关掉 DSH 后，一次迁移 pnpm store 并安装插件

因为迁移会重命名 profile 的 `node_modules`，必须在 DSH 完全退出后执行。关掉 DSH 后我这边也会结束，所以这件事由你用下面的脚本完成；脚本会自己迁移、安装、记日志、失败回滚。

1. 完全退出 DSH（包括托盘/后台进程）。
2. 双击或在终端运行：

   ```
   D:\Git\DSH-plugin\dsh-git-panel\scripts\run-store-move.cmd
   ```

   它会依次：

   - 把 profile 从 C 盘 pnpm store 切到 `D:\.pnpm-store\v11`
   - 备份 `package.json` / `pnpm-lock.yaml` / `.modules.yaml` / `.npmrc`
   - 重命名 `node_modules` 为 `node_modules.bak-store-move-<时间>`
   - 用 DSH 自带 pnpm 执行 `install --frozen-lockfile`
   - 校验新的 `.modules.yaml` 指向 D 盘
   - 迁移成功后，用本地 junction 安装 `dsh-git-panel`
   - 任一步失败，自动回滚并保留备份

3. 看脚本窗口最后的 `exit code`。为 `0` 就重新启动 DSH；不为 `0` 就按窗口里的日志排查，`node_modules` 应已回滚。

完整日志在：

```
D:\Git\DSH-plugin\dsh-git-panel\scripts\store-move.log
```

迁移脚本本身单独运行时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  D:\Git\DSH-plugin\dsh-git-panel\scripts\migrate-store-to-d.ps1
```

加 `-DryRun` 只预览。

## 方案 A：不动 store，先装插件

这个 profile 在 D 盘，但 `node_modules/.modules.yaml` 记录的 pnpm store 在 C 盘：

```
C:\Users\cynde\AppData\Local\pnpm\store\v11
```

pnpm 在 D 盘项目里会想改用 `D:\.pnpm-store\v11`，发现和现有依赖记录的 store 不一致就拒绝安装。先给 profile 加一个 `.npmrc`：

```ini
# D:\GodotProject\TOOLS\.dsh\profiles\desktop\.npmrc
store-dir=C:\Users\cynde\AppData\Local\pnpm\store\v11
package-import-method=copy
```

`package-import-method=copy` 允许 pnpm 跨盘把包从 C 盘 store 拷进 D 盘 profile。改完不需要重装现有依赖。

## 安装

### 方式零：本地脚本（推荐，走 D: 的 junction）

脚本不会跑 pnpm，只会在 profile 的 `node_modules` 建 junction，并更新 profile 的 `package.json` / `dsh.profile.bundles`。

先看它准备做什么：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  D:\Git\DSH-plugin\dsh-git-panel\scripts\install-profile.ps1 `
  -Mode manual -DryRun
```

确认后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  D:\Git\DSH-plugin\dsh-git-panel\scripts\install-profile.ps1 `
  -Mode manual
```

脚本会先备份 profile 的 `package.json`。如果 `node_modules\dsh-git-panel` 已存在且不是指向本插件的 junction，它会拒绝覆盖。

### 方式一：CLI

```powershell
dsh plugin --profile desktop add D:\Git\DSH-plugin\dsh-git-panel
```

或安装 tarball：

```powershell
dsh plugin --profile desktop add D:\Git\DSH-plugin\dsh-git-panel\dsh-git-panel-0.3.0.tgz
```

如果 `dsh` 不在 PATH，用方式二。

### 方式二：DSH 插件管理页

在 DSH 里打开插件管理，选择「安装组合包」，填入插件的绝对路径：

```
D:\Git\DSH-plugin\dsh-git-panel
```

安装完成后重启 DSH 宿主（宿主半区是启动时冻结的模块图）。浏览器半区刷新页面即可。

## 验证

1. 打开任意 Git 仓库会话；
2. 右侧栏「Git 变更」入口应该出现；
3. 如果右侧栏已有其他标签，点标签条的 `+` 或引导页里的「Git 变更」；
4. 面板应显示当前分支、工作树变更、历史、工作树列表；
5. 让 Agent 调用 `git_panel_submit` 提交一个补丁，面板应自动切到「审批」。

## 手动 link 安装（可选，不跑 pnpm）

如果 pnpm 仍然不配合，可以直接把插件目录链接进 profile。先备份 profile 的 `package.json`，然后：

```powershell
$profile = 'D:\GodotProject\TOOLS\.dsh\profiles\desktop'
$target  = 'D:\Git\DSH-plugin\dsh-git-panel'
$link    = Join-Path $profile 'node_modules\dsh-git-panel'

# 1) node_modules junction
if (-not (Test-Path $link)) {
  New-Item -ItemType Junction -Path $link -Target $target
}

# 2) 手工把 "dsh-git-panel" 加进 profile package.json 的
#    dependencies（值 link:D:/Git/DSH-plugin/dsh-git-panel）
#    和 dsh.profile.bundles 数组。
```

这种方式不会更新 `pnpm-lock.yaml`，下次执行 `pnpm install` 可能被覆盖；只建议本地开发时使用。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-git-panel
```

手动 link 安装则删除 `node_modules\dsh-git-panel` junction，并从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里移除 `dsh-git-panel`。
