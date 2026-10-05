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

import { startCapture, stopCapture } from "./capture";
import { registerDecorators, unregisterDecorators } from "./Decorations";
import { addIconToToolBar } from "./HeaderButton";
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
    description: "右键一个人或他的消息即可「标记」：挂自定义备注，名字后面显示 [被标记]；自带本地记录库，能直接看被标记用户的发言，不依赖任何日志插件。",
    searchTerms: ["mark", "tag", "note", "标记", "备注", "被标记"],
    tags: ["Appearance", "Friends", "Utility"],
    authors: [{ name: "星薄荷", id: 0n }],
    enabledByDefault: true,

    settings,
    dependencies: ["MessageDecorationsAPI", "MemberListDecoratorsAPI"],

    patches: [
        {
            // 频道右上角那一排图标。日志插件用的是同一个注入点，两处补丁各自插自己的调用，互不影响
            find: /toolbar:\i,mobileToolbar:\i/,
            replacement: {
                match: /(function \i\(\i\){)(.{1,200}toolbar.{1,100}mobileToolbar)/,
                replace: "$1$self.addIconToToolBar(arguments[0]);$2"
            }
        },
    ],

    // 补丁里的 $self 指向插件实例，所以这个方法必须挂在导出对象上
    addIconToToolBar,

    start() {
        registerDecorators();
        purgeProbeLeftovers();
        startCapture();
    },

    stop() {
        unregisterDecorators();
        stopCapture();
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
