/**
 * 本地 Git 只读访问层。
 *
 * 这里只做「读」：状态、diff、日志、提交详情、分支与工作树列表。
 * 唯一会执行的非读操作是 `git apply --check`（只为告诉用户补丁能否
 * 干净地落到当前工作树，不写任何文件）。真正的提交由用户/Agent 自己决定。
 *
 * 所有命令都用参数数组 spawn，不经过 shell；工作目录固定为仓库根或用户
 * 指定的仓库路径，路径参数在进入 Git 前会做越界检查。
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
export class GitError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.name = 'GitError';
        this.code = code;
        this.detail = detail;
    }
}
const GIT = process.env.DSH_GIT_EXECUTABLE || 'git';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
function gitEnv() {
    const env = { ...process.env };
    // 不让调用方的环境把 git 指向别的工作树/索引；也不让 git 交互式要凭据。
    for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_NAMESPACE',
        'GIT_PREFIX',
        'GIT_CONFIG_PARAMETERS'
    ]) {
        delete env[key];
    }
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_'))
            delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_PAGER = 'cat';
    env.GIT_CONFIG_COUNT = '0';
    env.LC_ALL = 'C';
    env.LANG = 'C';
    return env;
}
function describeFailure(stderr, code) {
    const text = stderr.trim();
    if (text !== '')
        return text;
    return `git exited with code ${code ?? 'unknown'}`;
}
function runGit(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return new Promise((resolvePromise, reject) => {
        let settled = false;
        let timer;
        const stdout = [];
        const stderr = [];
        let outBytes = 0;
        let errBytes = 0;
        let tooLarge = false;
        const child = spawn(GIT, ['-C', cwd, '-c', 'core.quotepath=false', '-c', 'color.ui=false', '--no-pager', ...args], {
            cwd,
            env: gitEnv(),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            fn();
        };
        const killWith = (error) => {
            finish(() => {
                try {
                    child.kill();
                }
                catch {
                    // ignore
                }
                reject(error);
            });
        };
        timer = setTimeout(() => {
            killWith(new GitError('git-timeout', `Git 命令超时（${timeoutMs}ms）。`));
        }, timeoutMs);
        child.on('error', (error) => {
            finish(() => reject(new GitError('git-unavailable', `无法启动 git：${error.message}`)));
        });
        child.stdout.on('data', (chunk) => {
            if (tooLarge)
                return;
            outBytes += chunk.length;
            if (outBytes > maxBytes) {
                tooLarge = true;
                killWith(new GitError('output-too-large', `Git 输出超过 ${maxBytes} 字节，已中止。`));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            errBytes += chunk.length;
            if (errBytes > 512 * 1024)
                return;
            stderr.push(chunk);
        });
        child.on('close', (code) => {
            if (settled)
                return;
            const out = Buffer.concat(stdout).toString('utf8');
            const err = Buffer.concat(stderr).toString('utf8');
            if (code !== 0 && options.allowFail !== true) {
                finish(() => reject(new GitError('git-failed', describeFailure(err, code), err)));
                return;
            }
            finish(() => resolvePromise({ stdout: out, stderr: err, code: code ?? 0 }));
        });
        if (options.input !== undefined)
            child.stdin.end(options.input, 'utf8');
        else
            child.stdin.end();
    });
}
export function isPathInside(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
function safeRelative(root, input) {
    const normalized = normalize(input.replace(/\\/g, '/'));
    if (isAbsolute(normalized)) {
        if (!isPathInside(root, normalized))
            throw new GitError('path-outside-repo', '路径不在仓库内。');
        return relative(root, normalized).split(sep).join('/');
    }
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new GitError('path-outside-repo', '路径不在仓库内。');
    }
    return normalized.split(sep).join('/');
}
async function readFileWithin(root, relativePath, maxBytes) {
    const rel = safeRelative(root, relativePath);
    const absolute = resolve(root, rel);
    if (!isPathInside(root, absolute))
        throw new GitError('path-outside-repo', '路径不在仓库内。');
    const real = await realpath(absolute).catch(() => absolute);
    if (!isPathInside(root, real))
        throw new GitError('path-outside-repo', '路径不在仓库内。');
    const info = await stat(real);
    if (!info.isFile())
        throw new GitError('not-a-file', '不是普通文件。');
    if (info.size > maxBytes)
        throw new GitError('file-too-large', `文件超过 ${maxBytes} 字节。`);
    const buffer = await readFile(real);
    const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
    const binary = sample.includes(0);
    return { text: buffer.toString('utf8'), bytes: buffer.length, binary };
}
export async function resolveRepo(inputPath) {
    const raw = resolve(inputPath);
    const info = await stat(raw).catch(() => undefined);
    if (info === undefined)
        throw new GitError('repo-not-found', `路径不存在：${raw}`);
    const cwd = info.isDirectory() ? raw : dirname(raw);
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (result.code !== 0) {
        throw new GitError('not-a-repo', '这个目录不是 Git 仓库（或 git 不可用）。', result.stderr.trim());
    }
    const root = await realpath(result.stdout.trim().split(/\r?\n/)[0]);
    const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'], { allowFail: true })).stdout.trim();
    const common = (await runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true })).stdout.trim();
    return {
        root,
        name: basename(root),
        gitDir: gitDir || undefined,
        commonDir: common || undefined
    };
}
function parseBranchHeader(header) {
    const text = header.replace(/^##\s*/, '');
    if (text.startsWith('HEAD (no branch)')) {
        return { branch: 'HEAD', upstream: '', ahead: 0, behind: 0, detached: true };
    }
    if (text.startsWith('No commits yet on ')) {
        return { branch: text.slice('No commits yet on '.length), upstream: '', ahead: 0, behind: 0, detached: false };
    }
    const match = text.match(/^(.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+?)\])?$/);
    const branch = match?.[1] ?? text;
    const upstream = match?.[2] ?? '';
    const counts = match?.[3] ?? '';
    const ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
    return { branch, upstream, ahead, behind, detached: false };
}
export function parseStatus(raw) {
    const tokens = raw.split('\0');
    let branch = '';
    let upstream = '';
    let ahead = 0;
    let behind = 0;
    let detached = false;
    const changes = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '')
            continue;
        if (token.startsWith('## ')) {
            const parsed = parseBranchHeader(token);
            branch = parsed.branch;
            upstream = parsed.upstream;
            ahead = parsed.ahead;
            behind = parsed.behind;
            detached = parsed.detached;
            continue;
        }
        if (token.length < 4)
            continue;
        const x = token[0];
        const y = token[1];
        if (x === '!' && y === '!')
            continue;
        const path = token.slice(3);
        let oldPath;
        if (x === 'R' || x === 'C') {
            oldPath = tokens[index + 1];
            index += 1;
        }
        const untracked = x === '?' && y === '?';
        const status = untracked ? '?' : ((x !== ' ' ? x : y) || 'M');
        changes.push({
            path,
            oldPath: oldPath && oldPath !== '' ? oldPath : undefined,
            status,
            index: x,
            worktree: y,
            staged: !untracked && x !== ' ' && x !== '?',
            unstaged: !untracked && y !== ' ',
            untracked
        });
    }
    return { branch, upstream, ahead, behind, detached, changes };
}
export function parseNumstat(raw) {
    const map = new Map();
    for (const token of raw.split('\0')) {
        if (token === '')
            continue;
        const parts = token.split('\t');
        if (parts.length < 3)
            continue;
        const path = parts.slice(2).join('\t');
        const binary = parts[0] === '-' || parts[1] === '-';
        map.set(path, {
            additions: binary ? 0 : Number(parts[0]) || 0,
            deletions: binary ? 0 : Number(parts[1]) || 0,
            binary
        });
    }
    return map;
}
async function untrackedFiles(root, limit = 200) {
    const result = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true });
    if (result.code !== 0)
        return [];
    return result.stdout.split('\0').filter(Boolean).slice(0, limit);
}
async function countTextLines(root, path) {
    try {
        const file = await readFileWithin(root, path, 1024 * 1024);
        if (file.binary)
            return { additions: 0, binary: true };
        const text = file.text;
        if (text === '')
            return { additions: 0, binary: false };
        const lines = text.split(/\r?\n/);
        if (lines.length > 0 && lines[lines.length - 1] === '')
            lines.pop();
        return { additions: lines.length, binary: false };
    }
    catch {
        return { additions: 0, binary: true };
    }
}
export async function listCommits(root, limit = 24, path) {
    const count = Math.max(1, Math.min(200, Math.floor(limit)));
    const args = [
        'log',
        `-n`,
        String(count),
        '--date=iso-strict',
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'
    ];
    if (path !== undefined && path !== '')
        args.push('--', safeRelative(root, path));
    const result = await runGit(root, args, { allowFail: true });
    if (result.code !== 0)
        return [];
    return result.stdout
        .split('\x1e')
        .map((record) => record.replace(/^\r?\n/, ''))
        .filter(Boolean)
        .map((record) => {
        const parts = record.split('\x1f');
        return {
            hash: parts[0] ?? '',
            short: parts[1] ?? '',
            author: parts[2] ?? '',
            date: parts[3] ?? '',
            subject: parts[4] ?? ''
        };
    })
        .filter((commit) => commit.hash !== '');
}
export async function listBranches(root, currentBranch, limit = 40) {
    // `for-each-ref` 不解释 `%x1f`（那是 `git log --pretty` 的转义），
    // 用 Git ref 名里不可能出现的 `~|~` 作为字段分隔符。
    const result = await runGit(root, ['for-each-ref', '--sort=-committerdate', `--count=${Math.max(1, Math.min(200, limit))}`, '--format=%(refname:short)~|~%(objectname:short)~|~%(committerdate:iso-strict)', 'refs/heads'], { allowFail: true });
    if (result.code !== 0)
        return [];
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        const parts = line.split('~|~');
        return {
            name: parts[0] ?? '',
            short: parts[1] ?? '',
            date: parts[2] ?? '',
            current: (parts[0] ?? '') === currentBranch
        };
    })
        .filter((branch) => branch.name !== '');
}
export async function listWorktrees(root) {
    const result = await runGit(root, ['worktree', 'list', '--porcelain'], { allowFail: true });
    if (result.code !== 0)
        return [];
    const rootKey = normalize(root).toLowerCase();
    return result.stdout
        .split(/\r?\n\r?\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
        const item = {
            path: '',
            head: '',
            branch: '',
            detached: false,
            bare: false,
            locked: '',
            prunable: false,
            current: false
        };
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('worktree '))
                item.path = line.slice('worktree '.length);
            else if (line.startsWith('HEAD '))
                item.head = line.slice('HEAD '.length);
            else if (line.startsWith('branch '))
                item.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
            else if (line === 'detached')
                item.detached = true;
            else if (line === 'bare')
                item.bare = true;
            else if (line.startsWith('locked'))
                item.locked = line.slice('locked'.length).trim();
            else if (line.startsWith('prunable'))
                item.prunable = true;
        }
        item.current = normalize(item.path).toLowerCase() === rootKey;
        return item;
    })
        .filter((item) => item.path !== '');
}
function stripDiffPrefix(value) {
    const path = value.replace(/\t.*$/, '').trim();
    if (path.startsWith('a/') || path.startsWith('b/'))
        return path.slice(2);
    return path;
}
export function parsePatch(patch, maxFileChars = 2 * 1024 * 1024) {
    if (patch.trim() === '')
        return [];
    let text = patch.replace(/\r\n/g, '\n');
    // `git show` 的完整输出在 patch 前还有 commit 头；从第一个 diff 开始。
    const firstDiff = text.indexOf('diff --git ');
    if (firstDiff > 0)
        text = text.slice(firstDiff);
    const blocks = text.split(/^(?=diff --git )/m).filter((block) => block.trim() !== '');
    const files = [];
    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length === 0)
            continue;
        let oldPath = '';
        let newPath = '';
        let renameFrom = '';
        let renameTo = '';
        let status = 'M';
        let binary = false;
        for (const line of lines) {
            if (line.startsWith('--- ')) {
                const value = line.slice(4).trim();
                if (value !== '/dev/null')
                    oldPath = stripDiffPrefix(value);
            }
            else if (line.startsWith('+++ ')) {
                const value = line.slice(4).trim();
                if (value !== '/dev/null')
                    newPath = stripDiffPrefix(value);
            }
            else if (line.startsWith('new file mode '))
                status = 'A';
            else if (line.startsWith('deleted file mode '))
                status = 'D';
            else if (line.startsWith('rename from ')) {
                renameFrom = line.slice('rename from '.length);
                status = 'R';
            }
            else if (line.startsWith('rename to ')) {
                renameTo = line.slice('rename to '.length);
                status = 'R';
            }
            else if (line.startsWith('copy from '))
                status = 'C';
            else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
                binary = true;
        }
        if (newPath === '' && renameTo !== '')
            newPath = renameTo;
        if (oldPath === '' && renameFrom !== '')
            oldPath = renameFrom;
        const path = newPath || renameTo || oldPath || renameFrom || 'unknown';
        if (path === 'unknown' && !block.includes('diff --git'))
            continue;
        let additions = 0;
        let deletions = 0;
        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++'))
                additions += 1;
            else if (line.startsWith('-') && !line.startsWith('---'))
                deletions += 1;
        }
        const truncated = block.length > maxFileChars;
        files.push({
            path,
            oldPath: status === 'R' || status === 'C' ? oldPath || renameFrom : undefined,
            status,
            additions,
            deletions,
            binary,
            patch: truncated ? block.slice(0, maxFileChars) : block,
            truncated
        });
    }
    return files;
}
function newFilePatch(path, text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const hasFinalNewline = normalized.endsWith('\n');
    const body = hasFinalNewline ? normalized.slice(0, -1) : normalized;
    const lines = body === '' ? [] : body.split('\n');
    const header = [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        `+++ b/${path}`
    ];
    if (lines.length === 0)
        return header.join('\n') + '\n';
    const out = [...header, `@@ -0,0 +1,${lines.length} @@`];
    for (const line of lines)
        out.push(`+${line}`);
    if (!hasFinalNewline)
        out.push('\\ No newline at end of file');
    return out.join('\n') + '\n';
}
async function untrackedPatch(root, path) {
    try {
        const file = await readFileWithin(root, path, 512 * 1024);
        if (file.binary) {
            const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
            return {
                path,
                status: 'A',
                additions: 0,
                deletions: 0,
                binary: true,
                patch,
                truncated: false
            };
        }
        const patch = newFilePatch(path, file.text);
        const parsed = parsePatch(patch);
        return parsed[0];
    }
    catch {
        return undefined;
    }
}
export async function getDiff(root, options = {}) {
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    const path = options.path === undefined || options.path === '' ? undefined : safeRelative(root, options.path);
    const hasHead = (await runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--unified=3'];
    if (options.staged === true) {
        args.push('--cached');
    }
    else if (options.rev !== undefined && options.rev !== '') {
        if (!/^[0-9a-fA-F]{4,64}$/.test(options.rev))
            throw new GitError('bad-commit', '提交哈希格式不正确。');
        args.push(options.rev);
    }
    else if (hasHead) {
        args.push('HEAD');
    }
    if (path !== undefined)
        args.push('--', path);
    let patch = '';
    let truncated = false;
    try {
        const result = await runGit(root, args, { maxBytes, allowFail: true, timeoutMs: 30_000 });
        if (result.code === 0)
            patch = result.stdout;
        if (result.stdout.length >= maxBytes)
            truncated = true;
        // 还没有第一个提交时 `git diff` 只给未暂存差异；把暂存差异也带上。
        if (!hasHead && options.staged !== true && (options.rev === undefined || options.rev === '')) {
            const cached = await runGit(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--unified=3', ...(path !== undefined ? ['--', path] : [])], { maxBytes, allowFail: true, timeoutMs: 30_000 });
            if (cached.code === 0)
                patch = `${cached.stdout}${patch}`;
        }
    }
    catch (error) {
        if (error instanceof GitError && error.code === 'output-too-large') {
            truncated = true;
        }
        else {
            throw error;
        }
    }
    if (path !== undefined && options.staged !== true) {
        const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--', path], { allowFail: true });
        if (status.code === 0 && status.stdout.startsWith('??')) {
            const single = await untrackedPatch(root, path);
            if (single !== undefined)
                return { patch: single.patch, files: [single], truncated: false };
        }
    }
    else if (path === undefined && options.includeUntracked !== false && options.staged !== true) {
        const untracked = await untrackedFiles(root, 80);
        const extra = [];
        let extraBytes = 0;
        for (const item of untracked) {
            if (extraBytes >= 2 * 1024 * 1024) {
                truncated = true;
                break;
            }
            const single = await untrackedPatch(root, item);
            if (single === undefined)
                continue;
            extra.push(single.patch);
            extraBytes += single.patch.length;
        }
        if (extra.length > 0)
            patch = `${patch}${patch.endsWith('\n') || patch === '' ? '' : '\n'}${extra.join('')}`;
    }
    return {
        patch,
        files: parsePatch(patch),
        truncated
    };
}
export async function getCommitDetail(root, hash) {
    if (!/^[0-9a-fA-F]{4,64}$/.test(hash))
        throw new GitError('bad-commit', '提交哈希格式不正确。');
    const meta = await runGit(root, [
        'show',
        '-s',
        '--date=iso-strict',
        '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b',
        hash
    ]);
    const parts = meta.stdout.split('\x1f');
    const commit = {
        hash: parts[0] ?? hash,
        short: parts[1] ?? hash.slice(0, 7),
        author: parts[2] ?? '',
        email: parts[3] ?? '',
        date: parts[4] ?? '',
        subject: parts[5] ?? '',
        body: (parts[6] ?? '').trim(),
        files: [],
        patch: '',
        truncated: false
    };
    const diff = await runGit(root, ['show', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--unified=3', '--patch', hash], { maxBytes: 4 * 1024 * 1024, allowFail: true, timeoutMs: 30_000 });
    commit.patch = diff.stdout;
    commit.files = parsePatch(diff.stdout);
    commit.truncated = diff.stdout.length >= 4 * 1024 * 1024;
    return commit;
}
export async function getRepoState(root) {
    const statusResult = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], {
        allowFail: true,
        timeoutMs: 30_000
    });
    if (statusResult.code !== 0) {
        throw new GitError('not-a-repo', '无法读取 Git 状态。', statusResult.stderr.trim());
    }
    const parsed = parseStatus(statusResult.stdout);
    const headResult = await runGit(root, ['rev-parse', '--short', 'HEAD'], { allowFail: true });
    const head = headResult.code === 0 ? headResult.stdout.trim() : '';
    const hasHead = head !== '';
    const stats = new Map();
    const mergeNumstat = (raw) => {
        for (const [key, value] of parseNumstat(raw))
            stats.set(key, value);
    };
    if (hasHead) {
        const diff = await runGit(root, ['diff', 'HEAD', '--numstat', '-z', '-M'], { allowFail: true, timeoutMs: 30_000 });
        if (diff.code === 0)
            mergeNumstat(diff.stdout);
    }
    else {
        const cached = await runGit(root, ['diff', '--cached', '--numstat', '-z', '-M'], { allowFail: true });
        if (cached.code === 0)
            mergeNumstat(cached.stdout);
        const work = await runGit(root, ['diff', '--numstat', '-z', '-M'], { allowFail: true });
        if (work.code === 0)
            mergeNumstat(work.stdout);
    }
    const changes = [];
    for (const change of parsed.changes) {
        const stat = stats.get(change.path) ?? (change.oldPath !== undefined ? stats.get(change.oldPath) : undefined);
        let additions = stat?.additions ?? 0;
        let deletions = stat?.deletions ?? 0;
        let binary = stat?.binary ?? false;
        if (change.untracked) {
            const counted = await countTextLines(root, change.path);
            additions = counted.additions;
            binary = counted.binary;
            deletions = 0;
        }
        changes.push({
            ...change,
            additions,
            deletions,
            binary
        });
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));
    const branchName = parsed.branch || (parsed.detached ? 'HEAD' : '');
    const [commits, branches, worktrees] = await Promise.all([
        listCommits(root, 24),
        listBranches(root, branchName),
        listWorktrees(root)
    ]);
    const additions = changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
    return {
        repo: { root, name: basename(root) },
        branch: branchName,
        head,
        detached: parsed.detached,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        changes,
        commits,
        branches,
        worktrees,
        additions,
        deletions,
        changedFiles: changes.length
    };
}
/**
 * 判断补丁能否干净地落到当前工作树。
 * `git apply --check` 只校验，不写文件。
 */
export async function checkPatch(root, patch) {
    if (patch.trim() === '')
        return { applies: false, error: '补丁为空。' };
    try {
        const result = await runGit(root, ['apply', '--check', '--whitespace=nowarn', '-'], {
            input: patch.endsWith('\n') ? patch : `${patch}\n`,
            allowFail: true,
            timeoutMs: 30_000
        });
        if (result.code === 0)
            return { applies: true };
        return { applies: false, error: result.stderr.trim() || `git apply 退出码 ${result.code}` };
    }
    catch (error) {
        return {
            applies: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
export async function listRepositoryFiles(root, max = 4000) {
    const result = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { allowFail: true });
    if (result.code !== 0)
        return [];
    return result.stdout
        .split('\0')
        .filter(Boolean)
        .slice(0, max)
        .sort((left, right) => left.localeCompare(right));
}
export async function readRepositoryFile(root, path, maxBytes = 2 * 1024 * 1024) {
    const file = await readFileWithin(root, path, maxBytes);
    return { path: safeRelative(root, path), text: file.text, binary: file.binary, bytes: file.bytes };
}
export async function listDirectory(root, path = '') {
    const rel = path === '' ? '' : safeRelative(root, path);
    const absolute = resolve(root, rel);
    if (!isPathInside(root, absolute))
        throw new GitError('path-outside-repo', '路径不在仓库内。');
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries
        .filter((entry) => entry.name !== '.git')
        .slice(0, 1000)
        .map((entry) => ({
        name: entry.name,
        path: join(rel, entry.name).split(sep).join('/'),
        type: (entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other')
    }))
        .sort((left, right) => {
        if (left.type !== right.type)
            return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}
