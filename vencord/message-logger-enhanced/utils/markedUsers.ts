/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlainSettings, Settings, SettingsStore } from "@api/Settings";
import { useEffect, useState } from "@webpack/common";

const MARKS_PATH = "plugins.UserMark.marks";

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

/**
 * 组件里用的响应式名单：UserMark 那边改备注、本插件这边取消标记，都会推进来重渲染。
 * 不订阅的话，弹窗打开期间名单变了行高亮也不会刷新（旧代码在每行的 useMemo 里读一次，
 * 依赖只有消息 id，等于挂载时拍一次快照）。
 */
export function useMarkedMarks(): Record<string, MarkedInfo> {
    const [marks, setMarks] = useState(getMarkedMarks);

    useEffect(() => {
        const onChange = () => setMarks(getMarkedMarks());
        SettingsStore.addChangeListener(MARKS_PATH, onChange);
        // 挂起到订阅之间可能被改过，补读一次
        onChange();

        return () => SettingsStore.removeChangeListener(MARKS_PATH, onChange);
    }, []);

    return marks;
}

/**
 * 读一份能安全改、能安全写回的纯数据。
 * 必须走 PlainSettings：Settings 是 Proxy，从它身上展开对象会把每条记录也包成 Proxy，
 * Proxy 进不了 Electron IPC 的结构化克隆（DataCloneError），设置文件就不会落盘。
 */
function readMarksPlain(): Record<string, any> {
    try {
        const raw = PlainSettings.plugins?.UserMark?.marks;
        if (raw == null || typeof raw !== "object") return {};
        return JSON.parse(JSON.stringify(raw));
    } catch {
        return {};
    }
}

function writeMarks(marks: Record<string, any>): boolean {
    try {
        // 写 store 不写 plain：只有 store 的 set 钩子会通知监听器并触发落盘
        Settings.plugins.UserMark.marks = marks;
        return true;
    } catch (e) {
        console.error("[MessageLogger] 写入 UserMark 标记名单失败", e);
        return false;
    }
}

/** 只改备注，其余字段（标记时间、来源消息、最新发言时间）原样保留 */
export function setMarkedNote(userId: string, note: string): boolean {
    const marks = readMarksPlain();
    const entry = marks[userId];
    if (!entry) return false;

    marks[userId] = { ...entry, note: note.trim() };
    return writeMarks(marks);
}

export function deleteMarkedUser(userId: string): boolean {
    const marks = readMarksPlain();
    if (!(userId in marks)) return false;

    delete marks[userId];
    return writeMarks(marks);
}
