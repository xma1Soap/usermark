/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { PencilIcon } from "@components/Icons";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { Menu, showToast } from "@webpack/common";

import { registerDecorators, unregisterDecorators } from "./Decorations";
import { MarkTarget, openMarkModal } from "./MarkModal";
import { getMark, purgeProbeLeftovers, removeMark, settings, sourceFromMessage } from "./settings";

function toTarget(user: User, message?: Message): MarkTarget {
    return {
        id: user.id,
        username: user.username,
        globalName: user.globalName,
        sourceMessage: message ? sourceFromMessage(message) : undefined,
    };
}

/** 在右键菜单末尾追加「标记 / 取消标记」两个入口 */
function pushMarkItems(children: Array<any | null>, target: MarkTarget): void {
    const existing = getMark(target.id);
    const name = target.globalName || target.username;

    children.push(
        <Menu.MenuItem
            key="vc-usermark-mark"
            id="vc-usermark-mark"
            label={existing ? "编辑标记备注" : "标记"}
            icon={PencilIcon}
            action={() => openMarkModal(target)}
        />
    );

    if (existing) {
        children.push(
            <Menu.MenuItem
                key="vc-usermark-unmark"
                id="vc-usermark-unmark"
                label="取消标记"
                action={() => {
                    removeMark(target.id);
                    showToast(`已取消标记 ${name}`);
                }}
            />
        );
    }
}

export default definePlugin({
    name: "UserMark",
    description: "右键一个人或他的消息即可「标记」：挂自定义备注，名字后面显示 [被标记]，设置页可搜索全部被标记用户的标记时间与最新发言时间。",
    searchTerms: ["mark", "tag", "note", "标记", "备注", "被标记"],
    tags: ["Appearance", "Friends", "Utility"],
    authors: [{ name: "星薄荷", id: 0n }],
    enabledByDefault: true,

    settings,
    dependencies: ["MessageDecorationsAPI", "MemberListDecoratorsAPI"],

    start() {
        registerDecorators();
        purgeProbeLeftovers();
    },

    stop() {
        unregisterDecorators();
    },

    contextMenus: {
        // 会员列表 / 私聊列表 / 用户资料弹出层
        "user-context"(children, { user }: { user?: User; }) {
            if (user?.id) pushMarkItems(children, toTarget(user));
        },
        "user-profile-actions"(children, { user }: { user?: User; }) {
            if (user?.id) pushMarkItems(children, toTarget(user));
        },
        "user-profile-overflow-menu"(children, { user }: { user?: User; }) {
            if (user?.id) pushMarkItems(children, toTarget(user));
        },
        // 右键消息本身：把这条消息记为标记来源
        "message"(children, { message }: { message?: Message; channel?: Channel; }) {
            const author = message?.author;
            if (author?.id) pushMarkItems(children, toTarget(author, message));
        },
    },
});
