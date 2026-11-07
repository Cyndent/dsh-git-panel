/**
 * dsh-git-panel —— 宿主半区。
 *
 * 一个 Typert 远程服务（"gitPanel"）同时服务两件事：
 *   1. 右侧栏界面：读取本地仓库工作树、diff、历史、工作树列表与审批单；
 *   2. 模型工具：Agent 提交 unified diff，用户在 DSH 里查看并通过/打回。
 *
 * 插件对仓库只读：不会 stage、commit、push，也不会改索引。唯一接近写操作的
 * 命令是 `git apply --check`，只校验补丁能否落地。
 */
import { GitError, checkPatch, getCommitDetail, getDiff, getRepoState, listCommits, parsePatch, resolveRepo } from './git.js';
import { ReviewError, createReview, decideReview, getReview, listPending, listReviews, summarize } from './reviews.js';
import { MANIFEST, PACKAGE_NAME, SERVICE_NAME } from './wire.js';
import { registerGitTools } from './tools.js';
export const name = PACKAGE_NAME;
export const inject = ['typert'];
/**
 * 本地 `RemoteError`：结构与 @deepseek-ai/dsh-typert-protocol 的一致，
 * 但不 import 它。插件以本地 link 安装时，Cordis/typert 的裸包名不在
 * 插件的 Node 解析路径里；结构标记让网关仍能识别错误码。
 */
class RemoteError extends Error {
    isDSHRemoteError = true;
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'RemoteError';
        this.code = code;
        this.details = details;
    }
}
const DEFAULT_ORIGIN = (() => {
    const value = process.env.DSH_WEB_URL;
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value.replace(/\/+$/, '') : '';
})();
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function sleep(ms, signal) {
    return new Promise((resolvePromise) => {
        if (signal?.aborted === true) {
            resolvePromise();
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolvePromise();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolvePromise();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
export class GitPanelService {
    name = SERVICE_NAME;
    typertRemote;
    ctx;
    origin = DEFAULT_ORIGIN;
    lastActivity = 0;
    constructor(ctx) {
        this.ctx = ctx;
        this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_NAME, namespace: SERVICE_NAME });
    }
    get context() {
        return this.ctx;
    }
    rethrow(error) {
        if (error instanceof RemoteError)
            throw error;
        if (error instanceof GitError) {
            throw new RemoteError(`git-panel/${error.code}`, error.message, {
                detail: error.detail ?? ''
            });
        }
        if (error instanceof ReviewError) {
            throw new RemoteError(`git-panel/${error.code}`, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new RemoteError('git-panel/internal', message);
    }
    openUrl(reviewId) {
        const base = this.origin === '' ? '' : this.origin;
        return `${base}/?dsh-git=${encodeURIComponent(reviewId)}`;
    }
    /**
     * 解析某个 Session 的工作目录。优先用 Session 的 workingDirectory 投影；
     * 没有 Session 服务时退回宿主进程的 cwd（最小化组合仍可用）。
     */
    sessionCwd(sessionId) {
        if (sessionId === undefined || sessionId === '')
            return undefined;
        const sessions = this.context.get('sessions');
        if (sessions === undefined)
            return undefined;
        try {
            const session = sessions.get(sessionId);
            if (session === undefined || session === null)
                return undefined;
            const workingDirectory = this.context.get('workingDirectory');
            const cwd = workingDirectory?.get?.(session);
            if (typeof cwd === 'string' && cwd !== '')
                return cwd;
            const headerCwd = session.header?.cwd;
            return typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : undefined;
        }
        catch {
            return undefined;
        }
    }
    async repoFor(sessionId, repo) {
        if (typeof repo === 'string' && repo.trim() !== '')
            return resolveRepo(repo.trim());
        const cwd = this.sessionCwd(sessionId);
        if (cwd !== undefined)
            return resolveRepo(cwd);
        return resolveRepo(process.cwd());
    }
    async resolveRepoForPayload(payload) {
        return this.repoFor(asString(payload.sessionId) || undefined, asString(payload.repo) || undefined);
    }
    // ── 浏览器半区调用的方法 ───────────────────────────────────────────────
    async reportOrigin(payload) {
        const input = asRecord(payload);
        const origin = asString(input.origin).trim().replace(/\/+$/, '');
        if (/^https?:\/\/[^/]+$/i.test(origin))
            this.origin = origin;
        return { ok: true, origin: this.origin };
    }
    async getState(payload) {
        try {
            const input = asRecord(payload);
            const repo = await this.resolveRepoForPayload(input);
            const state = await getRepoState(repo.root);
            const [reviews, pending] = await Promise.all([listReviews({ repoRoot: repo.root }), listPending()]);
            this.lastActivity = Date.now();
            let clientEntry = null;
            try {
                const graph = this.context.get('clientModules')?.graph?.();
                clientEntry = graph?.entries?.find((entry) => entry.id === PACKAGE_NAME) ?? null;
            }
            catch {
                // 诊断信息不可用时不影响正常读取。
            }
            return {
                ...state,
                repo: { ...state.repo, ...repo },
                cwd: this.sessionCwd(asString(input.sessionId)) || repo.root,
                reviews,
                pending,
                diagnostics: {
                    origin: this.origin,
                    hasClientModules: this.context.get('clientModules') !== undefined,
                    clientEntry
                },
                generatedAt: new Date().toISOString()
            };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async getDiff(payload) {
        try {
            const input = asRecord(payload);
            const repo = await this.resolveRepoForPayload(input);
            const staged = input.staged === true;
            const result = await getDiff(repo.root, {
                path: asString(input.path) || undefined,
                staged
            });
            return {
                repo: repo.root,
                staged,
                ...result
            };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async listCommits(payload) {
        try {
            const input = asRecord(payload);
            const repo = await this.resolveRepoForPayload(input);
            const limit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 30;
            const commits = await listCommits(repo.root, limit);
            return { repo: repo.root, commits };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async getCommit(payload) {
        try {
            const input = asRecord(payload);
            const repo = await this.resolveRepoForPayload(input);
            const hash = asString(input.hash);
            if (hash === '')
                throw new RemoteError('git-panel/bad-commit', '缺少提交哈希。');
            const commit = await getCommitDetail(repo.root, hash);
            // 客户端只需要逐文件 patch；整份 patch 再传一遍会白白翻倍。
            const { patch, ...summary } = commit;
            return { repo: repo.root, commit: summary };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async listReviews(payload) {
        try {
            const input = asRecord(payload);
            let repoRoot;
            if (asString(input.repo) !== '') {
                repoRoot = (await this.repoFor(undefined, asString(input.repo))).root;
            }
            else if (asString(input.sessionId) !== '') {
                repoRoot = (await this.repoFor(asString(input.sessionId), undefined)).root;
            }
            const status = asString(input.status);
            const validStatus = status === 'pending' || status === 'approved' || status === 'rejected' || status === 'expired' ? status : undefined;
            const reviews = await listReviews({ repoRoot, status: validStatus });
            return { reviews, pendingCount: (await listPending()).length };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async getReview(payload) {
        try {
            const input = asRecord(payload);
            const id = asString(input.reviewId);
            if (id === '')
                throw new RemoteError('git-panel/review-not-found', '缺少审批单 id。');
            const review = await getReview(id);
            if (review === undefined)
                throw new RemoteError('git-panel/review-not-found', '审批单不存在或已被清理。');
            // 客户端只需要逐文件 patch；原始整份 patch 再传一遍会白白翻倍。
            const { patch, ...summary } = review;
            return { review: summary, diffFiles: parsePatch(patch) };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async listPending() {
        try {
            const reviews = await listPending();
            return { reviews, count: reviews.length, generatedAt: new Date().toISOString() };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async decideReview(payload) {
        try {
            const input = asRecord(payload);
            const id = asString(input.reviewId);
            if (id === '')
                throw new RemoteError('git-panel/review-not-found', '缺少审批单 id。');
            const approved = input.approved === true;
            const comment = asString(input.comment);
            const review = await decideReview(id, approved, comment);
            return {
                review: summarize(review),
                pendingCount: (await listPending()).length,
                openUrl: this.openUrl(review.id)
            };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    // ── 工具面直接调用的方法 ───────────────────────────────────────────────
    async submitReview(payload) {
        try {
            const input = asRecord(payload);
            const repo = await this.repoFor(asString(input.sessionId) || undefined, asString(input.repo) || undefined);
            let patch = asString(input.patch);
            let source = 'patch';
            // 大改动不要经过模型上下文：没有 patch，或显式 use_worktree: true 时，
            // 由宿主直接读取当前工作区的 diff。
            const useWorktree = input.use_worktree === true || patch.trim() === '';
            if (useWorktree) {
                const diff = await getDiff(repo.root, {
                    staged: input.staged === true,
                    maxBytes: 12 * 1024 * 1024
                });
                if (diff.patch.trim() === '') {
                    if (diff.truncated) {
                        throw new RemoteError('git-panel/diff-too-large', '工作区 diff 超过 12 MB，请拆分提交，或用 staged 分批提交。');
                    }
                    throw new RemoteError('git-panel/no-changes', '当前工作区没有可提交的变更。');
                }
                patch = diff.patch;
                source = 'worktree';
            }
            if (patch.trim() === '')
                throw new RemoteError('git-panel/patch-empty', '补丁为空。');
            // 工作区直读的 diff 已经落在工作树里，`git apply --check` 必然失败，
            // 不能拿它当“补丁能否应用”的判断。
            const checked = source === 'worktree' ? { applies: true, error: undefined } : await checkPatch(repo.root, patch);
            const review = await createReview({
                title: asString(input.title),
                description: asString(input.description),
                repoRoot: repo.root,
                repoName: repo.name,
                sessionId: asString(input.sessionId),
                base: asString(input.base) || 'HEAD',
                source,
                patch,
                applies: checked.applies,
                applyError: checked.error,
                files: []
            });
            this.lastActivity = Date.now();
            return {
                reviewId: review.id,
                title: review.title,
                repoRoot: review.repoRoot,
                repoName: review.repoName,
                source: review.source,
                status: review.status,
                additions: review.additions,
                deletions: review.deletions,
                fileCount: review.fileCount,
                files: review.files,
                applies: review.applies,
                applyError: review.applyError,
                patchBytes: patch.length,
                openUrl: this.openUrl(review.id)
            };
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async waitForReview(reviewId, timeoutSeconds, signal) {
        try {
            const id = typeof reviewId === 'string' ? reviewId.trim() : '';
            if (id === '')
                throw new RemoteError('git-panel/review-not-found', '缺少审批单 id。');
            const seconds = Math.max(1, Math.min(600, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 120));
            const started = Date.now();
            const deadline = started + seconds * 1000;
            for (;;) {
                const review = await getReview(id);
                if (review === undefined)
                    throw new RemoteError('git-panel/review-not-found', '审批单不存在或已被清理。');
                if (review.status !== 'pending') {
                    return {
                        reviewId: review.id,
                        status: review.status,
                        comment: review.comment,
                        decidedAt: review.decidedAt,
                        waitedSeconds: Math.round((Date.now() - started) / 1000),
                        review: summarize(review),
                        openUrl: this.openUrl(review.id)
                    };
                }
                if (signal?.aborted === true) {
                    return {
                        reviewId: review.id,
                        status: 'pending',
                        comment: '',
                        waitedSeconds: Math.round((Date.now() - started) / 1000),
                        review: summarize(review),
                        openUrl: this.openUrl(review.id),
                        cancelled: true
                    };
                }
                if (Date.now() >= deadline) {
                    return {
                        reviewId: review.id,
                        status: 'pending',
                        comment: '',
                        waitedSeconds: Math.round((Date.now() - started) / 1000),
                        review: summarize(review),
                        openUrl: this.openUrl(review.id)
                    };
                }
                await sleep(Math.min(1000, Math.max(0, deadline - Date.now())), signal);
            }
        }
        catch (error) {
            this.rethrow(error);
        }
    }
    async reviewForTool(reviewId) {
        try {
            const review = await getReview(reviewId);
            return review === undefined ? undefined : summarize(review);
        }
        catch (error) {
            this.rethrow(error);
        }
    }
}
export function apply(ctx) {
    const service = new GitPanelService(ctx);
    // 不继承 protocol 包的 TypertRemoteService：本地 link 安装时裸包名不可解析。
    // ctx.reflect.provide 是 Cordis 公开的注册入口，typertRemote 绑定结构同协议包。
    ctx.effect(() => ctx.reflect.provide(SERVICE_NAME, service), 'dsh-git-panel: gitPanel service');
    ctx.effect(() => ctx.typert.register(MANIFEST), 'dsh-git-panel: typert manifest');
    ctx.effect(() => {
        const disposers = registerGitTools(ctx, service);
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-git-panel: tools');
}
