/**
 * dsh-git-panel — 浏览器半区。
 *
 * 右侧栏 tab：工作树变更、历史、审批、工作树列表。
 *
 * 这份文件由宿主以 /plugins/dsh-git-panel/client.js 直接下发给浏览器，
 * 因此必须是经典脚本：不能出现 import/export，React 元素统一用
 * React.createElement 构造。
 */
;
window.__ModuleLoader__.load({
    id: 'dsh-git-panel',
    factory: (require) => {
        const bundleModule = { exports: {} };
        const React = require('react');
        const h = React.createElement;
        const PACKAGE = 'dsh-git-panel';
        const SERVICE = 'gitPanel';
        const TAB_ID = '@dsh/dsh-git-panel';
        const KIND = 'git';
        // ── 远程贡献 ─────────────────────────────────────────────────────────
        const codec = (symbol) => ({
            mode: 'strict',
            typeSymbol: symbol,
            create: () => ({ parse: (value) => value })
        });
        const REMOTE_METHODS = [
            ['reportOrigin', true],
            ['getState', true],
            ['getDiff', true],
            ['listCommits', true],
            ['getCommit', true],
            ['listReviews', true],
            ['getReview', true],
            ['listPending', false],
            ['decideReview', true]
        ];
        const CONTRIBUTION = {
            package: PACKAGE,
            descriptors: REMOTE_METHODS.map(([method, hasPayload]) => ({
                id: `${PACKAGE}#${SERVICE}/${method}`,
                service: SERVICE,
                namespace: SERVICE,
                method,
                invocation: { kind: 'direct' },
                parameters: hasPayload
                    ? [{ name: 'payload', wire: 'payload', source: 'json', codec: codec(`${PACKAGE}#${method}Payload`) }]
                    : [],
                result: codec(`${PACKAGE}#${method}Result`)
            }))
        };
        // ── 基础工具 ─────────────────────────────────────────────────────────
        function errorMessage(error) {
            if (error === null || error === undefined)
                return '未知错误';
            if (typeof error === 'string')
                return error;
            return error.message || error.code || String(error);
        }
        function formatTime(value) {
            if (value === undefined || value === null || value === '')
                return '-';
            const date = new Date(value);
            if (Number.isNaN(date.getTime()))
                return value;
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }
        function formatShortTime(value) {
            if (value === undefined || value === null || value === '')
                return '-';
            const date = new Date(value);
            if (Number.isNaN(date.getTime()))
                return value;
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }
        function statusInfo(status) {
            switch (status) {
                case 'A':
                    return { label: '新增', className: 'GITP_s_add', icon: 'A' };
                case '?':
                    return { label: '未跟踪', className: 'GITP_s_add', icon: '?' };
                case 'D':
                    return { label: '删除', className: 'GITP_s_del', icon: 'D' };
                case 'R':
                    return { label: '重命名', className: 'GITP_s_ren', icon: 'R' };
                case 'C':
                    return { label: '复制', className: 'GITP_s_ren', icon: 'C' };
                case 'U':
                    return { label: '冲突', className: 'GITP_s_conf', icon: 'U' };
                default:
                    return { label: '修改', className: 'GITP_s_mod', icon: 'M' };
            }
        }
        function reviewStatusInfo(status) {
            switch (status) {
                case 'approved':
                    return { label: '已通过', className: 'GITP_r_ok' };
                case 'rejected':
                    return { label: '需修改', className: 'GITP_r_bad' };
                case 'expired':
                    return { label: '已过期', className: 'GITP_r_muted' };
                default:
                    return { label: '待审批', className: 'GITP_r_pending' };
            }
        }
        function statsText(additions, deletions) {
            return `+${additions ?? 0} -${deletions ?? 0}`;
        }
        function pathLabel(path, max = 54) {
            if (path.length <= max)
                return path;
            const slash = path.lastIndexOf('/');
            if (slash < 0)
                return `…${path.slice(-max)}`;
            const name = path.slice(slash + 1);
            const dir = path.slice(0, slash);
            const keep = Math.max(8, max - name.length - 2);
            return `${dir.slice(0, keep)}…/${name}`;
        }
        function mergeReviewLists(primary, pending) {
            const map = new Map();
            for (const review of primary ?? [])
                if (review && review.id)
                    map.set(review.id, review);
            for (const review of pending ?? [])
                if (review && review.id)
                    map.set(review.id, review);
            return Array.from(map.values()).sort((left, right) => {
                if (left.status === 'pending' && right.status !== 'pending')
                    return -1;
                if (left.status !== 'pending' && right.status === 'pending')
                    return 1;
                return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
            });
        }
        function buildFileAddress(sessionId, path) {
            const encoded = String(path)
                .split('/')
                .filter((part) => part !== '')
                .map((part) => encodeURIComponent(part))
                .join('/');
            return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`;
        }
        function relativePath(fromDir, target) {
            const from = String(fromDir || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
            const to = String(target || '').replace(/\\/g, '/').split('/').filter(Boolean);
            let common = 0;
            while (common < from.length && common < to.length && from[common].toLowerCase() === to[common].toLowerCase())
                common += 1;
            return [...Array(Math.max(0, from.length - common)).fill('..'), ...to.slice(common)].join('/');
        }
        function openFileInEditor(tab, sessionId, path, baseDir, repoRoot) {
            if (!tab || !tab.actions || typeof tab.actions.openResource !== 'function' || sessionId === '' || path === '')
                return;
            try {
                // dsh-resource://file/session/<id>/<path> 的路径必须相对会话工作目录，
                // 而 diff 里的路径相对仓库根；两者在子目录会话里并不相同。
                const absolute = String(repoRoot || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
                const relative = relativePath(baseDir || repoRoot, absolute);
                tab.actions.openResource(buildFileAddress(sessionId, relative));
            }
            catch {
                // 文件已删除或路径不合法时保持当前页。
            }
        }
        // ── 审批提示音 ───────────────────────────────────────────────────────
        // 不引入音频文件：用 Web Audio 合成一个短促的双音提示。
        // 浏览器自动播放策略要求先有一次用户手势；和 whale-widget 一样，
        // 首次 pointerdown / keydown 时解锁 AudioContext。
        const SOUND_KEY = 'dsh-git-panel.sound';
        let soundEnabled = true;
        try {
            soundEnabled = localStorage.getItem(SOUND_KEY) !== 'off';
        }
        catch {
            soundEnabled = true;
        }
        let audioContext = null;
        let lastChimeAt = 0;
        function isSoundEnabled() {
            return soundEnabled;
        }
        function setSoundEnabled(value) {
            soundEnabled = value;
            try {
                localStorage.setItem(SOUND_KEY, value ? 'on' : 'off');
            }
            catch {
                // localStorage 不可用时只影响记忆。
            }
        }
        function ensureAudioContext() {
            if (typeof window === 'undefined')
                return null;
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (typeof Ctor !== 'function')
                return null;
            if (audioContext === null || audioContext.state === 'closed') {
                try {
                    audioContext = new Ctor({ latencyHint: 'interactive' });
                }
                catch {
                    audioContext = null;
                }
            }
            return audioContext;
        }
        function unlockAudio() {
            const ctx = ensureAudioContext();
            if (ctx !== null && ctx.state === 'suspended') {
                try {
                    void ctx.resume().catch(() => undefined);
                }
                catch {
                    // ignore
                }
            }
        }
        function installAudioUnlock() {
            if (typeof window === 'undefined')
                return () => undefined;
            const unlock = () => unlockAudio();
            window.addEventListener('pointerdown', unlock, { passive: true });
            window.addEventListener('keydown', unlock);
            return () => {
                window.removeEventListener('pointerdown', unlock);
                window.removeEventListener('keydown', unlock);
            };
        }
        function playReviewChime() {
            if (!soundEnabled)
                return;
            const now = Date.now();
            if (now - lastChimeAt < 900)
                return;
            lastChimeAt = now;
            const ctx = ensureAudioContext();
            if (ctx === null)
                return;
            const play = () => {
                try {
                    const start = ctx.currentTime + 0.02;
                    const notes = [
                        { frequency: 880, at: 0 },
                        { frequency: 1174.66, at: 0.14 }
                    ];
                    for (const note of notes) {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        const base = start + note.at;
                        osc.type = 'sine';
                        osc.frequency.setValueAtTime(note.frequency, base);
                        gain.gain.setValueAtTime(0.0001, base);
                        gain.gain.exponentialRampToValueAtTime(0.11, base + 0.012);
                        gain.gain.exponentialRampToValueAtTime(0.0001, base + 0.32);
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.start(base);
                        osc.stop(base + 0.34);
                    }
                }
                catch {
                    // 音频节点创建失败不该影响审批流程。
                }
            };
            if (ctx.state === 'suspended') {
                try {
                    void ctx.resume().then(play).catch(() => undefined);
                }
                catch {
                    // ignore
                }
            }
            else {
                play();
            }
        }
        // ── Diff 渲染 ────────────────────────────────────────────────────────
        function buildDiffRows(patch) {
            const text = (patch ?? '').replace(/\r\n/g, '\n');
            if (text.trim() === '')
                return { rows: [], truncated: false };
            const lines = text.split('\n');
            const max = 5000;
            const rows = [];
            let oldNo = 0;
            let newNo = 0;
            for (let index = 0; index < Math.min(lines.length, max); index += 1) {
                const line = lines[index];
                if (line.startsWith('@@')) {
                    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                    if (match !== null) {
                        oldNo = Number(match[1]);
                        newNo = Number(match[2]);
                    }
                    rows.push({ kind: 'hunk', oldNo: '', newNo: '', text: line });
                    continue;
                }
                if (line.startsWith('diff --git ') ||
                    line.startsWith('index ') ||
                    line.startsWith('--- ') ||
                    line.startsWith('+++ ') ||
                    line.startsWith('new file mode ') ||
                    line.startsWith('deleted file mode ') ||
                    line.startsWith('old mode ') ||
                    line.startsWith('new mode ') ||
                    line.startsWith('similarity index ') ||
                    line.startsWith('rename from ') ||
                    line.startsWith('rename to ') ||
                    line.startsWith('copy from ') ||
                    line.startsWith('copy to ') ||
                    line.startsWith('Binary files ') ||
                    line.startsWith('GIT binary patch') ||
                    line.startsWith('\\ No newline')) {
                    rows.push({ kind: 'meta', oldNo: '', newNo: '', text: line });
                    continue;
                }
                if (line.startsWith('+')) {
                    rows.push({ kind: 'add', oldNo: '', newNo: String(newNo), text: line });
                    newNo += 1;
                    continue;
                }
                if (line.startsWith('-')) {
                    rows.push({ kind: 'del', oldNo: String(oldNo), newNo: '', text: line });
                    oldNo += 1;
                    continue;
                }
                if (line.startsWith(' ')) {
                    rows.push({ kind: 'ctx', oldNo: String(oldNo), newNo: String(newNo), text: line });
                    oldNo += 1;
                    newNo += 1;
                    continue;
                }
                rows.push({ kind: 'meta', oldNo: '', newNo: '', text: line });
            }
            return { rows, truncated: lines.length > max };
        }
        function DiffView(props) {
            const file = props.file;
            const tab = props.tab;
            const sessionId = props.sessionId;
            const baseDir = props.baseDir;
            const repoRoot = props.repoRoot;
            const [wrap, setWrap] = React.useState(false);
            const built = React.useMemo(() => buildDiffRows(file && file.patch ? file.patch : ''), [file && file.patch]);
            if (file === undefined || file === null) {
                return h('div', { className: 'GITP_empty' }, props.emptyText || '没有可显示的差异');
            }
            const meta = statusInfo(file.status);
            return h('div', { className: 'GITP_diffBox' }, h('div', { className: 'GITP_diffBar' }, h('div', { className: 'GITP_diffTitle', title: file.path }, h('span', { className: 'GITP_sBadge ' + meta.className }, meta.icon), h('span', { className: 'GITP_diffPath' }, pathLabel(file.path, 42)), h('span', { className: 'GITP_diffStats' }, statsText(file.additions, file.deletions))), h('div', { className: 'GITP_diffTools' }, h('button', {
                type: 'button',
                className: 'GITP_linkBtn',
                onClick: () => setWrap(!wrap),
                title: wrap ? '不自动换行' : '自动换行'
            }, wrap ? '不换行' : '换行'), file.status !== 'D'
                ? h('button', { type: 'button', className: 'GITP_linkBtn', onClick: () => openFileInEditor(tab, sessionId, file.path, baseDir, repoRoot) }, '打开文件')
                : null)), file.binary
                ? h('div', { className: 'GITP_empty GITP_binary' }, '二进制文件，无法显示文本差异')
                : h('div', { className: 'GITP_diff' + (wrap ? ' GITP_wrap' : '') }, built.rows.map((row, index) => h('div', { className: `GITP_row GITP_${row.kind}`, key: index }, h('span', { className: 'GITP_ln' }, row.oldNo), h('span', { className: 'GITP_ln' }, row.newNo), h('span', { className: 'GITP_sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''), h('span', { className: 'GITP_code' }, row.text === '' ? ' ' : row.text))), built.truncated ? h('div', { className: 'GITP_truncated' }, '差异太大，只显示前 5000 行。') : null));
        }
        function MultiDiff(props) {
            const files = props.files ?? [];
            const [active, setActive] = React.useState(files[0] && files[0].path ? files[0].path : '');
            React.useEffect(() => {
                if (!files.some((file) => file.path === active))
                    setActive(files[0] && files[0].path ? files[0].path : '');
            }, [files, active]);
            if (files.length === 0)
                return h('div', { className: 'GITP_empty' }, props.emptyText || '没有文件差异');
            const file = files.find((item) => item.path === active) || files[0];
            return h('div', { className: 'GITP_multi' }, files.length > 1
                ? h('div', { className: 'GITP_fileChips' }, files.map((item) => {
                    const meta = statusInfo(item.status);
                    return h('button', {
                        type: 'button',
                        key: item.path,
                        className: 'GITP_chip' + (item.path === file.path ? ' GITP_chipOn' : ''),
                        title: item.path,
                        onClick: () => setActive(item.path)
                    }, h('span', { className: 'GITP_sBadge ' + meta.className }, meta.icon), pathLabel(item.path, 34));
                }))
                : null, h(DiffView, {
                file,
                tab: props.tab,
                sessionId: props.sessionId,
                baseDir: props.baseDir,
                repoRoot: props.repoRoot,
                emptyText: props.emptyText
            }));
        }
        // ── 图标 ─────────────────────────────────────────────────────────────
        function GitIcon(props) {
            const size = props && props.size ? props.size : 16;
            return h('svg', {
                width: size,
                height: size,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true
            }, h('circle', { cx: 6, cy: 5, r: 2.2 }), h('circle', { cx: 6, cy: 19, r: 2.2 }), h('circle', { cx: 18, cy: 8, r: 2.2 }), h('path', { d: 'M6 7.2v9.6' }), h('path', { d: 'M18 10.2c0 3.1-2.7 4.2-6 4.7' }));
        }
        function SoundIcon(props) {
            const muted = props && props.muted === true;
            return h('svg', {
                width: 15,
                height: 15,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true
            }, h('path', { d: 'M4 9v6h4l5 4V5L8 9H4z' }), muted
                ? h('path', { d: 'M17 9l4 6M21 9l-4 6' })
                : h('path', { d: 'M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12' }));
        }
        function HeaderGitButton(props) {
            const ctx = props.ctx;
            return h('button', {
                type: 'button',
                className: 'GITP_headerBtn',
                title: '打开 Git 面板',
                'aria-label': '打开 Git 面板',
                onClick: () => {
                    const sidebar = ctx?.get?.('sidebarRight');
                    if (sidebar === undefined)
                        return;
                    try {
                        const active = sidebar.active?.();
                        if (active !== undefined && active !== null && active.kind === KIND && sidebar.isExpanded?.() === true) {
                            sidebar.hide(active.id);
                            return;
                        }
                        sidebar.openTab(KIND);
                    }
                    catch {
                        // 没有会话面时忽略。
                    }
                }
            }, h(GitIcon, { size: 15 }));
        }
        function GitTitle(props) {
            const info = props.useTabInfo ? props.useTabInfo() : null;
            return h('span', { className: 'GITP_title' }, h(GitIcon, { size: 14 }), h('span', null, (info && info.tab && info.tab.title) || 'Git 变更'));
        }
        function IconButton(props) {
            return h('button', { type: 'button', className: 'GITP_iconBtn', title: props.title, onClick: props.onClick, disabled: props.disabled }, props.children);
        }
        // ── 主界面 ───────────────────────────────────────────────────────────
        function GitBody(props) {
            const api = props.api;
            const useTabInfo = props.useTabInfo || (() => null);
            const info = useTabInfo();
            const tab = info && info.tab ? info.tab : null;
            const navigation = tab && tab.navigation ? tab.navigation : null;
            const sessionId = props.sessionId || (tab && tab.sessionId) || '';
            const [state, setState] = React.useState(null);
            const [error, setError] = React.useState(null);
            const [view, setView] = React.useState('changes');
            const [repoOverride, setRepoOverride] = React.useState(() => {
                try {
                    return sessionId === '' ? '' : localStorage.getItem(`dsh-git-panel.repo.${sessionId}`) || '';
                }
                catch {
                    return '';
                }
            });
            const [editingRepo, setEditingRepo] = React.useState(false);
            const [repoInput, setRepoInput] = React.useState('');
            const [changeDiff, setChangeDiff] = React.useState(null);
            const [diffError, setDiffError] = React.useState(null);
            const [selectedPath, setSelectedPath] = React.useState('');
            const [selectedCommit, setSelectedCommit] = React.useState('');
            const [commitDetail, setCommitDetail] = React.useState(null);
            const [commitError, setCommitError] = React.useState(null);
            const [selectedReviewId, setSelectedReviewId] = React.useState('');
            const [reviewDetail, setReviewDetail] = React.useState(null);
            const [reviewError, setReviewError] = React.useState(null);
            const [comment, setComment] = React.useState('');
            const [deciding, setDeciding] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            const [refreshKey, setRefreshKey] = React.useState(0);
            const [toast, setToast] = React.useState('');
            const [soundOn, setSoundOn] = React.useState(() => isSoundEnabled());
            const toastTimer = React.useRef(null);
            const reviewStatusRef = React.useRef(null);
            const showToast = (message) => {
                setToast(message);
                if (toastTimer.current !== null)
                    clearTimeout(toastTimer.current);
                toastTimer.current = setTimeout(() => setToast(''), 3200);
            };
            React.useEffect(() => {
                return () => {
                    if (toastTimer.current !== null)
                        clearTimeout(toastTimer.current);
                };
            }, []);
            const loadState = React.useCallback(async (silent) => {
                if (!silent)
                    setBusy(true);
                try {
                    const data = await api.getState({ sessionId, repo: repoOverride || undefined });
                    setState(data);
                    setError(null);
                    return data;
                }
                catch (caught) {
                    setError(caught);
                    if (!silent)
                        setState(null);
                    return undefined;
                }
                finally {
                    if (!silent)
                        setBusy(false);
                }
            }, [api, sessionId, repoOverride]);
            React.useEffect(() => {
                let alive = true;
                const run = async () => {
                    try {
                        const data = await api.getState({ sessionId, repo: repoOverride || undefined });
                        if (!alive)
                            return;
                        setState(data);
                        setError(null);
                    }
                    catch (caught) {
                        if (alive)
                            setError(caught);
                    }
                };
                void run();
                const timer = setInterval(run, 5000);
                return () => {
                    alive = false;
                    clearInterval(timer);
                };
            }, [api, sessionId, repoOverride, refreshKey]);
            const reviews = React.useMemo(() => mergeReviewLists(state ? state.reviews : [], state ? state.pending : []), [state && state.reviews, state && state.pending]);
            const pendingCount = reviews.filter((review) => review.status === 'pending').length;
            React.useEffect(() => {
                if (view !== 'changes' || state === null)
                    return;
                let alive = true;
                setDiffError(null);
                api
                    .getDiff({ sessionId, repo: state.repo ? state.repo.root : undefined, staged: false })
                    .then((data) => {
                    if (!alive)
                        return;
                    setChangeDiff(data);
                    const files = data && data.files ? data.files : [];
                    setSelectedPath((current) => (files.some((file) => file.path === current) ? current : files[0] ? files[0].path : ''));
                })
                    .catch((caught) => {
                    if (alive)
                        setDiffError(caught);
                });
                return () => {
                    alive = false;
                };
            }, [api, view, state && state.repo && state.repo.root, state && state.head, state && state.changedFiles, refreshKey, sessionId]);
            React.useEffect(() => {
                if (view !== 'history' || selectedCommit === '')
                    return;
                let alive = true;
                setCommitError(null);
                setCommitDetail(null);
                api
                    .getCommit({ sessionId, repo: state && state.repo ? state.repo.root : undefined, hash: selectedCommit })
                    .then((data) => {
                    if (alive)
                        setCommitDetail(data && data.commit ? data.commit : null);
                })
                    .catch((caught) => {
                    if (alive)
                        setCommitError(caught);
                });
                return () => {
                    alive = false;
                };
            }, [api, view, selectedCommit, state && state.repo && state.repo.root, refreshKey, sessionId]);
            React.useEffect(() => {
                if (view !== 'reviews' || selectedReviewId === '')
                    return;
                let alive = true;
                setReviewError(null);
                setReviewDetail(null);
                reviewStatusRef.current = null;
                const run = async () => {
                    try {
                        const data = await api.getReview({ reviewId: selectedReviewId });
                        if (!alive)
                            return;
                        const detail = data && data.review ? { ...data.review, diffFiles: data.diffFiles || [] } : null;
                        reviewStatusRef.current = detail ? detail.status : null;
                        setReviewDetail(detail);
                    }
                    catch (caught) {
                        if (alive)
                            setReviewError(caught);
                    }
                };
                void run();
                const timer = setInterval(() => {
                    if (reviewStatusRef.current === 'pending')
                        void run();
                }, 5000);
                return () => {
                    alive = false;
                    clearInterval(timer);
                };
            }, [api, view, selectedReviewId, refreshKey]);
            // 外部 git reset / revert 后，原来打开的提交可能已不在当前分支。
            // 继续停在详情里会让人以为「刷新没反应」，这里自动退回历史列表。
            React.useEffect(() => {
                if (selectedCommit === '' || state === null)
                    return;
                const commits = Array.isArray(state.commits) ? state.commits : [];
                if (commits.length === 0) {
                    setSelectedCommit('');
                    showToast('当前分支没有提交，已返回历史列表');
                    return;
                }
                if (!commits.some((commit) => commit.hash === selectedCommit)) {
                    setSelectedCommit('');
                    showToast('该提交已不在当前分支，已返回历史列表');
                }
            }, [state && state.commits, selectedCommit]);
            React.useEffect(() => {
                const reviewId = navigation && navigation.params ? navigation.params.reviewId : undefined;
                if (typeof reviewId === 'string' && reviewId !== '') {
                    setView('reviews');
                    setSelectedReviewId(reviewId);
                }
            }, [navigation && navigation.revision, navigation && navigation.params && navigation.params.reviewId]);
            const applyRepo = () => {
                const value = repoInput.trim();
                setRepoOverride(value);
                try {
                    if (value === '')
                        localStorage.removeItem(`dsh-git-panel.repo.${sessionId}`);
                    else
                        localStorage.setItem(`dsh-git-panel.repo.${sessionId}`, value);
                }
                catch {
                    // localStorage 不可用时只影响记忆。
                }
                setEditingRepo(false);
                setChangeDiff(null);
                setSelectedPath('');
                setRefreshKey((value) => value + 1);
            };
            const chooseReview = (reviewId) => {
                setView('reviews');
                setSelectedReviewId(reviewId);
                setComment('');
            };
            const decide = async (approved) => {
                if (selectedReviewId === '' || deciding)
                    return;
                setDeciding(true);
                try {
                    await api.decideReview({ reviewId: selectedReviewId, approved, comment });
                    showToast(approved ? '已通过' : '已打回，等待 Agent 修改');
                    setComment('');
                    const data = await api.getReview({ reviewId: selectedReviewId });
                    const detail = data && data.review ? { ...data.review, diffFiles: data.diffFiles || [] } : null;
                    reviewStatusRef.current = detail ? detail.status : null;
                    setReviewDetail(detail);
                    await loadState(true);
                }
                catch (caught) {
                    showToast(errorMessage(caught));
                }
                finally {
                    setDeciding(false);
                }
            };
            const retry = () => {
                setError(null);
                setRefreshKey((value) => value + 1);
                void loadState(false);
            };
            const changeFiles = state && state.changes ? state.changes : [];
            const diffFiles = changeDiff && changeDiff.files ? changeDiff.files : [];
            const selectedDiffFile = diffFiles.find((file) => file.path === selectedPath) ||
                diffFiles.find((file) => changeFiles.some((change) => change.path === file.path)) ||
                diffFiles[0];
            const selectedCommitFiles = commitDetail && commitDetail.files ? commitDetail.files : [];
            const head = state && state.repo && state.repo.name ? state.repo.name : 'Git';
            const branch = state && state.branch ? state.branch : state && state.detached ? 'HEAD' : '';
            const branchMeta = state === null
                ? '读取中…'
                : state.detached
                    ? `detached HEAD ${state.head ? '· ' + state.head : ''}`
                    : [
                        branch || '(未知分支)',
                        state.upstream ? '→ ' + state.upstream : '',
                        state.ahead ? '领先 ' + state.ahead : '',
                        state.behind ? '落后 ' + state.behind : ''
                    ]
                        .filter(Boolean)
                        .join('  ');
            const renderHeader = () => h('div', { className: 'GITP_head' }, h('div', { className: 'GITP_headTop' }, h('div', { className: 'GITP_repoTitle', title: state && state.repo ? state.repo.root : '' }, h('span', { className: 'GITP_repoIcon' }, h(GitIcon, { size: 15 })), h('span', { className: 'GITP_repoName' }, head), h('span', { className: 'GITP_branchPill' }, branch || '—')), h('div', { className: 'GITP_headActions' }, h(IconButton, {
                title: soundOn ? '审批提示音：开' : '审批提示音：关',
                onClick: () => {
                    const next = !soundOn;
                    setSoundEnabled(next);
                    setSoundOn(next);
                    if (next)
                        playReviewChime();
                }
            }, h(SoundIcon, { muted: !soundOn })), h(IconButton, { title: '刷新', onClick: retry, disabled: busy }, busy ? '…' : '↻'), h(IconButton, {
                title: editingRepo ? '取消修改仓库' : '修改仓库路径',
                onClick: () => {
                    setRepoInput(repoOverride || (state && state.repo ? state.repo.root : '') || '');
                    setEditingRepo(!editingRepo);
                }
            }, '⌂'))), editingRepo
                ? h('div', { className: 'GITP_repoEdit' }, h('input', {
                    className: 'GITP_input',
                    value: repoInput,
                    autoFocus: true,
                    placeholder: '仓库绝对路径，留空回到会话工作目录',
                    onChange: (event) => setRepoInput(event.target.value),
                    onKeyDown: (event) => {
                        if (event.key === 'Enter')
                            applyRepo();
                        if (event.key === 'Escape')
                            setEditingRepo(false);
                    }
                }), h('button', { type: 'button', className: 'GITP_primaryBtn', onClick: applyRepo }, '应用'))
                : h('div', { className: 'GITP_pathRow' }, h('span', { className: 'GITP_path', title: state && state.repo ? state.repo.root : '' }, (state && state.repo && state.repo.root) || '—'), h('span', { className: 'GITP_branchMeta' }, branchMeta)), h('div', { className: 'GITP_tabs' }, [
                ['changes', '变更' + (changeFiles.length > 0 ? ' ' + changeFiles.length : '')],
                ['history', '历史'],
                ['reviews', '审批' + (pendingCount > 0 ? ' ' + pendingCount : '')],
                ['worktrees', '工作树']
            ].map((entry) => h('button', {
                type: 'button',
                key: entry[0],
                className: 'GITP_tab' + (view === entry[0] ? ' GITP_tabOn' : ''),
                onClick: () => setView(entry[0])
            }, entry[1]))));
            const renderChanges = () => h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_summaryRow' }, h('span', null, changeFiles.length + ' 个文件'), h('span', { className: 'GITP_addText' }, '+' + (state ? state.additions || 0 : 0)), h('span', { className: 'GITP_delText' }, '-' + (state ? state.deletions || 0 : 0)), changeDiff && changeDiff.truncated ? h('span', { className: 'GITP_warnText' }, 'diff 已截断') : null), changeFiles.length === 0
                ? h('div', { className: 'GITP_empty' }, h('div', { className: 'GITP_emptyTitle' }, '工作树干净'), h('div', { className: 'GITP_emptyHint' }, '没有未提交的变更。Agent 提交补丁后会出现在「审批」里。'))
                : h('div', { className: 'GITP_fileList' }, changeFiles.map((change) => {
                    const meta = statusInfo(change.status);
                    return h('button', {
                        type: 'button',
                        key: change.path,
                        className: 'GITP_fileRow' + (selectedDiffFile && selectedDiffFile.path === change.path ? ' GITP_fileRowOn' : ''),
                        title: change.path,
                        onClick: () => setSelectedPath(change.path)
                    }, h('span', { className: 'GITP_sBadge ' + meta.className }, meta.icon), h('span', { className: 'GITP_fileName' }, pathLabel(change.path, 60), change.oldPath ? h('span', { className: 'GITP_oldPath' }, ' ← ' + change.oldPath) : null), h('span', { className: 'GITP_fileFlags' }, change.staged ? h('span', { className: 'GITP_flag' }, '暂存') : null, change.untracked ? h('span', { className: 'GITP_flag' }, '未跟踪') : null), h('span', { className: 'GITP_fileStats' }, statsText(change.additions, change.deletions)));
                })), diffError !== null ? h('div', { className: 'GITP_empty GITP_err' }, errorMessage(diffError)) : null, changeDiff === null && diffError === null ? h('div', { className: 'GITP_loading' }, '正在读取 diff…') : null, selectedDiffFile
                ? h(DiffView, {
                    file: selectedDiffFile,
                    tab,
                    sessionId,
                    baseDir: (state && state.cwd) || (state && state.repo && state.repo.root) || '',
                    repoRoot: (state && state.repo && state.repo.root) || '',
                    emptyText: '这个文件没有可显示的文本差异'
                })
                : null);
            const renderHistory = () => {
                const commits = state && state.commits ? state.commits : [];
                if (selectedCommit !== '') {
                    return h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_subHead' }, h('button', { type: 'button', className: 'GITP_linkBtn', onClick: () => setSelectedCommit('') }, '← 提交列表'), h('span', { className: 'GITP_hash' }, (commitDetail && commitDetail.short) || selectedCommit.slice(0, 7))), commitError !== null
                        ? h('div', { className: 'GITP_empty GITP_err' }, errorMessage(commitError))
                        : commitDetail === null
                            ? h('div', { className: 'GITP_loading' }, '正在读取提交…')
                            : h('div', null, h('div', { className: 'GITP_commitTitle' }, commitDetail.subject || '(无提交信息)'), h('div', { className: 'GITP_commitMeta' }, commitDetail.author + ' · ' + formatTime(commitDetail.date)), commitDetail.body ? h('div', { className: 'GITP_commitBody' }, commitDetail.body) : null, h('div', { className: 'GITP_summaryRow' }, h('span', null, selectedCommitFiles.length + ' 个文件'), h('span', { className: 'GITP_addText' }, '+' + selectedCommitFiles.reduce((sum, file) => sum + (file.additions || 0), 0)), h('span', { className: 'GITP_delText' }, '-' + selectedCommitFiles.reduce((sum, file) => sum + (file.deletions || 0), 0))), h(MultiDiff, {
                                files: selectedCommitFiles,
                                tab,
                                sessionId,
                                baseDir: (state && state.cwd) || (state && state.repo && state.repo.root) || '',
                                repoRoot: (state && state.repo && state.repo.root) || '',
                                emptyText: '这个提交没有文件差异'
                            })));
                }
                if (commits.length === 0)
                    return h('div', { className: 'GITP_empty' }, '还没有提交。');
                return h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_summaryRow' }, h('span', null, '最近 ' + commits.length + ' 次提交')), h('div', { className: 'GITP_commitList' }, commits.map((commit) => h('button', { type: 'button', key: commit.hash, className: 'GITP_commitRow', onClick: () => setSelectedCommit(commit.hash) }, h('span', { className: 'GITP_hash' }, commit.short), h('span', { className: 'GITP_commitSubject' }, commit.subject || '(无提交信息)'), h('span', { className: 'GITP_commitBy' }, commit.author + ' · ' + formatShortTime(commit.date))))));
            };
            const renderReviews = () => {
                if (selectedReviewId !== '') {
                    const detail = reviewDetail;
                    const status = detail ? detail.status : 'pending';
                    const meta = reviewStatusInfo(status);
                    return h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_subHead' }, h('button', { type: 'button', className: 'GITP_linkBtn', onClick: () => setSelectedReviewId('') }, '← 审批列表'), h('span', { className: 'GITP_reviewStatus ' + meta.className }, meta.label)), reviewError !== null
                        ? h('div', { className: 'GITP_empty GITP_err' }, errorMessage(reviewError))
                        : detail === null
                            ? h('div', { className: 'GITP_loading' }, '正在读取审批单…')
                            : h('div', { className: 'GITP_reviewDetail' }, h('div', { className: 'GITP_reviewTitle' }, detail.title), detail.description ? h('div', { className: 'GITP_reviewDesc' }, detail.description) : null, h('div', { className: 'GITP_reviewMeta' }, h('span', null, '仓库：' + (detail.repoName || detail.repoRoot)), h('span', null, '基准：' + detail.base), h('span', null, formatTime(detail.createdAt)), h('span', { className: 'GITP_addText' }, '+' + (detail.additions || 0)), h('span', { className: 'GITP_delText' }, '-' + (detail.deletions || 0))), detail.source === 'worktree'
                                ? h('div', { className: 'GITP_applyOk' }, '来自当前工作区：变更已在工作树中，审批只标记状态')
                                : detail.applies
                                    ? h('div', { className: 'GITP_applyOk' }, '补丁可干净应用到当前工作树')
                                    : h('div', { className: 'GITP_applyWarn' }, '补丁不能直接应用到当前工作树（可能已应用、上下文变化或仅用于展示）。', detail.applyError ? h('div', { className: 'GITP_applyErrText' }, detail.applyError) : null), status === 'pending'
                                ? h('div', { className: 'GITP_actionBar' }, h('textarea', {
                                    className: 'GITP_comment',
                                    value: comment,
                                    placeholder: '给 Agent 的意见（可选）：为什么通过 / 哪里需要改',
                                    onChange: (event) => setComment(event.target.value)
                                }), h('div', { className: 'GITP_actionRow' }, h('button', { type: 'button', className: 'GITP_dangerBtn', disabled: deciding, onClick: () => void decide(false) }, deciding ? '提交中…' : '需要修改'), h('button', { type: 'button', className: 'GITP_primaryBtn', disabled: deciding, onClick: () => void decide(true) }, deciding ? '提交中…' : '通过')))
                                : h('div', { className: 'GITP_decisionBox' }, h('div', { className: 'GITP_decisionTitle' }, meta.label), detail.comment ? h('div', { className: 'GITP_decisionComment' }, detail.comment) : null, h('div', { className: 'GITP_commitMeta' }, detail.decidedAt ? '决定时间：' + formatTime(detail.decidedAt) : '')), h(MultiDiff, {
                                files: detail.diffFiles || detail.files || [],
                                tab,
                                sessionId,
                                baseDir: (state && state.cwd) || (state && state.repo && state.repo.root) || '',
                                repoRoot: detail.repoRoot || (state && state.repo && state.repo.root) || '',
                                emptyText: '审批单没有文件差异'
                            })));
                }
                if (reviews.length === 0) {
                    return h('div', { className: 'GITP_empty' }, h('div', { className: 'GITP_emptyTitle' }, '还没有审批单'), h('div', { className: 'GITP_emptyHint' }, 'Agent 调用 git_panel_submit 提交补丁后，这里会出现待审批的变更。'));
                }
                return h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_summaryRow' }, h('span', null, pendingCount + ' 个待审批'), h('span', null, reviews.length + ' 个审批单')), h('div', { className: 'GITP_reviewList' }, reviews.map((review) => {
                    const meta = reviewStatusInfo(review.status);
                    return h('button', { type: 'button', key: review.id, className: 'GITP_reviewRow', onClick: () => chooseReview(review.id) }, h('span', { className: 'GITP_reviewRowTop' }, h('span', { className: 'GITP_reviewStatus ' + meta.className }, meta.label), h('span', { className: 'GITP_reviewTime' }, formatShortTime(review.createdAt))), h('span', { className: 'GITP_reviewRowTitle' }, review.title), h('span', { className: 'GITP_reviewRowMeta' }, h('span', null, review.repoName || review.repoRoot), review.source === 'worktree' ? h('span', { className: 'GITP_flag' }, '工作区') : null, h('span', null, (review.fileCount || 0) + ' 个文件'), h('span', { className: 'GITP_addText' }, '+' + (review.additions || 0)), h('span', { className: 'GITP_delText' }, '-' + (review.deletions || 0))));
                })));
            };
            const renderWorktrees = () => {
                const worktrees = state && state.worktrees ? state.worktrees : [];
                if (worktrees.length === 0)
                    return h('div', { className: 'GITP_empty' }, '没有登记的工作树。');
                return h('div', { className: 'GITP_view' }, h('div', { className: 'GITP_summaryRow' }, h('span', null, worktrees.length + ' 个工作树')), h('div', { className: 'GITP_wtList' }, worktrees.map((worktree) => h('div', { className: 'GITP_wtRow' + (worktree.current ? ' GITP_wtCurrent' : ''), key: worktree.path }, h('div', { className: 'GITP_wtTop' }, h('span', { className: 'GITP_wtBranch' }, worktree.branch || (worktree.detached ? 'detached HEAD' : '(bare)')), worktree.current ? h('span', { className: 'GITP_flag' }, '当前') : null), h('div', { className: 'GITP_wtPath', title: worktree.path }, worktree.path), h('div', { className: 'GITP_wtMeta' }, h('span', { className: 'GITP_hash' }, (worktree.head || '').slice(0, 8)), worktree.locked ? h('span', { className: 'GITP_warnText' }, '已锁定') : null, worktree.prunable ? h('span', { className: 'GITP_warnText' }, '可清理') : null)))));
            };
            const renderError = () => h('div', { className: 'GITP_errorPanel' }, h('div', { className: 'GITP_errorTitle' }, '无法读取 Git 仓库'), h('div', { className: 'GITP_errorText' }, errorMessage(error)), h('div', { className: 'GITP_errorHint' }, '当前会话的工作目录可能不是 Git 仓库。可以在右上角 ⌂ 里填写仓库绝对路径，或把会话切到仓库目录。'), h('button', { type: 'button', className: 'GITP_primaryBtn', onClick: retry }, '重试'));
            return h('div', { className: 'GITP_root' }, renderHeader(), h('div', { className: 'GITP_body' }, error !== null && state === null
                ? renderError()
                : state === null
                    ? h('div', { className: 'GITP_loading' }, '正在读取仓库…')
                    : view === 'changes'
                        ? renderChanges()
                        : view === 'history'
                            ? renderHistory()
                            : view === 'reviews'
                                ? renderReviews()
                                : renderWorktrees()), toast !== '' ? h('div', { className: 'GITP_toast' }, toast) : null);
        }
        // ── 深链接与自动打开 ─────────────────────────────────────────────────
        function openGitTab(ctx, reviewId) {
            const sidebar = ctx.get('sidebarRight');
            if (sidebar === undefined)
                return false;
            try {
                sidebar.openTab(KIND, reviewId ? { params: { reviewId } } : {});
                return true;
            }
            catch {
                return false;
            }
        }
        function openGitTabWithRetry(ctx, reviewId, attempt) {
            if (openGitTab(ctx, reviewId))
                return;
            if (attempt >= 20)
                return;
            setTimeout(() => openGitTabWithRetry(ctx, reviewId, attempt + 1), 200);
        }
        function consumeUrlIntent(ctx) {
            if (typeof window === 'undefined' || window.location === undefined)
                return;
            const params = new URLSearchParams(window.location.search);
            const reviewId = params.get('dsh-git');
            if (reviewId === null || reviewId === '')
                return;
            try {
                const url = new URL(window.location.href);
                url.searchParams.delete('dsh-git');
                window.history.replaceState(null, '', url.toString());
            }
            catch {
                // 清不掉参数不影响打开。
            }
            openGitTabWithRetry(ctx, reviewId, 0);
        }
        function installLinkHandler(ctx) {
            if (typeof document === 'undefined')
                return () => undefined;
            const onClick = (event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                    return;
                const target = event.target;
                if (target === null || target === undefined || typeof target.closest !== 'function')
                    return;
                const anchor = target.closest('a[href]');
                if (anchor === null)
                    return;
                let url;
                try {
                    url = new URL(anchor.getAttribute('href'), window.location.origin);
                }
                catch {
                    return;
                }
                const reviewId = url.searchParams.get('dsh-git');
                if (reviewId === null || reviewId === '')
                    return;
                event.preventDefault();
                event.stopPropagation();
                openGitTabWithRetry(ctx, reviewId, 0);
            };
            document.addEventListener('click', onClick, true);
            return () => document.removeEventListener('click', onClick, true);
        }
        function startPendingWatch(ctx, api) {
            let stopped = false;
            const seen = new Set();
            const tick = async () => {
                if (stopped)
                    return;
                try {
                    const data = await api.listPending();
                    const list = data && data.reviews ? data.reviews : [];
                    const ids = new Set(list.map((review) => review.id));
                    Array.from(seen).forEach((id) => {
                        if (!ids.has(id))
                            seen.delete(id);
                    });
                    const fresh = list.filter((review) => !seen.has(review.id));
                    if (fresh.length > 0) {
                        for (const review of fresh)
                            seen.add(review.id);
                        playReviewChime();
                        openGitTabWithRetry(ctx, fresh[0].id, 0);
                    }
                }
                catch {
                    // 宿主尚未就绪或当前没有会话，下一轮再试。
                }
            };
            const initial = setTimeout(() => void tick(), 900);
            const timer = setInterval(() => void tick(), 2500);
            return () => {
                stopped = true;
                clearTimeout(initial);
                clearInterval(timer);
            };
        }
        // ── 样式 ─────────────────────────────────────────────────────────────
        const CSS = `
.GITP_root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.55;background:transparent}
.GITP_head{padding:10px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.GITP_headTop{display:flex;align-items:center;gap:8px;min-width:0}
.GITP_repoTitle{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.GITP_repoIcon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.GITP_repoName{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.GITP_branchPill{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:170px;overflow:hidden;text-overflow:ellipsis}
.GITP_headActions{display:flex;gap:2px;flex:none}
.GITP_iconBtn{width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px}
.GITP_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.GITP_iconBtn:disabled{opacity:.5;cursor:default}
.GITP_pathRow{display:flex;flex-direction:column;gap:1px;margin-top:4px;min-width:0}
.GITP_path{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.GITP_branchMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.GITP_repoEdit{display:flex;gap:6px;margin-top:6px}
.GITP_input{flex:1;min-width:0;font:inherit;font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.GITP_tabs{display:flex;gap:2px;margin-top:8px;overflow-x:auto;scrollbar-width:none}
.GITP_tabs::-webkit-scrollbar{display:none}
.GITP_tab{font:inherit;font-size:12px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);padding:6px 9px;border-radius:8px 8px 0 0;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent}
.GITP_tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.GITP_tabOn{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}
.GITP_body{flex:1;min-height:0;overflow:auto;padding:0 0 20px}
.GITP_view{display:flex;flex-direction:column;gap:8px;padding:10px 12px 0}
.GITP_summaryRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.GITP_addText{color:var(--dsw-alias-state-success-primary,#2e7d32);font-variant-numeric:tabular-nums}
.GITP_delText{color:var(--dsw-alias-state-error-primary,#c62828);font-variant-numeric:tabular-nums}
.GITP_warnText{color:var(--dsw-alias-state-warning-primary,#b26a00)}
.GITP_fileList,.GITP_commitList,.GITP_reviewList,.GITP_wtList{display:flex;flex-direction:column;gap:2px}
.GITP_fileRow{display:grid;grid-template-columns:20px minmax(0,1fr) auto auto;align-items:center;gap:6px;width:100%;text-align:left;font:inherit;font-size:12px;padding:5px 6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.GITP_fileRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.GITP_fileRowOn{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2)}
.GITP_fileName{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.GITP_oldPath{color:var(--dsw-alias-label-tertiary);font-size:11px}
.GITP_fileFlags{display:flex;gap:3px}
.GITP_flag{font-size:10px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.GITP_fileStats{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.GITP_sBadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:5px;font-size:10px;font-weight:700;flex:none}
.GITP_s_mod{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-state-business-primary)}
.GITP_s_add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 16%,transparent);color:var(--dsw-alias-state-success-primary,#2e7d32)}
.GITP_s_del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 16%,transparent);color:var(--dsw-alias-state-error-primary,#c62828)}
.GITP_s_ren{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b26a00) 16%,transparent);color:var(--dsw-alias-state-warning-primary,#b26a00)}
.GITP_s_conf{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 22%,transparent);color:var(--dsw-alias-state-error-primary,#c62828)}
.GITP_diffBox{margin-top:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.GITP_diffBar{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.GITP_diffTitle{display:flex;align-items:center;gap:6px;min-width:0}
.GITP_diffPath{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;font-weight:600}
.GITP_diffStats{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.GITP_diffTools{display:flex;gap:2px;flex:none}
.GITP_linkBtn{font:inherit;font-size:11px;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);cursor:pointer;padding:3px 5px;border-radius:5px;white-space:nowrap}
.GITP_linkBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.GITP_diff{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:11px;line-height:1.55;overflow:auto;max-height:56vh;padding:4px 0}
.GITP_row{display:grid;grid-template-columns:34px 34px 16px minmax(0,1fr);min-width:max-content}
.GITP_ln{color:var(--dsw-alias-label-tertiary);text-align:right;padding-right:6px;user-select:none;font-variant-numeric:tabular-nums;font-size:10px}
.GITP_sign{text-align:center;color:var(--dsw-alias-label-tertiary);user-select:none}
.GITP_code{white-space:pre;padding-right:10px}
.GITP_wrap .GITP_code{white-space:pre-wrap;word-break:break-all}
.GITP_add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 11%,transparent)}
.GITP_del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 11%,transparent)}
.GITP_hunk{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-label-secondary)}
.GITP_meta{color:var(--dsw-alias-label-tertiary)}
.GITP_truncated,.GITP_binary{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.GITP_multi{display:flex;flex-direction:column;gap:6px;min-width:0}
.GITP_fileChips{display:flex;gap:4px;overflow-x:auto;padding:2px 0;scrollbar-width:thin}
.GITP_chip{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:10.5px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 8px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.GITP_chipOn{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.GITP_commitRow{display:grid;grid-template-columns:64px minmax(0,1fr);grid-template-rows:auto auto;gap:1px 6px;text-align:left;font:inherit;padding:6px 7px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.GITP_commitRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.GITP_hash{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.GITP_commitSubject{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.GITP_commitBy{grid-column:2;font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.GITP_commitTitle{font-size:13px;font-weight:600;margin-top:2px}
.GITP_commitMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.GITP_commitBody{white-space:pre-wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:6px 8px;margin-top:4px;max-height:140px;overflow:auto}
.GITP_subHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0}
.GITP_reviewRow{display:flex;flex-direction:column;gap:2px;text-align:left;font:inherit;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.GITP_reviewRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.GITP_reviewRowTop{display:flex;align-items:center;justify-content:space-between;gap:6px}
.GITP_reviewStatus{font-size:10px;padding:1px 7px;border-radius:999px;white-space:nowrap;font-weight:600}
.GITP_r_pending{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b26a00) 15%,transparent);color:var(--dsw-alias-state-warning-primary,#b26a00)}
.GITP_r_ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 15%,transparent);color:var(--dsw-alias-state-success-primary,#2e7d32)}
.GITP_r_bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 15%,transparent);color:var(--dsw-alias-state-error-primary,#c62828)}
.GITP_r_muted{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}
.GITP_reviewTime{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.GITP_reviewRowTitle{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.GITP_reviewRowMeta{display:flex;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.GITP_reviewDetail{display:flex;flex-direction:column;gap:7px;min-width:0}
.GITP_reviewTitle{font-size:14px;font-weight:650;line-height:1.35}
.GITP_reviewDesc{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;background:var(--dsw-alias-bg-layer-1);border-radius:7px;padding:7px 8px}
.GITP_reviewMeta{display:flex;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.GITP_applyOk{font-size:10.5px;color:var(--dsw-alias-state-success-primary,#2e7d32);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 9%,transparent);border-radius:6px;padding:5px 7px}
.GITP_applyWarn{font-size:10.5px;color:var(--dsw-alias-state-warning-primary,#b26a00);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b26a00) 9%,transparent);border-radius:6px;padding:5px 7px}
.GITP_applyErrText{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;font-size:10px;max-height:70px;overflow:auto;white-space:pre-wrap}
.GITP_actionBar{margin:10px 0 4px;padding:10px 0 4px;background:transparent;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px;flex:none}
.GITP_comment{width:100%;box-sizing:border-box;min-height:52px;max-height:140px;resize:vertical;font:inherit;font-size:11.5px;line-height:1.5;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.GITP_actionRow{display:flex;gap:8px;justify-content:flex-end}
.GITP_primaryBtn,.GITP_dangerBtn{font:inherit;font-size:12px;font-weight:600;border-radius:7px;padding:5px 14px;cursor:pointer;border:1px solid transparent}
.GITP_primaryBtn{background:var(--dsw-alias-state-business-primary);color:#fff}
.GITP_primaryBtn:hover{filter:brightness(1.06)}
.GITP_dangerBtn{background:transparent;color:var(--dsw-alias-state-error-primary,#c62828);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 45%,transparent)}
.GITP_dangerBtn:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 10%,transparent)}
.GITP_primaryBtn:disabled,.GITP_dangerBtn:disabled{opacity:.55;cursor:default}
.GITP_decisionBox{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);margin-top:6px}
.GITP_decisionTitle{font-size:12px;font-weight:600}
.GITP_decisionComment{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin-top:4px}
.GITP_wtRow{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:2px}
.GITP_wtCurrent{border-color:var(--dsw-alias-state-business-primary)}
.GITP_wtTop{display:flex;align-items:center;justify-content:space-between;gap:6px}
.GITP_wtBranch{font-size:12px;font-weight:600}
.GITP_wtPath{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.GITP_wtMeta{display:flex;gap:8px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.GITP_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;text-align:center;padding:34px 18px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.GITP_emptyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.GITP_emptyHint{max-width:260px;line-height:1.55}
.GITP_loading{padding:26px 14px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.GITP_err{color:var(--dsw-alias-state-error-primary,#c62828)}
.GITP_errorPanel{display:flex;flex-direction:column;gap:8px;padding:20px 16px;color:var(--dsw-alias-label-secondary)}
.GITP_errorTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.GITP_errorText{font-size:11.5px;color:var(--dsw-alias-state-error-primary,#c62828);white-space:pre-wrap;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 8%,transparent);border-radius:7px;padding:7px 8px}
.GITP_errorHint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.GITP_toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(420px,86vw);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:7px 12px;font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);z-index:50}
.GITP_title{display:inline-flex;align-items:center;gap:5px;min-width:0}
.GITP_headerBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.GITP_headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.GITP_headerBtn:active{background:var(--dsw-alias-bg-layer-3)}
`;
        // ── 插件体 ───────────────────────────────────────────────────────────
        const inject = ['slots', 'remote', 'sidebarRight', 'sidebarRightTabs'];
        function apply(ctx) {
            ctx.effect(() => {
                const style = document.createElement('style');
                style.dataset.dshPlugin = PACKAGE;
                style.textContent = CSS;
                document.head.appendChild(style);
                return () => style.remove();
            }, `${PACKAGE}: styles`);
            const mount = ctx.remote.$mount(CONTRIBUTION);
            const call = async (method, payload) => {
                await mount;
                const remote = ctx.get(`remote.${SERVICE}`);
                if (remote === undefined)
                    throw new Error('gitPanel 远程服务不可用，请确认插件已启用');
                const result = payload === undefined ? await remote[method]() : await remote[method](payload);
                if (result === null || typeof result !== 'object' || result.ok !== true) {
                    const detail = result ? result.error : undefined;
                    const error = new Error(detail === undefined ? `${method} 调用失败` : `${detail.code || 'ERROR'}: ${detail.message || ''}`);
                    error.code = detail ? detail.code : undefined;
                    throw error;
                }
                return result.value;
            };
            const api = {
                reportOrigin: (payload) => call('reportOrigin', payload),
                getState: (payload) => call('getState', payload),
                getDiff: (payload) => call('getDiff', payload),
                listCommits: (payload) => call('listCommits', payload),
                getCommit: (payload) => call('getCommit', payload),
                listReviews: (payload) => call('listReviews', payload),
                getReview: (payload) => call('getReview', payload),
                listPending: () => call('listPending'),
                decideReview: (payload) => call('decideReview', payload)
            };
            ctx.effect(() => {
                if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null') {
                    void api.reportOrigin({ origin: window.location.origin }).catch(() => undefined);
                }
                consumeUrlIntent(ctx);
                return installLinkHandler(ctx);
            }, `${PACKAGE}: deep link`);
            ctx.effect(() => installAudioUnlock(), `${PACKAGE}: audio unlock`);
            ctx.effect(() => startPendingWatch(ctx, api), `${PACKAGE}: pending watch`);
            ctx.effect(() => ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: KIND,
                priority: 'extension',
                title: () => 'Git 变更',
                guide: [
                    {
                        id: 'git',
                        order: 30,
                        title: () => 'Git 变更',
                        description: () => '查看本地工作树、历史，并审批 Agent 提交的补丁',
                        icon: GitIcon
                    }
                ]
            }), `${PACKAGE}: tab type`);
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ api, ctx }) }, GitBody)), `${PACKAGE}: tab body`);
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, GitTitle)), `${PACKAGE}: tab title`);
            // 会话标题栏右侧的快捷入口，位置与 forge（变更请求）图标同一排。
            ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
                name: 'conversation.session.header.utilities',
                id: 'git-panel.quick',
                order: -9,
                inject: () => ({ ctx })
            }, HeaderGitButton)), `${PACKAGE}: header quick open`);
        }
        bundleModule.exports.apply = apply;
        bundleModule.exports.inject = inject;
        return bundleModule.exports;
    }
});
