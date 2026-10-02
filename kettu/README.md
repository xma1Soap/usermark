# UserMark for Kettu

桌面版 UserMark 的移动端版本。Kettu 是 Bunny → Vendetta → Revenge 那条线的 Discord **手机端** mod，插件是 Vendetta polymanifest 格式（`manifest.json` + `index.js`），运行在 React Native 里，跟 Vencord 的 TypeScript/DOM 体系完全不是一套，所以这是**重写**，不是移植。

## 能做什么

- **长按一条消息** → 菜单末尾出现「标记此用户」，点了弹输入框写备注（可留空）
- 已标记的人 → 菜单变成「编辑标记备注」+「取消标记」
- **设置页 → 插件 → UserMark** → 名单面板：备注为主标题，用户名和标记时间为副标题，点一行出「编辑备注 / 取消标记」

## 装法

插件是通过 URL 装的（Kettu 拉 `manifest.json` 和 `index.js`），所以要先让它能被 HTTP 访问：

1. 把这个目录推到 GitHub 任意仓库（比如 `UserMark/`）
2. Kettu → 设置 → 插件 → 安装插件，粘贴目录 URL：

```
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/UserMark/
```

Kettu 会自己拼 `manifest.json` 和 `index.js`。改了 `index.js` 记得同步更新 `manifest.json` 里的 `hash`（sha256），否则它可能拿旧缓存。

## 实现要点

| 桌面版（Vencord） | 移动版（Kettu） |
| --- | --- |
| `contextMenus["message"]` | `patcher.after("default", findByProps("EmojiRow"))`，拦消息长按菜单组件 |
| 菜单项注入 | 遍历返回的 JSX 树，找「一堆带 `label`+`onPress` 的行」，往里 push（不按死层级路径，耐版本变化） |
| `openModal` 输入框 | `ui.alerts.showInputAlert` |
| `definePluginSettings` 落盘 | `plugin.storage`（MMKV 响应式代理） |
| 设置页 COMPONENT 面板 | 插件导出 `settings` React 组件，用 `Forms.FormSection/FormRow` |

`window.vendetta` 暴露的 API 面（patcher / metro / ui / utils / storage）见 Kettu 源码 `src/core/vendetta/api.tsx`。

## 已验证 / 未验证

**已验证（本机）：**

- `node --check` 语法通过
- 按 Vendetta 的求值方式 `vendetta => {return <内容>}` 跑过一遍，返回 `{onLoad, onUnload, settings}` 三个键，生命周期执行无异常（用桩 API 模拟）

**未验证（需要真机）：**

- 长按菜单能不能被拦到、按钮数组能不能定位到 —— 这两处依赖 Discord 当前版本的组件结构。定位失败时插件会 `logger.warn` 而不是崩，把 Kettu 日志发我即可定位
- 设置面板在你当前 Kettu 版本的 `Forms` 上的显示效果

## 暂时没做的

- **名字后面的 `[被标记]` 徽标**：桌面版走 `MessageDecorationsAPI`，移动端没有对应槽位，需要先定位消息头部组件（社区的 `Show Tag` / `PlatformIndicators` 插件就是改这里）。这一步必须在真机上跑一次才能确定模块名，我没有你的安卓环境，瞎猜写进去只会白装
- **右键用户本人**（不是消息）：移动端是资料页的菜单，另一套 hook
- **日志插件那套页签 / 回溯拉取**：桌面版依赖 IndexedDB + 文件系统，RN 上没有 IndexedDB，等于重做一个存储层，属于第二期
