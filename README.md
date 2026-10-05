# UserMark 标记

给 Discord 里的人挂自定义备注，名字后面显示 `[被标记]`，被标记的人进得了独立名单，他们的发言（含被删、被改）另存一份本地记录。

两套实现，一套给桌面 Vencord，一套给手机 Kettu，逻辑同源但代码完全不同——它们跑在两套运行时上。

```
vencord/
  UserMark/                     桌面版插件（完整，可直接用；自带本地记录库）
  message-logger-enhanced/      对日志插件的改动（只剩中文文案与观感修正，同名文件覆盖）
kettu/
  index.js  manifest.json       手机版插件（Vendetta polymanifest 格式）
```

## 桌面版（Vencord）

`vencord/UserMark/` 是一个标准 Vencord userplugin，目录整个丢进 `src/userplugins/`，构建后在插件列表里开（筛选记得切 `Show All`，`Show Enabled` 会把没启用的新插件藏起来）。

- 右键**人**或**他的消息** → 「标记」→ 写备注
- 消息头、成员列表名字后面挂 `[被标记]`，悬停看备注和两个时间
- 插件设置页有名单面板：搜索、编辑、删除
- **自带「标记发言」弹窗**：频道右上角那枚**问号**图标（或名单面板右上角的按钮）。被标记用户的发言进自己的 IndexedDB（`UserMarkMessagesIDB`），删除和编辑都留痕，**不装日志插件也能用**
- 读数据的方式是直接读 Vencord 全局 `Settings.plugins.UserMark.marks`，所以别的插件也能复用这份名单

### 三个闸门

1. `authorization: Bearer public` + 指纹头（OpenCode Zen 免密车道）——与本仓库无关，见下方说明
2. 装饰槽位依赖 `MessageDecorationsAPI` / `MemberListDecoratorsAPI`，右上角那颗图标靠插件自己的补丁注入 `toolbar`，首次启用会提示需要重启
3. 名单是纯本地数据，存在 `settings.json` 的 `plugins.UserMark.marks`；发言记录存在浏览器 IndexedDB（库名 `UserMarkMessagesIDB`，Vencord 设置目录旁边那份），两者都不上传任何地方

## 桌面版自带记录（`vencord/UserMark/` 的新文件）

| 文件 | 作用 |
| --- | --- |
| `records.ts` | 纯逻辑：把网关消息拍成一条 `MarkedRecord`、判断该不该记、按名单/作者/关键词筛选、算超限该删哪些 |
| `db.ts` | IndexedDB 封装：`getAllRecords` / `saveRecord`（覆盖，编辑用）/ `addRecords`（只写库里没有的，免得把 `DELETED` 洗回 `NORMAL`）/ `setStatus` / `deleteRecords` / `clearRecords` |
| `capture.ts` | 订阅 `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`，只记名单里的人；删除只改状态不丢正文；回调里的错统一吞成日志 |
| `backfill.ts` | 回溯当前频道（服务器走搜索接口、私聊读频道历史）、按 id 精确补「用来标记的那条」、按 `maxMarkedMessages` 裁剪 |
| `MarkedMessagesModal.tsx` | 「标记发言」弹窗：名单带 + 发言列表 + 搜索/排序/拉取/清空，行可跳回原消息、复制内容、改备注、取消标记；「用来标记的那条」挂「标记来源」标识，名单标签右键可直接跳到它 |
| `profiles.ts` | 头像与显示名的补档层：`UserStore` 里没有的人按需请求一次 `/users/{id}/profile`，带缓存、订阅和名字兜底链（昵称 → 备注名 → globalName → username → 档案 → 标记时的快照 → 雪花 ID） |
| `HeaderButton.tsx` | 频道右上角那枚问号图标：补丁塞进 Discord 自己的 `HeaderBarIcon` 那一排，点开同一个弹窗 |

设置里三个新开关：`logMarkedMessages`（存不存，默认开）、`maxMarkedMessages`（总条数上限，默认 2000，0 = 不限制）、`markedMessagesPerPage`（弹窗一屏多少条，默认 100）。

## 与日志插件的关系

`vencord/message-logger-enhanced/` 里的文件来自对 [Syncxv/vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 的本地改动，**同名文件直接覆盖**即可。现在它只剩中文文案和几处观感修正（详见该目录的 `README.md`）。

这里**曾经**给日志弹窗加过一整套 UserMark 的子页面——「标记用户发言」页签、名单带、行上的「标记来源」标识、行右键的修改 / 取消标记，加上 `utils/markedUsers.ts` / `utils/markedFetch.ts` / `components/MarkedUsersStrip.tsx` / `components/MarkNoteModal.tsx` 四个新文件和 `logMarkedUsers` 开关。2026-10-05 全删了：UserMark 自己的库和弹窗已经覆盖这些功能，而且不分状态、不用抢页签首页，两份实现只会让改一处得记两处。删除前对过账，两处真功能已经移植进 `MarkedMessagesModal.tsx`（「标记来源」标识、名单标签右键的「跳到标记来源」），其余都是重复。

唯一留下的痕迹是 `db.ts` 里的 `DBMessageStatus.NORMAL` 枚举成员——旧版那个页签往日志库写过的记录还在用户硬盘上，现在没有页签会显示它们，`清空所有日志` 能清掉，成员留着是让类型还认得这批数据。

## 手机版（Kettu）

`kettu/` 是给 [Kettu](https://github.com/C0C0B01/Kettu)（Bunny → Vendetta → Revenge 那条线的安卓/iOS mod）写的 Vendetta 插件：

- 长按一条消息 → 「标记此用户」→ **当场打上标记**，去设置页里写备注（设置页会自动把那个人的编辑框摊开）
- 已标记的人 → 「编辑标记备注」/「取消标记」
- 设置页出名单面板，备注就地改，发言记录就地复制/删除
- **全程零弹窗**：Kettu 的 `ui.alerts` 走的是 Discord 已经删掉的 `FluxContainer(Alert)`，弹一次就把插件炸掉，所以输入框、确认全部改成设置页里的行内控件

装法（插件是按 URL 拉的，所以要能被 HTTP 访问）：

```
https://raw.githubusercontent.com/xma1Soap/<本仓库>/main/kettu/
```

改过 `index.js` 记得同步 `manifest.json` 的 `hash`——它不是完整性校验，只是变更标记：Kettu 比对不上才会重新拉 JS，一样就沿用缓存里的旧版。

**手机版没做徽标**：桌面版靠 `MessageDecorationsAPI`，移动端没有对应槽位，得先在真机上定位消息头部的组件名，我没有安卓环境，瞎猜写进去只会让你装个坏插件。

## 状态

| | 状态 |
| --- | --- |
| 桌面标记 / 徽标 / 名单面板 | 已验证 |
| 桌面端离线自测 | 126 条断言全绿（settings 层 / 徽标+面板 / 菜单→弹窗→保存），桩在 `.Hanako\usermark-tests\vencord` |
| 弹窗离线自测 | 57 条断言全绿（折叠露最新 6 人 / 头像与名字兜底链 / 跨帖子跳转的路由串 / 两处右键 / 补档不重复发请求 / 筛选排序），桩在 `.Hanako\usermark-tests\modal`；**配色与头像圈描边还得真机看** |
| 桌面自带记录（库 / 捕获 / 回溯 / 裁剪 / 筛选 / 闸门串行 / 类名与观感对齐 / 日志插件解耦） | 离线 110 条断言全绿，桩在 `.Hanako\usermark-tests\standalone` |
| 日志插件里的 UserMark 子页面 | 已删干净（页签 / 名单带 / 「标记来源」标识 / 行右键那两项 / `logMarkedUsers` / 四个新文件），功能全留在 UserMark 自己的弹窗里；离线桩会扫日志插件目录，重新长回来就红 |
| 入口重复（右上角问号 + 输入框工具栏各一颗） | 已收成一处（输入框那颗和它依赖的 `ChatInputButtonAPI` 一起删了） |
| 弹窗搜索框是浏览器默认的白框 | 已修（不再用 Discord 的 `TextInput`，自己写 input，背景走 `--input-background-default`，边框 / 文字 / placeholder 全用现役令牌） |
| 备注弹窗点保存不关窗 | 已修（`onClose` + `closeAllModals` 双保险） |
| 设置文件被探针抓的源码撑到 287KB | 已修（撤掉 `probe.ts`，启动时清掉遗留数据） |
| `marks` 是坏数据时消息头 / 设置页整块崩 | 已修（读取统一兜底，克隆结果按存储对象身份缓存） |
| 名单带只显示备注，暗色主题下几乎看不见 | 已修（改成头像 + 当前频道名字/ID + 备注；配色换到现役主题令牌，`--header-primary` 已被 Discord 移除，取不到值退成 `#111`） |
| 名单带折叠 / 选中态没生效 | 已修（状态类得写整名 `.vc-usermark-strip-collapsed`，`.strip.collapsed` 这种复合选择器被 `classNameFactory` 的前缀行为永远匹配不上） |
| 点开日志弹窗整个 Discord 崩掉 | 已修（名单带曾在模块顶层快照 `waitForStore` 异步赋值的 store，拿到的是 undefined）；同一个写法现在在 UserMark 的弹窗里，桩会复现这个时序，重新引入会直接红 |
| 「标记来源」标识看不到 | 已修（代码与数据都完好，问题是那条消息不在列表首页：弹窗一开就按 id 回源补一次，名单标签右键再加「跳到标记来源」直达） |
| 来源标识不随名单变化刷新 | 已修（弹窗用 `settings.use([ "marks" ])` 订阅名单，行从上面拿结果，不是挂载时拍快照） |
| 名单带和发言行没有头像、名字是一串雪花 | 已修（`UserStore.getUser()` 只认已缓存的用户，名单里没缓存的人以前就只剩 ID。新增 `profiles.ts` 按需补档案，名字走完整兜底链、头像缺缓存时手拼 CDN 地址，动图认 `a_` 前缀；补不到就退到标记时的快照名，不画空头像圈） |
| 折叠露出来的是最旧的 6 个人 | 已修（名单是插入序，折叠前按 `markedAt` 倒序，刚标记的人不会再藏在折叠线后面） |
| 「跳到原消息」只有停在那条消息所在的子区 / 帖子才跳得动 | 已修（改用 Discord 自己的消息链接路由 `NavigationRouter.transitionTo("/channels/{ guild }/{ channel }/{ message }")`，认不出的频道它自己拉；`guildId` 直接取记录里存的那个，不再猜 `@me`） |
| 改备注 / 取消标记 | 名单标签右键 + 记录行右键都有（原先日志弹窗里那份重复实现已删除） |
| 手机版 | 无弹窗重制版已推送，离线 45 条断言全绿，**真机待验证** |
