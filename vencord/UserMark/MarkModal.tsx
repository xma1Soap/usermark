/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { RenderModalProps } from "@vencord/discord-types";
import { closeAllModals, Modal, openModal, showToast, TextArea, useState } from "@webpack/common";

import { getMark, MarkSourceMessage, setMark } from "./settings";

export interface MarkTarget {
    id: string;
    username: string;
    globalName?: string | null;
    /** 从消息菜单标记时，把那条消息一并存下来 */
    sourceMessage?: MarkSourceMessage;
}

export function openMarkModal(user: MarkTarget): void {
    openModal(props => <MarkDialog user={user} modalProps={props} />);
}

/**
 * 关窗。
 * 实测某些情况下 `modalProps.onClose()` 调了窗体却留着（备注已写入、窗不消）
 * 所以先试 onClose，再用 closeAllModals 兜底，两者都吞异常，保证用户能离开。
 */
function closeDialog(modalProps: RenderModalProps): void {
    try {
        modalProps.onClose?.();
    } catch {
        // 忽略，走兑底
    }

    try {
        closeAllModals();
    } catch {
        // 关不掉也不能让点击报错
    }
}

function MarkDialog({ user, modalProps }: { user: MarkTarget; modalProps: RenderModalProps; }) {
    const existing = getMark(user.id);
    const [note, setNote] = useState(existing?.note ?? "");

    const name = user.globalName || user.username;
    const trimmed = note.trim();

    return (
        <Modal
            {...modalProps}
            title={existing ? `编辑标记 · ${name}` : `标记 · ${name}`}
            subtitle="给这个人挂一条只有你看得见的备注。"
            actions={[
                {
                    text: "取消",
                    variant: "secondary",
                    onClick: () => closeDialog(modalProps)
                },
                {
                    text: existing ? "保存" : "标记",
                    variant: "primary",
                    disabled: !trimmed,
                    onClick: () => {
                        // 先关窗再弹 toast：中途任何一步抛错都不能把用户卡在窗里
                        try {
                            setMark(user.id, trimmed, name, user.sourceMessage);
                        } finally {
                            closeDialog(modalProps);
                        }

                        try {
                            showToast(existing ? `已更新 ${name} 的备注` : `已标记 ${name}`);
                        } catch {
                            // 提示失败无所谓，数据已经落盘
                        }
                    }
                }
            ]}
        >
            <Flex flexDirection="column" gap={12}>
                <section>
                    <HeadingSecondary>备注</HeadingSecondary>
                    <TextArea
                        value={note}
                        onChange={setNote}
                        placeholder="例如：杀戮尖塔2 群老哥，常发卡表"
                        autosize
                    />
                </section>
            </Flex>
        </Modal>
    );
}
