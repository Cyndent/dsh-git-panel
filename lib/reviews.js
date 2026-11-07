/**
 * 审批单存储。
 *
 * 审批单是插件自己的数据，不写进仓库、不碰 Git 索引。默认落在
 * `$DSH_HOME/git-panel/reviews.json`，跨 DSH 重启保留；每个单子只保存
 * Agent 提交时的补丁与展示所需的文件摘要。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parsePatch } from './git.js';
// 工作区直读模式下补丁不经过模型上下文，放宽到 12 MB；界面仍只画前 5000 行。
const MAX_PATCH_CHARS = 12 * 1024 * 1024;
const MAX_REVIEWS = 200;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export class ReviewError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ReviewError';
        this.code = code;
    }
}
let cache;
let loading;
let writeChain = Promise.resolve();
export function dataDirectory() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
    return join(home, 'git-panel');
}
export function reviewsFile() {
    return join(dataDirectory(), 'reviews.json');
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalizeStatus(value) {
    return value === 'approved' || value === 'rejected' || value === 'expired' || value === 'pending' ? value : 'pending';
}
function normalizeFile(value) {
    if (!isRecord(value) || typeof value.path !== 'string' || value.path === '')
        return undefined;
    return {
        path: value.path,
        oldPath: typeof value.oldPath === 'string' && value.oldPath !== '' ? value.oldPath : undefined,
        status: typeof value.status === 'string' ? value.status : 'M',
        additions: Number(value.additions) || 0,
        deletions: Number(value.deletions) || 0,
        binary: value.binary === true
    };
}
function normalizeReview(value) {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id === '')
        return undefined;
    if (typeof value.patch !== 'string')
        return undefined;
    const files = Array.isArray(value.files) ? value.files.map(normalizeFile).filter(Boolean) : [];
    return {
        id: value.id,
        title: typeof value.title === 'string' && value.title !== '' ? value.title : '未命名变更',
        description: typeof value.description === 'string' ? value.description : '',
        repoRoot: typeof value.repoRoot === 'string' ? value.repoRoot : '',
        repoName: typeof value.repoName === 'string' && value.repoName !== '' ? value.repoName : basename(value.repoRoot || ''),
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
        base: typeof value.base === 'string' && value.base !== '' ? value.base : 'HEAD',
        source: value.source === 'worktree' ? 'worktree' : 'patch',
        status: normalizeStatus(value.status),
        comment: typeof value.comment === 'string' ? value.comment : '',
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
        decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : undefined,
        applies: value.applies === true,
        applyError: typeof value.applyError === 'string' && value.applyError !== '' ? value.applyError : undefined,
        additions: Number(value.additions) || 0,
        deletions: Number(value.deletions) || 0,
        fileCount: Number(value.fileCount) || files.length,
        files,
        patch: value.patch
    };
}
async function readStore() {
    try {
        const raw = await readFile(reviewsFile(), 'utf8');
        const parsed = JSON.parse(raw);
        const reviews = Array.isArray(parsed?.reviews) ? parsed.reviews.map(normalizeReview).filter(Boolean) : [];
        const now = Date.now();
        for (const review of reviews) {
            if (review.status === 'pending' && now - Date.parse(review.createdAt) > PENDING_TTL_MS) {
                review.status = 'expired';
                review.updatedAt = new Date().toISOString();
            }
        }
        return { version: 1, reviews };
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { version: 1, reviews: [] };
        // 损坏的文件不阻塞插件启动；把现场留成 .bak 便于排查。
        try {
            await rename(reviewsFile(), `${reviewsFile()}.bak-${Date.now()}`);
        }
        catch {
            // ignore
        }
        return { version: 1, reviews: [] };
    }
}
async function ensureLoaded() {
    if (cache !== undefined)
        return cache;
    if (loading === undefined) {
        loading = readStore().then((store) => {
            cache = store;
            return store;
        });
    }
    return loading;
}
async function persist(store) {
    const dir = dataDirectory();
    await mkdir(dir, { recursive: true });
    const target = reviewsFile();
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const body = JSON.stringify({ version: 1, reviews: store.reviews }, null, 2);
    await writeFile(temp, body, 'utf8');
    try {
        await rename(temp, target);
    }
    catch {
        await rm(target, { force: true });
        await rename(temp, target);
    }
}
function save(store) {
    // 写入串行化；本次失败要抛给调用方，但下一条写入不能被失败的链卡住。
    const next = writeChain.catch(() => undefined).then(() => persist(store));
    writeChain = next.catch(() => undefined);
    return next;
}
function prune(store) {
    const pending = store.reviews.filter((review) => review.status === 'pending');
    const decided = store.reviews.filter((review) => review.status !== 'pending');
    decided.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    store.reviews = [...pending, ...decided.slice(0, Math.max(0, MAX_REVIEWS - pending.length))];
}
export function summarize(review) {
    return {
        id: review.id,
        title: review.title,
        description: review.description,
        repoRoot: review.repoRoot,
        repoName: review.repoName,
        sessionId: review.sessionId,
        base: review.base,
        source: review.source,
        status: review.status,
        comment: review.comment,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
        decidedAt: review.decidedAt,
        applies: review.applies,
        applyError: review.applyError,
        additions: review.additions,
        deletions: review.deletions,
        fileCount: review.fileCount
    };
}
export async function createReview(input) {
    const title = input.title.trim();
    if (title === '')
        throw new ReviewError('title-required', '审批标题不能为空。');
    const patch = input.patch;
    if (patch.trim() === '')
        throw new ReviewError('patch-empty', '补丁为空。');
    if (patch.length > MAX_PATCH_CHARS) {
        throw new ReviewError('patch-too-large', `补丁超过 ${Math.floor(MAX_PATCH_CHARS / 1024)} KB，无法保存。请拆分后再提交。`);
    }
    const files = (input.files.length > 0 ? input.files : parsePatch(patch)).slice(0, 500).map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary
    }));
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const now = new Date().toISOString();
    const review = {
        id: `rv_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
        title,
        description: (input.description ?? '').trim(),
        repoRoot: input.repoRoot,
        repoName: input.repoName,
        sessionId: input.sessionId ?? '',
        base: input.base ?? 'HEAD',
        source: input.source === 'worktree' ? 'worktree' : 'patch',
        status: 'pending',
        comment: '',
        createdAt: now,
        updatedAt: now,
        applies: input.applies,
        applyError: input.applyError,
        additions,
        deletions,
        fileCount: files.length,
        files,
        patch
    };
    const store = await ensureLoaded();
    store.reviews.unshift(review);
    prune(store);
    await save(store);
    return review;
}
export async function listReviews(filter = {}) {
    const store = await ensureLoaded();
    const repoKey = filter.repoRoot?.toLowerCase();
    return store.reviews
        .filter((review) => (repoKey === undefined || review.repoRoot.toLowerCase() === repoKey))
        .filter((review) => (filter.sessionId === undefined || review.sessionId === filter.sessionId))
        .filter((review) => (filter.status === undefined || review.status === filter.status))
        .map(summarize)
        .sort((left, right) => {
        if (left.status === 'pending' && right.status !== 'pending')
            return -1;
        if (left.status !== 'pending' && right.status === 'pending')
            return 1;
        return right.createdAt.localeCompare(left.createdAt);
    });
}
export async function listPending() {
    return listReviews({ status: 'pending' });
}
export async function getReview(id) {
    const store = await ensureLoaded();
    return store.reviews.find((review) => review.id === id);
}
export async function decideReview(id, approved, comment = '') {
    const store = await ensureLoaded();
    const review = store.reviews.find((item) => item.id === id);
    if (review === undefined)
        throw new ReviewError('review-not-found', '审批单不存在。');
    if (review.status !== 'pending')
        throw new ReviewError('review-decided', `审批单已经是「${review.status}」状态。`);
    review.status = approved ? 'approved' : 'rejected';
    review.comment = comment.trim();
    review.decidedAt = new Date().toISOString();
    review.updatedAt = review.decidedAt;
    await save(store);
    return review;
}
export async function expireReview(id) {
    const store = await ensureLoaded();
    const review = store.reviews.find((item) => item.id === id);
    if (review === undefined || review.status !== 'pending')
        return review;
    review.status = 'expired';
    review.updatedAt = new Date().toISOString();
    await save(store);
    return review;
}
export async function pendingCount() {
    const store = await ensureLoaded();
    return store.reviews.filter((review) => review.status === 'pending').length;
}
