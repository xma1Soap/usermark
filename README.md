# UserMark 标记

给 Discord 里的人挂自定义备注，名字后面显示 `[被标记]`，被标记的人进得了独立名单。

两套实现，一套给桌面 Vencord，一套给手机 Kettu，逻辑同源但代码完全不同——它们跑在两套运行时上。

```
vencord/
  UserMark/                     桌面版插件（完整，可直接用）
  message-logger-enhanced/      对日志插件的改动（覆盖同名文件）
kettu/
  index.js  manifest.json       手机版插件（Vendetta polymanifest 格式）
```

## 桌面版（Vencord）

`vencord/UserMark/` 是一个标准 Vencord userplugin，目录整个丢进 `src/userplugins/`，构建后在插件列表里开（筛选记得切 `Show All`，`Show Enabled` 会把没启用的新插件藏起来）。

- 右键**人**或**他的消息** → 「标记」→ 写备注
- 消息头、成员列表名字后面挂 `[被标记]`，悬停看备注和两个时间
- 插件设置页有名单面板：搜索、编辑、删除
- 读数据的方式是直接读 Vencord 全局 `Settings.plugins.UserMark.marks`，所以别的插件也能复用这份名单

### 三个闸门

1. `authorization: Bearer public` + 指纹头（OpenCode Zen 免密车道）——与本仓库无关，见下方说明
2. 装饰槽位依赖 `MessageDecorationsAPI` / `MemberListDecoratorsAPI`，首次启用会提示需要重启
3. 名单是纯本地数据，存在 `settings.json` 的 `plugins.UserMark.marks`，不上传任何地方

## 与日志插件的联动

`vencord/message-logger-enhanced/` 里的文件来自对 [Syncxv/vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 的本地改动。**同名文件直接覆盖**即可，新文件按原路径放入：

| 文件 | 改动 |
| --- | --- |
| `utils/markedUsers.ts` | 新增：读 UserMark 名单 |
| `utils/markedFetch.ts` | 新增：按标记时间回溯当前频道发言 |
| `components/MarkedUsersStrip.tsx` | 新增：标签栏下的名单带 |
| `db.ts` | 新增 `NORMAL` 状态与两个标记查询 |
| `components/hooks.ts` | 页签分流 |
| `components/LogsModal.tsx` | 新增「标记用户发言」页签、名单带、拉取按钮 |
| `index.tsx` | `MESSAGE_CREATE` 时把标记用户的发言入库 |
| `settings.tsx` | 新增 `logMarkedUsers` 开关 |
| `styles.css` | 名单带样式 |

> 注意：这些文件里还带着本机的中文本地化改动，覆盖前先看一眼 diff。

装完后日志弹窗会多出「标记用户发言」页签（在「幽灵提及」右边），自动按标记时间回溯当前频道，页脚有手动拉取按钮。

## 手机版（Kettu）

`kettu/` 是给 [Kettu](https://github.com/C0C0B01/Kettu)（Bunny → Vendetta → Revenge 那条线的安卓/iOS mod）写的 Vendetta 插件：

- 长按一条消息 → 「标记此用户」→ 弹输入框写备注
- 已标记的人 → 「编辑标记备注」/「取消标记」
- 设置页出名单面板

装法（插件是按 URL 拉的，所以要能被 HTTP 访问）：

```
https://raw.githubusercontent.com/xma1Soap/<本仓库>/main/kettu/
```

改过 `index.js` 记得同步 `manifest.json` 的 `hash`（sha256）。

**手机版没做徽标**：桌面版靠 `MessageDecorationsAPI`，移动端没有对应槽位，得先在真机上定位消息头部的组件名，我没有安卓环境，瞎猜写进去只会让你装个坏插件。

## 状态

| | 状态 |
| --- | --- |
| 桌面标记 / 徽标 / 名单面板 | 已验证 |
| 桌面日志页签 / 当前频道回溯 / 名单带 | 已验证构建，真机行为待你确认 |
| 备注弹窗点保存不关窗 | 已修（`onClose` + `closeAllModals` 双保险） |
| 手机版 | 本机语法与求值通过，**真机未验证** |
