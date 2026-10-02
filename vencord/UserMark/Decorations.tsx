/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageDecoration, type MessageDecorationProps, removeMessageDecoration } from "@api/MessageDecorations";
import { User } from "@vencord/discord-types";
import { Tooltip, useEffect } from "@webpack/common";

import { MarkEntry, recordMessage, settings } from "./settings";
import { badgeTooltip, toMs } from "./utils";

function MarkBadge({ entry }: { entry: MarkEntry; }) {
    return (
        <Tooltip text={badgeTooltip(entry)}>
            {tooltipProps => (
                <span {...tooltipProps} className="vc-usermark-badge">
                    [被标记]
                </span>
            )}
        </Tooltip>
    );
}

/**
 * 消息头里的徽标。走 Vencord 的 MessageDecorations 槽位，
 * 该槽位渲染在作者名之后，因此天然排在 ShowMeYourName 拼出来的昵称后面。
 */
function MessageMarkBadge({ message }: MessageDecorationProps) {
    const { marks } = settings.use(["marks"]);

    const userId: string | undefined = message?.author?.id;
    const entry = userId ? marks[userId] : undefined;
    const timestampMs = toMs(message?.timestamp);

    useEffect(() => {
        if (!userId || !entry || timestampMs == null) return;
        recordMessage(userId, timestampMs);
    }, [userId, entry, timestampMs]);

    if (!entry) return null;

    return <MarkBadge entry={entry} />;
}

/** 成员列表里的徽标 */
function MemberListMarkBadge({ user }: { user: User; }) {
    const { marks, memberListBadge } = settings.use(["marks", "memberListBadge"]);

    const entry = user?.id ? marks[user.id] : undefined;
    if (!memberListBadge || !entry) return null;

    return <MarkBadge entry={entry} />;
}

export function registerDecorators(): void {
    addMessageDecoration("usermark", MessageMarkBadge);
    addMemberListDecorator("usermark", MemberListMarkBadge);
}

export function unregisterDecorators(): void {
    removeMessageDecoration("usermark");
    removeMemberListDecorator("usermark");
}
