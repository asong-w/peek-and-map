# 项目结构

```
peek/
├── src/
│   ├── extension.ts          # 扩展入口：activate/deactivate、事件注册
│   ├── constants.ts          # 常量：语言映射表、Prism→TextMate scope 映射表
│   ├── types.ts              # 共享接口：ContextInfo、TreeNodeData、TokenColorRule
│   ├── theme.ts              # 主题颜色提取：JSONC 解析、主题文件加载、CSS 生成
│   ├── viewCommon.ts         # 三视图共享逻辑：主题样式、SymbolKind 名称、emoji 映射
│   ├── utils.ts              # 通用工具函数（getNonce 等）
│   ├── peekView.ts       # PeekViewProvider — 代码预览面板
│   ├── mapView.ts        # MapViewProvider — 引用/调用关系面板
│   └── symbolSearchView.ts # SymbolSearchViewProvider — 工作区符号搜索面板
├── out/                      # 编译产物（自动生成）
│   ├── extension.js
│   ├── constants.js
│   ├── types.js
│   ├── theme.js
│   ├── viewCommon.js
│   ├── utils.js
│   ├── peekView.js
│   ├── mapView.js
│   └── symbolSearchView.js
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

- 注册 `PeekViewProvider`、`MapViewProvider` 和 `SymbolSearchViewProvider` 三个 webview view provider
- 监听编辑器事件（`onDidChangeActiveTextEditor`、`onDidChangeTextEditorSelection`、`onDidChangeTextDocument`）并通知 provider 更新
- 监听主题变更事件，触发重新推送配色
- 注册 `peekView.reveal`、`mapView.reveal` 和 `symbolSearch.reveal` 命令

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
- `generateSymbolKindCss()`：生成 `--peek-kind-*` CSS 自定义属性，供 Peek / Map / Symbol Search 三个视图使用真实主题颜色
- `generateThemeTokenCss()`：生成 Prism token 的动态 CSS

### `viewCommon.ts` — 视图共享逻辑

- `getThemeColorsCss()`：统一拼接 `generateThemeTokenCss() + generateSymbolKindCss()`，供三个视图推送与初始化主题样式
- `symbolKindToName()`：统一 `vscode.SymbolKind -> string` 映射（按字母序维护），避免各视图重复维护
- `buildKindIconFunction()`：统一生成 webview 端 `kind -> emoji` 函数代码（按字母序维护，含 `Global` 扩展类型），确保三个视图图标一致

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

> 说明：Peek View 的符号类型名称映射、顶部 emoji 图标函数与主题样式拼接已复用 `viewCommon.ts`。

### `mapView.ts` — Map View 面板

`MapViewProvider` 实现 `WebviewViewProvider`，提供符号引用关系分析，并支持树形列表与图形两种视图模式（图形支持四个方向）：

| 方法 | 说明 |
|------|------|
| `notifyEditorChange()` | 记录最后已知编辑器 |
| `setPeekView(pv)` | 注入 `PeekViewProvider` 引用，用于点击节点时直接更新预览 |
| `_saveViewState(mode, direction)` | 持久化视图模式与图形方向到 `workspaceState` |
| `pushInteractionConfig()` | 将 Map 图形视图交互配置推送到 webview（滚动/拨动灵敏度 + 单击行为） |
| `_doSearch()` | 按钮触发：分析光标所在符号的引用 |
| `_resolveReferencingSymbols()` | 查找引用并定位其所在的封闭符号，构建引用树；包含路径去重（防止同一路径回环）以及“声明不被其定义回引”过滤规则 |
| `_expandRef()` | 展开引用节点，递归加载子引用 |
| `_getDocumentSymbols()` | 获取文档符号列表 |
| `_deepestContaining()` | 递归查找最内层包含指定位置的符号 |
| `_getHtml()` | 返回 Map View 的 webview HTML/CSS/JS |

> 说明：Map View 的 `SymbolKind` 名称映射、节点 emoji 图标函数与主题样式拼接已复用 `viewCommon.ts`。

#### Webview 端关键函数（内联 JS）

| 函数 | 说明 |
|------|------|
| `setViewState(mode, direction)` | 在 `Outline` / `Graph` 间切换，并设置图形方向（`'up'` / `'down'` / `'left'` / `'right'`） |
| `renderTreeList()` / `renderTreeNodeHtml()` | 渲染树形列表节点（SVG 箭头、类型徽章、名称、位置） |
| `stripParams(name)` | 去除函数参数：`"foo(a, b)"` → `"foo"` |
| `graphBuildFromData(d)` | 从搜索结果构建图形节点/边数据，根符号作为真实节点参与渲染，自动合并同符号的重复引用节点 |
| `mergeItemsBySymbol(items)` | 将多个引用同一封闭符号的 TreeNodeData 合并为单个图形节点，收集所有调用位置（callSites） |
| `graphLayout()` | 递归子树布局 + 宽度/高度计算（多调用位置节点自动增高）；父节点始终位于子节点集合几何中心，并在四方向（`up/down/left/right`）下按“展开反方向”进行同级贴边对齐（非层内居中） |
| `graphDraw()` | Canvas 2D 渲染：Bezier 曲线连边、箭头、节点（普通节点为圆角矩形；函数声明节点为直角梯形，`left` 方向自动镜像）、彩色 Emoji 图标前缀（💿 Function、📀 Method、📱 Class 等，无背景底板，颜色继承自主题 `--peek-kind-*` CSS 变量）、标签；多调用位置节点额外渲染可点击的行号徽章（如 `L10` `L20` `L30`）；展开等待动画沿节点延伸方向显示；节点尝试展开且无子节点时，侧边按钮显示为空心圆 |
| `wheel` 事件处理 | `Ctrl+滚轮` 缩放；普通滚轮上下平移；`Shift+滚轮` 左右平移；鼠标滚轮左右拨动（`deltaX`）左右平移 |
| `graphHitTest(cx, cy)` | 鼠标坐标命中测试 |
| `graphHitTestCallSite(node, cx, cy)` | 命中测试节点内的调用位置徽章，返回徽章索引 |
| `graphHandleChildren()` | 处理扩展后返回的子节点，更新图形 |
| `graphCollapse(node)` | 递归移除当前图中的后代节点，并保留后代展开状态以便重新展开时恢复 |

> 图形文本补充：在垂直方向（`up/down`）下，若节点名为限定名（如 `Class::method`），节点内符号会改为两行渲染：第一行 `Class::`，第二行 `method`。

#### 消息类型

| 消息类型（Webview→Extension） | 说明 |
|------|------|
| `search` | 触发符号分析 |
| `expandRef` | 展开树/图节点 |
| `jumpTo` | 打开编辑器并定位（`preserveFocus: false`），同时通过 `peekLocation()` 更新 Peek View；默认用于双击，也可由 `mapView.singleClickAction` 用于单击 |
| `peekOnly` | 仅调用 `_peekView.peekLocation()` 更新 Peek View，不打开编辑器；默认用于单击 |
| `setViewState` | 保存当前 Map 视图状态（`mode` + `direction`） |

### `symbolSearchView.ts` — Symbol Search 面板

`SymbolSearchViewProvider` 实现 `WebviewViewProvider`，用于工作区符号检索：

| 方法 | 说明 |
|------|------|
| `setPeekView(pv)` | 注入 `PeekViewProvider` 引用，用于结果点击时直接更新 Peek |
| `pushThemeColors()` | 推送主题 token 与符号类型颜色到 webview |
| `pushInteractionConfig()` | 推送 Symbol Search 交互配置（结果单击行为）到 webview |
| `_search()` | 支持多关键字搜索：先以首关键字调用 `vscode.executeWorkspaceSymbolProvider` 获取候选，再按全部关键字（AND）在 `name/container/kind` 上过滤并回传结果 |
| `_splitKeywords()` | 将输入按空白分词并标准化为关键字列表 |
| `_matchesAllKeywords()` | 对候选符号执行“全部关键字都匹配”的过滤逻辑（支持 Exact/Fuzzy） |
| `_peekLocation()` | 仅更新 Peek View，不打开编辑器 |
| `_openLocation()` | 打开符号所在文件并定位到具体行列 |
| `_getHtml()` | 返回搜索框与结果列表的 webview UI，输入实时更新结果；支持单击/双击分流 |

> 说明：Symbol Search 的 `SymbolKind` 名称映射、列表 emoji 图标函数与主题样式拼接已复用 `viewCommon.ts`。

## 关键配置项

- `mapView.wheelPanSensitivity`：Map 图形视图中滚轮滚动平移灵敏度（默认 `1`，用于普通滚轮与 `Shift+滚轮`）
- `mapView.wheelTiltPanSensitivity`：Map 图形视图中鼠标滚轮左右拨动平移灵敏度（默认 `0.28`，用于 `deltaX`）
- `mapView.singleClickAction`：Map 视图单击行为（默认 `peekOnly`；可选 `peekOnly` / `jumpTo`）
- `symbolSearch.singleClickAction`：Symbol Search 结果单击行为（默认 `peekOnly`；可选 `peekOnly` / `jumpTo`）
