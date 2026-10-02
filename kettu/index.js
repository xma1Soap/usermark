(() => {
    "use strict";

    const { patcher, metro, ui, utils, plugin, logger, storage: vdStorage } = vendetta;
    const React = metro.common.React;
    const Forms = ui.components.Forms;

    const unpatches = [];

    /* ================= 存储 =================
       plugin.storage 是 MMKV 后端的响应式代理，写入即落盘。
       初始化未完成时读取会抛错，这里全部兜住。 */

    const SOURCE_CONTENT_LIMIT = 140;

    /** 从消息对象提一份精简副本，长文本截断，避免撑爆存储 */
    function sourceFromMessage(message) {
        if (!message || !message.id) return undefined;

        const raw = typeof message.content === "string" ? message.content.trim() : "";
        const truncated = raw
            ? (raw.length > SOURCE_CONTENT_LIMIT ? raw.slice(0, SOURCE_CONTENT_LIMIT) + "…" : raw)
            : undefined;

        let timestamp;
        if (typeof message.timestamp === "string") timestamp = message.timestamp;
        else if (message.timestamp instanceof Date) timestamp = message.timestamp.toISOString();

        return {
            id: String(message.id),
            channelId: message.channel_id ? String(message.channel_id) : undefined,
            content: truncated,
            timestamp,
        };
    }

    function readMarks() {
        try {
            const store = plugin.storage;
            const marks = store && store.marks;
            if (!marks || typeof marks !== "object") return {};

            // MMKV 响应式代理里取出来的值可能还是代理。桌面端就是栽在这上面：
            // 代理进不了 IPC 的结构化克隆，写盘直接失败，重启只剩第一条。
            // 这里统一过一道 JSON，拿到的保证是纯对象。
            return JSON.parse(JSON.stringify(marks));
        } catch (e) {
            logger.warn("读取标记数据失败", e);
            return {};
        }
    }

    function writeMarks(marks) {
        try {
            plugin.storage.marks = marks;
        } catch (e) {
            logger.error("写入标记数据失败", e);
        }
    }

    function getMark(userId) {
        return readMarks()[userId];
    }

    function setMark(userId, note, username, sourceMessage) {
        const marks = { ...readMarks() };
        const prev = marks[userId];

        marks[userId] = {
            note: note || "",
            username: username || (prev && prev.username) || "",
            // 重复编辑不刷新标记时间
            markedAt: prev && prev.markedAt ? prev.markedAt : Date.now(),
            // 不传来源（比如从名单里改备注）就保留原来那条
            sourceMessage: sourceMessage || (prev && prev.sourceMessage) || undefined,
        };

        writeMarks(marks);
    }

    function removeMark(userId) {
        const marks = { ...readMarks() };
        if (!(userId in marks)) return;

        delete marks[userId];
        writeMarks(marks);
    }

    /* ================= 弹窗与提示 ================= */

    function hideSheet() {
        try {
            const sheet = metro.findByProps("openLazy", "hideActionSheet");
            sheet && sheet.hideActionSheet && sheet.hideActionSheet();
        } catch (e) {
            // 关不掉就算了
        }
    }

    function askNote(author, message) {
        const existing = getMark(author.id);
        const name = author.globalName || author.username || author.id;

        ui.alerts.showInputAlert({
            title: existing ? `编辑标记 · ${name}` : `标记 · ${name}`,
            placeholder: "写点备注，可以留空",
            initialValue: existing ? existing.note : "",
            confirmText: existing ? "保存" : "标记",
            cancelText: "取消",
            onConfirm: text => {
                // 保存失败也绝不能把弹窗卡住：先存，存不动就吞掉异常，弹窗自己会关
                try {
                    setMark(author.id, text, name, sourceFromMessage(message));
                } catch (e) {
                    logger.error("标记失败", e);
                }
                // 不弹 toast：桌面端这个提示会渲染成一个空白圆圈，
                // 标记结果本身已经看得见（菜单里变成取消标记、名单里多一行）
            },
        });
    }

    /* ================= 长按菜单 =================
       Discord 移动端的消息长按菜单是 LazyActionSheet 拉起来的组件，
       模块特征是带 EmojiRow（社区插件里验证过的定位方式）。
       拿到组件返回的 JSX 后，遍历树找「一堆带 label+onPress 的行」，
       往里塞我们自己的项 —— 比按死层级路径耐版本变化。 */

    function isMenuRow(node) {
        return !!(
            node && typeof node === "object" && !Array.isArray(node)
            && node.props && typeof node.props.onPress === "function"
            && (node.props.label != null || node.props.text != null
                || node.props.title != null || node.props.children != null)
        );
    }

    function findMenuRows(root) {
        const queue = [root];
        let best = null;

        while (queue.length) {
            const node = queue.shift();
            if (!node) continue;

            if (Array.isArray(node)) {
                const rows = node.filter(isMenuRow);

                // 放宽到一行也要：面板已经锁定是消息长按，卡「至少两行」反而抓不到分组结构
                if (rows.length >= 1 && (!best || rows.length > best.length)) best = node;

                for (const child of node) queue.push(child);
                continue;
            }

            if (typeof node === "object" && node.props) {
                const p = node.props;
                queue.push(p.children, p.rows, p.options, p.actions, p.items);
            }
        }

        return best;
    }

    function patchMessageSheet() {
        const sheetModule = metro.findByProps("EmojiRow");

        if (!sheetModule || typeof sheetModule.default !== "function") {
            logger.warn("没找到消息长按菜单组件（EmojiRow），标记入口不可用");
            return;
        }

        unpatches.push(
            patcher.after("default", sheetModule, ([props], res) => {
                try {
                    const author = props && props.message && props.message.author;
                    if (!author || !author.id) return;

                    const rows = findMenuRows(res);
                    if (!rows) {
                        logger.warn("长按菜单里没定位到按钮数组");
                        return;
                    }

                    if (rows.some(r => isMenuRow(r) && r.props.key === "usermark-mark")) return;

                    const existing = getMark(author.id);
                    const sourceMessage = props.message;

                    rows.push(
                        React.createElement(Forms.FormRow, {
                            key: "usermark-mark",
                            label: existing ? "编辑标记备注" : "标记此用户",
                            onPress: () => {
                                hideSheet();
                                askNote(author, sourceMessage);
                            },
                        })
                    );

                    if (existing) {
                        rows.push(
                            React.createElement(Forms.FormRow, {
                                key: "usermark-unmark",
                                label: "取消标记",
                                onPress: () => {
                                    hideSheet();
                                    removeMark(author.id);
                                    ui.toasts.showToast("已取消标记");
                                },
                            })
                        );
                    }
                } catch (e) {
                    logger.error("注入标记菜单失败", e);
                }
            })
        );
    }

    /* ============ 策略二：openLazy 懒加载的面板 ============
       有些版本消息长按面板是 openLazy 拉起来的，EmojiRow 那条路挂不上。
       这里盯住 openLazy，组件一解析完就补一次丁。 */

    const patchedComponents = new WeakSet();

    function injectMarkRow(props, res) {
        const message = props && props.message;
        const author = message && message.author;
        if (!author || !author.id) return false;

        const rows = findMenuRows(res);
        if (!rows) return false;
        if (rows.some(r => isMenuRow(r) && r.props.key === "usermark-mark")) return true;

        const existing = getMark(author.id);
        rows.push(React.createElement(Forms.FormRow, {
            key: "usermark-mark",
            label: existing ? "编辑标记备注" : "标记此用户",
            onPress: () => { hideSheet(); askNote(author, message); },
        }));
        if (existing) {
            rows.push(React.createElement(Forms.FormRow, {
                key: "usermark-unmark",
                label: "取消标记",
                onPress: () => { hideSheet(); removeMark(author.id); ui.toasts.showToast("已取消标记"); },
            }));
        }
        return true;
    }

    function patchLazyComponent(mod) {
        try {
            const target = mod && mod.default;
            if (!target || typeof target !== "function" || patchedComponents.has(target)) return;

            // Kettu 靠 displayName 反查组件（byDisplayName），包装后可能把它顶掉，先留着
            const displayName = target.displayName || target.name;
            patchedComponents.add(target);

            const unpatch = patcher.after("default", mod, (args, res) => {
                try {
                    const injected = injectMarkRow(args && args[0], res);
                    // 一眼看出不是菜单面板：立刻把补丁摘掉，恢复原样
                    if (!injected && unpatch) unpatch();
                } catch (e) {
                    logger.error("注入标记菜单失败", e);
                }
            });

            if (displayName && mod.default && mod.default.displayName !== displayName) {
                try { mod.default.displayName = displayName; } catch { /* 只读就作罢 */ }
            }
            // 把原组件的静态成员整体搬过去，别只搬 displayName
            try {
                for (const key of Object.getOwnPropertyNames(target)) {
                    if (key === "prototype" || key === "arguments" || key === "caller") continue;
                    if (!(key in mod.default)) {
                        try { mod.default[key] = target[key]; } catch { /* 只读就跳过 */ }
                    }
                }
            } catch { /* 拿不到属性名就算了 */ }
            logger.log("已补丁懒加载的长按面板");
        } catch (e) {
            logger.warn("补丁懒加载组件失败", e);
        }
    }

    function patchOpenLazy() {
        try {
            // 默认开；在设置里点一下可关（怀疑它引发崩溃时关掉）
            if (plugin.storage.enableLazyStrategy === false) {
                logger.log("策略二已被手动关闭");
                return;
            }
            const mod = metro.findByProps("openLazy", "hideActionSheet");
            if (!mod || typeof mod.openLazy !== "function") {
                logger.warn("openLazy 模块没找到，策略二不可用");
                return;
            }

            unpatches.push(patcher.before("openLazy", mod, (args) => {
                try {
                    const key = args && args[1];
                    // 只管消息相关的面板。Alert 等一概不碰：
                    // 打过补丁的组件 displayName 会变，Discord 渲染弹窗时 byDisplayName 解析不到就崩
                    if (typeof key !== "string" || !/message|longpress/i.test(key)) return;

                    const lazy = args && args[0];
                    // 只接原生 Promise，Kettu 自家的 thenable 不能随便唤
                    if (!lazy || typeof lazy.then !== "function" || !(lazy instanceof Promise)) return;

                    lazy.then(patchLazyComponent, () => { });
                } catch (e) {
                    logger.warn("openLazy 观察失败", e);
                }
            }));
            logger.log("策略二已挂：openLazy");
        } catch (e) {
            logger.warn("openLazy 挂载失败", e);
        }
    }

    /* ============ 消息日志（原 vc-message-logger-enhanced 精简并入） ============
       手机端没有 IndexedDB，直接放 plugin.storage（MMKV）。
       记：收到 / 编辑 / 删除，名单里的用户发言随时能在设置页里翻。 */

    const DEFAULT_LOG_LIMIT = 1000;
    const S = { NORMAL: 0, DELETED: 1, EDITED: 2 };
    const STATUS_TEXT = ["普通", "已删除", "已编辑"];

    function getLogLimit() {
        const n = Number(plugin.storage.messageLimit);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOG_LIMIT;
    }

    function readLogs() {
        try {
            const logs = plugin.storage.logs;
            return Array.isArray(logs) ? JSON.parse(JSON.stringify(logs)) : [];
        } catch (e) {
            logger.warn("读取日志失败", e);
            return [];
        }
    }

    function writeLogs(logs) {
        try {
            const limit = getLogLimit();
            plugin.storage.logs = JSON.parse(JSON.stringify(logs.slice(0, limit)));
        } catch (e) {
            logger.error("写入日志失败", e);
        }
    }

    function slimMessage(message) {
        if (!message || !message.id) return null;
        const author = message.author;
        return {
            id: String(message.id),
            channel_id: message.channel_id ? String(message.channel_id) : undefined,
            author: author && author.id ? {
                id: String(author.id),
                username: author.username || "",
                global_name: author.globalName ?? author.global_name ?? undefined,
                avatar: author.avatar ?? undefined,
                discriminator: author.discriminator ?? undefined,
            } : undefined,
            content: typeof message.content === "string" ? message.content.slice(0, 2000) : "",
            timestamp: typeof message.timestamp === "string" ? message.timestamp
                : message.timestamp instanceof Date ? message.timestamp.toISOString() : undefined,
        };
    }

    /** 有旧记录就合并（UPDATE 常常只带部分字段），没有就新建 */
    function upsertLog(status, message) {
        try {
            const slim = slimMessage(message);
            if (!slim || !slim.id) return;

            const logs = readLogs();
            const idx = logs.findIndex(x => x && x.id === slim.id);
            const prev = idx >= 0 ? logs[idx] : undefined;

            const incoming = {};
            for (const [k, v] of Object.entries(slim)) {
                if (v !== undefined && v !== "") incoming[k] = v;
            }
            const merged = prev ? { ...prev.message, ...incoming } : slim;
            if (prev && prev.message) {
                if (!merged.author) merged.author = prev.message.author;
                if (!merged.content && prev.message.content) merged.content = prev.message.content;
            }

            let nextStatus = status;
            let editHistory = prev ? prev.editHistory : undefined;
            const contentChanged = prev && prev.message && prev.status !== S.DELETED
                && typeof prev.message.content === "string" && typeof merged.content === "string"
                && prev.message.content !== merged.content;

            if (status === S.NORMAL && contentChanged) {
                editHistory = [...(editHistory || []), { content: prev.message.content, ts: prev.ts }].slice(-10);
                nextStatus = S.EDITED;
            } else if (prev) {
                if (prev.status === S.DELETED) nextStatus = S.DELETED;
                else if (prev.status === S.EDITED) nextStatus = S.EDITED;
            }

            const rec = { id: slim.id, status: nextStatus, ts: Date.now(), message: merged, editHistory };
            if (idx >= 0) logs[idx] = rec;
            else logs.unshift(rec);

            writeLogs(logs);
        } catch (e) {
            logger.error("记录消息失败", e);
        }
    }

    function markDeleted(ids) {
        try {
            const list = (ids || []).map(String).filter(Boolean);
            if (!list.length) return;

            const logs = readLogs();
            let changed = false;
            for (const id of list) {
                const rec = logs.find(x => x && String(x.id) === id);
                if (rec) {
                    if (rec.status !== S.DELETED) { rec.status = S.DELETED; rec.ts = Date.now(); changed = true; }
                } else {
                    // 库里没有就记个空壳，至少知道这条被删了
                    logs.unshift({ id, status: S.DELETED, ts: Date.now(), message: { id, content: "" } });
                    changed = true;
                }
            }
            if (changed) writeLogs(logs);
        } catch (e) {
            logger.error("标记删除失败", e);
        }
    }

    /** 只记名单里的人。全量记录 = 每条消息整表读写 MMKV，滑动必卡 */
    function isMarkedAuthor(author) {
        try {
            const marks = plugin.storage.marks;
            return !!(author && author.id && marks && typeof marks === "object" && author.id in marks);
        } catch {
            return false;
        }
    }

    function hasLog(id) {
        try {
            return readLogs().some(x => x && String(x.id) === String(id));
        } catch {
            return false;
        }
    }

    function onDispatch(args) {
        try {
            const action = args && args[0];
            if (!action || typeof action.type !== "string") return;

            switch (action.type) {
                case "MESSAGE_CREATE": {
                    const m = action.message;
                    if (m && m.id && isMarkedAuthor(m.author)) upsertLog(S.NORMAL, { ...m, channel_id: m.channel_id || action.channelId, guild_id: m.guild_id || action.guildId });
                    break;
                }
                case "MESSAGE_UPDATE": {
                    const m = action.message;
                    // 更新包里不一定带 author：已有记录的也要能改，否则编辑抓不到
                    if (m && m.id && (isMarkedAuthor(m.author) || hasLog(m.id))) upsertLog(S.NORMAL, { ...m, channel_id: m.channel_id || action.channelId });
                    break;
                }
                case "MESSAGE_DELETE": {
                    const id = action.id || (action.message && action.message.id);
                    if (id && hasLog(id)) markDeleted([id]);
                    break;
                }
                case "MESSAGE_DELETE_BULK":
                    // 只改已有记录，不为不相干的 id 新建空壳（那会白白写盘）
                    (action.ids || []).filter(hasLog).forEach(id => markDeleted([id]));
                    break;
            }
        } catch (e) {
            logger.error("日志处理失败", e);
        }
    }

    function startLogger() {
        const candidates = [
            () => metro.findByProps("subscribe", "dispatch"),
            () => metro.findByProps("dispatch", "subscribe", "wait"),
        ];

        for (const get of candidates) {
            try {
                const d = get();
                if (d && typeof d.dispatch === "function" && typeof d.subscribe === "function") {
                    unpatches.push(patcher.before("dispatch", d, onDispatch));
                    logger.log("消息日志已启动");
                    return;
                }
            } catch { /* 换下一个候选 */ }
        }

        logger.warn("没找到 FluxDispatcher，消息日志不可用");
    }

    /** 一键把定位线索写进日志：到底是模块没了，还是行结构对不上 */
    function runDiag() {
        const report = [];
        const probes = ["EmojiRow", "ActionSheetRow", "MessageLongPress", "MessageActionSheet", "hideActionSheet", "openLazy", "showSimpleActionSheet"];

        for (const p of probes) {
            try {
                const found = metro.findByProps(p);
                report.push(`${p}=${found ? "有" : "无"}`);
            } catch (e) {
                report.push(`${p}=错`);
            }
        }

        try {
            const hits = [];
            metro.find(m => {
                try {
                    const d = m && m.default;
                    if (typeof d === "function" && hits.length < 10) {
                        const s = String(d);
                        for (const marker of ["EmojiRow", "MessageLongPress", "ActionSheetRow", "hideActionSheet", "FormRow"]) {
                            if (s.includes(marker)) hits.push(`${marker}→${d.displayName || d.name || "匿名"}`);
                        }
                    }
                } catch { /* 单个模块取不到就算了 */ }
                return false;
            });
            report.push(`源码命中=[${hits.join(", ") || "无"}]`);
        } catch (e) {
            report.push(`扫描失败=${e && e.message}`);
        }

        logger.warn("【诊断】" + report.join(" | "));
        try { ui.toasts.showToast("诊断已写入日志"); } catch { }
    }

    /** 菜单进不来时的保底入口：一条输入框搞定标记 */
    function askMarkById() {
        ui.alerts.showInputAlert({
            title: "按 ID 标记",
            placeholder: "例如：123456789012345678 备注内容",
            initialValue: "",
            confirmText: "标记",
            cancelText: "取消",
            onConfirm: text => {
                try {
                    const raw = String(text || "").trim();
                    const [id, ...rest] = raw.split(/\s+/);
                    if (!/^\d{5,}$/.test(id || "")) {
                        ui.toasts.showToast("开头那串得是数字用户 ID");
                        return;
                    }
                    setMark(id, rest.join(" "), id, undefined);
                } catch (e) {
                    logger.error("按 ID 标记失败", e);
                }
            },
        });
    }

    function deleteLog(id) {
        try {
            writeLogs(readLogs().filter(r => r && r.id !== id));
        } catch (e) {
            logger.error("删除记录失败", e);
        }
    }

    function askLogLimit() {
        const current = getLogLimit();
        ui.alerts.showInputAlert({
            title: "日志上限",
            placeholder: String(current),
            initialValue: String(current),
            confirmText: "保存",
            cancelText: "取消",
            onConfirm: text => {
                try {
                    const n = Math.floor(Number(text));
                    if (Number.isFinite(n) && n > 0 && n <= 20000) plugin.storage.messageLimit = n;
                } catch (e) {
                    logger.warn("设置日志上限失败", e);
                }
            },
        });
    }

    function openLogRowMenu(rec, refresh) {
        const sheet = metro.findByProps("showSimpleActionSheet");
        if (!sheet) return;

        const m = rec.message || {};
        sheet.showSimpleActionSheet({
            key: "UserMarkLogRow",
            header: { title: (m.content || "（无内容）").slice(0, 60) },
            options: [
                {
                    label: "复制内容",
                    onPress: () => {
                        try {
                            if (ui.clipboard && typeof ui.clipboard.setString === "function") {
                                ui.clipboard.setString(m.content || "");
                                ui.toasts.showToast("已复制");
                            } else {
                                ui.toasts.showToast("这个端没有剪贴板接口");
                            }
                        } catch (e) {
                            logger.warn("复制失败", e);
                        }
                    },
                },
                {
                    label: "删除记录",
                    isDestructive: true,
                    onPress: () => { deleteLog(rec.id); refresh(); },
                },
            ],
        });
    }

    function renderLogRows(list, refresh) {
        if (!list.length) {
            return [React.createElement(Forms.FormRow, {
                key: "no-log",
                label: "还没有记录",
                subtext: "收到消息后自动写入",
                disabled: true,
            })];
        }

        return list.map(rec => {
            const m = (rec && rec.message) || {};
            const who = m.author
                ? (m.author.global_name || m.author.username || m.author.id)
                : "未知用户";
            const body = String(m.content || "").replace(/\s+/g, " ").trim();
            const preview = body ? (body.length > 40 ? body.slice(0, 40) + "…" : body) : "（无文字内容）";
            const when = rec.ts ? new Date(rec.ts).toLocaleTimeString() : "";

            return React.createElement(Forms.FormRow, {
                key: `${rec.id}_${rec.ts}`,
                label: preview,
                subtext: `${who} · ${STATUS_TEXT[rec.status] || "普通"} · ${when}`,
                onPress: () => openLogRowMenu(rec, refresh),
            });
        });
    }

    /* ================= 设置面板 ================= */

    function openRowMenu(userId, refresh) {
        const marks = readMarks();
        const entry = marks[userId];
        if (!entry) return;

        const sheet = metro.findByProps("showSimpleActionSheet");
        if (!sheet) return;

        const name = entry.username || userId;

        sheet.showSimpleActionSheet({
            key: "UserMarkRow",
            header: { title: entry.note || name },
            options: [
                {
                    label: "编辑备注",
                    onPress: () => askNote({ id: userId, username: name }),
                },
                {
                    label: "取消标记",
                    isDestructive: true,
                    onPress: () => {
                        removeMark(userId);
                        ui.toasts.showToast(`已取消标记 ${name}`);
                        refresh();
                    },
                },
            ],
        });
    }

    function Settings() {
        const store = vdStorage.useProxy(plugin.storage);
        const marks = (store && store.marks) || {};
        const ids = Object.keys(marks);

        // useProxy 的代理是响应式的，删除后需要强制重渲染
        const [, forceUpdate] = React.useReducer(x => x + 1, 0);
        React.useEffect(() => forceUpdate(), [ids.length]);

        const children = [];

        if (ids.length === 0) {
            children.push(
                React.createElement(Forms.FormRow, {
                    key: "empty",
                    label: "还没有标记任何人",
                    subtext: "长按一条消息 → 标记此用户",
                    disabled: true,
                })
            );
        } else {
            for (const id of ids) {
                const entry = marks[id];
                const when = entry.markedAt ? new Date(entry.markedAt).toLocaleString() : "未知时间";
                const source = entry.sourceMessage && entry.sourceMessage.content
                    ? entry.sourceMessage.content
                    : "";
                const sourceShort = source.length > 60 ? source.slice(0, 60) + "…" : source;

                children.push(
                    React.createElement(Forms.FormRow, {
                        key: id,
                        label: entry.note || entry.username || id,
                        subtext: `${entry.username || id} · 标记于 ${when}${sourceShort ? ` · 来源：${sourceShort}` : ""}`,
                        onPress: () => openRowMenu(id, forceUpdate),
                    })
                );
            }
        }

        const markedSection = React.createElement(
            Forms.FormSection,
            { title: `被标记用户（${ids.length}）` },
            ...children
        );

        const optionsSection = null;

        const logs = readLogs();
        const markedIds = new Set(ids);
        const markedLogs = logs.filter(r => r && r.message && r.message.author && markedIds.has(r.message.author.id));

        const idSection = React.createElement(
            Forms.FormSection,
            { title: "手动标记" },
            React.createElement(Forms.FormRow, {
                key: "mark-by-id",
                label: "按 ID 标记一个用户",
                subtext: "长按菜单进不来时用这个：输入 用户ID 备注",
                onPress: askMarkById,
            }),
            React.createElement(Forms.FormRow, {
                key: "mark-diag",
                label: "跑一次菜单定位诊断",
                subtext: "结果写进日志，发给白娅即可",
                onPress: runDiag,
            })
        );

        return React.createElement(
            React.Fragment,
            null,
            idSection,
            markedSection,
            React.createElement(
                Forms.FormSection,
                { title: `标记用户发言（${markedLogs.length}/${getLogLimit()}）` },
                ...renderLogRows(markedLogs.slice(0, 30), forceUpdate),
                React.createElement(Forms.FormRow, {
                    key: "log-limit",
                    label: `记录上限：${getLogLimit()} 条`,
                    subtext: "只存名单内用户的发言",
                    onPress: askLogLimit,
                }),
                React.createElement(Forms.FormRow, {
                    key: "log-clear",
                    label: "清空记录",
                    subtext: "删掉已存的发言记录",
                    destructive: true,
                    onPress: () => { writeLogs([]); forceUpdate(); },
                })
            )
        );
    }

    /* ================= 生命周期 ================= */

    return {
        onLoad() {
            try {
                patchMessageSheet();
            } catch (e) {
                logger.error("挂载长按菜单失败", e);
            }
            // 策略二已停用：挂 openLazy 会让 Kettu 的 byDisplayName 整条链坏掉，
            // 表现为 FluxContainer(Alert) 解析不到、渲染弹窗就崩。实测过，不再挂。
            try {
                startLogger();
            } catch (e) {
                logger.warn("启动消息日志失败", e);
            }
            logger.log("UserMark 已加载");
        },

        onUnload() {
            while (unpatches.length) {
                try {
                    unpatches.pop()();
                } catch (e) {
                    logger.error("卸载补丁失败", e);
                }
            }
            logger.log("UserMark 已卸载");
        },

        settings: Settings,
    };
})()
