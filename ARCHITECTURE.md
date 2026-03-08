# 项目结构

```
peek/
├── src/
│   ├── extension.ts          # 扩展入口：activate/deactivate、事件注册
│   ├── constants.ts          # 常量：语言映射表、Prism→TextMate scope 映射表
│   ├── types.ts              # 共享接口：ContextInfo、TreeNodeData、TokenColorRule
│   ├── theme.ts              # 主题颜色提取：JSONC 解析、主题文件加载、CSS 生成
│   ├── utils.ts              # 通用工具函数（getNonce 等）
│   ├── peekView.ts       # PeekViewProvider — 代码预览面板
│   └── mapView.ts        # MapViewProvider — 引用/调用关系面板
├── out/                      # 编译产物（自动生成）
│   ├── extension.js
│   ├── constants.js
│   ├── types.js
│   ├── theme.js
│   ├── utils.js
│   ├── peekView.js
│   └── mapView.js
├── media/
│   ├── prism.js              # Prism 核心（本地，无 CDN）
│   ├── prism-autoloader.min.js  # Prism 语言自动加载插件
│   └── components/           # 所有 Prism 语言组件（597 个文件）
├── .vscode/
│   ├── launch.json           # F5 调试配置
│   └── tasks.json            # 构建任务（compile / watch）
├── package.json              # 插件清单 + npm 脚本
├── tsconfig.json             # TypeScript 编译配置
└── README.md                 # 项目说明文档
```

## 模块职责

### `extension.ts` — 扩展入口

- 注册 `PeekViewProvider` 和 `MapViewProvider` 两个 webview view provider
- 监听编辑器事件（`onDidChangeActiveTextEditor`、`onDidChangeTextEditorSelection`、`onDidChangeTextDocument`）并通知 provider 更新
- 监听主题变更事件，触发重新推送配色
- 注册 `peekView.reveal` 和 `mapView.reveal` 命令

### `constants.ts` — 常量定义

- `LANG_MAP`：VS Code language ID → Prism.js 语言别名映射表（30+ 种语言）
- `PRISM_TO_TEXTMATE`：Prism token class → TextMate scope 映射表，用于从主题中提取高亮颜色

### `types.ts` — 共享类型

- `ContextInfo`：每次更新发送给 Peek View webview 的数据结构
- `TreeNodeData`：Map View 树节点数据
- `TokenColorRule`：主题 tokenColor 规则接口

### `theme.ts` — 主题颜色提取

- `stripJsonComments()` / `parseJsonc()`：去除 JSONC 注释并解析
- `loadThemeTokenColors()`：递归加载主题文件（含 `include` 继承链）
- `resolveActiveThemeTokenColors()`：根据 `workbench.colorTheme` 找到主题扩展并解析
- `findBestSetting()`：TextMate 前缀匹配，为目标 scope 找最佳颜色
- `SYMBOL_KIND_TO_TM`：符号类型（Function/Class/Method…）→ TextMate scope 映射表
- `generateSymbolKindCss()`：生成 `--peek-kind-*` CSS 自定义属性，供 Peek View 和 Map View 的符号徽章使用真实主题颜色
- `generateThemeTokenCss()`：生成 Prism token 的动态 CSS

### `utils.ts` — 工具函数

- `getNonce()`：生成 32 字符随机字符串，用于 webview CSP nonce

### `peekView.ts` — Peek View 面板

`PeekViewProvider` 实现 `WebviewViewProvider`，核心功能：

| 方法 | 说明 |
|------|------|
| `notifyEditorChange()` | 外部调用：记录最后已知编辑器并触发更新 |
| `pushThemeColors()` | 将主题 token CSS 推送到 webview |
| `resolveWebviewView()` | 注册面板、设置消息总线 |
| `update()` | 核心：definition provider → 符号树 → webview |
| `_getContextFromLocation()` | 打开定义文件，解析符号，构造 ContextInfo |
| `_findContext()` | 遍历当前文件 DocumentSymbol 树（fallback） |
| `_deepestContaining()` | 递归树搜索最内层符号 |
| `_resetDedup()` | 清除去重缓存，强制下次刷新 |
| `_getHtml()` | 返回完整的 webview HTML/CSS/JS |

### `mapView.ts` — Map View 面板

`MapViewProvider` 实现 `WebviewViewProvider`，提供符号引用关系分析，并支持树形列表、横向图形、纵向图形三种视图模式：

| 方法 | 说明 |
|------|------|
| `notifyEditorChange()` | 记录最后已知编辑器 |
| `setPeekView(pv)` | 注入 `PeekViewProvider` 引用，用于单击节点时直接更新预览 |
| `_doSearch()` | 按钮触发：分析光标所在符号的引用 |
| `_resolveReferencingSymbols()` | 查找引用并定位其所在的封闭符号，构建引用树 |
| `_expandRef()` | 展开引用节点，递归加载子引用 |
| `_getDocumentSymbols()` | 获取文档符号列表 |
| `_deepestContaining()` | 递归查找最内层包含指定位置的符号 |
| `_getHtml()` | 返回 Map View 的 webview HTML/CSS/JS |

#### Webview 端关键函数（内联 JS）

| 函数 | 说明 |
|------|------|
| `setViewMode(mode)` | 在 `Outline`、`Horiz`、`Vert` 三种视图模式间切换（内部模式值分别为 `'tree'`、`'graph'`、`'graph-up'`） |
| `renderTreeList()` / `renderTreeNodeHtml()` | 渲染树形列表节点（SVG 箭头、类型徽章、名称、位置） |
| `stripParams(name)` | 去除函数参数：`"foo(a, b)"` → `"foo"` |
| `graphBuildFromData(d)` | 从搜索结果构建图形节点/边数据，根符号作为真实节点参与渲染，自动合并同符号的重复引用节点 |
| `mergeItemsBySymbol(items)` | 将多个引用同一封闭符号的 TreeNodeData 合并为单个图形节点，收集所有调用位置（callSites） |
| `graphLayout()` | BFS 层级布局 + 宽度/高度计算（多调用位置节点自动增高）+ 居中定位；`Horiz`/`Vert` 均使用父层顺序的稳定排序避免交叉渲染 |
| `graphDraw()` | Canvas 2D 渲染：Bezier 曲线连边、箭头、圆角矩形节点（统一形状）、彩色字母徽章前缀（如 `f` Function、`m` Method、`C` Class 等，颜色继承自主题 `--peek-kind-*` CSS 变量）、标签；多调用位置节点额外渲染可点击的行号徽章（如 `L10` `L20` `L30`）；展开等待动画沿节点延伸方向显示 |
| `graphHitTest(cx, cy)` | 鼠标坐标命中测试 |
| `graphHitTestCallSite(node, cx, cy)` | 命中测试节点内的调用位置徽章，返回徽章索引 |
| `graphHandleChildren()` | 处理扩展后返回的子节点，更新图形 |
| `graphCollapse(node)` | 递归移除当前图中的后代节点，并保留后代展开状态以便重新展开时恢复 |

#### 消息类型

| 消息类型（Webview→Extension） | 说明 |
|------|------|
| `search` | 触发符号分析 |
| `expandRef` | 展开树/图节点 |
| `jumpTo` | 双击：在编辑器中打开文件并定位（`preserveFocus: false`），同时通过 `peekLocation()` 更新 Peek View |
| `peekOnly` | 单击：调用 `_peekView.peekLocation()` 直接更新 Peek View，不打开编辑器 |
