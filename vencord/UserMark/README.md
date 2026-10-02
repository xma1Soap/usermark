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
    "username": "标记时的用户名快照",
    "markedAt": 1790000000000,
    "lastMessageAt": 1790000000000
  }
}
```

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
