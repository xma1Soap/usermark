/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { DeleteIcon, PencilIcon } from "@components/Icons";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { showToast, TextInput, useState } from "@webpack/common";

import { openMarkedMessagesModal } from "./MarkedMessagesModal";
import { openMarkModal } from "./MarkModal";
import { asMarkMap, MarkEntry, removeMark, settings } from "./settings";
import { formatTimestamp } from "./utils";

interface Row {
    userId: string;
    entry: MarkEntry;
}

function matches(entry: MarkEntry, query: string): boolean {
    if (!query) return true;

    // 逐个判类型再比：条目可能来自设置同步或老版本，字段未必都在
    return [entry.username, entry.note, entry.sourceMessage?.content]
        .some(field => typeof field === "string" && field.toLowerCase().includes(query));
}

/** 标记时那条消息的一行摘要 */
function SourceLine({ entry }: { entry: MarkEntry; }) {
    const source = entry.sourceMessage;
    if (!source) return null;

    const time = source.timestamp ? Date.parse(source.timestamp) : NaN;

    return (
        <Paragraph size="sm" color="muted">
            标记来源：{source.content || "（纯表情/无文字）"}
            {!Number.isNaN(time) && ` · ${formatTimestamp(time)}`}
        </Paragraph>
    );
}

function MarkRow({ userId, entry }: Row) {
    const name = entry.username || userId;

    return (
        <Card className="vc-usermark-card">
            <Flex flexDirection="column" gap="0.25em">
                <Flex alignItems="center" justifyContent="space-between" gap={8}>
                    <BaseText size="md" weight="semibold">{name}</BaseText>
                    <Flex gap={8}>
                        <Button
                            variant="secondary"
                            size="iconOnly"
                            aria-label="编辑备注"
                            onClick={() => openMarkModal({ id: userId, username: entry.username })}
                        >
                            <PencilIcon aria-hidden width={18} height={18} />
                        </Button>
                        <Button
                            variant="dangerSecondary"
                            size="iconOnly"
                            aria-label="取消标记"
                            onClick={() => {
                                removeMark(userId);
                                showToast(`已取消标记 ${name}`);
                            }}
                        >
                            <DeleteIcon aria-hidden width={18} height={18} />
                        </Button>
                    </Flex>
                </Flex>

                <Paragraph size="sm" color="normal">
                    备注：{entry.note || "（空）"}
                </Paragraph>

                <SourceLine entry={entry} />

                <Flex gap={16} className={Margins.top8}>
                    <BaseText size="xs" color="muted">
                        被标记时间：{formatTimestamp(entry.markedAt)}
                    </BaseText>
                    <BaseText size="xs" color="muted">
                        最新发言时间：{formatTimestamp(entry.lastMessageAt)}
                    </BaseText>
                </Flex>
            </Flex>
        </Card>
    );
}

export function MarkPanel() {
    const marks = asMarkMap(settings.use(["marks"]).marks);
    const [query, setQuery] = useState("");

    const trimmedQuery = query.trim().toLowerCase();
    const total = Object.keys(marks).length;
    const rows: Row[] = Object.entries(marks)
        .filter(([, entry]) => entry && typeof entry === "object")
        .map(([userId, entry]) => ({ userId, entry }))
        .filter(({ entry }) => matches(entry, trimmedQuery))
        .sort((a, b) => (b.entry.lastMessageAt ?? 0) - (a.entry.lastMessageAt ?? 0));

    return (
        <section className={Margins.top8}>
            <Flex alignItems="center" justifyContent="space-between" gap={8}>
                <BaseText size="md" weight="semibold">
                    被标记名单（{rows.length}{trimmedQuery ? ` / ${total}` : ""}）
                </BaseText>
                <Button variant="secondary" size="min" onClick={openMarkedMessagesModal}>
                    查看标记发言
                </Button>
            </Flex>

            <TextInput
                value={query}
                onChange={setQuery}
                placeholder="搜索用户名或备注"
                className={Margins.top8}
            />

            <Flex flexDirection="column" gap="0.5em" className={Margins.top8}>
                {rows.length === 0 && (
                    <Paragraph size="sm">
                        {total === 0
                            ? "还没有标记任何人。右键一个人或他的消息，选「标记」。"
                            : "没有匹配的被标记用户。"}
                    </Paragraph>
                )}

                {rows.map(row => (
                    <MarkRow key={row.userId} {...row} />
                ))}
            </Flex>
        </section>
    );
}
