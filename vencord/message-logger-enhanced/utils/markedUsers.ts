/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";

/**
 * 读取 UserMark 插件的标记名单。
 *
 * 这里刻意直接读 Vencord 的全局 Settings，不 import UserMark 的模块：
 * 那样会把 UserMark 的 definePluginSettings 拖进本插件的 chunk，
 * 而 UserMark 一旦被禁用，它的 settings.store 访问会抛错。
 * Settings 是纯数据，插件禁没禁用都能安全读。
 */
export function getMarkedAuthorIds(): Set<string> {
    try {
        const marks = Settings.plugins?.UserMark?.marks;
        if (marks == null || typeof marks !== "object") return new Set();
        return new Set(Object.keys(marks));
    } catch {
        return new Set();
    }
}

export function isMarkedAuthor(authorId?: string | null): boolean {
    if (!authorId) return false;

    try {
        const marks = Settings.plugins?.UserMark?.marks;
        return marks != null && typeof marks === "object" && authorId in marks;
    } catch {
        return false;
    }
}

export interface MarkedInfo {
    /** 被标记的时间（ms），缺省为 0 即不限制起始时间 */
    markedAt: number;
    /** 自定义备注，标签展示用 */
    note: string;
    /** 标记时的用户名快照，备注为空时的回退显示 */
    username: string;
    /** 标记时那条消息的 id，日志里认出它 */
    sourceId?: string;
    /** 那条消息所在频道，缺了就没法按 id 单独拉回来 */
    sourceChannelId?: string;
    /** 那条消息的文本摘要 */
    sourceContent?: string;
}

/** 标记名单 + 每人的标记时间与备注，供回溯拉取、页签过滤与名单条使用 */
export function getMarkedMarks(): Record<string, MarkedInfo> {
    try {
        const marks = Settings.plugins?.UserMark?.marks;
        if (marks == null || typeof marks !== "object") return {};

        const out: Record<string, MarkedInfo> = {};
        for (const [id, entry] of Object.entries(marks as Record<string, any>)) {
            out[id] = {
                markedAt: typeof entry?.markedAt === "number" ? entry.markedAt : 0,
                note: typeof entry?.note === "string" ? entry.note : "",
                username: typeof entry?.username === "string" ? entry.username : "",
                sourceId: typeof entry?.sourceMessage?.id === "string" ? entry.sourceMessage.id : undefined,
                sourceChannelId: typeof entry?.sourceMessage?.channelId === "string" ? entry.sourceMessage.channelId : undefined,
                sourceContent: typeof entry?.sourceMessage?.content === "string" ? entry.sourceMessage.content : undefined,
            };
        }

        return out;
    } catch {
        return {};
    }
}
