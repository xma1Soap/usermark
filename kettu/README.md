# UserMark for Kettu

桌面版 UserMark 的移动端版本。Kettu 是 Bunny → Vendetta → Revenge 那条线的 Discord **手机端** mod，插件是 Vendetta polymanifest 格式（`manifest.json` + `index.js`），运行在 React Native 里，跟 Vencord 的 TypeScript/DOM 体系完全不是一套，所以这是**重写**，不是移植。

## 能做什么

- **长按一条消息** → 菜单末尾出现「标记此用户」，点一下就**当场落盘**（备注可以先不写），面板自动收起，只弹一个 toast
- 回到 **设置页 → 插件 → UserMark**，顶部会自己摊开「给「xx」写备注」的输入框，写完点「保存」
- 已标记的人 → 菜单变成「编辑标记备注」+「取消标记」
- 名单里点一行 → 就地展开输入框改备注，下面还有「取消标记这个人」；**全程不弹任何窗**（原因见下面「踩过的三个坑」第 1 条）
- **设置页 → 标记用户发言**：只记名单内用户的收到/编辑/删除（存 MMKV），点一行就地摊出「复制这条内容 /（改过的话）改之前的每一版 / 删除这条记录」，上限也能在这一页改
- 长按菜单万一挂不上：**设置页 → 按 ID 标记一个用户**照样能用（就地输入 `用户ID 备注`）
- 被旧版本弄坏了缓存（一开弹窗就报 `FluxContainer(Alert) is undefined`）：**设置页 → 修复：清空模块缓存并重启**（两下确认）

## 装法

插件是通过 URL 装的（Kettu 拉 `manifest.json` 和 `index.js`），所以要先让它能被 HTTP 访问：

1. 把这个目录推到 GitHub 任意仓库（比如 `UserMark/`）
2. Kettu → 设置 → 插件 → 安装插件，粘贴目录 URL：

```
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/UserMark/
```

Kettu 会自己拼 `manifest.json` 和 `index.js`。

`manifest.json` 里的 `hash` **不是完整性校验，只是变更标记**：Kettu 拿它跟本地已存的比对，一样就沿用缓存的旧 JS。所以改了 `index.js` 必须让 `hash` 变（本项目沿用 sha256，改完重算即可），否则你装的还是旧版。

## 实现要点

| 桌面版（Vencord） | 移动版（Kettu） |
| --- | --- |
| `contextMenus["message"]` | `patcher.before("openLazy", findByProps("openLazy","hideActionSheet"))`：从调用参数认出消息长按面板（key 含 `LongPress`、props 里带 `message`） |
| 菜单项注入 | 面板是 `openLazy(promise, key, props)` 懒加载的，所以 `promise.then(mod => patcher.after("default", mod, cb))`，从 `cb` 拿到的渲染树里按**形状**找行数组（`Array` 且元素带 `props.onPress`），往里 push 行 |
| 行用什么组件渲染 | 直接抄面板里现成那行的 `type`，连文字 prop 叫什么（`label`/`text`/`title`）一起抄——这样一次 metro 查询都不发。抄不到才回退 `findByProps("ActionSheetRow")`，且整个会话只查一次 |
| 每次渲染重新判定 | 行里给谁标记，取**本次渲染 props 的 message**，不取当初 openLazy 的闭包；重复渲染靠行上的 `__usermarkRow` 标记去重 |
| `openModal` 输入框 | **不用弹窗**：设置页里就地展开一个输入框，优先 `Forms.FormInput`（`onChange` 同时吃 string 和 `{text}`），拿不到就降级 `ReactNative.TextInput` + `onChangeText`，两个都没有就显示「这台设备找不到可用的输入框」（标记本身照样能用）。取组件的语句包了 try/catch：`metro.common.*` 是懒代理，读属性会触发 `forceLoad` |
| `definePluginSettings` 落盘 | `plugin.storage`（MMKV 响应式代理），读写一律 JSON 往返保证纯对象 |
| 设置面板 | 插件导出 `settings` React 组件，用 `Forms.FormSection/FormRow` |

`window.vendetta` 暴露的 API 面（patcher / metro / ui / utils / storage）见 Kettu 源码 `src/core/vendetta/api.tsx`；`window.bunny` 是同一套东西的新版入口。

## 踩过的三个坑（改这块代码前先看）

1. **别用 `ui.alerts`，一次都别用。** Kettu 的 `showInputAlert` / `showConfirmationAlert` 渲染的是 Discord 那套**老 Alert**：`src/metro/common/components.ts:18` 的 `LegacyAlert = findByDisplayNameLazy("FluxContainer(Alert)")`。现网 Discord 已经没有这个组件了，所以只要插件弹一次输入框，就在 `forceLoad` 抛
   `bunny.metro.byDisplayName(FluxContainer(Alert)) is undefined! (id unknown)`，整块被 ErrorBoundary 吃掉——**表现就是「一点标记就崩」，而且跟插件自己的代码看起来没关系**。
   所以这一版的交互全部改成设置页里就地展开编辑器，连 `showSimpleActionSheet` 也不用了（少一次 metro 查询，少一处会崩的地方）。要加交互就继续往这一页里加，别回头去调 `ui.alerts`。
2. **别发「查不到」的 metro 查询，尤其别在热路径里重复发。** 一次未命中的 `findByProps` / 永不命中的 `find(cb)` 会做两件事，两件都落盘到 `caches/metro_modules.json`：
   - 扫描会把所有**还没初始化**的模块强制 `require` 一遍。抛错的那个 id 被 `blacklistModule()` 置为非枚举 + 写进 `flagsIndex`。Kettu 启动时（`src/metro/internals/modules.ts` 开头那个循环）照着文件把黑名单原样套回来，于是它从此不在 `for (const id in metroModules)` 里 —— **按名字/属性找它就再也找不到了**。
   - 同一次未命中还会把这条查询的 uniq 标成 `_NOT_FOUND`（`findIndex`），之后同种查找直接返回空。

   表现就是**别的插件（或本插件旧版）一开弹窗就崩**，而且**重启、重装插件都不自愈**——旧版本 `104f801` 在 `onLoad` 里全量扫描时就踩过这个，被拉黑的恰好是老 Alert 那个模块。

   自救：**设置页 → UserMark → 「修复：清空模块缓存并重启」**（两下确认）。它删掉 `caches/metro_modules.json` 再叫 `BundleUpdaterManager.reload()`，下次启动 Kettu 自己重建一份干净的。删两次是必须的：Kettu 的 `saveCache` 是 1 秒防抖，只删一次会被内存里的旧缓存写回来。不想用按钮的话，手动删 `<Discord 文档目录>/pyoncord/caches/metro_modules.json` 也行（各分支前缀可能是 `pyoncord/` `bunny/` `kettu/`），删完**要先彻底关闭进程**再打开，否则又写回来。
3. **`patcher` 是 Proxy 包装，不是换函数。** spitroast 往模块上装的是 `new Proxy(origFunc, {...})`，`name`/`displayName`/自定义属性都还是原函数的，unpatch 时精确还原原引用。所以「补组件 default 会截断 Kettu 按名字找组件的链」这个担心是多余的——真正会截断的是自己写 `mod.default = function 包装(){}`。

## 已验证 / 未验证

**已验证（本机，用真实 spitroast + Kettu 兼容层桩跑）：**

- `node --check` 通过；`onLoad` / `onUnload` / `settings` 三件套齐全
- 长按 → 面板出现「标记此用户」；点一下**立刻**落盘（含来源消息），面板收起、只给 toast；再长按同一人变「编辑标记备注 / 取消标记」
- 换一个未标记的人长按仍显示「标记此用户」（作者按本次渲染判定，不会串到上一个人）
- 面板重复渲染不会堆出重复行；非消息面板（如头像长按）不会被误补
- 补丁装在上面那种壳模块（渲染树里没行）时，下一次长按会自动再补一个模块（上限 2）
- `unpatch` 后模块 `default` 与 `openLazy` 都还原为原引用；`displayName` 全程可被 `byDisplayName` 找到
- 面板自己带行组件时**一次 metro 查询都不发**；面板只给字符串 type 时才回退查 `ActionSheetRow`，且连渲 4 次也只查 1 次
- 修复按钮：第一下只落在确认文案上（不碰文件），第二下才删缓存 + 调 `reload`，删除前会先用 `fileExists` 认出真实前缀目录
- **全程零弹窗**：桩里 `ui.alerts.showInputAlert / showConfirmationAlert / showCustomAlert` 一被调用就直接 throw，跑完 ⓪–⑯ 没触发；整轮只发过 3 种 metro 查询（`openLazy+hideActionSheet`、`subscribe+dispatch`、回退时的 `ActionSheetRow`）
- 长按之后进设置页：备注框自己摊开（靠 `plugin.storage.pending`），打字→保存 → 备注落盘、`pending` 清掉、编辑器收起
- 名单里点一行带出旧备注；「取消标记这个人」就地删掉这条标记
- 按 ID 标记：合法 snowflake 存下备注；`abc` 只给提示，不落盘也不关编辑器
- 记录上限：非法值不改数、编辑器不关；合法值写进去且行标题同步（`记录上限：50 条`）
- 发言记录行：点开设「复制这条内容 / 删除这条记录」，复制走剪贴板，删除只删这一条
- 防编辑：改之前那版排进 `editHistory`（正文没变的那类更新不排、反复改只留最新 10 版），行副标题报出「改前 N 版」，摊开能看见每一版旧正文并把它单独复制走
- 删掉 `Forms.FormInput` 之后设置页仍能输入，自动降级成 `ReactNative.TextInput` + `onChangeText`

**未验证（需要真机）：**

- 你当前 Discord 版本的消息长按面板 key 是否还叫 `MessageLongPressActionSheet`、props 里是否直接给 `message`。装好后设置页「跑一次菜单定位诊断」会把**最近打开过的面板 key 和 props 属性名**列出来——不出现标记项时那几行就是定位依据
- 行样式（抄的是面板里现成那行的组件，只给文字不给图标）在面板里的观感
- 真机上 `pyoncord/caches/metro_modules.json` 的实际前缀目录名（代码里 `pyoncord/ bunny/ kettu/` 都试）
- `Forms.FormInput` 在你这版 Discord 里 `onChange` 到底给的是 string 还是 `{text}`（代码两种都兜了），以及内联输入框在这一页的观感

## 暂时没做的

- **名字后面的 `[被标记]` 徽标**：桌面版走 `MessageDecorationsAPI`，移动端没有对应槽位，需要先定位消息头部组件（社区的 `Show Tag` / `PlatformIndicators` 插件就是改这里）。这一步必须在真机上跑一次才能确定模块名
- **右键用户本人**（不是消息）：移动端是资料页的菜单，另一套 hook
- **桌面版那套「回溯拉取 / 标记来源高亮」**：手机端没 IndexedDB 也没 MessageLogger 插件联动，目前只记本机收到过的消息
