/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { ReactNode } from "react";

import { openMarkedMessagesModal } from "./MarkedMessagesModal";

/** Discord 频道右上角那一排图标用的组件，它自己带 tooltip / 高亮 / 尺寸 */
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

function QuestionIcon() {
    return (
        <svg
            width={24}
            height={24}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
        >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.3 9.3a2.8 2.8 0 1 1 4 2.6c-.8.5-1.3 1.1-1.3 2.1v.3" />
            <path d="M12 17.3h.01" />
        </svg>
    );
}

export function MarkedMessagesHeaderButton() {
    return (
        <HeaderBarIcon
            className="vc-usermark-header-btn"
            onClick={() => openMarkedMessagesModal()}
            tooltip="标记发言"
            icon={QuestionIcon}
        />
    );
}

/**
 * 塞进频道右上角那排图标的最左边。
 * toolbar 有时是数组、有时是单个节点，两种都得接住，否则整个头部进 ErrorBoundary。
 */
export function addIconToToolBar(e: { toolbar: ReactNode[] | ReactNode; }): void {
    const button = (
        <ErrorBoundary noop key="vc-usermark-header-btn">
            <MarkedMessagesHeaderButton />
        </ErrorBoundary>
    );

    if (Array.isArray(e.toolbar)) {
        e.toolbar.unshift(button);
        return;
    }

    e.toolbar = [button, e.toolbar];
}
