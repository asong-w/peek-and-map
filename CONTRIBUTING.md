# 工作原理与运行调试

## 工作原理

### 整体流程

```
VS Code 编辑器                扩展宿主                              Webview（底部面板）
────────────────              ────────────────────────────────      ─────────────────────
光标移动       ──事件──▶  onDidChangeTextEditorSelection
                              │   notifyEditorChange()
                              │          │
                              │       update()
                              │          │
                              │   executeDefinitionProvider         ◀── 语言服务器
                              │   （获取光标处符号的定义位置）
                              │          │
                              │    ┌─ 找到定义 ──────────────────┐
                              │    │                              │
                              │    │  _getContextFromLocation()   │
                              │    │  打开定义文件，查询符号树     │
                              │    │  构造 ContextInfo            │
                              │    │          │                   │
                              │    │  postMessage({type:'update'})──────▶ renderCode()
                              │    │                                      Prism.highlight()
                              │    └──────────────────────────────┘       构建 <table>
                              │                                            滚动到视图中央
                              │    ┌─ 未找到定义 ─────────────────┐
                              │    │  保持面板当前内容不变         │
                              │    │  （不发送任何消息到 webview）  │
                              │    └──────────────────────────────┘

Webview 交互                  扩展宿主
────────────────              ──────────────────────────────────
双击空白/行号   ──消息──▶  onDidReceiveMessage({ type:'jumpToLine', line, uri })
单击行号       ──消息──▶       │
点击 ↗ 按钮   ──消息──▶       ▼
                          openTextDocument(uri)  → 跨文件打开
                          showTextDocument()     → 定位到对应行

Ctrl+点击符号  ──消息──▶  onDidReceiveMessage({ type:'ctrlClick', line, character, uri })
                              │  executeDefinitionProvider → _getContextFromLocation()
                              │  压入后退栈 → postMessage({ type:'update' }) ─────▶ 窗口内跳转
                              └─ postMessage({ type:'navState' }) ─────────────▶ 更新按钮状态

后退/前进按钮  ──消息──▶  onDidReceiveMessage({ type:'navBack' / 'navForward' })
鼠标侧键(3/4) ──消息──▶       │  从历史栈取出 → postMessage({ type:'update' })
                              └─ postMessage({ type:'navState' })
```

### Map View 流程

```
用户点击 "Analysis" 按钮       扩展宿主                              Webview
────────────────              ────────────────────────────────      ─────────────────────
                 ──消息──▶  onDidReceiveMessage({ type:'search' })
                              │  _doSearch()
                              │    ├─ 获取光标处单词
                              │    ├─ executeReferenceProvider → 引用列表
                              │    │  _resolveReferencingSymbols()
                              │    │  （为每条引用查找其封闭符号，构建引用树）
                              │    ├─ prepareCallHierarchy → provideIncomingCalls
                              │    │  （构建调用者树）
                              │    └─ postMessage({ type:'update' }) ──────▶ renderTreeList() / graphBuildFromData()
                              │                                              树形视图 或 图形视图
展开树/图节点  ──消息──▶  expandRef
                              │  递归加载子引用或上游调用者
                              └─ postMessage({ type:'children' }) ────────▶ 插入子节点 / graphHandleChildren()

图形视图交互                  扩展宿主
────────────────              ──────────────────────────────────
单击图形节点   ──消息──▶  onDidReceiveMessage({ type:'peekOnly', uri, line, character })
                              └─ _peekView.peekLocation(uri, pos)
                                 → Peek View 直接刷新，编辑器不变

双击图形节点   ──消息──▶  onDidReceiveMessage({ type:'jumpTo', uri, line, character })
                              ├─ _peekView.peekLocation(uri, pos)  → Peek View 同步刷新
                              └─ showTextDocument({ preserveFocus:false }) → 打开文件

Ctrl+点击      ──▶  展开/折叠子节点（不发消息到宿主，已展开节点本地折叠；
                              未展开节点发送 expandRef 请求）

点击 "Outline / Horiz / Vert" 标签  ──▶  setViewMode('tree'/'graph'/'graph-up') — 本地切换视图模式
```

### 主题配色继承

```
扩展宿主                                        Webview
───────────────────────────────────            ──────────────────────
resolveActiveThemeTokenColors()
  ├── 读取 workbench.colorTheme 配置
  ├── 遍历 vscode.extensions.all
  │   找到贡献该主题的扩展
  ├── 读取主题 JSON/JSONC 文件
  │   （递归处理 include 继承链）
  └── 返回 TokenColorRule[]

generateThemeTokenCss()
  ├── 遍历 PRISM_TO_TEXTMATE 映射表
  ├── 为每个 Prism token 查找
  │   最匹配的 TextMate scope 颜色
  └── 生成 CSS 字符串
         │
         ├─ 初始化时：嵌入 <style id="theme-tokens">
         │
         └─ 主题切换时（onDidChangeActiveColorTheme）：
              pushThemeColors()
              postMessage({ type:'themeColors', css })
                                                        │
                                                   更新 <style> 内容
                                                   立即生效，无需重新渲染代码
```

### 关键设计决策

**1. 立即发送 `ready` 信号（解决"加载中…"问题）**

webview 的内联脚本在 DOM 解析完成后**同步执行**，第一行就向扩展发送 `{ type: 'ready' }`，扩展收到后立即触发 `pushThemeColors()` + `update()`。不等待任何外部资源（无 CDN）。

**2. Definition Provider 驱动 + 无定义时保持不变**

`update()` 调用 `executeDefinitionProvider`，获取光标处标识符的定义位置（可能在完全不同的文件）。找到后调用 `_getContextFromLocation()` 打开定义文件并展示定义体。若光标处没有可解析的定义（空白、注释、语言无 provider），面板**保持上次内容不变**，避免频繁清空或闪烁。

**3. Ctrl+点击视图内跳转 + 前进后退导航**

Peek 视图中按住 Ctrl 并点击符号，扩展会调用 `executeDefinitionProvider` 解析该符号的定义，并将结果直接显示在当前面板，无需离开 Peek 视图。每次 Ctrl+点击跳转会将当前显示内容压入后退栈，支持通过底部按钮或鼠标侧键（button 3/4）在历史中前进/后退。当编辑器光标移动导致内容刷新时，导航历史会自动重置。

**4. 双击交互区分**

webview 在 `codeContainer` 上监听 `dblclick`（事件委托），双击行号列或空白区域时跳转到编辑器对应位置；双击代码文本则执行正常的文字选中操作，不会触发跳转。同时保留单击行号列的传统跳转方式。

**5. 跨文件跳转**

`jumpToLine` 消息携带 `uri` 字段（vscode URI 字符串）。扩展收到后调用 `vscode.workspace.openTextDocument(uri)` + `showTextDocument()`，可无缝导航到任意文件的任意行。

**6. 完全本地化 Prism.js（消除 CDN 依赖）**

prism.js、主题 CSS 和所有语言组件均存放在 `media/` 目录，通过 VS Code 的 `webview.asWebviewUri` 以本地资源方式加载。autoloader 的 `languages_path` 也指向本地 `media/components/`。

**7. 动态主题配色（继承编辑器主题）**

扩展直接读取当前 VS Code 主题的 JSON 文件（通过 `vscode.extensions.all` 定位主题扩展），解析其 `tokenColors` 数组，根据 `PRISM_TO_TEXTMATE` 映射表将 TextMate scope 转换为 Prism `.token.xxx` 的 CSS 颜色规则。初始化时嵌入 HTML，主题切换时通过 `postMessage` 动态更新 `<style>` 标签，无需重建 webview。支持 JSONC 注释、尾逗号和 `include` 继承链。

**8. 记录最后已知编辑器（解决面板夺焦问题）**

底部面板获得鼠标焦点时，`vscode.window.activeTextEditor` 变为 `undefined`。
`PeekViewProvider` 持有 `_lastKnownEditor`，在所有编辑器/光标变化事件中更新它。`update()` 优先使用 `activeTextEditor`，回退到 `_lastKnownEditor`，保证面板有焦点时内容仍然正确。

**9. 增量去重**

`update()` 缓存 `_lastUri + _lastVersion + _lastLine`，三者均未变化时直接跳过，避免每次按键都触发语言服务器请求。`_resetDedup()` 在收到 `ready` 或面板重新可见时调用，强制下一次刷新。

**10. 符号解析重试**

在 `_getContextFromLocation()` 中，若语言服务器刚启动，`executeDocumentSymbolProvider` 可能返回空数组。此时等待 600ms 后重试一次。若仍无符号，则以定义点为中心显示前后数十行代码作为上下文（fallback to surrounding lines）。

**11. 两阶段渲染（加速显示）**

若 Prism 语言组件尚未加载（首次打开该语言文件），先立即用转义纯文本渲染（无延迟），再让 autoloader 异步加载对应语法后自动重绘为高亮版本。

**12. Ctrl+滚轮缩放字体（保持区域不变）**

按住 Ctrl 并滚动鼠标滚轮可调整面板字体大小（8–40px，每次 ±1px）。缩放时会按新旧字体大小比例调整 `scrollTop`，保持当前窗口可见的第一行不变。字体大小通过 `vscodeApi.setState()` 持久化，面板重新显示时自动恢复。

**13. Map View 引用树去重**

`_resolveReferencingSymbols()` 查找所有引用后，为每条引用定位其封闭符号（所在的函数/类），按符号位置去重，避免同一个函数中多次引用导致重复节点。自引用（封闭符号就是被查询的符号本身）也会被过滤。

**14. 懒加载树展开**

Relation Window 的树节点不会一次性加载所有层级。首次点击展开箭头时才向扩展发送请求，扩展异步查询并返回子节点。已加载的节点可直接折叠/展开，无需重新请求。在图形视图中通过 Ctrl+点击节点触发展开/折叠。

**15. Canvas 图形视图**

Map View 提供基于 HTML5 Canvas 2D 的图形视图，通过 `Outline` / `Horiz` / `Vert` 标签切换。`Horiz` 使用 BFS 层级布局从左到右排列，`Vert` 使用向上展开布局。连边均为 Bezier 曲线并带箭头。节点统一为圆角矩形，通过符号名前的**彩色字母徽章**区分类型（如 `f` Function、`m` Method、`C` Class、`I` Interface、`v` Variable、`S` Struct 等），徽章颜色与节点边框颜色一致，颜色来源于当前主题的 `--peek-kind-*` CSS 变量。函数参数自动去除，保持标签简洁。支持滚轮缩放（0.2x–5x）、鼠标拖拽平移、ResizeObserver 自动重布局。

图形展开时的等待动画会显示在节点延伸方向：`Horiz` 显示在节点右侧，`Vert` 显示在节点上方。

当前分析符号不再显示在顶栏，而是作为真实根节点参与树形/图形渲染，交互与普通节点一致。

**15a. 图形视图节点合并**

当同一封闭符号（如函数 B）在多处引用了目标符号（如函数 A）时，树形列表中会显示多个节点（首个可展开，后续为叶子节点），但图形视图通过 `mergeItemsBySymbol()` 函数自动将这些重复节点合并为一个。合并后的节点在不同位置的引用行号各自显示为可交互的行号徽章（如 `L10` `L20` `L30`），排列在符号名称下方。节点高度根据是否有多个调用位置自动调整（单调用位置：32px，多调用位置：32+16=48px）。鼠标悬停在行号徽章上时高亮显示，单击触发 `peekOnly`（预览），双击触发 `jumpTo`（跳转到编辑器），行为与树形视图中对应的节点完全一致。合并使用符号定义位置（`uri + line + character`）作为去重键，保留首个可展开的 `nodeId` 用于递归展开。图形节点右侧不再显示 `+/-` 展开徽标，展开/折叠通过 Ctrl/Cmd+点击节点触发。

**15b. 图形稳定排序（Horiz / Vert）**

在 `Horiz` 与 `Vert` 模式中，同层节点都按父节点层的顺序与位置进行稳定排序，而不是按“展开先后”排序，避免出现下一级节点交叉渲染。

**15c. 折叠后展开状态恢复**

在图形视图中，折叠靠近根部节点时会移除当前图中的后代节点，但保留后代的展开状态；重新展开该父节点后，会根据缓存自动恢复此前已展开的子节点。

**16. 三模式点击交互（树形列表与图形视图通用）**

树形列表和图形视图均实现三种点击交互：
- **单击**：发送 `peekOnly` 消息，扩展调用 `_peekView.peekLocation(uri, pos)` 直接将目标符号推入 Peek View，**不打开也不切换编辑器**
- **双击**：发送 `jumpTo` 消息，扩展先调用 `peekLocation()` 更新 Peek View，再以 `preserveFocus: false` 在编辑器中正式打开目标文件
- **Ctrl/Cmd+点击**（图形视图）：展开或折叠子节点，触发 `expandRef` 请求或本地折叠

为避免单击和双击冲突，利用了 `click` 事件的 `e.detail` 属性区分。

**17. 按钮与标签**

Map View 的 Analysis 使用 Emoji 图标（🔍）；视图切换使用文字标签（`Outline` / `Horiz` / `Vert`）。

**18. 函数参数省略**

树形列表和图形视图均通过 `stripParams()` 函数将 `"foo(int a, int b)"` 截断为 `"foo"`，使节点/行标签更紧凑，减少宽度占用。

---

## 运行与调试

### 前置条件

- Node.js ≥ 18
- VS Code ≥ 1.85

### 安装依赖

```bash
# Windows（绕过 PowerShell 执行策略）
cmd /c "npm install"
```

### 构建

```bash
cmd /c "npm run compile"
# 或监听模式：
cmd /c "npm run watch"
```

### 以调试模式启动

按 **F5**（或菜单 **运行 → 开始调试**），VS Code 会打开一个扩展开发宿主窗口，插件已自动加载。

- 在底部面板点击 **Peek** 标签，然后在任意支持语言的文件中将光标移到函数体内即可看到 Peek View 效果。
- 在底部面板点击 **Map** 标签，将光标放在符号上后点击「Analysis」按钮，即可查看引用和调用关系。通过 `Outline` / `Horiz` / `Vert` 标签切换视图。

### 手动命令

打开命令面板（`Ctrl+Shift+P`）执行：

```
Peek and Map: Show Peek View
Peek and Map: Show Map View
```

### 打包

```bash
cmd /c "npm run package"
```

生成 `.vsix` 文件后可通过 `Extensions: Install from VSIX...` 安装。
