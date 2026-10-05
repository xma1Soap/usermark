# 对 vc-message-logger-enhanced 的改动

这些文件来自 [Syncxv/vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 的本地修改，**同名文件覆盖原文件**，新文件按目录结构放入。

现在这份本地修改只剩界面文案的中文化和几处观感修正：

- 标签页、设置项、右键菜单、弹窗按钮的中文文案（`components/LogsModal.tsx`、`settings.tsx`、`index.tsx`）
- `.msg-logger-modal-footer { align-items: center; gap: 16px }`：Discord 的 `ModalFooter` 是 `row-reverse`，原来靠每个按钮自己加 `marginRight`，只要有一个没加（`清空所有日志` 就没有）就会和旁边那颗贴死

## UserMark 的子页面已全部移除（2026-10-05）

这里曾经给日志弹窗加过一整套 UserMark 的东西：`LogTabs.MARKED`「标记用户发言」页签、标签栏下的名单带 `components/MarkedUsersStrip.tsx`、行上的「标记来源」标识、行右键的修改 / 取消标记、`components/MarkNoteModal.tsx`、`utils/markedUsers.ts`（读写 Vencord 全局名单）、`utils/markedFetch.ts`（回溯当前频道 + 按 id 补来源那条）、`db.ts` 的 `getDateStortedMarkedIDB` / `countMarkedIDB`、`index.tsx` 里 `MESSAGE_CREATE` 时名单用户直入库（故意绕过黑白名单）、`settings.tsx` 的 `logMarkedUsers` 开关。

删掉的理由：UserMark 已经有了自己独立的库、独立的弹窗、独立的入口，这些功能它全都有，而且体验更好——自己的库不分状态，不用靠页签首页抢位置。两个插件各存一份实现，改一处得记两处。

**唯一留下的痕迹**是 `DBMessageStatus.NORMAL` 这个枚举成员：旧版那个页签往日志库里写过的普通发言还在用户硬盘上。现在没有任何页签会显示它们（`getStatus` 只剩 DELETED / EDITED / GHOST_PINGED 三条），`清空所有日志` 能清掉；成员留着只是让类型还认得这批历史数据。

## 踩过的坑（结论仍然成立，只是搬进了 UserMark 的弹窗）

- 配色只能用 `--background-mod-*` / `--text-default` / `--border-subtle` 这套现役令牌。`--header-primary` 已被 Discord 移除，取不到值就退成代码里的 `#111`，暗色主题下等于隐形
- 状态类必须写成整名（`.vc-usermark-chip-active`）：`classNameFactory` 会给**每个**类名加前缀，复合选择器 `.chip.active` 永远匹配不上
- 自己写的药丸 / 输入框要逐条 `!important`：不加会被宿主样式压掉，实测 padding、line-height、字色全都不生效
- **store 只能在 hook 里现取，绝不能在模块顶层抄进常量**：`@webpack/common` 里那些 store 是 `waitForStore` 异步赋值的 `export let` 绑定，插件模块在启动时就求值完了，那时还是 `undefined`；顶层 `const X = [UserStore, ...]` 会把 undefined 永久存进数组，`useStateFromStores` 拿它调 `addChangeListener` 就抛。日志弹窗是懒加载的，真机上表现为「一点开日志整个 Discord 崩掉」（That also failed）
- 网关的 `MESSAGE_CREATE` 只覆盖当前订阅的频道，所以想看历史必须自己开一条回溯路径
- 「用来标记的那条消息」必然早于标记时刻，一次只展示前 N 条的列表里经常挤不进首页，看起来就像标识丢了——得按 id 单独精确补一次
