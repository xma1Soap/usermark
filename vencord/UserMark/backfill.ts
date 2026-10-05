/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, RestAPI, SelectedChannelStore } from "@webpack/common";

import { addRecords, deleteRecords, getAllRecords } from "./db";
import { MarkedRecord, prunePlan, toRecord } from "./records";
import { getMarks, settings } from "./settings";

const Flogger = new Logger("UserMark", "#eb459e");

const PAGE_SIZE = 25;
const MAX_PAGES = 10;
const DM_PAGE_SIZE = 100;
const MAX_DM_PAGES = 4;
const REQUEST_DELAY = 250;
const AUTO_INTERVAL = 60_000;

export interface BackfillResult {
    added: number;
    pages: number;
    users: number;
    skipped?: boolean;
    channelId?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRateLimited(error: any): boolean {
    return error?.status === 429
        || error?.response?.status === 429
        || typeof error?.body?.retry_after === "number";
}

let running = false;
let lastRun = 0;

/**
 * 回溯当前频道里被标记用户的发言。
 *
 * 服务器频道走 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，一个用户一页页翻；
 * 私聊 / 群聊没有搜索接口，改读频道历史再按名单过滤。
 * 网关的 MESSAGE_CREATE 只覆盖当前订阅的频道，所以没打开过的频道得靠这条路补。
 */
export async function fetchCurrentChannel(force = false): Promise<BackfillResult> {
    const empty: BackfillResult = { added: 0, pages: 0, users: 0 };

    if (running) return { ...empty, skipped: true };
    if (!force && Date.now() - lastRun < AUTO_INTERVAL) return { ...empty, skipped: true };

    const marks = getMarks();
    const userIds = Object.keys(marks);
    if (userIds.length === 0) return empty;

    const channelId = SelectedChannelStore.getChannelId?.();
    if (!channelId) return empty;

    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;

    running = true;
    lastRun = Date.now();

    try {
        const result = guildId
            ? await fetchFromGuildSearch(String(guildId), String(channelId), userIds, { ...empty, channelId: String(channelId) })
            : await fetchFromChannelHistory(String(channelId), marks, { ...empty, channelId: String(channelId) });

        await fetchSourceMessages(result);
        await prune();

        return result;
    } finally {
        running = false;
    }
}

/** 只补「用来标记的那条消息」，它必然早于标记时刻，靠翻页不保证碰得到 */
export async function fetchMarkedSourceMessages(): Promise<number> {
    if (running) return 0;

    running = true;
    try {
        const result: BackfillResult = { added: 0, pages: 0, users: 0 };
        await fetchSourceMessages(result);
        return result.added;
    } finally {
        running = false;
    }
}

async function fetchSourceMessages(result: BackfillResult): Promise<void> {
    const marks = getMarks();
    const known = new Set((await getAllRecords()).map(record => record.id));

    for (const entry of Object.values(marks)) {
        const sourceId = entry.sourceMessage?.id;
        const sourceChannelId = entry.sourceMessage?.channelId;
        if (!sourceId || !sourceChannelId) continue;
        if (known.has(sourceId)) continue;

        try {
            const res = await RestAPI.get({
                url: `/channels/${sourceChannelId}/messages`,
                query: { limit: 1, around: sourceId },
                retries: 1,
            });

            const list = Array.isArray(res.body) ? res.body : [];
            const target = list.find((m: any) => String(m?.id) === String(sourceId));
            if (!target) continue;

            result.added += await addRecords([toRecord(target)].filter(Boolean) as MarkedRecord[]);
            result.pages++;

            await sleep(REQUEST_DELAY);
        } catch (e: any) {
            Flogger.warn(`拉取标记来源消息失败 (${sourceId}):`, e?.message ?? e);
            if (isRateLimited(e)) return;
        }
    }
}

async function fetchFromGuildSearch(
    guildId: string,
    channelId: string,
    userIds: string[],
    result: BackfillResult
): Promise<BackfillResult> {
    outer: for (const userId of userIds) {
        result.users++;

        for (let page = 0; page < MAX_PAGES; page++) {
            let groups: any[][];

            try {
                const res = await RestAPI.get({
                    url: `/guilds/${guildId}/messages/search`,
                    query: {
                        channel_id: channelId,
                        author_id: userId,
                        offset: page * PAGE_SIZE,
                        limit: PAGE_SIZE,
                        sort_by: "timestamp",
                        sort_order: "desc",
                        include_nsfw: true,
                    },
                    retries: 1,
                });

                groups = Array.isArray(res.body?.messages) ? res.body.messages : [];
            } catch (e: any) {
                Flogger.warn(`搜索失败 (频道 ${channelId}):`, e?.message ?? e);
                if (isRateLimited(e)) break outer;
                break;
            }

            result.pages++;

            const flat = groups.flat().filter(m => m && typeof m === "object");
            if (flat.length === 0) break;

            const records = flat
                .filter(message => message?.author?.id === userId)
                .map(message => toRecord(message))
                .filter(Boolean) as MarkedRecord[];

            result.added += await addRecords(records);

            // 这一页不满说明到底了，否则最多翻 MAX_PAGES 页
            if (flat.length < PAGE_SIZE) break;

            await sleep(REQUEST_DELAY);
        }
    }

    Flogger.info(`频道 ${channelId} 回溯到 ${result.added} 条（名单里 ${result.users} 人）`);
    return result;
}

async function fetchFromChannelHistory(
    channelId: string,
    marks: Record<string, { markedAt: number; }>,
    result: BackfillResult
): Promise<BackfillResult> {
    // 私聊 / 群聊没有搜索接口：频道历史读一遍，按名单过滤
    let before: string | undefined;

    for (let page = 0; page < MAX_DM_PAGES; page++) {
        let messages: any[];

        try {
            const res = await RestAPI.get({
                url: `/channels/${channelId}/messages`,
                query: before ? { limit: DM_PAGE_SIZE, before } : { limit: DM_PAGE_SIZE },
                retries: 1,
            });

            messages = Array.isArray(res.body) ? res.body : [];
        } catch (e: any) {
            Flogger.warn(`读频道历史失败 (${channelId}):`, e?.message ?? e);
            break;
        }

        result.pages++;
        if (messages.length === 0) break;

        const records = messages
            .filter(message => message?.author?.id in marks)
            .map(message => toRecord(message))
            .filter(Boolean) as MarkedRecord[];

        result.added += await addRecords(records);

        if (messages.length < DM_PAGE_SIZE) break;

        before = messages[messages.length - 1]?.id;
        if (!before) break;

        await sleep(REQUEST_DELAY);
    }

    Flogger.info(`频道 ${channelId} 回溯到 ${result.added} 条（读历史）`);
    return result;
}

async function prune(): Promise<void> {
    const max = Number(settings.store.maxMarkedMessages) || 0;
    if (max <= 0) return;

    const doomed = prunePlan(await getAllRecords(), max);
    if (doomed.length > 0) await deleteRecords(doomed);
}
