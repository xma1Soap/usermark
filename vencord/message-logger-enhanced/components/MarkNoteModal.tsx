/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import type { RenderModalProps } from "@vencord/discord-types";
import { closeAllModals, Modal, openModal, TextArea, useState } from "@webpack/common";

import { setMarkedNote } from "../utils/markedUsers";

export interface MarkNoteTarget {
    /** 被标记用户的 id */
    id: string;
    /** 弹窗标题里显示的名字 */
    name: string;
    /** 当前备注 */
    note: string;
}

/**
 * 关窗。
 * 实测某些情况下 modalProps.onClose() 调了窗体却留着，所以先试 onClose 再用 closeAllModals 兜底，
 * 两者都吞异常，保证用户能离开。
 */
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

export function openMarkNoteModal(target: MarkNoteTarget, onSaved?: () => void): void {
    openModal(props => <MarkNoteDialog target={target} modalProps={props} onSaved={onSaved} />);
}

/**
 * 日志插件自带的备注编辑窗。
 * 不 import UserMark 的 MarkModal：那会把 UserMark 模块拖进本插件的 chunk，
 * UserMark 一旦被禁用，它的 definePluginSettings 访问会抛错。
 */
function MarkNoteDialog({ target, modalProps, onSaved }: {
    target: MarkNoteTarget;
    modalProps: RenderModalProps;
    onSaved?: () => void;
}) {
    const [note, setNote] = useState(target.note ?? "");
    const trimmed = note.trim();

    return (
        <Modal
            {...modalProps}
            title={`编辑标记 · ${target.name}`}
            subtitle="改的是 UserMark 名单里这个人的备注。"
            actions={[
                {
                    text: "取消",
                    variant: "secondary",
                    onClick: () => closeDialog(modalProps)
                },
                {
                    text: "保存",
                    variant: "primary",
                    disabled: !trimmed,
                    onClick: () => {
                        // 先写后关：中途抛错也不能把用户卡在窗里
                        try {
                            if (setMarkedNote(target.id, trimmed)) onSaved?.();
                        } finally {
                            closeDialog(modalProps);
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
