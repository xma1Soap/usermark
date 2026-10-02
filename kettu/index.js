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
            return marks && typeof marks === "object" ? marks : {};
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
                setMark(author.id, text, name, sourceFromMessage(message));
                ui.toasts.showToast(existing ? `已更新 ${name} 的备注` : `已标记 ${name}`);
            },
        });
    }

    /* ================= 长按菜单 =================
       Discord 移动端的消息长按菜单是 LazyActionSheet 拉起来的组件，
       模块特征是带 EmojiRow（社区插件里验证过的定位方式）。
       拿到组件返回的 JSX 后，遍历树找「一堆带 label+onPress 的行」，
       往里塞我们自己的项 —— 比按死层级路径耐版本变化。 */

    function findMenuRows(root) {
        const queue = [root];
        let best = null;

        while (queue.length) {
            const node = queue.shift();
            if (!node) continue;

            if (Array.isArray(node)) {
                const rows = node.filter(c =>
                    c &&
                    typeof c === "object" &&
                    c.props &&
                    typeof c.props.onPress === "function" &&
                    (c.props.label != null || c.props.text != null || c.props.title != null)
                );

                if (rows.length >= 2 && (!best || rows.length > best.length)) best = node;

                for (const child of node) queue.push(child);
                continue;
            }

            if (typeof node === "object") {
                if (node.props) queue.push(node.props.children);
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

        return React.createElement(
            Forms.FormSection,
            { title: `被标记用户（${ids.length}）` },
            ...children
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
