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

    /* ================= 输入与提示 =================
       这版插件**不用任何弹窗**。Kettu 的 `ui.alerts.showInputAlert` 渲染的是 Discord
       老 Alert（`src/metro/common/components.ts:18` = findByDisplayNameLazy("FluxContainer(Alert)")），
       现网 Discord 已经没有那个组件了，所以一进输入弹窗就在 forceLoad 抛
       「FluxContainer(Alert) is undefined」，整块被 ErrorBoundary 吃掉。
       要写字儿就全在设置页里就地展开一个输入框，只用已经解析到的 Forms / React Native。 */

    const ReactNative = metro.common.ReactNative;

    let sheetActionsMod; // undefined = 还没查过，null = 查过但没有
    function getSheetActions() {
        if (sheetActionsMod === undefined) {
            try {
                sheetActionsMod = metro.findByProps("openLazy", "hideActionSheet") || null;
            } catch {
                sheetActionsMod = null;
            }
        }
        return sheetActionsMod;
    }

    function hideSheet() {
        try {
            const sheet = getSheetActions();
            sheet && sheet.hideActionSheet && sheet.hideActionSheet();
        } catch { /* 关不掉就算了 */ }
    }

    /** 长按里的「标记」：先立刻落盘（备注可空），再把待写备注的人挂到设置页 */
    function markAndQueueNote(author, message) {
        const existing = getMark(author.id);
        const name = author.globalName || author.global_name || author.username || author.id;

        try {
            if (!existing) setMark(author.id, "", name, sourceFromMessage(message));
            plugin.storage.pending = JSON.parse(JSON.stringify({
                userId: String(author.id),
                username: name,
            }));
        } catch (e) {
            logger.error("标记失败", e);
        }

        ui.toasts.showToast(`已标记 ${name}：去 UserMark 设置页写备注`);
    }

    /** 一个不自带样式的输入框：优先用 Discord 的 Forms.FormInput，没有就退回 RN TextInput */
    function makeInput({ key: rowKey, value, onChange, placeholder }) {
        let FormInput = null;
        try {
            FormInput = Forms && Forms.FormInput;
        } catch (e) {
            logger.warn("拿 Forms.FormInput 失败，改用 RN 输入框", e);
            FormInput = null;
        }
        if (FormInput) {
            return React.createElement(FormInput, {
                key: rowKey,
                placeholder,
                value,
                onChange: v => onChange(typeof v === "string" ? v : ((v && v.text) || "")),
                autoFocus: true,
                showBorder: true,
                style: { alignSelf: "stretch" },
            });
        }

        let Input = null;
        try {
            Input = ReactNative && ReactNative.TextInput;
        } catch (e) {
            // metro.common.ReactNative 是懒代理，取属性会触发 forceLoad：
            // 万一它被拉黑，宁可显示「找不到输入框」那一行，也别把整页抛进 ErrorBoundary
            logger.warn("拿 RN 的 TextInput 失败", e);
            Input = null;
        }
        if (!Input) return null;

        return React.createElement(Input, {
            key: rowKey,
            placeholder,
            value,
            onChangeText: onChange,
            autoFocus: true,
            style: {
                alignSelf: "stretch",
                marginHorizontal: 12,
                padding: 12,
                borderWidth: 1,
                borderColor: "rgba(130, 130, 140, 0.6)",
                borderRadius: 8,
                fontSize: 16,
            },
        });
    }

    /* ================= 长按菜单 =================
       消息长按走 openLazy(promise, "MessageLongPressActionSheet", { message, … })。
       先只读 openLazy 的参数认出是哪个面板，再把那个模块的 default 补一层，
       从渲染结果里按形状找到行数组，往里 push 我们的项。
       patcher 是 Proxy 包装，不改组件自身的 name/displayName，所以按名字找组件不受影响。
       真正会弄坏弹窗的是「查不到的 metro 查询」：它等于全量扫描并强制 require 所有还没
       初始化的模块，require 抛错的模块被永久拉黑写进磁盘缓存，见下面「缓存中毒自救」。 */

    const MARK_FLAG = "__usermarkRow";

    /** 诊断状态：最近几次长按调用、补丁就位情况、命中次数 */
    const sheetTrace = {
        keys: [],
        opens: 0,
        hits: 0,
        rows: 0,
        lastError: "",
        openLazyPatched: false,
        rowComp: "",
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

    let rowComp = null;      // 缓存住的行组件：整个会话最多只查一次
    let rowCompTried = false;

    /**
     * 兜底用的行组件。延迟到真要出行时才查，而且只查一次：
     * findByProps 落空会强制 require 所有还没初始化的模块，抛错的那些直接被永久拉黑，
     * 下一次长按又问一遍的话，黑名单只会越滚越长。
     */
    function getRowComp() {
        if (rowCompTried) return rowComp;
        rowCompTried = true;
        try {
            const m = metro.findByProps("ActionSheetRow");
            if (m && m.ActionSheetRow) {
                rowComp = m.ActionSheetRow;
                sheetTrace.rowComp = "ActionSheetRow";
            }
        } catch { /* 换降级 */ }
        if (!rowComp) {
            rowComp = Forms.FormRow;
            sheetTrace.rowComp = sheetTrace.rowComp || "FormRow（降级）";
        }
        return rowComp;
    }

    /**
     * 优先借用面板里现成的行组件：它就是 Discord 这一版真正在渲染行的那个，
     * 连文字 prop 叫什么都能一起抄，还能省掉一次 metro 查询。
     */
    function pickRow(rows) {
        const sample = rows.find(r => r && r.props && typeof r.props.onPress === "function");
        const type = sample && sample.type;
        if (typeof type !== "function" && (typeof type !== "object" || !type)) return { Comp: getRowComp(), labelProp: "label" };

        let labelProp = "label";
        for (const k of ["label", "text", "title"]) {
            if (typeof sample.props[k] === "string") {
                labelProp = k;
                break;
            }
        }
        if (!sheetTrace.rowComp) sheetTrace.rowComp = `面板自带（文字 prop=${labelProp}）`;
        return { Comp: type, labelProp };
    }

    /** 往行数组尾部加「标记此用户 / 取消标记」 */
    function injectRows(rows, message) {
        const author = message && message.author;
        if (!author || !author.id) return false;
        if (rows.some(r => r && r.props && r.props[MARK_FLAG])) return false;

        const picked = pickRow(rows);
        const Row = picked.Comp;
        const labelProp = picked.labelProp;
        const existing = getMark(author.id);
        const makeRow = (key, label, onPress) => React.createElement(Row, {
            key,
            [labelProp]: label,
            onPress,
            [MARK_FLAG]: true,
        });

        rows.push(makeRow("usermark-mark", existing ? "编辑标记备注" : "标记此用户", () => {
            hideSheet();
            markAndQueueNote(author, message);
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
        const sheetActions = getSheetActions();

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

        // 这里刻意不做额外的 findByProps 探测：查不到的探测 = 全量强制 require，
        // 正是把模块拉黑、弄坏所有弹窗的那个动作。
        report.push(`行组件=${sheetTrace.rowComp || "还没出行（长按一次消息后才有）"}`);

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

    /** 长按菜单进不来时的保底入口：设置页里输 `用户ID 备注` */
    function saveMarkById(raw) {
        const [id, ...rest] = String(raw || "").trim().split(/\s+/);
        if (!/^\d{5,}$/.test(id || "")) {
            ui.toasts.showToast("开头那串得是数字用户 ID");
            return false;
        }
        setMark(id, rest.join(" "), id, undefined);
        return true;
    }

    function saveLogLimit(raw) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n) || n <= 0 || n > 20000) {
            ui.toasts.showToast("填个 1 到 20000 之间的整数");
            return false;
        }
        plugin.storage.messageLimit = n;
        return true;
    }

    function copyText(text) {
        try {
            if (ui.clipboard && typeof ui.clipboard.setString === "function") {
                ui.clipboard.setString(String(text || ""));
                ui.toasts.showToast("已复制");
            } else {
                ui.toasts.showToast("这个端没有剪贴板接口");
            }
        } catch (e) {
            logger.warn("复制失败", e);
        }
    }

    function deleteLog(id) {
        try {
            writeLogs(readLogs().filter(r => r && r.id !== id));
        } catch (e) {
            logger.error("删除记录失败", e);
        }
    }

    /** 记录行：点开就在下面摊出「复制 / 删除」，改过几回就把每一版旧正文一并摊出来 */
    function renderLogRows(list, expandedId, setExpanded) {
        if (!list.length) {
            return [React.createElement(Forms.FormRow, {
                key: "no-log",
                label: "还没有记录",
                subtext: "收到消息后自动写入",
                disabled: true,
            })];
        }

        const out = [];
        for (const rec of list) {
            const m = (rec && rec.message) || {};
            const who = m.author
                ? (m.author.global_name || m.author.username || m.author.id)
                : "未知用户";
            const body = String(m.content || "").replace(/\s+/g, " ").trim();
            const preview = body ? (body.length > 40 ? body.slice(0, 40) + "…" : body) : "（无文字内容）";
            const when = rec.ts ? new Date(rec.ts).toLocaleTimeString() : "";
            const open = expandedId === rec.id;
            const history = Array.isArray(rec.editHistory) ? rec.editHistory : [];

            out.push(React.createElement(Forms.FormRow, {
                key: `${rec.id}_${rec.ts}`,
                label: preview,
                subtext: `${who} · ${STATUS_TEXT[rec.status] || "普通"} · ${when}${history.length ? ` · 改前 ${history.length} 版` : ""}${open ? " · 点收起" : ""}`,
                onPress: () => setExpanded(open ? null : rec.id),
            }));

            if (!open) continue;
            out.push(React.createElement(Forms.FormRow, {
                key: `${rec.id}_copy`,
                label: "复制这条内容",
                subtext: body ? "" : "这条没有文字",
                onPress: () => copyText(m.content || ""),
            }));

            // 改之前的每一版单独一行，按从旧到新；点一下就把那一版复制走
            for (let i = 0; i < history.length; i++) {
                const old = String(history[i].content || "").replace(/\s+/g, " ").trim();
                const oldPreview = old ? (old.length > 40 ? old.slice(0, 40) + "…" : old) : "（无文字内容）";
                out.push(React.createElement(Forms.FormRow, {
                    key: `${rec.id}_old_${i}`,
                    label: oldPreview,
                    subtext: `${history.length === 1 ? "原话" : `第 ${i + 1} 版`} · ${history[i].ts ? new Date(history[i].ts).toLocaleTimeString() : ""} · 点复制`,
                    onPress: () => copyText(history[i].content || ""),
                }));
            }

            out.push(React.createElement(Forms.FormRow, {
                key: `${rec.id}_del`,
                label: "删除这条记录",
                destructive: true,
                onPress: () => {
                    deleteLog(rec.id);
                    setExpanded(null);
                },
            }));
        }
        return out;
    }

    /* ================= 缓存中毒自救 =================
       症状：一开弹窗就炸，报 bunny.metro.byDisplayName(FluxContainer(Alert)) is undefined!
       原因：一次「查不到的 metro 查询」会强制 require 所有还没初始化的模块，抛错的那些
             被 blacklistModule 变成非枚举，并写进 caches/metro_modules.json 的 flagsIndex。
             Kettu 启动时（internals/modules.ts）照着文件把黑名单原样套回来，所以重启也不会
             自己好；那次查询还顺手把它的 uniq 标成 _NOT_FOUND，之后每次都直接返回空。
       自救：删掉那个文件再重载 JS —— initMetroCache 发现文件不在就重建一份干净的。 */

    const METRO_CACHE_REL = "caches/metro_modules.json";
    // 各分支的目录前缀不统一，逐个试
    const CACHE_PREFIXES = ["pyoncord/", "bunny/", "kettu/", ""];

    function getNativeModule(name) {
        try {
            if (globalThis.__turboModuleProxy) {
                const m = globalThis.__turboModuleProxy(name);
                if (m) return m;
            }
        } catch { /* 换下一条 */ }
        try {
            const nmp = window.nativeModuleProxy;
            if (nmp && nmp[name]) return nmp[name];
        } catch { /* 没有 */ }
        return null;
    }

    /** 删掉能找到的那份缓存，返回删掉的相对路径 */
    async function deleteMetroCache() {
        const fm = getNativeModule("NativeFileModule") || getNativeModule("RTNFileManager") || getNativeModule("DCDFileManager");
        if (!fm || typeof fm.removeFile !== "function") {
            throw new Error(`没找到文件模块，请手动删 ${METRO_CACHE_REL}`);
        }

        let docs = "";
        try { docs = fm.getConstants().DocumentsDirPath; } catch { /* 那就盲删 */ }

        const removed = [];
        for (const prefix of CACHE_PREFIXES) {
            const rel = `${prefix}${METRO_CACHE_REL}`;
            if (docs && typeof fm.fileExists === "function") {
                let exists = false;
                try { exists = !!(await fm.fileExists(`${docs}/${rel}`)); } catch { exists = true; }
                if (!exists) continue;
            }
            try {
                await fm.removeFile("documents", rel);
                removed.push(rel);
            } catch { /* 这个前缀下确实没有 */ }
        }
        return removed;
    }

    /** Kettu 的 saveCache 是 1 秒防抖：删早了会被内存里的旧缓存写回来，所以等一拍再删第二遍 */
    async function repairMetroCache() {
        let removed = await deleteMetroCache();
        await new Promise(r => setTimeout(r, 1400));
        removed = removed.concat(await deleteMetroCache());
        if (!removed.length) throw new Error("没找到缓存文件（可能已经被手动删过了）");

        const bundler = getNativeModule("BundleUpdaterManager");
        if (!bundler || typeof bundler.reload !== "function") {
            return `已删除 ${removed[0]}，请手动彻底关闭 Discord（最近任务里划掉）再打开`;
        }

        ui.toasts.showToast("模块缓存已清除，正在重启 Discord");
        await new Promise(r => setTimeout(r, 500));
        await bundler.reload();
        return `已删除 ${removed[0]}，正在重载`;
    }

    /* ================= 设置面板 =================
       名单、备注、上限全部在这一页里就地展开编辑，不叫弹窗也不叫面板
       （showSimpleActionSheet 也不用了：少一次 metro 查询，少一处会崩的地方）。 */

    function Settings() {
        const store = vdStorage.useProxy(plugin.storage);
        const marks = (store && store.marks) || {};
        const ids = Object.keys(marks);
        const pending = store && store.pending;

        // useProxy 的代理是响应式的，删除后需要强制重渲染
        const [, forceUpdate] = React.useReducer(x => x + 1, 0);
        React.useEffect(() => forceUpdate(), [ids.length]);
        const [diag, setDiag] = React.useState(null);
        const [repair, setRepair] = React.useState({ armed: false, busy: false, msg: "" });
        const [editor, setEditor] = React.useState(null); // {mode: note|id|limit, userId?, username?, value}
        const [expandedLog, setExpandedLog] = React.useState(null);
        const pendingId = pending && pending.userId ? String(pending.userId) : "";

        // 长按标完人回到这页，备注框就自己摊开好
        React.useEffect(() => {
            if (!pendingId) return;
            setEditor({
                mode: "note",
                userId: pendingId,
                username: (pending && pending.username) || pendingId,
                value: (getMark(pendingId) || {}).note || "",
            });
            try {
                plugin.storage.pending = null;
            } catch { /* 清不掉顶多下次进来再摊开一次 */ }
        }, [pendingId]);

        function openNoteEditor(userId) {
            const entry = readMarks()[userId];
            if (!entry) return;
            setEditor({
                mode: "note",
                userId,
                username: entry.username || userId,
                value: entry.note || "",
            });
        }

        function saveEditor() {
            if (!editor) return;
            let ok = true;
            if (editor.mode === "note") {
                setMark(editor.userId, editor.value, editor.username, undefined);
            } else if (editor.mode === "id") {
                ok = saveMarkById(editor.value);
            } else if (editor.mode === "limit") {
                ok = saveLogLimit(editor.value);
            }
            if (ok) setEditor(null);
            forceUpdate();
        }

        const children = [];

        if (ids.length === 0) {
            children.push(
                React.createElement(Forms.FormRow, {
                    key: "empty",
                    label: "还没有标记任何人",
                    subtext: "长按一条消息 → 标记此用户，回这页写备注",
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
                        onPress: () => openNoteEditor(id),
                    })
                );
            }
        }

        const markedSection = React.createElement(
            Forms.FormSection,
            { title: `被标记用户（${ids.length}）` },
            ...children
        );

        const editorInput = editor ? makeInput({
            key: "usermark-input",
            value: editor.value,
            placeholder: editor.mode === "note" ? "例如：半夜刷屏那位，可以留空"
                : editor.mode === "id" ? "123456789012345678 备注内容"
                : String(getLogLimit()),
            onChange: v => setEditor({ ...editor, value: v }),
        }) : null;

        const editorSection = editor && React.createElement(
            Forms.FormSection,
            {
                title: editor.mode === "note" ? `给「${editor.username}」写备注`
                    : editor.mode === "id" ? "按 ID 标记"
                    : "发言记录上限",
            },
            editorInput || React.createElement(Forms.FormRow, {
                key: "no-input",
                label: "这台设备找不到可用的输入框",
                subtext: "长按标记本身还是能用（备注留空）",
                disabled: true,
            }),
            React.createElement(Forms.FormRow, {
                key: "usermark-save",
                label: editor.mode === "id" ? "标记" : "保存",
                subtext: editor.mode === "note" ? "留空也算标记成功" : "",
                onPress: saveEditor,
            }),
            React.createElement(Forms.FormRow, {
                key: "usermark-cancel",
                label: "取消",
                onPress: () => setEditor(null),
            }),
            ...(editor.mode === "note" && marks[editor.userId] ? [
                React.createElement(Forms.FormRow, {
                    key: "usermark-unmark",
                    label: "取消标记这个人",
                    subtext: "连备注一起删掉",
                    destructive: true,
                    onPress: () => {
                        removeMark(editor.userId);
                        setEditor(null);
                        ui.toasts.showToast("已取消标记");
                        forceUpdate();
                    },
                }),
            ] : [])
        );

        const repairSection = React.createElement(
            Forms.FormSection,
            { title: "卡住了再动这里" },
            React.createElement(Forms.FormRow, {
                key: "cache-repair",
                label: repair.busy ? "正在清理模块缓存…" : (repair.armed ? "再点一次确认：删缓存 + 重启" : "修复：清空模块缓存并重启"),
                subtext: repair.msg || "弹窗一开就炸（报 FluxContainer(Alert) is undefined）才点它，平时别碰",
                destructive: true,
                onPress: () => {
                    if (repair.busy) return;
                    if (!repair.armed) {
                        setRepair({ armed: true, busy: false, msg: "确认后会删掉 caches/metro_modules.json 并重载 Discord" });
                        setTimeout(() => setRepair({ armed: false, busy: false, msg: "" }), 15000);
                        return;
                    }
                    setRepair({ armed: false, busy: true, msg: "正在删除，等两秒…" });
                    repairMetroCache()
                        .then(text => setRepair({ armed: false, busy: false, msg: text }))
                        .catch(e => setRepair({ armed: false, busy: false, msg: `清理失败：${e && e.message}` }));
                },
            })
        );

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
                onPress: () => setEditor({ mode: "id", value: "" }),
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
                    subtext: sheetTrace.lastError || `openLazy=${sheetTrace.openLazyPatched ? "已挂" : "没挂"} · 面板补丁=${sheetMods.length ? "已装" : "未装"} · 行组件=${sheetTrace.rowComp || "未定"}`,
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
            editorSection,
            idSection,
            markedSection,
            repairSection,
            React.createElement(
                Forms.FormSection,
                { title: `标记用户发言（${markedLogs.length}/${getLogLimit()}）` },
                ...renderLogRows(markedLogs.slice(0, 30), expandedLog, setExpandedLog),
                React.createElement(Forms.FormRow, {
                    key: "log-limit",
                    label: `记录上限：${getLogLimit()} 条`,
                    subtext: "只存名单内用户的发言",
                    onPress: () => setEditor({ mode: "limit", value: String(getLogLimit()) }),
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
