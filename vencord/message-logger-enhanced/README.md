# 对 vc-message-logger-enhanced 的改动

这些文件来自 [Syncxv/vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 的本地修改，**同名文件覆盖原文件**，新文件按目录结构放入。

改动目的是给日志弹窗加一个「标记用户发言」页签，并与 UserMark 插件的标记名单联动。

## 新增文件

- `utils/markedUsers.ts` —— 读 UserMark 的标记名单与标记时间（直接读 Vencord 全局 Settings，不 import 插件模块，UserMark 被禁用也不会崩）
- `utils/markedFetch.ts` —— 按标记时间回溯**当前频道**的发言：服务器频道走 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，私聊分页读 `GET /channels/{id}/messages`
- `components/MarkedUsersStrip.tsx` —— 标签栏下的名单带，按备注显示，超过 6 人折叠，最右侧展开/收起，点标签筛这个人

## 改动文件

- `db.ts` —— `DBMessageStatus` 增加 `NORMAL`；新增 `getDateStortedMarkedIDB` / `countMarkedIDB`，按**作者**过滤而不是按状态，所以已删除/已编辑的消息也会出现在这个页签，反之消息被删也不会从页签消失
- `components/hooks.ts` —— 页签分流到上面两个查询
- `components/LogsModal.tsx` —— 枚举 `LogTabs.MARKED`、页签项、自动回溯、手动拉取按钮、名单带
- `index.tsx` —— `MESSAGE_CREATE` 时，作者在名单里且非临时消息就入库（**故意绕过日志插件的黑白名单**，盯人时黑名单服务器恰恰要看）
- `settings.tsx` —— 新增 `logMarkedUsers` 开关
- `styles.css` —— 名单带样式

## 已知取舍

- 名单带的药丸样式逐条加了 `!important`：不加会被宿主样式压掉，实测 padding、line-height、字色全都不生效
- 页签只显示**不早于标记时间**的记录，回溯也只拉这个范围，更早的拉了也会被过滤
- 网关的 `MESSAGE_CREATE` 只覆盖当前订阅的频道，所以才需要回溯这条路径
