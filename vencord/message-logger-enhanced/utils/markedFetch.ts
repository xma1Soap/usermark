/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, RestAPI, SelectedChannelStore } from "@webpack/common";

import { DBMessageStatus, hasMessageIDB } from "../db";
import { addMessage } from "../LoggedMessageManager";
import { getMarkedMarks, MarkedInfo } from "./markedUsers";

const Flogger = new Logger("MarkedFetch", "#f26c6c");

const PAGE_SIZE = 25;
const MAX_PAGES = 10;
const DM_PAGE_SIZE = 100;
const MAX_DM_PAGES = 4;
const REQUEST_DELAY = 250;
const AUTO_INTERVAL = 60_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface FetchMarkedResult {
    added: number;
    pages: number;
    users: number;
    skipped?: boolean;
    channelId?: string;
}

let running = false;
let lastRun = 0;

function isRateLimited(error: any): boolean {
    return error?.status === 429 || error?.response?.status === 429 || typeof error?.body?.retry_after === "number";
}

/**
 * 拉取当前频道里被标记用户的发言，供「标记用户发言」页签展示。
 *
 * 服务器频道走 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，一个用户一页请求；
 * 私聊/群聊没有搜索接口，改成分页读频道历史，读到的按名单过滤。
 *
 * **不再限定「标记时间之后」**：那个页签要显示被标记人的全部消息，
 * 包括标记之前发的。翻页有上限，所以另把「用来标记的那条」单独拉一次保证不漏。
 */
export async function fetchMarkedHistory(force = false): Promise<FetchMarkedResult> {
    const empty: FetchMarkedResult = { added: 0, pages: 0, users: 0 };

    if (running) return { ...empty, skipped: true };
    if (!force && Date.now() - lastRun < AUTO_INTERVAL) return { ...empty, skipped: true };

    const marks = getMarkedMarks();
    const userIds = Object.keys(marks);
    if (userIds.length === 0) return empty;

    const channelId = SelectedChannelStore.getChannelId?.();
    if (!channelId) return empty;

    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? null;

    running = true;
    lastRun = Date.now();

    try {
        const result = guildId
            ? await fetchFromGuildSearch({ guildId, channelId, marks, userIds, result: { ...empty, channelId } })
            : await fetchFromChannelHistory({ channelId, marks, userIds, result: { ...empty, channelId } });

        await fetchSourceMessages(Object.values(marks), result);

        return result;
    } finally {
        running = false;
    }
}

/**
 * 只把「用来标记的那条消息」补进日志库，返回新增条数。
 * 页签翻页一次只展示前 N 条，来源消息往往是标记之前很久的一条，光靠频道回溯挤不进第一页；
 * 而这条一旦没进库，日志里就完全没有能看到「标记来源」标识的行。
 * 弹窗一打开就调它，不等切到「标记用户发言」页签，也不受 60 秒冷却限制。
 */
export async function fetchMarkedSourceMessages(): Promise<number> {
    if (running) return 0;

    running = true;
    try {
        const result: FetchMarkedResult = { added: 0, pages: 0, users: 0 };
        await fetchSourceMessages(Object.values(getMarkedMarks()), result);
        return result.added;
    } finally {
        running = false;
    }
}

/**
 * 按 id 精确把「用来标记的那条消息」抓进日志库。
 * 它必然早于标记时刻，靠频道翻页不保证能碰到，所以单独保证一次。
 */
async function fetchSourceMessages(
    entries: MarkedInfo[],
    result: FetchMarkedResult
): Promise<void> {
    for (const info of entries) {
        const { sourceId, sourceChannelId } = info;
        if (!sourceId || !sourceChannelId) continue;

        try {
            if (await hasMessageIDB(sourceId)) continue;

            const res = await RestAPI.get({
                url: `/channels/${sourceChannelId}/messages`,
                query: { limit: 1, around: sourceId },
                retries: 1,
            });

            const list = Array.isArray(res.body) ? res.body : [];
            const target = list.find((m: any) => m?.id === sourceId);
            if (!target) continue;

            await addMessage(target, DBMessageStatus.NORMAL);
            result.added++;
            result.pages++;

            await sleep(REQUEST_DELAY);
        } catch (e: any) {
            Flogger.warn(`拉取标记来源消息失败 (${sourceId}):`, e?.message ?? e);
            if (isRateLimited(e)) return;
        }
    }
}

async function fetchFromGuildSearch(args: {
    guildId: string;
    channelId: string;
    marks: Record<string, { markedAt: number; }>;
    userIds: string[];
    result: FetchMarkedResult;
}): Promise<FetchMarkedResult> {
    const { guildId, channelId, marks, userIds, result } = args;

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
                Flogger.warn(`search failed (channel ${channelId}):`, e?.message ?? e);
                if (isRateLimited(e)) break outer;
                break;
            }

            result.pages++;

            const flat = groups.flat().filter(m => m && typeof m === "object");
            if (flat.length === 0) break;

            for (const message of flat) {
                if (message?.author?.id !== userId) continue;
                if (Number.isNaN(Date.parse(message?.timestamp))) continue;

                await addMessage(message, DBMessageStatus.NORMAL);
                result.added++;
            }

            // 这一页不满，说明到底了；否则最多翻 MAX_PAGES 页
            if (flat.length < PAGE_SIZE) break;

            await sleep(REQUEST_DELAY);
        }
    }

    Flogger.info(`fetched ${result.added} messages in channel ${channelId} (${result.users} marked users)`);
    return result;
}

async function fetchFromChannelHistory(args: {
    channelId: string;
    marks: Record<string, { markedAt: number; }>;
    userIds: string[];
    result: FetchMarkedResult;
}): Promise<FetchMarkedResult> {
    const { channelId, marks, result } = args;

    // 私聊/群聊没有搜索接口：频道历史读一遍，按名单过滤
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
            Flogger.warn(`channel history failed (${channelId}):`, e?.message ?? e);
            break;
        }

        result.pages++;
        if (messages.length === 0) break;

        for (const message of messages) {
            const authorId = message?.author?.id;
            if (!authorId || !(authorId in marks)) continue;
            if (Number.isNaN(Date.parse(message?.timestamp))) continue;

            await addMessage(message, DBMessageStatus.NORMAL);
            result.added++;
        }

        if (messages.length < DM_PAGE_SIZE) break;

        before = messages[messages.length - 1]?.id;
        if (!before) break;

        await sleep(REQUEST_DELAY);
    }

    Flogger.info(`fetched ${result.added} messages in channel ${channelId} (history)`);
    return result;
}
