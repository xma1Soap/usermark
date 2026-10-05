/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Margins } from "@components/margins";
import { Logger } from "@utils/Logger";
import { RenderModalProps } from "@vencord/discord-types";
import {
    Alerts,
    ChannelStore,
    closeAllModals,
    ContextMenuApi,
    FluxDispatcher,
    GuildMemberStore,
    Menu,
    MessageActions,
    Modal,
    openModal,
    RelationshipStore,
    SelectedChannelStore,
    TextInput,
    useEffect,
    useMemo,
    UserStore,
    useState,
    useStateFromStores } from "@webpack/common";

import { fetchCurrentChannel, fetchMarkedSourceMessages } from "./backfill";
import { clearRecords, getAllRecords } from "./db";
import { openMarkModal } from "./MarkModal";
import { MarkedRecord, selectRecords } from "./records";
import { asMarkMap, removeMark, settings } from "./settings";
import { formatTimestamp } from "./utils";

const Flogger = new Logger("UserMark", "#eb459e");
const cl = classNameFactory("vc-usermark-");

/** 名单带折叠阈值：超过这么多先只露前几枚 */
const COLLAPSED_COUNT = 6;

const STATUS_LABEL: Record<string, string> = {
    EDITED: "已编辑",
    DELETED: "已删除",
};

/*
 * @webpack/common 里这些 store 是 waitForStore 异步赋值的 export let 绑定，
 * 绝不能在模块顶层抄进常量（那时还是 undefined），只能在 hook 里现取。
 */

/** 当前打开的频道在哪个服务器，昵称按那个服务器取 */
function useCurrentGuildId(): string | undefined {
    return useStateFromStores([SelectedChannelStore, ChannelStore], () =>
        ChannelStore.getChannel(SelectedChannelStore.getChannelId())?.guild_id || undefined);
}

/** 这个人在当前场景里实际显示的名字：服务器昵称 > 私聊备注名 > 全局名 > 用户名 */
function useDisplayName(userId: string, guildId: string | undefined): string {
    return useStateFromStores([UserStore, GuildMemberStore, RelationshipStore], () => {
        const user = UserStore.getUser(userId);
        if (!user) return userId;

        return (guildId && GuildMemberStore.getNick(guildId, userId))
            || RelationshipStore.getNickname(userId)
            || user.globalName
            || user.username;
    });
}

function useAvatarUrl(userId: string, guildId: string | undefined): string {
    return useStateFromStores([UserStore, GuildMemberStore], () =>
        UserStore.getUser(userId)?.getAvatarURL(guildId, 32, false) ?? "");
}

function useChannelLabel(channelId: string): string {
    return useStateFromStores([ChannelStore], () => {
        const channel = ChannelStore.getChannel(channelId) as any;
        if (!channel) return channelId;
        if (channel.guild_id) return `#${channel.name || channelId}`;

        const meId = UserStore.getCurrentUser()?.id;
        const other = channel.recip?.user ?? (channel.recipients ?? []).find((r: any) => r?.id !== meId);
        return other ? (other.globalName || other.username) : "私聊";
    });
}

function closeDialog(modalProps: RenderModalProps): void {
    try {
        modalProps.onClose?.();
    } catch {
        // 忽略，走兜底
    }

    try {
        closeAllModals();
    } catch {
        // 关不掉也不能让点击报错
    }
}

export function openMarkedMessagesModal(): void {
    openModal(props => (
        <ErrorBoundary>
            <MarkedMessagesModal modalProps={props} />
        </ErrorBoundary>
    ));
}

interface ChipProps {
    userId: string;
    note: string;
    guildId: string | undefined;
    active: boolean;
    onClick: () => void;
    onUnmark: (userId: string) => void;
}

function ChipContextMenu({ displayName, userId, onUnmark }: {
    displayName: string;
    userId: string;
    onUnmark: () => void;
}) {
    return (
        <Menu.Menu
            navId="vc-usermark-strip"
            onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
            aria-label="被标记名单"
        >
            <Menu.MenuItem
                key="vc-usermark-chip-edit"
                id="vc-usermark-chip-edit"
                label="修改标记"
                action={() => openMarkModal({ id: userId, username: displayName })}
            />
            <Menu.MenuItem
                key="vc-usermark-chip-unmark"
                id="vc-usermark-chip-unmark"
                label="取消标记"
                color="danger"
                action={onUnmark}
            />
        </Menu.Menu>
    );
}

function Chip({ userId, note, guildId, active, onClick, onUnmark }: ChipProps) {
    const displayName = useDisplayName(userId, guildId);
    const avatarUrl = useAvatarUrl(userId, guildId);

    return (
        <button
            type="button"
            className={cl("chip", active && "chip-active")}
            onClick={onClick}
            onContextMenu={e => ContextMenuApi.openContextMenu(e, () =>
                <ChipContextMenu displayName={displayName} userId={userId} onUnmark={() => onUnmark(userId)} />
            )}
        >
            {!!avatarUrl && <img className={cl("chip-avatar")} src={avatarUrl} alt="" width={16} height={16} />}
            <span className={cl("chip-name")}>{displayName}</span>
            {!!note && note !== displayName && <span className={cl("chip-note")}>{note}</span>}
        </button>
    );
}

interface StripProps {
    marks: Record<string, { note?: string; }>;
    activeUserId: string | null;
    onPick: (userId: string | null) => void;
}

function UserStrip({ marks, activeUserId, onPick }: StripProps) {
    const [expanded, setExpanded] = useState(false);
    const guildId = useCurrentGuildId();

    const userIds = Object.keys(marks);
    if (userIds.length === 0) return null;

    const visible = expanded ? userIds : userIds.slice(0, COLLAPSED_COUNT);
    const hidden = userIds.length - visible.length;

    return (
        <div className={cl("strip", !expanded && "strip-collapsed")}>
            <span className={cl("strip-label")}>标记</span>

            {visible.map(userId => (
                <Chip
                    key={userId}
                    userId={userId}
                    note={(marks[userId]?.note ?? "").trim()}
                    guildId={guildId}
                    active={activeUserId === userId}
                    onClick={() => onPick(activeUserId === userId ? null : userId)}
                    onUnmark={() => {
                        removeMark(userId);
                        if (activeUserId === userId) onPick(null);
                    }}
                />
            ))}

            {!expanded && hidden > 0 && <span className={cl("strip-more")}>+{hidden}</span>}

            {userIds.length > COLLAPSED_COUNT && (
                <button type="button" className={cl("strip-toggle")} onClick={() => setExpanded(v => !v)}>
                    {expanded ? "收起" : `展开 ${userIds.length} 人`}
                </button>
            )}
        </div>
    );
}

interface RowProps {
    record: MarkedRecord;
    note: string;
    onJump: (record: MarkedRecord) => void;
    onUnmark: (userId: string) => void;
}

function RowContextMenu({ record, displayName, onJump, onUnmark }: {
    record: MarkedRecord;
    displayName: string;
    onJump: () => void;
    onUnmark: () => void;
}) {
    return (
        <Menu.Menu
            navId="vc-usermark-row"
            onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
            aria-label="标记发言"
        >
            <Menu.MenuItem key="vc-usermark-jump" id="vc-usermark-jump" label="跳到原消息" action={onJump} />
            <Menu.MenuItem
                key="vc-usermark-copy"
                id="vc-usermark-copy"
                label="复制内容"
                disabled={!record.content}
                action={() => navigator.clipboard?.writeText(record.content).catch(() => undefined)}
            />
            <Menu.MenuItem
                key="vc-usermark-row-edit"
                id="vc-usermark-row-edit"
                label="修改标记"
                action={() => openMarkModal({ id: record.authorId, username: displayName })}
            />
            <Menu.MenuItem
                key="vc-usermark-row-unmark"
                id="vc-usermark-row-unmark"
                label="取消标记"
                color="danger"
                action={onUnmark}
            />
        </Menu.Menu>
    );
}

function Row({ record, note, onJump, onUnmark }: RowProps) {
    const guildId = record.guildId ?? undefined;
    const displayName = useDisplayName(record.authorId, guildId);
    const avatarUrl = useAvatarUrl(record.authorId, guildId);
    const channelLabel = useChannelLabel(record.channelId);
    const statusLabel = STATUS_LABEL[record.status];

    return (
        <div
            className={cl("row", statusLabel && "row-muted")}
            onClick={() => onJump(record)}
            onContextMenu={e => ContextMenuApi.openContextMenu(e, () => (
                <RowContextMenu
                    record={record}
                    displayName={displayName}
                    onJump={() => onJump(record)}
                    onUnmark={() => onUnmark(record.authorId)}
                />
            ))}
        >
            {!!avatarUrl && <img className={cl("row-avatar")} src={avatarUrl} alt="" width={24} height={24} />}

            <div className={cl("row-main")}>
                <div className={cl("row-head")}>
                    <span className={cl("row-name")}>{displayName}</span>
                    {!!note && note !== displayName && <span className={cl("row-note")}>{note}</span>}
                    <span className={cl("row-meta")}>
                        {channelLabel} · {formatTimestamp(record.timestamp)}
                        {!!statusLabel && ` · ${statusLabel}`}
                        {!!record.attachments.length && ` · ${record.attachments.length} 个附件`}
                        {!!record.embedCount && ` · ${record.embedCount} 个嵌入`}
                    </span>
                </div>

                <div className={cl("row-content")}>{record.content || "（无文字内容）"}</div>
            </div>
        </div>
    );
}

function MarkedMessagesModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const marks = asMarkMap(settings.use(["marks"]).marks);
    const logging = settings.use(["logMarkedMessages"]).logMarkedMessages;

    const [authorId, setAuthorId] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [newest, setNewest] = useState(true);
    const [limit, setLimit] = useState(() => Number(settings.store.markedMessagesPerPage) || 100);
    const [records, setRecords] = useState<MarkedRecord[]>([]);
    const [fetching, setFetching] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    const reload = () => setReloadKey(k => k + 1);

    useEffect(() => {
        let cancelled = false;

        getAllRecords()
            .then(rows => !cancelled && setRecords(rows))
            .catch(e => Flogger.error("读取本地记录失败", e));

        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    // 打开时补一次：先按 id 精确补「标记来源那条」，再回溯当前频道（非强制，撞 60 秒冷却就跳过）。
    // 两条路共用同一个 running 闸门，必须串着来：并排发的话后一条一定被判成「正在跑」而整条跳过，
    // 表现就是弹窗开着却一条都没补进来。
    useEffect(() => {
        (async () => {
            try {
                const sourceAdded = await fetchMarkedSourceMessages();
                const backfill = await fetchCurrentChannel();
                if (sourceAdded > 0 || backfill.added > 0) reload();
            } catch (e) {
                Flogger.error("打开弹窗时补记录失败", e);
            }
        })();
    }, []);

    const rows = useMemo(
        () => selectRecords(records, { marks, authorId, query, newest, limit }),
        [records, marks, authorId, query, newest, limit]
    );

    const totalForFilter = useMemo(
        () => selectRecords(records, { marks, authorId, query, newest, limit: 0 }).length,
        [records, marks, authorId, query, newest]
    );

    const jumpTo = (record: MarkedRecord) => {
        try {
            if (record.channelId !== SelectedChannelStore.getChannelId()) {
                FluxDispatcher.dispatch({ type: "SELECT_CHANNEL", guildId: record.guildId, channelId: record.channelId });
            }

            MessageActions.jumpToMessage({
                channelId: record.channelId,
                messageId: record.id,
                flash: true,
                jumpType: "INSTANT",
            });

            closeDialog(modalProps);
        } catch (e) {
            Flogger.error("跳转失败", e);
        }
    };

    const runFetch = async () => {
        if (fetching) return;
        setFetching(true);

        try {
            const result = await fetchCurrentChannel(true);
            if (result.added > 0) reload();
            else if (result.skipped) Flogger.info("回溯被跳过（正在跑或未到间隔）");
        } catch (e) {
            Flogger.error("回溯当前频道失败", e);
        } finally {
            setFetching(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="标记发言"
            subtitle="只记录被标记用户的发言，存在 UserMark 自己的本地库里。"
            actions={[
                { text: "关闭", variant: "secondary", onClick: () => closeDialog(modalProps) }
            ]}
        >
            <div className={cl("logs")}>
                {!logging && (
                    <div className={cl("logs-warn")}>
                        本地记录目前是关的：设置里的「把被标记用户的发言存进本地库」打开之后才会开始捕获。
                    </div>
                )}

                <div className={cl("logs-toolbar")}>
                    <TextInput
                        className={cl("logs-search")}
                        value={query}
                        onChange={setQuery}
                        placeholder="搜索发言内容"
                    />
                    <Button variant="secondary" size="small" disabled={fetching} onClick={runFetch}>
                        {fetching ? "拉取中…" : "拉取本频道"}
                    </Button>
                    <Button variant="secondary" size="small" onClick={() => setNewest(v => !v)}>
                        {newest ? "新的在前" : "旧的在前"}
                    </Button>
                    <Button
                        variant="dangerSecondary"
                        size="small"
                        disabled={records.length === 0}
                        onClick={() => Alerts.show({
                            title: "清空本地记录",
                            body: "只清 UserMark 自己存的发言，不影响被标记名单和日志插件。",
                            confirmText: "清空",
                            cancelText: "取消",
                            onConfirm: async () => {
                                try {
                                    await clearRecords();
                                    reload();
                                } catch (e) {
                                    Flogger.error("清空本地记录失败", e);
                                }
                            }
                        })}
                    >
                        清空记录
                    </Button>
                    <span className={cl("logs-count")}>
                        {rows.length}{totalForFilter > rows.length ? ` / ${totalForFilter}` : ""} 条
                    </span>
                </div>

                <UserStrip marks={marks} activeUserId={authorId} onPick={setAuthorId} />

                <div className={cl("list")}>
                    {rows.length === 0 && (
                        <div className={cl("empty")}>
                            {Object.keys(marks).length === 0
                                ? "还没有标记任何人。右键一个人或他的消息，选「标记」。"
                                : "本地还没有这些人的发言。打开过的频道会自动记下来，也可以点「拉取本频道」补当前的。"}
                        </div>
                    )}

                    {rows.map(record => (
                        <Row
                            key={record.id}
                            record={record}
                            note={(marks[record.authorId]?.note ?? "").trim()}
                            onJump={jumpTo}
                            onUnmark={userId => {
                                removeMark(userId);
                                if (authorId === userId) setAuthorId(null);
                            }}
                        />
                    ))}
                </div>

                {totalForFilter > rows.length && (
                    <Button
                        className={Margins.top8}
                        variant="secondary"
                        size="small"
                        onClick={() => setLimit(n => n + (Number(settings.store.markedMessagesPerPage) || 100))}
                    >
                        显示更多
                    </Button>
                )}
            </div>
        </Modal>
    );
}
