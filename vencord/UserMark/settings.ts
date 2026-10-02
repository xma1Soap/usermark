/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { MarkPanel } from "./MarkPanel";

/**
 * 标记时用来标记的那条消息（从消息菜单标记时才有）。
 * 内容存前截断，避免把长文撑进设置文件。
 */
export interface MarkSourceMessage {
    id: string;
    channelId?: string;
    content?: string;
    timestamp?: string;
}

export interface MarkEntry {
    /** 自定义备注内容 */
    note: string;
    /** 标记那一刻的用户名快照，对方改名后仍能认出是谁 */
    username: string;
    /** 被标记时间（ms 时间戳） */
    markedAt: number;
    /** 最新发言时间（ms 时间戳），插件启用后没捕获到发言则为 null */
    lastMessageAt: number | null;
    /** 标记时的那条消息，从用户菜单标记时为空 */
    sourceMessage?: MarkSourceMessage;
}

const SOURCE_CONTENT_LIMIT = 140;

/** 从 Discord 消息对象提一份精简副本，长文本截断 */
export function sourceFromMessage(message: any): MarkSourceMessage | undefined {
    if (!message?.id) return undefined;

    const raw = typeof message.content === "string" ? message.content.trim() : "";

    return {
        id: String(message.id),
        channelId: message.channel_id ? String(message.channel_id) : undefined,
        content: raw ? (raw.length > SOURCE_CONTENT_LIMIT ? `${raw.slice(0, SOURCE_CONTENT_LIMIT)}…` : raw) : undefined,
        timestamp: typeof message.timestamp === "string"
            ? message.timestamp
            : message.timestamp instanceof Date
                ? message.timestamp.toISOString()
                : undefined,
    };
}

export const settings = definePluginSettings({
    /** 数据本体：userId -> MarkEntry。写进 Vencord 设置文件，天然落盘 */
    marks: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, MarkEntry>,
    },
    /** 设置页里的「被标记名单」面板 */
    markPanel: {
        type: OptionType.COMPONENT,
        component: MarkPanel,
    },
    memberListBadge: {
        type: OptionType.BOOLEAN,
        description: "在成员列表的名字后面也显示 [被标记]",
        default: true,
    },
    /** 调试用：抓取 Discord 搜索界面源码（搜索面板改版已暂停，默认关闭） */
    probeEnabled: {
        type: OptionType.BOOLEAN,
        description: "抓取搜索界面组件源码（定位筛选菜单用，抓满自动关闭）",
        default: false,
    },
    /** 探针抓到的数据，只由程序读写 */
    probe: {
        type: OptionType.CUSTOM,
        default: [] as unknown[],
    },
});

export function getMarks(): Record<string, MarkEntry> {
    // 必须从 plain 读，不能从 settings.store 读：
    // store 是 Proxy，从它身上展开对象会把每条记录也包成 Proxy，
    // 而 Proxy 进不了 Electron IPC 的结构化克隆（DataCloneError），
    // 主进程收不到变更 -> 设置文件不更新 -> 重启后只剩磁盘上原有的那一条。
    try {
        const raw = settings.plain?.marks;
        if (!raw || typeof raw !== "object") return {};

        // JSON 往返顺手把可能已经混进去的 Proxy 拍成纯对象
        return JSON.parse(JSON.stringify(raw));
    } catch (e) {
        console.error("[UserMark] 读取标记数据失败", e);
        return {};
    }
}

export function getMark(userId: string): MarkEntry | undefined {
    return getMarks()[userId];
}

/** 打标记（或编辑已有备注）。重复编辑不会刷新被标记时间；不传来源消息则保留原有的那条 */
export function setMark(userId: string, note: string, username: string, sourceMessage?: MarkSourceMessage): void {
    const marks = { ...getMarks() };
    const prev = marks[userId];

    marks[userId] = {
        note: note.trim(),
        username: username || prev?.username || "",
        markedAt: prev?.markedAt ?? Date.now(),
        lastMessageAt: prev?.lastMessageAt ?? null,
        sourceMessage: sourceMessage ?? prev?.sourceMessage,
    };

    settings.store.marks = marks;
}

export function removeMark(userId: string): void {
    const marks = { ...getMarks() };
    if (!(userId in marks)) return;

    delete marks[userId];
    settings.store.marks = marks;
}

/**
 * 记录某个被标记用户的最新发言时间。
 * 只接受更晚的时间戳（翻旧消息不会把时间戳改回去），
 * 相同值直接跳过，避免「写盘 -> 重渲染 -> 再写盘」打转。
 *
 * 这里跑在 useEffect 里，一旦抛错会被消息装饰的 ErrorBoundary 吃掉，
 * 所以单独兜一层，不让设置写入失败变成满屏渲染报错。
 */
export function recordMessage(userId: string, timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return;

    try {
        const marks = getMarks();
        const entry = marks[userId];
        if (!entry) return;
        if (entry.lastMessageAt != null && timestampMs <= entry.lastMessageAt) return;

        marks[userId] = { ...entry, lastMessageAt: timestampMs };
        settings.store.marks = marks;
    } catch (e) {
        console.error("[UserMark] 记录最新发言时间失败", e);
    }
}
