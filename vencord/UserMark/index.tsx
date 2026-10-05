/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { LogIcon, PencilIcon } from "@components/Icons";
import definePlugin from "@utils/types";
import { Channel, Message, User } from "@vencord/discord-types";
import { Menu, showToast } from "@webpack/common";

import { startCapture, stopCapture } from "./capture";
import { registerDecorators, unregisterDecorators } from "./Decorations";
import { openMarkedMessagesModal } from "./MarkedMessagesModal";
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
    // ChatInputButtonAPI 不是可选的：工具栏那颗图标靠它的补丁往里塞，
    // 没声明依赖时插件不会被强制启用，图标就根本不出现（addChatBarButton 本身不报错，很容易看不出来）
    dependencies: ["MessageDecorationsAPI", "MemberListDecoratorsAPI", "ChatInputButtonAPI"],

    start() {
        registerDecorators();
        purgeProbeLeftovers();
        startCapture();

        addChatBarButton(
            "vc-usermark-logs",
            () => (
                <ChatBarButton tooltip="标记发言" onClick={openMarkedMessagesModal}>
                    <LogIcon width={20} height={20} />
                </ChatBarButton>
            ),
            LogIcon
        );
    },

    stop() {
        unregisterDecorators();
        stopCapture();
        removeChatBarButton("vc-usermark-logs");
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
