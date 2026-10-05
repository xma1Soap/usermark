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
       消息长按走 openLazy(promise, "MessageLongPressActionSheet", { message, … })。
       先只读 openLazy 的参数认出是哪个面板，再把那个模块的 default 补一层，
       从渲染结果里按形状找到行数组，往里 push 我们的项。
       patcher 是 Proxy 包装，不改组件自身的 name/displayName，所以不会截断
       Kettu 按名字找组件的链路（旧版把组件整个换掉过，代价是所有弹窗崩）。 */

    const MARK_FLAG = "__usermarkRow";

    /** 诊断状态：最近几次长按调用、补丁就位情况、命中次数 */
    const sheetTrace = {
        keys: [],
        opens: 0,
        hits: 0,
        rows: 0,
        lastError: "",
        openLazyPatched: false,
    };

    /** 已经补过 default 的面板模块，避免同一次长按重复装 */
    const sheetMods = [];

    function traceSheetOpen(key, props, message, isLazy) {
        try {
            sheetTrace.opens++;
            const line = `${key} · message=${message ? "有" : "无"} · lazy=${isLazy ? "是" : "否"} · props=[${Object.keys(props || {}).slice(0, 10).join(",")}]`;
            if (sheetTrace.keys[0] === line) return;
            sheetTrace.keys.unshift(line);
            sheetTrace.keys.length = Math.min(sheetTrace.keys.length, 6);
            logger.log(`【面板】${line}`);
        } catch { /* 诊断不该影响长按本身 */ }
    }

    /**
     * 在渲染树里找「一组带 onPress 的行」。
     * 按形状认不按组件名认 —— Discord 把 ActionSheet 改名叫 BottomSheet 过，名字靠不住。
     */
    function findRows(root) {
        const seen = new WeakSet();
        let budget = 1400;

        function walk(node, depth) {
            if (node == null || depth > 12 || budget-- <= 0) return null;

            if (Array.isArray(node) && node.some(x => x && x.props && typeof x.props.onPress === "function")) return node;
            if (typeof node !== "object" || seen.has(node)) return null;
            seen.add(node);

            for (const k of Object.keys(node)) {
                let v;
                try { v = node[k]; } catch { continue; }
                if (typeof v === "function") continue;
                const got = walk(v, depth + 1);
                if (got) return got;
            }
            return null;
        }

        return walk(root, 0);
    }

    /**
     * 行组件延迟到真正要出行时才查。
     * 面板所在的 chunk 可能还没加载 —— 这时候 findByProps 找不到，Kettu 会把
     * 这个查询永久标记成「没有」并写进磁盘缓存，之后再怎么找都是空。
     */
    function getRowComp() {
        try {
            const m = metro.findByProps("ActionSheetRow");
            if (m && m.ActionSheetRow) return m.ActionSheetRow;
        } catch { /* 换降级 */ }
        return Forms.FormRow;
    }

    /** 往行数组尾部加「标记此用户 / 取消标记」 */
    function injectRows(rows, message) {
        const author = message && message.author;
        if (!author || !author.id) return false;
        if (rows.some(r => r && r.props && r.props[MARK_FLAG])) return false;

        const Row = getRowComp();
        const existing = getMark(author.id);
        const makeRow = (key, label, onPress) => React.createElement(Row, {
            key,
            label,
            onPress,
            [MARK_FLAG]: true,
        });

        rows.push(makeRow("usermark-mark", existing ? "编辑标记备注" : "标记此用户", () => {
            hideSheet();
            askNote(author, message);
        }));
        if (existing) {
            rows.push(makeRow("usermark-unmark", "取消标记", () => {
                hideSheet();
                removeMark(author.id);
                ui.toasts.showToast("已取消标记");
            }));
        }

        sheetTrace.rows++;
        return true;
    }

    /** 挂 openLazy 钩子：只有消息长按面板那个模块会被补 */
    function patchMessageSheet() {
        const sheetActions = metro.findByProps("openLazy", "hideActionSheet");

        if (!sheetActions || typeof sheetActions.openLazy !== "function") {
            logger.warn("没找到 ActionSheet 入口，长按标记不可用（仍可用设置页按 ID 标记）");
            return false;
        }

        unpatches.push(patcher.before("openLazy", sheetActions, ([component, key, props]) => {
            const isLongPress = typeof key === "string" && /LongPress/i.test(key);

            const message = extractMessage(props);
            // 所有面板都记一笔：万一 Discord 改了名，这里看得出到底弹的是哪个 key
            traceSheetOpen(key, props, message, !!(component && typeof component.then === "function"));

            if (!isLongPress) return;

            // 面板名字里带 Message，或者参数里直接给了消息，才认定是消息长按
            const isMessageSheet = message || /message/i.test(key);
            if (!isMessageSheet || !component || typeof component.then !== "function") return;
            if (sheetTrace.rows > 0) return; // 已经能出行了，别再装第二个补丁

            component.then(mod => {
                if (!mod || typeof mod.default !== "function") {
                    sheetTrace.lastError = `面板模块 default 类型=${mod && typeof mod.default}`;
                    return;
                }
                if (sheetMods.includes(mod)) return;
                if (sheetMods.length >= 2) {
                    sheetTrace.lastError = "补了两个模块还找不到行，八成不是渲染行的那个组件";
                    return;
                }

                // 常驻补丁。spitroast 是 Proxy 包装，函数自身的 name/displayName 不受影响，
                // 所以 Kettu 按名字找组件的链路不会被截断（旧版截断过一次，代价是所有弹窗都崩）
                try {
                    unpatches.push(patcher.after("default", mod, (args, tree) => {
                        // 消息从本次渲染的 props 取，不靠当初 openLazy 那份闭包
                        const msg = extractMessage(args && args[0]) || message;
                        if (!msg || !msg.author) return;

                        const rows = findRows(tree);
                        if (!rows) {
                            sheetTrace.lastError = `${key} 的渲染树里没找到行`;
                            return;
                        }
                        sheetTrace.hits++;
                        injectRows(rows, msg);
                    }));
                    sheetMods.push(mod);
                    logger.log(`长按面板补丁已装（第 ${sheetMods.length} 个：${key}）`);
                } catch (e) {
                    sheetTrace.lastError = `补 ${key} 失败：${e && e.message}`;
                    logger.warn(sheetTrace.lastError);
                }
            }).catch(() => { /* 面板模块没加载成功，不拦正常长按 */ });
        }));

        sheetTrace.openLazyPatched = true;
        logger.log("长按菜单钩子已挂（等第一次长按消息装面板补丁）");
        return true;
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

    /** 一键把定位线索写进日志：钩子挂上了没、长按时 openLazy 报的是什么 key */
    function runDiag() {
        const report = [];

        for (const p of ["openLazy", "ActionSheetRow", "showSimpleActionSheet"]) {
            try {
                report.push(`${p}=${metro.findByProps(p) ? "有" : "无"}`);
            } catch {
                report.push(`${p}=错`);
            }
        }

        if (!sheetTrace.openLazyPatched) {
            try {
                report.push(`重挂=${patchMessageSheet() ? "成功" : "失败"}`);
            } catch (e) {
                report.push(`重挂=错（${e && e.message}）`);
            }
        }

        report.push(`openLazy 钩子=${sheetTrace.openLazyPatched ? "已挂" : "没挂上"}`);
        report.push(`面板补丁=${sheetMods.length ? `已装 ${sheetMods.length} 个模块` : "还没装上（长按一次消息后才有）"}`);
        report.push(`面板打开=${sheetTrace.opens} · 渲染树=${sheetTrace.hits} · 加行=${sheetTrace.rows}`);
        if (sheetTrace.lastError) report.push(`问题：${sheetTrace.lastError}`);
        report.push(`模块数=${Object.keys(metro.modules || {}).length}`);

        for (const line of sheetTrace.keys) report.push(`面板 ${line}`);
        if (!sheetTrace.keys.length) report.push("还没记录到任何面板：先去长按一条消息，再回来看这几行");

        logger.warn("【诊断】" + report.join(" | "));
        return report;
    }

    /** 从面板 props 里挖消息：这版可能叫 message / messages[0] / msg 等 */
    function extractMessage(props) {
        if (!props || typeof props !== "object") return null;
        const m = props.message || props.msg || props.targetMessage
            || (Array.isArray(props.messages) && props.messages[0])
            || (props.data && props.data.message);
        return m || null;
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
        const [diag, setDiag] = React.useState(null);

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
                subtext: "结果列在下方。没长按过就先长按一条消息再进来点它",
                onPress: () => { try { setDiag(runDiag() || []); } catch (e) { logger.error("诊断失败", e); setDiag(["诊断异常：" + (e && e.message)]); } },
            }),
            ...(diag || []).map((line, i) => React.createElement(Forms.FormRow, {
                key: "diag-" + i,
                label: line,
                disabled: true,
            })),
            ...(sheetTrace.keys.length ? [
                React.createElement(Forms.FormRow, {
                    key: "cap-0",
                    label: `面板：打开 ${sheetTrace.opens} 次 · 拿到渲染树 ${sheetTrace.hits} 次 · 加行 ${sheetTrace.rows} 次`,
                    subtext: sheetTrace.lastError || `openLazy=${sheetTrace.openLazyPatched ? "已挂" : "没挂"} · 面板补丁=${sheetMods.length ? "已装" : "未装"}`,
                    disabled: true,
                }),
            ] : []),
            ...sheetTrace.keys.map((line, i) => React.createElement(Forms.FormRow, {
                key: "caplog-" + i,
                label: line,
                disabled: true,
            }))
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
