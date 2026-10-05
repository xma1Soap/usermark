# UserMark 标记

右键一个人或他的消息 → 「标记」→ 给他挂一条自定义备注。被标记的人在名字后面会显示一枚红色的 `[被标记]`，鼠标悬停能看到备注和两个时间。设置页里有一份可搜索的完整名单。

## 功能

| 位置 | 表现 |
| --- | --- |
| 右键用户（成员列表 / 资料弹层 / 私聊列表） | 菜单末尾多出「标记」，已标记则变成「编辑标记备注」+「取消标记」 |
| 右键消息 | 同上，取该消息的作者 |
| 消息头 | 名字后面挂 `[被标记]` 徽标 |
| 成员列表 | 名字后面挂 `[被标记]` 徽标（可在设置里关） |
| Vencord 设置 → UserMark → 齿轮 | 「被标记名单」面板：搜索框 + 每人的备注、被标记时间、最新发言时间，支持编辑和删除 |

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

## 与消息记录器的联动

标记名单不只存在 UserMark 里。`vc-message-logger-enhanced`（日志插件）会读同一份数据：

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
- 页签只显示**不早于标记时间**的记录，比这更早的消息拉了也会被过滤，所以不拉
- DM 不走搜索接口（Discord 搜索只支持服务器），靠实时捕获，私聊始终订阅所以不会漏

### 标记用户名单带

日志弹窗标签栏下面那一条（搜索框与消息列表之间）会把所有被标记用户按**备注**摆成标签：

- 超过 6 人就先只露前 6 个，剩下的收成 `+N`，最右侧给一个「展开 N 人 / 收起」
- 鼠标悬停显示用户名与标记时间
- 点标签 = 把搜索框填成 `from:<用户ID>` 筛这个人，再点一次取消；在哪个页签都生效
- 一个都没标记时整条隐藏

注意：日志插件的 `最多保存多少条消息` 默认 **200**，是全库总量上限，标记发言也会跟着被顶掉。想留得久把它调大或设 0（不限制）。

## 已知限制

- `authors` 用的是占位 id `0n`，要显示你的 Discord 头像就把 `index.tsx` 里的 id 换成真实用户 ID。
- 右键私聊列表里的会话本身给的是频道菜单（`channel-context`），要标记那个人得走他的消息或资料弹层。
- 最新发言时间只覆盖插件启用之后、且消息实际渲染过的记录。

## 撤掉的调试探针

`probe.ts`（抓搜索界面组件源码用的）已经删除。它把抓到的源码整份写进 `settings.json`：本机实测 287KB 的 `plugins.UserMark.probe`，占当时整个设置文件的 97%，之后 Vencord 每写一次任何设置都要把这一坨整份序列化进磁盘；而且 `probeEnabled` 一旦打开，`focusin` 加全站 `MutationObserver` 会在每次点搜索框时重新抓一遍。搜索面板改版要继续做的话：

- 代码：`git show 629f588:vencord/UserMark/probe.ts`
- 最后一次抓到的 10 份数据：`C:\Users\11028\Documents\.Hanako\usermark-probe\probe-captures-2026-10-05.json`
- 老设置文件里的残留不用手动删，插件下次启动会自己清（`purgeProbeLeftovers()`）
