/**
 * 对话调用面（模型工具）。
 *
 * 工具只做编排，真正的 Git/审批逻辑在 `GitPanelService` 上，界面走同一条
 * 远程服务。这样「Agent 提交的审批单」和「界面看到的审批单」永远是同一份。
 */
function jsonSafe(value) {
    if (value === undefined)
        return null;
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return null;
    }
}
function textResult(value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}
function renderStatus(value) {
    if (value?.repoRoot === undefined)
        return JSON.stringify(value, null, 2);
    const changes = Array.isArray(value.changes) ? value.changes : [];
    const lines = [
        `仓库：${value.repoRoot}`,
        `分支：${value.branch ?? '-'}   HEAD：${value.head ?? '-'}`,
        `工作树：${changes.length} 个文件  +${value.additions ?? 0} -${value.deletions ?? 0}`,
        ''
    ];
    for (const change of changes.slice(0, 80)) {
        const staged = change.staged ? '已暂存 ' : '';
        const untracked = change.untracked ? '未跟踪 ' : '';
        lines.push(`  [${change.status}] ${staged}${untracked}${change.path}  +${change.additions} -${change.deletions}`);
    }
    if (changes.length > 80)
        lines.push(`  … 还有 ${changes.length - 80} 个文件`);
    const pending = Array.isArray(value.pending) ? value.pending : [];
    if (pending.length > 0) {
        lines.push('', `待审批：${pending.length} 个`);
        for (const review of pending.slice(0, 10)) {
            lines.push(`  ${review.id}  ${review.title}  (${review.repoName})`);
        }
    }
    return lines.join('\n');
}
function renderSubmit(value) {
    if (value?.reviewId === undefined)
        return JSON.stringify(value, null, 2);
    const files = Array.isArray(value.files) ? value.files : [];
    const source = value.source === 'worktree' ? '当前工作区（宿主直读）' : '传入的 patch';
    const lines = [
        `已提交审批：${value.title}`,
        `审批单：${value.reviewId}`,
        `来源：${source}`,
        `文件：${files.length} 个  +${value.additions ?? 0} -${value.deletions ?? 0}  补丁 ${value.patchBytes ?? 0} 字节`,
        value.source === 'worktree'
            ? '工作区直读：变更已在工作树里，审批只标记状态，不会再次应用补丁。'
            : `补丁可直接应用：${value.applies ? '是' : '否（仅展示，不阻止审批）'}`,
        value.applyError ? `git apply 提示：${value.applyError}` : '',
        '',
        `打开审批：${value.openUrl}`,
        '',
        '下一步：调用 git_panel_wait 等待用户决定；通过后由你决定是否继续提交。'
    ].filter((line) => line !== '');
    return lines.join('\n');
}
function renderWait(value) {
    if (value?.status === undefined)
        return JSON.stringify(value, null, 2);
    if (value.status === 'pending') {
        return `审批单 ${value.reviewId ?? ''} 仍在等待用户决定（已等待 ${value.waitedSeconds ?? 0} 秒）。\n打开审批：${value.openUrl ?? ''}`;
    }
    const label = value.status === 'approved' ? '已通过' : value.status === 'rejected' ? '需要修改' : value.status;
    const lines = [`审批结果：${label}`, `审批单：${value.reviewId ?? ''}`];
    if (value.comment)
        lines.push(`用户意见：${value.comment}`);
    return lines.join('\n');
}
export function registerGitTools(ctx, service) {
    const tools = ctx.get('tools');
    if (tools === undefined)
        return [];
    const disposers = [];
    const register = (definition) => {
        const execute = definition.execute;
        disposers.push(tools.register({
            ...definition,
            async execute(args, exec) {
                return jsonSafe(await execute(args, exec));
            }
        }));
    };
    const output = {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textResult(value)
    };
    register({
        name: 'git_panel_status',
        description: '查看当前会话工作区的本地 Git 状态：仓库根、分支、HEAD、工作树变更文件、行数统计，以及所有待审批的补丁。用于 agent 在提交审批前确认改了什么。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                repo: { type: 'string', description: '可选：仓库路径或仓库内任意路径；省略时使用当前会话工作目录。' }
            }
        },
        output: {
            ...output,
            render: (_args, value) => textResult(renderStatus(value))
        },
        timeoutMs: 60_000,
        async execute(args, exec) {
            return service.getState({
                sessionId: exec?.agent?.session?.id,
                repo: typeof args?.repo === 'string' ? args.repo : undefined
            });
        }
    });
    register({
        name: 'git_panel_diff',
        description: '读取当前会话工作区的 unified diff（已跟踪文件与未跟踪文件）。可选只看某个文件。返回内容可能被截断，适合 agent 在提交审批前复核。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                repo: { type: 'string', description: '可选：仓库路径；省略时使用当前会话工作目录。' },
                path: { type: 'string', description: '可选：只看这个文件（相对仓库根）。' },
                staged: { type: 'boolean', description: 'true 只读取已暂存变更；默认读取相对 HEAD 的完整工作树变更。' }
            }
        },
        output,
        timeoutMs: 60_000,
        async execute(args, exec) {
            const result = await service.getDiff({
                sessionId: exec?.agent?.session?.id,
                repo: typeof args?.repo === 'string' ? args.repo : undefined,
                path: typeof args?.path === 'string' ? args.path : undefined,
                staged: args?.staged === true
            });
            // 工具输出会进入模型上下文，不能把几 MB 的补丁原样塞回去。
            const MAX_PATCH_CHARS = 120_000;
            if (result && typeof result.patch === 'string' && result.patch.length > MAX_PATCH_CHARS) {
                return {
                    ...result,
                    patch: result.patch.slice(0, MAX_PATCH_CHARS),
                    truncated: true,
                    patchTruncated: true
                };
            }
            return result;
        }
    });
    register({
        name: 'git_panel_submit',
        description: '把代码改动提交给用户在 DSH 右侧的 Git 面板里审批。大改动建议省略 patch 并传 use_worktree: true：宿主会直接读取当前工作区 diff，补丁不经过模型上下文，也不会被上下文大小截断。也可以显式传 patch。返回审批单 id 与打开链接；审批只标记通过，不会自动提交。提交后用 git_panel_wait 等待用户决定。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: '一句话说明这次改动。' },
                description: { type: 'string', description: '可选：更详细的背景、风险、验证方式。' },
                patch: {
                    type: 'string',
                    description: '可选：unified diff/patch 文本。省略时宿主自动读取工作区 diff（等同 use_worktree: true）。大补丁建议省略，避免被模型上下文截断。'
                },
                use_worktree: {
                    type: 'boolean',
                    description: 'true 时忽略 patch，直接读取当前工作区（相对 HEAD）的 diff，包含未跟踪文件。补丁不经过模型上下文。'
                },
                staged: {
                    type: 'boolean',
                    description: '仅 use_worktree 时有效：true 读取已暂存变更，默认读取完整工作区变更。'
                },
                repo: { type: 'string', description: '可选：仓库路径；省略时使用当前会话工作目录。' },
                base: { type: 'string', description: '可选：补丁的比较基准，默认 HEAD。仅作为展示信息。' }
            },
            required: ['title']
        },
        output: {
            ...output,
            render: (_args, value) => textResult(renderSubmit(value))
        },
        timeoutMs: 120_000,
        async execute(args, exec) {
            return service.submitReview({
                sessionId: exec?.agent?.session?.id,
                repo: typeof args?.repo === 'string' ? args.repo : undefined,
                title: typeof args?.title === 'string' ? args.title : '',
                description: typeof args?.description === 'string' ? args.description : '',
                patch: typeof args?.patch === 'string' ? args.patch : '',
                use_worktree: args?.use_worktree === true,
                staged: args?.staged === true,
                base: typeof args?.base === 'string' ? args.base : 'HEAD'
            });
        }
    });
    register({
        name: 'git_panel_wait',
        description: '等待用户在 Git 面板里对某个审批单做出决定。返回 approved / rejected / expired / pending。超时后会返回 pending，可再次调用。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                reviewId: { type: 'string', description: 'git_panel_submit 返回的审批单 id。' },
                timeoutSeconds: {
                    type: 'number',
                    description: '最多等待多少秒，默认 120，最大 600。'
                }
            },
            required: ['reviewId']
        },
        output: {
            ...output,
            render: (_args, value) => textResult(renderWait(value))
        },
        timeoutMs: 11 * 60 * 1000,
        async execute(args, exec) {
            const reviewId = typeof args?.reviewId === 'string' ? args.reviewId : '';
            const timeout = typeof args?.timeoutSeconds === 'number' ? args.timeoutSeconds : 120;
            return service.waitForReview(reviewId, timeout, exec?.signal);
        }
    });
    register({
        name: 'git_panel_reviews',
        description: '列出最近的审批单（默认当前仓库），包含待审批与已决定的结果。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                repo: { type: 'string', description: '可选：仓库路径；省略时使用当前会话工作目录。' },
                status: {
                    type: 'string',
                    enum: ['pending', 'approved', 'rejected', 'expired'],
                    description: '可选：只看某个状态。'
                }
            }
        },
        output,
        timeoutMs: 30_000,
        async execute(args, exec) {
            return service.listReviews({
                sessionId: exec?.agent?.session?.id,
                repo: typeof args?.repo === 'string' ? args.repo : undefined,
                status: typeof args?.status === 'string' ? args.status : undefined
            });
        }
    });
    return disposers;
}
