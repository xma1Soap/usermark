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
| `components/MarkedUsersStrip.tsx` | 新增：标签栏下的名单带（头像 + 当前频道名字/ID + 备注） |
| `db.ts` | 新增 `NORMAL` 状态与两个标记查询 |
| `components/hooks.ts` | 页签分流 |
| `components/LogsModal.tsx` | 新增「标记用户发言」页签、名单带、拉取按钮 |
| `index.tsx` | `MESSAGE_CREATE` 时把标记用户的发言入库 |
| `settings.tsx` | 新增 `logMarkedUsers` 开关 |
| `styles.css` | 名单带样式（走现役主题令牌，亮暗两侧都可读） |

> 注意：这些文件里还带着本机的中文本地化改动，覆盖前先看一眼 diff。

装完后日志弹窗会多出「标记用户发言」页签（在「幽灵提及」右边），自动按标记时间回溯当前频道，页脚有手动拉取按钮。

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
| 桌面日志页签 / 当前频道回溯 / 名单带 | 已验证构建，真机行为待你确认 |
| 备注弹窗点保存不关窗 | 已修（`onClose` + `closeAllModals` 双保险） |
| 设置文件被探针抓的源码撑到 287KB | 已修（撤掉 `probe.ts`，启动时清掉遗留数据） |
| `marks` 是坏数据时消息头 / 设置页整块崩 | 已修（读取统一兜底，克隆结果按存储对象身份缓存） |
| 名单带只显示备注，暗色主题下几乎看不见 | 已修（改成头像 + 当前频道名字/ID + 备注；配色换到现役主题令牌，`--header-primary` 已被 Discord 移除，取不到值退成 `#111`） |
| 名单带折叠 / 选中态没生效 | 已修（状态类得写整名 `msg-logger-marked-strip-collapsed`，`.strip.collapsed` 这种复合选择器被 `classNameFactory` 的前缀行为永远匹配不上） |
| 名单带离线自测 | 42 条断言全绿（折叠阈值 / +N / 展开收起 / 名字回退链 / 点选 / 类名与样式表对齐），桩在 `.Hanako\usermark-tests\strip` |
| 手机版 | 无弹窗重制版已推送，离线 45 条断言全绿，**真机待验证** |
