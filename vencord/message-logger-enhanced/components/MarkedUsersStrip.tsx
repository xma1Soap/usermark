/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { ChannelStore, GuildMemberStore, RelationshipStore, SelectedChannelStore, UserStore, useState, useStateFromStores } from "@webpack/common";

import { getMarkedMarks, MarkedInfo } from "../utils/markedUsers";

const cl = classNameFactory("msg-logger-marked-");

/** 折叠阈值：超过这么多就先只露前几个，剩下收进 +N */
const COLLAPSED_COUNT = 6;

const USER_STORES = [UserStore, GuildMemberStore, RelationshipStore];

type Entry = MarkedInfo & { id: string; };

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
    return useStateFromStores(USER_STORES, () => {
        const user = UserStore.getUser(userId);
        if (!user) return userId;

        return (guildId && GuildMemberStore.getNick(guildId, userId))
            || RelationshipStore.getNickname(userId)
            || user.globalName
            || user.username;
    });
}

function useAvatarUrl(userId: string, guildId: string | undefined): string {
    return useStateFromStores(USER_STORES, () => {
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
}

function MarkedChip({ entry, guildId, active, onClick }: ChipProps) {
    const displayName = useDisplayName(entry.id, guildId);
    const avatarUrl = useAvatarUrl(entry.id, guildId);
    const note = entry.note?.trim();

    return (
        <button
            type="button"
            className={cl("chip", active && "chip-active")}
            title={chipTitle(entry, displayName)}
            onClick={onClick}
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
}

/**
 * 日志弹窗标签栏下面那条名单带：每个被标记用户一枚标签，摆出头像、
 * 当前频道里的名字（取不到就摆 ID）和备注。
 * 点一下 = 在搜索框里筛这个人（from:<id>），再点一下取消。
 * 人数超过阈值先只露前若干枚，剩下的收进 +N，右侧给展开/收起。
 */
export function MarkedUsersStrip({ activeUserId, onPick }: Props) {
    const [expanded, setExpanded] = useState(false);
    const guildId = useCurrentGuildId();

    const entries: Entry[] = Object.entries(getMarkedMarks()).map(([id, info]) => ({ id, ...info }));
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
