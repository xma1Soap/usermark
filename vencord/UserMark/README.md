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
| 输入框工具栏 | 一枚「标记发言」图标（`LogIcon`），同一个弹窗 |
| Vencord 设置 → UserMark → 齿轮 | 「被标记名单」面板：搜索框 + 每人的备注、被标记时间、最新发言时间，支持编辑、删除，右上角有「查看标记发言」 |
| 「标记发言」弹窗 | 名单带（每人一枚标签）+ 发言列表：头像、当前昵称、备注、频道、时间、状态（已编辑 / 已删除）、附件与嵌入数量、正文。点一行跳回原消息，右键一行可「跳到原消息 / 复制内容 / 修改标记 / 取消标记」 |

三个入口都只指向同一个 `openMarkedMessagesModal()`，全部不依赖日志插件。右上角那枚走 Discord 自己的 `HeaderBarIcon`（`findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"')`），注入点是 `toolbar: … mobileToolbar: …` 那个组件的补丁，跟日志插件用的是同一处、各自插自己的调用（补丁里的 `$self` 按插件实例替换，不会互相盖）。输入框那颗走 Vencord 的 `ChatButtons` API，它由内置插件 `ChatInputButtonAPI` 的补丁负责往里塞，所以这个 API 名字**必须写在 `dependencies` 里**：不声明的话 `addChatBarButton()` 一样跑得不声不响、不报错，但图标根本不会出现（`MessageDecorationsAPI` / `MemberListDecoratorsAPI` 同理）。


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
node build.mjs              # settings 层：读写兜底、克隆缓存、探针清理
node build2.mjs entry2.mjs  # 徽标 + 名单面板
node build2.mjs entry3.mjs  # 右键菜单 -> 弹窗 -> 保存 的整条链
```

三行都该是 `失败 0 条`（42 / 41 / 43）。它把这几件事钉住了：

- `marks` 被改成 null / 字符串 / 混进坏条目时，徽标静默不渲染、面板退到空名单提示，**不能把整条消息头炸进 ErrorBoundary**
- `getMarks()` 的克隆结果按存储对象身份缓存：200 条可见消息回填只克隆 1 次；写入方全部换新对象，缓存那份不会被改脏
- 标记成功不弹 toast、`onClose()` 抛错也照样用 `closeAllModals()` 兜底关窗（都是实测踩出来的，别改回去）
- 启动时清探针遗留数据是幂等的：没有遗留就一次盘都不写

自带库这条链路另有一套桩，在 `C:\Users\11028\Documents\.Hanako\usermark-tests\standalone\`：

```powershell
cd "C:\Users\11028\Documents\.Hanako\usermark-tests\standalone"
node build.mjs                 # 104 条，全绿才是 0 失败
```

它用 `fake-idb.mjs` 顶掉 `indexedDB`（写入同样过 `structuredClone`，所以「把带 getter 的 flux Message 直接塞进库」在桩里也会像真机一样抛 DataCloneError），用 `stub-webpack.mjs` 顶掉 `RestAPI` / `FluxDispatcher` / 各种 store，然后跑真的 `records.ts` / `db.ts` / `capture.ts` / `backfill.ts`。钉住的是这几件事：

- 名单外的人、临时消息、pending/失败消息、非 `type === 0` 的消息都不落库；关掉 `logMarkedMessages` 就一条都不记
- 删除只改 `status`，正文留着；`addRecords` 不会把已知的 `DELETED` 洗回 `NORMAL`
- 回溯：服务器频道走搜索接口、私聊走频道历史；整页才翻页（第二页 `offset=25`）；撞 429 立即收手不再发请求，普通报错只断当前这个用户；标记来源那条会被补进来且不会重复拉
- 超过 `maxMarkedMessages` 裁到最新的 N 条
- 取消标记后那个人的记录立刻不再显示，但行还在库里（重新标记就回来）
- 闸门契约：并排发两条回溯时第二条必然 `skipped`（把坑本身钉住），串着发两条都跑到、库里两条都在
- ⑨ 静态对齐：弹窗里每个 `cl("...")` 吐出的类名在 `styles.css` 都有规则、样式表里也没有没人认领的孤儿类名，状态类必须是带前缀的整名，令牌得在 Vencord 自带样式里有先例

弹窗本身要真 Discord 才渲染得动，这块离线只验到类名和筛选逻辑；点开的表现还得实测。

## （可选）与消息记录器的联动

UserMark 现在**自己就能记**，装不装日志插件都不影响上面那条链路。`vc-message-logger-enhanced`（日志插件）是另一套独立实现，它会读同一份名单，所以也带一份标记发言的视图：

- 被标记用户发出的消息（非临时消息）会直接写进日志库，**不受日志插件的黑白名单限制**
- 日志弹窗的「幽灵提及」右边多出一个「标记用户发言」页签
- 该页签按**作者**过滤而非按状态，所以他们的已删除、已编辑消息也会出现在这里；反过来，一条消息被删了也不会从这个页签消失
- 日志插件设置里有 `记录被 UserMark 标记的用户…` 开关，不想要可单独关

读取方式是直接读 Vencord 全局 `Settings.plugins.UserMark.marks`，不 import 模块，所以 UserMark 被禁用时日志插件不会崩。

### 回溯拉取

网关推送只覆盖当前订阅的频道，重启前、没打开的服务器都会漏，所以页签还挂了一条回溯路径，**范围限定在你当前打开的频道**：

- 服务器频道：`GET /guilds/{id}/messages/search?channel_id=&author_id=`，一个用户一页请求，翻到标记时间之前就停（最多 10 页，每页 25 条）
- 私聊 / 群聊没有搜索接口，改读频道历史 `GET /channels/{id}/messages`（每页 100 条，最多 4 页），读到的按名单过滤
- 请求间隔 250ms，撞 429 立即收手；两次自动拉取间隔至少 60 秒
- 页脚有「拉取本频道标记发言」按钮，点了强制拉，不受冷却限制
- 页签**不按标记时间过滤**（把标记之前的发言也摆出来），所以「用来标记的那条」也能出现
- DM 不走搜索接口（Discord 搜索只支持服务器），靠实时捕获，私聊始终订阅所以不会漏

### 标记来源那条消息

被标记时用来标记的那条消息，在日志里会多一条左侧竖线加「标记来源」小徽标。要看到它有两条路径：

- 弹窗一打开就按 `sourceMessage.id` + `channelId` 精确回源补一次（这条必然早于标记时刻，靠频道回溯经常挤不进页签首页）
- 名单标签右键「查看标记来源」，把搜索框填成 `from:<用户ID> message:<消息ID>` 直达；搜索框非空时查询是全量扫描，不受「一次显示 N 条」限制

徽标是否出现是**订阅**名单算的，不是挂载时拍快照：弹窗开着的时候在外面改了名单、或者右键取消了标记，行会立刻跟着变。

### 标记用户名单带

日志弹窗标签栏下面那一条（搜索框与消息列表之间）给每个被标记用户摆一枚标签，三样一起上：**头像 + 当前频道里显示的名字 + 备注**。

- 名字按「当前服务器的昵称 → 私聊备注名 → 全局名 → 用户名」依次取，档案还没缓存下来就直接摆 snowflake ID（可辨认、可复制）
- 头像跟着当前服务器走（有服务器头像就用服务器的）
- 超过 6 人就先只露前 6 个，剩下的收成 `+N`，最右侧给一个「展开 N 人 / 收起」；折叠态是单行不换行，标签自己收缩省略，`+N` 和展开按钮不会被挤出去
- 鼠标悬停显示：名字、用户 ID、标记时间、备注、标记来源那条消息
- 点标签 = 把搜索框填成 `from:<用户ID>` 筛这个人，再点一次取消；在哪个页签都生效
- 右键标签 = 「查看标记来源 / 修改标记 / 取消标记」。后两项直接写 Vencord 全局 `Settings.plugins.UserMark.marks`，所以 UserMark 那边（设置页名单面板、右键菜单）同步生效，不需要两个插件互相 import
- 备注为空、或备注跟名字一模一样时，就不多摆一段重复的
- 一个都没标记时整条隐藏

配色全部走 Discord 的主题令牌（`--background-mod-*` / `--text-default` / `--border-subtle`）。**别改回 `--header-primary`**：Discord 已经移除这个变量，取不到值会退成代码里写的 `#111`，暗色主题下等于隐形。也别把状态类写成 `.msg-logger-marked-chip.active` —— `classNameFactory` 会给**每个**类名加前缀，实际吐出的类是 `msg-logger-marked-chip-active`，复合选择器永远匹配不上（折叠和选中态都曾经因此是死规则）。

还有条时序上的坑：**store 只能在 hook 里现取，不能在模块顶层抄进常量**。`@webpack/common` 里的 `UserStore` / `GuildMemberStore` 那几个是 `waitForStore` 异步赋值的 `export let` 绑定，插件模块启动时就求值完了，那时还是 `undefined`；顶层 `const X = [UserStore, ...]` 会把三个 undefined 永久存进数组，`useStateFromStores` 拿它调 `addChangeListener` 就抛。因为日志弹窗是懒加载的，真机上表现为「一点开日志整个 Discord 崩掉」（That also failed）。桩已经会复现这个时序，改回去会直接红。

注意：日志插件的 `最多保存多少条消息` 默认 **200**，是全库总量上限，标记发言也会跟着被顶掉。想留得久把它调大或设 0（不限制）。

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
