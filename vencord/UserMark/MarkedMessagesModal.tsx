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
    Modal,
    NavigationRouter,
    openModal,
    RelationshipStore,
    SelectedChannelStore,
    useEffect,
    useMemo,
    UserStore,
    useState,
    useStateFromStores } from "@webpack/common";

import { fetchCurrentChannel, fetchMarkedSourceMessages } from "./backfill";
import { clearRecords, getAllRecords } from "./db";
import { openMarkModal } from "./MarkModal";
import { ensureProfiles, getProfilesVersion, resolveAvatarUrl, resolveDisplayName, subscribeProfiles } from "./profiles";
import { MarkedRecord, selectRecords } from "./records";
import { asMarkMap, MarkEntry, MarkSourceMessage, removeMark, settings } from "./settings";
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

/** 这个人在当前场景里实际显示的名字，回退链见 profiles.ts */
function useDisplayName(userId: string, guildId: string | undefined, snapshotName = ""): string {
    return useStateFromStores([UserStore, GuildMemberStore, RelationshipStore], () =>
        resolveDisplayName(userId, guildId, snapshotName));
}

function useAvatarUrl(userId: string, guildId: string | undefined): string {
    return useStateFromStores([UserStore, GuildMemberStore], () => resolveAvatarUrl(userId, guildId));
}

/* 档案是异步补进来的，到位时得有人把弹窗重渲染一遍，不然头像要等别的什么原因刷新才露出来 */
function useProfilesVersion(): number {
    const [version, setVersion] = useState(getProfilesVersion());

    useEffect(() => subscribeProfiles(() => setVersion(getProfilesVersion())), []);

    return version;
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
    /** 标记那一刻存下的显示名快照，档案没缓存时拿它顶名字 */
    snapshotName: string;
    source?: MarkSourceMessage;
    guildId: string | undefined;
    active: boolean;
    onClick: () => void;
    onUnmark: (userId: string) => void;
    onViewSource: (source: MarkSourceMessage) => void;
}

function ChipContextMenu({ displayName, userId, source, onUnmark, onViewSource }: {
    displayName: string;
    userId: string;
    source?: MarkSourceMessage;
    onUnmark: () => void;
    onViewSource: () => void;
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
            {/* 从用户菜单标的没有「用来标记的那条」，这时候压根不给这一项 */}
            {!!source?.id && !!source.channelId && (
                <Menu.MenuItem
                    key="vc-usermark-chip-source"
                    id="vc-usermark-chip-source"
                    label="跳到标记来源"
                    action={onViewSource}
                />
            )}
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

function Chip({ userId, note, snapshotName, source, guildId, active, onClick, onUnmark, onViewSource }: ChipProps) {
    const displayName = useDisplayName(userId, guildId, snapshotName);
    const avatarUrl = useAvatarUrl(userId, guildId);

    return (
        <button
            type="button"
            className={cl("chip", active && "chip-active")}
            onClick={onClick}
            onContextMenu={e => ContextMenuApi.openContextMenu(e, () =>
                <ChipContextMenu
                    displayName={displayName}
                    userId={userId}
                    source={source}
                    onUnmark={() => onUnmark(userId)}
                    onViewSource={() => source && onViewSource(source)}
                />
            )}
        >
            {!!avatarUrl && <img className={cl("chip-avatar")} src={avatarUrl} alt="" width={16} height={16} />}
            <span className={cl("chip-name")}>{displayName}</span>
            {!!note && note !== displayName && <span className={cl("chip-note")}>{note}</span>}
        </button>
    );
}

interface StripProps {
    marks: Record<string, MarkEntry>;
    activeUserId: string | null;
    onPick: (userId: string | null) => void;
    onViewSource: (source: MarkSourceMessage) => void;
}

function UserStrip({ marks, activeUserId, onPick, onViewSource }: StripProps) {
    const [expanded, setExpanded] = useState(false);
    const guildId = useCurrentGuildId();

    // 名单是插入序（新标记的排在最后），折叠只露前几枚，所以按标记时间倒序，刚标的人不会藏在折叠线后面
    const userIds = Object.keys(marks)
        .sort((a, b) => (marks[b]?.markedAt ?? 0) - (marks[a]?.markedAt ?? 0));

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
                    snapshotName={(marks[userId]?.username ?? "").trim()}
                    source={marks[userId]?.sourceMessage}
                    guildId={guildId}
                    active={activeUserId === userId}
                    onClick={() => onPick(activeUserId === userId ? null : userId)}
                    onUnmark={() => {
                        removeMark(userId);
                        if (activeUserId === userId) onPick(null);
                    }}
                    onViewSource={onViewSource}
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
    /** 标记那一刻存下的显示名快照，档案没缓存时拿它顶名字 */
    snapshotName: string;
    /** 这条就是这个人被标记时用的那条消息 */
    isSource: boolean;
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

function Row({ record, note, snapshotName, isSource, onJump, onUnmark }: RowProps) {
    const guildId = record.guildId ?? undefined;
    const displayName = useDisplayName(record.authorId, guildId, snapshotName);
    const avatarUrl = useAvatarUrl(record.authorId, guildId);
    const channelLabel = useChannelLabel(record.channelId);
    const statusLabel = STATUS_LABEL[record.status];

    return (
        <div
            className={cl("row", statusLabel && "row-muted", isSource && "row-source-accent")}
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
                    {isSource && <span className={cl("row-source-tag")}>标记来源</span>}
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
    const profilesVersion = useProfilesVersion();

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

    // 名单里的人未必在 UserStore 里（没点过他资料、私聊对面那位），档案要自己补一发才有头像和名字。
    // profilesVersion 进依赖：补回来一个就再扫一遍，全部补齐后 ensureProfiles 不再发请求，也就停住了。
    useEffect(() => {
        void ensureProfiles(Object.keys(marks));
    }, [profilesVersion, marks]);

    const rows = useMemo(
        () => selectRecords(records, { marks, authorId, query, newest, limit }),
        [records, marks, authorId, query, newest, limit]
    );

    const totalForFilter = useMemo(
        () => selectRecords(records, { marks, authorId, query, newest, limit: 0 }).length,
        [records, marks, authorId, query, newest]
    );

    const jumpToMessage = (channelId: string, messageId: string, guildId?: string | null) => {
        try {
            // 走 Discord 自己的消息链接路由：认不了的路由它会自己去把频道拉下来，
            // 所以没加载过的帖子 / 子区也跳得动。
            // 原来那套「手动 SELECT_CHANNEL + jumpToMessage」得先假设频道已经在 ChannelStore 里
            // （不然 guild_id 取不到就退成 "@me"），所以只有界面正停在那个帖子/子区里才好使。
            NavigationRouter.transitionTo(`/channels/${guildId || "@me"}/${channelId}/${messageId}`);
            closeDialog(modalProps);
        } catch (e) {
            Flogger.error("跳转失败", e);
        }
    };

    const jumpTo = (record: MarkedRecord) => jumpToMessage(record.channelId, record.id, record.guildId);

    // 名单标签右键用：跳到「当初拿来标记他的那条」，那条自己也在这份库里
    const jumpToSource = (source: MarkSourceMessage) => {
        if (!source?.id || !source.channelId) return;

        // 名单里只存了频道和消息 id，服务器得从库里那条记录现取（取不到再问频道本身）
        const guildId = records.find(record => record.id === source.id)?.guildId
            ?? ChannelStore.getChannel(source.channelId)?.guild_id
            ?? null;

        jumpToMessage(source.channelId, source.id, guildId);
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
            subtitle="只记录被标记用户的发言"
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
                    {/* 不用 @webpack/common 的 TextInput：实测它在这个弹窗里就是浏览器默认的白框，
                        主题类挂不到 input 身上。自己写一个，颜色全走 Discord 令牌，明暗主题都跟着走。 */}
                    <input
                        type="text"
                        className={cl("logs-search")}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
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

                <UserStrip marks={marks} activeUserId={authorId} onPick={setAuthorId} onViewSource={jumpToSource} />

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
                            snapshotName={(marks[record.authorId]?.username ?? "").trim()}
                            isSource={marks[record.authorId]?.sourceMessage?.id === record.id}
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
