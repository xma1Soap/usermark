/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { InfoIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { closeAllModals, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { LazyComponent } from "@utils/react";
import type { Channel, User } from "@vencord/discord-types";
import { find, findByCodeLazy } from "@webpack";
import { Alerts, ChannelStore, ContextMenuApi, FluxDispatcher, Menu, NavigationRouter, React, showToast,TabBar, TextInput, Tooltip, useEffect, useMemo, useRef, UserStore, UserUtils, useState } from "@webpack/common";

import { DBMessageRecord, deleteMessageIDB, deleteMessagesBulkIDB } from "../db";
import { settings } from "../index";
import { LoggedMessage, LoggedMessageJSON } from "../types";
import { messageJsonToMessageClass } from "../utils";
import { fetchMarkedHistory, fetchMarkedSourceMessages } from "../utils/markedFetch";
import { deleteMarkedUser, getMarkedMarks, useMarkedMarks } from "../utils/markedUsers";
import { importLogs } from "../utils/settingsUtils";
import { ClearLogsButton } from "./ClearLogsButton";
import { useMessages } from "./hooks";
import { MarkedUsersStrip } from "./MarkedUsersStrip";
import { openMarkNoteModal } from "./MarkNoteModal";

export interface MessagePreviewProps {
    className: string;
    author: User;
    message: LoggedMessage;
    channel: Channel,
    compact: boolean;
    isGroupStart: boolean;
    hideSimpleEmbedContent: boolean;
}

const PrivateChannelRecord = findByCodeLazy(".is_message_request_timestamp,");
const MessagePreview = LazyComponent<MessagePreviewProps>(() => find(m => m?.type?.toString().includes("previewLinkTarget:") && !m?.type?.toString().includes("HAS_THREAD")));

const cl = classNameFactory("msg-logger-modal-");

export enum LogTabs {
    DELETED = "已删除",
    EDITED = "已编辑",
    GHOST_PING = "幽灵提及",
    MARKED = "标记用户发言"
}

interface Props {
    modalProps: ModalProps;
    initalQuery?: string;
}

export function LogsModal({ modalProps, initalQuery }: Props) {
    const [currentTab, setCurrentTab] = useState(LogTabs.DELETED);
    const [queryEh, setQuery] = useState(initalQuery ?? "");
    const [sortNewest, setSortNewest] = useState(settings.store.sortNewest);
    const [numDisplayedMessages, setNumDisplayedMessages] = useState(settings.store.messagesToDisplayAtOnceInLogs);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const { messages, total, statusTotal, pending, reset } = useMessages(queryEh, currentTab, sortNewest, numDisplayedMessages);

    // 名单在弹窗开着的时候也会被改（右键取消标记），所以订阅变化而不是挂载时拍一次快照
    const marks = useMarkedMarks();
    const markSourceIds = useMemo(
        () => new Set(Object.values(marks).map(m => m.sourceId).filter((id): id is string => Boolean(id))),
        [marks]
    );
    const markedIds = useMemo(() => new Set(Object.keys(marks)), [marks]);

    // 搜索框里带 from:<id> 就把对应标签高亮（「查看标记来源」会在后面再接 message:<id>，所以不锚结尾）
    const activeMarkedId = useMemo(() => {
        const match = /^(?:from|user):(\S+)/.exec(queryEh.trim());
        return match?.[1] ?? null;
    }, [queryEh]);

    const [fetchingMarked, setFetchingMarked] = useState(false);
    const autoFetchedRef = useRef(false);
    const sourceFetchedRef = useRef(false);

    // 「标记来源」那条必然早于标记时刻，页签一次只展示前 N 条，光靠频道回溯它经常挤不进第一页，
    // 于是行都不在列表里，标识自然看不见。弹窗一开就按 id 精确补一次，不等切页签。
    useEffect(() => {
        if (sourceFetchedRef.current) return;
        sourceFetchedRef.current = true;

        fetchMarkedSourceMessages()
            .then(added => added > 0 && reset())
            .catch(() => { /* 补不到就用库里那份，标识顶多多等一次手动拉取 */ });
    }, []);

    const runMarkedFetch = async (force: boolean) => {
        if (fetchingMarked) return;
        setFetchingMarked(true);

        try {
            const result = await fetchMarkedHistory(force);
            if (result.skipped) return;

            if (result.added > 0) {
                showToast(`在当前频道拉取到 ${result.added} 条标记用户消息`);
                reset();
            } else {
                showToast("当前频道没有新的标记用户消息");
            }
        } catch (e) {
            showToast("拉取标记用户消息失败");
        } finally {
            setFetchingMarked(false);
        }
    };

    // 切到「标记用户发言」时自动回溯一次（60 秒内不重复）
    useEffect(() => {
        if (currentTab !== LogTabs.MARKED || autoFetchedRef.current) return;
        autoFetchedRef.current = true;
        void runMarkedFetch(false);
    }, [currentTab]);

    return (
        <ModalRoot className={cl("root")} {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader className={cl("header")}>
                <TextInput value={queryEh} onChange={e => setQuery(e)} style={{ width: "100%" }} placeholder="筛选消息..." />
                <TabBar
                    type="top"
                    look="brand"
                    className={cl("tab-bar")}
                    selectedItem={currentTab}
                    onItemSelect={e => {
                        setCurrentTab(e);
                        setNumDisplayedMessages(settings.store.messagesToDisplayAtOnceInLogs);
                        contentRef.current?.firstElementChild?.scrollTo(0, 0);
                        // forceUpdate();
                    }}
                >
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.DELETED}
                    >
                        已删除
                    </TabBar.Item>
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.EDITED}
                    >
                        已编辑
                    </TabBar.Item>
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.GHOST_PING}
                    >
                        幽灵提及
                    </TabBar.Item>
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.MARKED}
                    >
                        标记用户发言
                    </TabBar.Item>
                </TabBar>
                <MarkedUsersStrip
                    activeUserId={activeMarkedId}
                    onMarksChanged={reset}
                    onViewSource={(userId, sourceId) => {
                        // message:<id> 走全量扫描再过滤，不受一次只显示 N 条的限制
                        setQuery(`from:${userId} message:${sourceId}`);
                        setCurrentTab(LogTabs.MARKED);
                        fetchMarkedSourceMessages()
                            .then(added => added > 0 && reset())
                            .catch(() => { /* 拉不到就是库里真没有，列表给个空结果 */ });
                    }}
                    onPick={userId => {
                        if (!userId) {
                            setQuery("");
                            return;
                        }
                        // 点标签 = 只看这个人，且切到按标记时间过滤的页签
                        setQuery(`from:${userId}`);
                        setCurrentTab(LogTabs.MARKED);
                    }}
                />
            </ModalHeader>
            <div style={{ opacity: modalProps.transitionState === 1 ? "1" : "0" }} className={cl("content-container")} ref={contentRef}>
                {
                    modalProps.transitionState === 1 &&
                    <ModalContent
                        className={cl("content")}
                    >
                        {messages != null && total === 0 && (
                            <EmptyLogs
                                hasQuery={queryEh.length !== 0}
                                reset={reset}
                            />
                        )}

                        {!pending && messages != null && (
                            <LogsContentMemo
                                visibleMessages={messages}
                                canLoadMore={messages.length < statusTotal && messages.length >= settings.store.messagesToDisplayAtOnceInLogs}
                                tab={currentTab}
                                sortNewest={sortNewest}
                                reset={reset}
                                markSourceIds={markSourceIds}
                                markedIds={markedIds}
                                handleLoadMore={() => setNumDisplayedMessages(e => e + settings.store.messagesToDisplayAtOnceInLogs)}
                            />
                        )}
                    </ModalContent>
                }
            </div>
            <ModalFooter className={cl("footer")}>
                {currentTab === LogTabs.MARKED && (
                    <Button
                        variant="secondary"
                        disabled={fetchingMarked}
                        onClick={() => runMarkedFetch(true)}
                    >
                        {fetchingMarked ? "拉取中…" : "拉取本频道标记发言"}
                    </Button>
                )}
                <ClearLogsButton label="清空所有日志" onCleared={reset} />
                <Button
                    variant="dangerSecondary"
                    disabled={messages?.length === 0}
                    onClick={() => Alerts.show({
                        title: "清除日志",
                        body: `确定要清除当前显示的 ${messages.length} 条记录吗？`,
                        confirmText: "清除",
                        // confirmColor: cl('danger-btn'),
                        // @ts-ignore
                        confirmVariant: "critical-primary",
                        cancelText: "取消",
                        onConfirm: async () => {
                            await deleteMessagesBulkIDB(messages.map(e => e.message_id));
                            reset();
                        }
                    })}
                >
                    清除可见日志
                </Button>
                <Link
                    onClick={() => {
                        setSortNewest(e => {
                            const val = !e;
                            settings.store.sortNewest = val;
                            return val;
                        });
                        contentRef.current?.firstElementChild?.scrollTo(0, 0);
                    }}
                >
                    排序：{sortNewest ? "旧的在前" : "新的在前"}
                </Link>
            </ModalFooter>
        </ModalRoot>
    );
}

interface LogContentProps {
    sortNewest: boolean;
    tab: LogTabs;
    visibleMessages: DBMessageRecord[];
    canLoadMore: boolean;
    reset: () => void;
    /** 各人被标记时用的那条消息 id，命中的行挂「标记来源」标识 */
    markSourceIds: Set<string>;
    /** 被标记名单，决定行右键菜单给不给「修改标记 / 取消标记」 */
    markedIds: Set<string>;
    handleLoadMore: () => void;
}

function LogsContent({ visibleMessages, canLoadMore, sortNewest, tab, reset, markSourceIds, markedIds, handleLoadMore }: LogContentProps) {
    if (visibleMessages.length === 0)
        return <NoResults tab={tab} />;

    return (
        <div className={cl("content-inner")}>
            {visibleMessages
                .map(({ message }, i) => (
                    <LMessage
                        key={message.id}
                        log={{ message }}
                        reset={reset}
                        isMarkSource={markSourceIds.has(message.id)}
                        isMarked={markedIds.has(message.author?.id)}
                        isGroupStart={isGroupStart(message, visibleMessages[i - 1]?.message, sortNewest)}
                    />
                ))}
            {
                canLoadMore &&
                <Button
                    style={{ marginTop: "1rem", width: "100%" }}
                    size="small" onClick={() => handleLoadMore()}
                >
                    加载更多
                </Button>
            }
        </div>
    );
}

const LogsContentMemo = LazyComponent(() => React.memo(LogsContent));


function NoResults({ tab }: { tab: LogTabs; }) {
    const generateSuggestedTabs = (tab: LogTabs) => {
        switch (tab) {
            case LogTabs.DELETED:
                return { nextTab: LogTabs.EDITED, lastTab: LogTabs.GHOST_PING };
            case LogTabs.EDITED:
                return { nextTab: LogTabs.GHOST_PING, lastTab: LogTabs.DELETED };
            case LogTabs.GHOST_PING:
                return { nextTab: LogTabs.MARKED, lastTab: LogTabs.EDITED };
            case LogTabs.MARKED:
                return { nextTab: LogTabs.DELETED, lastTab: LogTabs.GHOST_PING };
            default:
                return { nextTab: "", lastTab: "" };
        }
    };

    const { nextTab, lastTab } = generateSuggestedTabs(tab);

    return (
        <div className={cl("empty-logs", "content-inner")} style={{ textAlign: "center" }}>
            <BaseText size="lg">
                "<b>{tab}</b>" 中暂无记录。
            </BaseText>
            <BaseText size="lg" style={{ marginTop: "0.2rem" }}>
                试试看看 "<b>{nextTab}</b>" 或 "<b>{lastTab}</b>"？
            </BaseText>
        </div>
    );
}

function EmptyLogs({ hasQuery, reset: forceUpdate }: { hasQuery: boolean; reset: () => void; }) {
    return (
        <div className={cl("empty-logs", "content-inner")} style={{ textAlign: "center" }}>
            <Flex flexDirection="column" style={{ position: "relative" }}>

                <BaseText size="lg">
                    暂无日志
                </BaseText>

                {!hasQuery && (
                    <>
                        <Tooltip text="插件现已改用 IndexedDB 存储日志。如果你有旧版 JSON 日志，可以从日志目录导入。导入不会覆盖已有记录。">
                            {({ onMouseEnter, onMouseLeave }) => (
                                <div
                                    className={cl("info-icon")}
                                    onMouseEnter={onMouseEnter}
                                    onMouseLeave={onMouseLeave}
                                >
                                    <InfoIcon />
                                </div>
                            )}
                        </Tooltip>

                        <Button onClick={() => importLogs().then(() => forceUpdate())}>
                            导入日志
                        </Button>
                    </>
                )}
            </Flex>
        </div>
    );

}

interface LMessageProps {
    log: { message: LoggedMessageJSON; };
    isGroupStart: boolean,
    reset: () => void;
    /** 这条就是某人被标记时用的那条消息 */
    isMarkSource: boolean;
    /** 作者在被标记名单里 */
    isMarked: boolean;
}
/** 正在按 id补人的名单，防止同一条消息反复发请求 */
const pendingAuthorFetches = new Set<string>();

function LMessage({ log, isGroupStart, reset, isMarkSource, isMarked, }: LMessageProps) {
    const [, bumpAuthor] = useState(0);
    const message = useMemo(() => messageJsonToMessageClass(log), [log]);

    const authorId = log.message?.author?.id;

    // 用户不在缓存里时，头像会拼成空灰圈：按 id补一次人，回来后重算
    useEffect(() => {
        if (!authorId || UserStore.getUser(authorId)) return;
        if (pendingAuthorFetches.has(authorId)) return;

        pendingAuthorFetches.add(authorId);
        UserUtils.getUser(authorId)
            .then(() => bumpAuthor(x => x + 1))
            .catch(() => { /* 拉不到就用库里那份，至少有个默认头像 */ })
            .finally(() => pendingAuthorFetches.delete(authorId));
    }, [authorId]);

    // 拿到实时用户就换上（当前头像哈希、当前昵称）
    if (message && authorId) {
        const live = UserStore.getUser(authorId);
        if (live && message.author !== live) (message as any).author = live;
    }

    // console.log(message);

    if (!message) return null;

    return (
        <div
            className={isMarkSource ? "vc-usermark-source-msg" : undefined}
            onContextMenu={e => {
                ContextMenuApi.openContextMenu(e, () =>
                    <Menu.Menu
                        navId="message-logger"
                        onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
                        aria-label="消息记录器"
                    >

                        <Menu.MenuItem
                            key="jump-to-message"
                            id="jump-to-message"
                            label="跳转到原消息"
                            action={() => {
                                NavigationRouter.transitionTo(`/channels/${ChannelStore.getChannel(message.channel_id)?.guild_id ?? "@me"}/${message.channel_id}${message.id ? "/" + message.id : ""}`);
                                closeAllModals();
                            }}
                        />
                        <Menu.MenuItem
                            key="open-user-profile"
                            id="open-user-profile"
                            label="打开用户资料"
                            action={() => {
                                closeAllModals();
                                openUserProfile(message.author.id);
                            }}
                        />

                        <Menu.MenuItem
                            key="copy-content"
                            id="copy-content"
                            label="复制消息内容"
                            action={() => copyWithToast(message.content)}
                        />

                        <Menu.MenuItem
                            key="copy-user-id"
                            id="copy-user-id"
                            label="复制用户 ID"
                            action={() => copyWithToast(message.author.id)}
                        />

                        <Menu.MenuItem
                            key="copy-message-id"
                            id="copy-message-id"
                            label="复制消息 ID"
                            action={() => copyWithToast(message.id)}
                        />

                        <Menu.MenuItem
                            key="copy-channel-id"
                            id="copy-channel-id"
                            label="复制频道 ID"
                            action={() => copyWithToast(message.channel_id)}
                        />

                        {
                            log.message.guildId != null
                            && (
                                <Menu.MenuItem
                                    key="copy-server-id"
                                    id="copy-server-id"
                                    label="复制服务器 ID"
                                    action={() => copyWithToast(log.message.guildId!)}
                                />
                            )
                        }

                        {isMarked && (
                            <Menu.MenuItem
                                key="usermark-edit"
                                id="usermark-edit"
                                label="修改标记"
                                action={() => {
                                    const info = getMarkedMarks()[message.author.id];
                                    openMarkNoteModal({
                                        id: message.author.id,
                                        name: message.author.globalName || message.author.username,
                                        note: info?.note ?? ""
                                    });
                                }}
                            />
                        )}

                        {isMarked && (
                            <Menu.MenuItem
                                key="usermark-unmark"
                                id="usermark-unmark"
                                label="取消标记"
                                color="danger"
                                action={() => {
                                    if (deleteMarkedUser(message.author.id)) reset();
                                }}
                            />
                        )}

                        <Menu.MenuItem
                            key="delete-log"
                            id="delete-log"
                            label="删除此条记录"
                            color="danger"
                            action={() =>
                                deleteMessageIDB(log.message.id).then(() => reset())
                            }
                        />

                    </Menu.Menu>
                );
            }}>
            {isMarkSource && (
                <div className="vc-usermark-source-tag">标记来源</div>
            )}
            <MessagePreview
                className={`${cl("msg-preview")} ${message.deleted ? "messagelogger-deleted" : ""}`}
                author={message.author}
                message={message}
                channel={ChannelStore.getChannel(message.channel_id) || new PrivateChannelRecord({ id: "" })}
                compact={false}
                isGroupStart={isGroupStart}
                hideSimpleEmbedContent={false}
            />
        </div>
    );
}

export const openLogModal = (initalQuery?: string) => openModal(modalProps => <LogsModal modalProps={modalProps} initalQuery={initalQuery} />);

function isGroupStart(
    currentMessage: LoggedMessageJSON | undefined,
    previousMessage: LoggedMessageJSON | undefined,
    sortNewest: boolean
) {
    if (!currentMessage || !previousMessage) return true;

    if (currentMessage.id === previousMessage.id) return true;

    const [newestMessage, oldestMessage] = sortNewest
        ? [previousMessage, currentMessage]
        : [currentMessage, previousMessage];

    if (newestMessage.author.id !== oldestMessage.author.id) return true;

    const timeDifferenceInMinutes = Math.abs(
        (new Date(newestMessage.timestamp).getTime() - new Date(oldestMessage.timestamp).getTime()) / (1000 * 60)
    );

    return timeDifferenceInMinutes >= 5;
}
