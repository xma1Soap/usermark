/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { OptionType } from "@utils/types";
import { useState } from "@webpack/common";

import { Native } from ".";
import { ClearLogsButton } from "./components/ClearLogsButton";
import { openLogModal } from "./components/LogsModal";
import { ImageCacheDir, LogsDir } from "./components/settings/FolderSelectInput";
import { openUpdaterModal } from "./components/UpdaterModal";
import { DEFAULT_IMAGE_CACHE_DIR } from "./utils/constants";
import { exportLogs, importLogs } from "./utils/settingsUtils";

function ImportLogsButton() {
    const [loading, setLoading] = useState(false);

    return (
        <Button
            disabled={loading}
            onClick={async () => {
                setLoading(true);
                try {
                    await importLogs();
                } finally {
                    setLoading(false);
                }
            }}
        >
            {loading ? "导入中..." : "导入日志"}
        </Button>
    );
}

function ExportLogsButton() {
    const [loading, setLoading] = useState(false);

    return (
        <Button
            disabled={loading}
            onClick={async () => {
                setLoading(true);
                try {
                    await exportLogs();
                } finally {
                    setLoading(false);
                }
            }}
        >
            {loading ? "导出中..." : "导出日志"}
        </Button>
    );
}

export const settings = definePluginSettings({
    checkForUpdate: {
        type: OptionType.COMPONENT,
        description: "检查更新",
        component: () =>
            <Button onClick={() => openUpdaterModal()}>
                检查更新
            </Button>
    },
    saveMessages: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "是否保存被删除和编辑过的消息。",
    },

    saveImages: {
        type: OptionType.BOOLEAN,
        description: "保存被删除消息中的附件（图片、视频等）。",
        default: false
    },

    sortNewest: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "日志按最新优先排序。",
    },

    cacheMessagesFromServers: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "默认只记录白名单和私信中的消息。开启后会记录所有服务器的消息——如果你加的服务器很多，这会导致缓存超限、漏记消息，并产生大量无关记录。",
    },

    autoCheckForUpdates: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "启动时自动检查插件更新。",
    },

    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "是否忽略机器人发送的消息",
        default: false,
        onChange() {
            // we will be handling the ignoreBots now (enabled or not) so the original message logger shouldnt
            Settings.plugins.MessageLogger.ignoreBots = false;
        }
    },

    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "是否忽略你自己发送的消息",
        default: false,
        onChange() {
            Settings.plugins.MessageLogger.ignoreSelf = false;
        }
    },

    ignoreMutedGuilds: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "不记录已静音服务器中的消息。白名单中的用户/频道仍会被记录。"
    },

    ignoreMutedCategories: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "不记录已静音分类下的频道消息。白名单中的用户/频道仍会被记录。"
    },

    ignoreMutedChannels: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "不记录已静音的单个频道中的消息。白名单中的用户/频道仍会被记录。"
    },

    alwaysLogDirectMessages: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "始终记录私信（DM）"
    },

    alwaysLogCurrentChannel: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "始终记录当前正在查看的频道。黑名单中的频道/用户仍会被忽略。"
    },

    permanentlyRemoveLogByDefault: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "日志中的删除按钮将直接永久删除记录（而非仅标记为已删除）"
    },

    hideMessageFromMessageLoggers: {
        default: false,
        type: OptionType.BOOLEAN,
        description: "开启后，消息右键菜单会多出一个选项，让你删除消息后不被其他消息记录器记录。注意：此功能可能不安全，请自行承担风险。"
    },

    ShowLogsButton: {
        default: true,
        type: OptionType.BOOLEAN,
        description: "是否在工具栏显示日志按钮",
        restartNeeded: true,
    },

    messagesToDisplayAtOnceInLogs: {
        default: 100,
        type: OptionType.NUMBER,
        description: "日志弹窗中一次显示的消息数量，以及点击「加载更多」时追加的数量。",
    },

    hideMessageFromMessageLoggersDeletedMessage: {
        default: "（这条消息已被隐藏）",
        type: OptionType.STRING,
        description: "使用「隐藏消息」功能时，替换原消息内容的占位文字。",
    },

    messageLimit: {
        default: 200,
        type: OptionType.NUMBER,
        description: "最多保存多少条消息。达到上限后自动删除最旧的记录。0 = 不限制"
    },

    attachmentSizeLimitInMegabytes: {
        default: 12,
        type: OptionType.NUMBER,
        description: "单个附件的最大保存大小（MB）。超过此大小的附件不会被保存。"
    },

    attachmentFileExtensions: {
        default: "png,jpg,jpeg,gif,webp,mp4,webm,mp3,ogg,wav",
        type: OptionType.STRING,
        description: "要保存的附件扩展名（逗号分隔）。不在此列表中的附件不会被保存。留空 = 保存所有附件。"
    },

    cacheLimit: {
        default: 1000,
        type: OptionType.NUMBER,
        description: "内存中缓存的最大消息数量，用于比对编辑/删除事件。达到上限后自动清除旧缓存。0 = 不限制"
    },

    whitelistedIds: {
        default: "",
        type: OptionType.STRING,
        description: "白名单：服务器、频道或用户 ID（逗号分隔）。"
    },

    blacklistedIds: {
        default: "",
        type: OptionType.STRING,
        description: "黑名单：服务器、频道或用户 ID（逗号分隔）。"
    },

    imageCacheDir: {
        type: OptionType.COMPONENT,
        description: "选择图片保存目录",
        component: ErrorBoundary.wrap(ImageCacheDir) as any
    },

    logsDir: {
        type: OptionType.COMPONENT,
        description: "选择日志保存目录",
        component: ErrorBoundary.wrap(LogsDir) as any
    },

    importLogs: {
        type: OptionType.COMPONENT,
        description: "从文件导入日志",
        component: ImportLogsButton
    },

    exportLogs: {
        type: OptionType.COMPONENT,
        description: "导出日志到文件",
        component: ExportLogsButton
    },

    openLogs: {
        type: OptionType.COMPONENT,
        description: "打开日志",
        component: () =>
            <Button onClick={() => openLogModal()}>
                打开日志
            </Button>
    },
    openImageCacheFolder: {
        type: OptionType.COMPONENT,
        description: "打开图片缓存目录",
        component: () =>
            <Button
                disabled={
                    IS_WEB
                    || settings.store.imageCacheDir == null
                    || settings.store.imageCacheDir === DEFAULT_IMAGE_CACHE_DIR
                }
                onClick={() => Native.showItemInFolder(settings.store.imageCacheDir)}
            >
                打开图片缓存文件夹
            </Button>
    },

    clearLogs: {
        type: OptionType.COMPONENT,
        description: "清空日志",
        component: () => <ClearLogsButton />
    },

});
