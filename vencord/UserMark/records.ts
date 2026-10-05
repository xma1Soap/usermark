/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { toMs } from "./utils";

export type MarkedMessageStatus = "NORMAL" | "EDITED" | "DELETED";

/**
 * 本地库里的一条发言。刻意只留展示要用的字段：
 * 网关消息在 flux 里是 Message 类实例，带 getter，整份塞进 IndexedDB
 * 要么结构化克隆炸掉，要么存进去一堆没用的东西。
 */
export interface MarkedRecord {
    id: string;
    authorId: string;
    channelId: string;
    guildId: string | null;
    /** ms 时间戳 */
    timestamp: number;
    editedTimestamp: number | null;
    content: string;
    status: MarkedMessageStatus;
    /** 附件文件名，只用来提示「有 N 个附件」 */
    attachments: string[];
    embedCount: number;
}

export interface SelectOptions {
    /** 当前被标记名单：不在名单里的作者一律不显示（取消标记即等效于清空它的记录） */
    marks: Record<string, unknown>;
    authorId?: string | null;
    query?: string;
    newest?: boolean;
    limit?: number;
}

const CONTENT_LIMIT = 2000;
const ATTACHMENT_LIMIT = 10;
const EPHEMERAL_FLAG = 1 << 6;
/** MessageState.PENDING / MessageState.FAILED：自己还没发出去的消息不记 */
const SKIP_STATES = new Set([1, 2]);

function clip(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function pickAttachments(attachments: unknown): string[] {
    if (!Array.isArray(attachments)) return [];

    return attachments
        .map(a => (typeof a?.name === "string" ? a.name : ""))
        .filter(Boolean)
        .slice(0, ATTACHMENT_LIMIT);
}

/**
 * 网关 / REST 的消息对象 -> 本地记录。字段不全就返回 null，不硬凑。
 */
export function toRecord(message: any, status: MarkedMessageStatus = "NORMAL"): MarkedRecord | null {
    const id = message?.id == null ? "" : String(message.id);
    const authorId = message?.author?.id == null ? "" : String(message.author.id);
    const channelId = message?.channel_id == null ? "" : String(message.channel_id);
    if (!id || !authorId || !channelId) return null;

    const timestamp = toMs(message.timestamp);
    if (timestamp == null) return null;

    return {
        id,
        authorId,
        channelId,
        guildId: message.guild_id == null ? null : String(message.guild_id),
        timestamp,
        editedTimestamp: toMs(message.edited_timestamp),
        content: clip(typeof message.content === "string" ? message.content : "", CONTENT_LIMIT),
        status,
        attachments: pickAttachments(message.attachments),
        embedCount: Array.isArray(message.embeds) ? message.embeds.length : 0,
    };
}

/** 这条消息该不该记：作者在名单里、不是 ephemeral、不是系统消息、不是自己发失败的 */
export function shouldCapture(message: any, marks: Record<string, unknown>): boolean {
    const authorId = message?.author?.id;
    if (typeof authorId !== "string" || !(authorId in marks)) return false;

    if ((Number(message?.flags ?? 0) & EPHEMERAL_FLAG) === EPHEMERAL_FLAG) return false;
    if (message?.type != null && message.type !== 0) return false;
    if (message?.pending === true || SKIP_STATES.has(Number(message?.state ?? 0))) return false;

    return true;
}

/** 取查询要展示的那一页；排序和过滤都放在内存里做，量级由 maxMarkedMessages 兜住 */
export function selectRecords(all: MarkedRecord[], opts: SelectOptions): MarkedRecord[] {
    const { marks, authorId = null, query = "", newest = true, limit = 100 } = opts;

    const needle = query.trim().toLowerCase();

    const rows = all.filter(record => {
        if (!record || !(record.authorId in marks)) return false;
        if (authorId && record.authorId !== authorId) return false;
        if (needle && !record.content.toLowerCase().includes(needle)) return false;
        return true;
    });

    rows.sort((a, b) => (newest ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));

    return limit > 0 ? rows.slice(0, limit) : rows;
}

/** 超出上限时要删掉的最旧记录 id；max <= 0 表示不限制 */
export function prunePlan(all: MarkedRecord[], max: number): string[] {
    if (max <= 0 || all.length <= max) return [];

    return [...all]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, all.length - max)
        .map(record => record.id);
}
