/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { FluxDispatcher, MessageStore } from "@webpack/common";

import { addRecords, deleteRecords, getAllRecords, saveRecord, setStatus } from "./db";
import { prunePlan, shouldCapture, toRecord } from "./records";
import { getMarks, settings } from "./settings";

const Flogger = new Logger("UserMark", "#eb459e");

/** 每写这么多条才整库扫一次做裁剪，别每条消息都读一遍库 */
const PRUNE_EVERY = 25;

let writesSincePrune = 0;

async function maybePrune(): Promise<void> {
    if (++writesSincePrune < PRUNE_EVERY) return;
    writesSincePrune = 0;

    const max = Number(settings.store.maxMarkedMessages) || 0;
    if (max <= 0) return;

    const doomed = prunePlan(await getAllRecords(), max);
    if (doomed.length > 0) await deleteRecords(doomed);
}

async function handleMessageCreate(payload: any): Promise<void> {
    if (!settings.store.logMarkedMessages) return;
    if (!shouldCapture(payload?.message, getMarks())) return;

    const record = toRecord(payload.message);
    if (!record) return;

    await addRecords([record]);
    await maybePrune();
}

async function handleMessageUpdate(payload: any): Promise<void> {
    if (!settings.store.logMarkedMessages) return;

    const channelId = payload?.message?.channel_id;
    const messageId = payload?.message?.id;
    if (!channelId || !messageId) return;

    // 置顶、加表情回应都会发 MESSAGE_UPDATE，而且常常只带变化字段；以缓存里的完整消息为准
    const message: any = MessageStore?.getMessage?.(String(channelId), String(messageId)) ?? payload.message;
    if (!message?.edited_timestamp) return;
    if (!shouldCapture(message, getMarks())) return;

    const record = toRecord(message, "EDITED");
    if (!record) return;

    await saveRecord(record);
}

async function handleMessageDelete(payload: any): Promise<void> {
    if (!settings.store.logMarkedMessages) return;
    if (!payload?.id) return;

    await setStatus([String(payload.id)], "DELETED");
}

async function handleMessageDeleteBulk(payload: any): Promise<void> {
    if (!settings.store.logMarkedMessages) return;
    if (!Array.isArray(payload?.ids)) return;

    await setStatus(payload.ids.map((id: unknown) => String(id)), "DELETED");
}

/** 网关回调里抛出去的错误会变成满屏报错，这里统一吞成日志 */
function safeRun(fn: (payload: any) => Promise<void>, what: string) {
    return (payload: any) => {
        fn(payload).catch(e => Flogger.error(`${what}失败`, e));
    };
}

const handlers = new Map<string, (payload: any) => void>();

export function startCapture(): void {
    if (handlers.size > 0) return;

    handlers.set("MESSAGE_CREATE", safeRun(handleMessageCreate, "记录被标记用户发言"));
    handlers.set("MESSAGE_UPDATE", safeRun(handleMessageUpdate, "记录被标记用户编辑"));
    handlers.set("MESSAGE_DELETE", safeRun(handleMessageDelete, "标记被删除发言"));
    handlers.set("MESSAGE_DELETE_BULK", safeRun(handleMessageDeleteBulk, "标记批量删除发言"));

    for (const [type, handler] of handlers) FluxDispatcher.subscribe(type, handler);
}

export function stopCapture(): void {
    for (const [type, handler] of handlers) FluxDispatcher.unsubscribe(type, handler);
    handlers.clear();
}
