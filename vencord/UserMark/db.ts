/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MarkedMessageStatus, MarkedRecord } from "./records";

const DB_NAME = "UserMarkMessagesIDB";
const DB_VERSION = 1;
const STORE = "messages";

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`${what}失败`));
    });
}

function done(tx: IDBTransaction, what: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`${what}失败`));
        tx.onabort = () => reject(tx.error ?? new Error(`${what}被中止`));
    });
}

function openDb(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const database = req.result;
            if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("打不开 UserMark 记录库"));
    }).catch(e => {
        // 失败态不能永久留在 dbPromise 上：那样一次偶然的拒绝会让这个会话再也读不到库
        dbPromise = null;
        throw e;
    });

    return dbPromise;
}

/** 整库读出来。条数由 maxMarkedMessages 封顶，所以不做索引也够用 */
export async function getAllRecords(): Promise<MarkedRecord[]> {
    const database = await openDb();
    const tx = database.transaction(STORE, "readonly");
    const rows = await request(tx.objectStore(STORE).getAll(), "读取 UserMark 记录库");

    return Array.isArray(rows) ? rows : [];
}

/** 覆盖写入一条（编辑事件要盖掉旧内容） */
export async function saveRecord(record: MarkedRecord): Promise<void> {
    const database = await openDb();
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    await done(tx, "写入 UserMark 记录");
}

/**
 * 只写库里还没有的，返回真正新增的条数。
 * 回溯会反复扫同一批消息，用 put 覆盖会把已知的 DELETED 状态洗回 NORMAL。
 */
export async function addRecords(records: MarkedRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    const database = await openDb();
    const tx = database.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    const known = new Set((await request(store.getAllKeys(), "读取 UserMark 记录键名") as string[]) ?? []);
    const fresh = records.filter(record => !known.has(record.id));

    for (const record of fresh) store.put(record);
    await done(tx, "写入 UserMark 记录");

    return fresh.length;
}

/** 把库里已有的这些条改成某个状态（删除事件用），返回改了几条 */
export async function setStatus(ids: string[], status: MarkedMessageStatus): Promise<number> {
    if (ids.length === 0) return 0;

    const database = await openDb();
    const tx = database.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    let changed = 0;
    await Promise.all(ids.map(async id => {
        const existing = await request<MarkedRecord | undefined>(store.get(id), "读取 UserMark 记录");
        if (!existing || existing.status === status) return;

        store.put({ ...existing, status });
        changed++;
    }));
    await done(tx, "更新 UserMark 记录状态");

    return changed;
}

export async function deleteRecords(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const database = await openDb();
    const tx = database.transaction(STORE, "readwrite");
    ids.forEach(id => tx.objectStore(STORE).delete(id));
    await done(tx, "删除 UserMark 记录");
}

export async function clearRecords(): Promise<void> {
    const database = await openDb();
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx, "清空 UserMark 记录库");
}
