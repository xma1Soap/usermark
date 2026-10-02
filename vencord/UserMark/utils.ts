/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MarkEntry } from "./settings";

/** Discord 的 message.timestamp 类型声明是 Date，运行时也可能是 ISO 字符串，统一转 ms */
export function toMs(value: unknown): number | null {
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isNaN(ms) ? null : ms;
    }

    if (typeof value === "string") {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }

    if (typeof value === "number" && Number.isFinite(value)) return value;

    return null;
}

/** ms 时间戳 -> 本地可读时间；没有记录时给占位文案 */
export function formatTimestamp(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return "暂无记录";

    return new Date(ms).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

/** 徽标悬浮提示：备注 + 两个时间 */
export function badgeTooltip(entry: MarkEntry): string {
    const lines: string[] = [];

    if (entry.note) lines.push(`备注：${entry.note}`);
    lines.push(`被标记于：${formatTimestamp(entry.markedAt)}`);
    lines.push(`最新发言：${formatTimestamp(entry.lastMessageAt)}`);

    return lines.join("\n");
}
