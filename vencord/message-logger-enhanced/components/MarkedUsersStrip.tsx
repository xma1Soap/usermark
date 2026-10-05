/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { ChannelStore, ContextMenuApi, FluxDispatcher, GuildMemberStore, Menu, RelationshipStore, SelectedChannelStore, UserStore, useState, useStateFromStores } from "@webpack/common";

import { deleteMarkedUser, MarkedInfo, useMarkedMarks } from "../utils/markedUsers";
import { openMarkNoteModal } from "./MarkNoteModal";

const cl = classNameFactory("msg-logger-marked-");

/** 折叠阈值：超过这么多就先只露前几个，剩下收进 +N */
const COLLAPSED_COUNT = 6;

type Entry = MarkedInfo & { id: string; };

/*
 * 这几个 store 是 @webpack/common 里 waitForStore 异步赋值的 `export let` 绑定。
 * 插件代码在启动时就求值了，那时它们还是 undefined，
 * 所以绝对不能在模块顶层把 store 抄进常量里 —— 那样会永久存着 undefined，
 * useStateFromStores 拿它对 addChangeListener 就是渲染期崩（点开日志弹窗才崩，因为弹窗是懒加载的）。
 * 只能在 hook 里现取。
 */

/** 当前打开的频道在哪个服务器，昵称要按那个服务器取 */
function useCurrentGuildId(): string | undefined {
    return useStateFromStores([SelectedChannelStore, ChannelStore], () => {
        const channelId = SelectedChannelStore.getChannelId();
        if (!channelId) return undefined;

        return ChannelStore.getChannel(channelId)?.guild_id || undefined;
    });
}

/**
 * 这个人在当前频道里实际显示的名字：服务器昵称 > 私聊备注名 > 全局名 > 用户名。
 * 档案还没缓存下来就退回 snowflake，至少标签是可辨认、可复制的。
 */
function useDisplayName(userId: string, guildId: string | undefined): string {
    return useStateFromStores([UserStore, GuildMemberStore, RelationshipStore], () => {
        const user = UserStore.getUser(userId);
        if (!user) return userId;

        return (guildId && GuildMemberStore.getNick(guildId, userId))
            || RelationshipStore.getNickname(userId)
            || user.globalName
            || user.username;
    });
}

function useAvatarUrl(userId: string, guildId: string | undefined): string {
    return useStateFromStores([UserStore, GuildMemberStore], () => {
        const user = UserStore.getUser(userId);
        return user?.getAvatarURL(guildId, 32, false) ?? "";
    });
}

function chipTitle(entry: Entry, displayName: string): string {
    const when = entry.markedAt ? new Date(entry.markedAt).toLocaleString("zh-CN") : "未知";
    const lines = [`${displayName}（${entry.id}）· 标记于 ${when}`];

    if (entry.note) lines.push(`备注：${entry.note}`);
    if (entry.sourceContent) lines.push(`标记来源：${entry.sourceContent}`);

    return lines.join("\n");
}

interface ChipProps {
    entry: Entry;
    guildId: string | undefined;
    active: boolean;
    onClick: () => void;
    onViewSource: (entry: Entry) => void;
    onUnmark: (entry: Entry) => void;
}

/** 标签上的右键菜单：直达那条标记来源，以及改备注 / 取消标记 */
function ChipContextMenu({ entry, displayName, onViewSource, onUnmark }: {
    entry: Entry;
    displayName: string;
    onViewSource: (entry: Entry) => void;
    onUnmark: (entry: Entry) => void;
}) {
    return (
        <Menu.Menu
            navId="vc-marked-users-strip"
            onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
            aria-label="标记名单"
        >
            {entry.sourceId && (
                <Menu.MenuItem
                    key="vc-marked-view-source"
                    id="vc-marked-view-source"
                    label="查看标记来源"
                    action={() => onViewSource(entry)}
                />
            )}

            <Menu.MenuItem
                key="vc-marked-edit"
                id="vc-marked-edit"
                label="修改标记"
                action={() => openMarkNoteModal({ id: entry.id, name: displayName, note: entry.note ?? "" })}
            />

            <Menu.MenuItem
                key="vc-marked-unmark"
                id="vc-marked-unmark"
                label="取消标记"
                color="danger"
                action={() => onUnmark(entry)}
            />
        </Menu.Menu>
    );
}

function MarkedChip({ entry, guildId, active, onClick, onViewSource, onUnmark }: ChipProps) {
    const displayName = useDisplayName(entry.id, guildId);
    const avatarUrl = useAvatarUrl(entry.id, guildId);
    const note = entry.note?.trim();

    return (
        <button
            type="button"
            className={cl("chip", active && "chip-active")}
            title={chipTitle(entry, displayName)}
            onClick={onClick}
            onContextMenu={e => ContextMenuApi.openContextMenu(e, () =>
                <ChipContextMenu
                    entry={entry}
                    displayName={displayName}
                    onViewSource={onViewSource}
                    onUnmark={onUnmark}
                />
            )}
        >
            {!!avatarUrl && <img className={cl("chip-avatar")} src={avatarUrl} alt="" width={16} height={16} />}
            <span className={cl("chip-name")}>{displayName}</span>
            {!!note && note !== displayName && <span className={cl("chip-note")}>{note}</span>}
        </button>
    );
}

interface Props {
    /** 当前搜索框里正在筛的那个被标记用户 id，用于高亮 */
    activeUserId: string | null;
    onPick: (userId: string | null) => void;
    /** 名单变了（取消标记），让外面的消息列表重查一次 */
    onMarksChanged: () => void;
    /** 直接只看这个人标记时用的那条消息 */
    onViewSource: (userId: string, sourceId: string) => void;
}

/**
 * 日志弹窗标签栏下面那条名单带：每个被标记用户一枚标签，摆出头像、
 * 当前频道里的名字（取不到就摆 ID）和备注。
 * 点一下 = 在搜索框里筛这个人（from:<id>），再点一下取消；右键出「查看标记来源 / 修改标记 / 取消标记」。
 * 人数超过阈值先只露前若干枚，剩下的收进 +N，右侧给展开/收起。
 */
export function MarkedUsersStrip({ activeUserId, onPick, onMarksChanged, onViewSource }: Props) {
    const [expanded, setExpanded] = useState(false);
    const guildId = useCurrentGuildId();
    const marks = useMarkedMarks();

    const entries: Entry[] = Object.entries(marks).map(([id, info]) => ({ id, ...info }));
    if (entries.length === 0) return null;

    const visible = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);
    const hidden = entries.length - visible.length;
    const canToggle = entries.length > COLLAPSED_COUNT;

    return (
        <div className={cl("strip", !expanded && "strip-collapsed")}>
            <span className={cl("label")}>标记</span>

            {visible.map(entry => (
                <MarkedChip
                    key={entry.id}
                    entry={entry}
                    guildId={guildId}
                    active={activeUserId === entry.id}
                    onClick={() => onPick(activeUserId === entry.id ? null : entry.id)}
                    onViewSource={e => e.sourceId && onViewSource(e.id, e.sourceId)}
                    onUnmark={e => {
                        if (!deleteMarkedUser(e.id)) return;
                        if (activeUserId === e.id) onPick(null);
                        onMarksChanged();
                    }}
                />
            ))}

            {!expanded && hidden > 0 && (
                <span className={cl("more")}>+{hidden}</span>
            )}

            {canToggle && (
                <button
                    type="button"
                    className={cl("toggle")}
                    onClick={() => setExpanded(value => !value)}
                >
                    {expanded ? "收起" : `展开 ${entries.length} 人`}
                </button>
            )}
        </div>
    );
}
