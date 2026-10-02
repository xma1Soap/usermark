/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { useState } from "@webpack/common";

import { getMarkedMarks, MarkedInfo } from "../utils/markedUsers";

const cl = classNameFactory("msg-logger-marked-");

/** 标签悬停文案：谁、什么时候标记，以及标记时的那条消息 */
function chipTitle(entry: MarkedInfo & { id: string; }): string {
    const when = entry.markedAt ? new Date(entry.markedAt).toLocaleString("zh-CN") : "未知";
    const base = `${entry.username || entry.id} · 标记于 ${when}`;

    return entry.sourceContent ? `${base}\n标记来源：${entry.sourceContent}` : base;
}

/** 折叠阈值：超过这么多就先只露前几个，剩下收进 +N */
const COLLAPSED_COUNT = 6;

interface Props {
    /** 当前搜索框里正在筛的那个被标记用户 id，用于高亮 */
    activeUserId: string | null;
    onPick: (userId: string | null) => void;
}

/**
 * 日志弹窗标签栏下面那条名单带：把所有被标记用户按备注摆出来。
 * 点一下 = 在搜索框里筛这个人（from:<id>），再点一下取消。
 * 人数超过阈值就折叠，最右侧给一个展开/收起。
 */
export function MarkedUsersStrip({ activeUserId, onPick }: Props) {
    const [expanded, setExpanded] = useState(false);

    const entries = Object.entries(getMarkedMarks()).map(([id, info]) => ({ id, ...info }));
    if (entries.length === 0) return null;

    const visible = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);
    const hidden = entries.length - visible.length;
    const canToggle = entries.length > COLLAPSED_COUNT;

    return (
        <div className={cl("strip", expanded ? "expanded" : "collapsed")}>
            <span className={cl("label")}>标记</span>

            {visible.map(entry => (
                <button
                    key={entry.id}
                    type="button"
                    className={cl("chip", activeUserId === entry.id && "active")}
                    title={chipTitle(entry)}
                    onClick={() => onPick(activeUserId === entry.id ? null : entry.id)}
                >
                    {entry.note || entry.username || entry.id}
                </button>
            ))}

            {!expanded && hidden > 0 && (
                <span className={cl("more")}>+{hidden}</span>
            )}

            {canToggle && (
                <button
                    type="button"
                    className={cl("toggle")}
                    onClick={() => setExpanded(value => !value)}
                >
                    {expanded ? "收起" : `展开 ${entries.length} 人`}
                </button>
            )}
        </div>
    );
}
