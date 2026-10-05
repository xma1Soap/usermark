/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { GuildMemberStore, RelationshipStore, RestAPI, UserStore } from "@webpack/common";

const Flogger = new Logger("UserMark", "#eb459e");

const REQUEST_DELAY = 250;
const AVATAR_SIZE = 64;

export interface CachedProfile {
    name: string;
    avatarUrl: string;
}

/*
 * 被标记的人经常压根不在 UserStore 里（没点过他的资料，私聊对面那位尤其如此），
 * 这时 getUser() 给 undefined：名字只能退回 snowflake，头像直接没有。
 * 所以自己存一份最小档案，弹窗订阅它，档案到位就整块重渲染。
 */
const profiles = new Map<string, CachedProfile>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function emit(): void {
    version++;
    listeners.forEach(fn => fn());
}

export function getProfilesVersion(): number {
    return version;
}

export function subscribeProfiles(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function getCachedProfile(userId: string): CachedProfile | undefined {
    return profiles.get(userId);
}

/* 这些 store 是 waitForStore 异步赋值的绑定，只能在函数体里现取，别在模块顶层抄进常量 */
function readUser(userId: string): any {
    return UserStore?.getUser?.(userId);
}

function avatarUrlOf(user: any): string {
    const hash = user?.avatar;
    if (!user?.id || typeof hash !== "string") return "";

    // a_ 开头是动图头像，得用 gif
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${ext}?size=${AVATAR_SIZE}`;
}

/** 认一个人：档案接口回的 user、消息里的 author 都是这个形状 */
export function rememberProfile(user: any): boolean {
    const id = user?.id == null ? "" : String(user.id);
    const name = String(user?.global_name ?? user?.globalName ?? user?.username ?? "");
    const avatarUrl = avatarUrlOf(user);

    if (!id || (!name && !avatarUrl)) return false;

    const prev = profiles.get(id);
    if (prev?.name === name && prev?.avatarUrl === avatarUrl) return false;

    profiles.set(id, { name, avatarUrl });
    emit();
    return true;
}

/** 名字回退链：服务器昵称 → 私聊备注名 → 全局名 → 用户名 → 补来的档案 → 标记时的名字快照 → snowflake */
export function resolveDisplayName(userId: string, guildId?: string, snapshotName = ""): string {
    const user = readUser(userId);
    if (!user) return profiles.get(userId)?.name || snapshotName || userId;

    return (guildId ? GuildMemberStore?.getNick?.(guildId, userId) : "")
        || RelationshipStore?.getNickname?.(userId)
        || user.globalName
        || user.username
        || profiles.get(userId)?.name
        || snapshotName
        || userId;
}

/** 头像：档案在 UserStore 里就走 Discord 自己的取法（能拿到服务器头像），否则用补来的 hash 拼 CDN */
export function resolveAvatarUrl(userId: string, guildId?: string): string {
    const user = readUser(userId);
    if (user) return user.getAvatarURL?.(guildId, AVATAR_SIZE, false) ?? "";

    return profiles.get(userId)?.avatarUrl ?? "";
}

/**
 * 补档案：名单里那些 UserStore 没有、缓存里也没有、此刻也没在拉的人，一人一发
 * `GET /users/{id}/profile`。查无此人（注销/被封）只留日志，不重试。
 */
export async function ensureProfiles(userIds: Array<string | number>): Promise<number> {
    const queue = Array.from(new Set(userIds.map(String))).filter(id =>
        id && !profiles.has(id) && !pending.has(id) && !readUser(id));

    if (queue.length === 0) return 0;
    queue.forEach(id => pending.add(id));

    let fetched = 0;

    for (const id of queue) {
        try {
            const res = await RestAPI.get({
                url: `/users/${id}/profile`,
                query: { with_counts: false },
                retries: 1,
            });

            if (rememberProfile(res.body?.user)) fetched++;
        } catch (e: any) {
            Flogger.warn(`补档案失败 (${id}):`, e?.message ?? e);
        } finally {
            pending.delete(id);
        }

        await sleep(REQUEST_DELAY);
    }

    return fetched;
}
