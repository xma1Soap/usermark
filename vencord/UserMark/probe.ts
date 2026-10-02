/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "./settings";

/**
 * 搜索界面源码探针（临时调试用）
 *
 * Discord 渲染搜索筛选弹层的组件在静态包里找不到（主包 + 305 预加载 + 252 懒加载全翻过），
 * 所以改成运行时抓：她在 Discord 里打开搜索框 / 筛选弹层时，沿 React fiber 把经过的组件
 * 源码与 props 收集起来，写进 Vencord settings，我直接读文件分析。
 *
 * 抓满 MAX_CAPTURES 条后自动停止并卸载监听。
 */

interface FiberDump {
    name: string;
    src?: string;
    props?: string[];
}

interface Capture {
    trigger: string;
    at: number;
    label: string;
    html?: string;
    classes?: string[];
    fibers: FiberDump[];
}

const MAX_CAPTURES = 10;
const MAX_FIBERS = 40;
const MAX_SRC = 7000;

const seenSignatures = new Set<string>();
let teardown: (() => void) | null = null;

function getFiber(el: Element | null | undefined): any {
    if (!el) return null;

    for (const key of Object.keys(el)) {
        if (key.startsWith("__reactFiber$")) return (el as any)[key];
    }

    return null;
}

function typeLabel(type: any): string {
    if (!type) return "unknown";
    if (typeof type === "string") return type;
    if (typeof type === "function") return type.name || type.displayName || "anonymous";
    return type.displayName || type.name || "object";
}

function propKeys(props: any): string[] {
    try {
        return Object.keys(props ?? {}).slice(0, 50);
    } catch {
        return [];
    }
}

function classChain(el: Element): string[] {
    const out: string[] = [];
    let cur: Element | null = el;

    for (let i = 0; cur && i < 8; i++) {
        out.push((cur.getAttribute("class") ?? "").slice(0, 240));
        cur = cur.parentElement;
    }

    return out;
}

/** 祖先链 + 有限深度的后代树，函数组件各取一份源码（全局去重） */
function collectFibers(el: Element): FiberDump[] {
    const root = getFiber(el);
    if (!root) return [];

    const out: FiberDump[] = [];

    const push = (fiber: any) => {
        if (out.length >= MAX_FIBERS) return;

        const type = fiber?.type;
        if (typeof type !== "function") return;

        let src = "";
        try {
            src = Function.prototype.toString.call(type);
        } catch {
            src = "";
        }

        const key = src.slice(0, 160) || typeLabel(type);
        if (seenSignatures.has(key)) return;
        seenSignatures.add(key);

        out.push({
            name: typeLabel(type),
            src: src.slice(0, MAX_SRC),
            props: propKeys(fiber.memoizedProps),
        });
    };

    // 往上：谁渲染了我
    let up: any = root;
    let depth = 0;
    while (up && depth < 60) {
        push(up);
        up = up.return;
        depth++;
    }

    // 往下：我里面渲染了谁（广度优先，限节点数）
    const queue: any[] = [root];
    let visited = 0;
    while (queue.length && out.length < MAX_FIBERS && visited < 500) {
        const fiber = queue.shift();
        visited++;
        if (!fiber) continue;

        push(fiber);
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
    }

    return out;
}

function readStore(): Capture[] {
    // 同样从 plain 读：store 是 Proxy，存回去会让 Electron IPC 结构化克隆失败
    try {
        const raw = settings.plain?.probe;
        if (!Array.isArray(raw)) return [];
        return JSON.parse(JSON.stringify(raw));
    } catch {
        return [];
    }
}

function writeStore(list: Capture[]): void {
    // 必须赋一个新数组：值相同时 store 的 set 钩子会直接 return，不触发落盘
    settings.store.probe = [...list];
}

function isSearchInput(el: Element): boolean {
    if (el.tagName !== "INPUT") return false;

    const placeholder = (el as HTMLInputElement).placeholder ?? "";
    if (/search|搜索|筛选|关键词|查找/i.test(placeholder)) return true;

    return /search/i.test(classChain(el).join(" "));
}

const POPUP_NEEDLES = [
    "更多筛选",
    "More Filters",
    "清除搜索历史",
    "Clear Search History",
    "Clear Recent Searches",
    "来自特定用户",
    "From a specific user",
    "包含特定类型",
];

function findPopup(): Element | null {
    const candidates = document.querySelectorAll<HTMLElement>(
        "div[class*='search'],div[class*='Search'],div[role='dialog'],div[role='listbox'],div[role='menu'],div[role='listboxItem']"
    );

    let best: Element | null = null;
    let bestLength = Infinity;

    for (const el of candidates) {
        const text = el.textContent ?? "";
        if (text.length === 0 || text.length > 12000) continue;
        if (!POPUP_NEEDLES.some(needle => text.includes(needle))) continue;

        if (text.length < bestLength) {
            best = el;
            bestLength = text.length;
        }
    }

    return best;
}

function capture(trigger: string, el: Element, label: string): void {
    const current = readStore();
    if (current.length >= MAX_CAPTURES) {
        stopProbe();
        return;
    }

    const fibers = collectFibers(el);
    if (fibers.length === 0) return;

    let html = "";
    try {
        html = el.outerHTML.slice(0, 3000);
    } catch {
        html = "";
    }

    current.push({
        trigger,
        at: Date.now(),
        label: label.slice(0, 100),
        html,
        classes: classChain(el),
        fibers,
    });

    try {
        writeStore(current);
    } catch (e) {
        console.error("[UserMark] 保存探针数据失败", e);
    }
}

export function startProbe(): void {
    if (teardown || settings.store.probeEnabled === false) return;

    const onFocusIn = (event: Event) => {
        try {
            const target = event.target as Element | null;
            if (target && isSearchInput(target)) {
                capture("focusin", target, (target as HTMLInputElement).placeholder || "search-input");
            }
        } catch {
            // 探针永不影响主功能
        }
    };

    document.addEventListener("focusin", onFocusIn, true);

    let timer: number | undefined;
    const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            try {
                const popup = findPopup();
                if (popup) capture("popup", popup, (popup.textContent ?? "").trim().slice(0, 90));
            } catch {
                // ignore
            }
        }, 400);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    teardown = () => {
        document.removeEventListener("focusin", onFocusIn, true);
        observer.disconnect();
        window.clearTimeout(timer);
        teardown = null;
    };
}

export function stopProbe(): void {
    teardown?.();
}
