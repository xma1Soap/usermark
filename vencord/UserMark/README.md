# UserMark 标记

右键一个人或他的消息 → 「标记」→ 给他挂一条自定义备注。被标记的人在名字后面会显示一枚红色的 `[被标记]`，鼠标悬停能看到备注和两个时间。设置页里有一份可搜索的完整名单，另外插件**自带一个本地记录库**，能直接翻被标记用户说过什么——删除、编辑都会留痕，不需要装任何日志插件。

## 功能

| 位置 | 表现 |
| --- | --- |
| 右键用户（成员列表 / 资料弹层 / 私聊列表） | 菜单末尾多出「标记」，已标记则变成「编辑标记备注」+「取消标记」 |
| 右键消息 | 同上，取该消息的作者 |
| 消息头 | 名字后面挂 `[被标记]` 徽标 |
| 成员列表 | 名字后面挂 `[被标记]` 徽标（可在设置里关） |
| 频道右上角 | 一排图标最左边多出一枚**问号**图标（tooltip「标记发言」），点开自己的记录弹窗 |
| Vencord 设置 → UserMark → 齿轮 | 「被标记名单」面板：搜索框 + 每人的备注、被标记时间、最新发言时间，支持编辑、删除，右上角有「查看标记发言」 |
| 「标记发言」弹窗 | 名单带（每人一枚**带头像**的标签，超过 6 人折叠，折叠时露的是**最新标记**的那几个）+ 发言列表：头像、当前昵称、备注、频道、时间、状态（已编辑 / 已删除）、附件与嵌入数量、正文；被标记时「用来标记的那条」左边压一条竖杠、头上挂一枚「标记来源」标签。点一行跳回原消息（帖子 / 子区没加载过也跳得动），右键一行可「跳到原消息 / 复制内容 / 修改标记 / 取消标记」，右键名单标签可「修改标记 / 跳到标记来源 / 取消标记」 |

弹窗有两个入口（右上角问号、设置页名单面板的「查看标记发言」），都指向同一个 `openMarkedMessagesModal()`，全部不依赖日志插件。右上角那枚走 Discord 自己的 `HeaderBarIcon`（`findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"')`），注入点是 `toolbar: … mobileToolbar: …` 那个组件的补丁，跟日志插件的按钮用的是同一处、各自插自己的调用（补丁里的 `$self` 按插件实例替换，不会互相盖）。

输入框工具栏那颗按钮已经撤了：入口只留右上角一处，一个功能不需要两个门。撤的时候顺手把 `dependencies` 里的 `ChatInputButtonAPI` 一起删了——留着一个不用的 API 依赖，等于让插件被强制启用一个用不上的内置插件。


## 头像和名字从哪来

`profiles.ts` 管这件事，弹窗一打开就 `ensureProfiles(Object.keys(marks))` 把名单里缺的人补一遍。名字走一条明确的兜底链，从前到后第一个有值的赢：

1. 服务器昵称（`GuildMemberStore.getMember(guildId, id).nick`）
2. 好友备注名（`RelationshipStore.getNickname(id)`）
3. `globalName` → `username`（`UserStore.getUser(id)`）
4. 插件自己补来的档案（`GET /users/{id}/profile?with_counts=false`）
5. 标记那一刻存下的 `username` 快照
6. 都没有就直接显示 ID（雪花）

头像同理：`UserStore` 里有这个人就走 Discord 自己的 `getAvatarURL(guildId, 64, false)`；没有就用补来的 hash 手拼 CDN 地址（`a_` 开头的是动图，后缀得给 `gif`）。

为什么要自己补：`UserStore.getUser()` 只认**已经缓存过**的用户。名单里躺着一个只在别的服务器说过话的人，本地就没有他的档案，界面上只剩一串雪花数字和一个空头像圈——实测截图里那两枚「1526926386780962838」就是这么来的。补档案一人一发请求、间隔 250ms，已缓存的、正在拉的、`UserStore` 里已经有的都跳过，429 / 404 只记一条 warn（补不到就退到快照名，不报错、不白圈刷屏）。档案是异步到位的，所以 `profiles.ts` 带一个版本号 + 订阅，弹窗用 `useProfilesVersion()` 挂上去，补回来一个人就重渲染一次、并再扫一遍还缺谁，全补齐之后 `ensureProfiles` 不再发请求，循环自己就停了。

没有 `fetchUserAsync` 这东西，头像也没有能直接用的现成签名（`IconUtils.getUserAvatarURL` 的参数形态不确定），所以 CDN 地址手拼，先例见 `plugins/xsOverlay/index.tsx`。

## 跳转为什么走路由而不是 `jumpToMessage`

原来那套是「`FluxDispatcher.dispatch({ type: "SELECT_CHANNEL" })` + `MessageActions.jumpToMessage()`」，实测只有在**当前界面已经停在有这条消息的子区 / 帖子**时才跳得动：`SELECT_CHANNEL` 要求频道已经在 `ChannelStore` 里，帖子（线程）没被打开过就没有这条记录，`guild_id` 只能猜成 `@me`，于是 Discord 拿到一个对不上号的频道 id，界面纹丝不动。

现在换成 Discord 自己的消息链接路由：

```ts
NavigationRouter.transitionTo(`/channels/${guildId || "@me"}/${channelId}/${messageId}`);
```

认不出来的 id 它会自己去拉，帖子 / 未加载的子区 / 跨服务器频道都能直达。`guildId` 用的是每条 `MarkedRecord` 本来就落库的那个字段，不用猜；「跳到标记来源」那条消息未必在当前列表里，所以先按 id 在已捕获的记录里找它的 `guildId`，找不到才退回 `ChannelStore`。跳转之后立刻 `closeDialog()` 关弹窗，否则路由变了窗还糊在上面。

## 与 ShowMeYourName 的顺序

徽标走 Vencord 的 `MessageDecorationsAPI` 槽位（`@api/MessageDecorations`），这个槽位在消息头里渲染在**作者名之后**；ShowMeYourName 是把自己的输出塞进作者名的 `children`，所以两者天然是「昵称在前、`[被标记]` 在后」的顺序，不需要额外做优先级控制。

两个插件都依赖同一个 `="SYSTEM_TAG"` 模块，但注入点不同：ShowMeYourName 改 `children:` 字段，UserMark 走 Vencord 的公开装饰槽，互不冲突。

## 时间从什么时候开始记

- **被标记时间**：点「标记」那一刻。
- **最新发言时间**：插件启用之后，被标记用户的消息在渲染时回填。翻到的旧消息不会把时间戳改回去（只接受更晚的时间）。启用之前的历史消息不会回扫。

## 数据存哪

写进 Vencord 的设置文件（`%APPDATA%\Vencord\settings`），键是 `plugins.UserMark.marks`，结构：

```json
{
  "用户ID": {
    "note": "自定义备注",
    "username": "标记时的显示名快照",
    "markedAt": 1790000000000,
    "lastMessageAt": 1790000000000,
    "sourceMessage": {
      "id": "1555997714439733380",
      "channelId": "1337107956499615744",
      "content": "那条消息，超 140 字会裁断",
      "timestamp": "2026-10-03T17:39:24.162Z"
    }
  }
}
```

`sourceMessage` 只有从消息菜单标记时才有，从人身上标记就不带这个键。

读写各有一条不能破的规矩：**读走 `settings.plain` 并且 JSON 拍平**（`settings.store` 是 Proxy，从它身上展开出来的对象进不了 Electron IPC 的结构化克隆，写盘会静默失败，重启就只剩第一条）；**写一律整体换新对象**，不原地改——原地改既会让 Vencord 的相等判断跳过落盘，也会污染 `getMarks()` 的缓存。

### 发言记录：自己的 IndexedDB

被标记用户的发言**不进设置文件**，进的是自己的库：`indexedDB.open("UserMarkMessagesIDB")`，object store `messages`，keyPath 是消息 id，不建索引（条数被上限封顶，`getAll()` 读出来在内存里筛）。一条记录长这样（`records.ts` 的 `MarkedRecord`）：

```json
{
  "id": "消息ID",
  "authorId": "用户ID",
  "channelId": "频道ID",
  "guildId": "服务器ID 或 null",
  "timestamp": 1790000000000,
  "editedTimestamp": null,
  "content": "正文，超 2000 字裁断",
  "status": "NORMAL | EDITED | DELETED",
  "attachments": ["文件名，最多 10 个"],
  "embedCount": 0
}
```

四条链路，全都不碰日志插件：

- **实时捕获**（`capture.ts`）：订阅 `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`。只落名单里的人、`type === 0`、非临时消息（`flags & 64`）、非 pending/failed。编辑走 `saveRecord` 覆盖（`MESSAGE_UPDATE` 也发给置顶和加表情，而且常常只带变化字段，所以以 `MessageStore.getMessage` 拿到的完整消息为准，且必须有 `edited_timestamp`）；删除**只把状态改成 `DELETED`**，正文留着——这才是要留档的东西。网关回调里抛出去的错误统一吞成日志，不然满屏报错。
- **回溯当前频道**（`backfill.ts`）：服务器频道走 `GET /guilds/{id}/messages/search?channel_id=&author_id=`，一人一页（25 条，最多 10 页）；私聊 / 群聊没有搜索接口，改读 `GET /channels/{id}/messages`（100 条，最多 4 页）再按名单过滤。请求间隔 250ms，撞 429 立即收手，自动拉取之间至少隔 60 秒，工具栏「拉取本频道」是强制的。
- **标记来源那条**：弹窗一打开先按 `sourceMessage.id` + `channelId` 精确回源补一次。这条必然早于标记时刻，靠翻页经常挤不进首页，所以单独拉。
- **裁剪**：`maxMarkedMessages` 是总条数上限，超了删最旧的。捕获侧每写 25 条才整库扫一次，别每条消息都读一遍库。

写入分工：`addRecords` 只写库里还没有的（回溯会反复扫同一批消息，用 `put` 覆盖会把已知的 `DELETED` 洗回 `NORMAL`），`saveRecord` 才是无条件覆盖（编辑事件要盖掉旧内容）。

两条回溯**必须串着发**：`fetchMarkedSourceMessages()` 在第一个 `await` 之前就把 `running` 置真，并排发（`Promise.all`）的话后跑的 `fetchCurrentChannel()` 会立刻撞上同一个闸门、被判成「正在跑」而整条跳过。真机表现就是弹窗开着却一条都没补进来，看着像「还是得靠日志插件」。

## 设置项

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `marks` | `{}` | 名单本体，写进 Vencord 设置文件 |
| `markPanel` | — | 设置页里的名单面板 |
| `memberListBadge` | 开 | 成员列表后面也挂 `[被标记]` |
| `logMarkedMessages` | 开 | 把被标记用户的发言存进自己的 IndexedDB；关掉只是不再新增，已有记录保留 |
| `maxMarkedMessages` | 2000 | 本地库总条数上限，超了删最旧的；`0` = 不限制 |
| `markedMessagesPerPage` | 100 | 「标记发言」弹窗一屏先显示多少条 |

## 构建与部署

```powershell
cd "C:\Users\11028\Documents\.Hanako\orion-setup\Vencord"
node --require=./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs
# 然后把 dist 拷进 %APPDATA%\Vencord\dist，重启 Discord
```

检查清单：

```powershell
node .\node_modules\typescript\bin\tsc --noEmit          # 类型
node .\node_modules\eslint\bin\eslint.js src/userplugins\UserMark   # lint
```

注意：`pnpm exec` 在这台机器上会撞 store 版本（v11 装的依赖被 pnpm 10 接管），直接调 `node_modules` 里的 bin。

## 离线自测

不用开 Discord 也能验插件逻辑：`C:\Users\11028\Documents\.Hanako\usermark-tests\vencord\` 那套桩用 esbuild 把真插件源码直接编译进来跑——`@api/Settings` 换成**真的 `SettingsStore` 类**（Vencord 用的那个 proxy 库，从 `src/shared/SettingsStore.ts` 编译），`@components/*` 和 `@webpack/common` 换成会把 children 透出来的假组件，然后当场调用真的组件函数、点真的按钮回调。

```powershell
cd "C:\Users\11028\Documents\.Hanako\usermark-tests\vencord"
node build.mjs              # settings 层：读写兜底、克隆缓存、探针清理（42 条）
node build2.mjs entry2.mjs  # 徽标 + 名单面板（41 条）
node build2.mjs entry3.mjs  # 右键菜单 -> 弹窗 -> 保存 的整条链（43 条）

cd "C:\Users\11028\Documents\.Hanako\usermark-tests\modal"
node build.mjs              # 「标记发言」弹窗整棵组件树（57 条）
```

三行都该是 `失败 0 条`（42 / 41 / 43）。它把这几件事钉住了：

- `marks` 被改成 null / 字符串 / 混进坏条目时，徽标静默不渲染、面板退到空名单提示，**不能把整条消息头炸进 ErrorBoundary**
- `getMarks()` 的克隆结果按存储对象身份缓存：200 条可见消息回填只克隆 1 次；写入方全部换新对象，缓存那份不会被改脏
- 标记成功不弹 toast、`onClose()` 抛错也照样用 `closeAllModals()` 兜底关窗（都是实测踩出来的，别改回去）
- 启动时清探针遗留数据是幂等的：没有遗留就一次盘都不写

自带库这条链路另有一套桩，在 `C:\Users\11028\Documents\.Hanako\usermark-tests\standalone\`：

```powershell
cd "C:\Users\11028\Documents\.Hanako\usermark-tests\standalone"
node build.mjs                 # 110 条，全绿才是 0 失败
```

它用 `fake-idb.mjs` 顶掉 `indexedDB`（写入同样过 `structuredClone`，所以「把带 getter 的 flux Message 直接塞进库」在桩里也会像真机一样抛 DataCloneError），用 `stub-webpack.mjs` 顶掉 `RestAPI` / `FluxDispatcher` / 各种 store，然后跑真的 `records.ts` / `db.ts` / `capture.ts` / `backfill.ts`。钉住的是这几件事：

- 名单外的人、临时消息、pending/失败消息、非 `type === 0` 的消息都不落库；关掉 `logMarkedMessages` 就一条都不记
- 删除只改 `status`，正文留着；`addRecords` 不会把已知的 `DELETED` 洗回 `NORMAL`
- 回溯：服务器频道走搜索接口、私聊走频道历史；整页才翻页（第二页 `offset=25`）；撞 429 立即收手不再发请求，普通报错只断当前这个用户；标记来源那条会被补进来且不会重复拉
- 超过 `maxMarkedMessages` 裁到最新的 N 条
- 取消标记后那个人的记录立刻不再显示，但行还在库里（重新标记就回来）
- 闸门契约：并排发两条回溯时第二条必然 `skipped`（把坑本身钉住），串着发两条都跑到、库里两条都在
- ⑨ 静态对齐：弹窗里每个 `cl("...")` 吐出的类名在 `styles.css` 都有规则、样式表里也没有没人认领的孤儿类名，状态类必须是带前缀的整名，令牌得在 Vencord 自带样式里有先例
- ⑨ 观感契约：搜索框不用 Discord 的 `TextInput`（它在这个弹窗里就是浏览器默认的白框）、`.vc-usermark-logs-search` 自己用 `--input-background-default` 上色、「标记来源」的标识类名都在、名单标签右键有「跳到标记来源」
- ⑨ 反向契约：日志插件目录里再扫不到 `UserMark` / `markedUsers` / `markedFetch` / `MarkedUsersStrip` / `MarkNoteModal` / `logMarkedUsers` / `LogTabs.MARKED` 任何一个，子页面不会被哪天又长回来

弹窗自己还有一套更贴近界面的桩（`usermark-tests\modal\`）：手写的 React 替身（`withFrame` + 按调用路径分槽位的 `useState` / `useEffect` / `useMemo`）把真的函数组件展成一棵可以遍历、可以点、可以读类名的宿主节点树，`MarkedMessagesModal.tsx` 从头到尾是真的，连 `@api/Styles` 都编译的是真的 `src/utils/css.ts`。它钉住的是：

- 折叠：9 人只露 6 枚 + `+3`，露出来的按 `markedAt` **倒序**（刚标记的人不会被压在折叠线后面），展开 / 收起往返还原样
- 头像与名字：`UserStore` 命中、档案补来的 PNG、`a_` 开头的动图拼成 gif、404 时退到快照名且不画空 `<img>`、什么都不知道才显示雪花
- 跳转：帖子走 `/channels/900/c-thread/m1`、私聊走 `/channels/@me/c-dm/m2`，断言的是 `NavigationRouter.transitionTo` 收到的那一串
- 行与标签的右键项齐全、取消标记真的写回设置、`ensureProfiles` 不重复发请求也不给空 id 发
- 筛选与排序：搜索框、`channel:force`、`source,channel:auto` 的先后

两套桩都撞过一个同一个坑：`@api/Styles` 在模块顶层就 `document.createElement`，`HeaderButton` / `MarkPanel` 又引用 `./MarkedMessagesModal`，于是 Node 里一编译就炸。解法是把弹窗在那个入口上桩掉（`stub-markedmodal.mjs`），`@webpack` 的 lazy 查找同样桩掉（`stub-webpack-lazy.mjs`，不桩会把真的 `src/webpack/common` 目录顺着相对导入拖进来，一路拽到 `document`）。

弹窗的视觉表现（配色在暗色 / 亮色主题下的实际对比度、头像圈的描边）还是得开 Discord 看，离线只验到类名、结构和回调。

## 与消息记录器的关系

两边**彻底独立**了。`vc-message-logger-enhanced` 里曾经有一份 UserMark 的子页面（「标记用户发言」页签、标签栏下的名单带、行上的「标记来源」标识、行右键的修改 / 取消标记、`logMarkedUsers` 开关，外加 `utils/markedUsers.ts` / `utils/markedFetch.ts` / `components/MarkedUsersStrip.tsx` / `components/MarkNoteModal.tsx`），现在全删了。同一件事不必在两个插件里各做一遍，UserMark 自己的弹窗功能不减反增：

- 「标记来源」标识 → 移植进 `MarkedMessagesModal.tsx`：命中 `marks[人].sourceMessage.id` 的那行左边压一条竖杠、头上挂一枚标签
- 名单标签的「查看标记来源」→ 移植成标签右键里的「跳到标记来源」，直接 `jumpToMessage` 到那条，比原来往搜索框塞 `from:<人> message:<那条>` 更准
- 「标记用户发言」页签原本是日志库里 `NORMAL` 状态记录唯一的落脚点 → UserMark 的库不分状态全摆，所以不算损失；日志那边只喂这个页签的 `logMarkedUsers` 捕获随之删掉
- 行右键的修改标记 / 取消标记 → UserMark 的行右键和消息右键菜单本来就有

日志库里已经存着的 `NORMAL` 记录（旧版那个页签写进去的）不会自己消失，也不再被任何页签显示，`清空所有日志` 能清掉。`DBMessageStatus.NORMAL` 这个枚举成员特意留着，就是让类型还认得这些历史数据。

名单带的观感规矩（配色只能用 `--background-mod-*` / `--text-default` / `--border-subtle`，`--header-primary` 已被 Discord 移除，取不到值会退成代码里写的深色、暗色主题下等于隐形；状态类必须写成带前缀的整名 `.vc-usermark-chip-active`，因为 `classNameFactory` 会给**每个**类名加前缀，`.chip.active` 这种复合选择器永远匹配不上）和 **store 只能在 hook 里现取、不能在模块顶层抄进常量**（`@webpack/common` 里那些是 `waitForStore` 异步赋值的 `export let`，顶层抄进数组等于永久存进 `undefined`，`useStateFromStores` 一调就抛）——都是从日志弹窗那一版踩出来的，UserMark 的弹窗照搬了同样的写法，别改回去。

## 已知限制

- `authors` 用的是占位 id `0n`，要显示你的 Discord 头像就把 `index.tsx` 里的 id 换成真实用户 ID。
- 右键私聊列表里的会话本身给的是频道菜单（`channel-context`），要标记那个人得走他的消息或资料弹层。
- 最新发言时间只覆盖插件启用之后、且消息实际渲染过的记录。
- 本地库存的是**正文和附件文件名**，不存附件本体、不存 embed / 卡片的正文（只记数量）。编辑是覆盖式的：留最新正文加一个 `EDITED` 状态，不保留改之前的原文（要看编辑历史得用日志插件）。
- 网关只推当前订阅的频道，弹窗里只回溯**当前打开的那个频道**。没打开过的服务器不会自己补，得先切过去再点「拉取本频道」。
- 「取消标记」不会删那个人的历史发言，只是不再显示、也不再新增；要腾地方就点弹窗里的「清空记录」，或者靠 `maxMarkedMessages` 裁。

## 撤掉的调试探针

`probe.ts`（抓搜索界面组件源码用的）已经删除。它把抓到的源码整份写进 `settings.json`：本机实测 287KB 的 `plugins.UserMark.probe`，占当时整个设置文件的 97%，之后 Vencord 每写一次任何设置都要把这一坨整份序列化进磁盘；而且 `probeEnabled` 一旦打开，`focusin` 加全站 `MutationObserver` 会在每次点搜索框时重新抓一遍。搜索面板改版要继续做的话：

- 代码：`git show 629f588:vencord/UserMark/probe.ts`
- 最后一次抓到的 10 份数据：`C:\Users\11028\Documents\.Hanako\usermark-probe\probe-captures-2026-10-05.json`
- 老设置文件里的残留不用手动删，插件下次启动会自己清（`purgeProbeLeftovers()`）
