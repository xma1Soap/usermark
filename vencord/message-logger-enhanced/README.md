# 对 vc-message-logger-enhanced 的改动

这些文件来自 [Syncxv/vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 的本地修改，**同名文件覆盖原文件**，新文件按目录结构放入。

改动目的是给日志弹窗加一个「标记用户发言」页签，并与 UserMark 插件的标记名单联动。

## 新增文件

- `utils/markedUsers.ts` —— 读写 UserMark 的标记名单：读名单与标记时间、`useMarkedMarks()` 订阅变化、`setMarkedNote()` / `deleteMarkedUser()` 写回。全程只用 Vencord 全局 Settings，不 import UserMark 的模块，所以 UserMark 被禁用也不会崩
- `utils/markedFetch.ts` —— 回溯**当前频道**里被标记用户的发言：服务器频道走 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，私聊分页读 `GET /channels/{id}/messages`；另有 `fetchMarkedSourceMessages()` 按 id 精确把「用来标记的那条消息」补进库
- `components/MarkedUsersStrip.tsx` —— 标签栏下的名单带，每人一枚「头像 + 当前频道里的名字 + 备注」，超过 6 人折叠，最右侧展开/收起。点标签筛这个人，右键出「查看标记来源 / 修改标记 / 取消标记」
- `components/MarkNoteModal.tsx` —— 日志插件自带的备注编辑弹窗（不复用 UserMark 的 MarkModal，理由同上）

## 改动文件

- `db.ts` —— `DBMessageStatus` 增加 `NORMAL`；新增 `getDateStortedMarkedIDB` / `countMarkedIDB`，按**作者**过滤而不是按状态，所以已删除/已编辑的消息也会出现在这个页签，反之消息被删也不会从页签消失
- `components/hooks.ts` —— 页签分流到上面两个查询
- `components/LogsModal.tsx` —— 枚举 `LogTabs.MARKED`、页签项、自动回溯、手动拉取按钮、名单带；行的右键菜单多了「修改标记 / 取消标记」（作者在被标记名单里才出现）；命中来源消息的行挂「标记来源」标识
- `index.tsx` —— `MESSAGE_CREATE` 时，作者在名单里且非临时消息就入库（**故意绕过日志插件的黑白名单**，盯人时黑名单服务器恰恰要看）
- `settings.tsx` —— 新增 `logMarkedUsers` 开关
- `styles.css` —— 名单带样式

## 已知取舍

- 名单带的药丸样式逐条加了 `!important`：不加会被宿主样式压掉，实测 padding、line-height、字色全都不生效
- 配色只能用 `--background-mod-*` / `--text-default` / `--border-subtle` 这套现役令牌。`--header-primary` 已被 Discord 移除，取不到值就退成代码里的 `#111`，暗色主题下等于隐形（就是那次「标签看不见」的成因）
- 状态类必须写成整名 `.msg-logger-marked-chip-active`、`.msg-logger-marked-strip-collapsed`：`classNameFactory` 会给每个类名加前缀，复合选择器 `.chip.active` 永远匹配不上
- 名字跟着「当前打开的频道所在服务器」解析，所以切服务器时标签上的昵称会跟着变；档案没缓存就直接显示 snowflake ID
- **store 只能在 hook 里现取，绝不能在模块顶层抄进常量**：`@webpack/common` 里那些 store 是 `waitForStore` 异步赋值的 `export let` 绑定，插件模块在启动时就求值完了，那时它们还是 `undefined`。真机上表现为「一点日志弹窗整个渲染器崩掉」（弹窗是懒加载的，所以崩点延后到点开那一刻）
- 写名单必须走 `Settings.plugins.UserMark.marks = 整份新对象`：写 `PlainSettings` 不通知不落盘，写进 Proxy 的嵌套对象又会被结构化克隆拒绝（DataCloneError）
- 「标记来源」那条必然早于标记时刻，页签一次只展示前 N 条（默认 100），所以它经常不在第一页里，看起来就像标识丢了。现在弹窗一开就按 id 精确补一次，名单标签右键还能用 `from:<人> message:<那条>` 直接跳到它 —— 搜索框非空时查询是全量扫描，不受分页限制
- 名单带的高亮判据是 `^(?:from|user):(\S+)`，不锚字符串结尾，否则「查看标记来源」拼出的两段查询会让标签不亮
- 页签不按标记时间过滤（`db.ts` 里那条注释是原因）：真要过滤掉标记之前的发言，「标记来源」那条永远进不了页签
- 网关的 `MESSAGE_CREATE` 只覆盖当前订阅的频道，所以才需要回溯这条路径
