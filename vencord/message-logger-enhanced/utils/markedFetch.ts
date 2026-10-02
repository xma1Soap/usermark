/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, RestAPI, SelectedChannelStore } from "@webpack/common";

import { DBMessageStatus } from "../db";
import { addMessage } from "../LoggedMessageManager";
import { getMarkedMarks } from "./markedUsers";

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
 * 只拉当前频道里被标记用户的发言。
 *
 * 之前是遍历所有服务器，几十个请求太慢；现在限定到当前频道后：
 * 服务器频道直接用 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，一个用户一页请求；
 * 私聊/群聊没有搜索接口，改成分页读频道历史，读到的按名单过滤。
 *
 * 时间下界是每个人的标记时间，比它更早的消息拉了也会被页签过滤掉，不浪费请求。
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
        return guildId
            ? await fetchFromGuildSearch({ guildId, channelId, marks, userIds, result: { ...empty, channelId } })
            : await fetchFromChannelHistory({ channelId, marks, userIds, result: { ...empty, channelId } });
    } finally {
        running = false;
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
        const markedAt = marks[userId]?.markedAt ?? 0;

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

            let inserted = 0;
            let oldest = Infinity;

            for (const message of flat) {
                const ts = Date.parse(message?.timestamp);
                if (!Number.isNaN(ts)) oldest = Math.min(oldest, ts);

                if (message?.author?.id !== userId) continue;
                if (Number.isNaN(ts)) continue;
                if (markedAt && ts < markedAt) continue;

                await addMessage(message, DBMessageStatus.NORMAL);
                result.added++;
                inserted++;
            }

            // 已经翻到标记时间之前，或这一页没有新东西，收工
            if (inserted === 0 || oldest < markedAt) break;

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
    const earliestMarkedAt = Math.min(...Object.values(marks).map(m => m.markedAt || 0).filter(Boolean), Infinity);
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

        let oldest = Infinity;

        for (const message of messages) {
            const ts = Date.parse(message?.timestamp);
            if (!Number.isNaN(ts)) oldest = Math.min(oldest, ts);

            const markedAt = marks[message?.author?.id]?.markedAt ?? 0;
            if (!markedAt) continue;
            if (Number.isNaN(ts) || ts < markedAt) continue;

            await addMessage(message, DBMessageStatus.NORMAL);
            result.added++;
        }

        if (oldest < earliestMarkedAt) break;

        before = messages[messages.length - 1]?.id;
        if (!before) break;

        await sleep(REQUEST_DELAY);
    }

    Flogger.info(`fetched ${result.added} messages in channel ${channelId} (history)`);
    return result;
}
