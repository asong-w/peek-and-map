import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNodeData } from './types';
import { getNonce } from './utils';
import { PeekViewProvider } from './peekView';
import { generateThemeTokenCss, generateSymbolKindCss } from './theme';

export class MapViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mapView.view';

  private _view?: vscode.WebviewView;
  private _lastKnownEditor?: vscode.TextEditor;

  // Node maps for lazy tree expansion
  private _refNodeMap = new Map<string, { uri: vscode.Uri; position: vscode.Position }>();
  private _nodeCounter = 0;
  private _peekView?: PeekViewProvider;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Provide a reference to the PeekViewProvider so single-click can update it directly. */
  setPeekView(pv: PeekViewProvider): void {
    this._peekView = pv;
  }

  /** Track the active editor (no auto-update). */
  notifyEditorChange(editor: vscode.TextEditor | undefined): void {
    if (editor) {
      this._lastKnownEditor = editor;
    }
  }

  /** Push current theme symbol-kind colors to the webview. */
  pushThemeColors(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({ type: 'themeColors', css: generateThemeTokenCss() + generateSymbolKindCss() });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this.pushThemeColors();
          break;

        case 'search':
          await this._doSearch();
          break;

        case 'expandRef':
          await this._expandRef(msg.nodeId as string);
          break;

        case 'jumpTo': {
          const uri = vscode.Uri.parse(msg.uri as string);
          const pos = new vscode.Position(msg.line as number, msg.character as number);
          // Update peek view immediately (don't wait for cursor-change event)
          this._peekView?.peekLocation(uri, pos);
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const ed  = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          } catch { /* ignore */ }
          break;
        }

        case 'peekOnly': {
          // Single-click: update peek view only, do NOT open/change the editor
          const uri = vscode.Uri.parse(msg.uri as string);
          const pos = new vscode.Position(msg.line as number, msg.character as number);
          await this._peekView?.peekLocation(uri, pos);
          break;
        }
      }
    });
  }

  // ── Node ID allocation ─────────────────────────────────────────────────────

  private _allocRefNodeId(uri: vscode.Uri, position: vscode.Position): string {
    const id = `r${++this._nodeCounter}`;
    this._refNodeMap.set(id, { uri, position });
    return id;
  }

  // ── Search (button-triggered) ──────────────────────────────────────────────

  private async _doSearch(): Promise<void> {
    if (!this._view) { return; }

    const editor = vscode.window.activeTextEditor ?? this._lastKnownEditor;
    if (!editor) {
      this._sendEmpty('No active editor');
      return;
    }

    const doc = editor.document;
    const cursor = editor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(cursor);
    if (!wordRange) {
      this._sendEmpty('Cursor is not on a symbol');
      return;
    }
    const word = doc.getText(wordRange);
    const queryPos = wordRange.start;

    // Clear maps for new search
    this._refNodeMap.clear();
    this._nodeCounter = 0;

    // Show loading state
    this._view.webview.postMessage({ type: 'loading', symbolName: word });

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    // ── References hierarchy (first level) ─────────────────────────────────
    const refNodes = await this._resolveReferencingSymbols(doc.uri, queryPos, wsRoot);

    // Determine symbol kind for display
    let rootKind = '';
    try {
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy', doc.uri, queryPos
      );
      if (items && items.length > 0) {
        rootKind = this._symbolKindName(items[0].kind);
      }
    } catch { /* no call hierarchy provider */ }

    // Resolve current symbol + optional owning class for root label
    let rootLabel = word;
    try {
      const symbols = await this._getDocumentSymbols(doc.uri);
      const found = this._deepestContainingWithAncestors(symbols, queryPos);
      if (found) {
        const ownerClass =
          this._nearestOwnerClassName(found.ancestors) ??
          this._inferCppOwnerClass(found.symbol.name, doc.lineAt(found.symbol.selectionRange.start.line).text, doc.languageId);
        rootLabel = this._formatLabelWithOwner(found.symbol.name, ownerClass, found.symbol.kind);
      }
    } catch {
      // keep fallback word
    }

    this._view.webview.postMessage({
      type: 'update',
      data: {
        rootNode: {
          nodeId: '__root__',
          label: rootLabel,
          detail: this._relativePath(doc.uri.fsPath, wsRoot),
          line: queryPos.line,
          character: queryPos.character,
          callLine: queryPos.line,
          callCharacter: queryPos.character,
          uri: doc.uri.toString(),
          kind: rootKind || 'Function',
          preview: doc.lineAt(queryPos.line).text.trim(),
        },
        symbolName: word,
        symbolKind: rootKind,
        fileName: path.basename(doc.uri.fsPath),
        refNodes,
      },
    });
  }

  // ── Resolve referencing symbols (for tree expansion) ───────────────────────
  //
  // Given a symbol at (uri, pos), find all references to it, then for each
  // reference determine its enclosing symbol (the function/class that contains
  // the reference).  Return a deduplicated list of those enclosing symbols as
  // tree nodes.  Each node stores the enclosing symbol's name position so it
  // can be expanded recursively to find "who references this enclosing symbol".

  private async _resolveReferencingSymbols(
    uri: vscode.Uri,
    pos: vscode.Position,
    wsRoot: string
  ): Promise<TreeNodeData[]> {
    let locs: vscode.Location[] | undefined;
    try {
      locs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, pos
      );
    } catch { /* no reference provider */ }
    if (!locs || locs.length === 0) { return []; }

    const result: TreeNodeData[] = [];
    // Tracks which enclosing symbols have already received an expandable nodeId
    const firstSeenKeys = new Set<string>();

    for (const loc of locs) {
      let refDoc: vscode.TextDocument;
      try {
        refDoc = await vscode.workspace.openTextDocument(loc.uri);
      } catch { continue; }

      const symbols = await this._getDocumentSymbols(loc.uri);
      const enclosing = this._deepestContaining(symbols, loc.range.start);

      if (!enclosing) {
        // Reference at file/global scope — always show as leaf node (not expandable)
        result.push({
          nodeId: `leaf_${++this._nodeCounter}`,
          label: path.basename(loc.uri.fsPath) + ' (global)',
          detail: this._relativePath(loc.uri.fsPath, wsRoot),
          line: loc.range.start.line,
          character: loc.range.start.character,
          callLine: loc.range.start.line,
          callCharacter: loc.range.start.character,
          uri: loc.uri.toString(),
          kind: 'Global',
          preview: refDoc.lineAt(loc.range.start.line).text.trim(),
        });
        continue;
      }

      // Skip self-reference: enclosing symbol IS the queried symbol itself
      const symStart = enclosing.selectionRange.start;
      if (
        loc.uri.toString() === uri.toString() &&
        symStart.line === pos.line &&
        symStart.character === pos.character
      ) {
        continue;
      }

      // First occurrence of this enclosing symbol → expandable; subsequent → leaf
      const symKey = loc.uri.toString() + '#sym:' + symStart.line + ':' + symStart.character;
      const isFirst = !firstSeenKeys.has(symKey);
      if (isFirst) { firstSeenKeys.add(symKey); }

      const nodeId = isFirst
        ? this._allocRefNodeId(loc.uri, symStart)
        : `leaf_${++this._nodeCounter}`;

      const found =
        this._findBySelectionStartWithAncestors(symbols, symStart) ??
        this._deepestContainingWithAncestors(symbols, loc.range.start);
      const ownerClass = found
        ? (
          this._nearestOwnerClassName(found.ancestors) ??
          this._inferCppOwnerClass(enclosing.name, refDoc.lineAt(symStart.line).text, refDoc.languageId)
        )
        : this._inferCppOwnerClass(enclosing.name, refDoc.lineAt(symStart.line).text, refDoc.languageId);

      result.push({
        nodeId,
        label: this._formatLabelWithOwner(enclosing.name, ownerClass, enclosing.kind),
        detail: this._relativePath(loc.uri.fsPath, wsRoot),
        line: symStart.line,
        character: symStart.character,
        callLine: loc.range.start.line,
        callCharacter: loc.range.start.character,
        uri: loc.uri.toString(),
        kind: this._symbolKindName(enclosing.kind),
        preview: refDoc.lineAt(symStart.line).text.trim(),
      });
    }

    return result;
  }

  // ── Expand: Reference hierarchy ────────────────────────────────────────────

  private async _expandRef(nodeId: string): Promise<void> {
    if (!this._view) { return; }
    const info = this._refNodeMap.get(nodeId);
    if (!info) {
      this._view.webview.postMessage({ type: 'children', parentNodeId: nodeId, items: [] });
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const children = await this._resolveReferencingSymbols(info.uri, info.position, wsRoot);
    this._view.webview.postMessage({ type: 'children', parentNodeId: nodeId, items: children });
  }

  // ── Symbol helpers ─────────────────────────────────────────────────────────

  private async _getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    try {
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
      );
      return result ?? [];
    } catch {
      return [];
    }
  }

  /** Recursively find the innermost symbol whose range contains `pos`. */
  private _deepestContaining(
    symbols: vscode.DocumentSymbol[],
    pos: vscode.Position
  ): vscode.DocumentSymbol | undefined {
    let best: vscode.DocumentSymbol | undefined;
    for (const sym of symbols) {
      if (sym.range.contains(pos)) {
        const child = this._deepestContaining(sym.children, pos);
        const candidate = child ?? sym;
        if (!best || this._rangeSize(candidate.range) < this._rangeSize(best.range)) {
          best = candidate;
        }
      }
    }
    return best;
  }

  private _deepestContainingWithAncestors(
    symbols: vscode.DocumentSymbol[],
    pos: vscode.Position,
    ancestors: vscode.DocumentSymbol[] = []
  ): { symbol: vscode.DocumentSymbol; ancestors: vscode.DocumentSymbol[] } | undefined {
    let best: { symbol: vscode.DocumentSymbol; ancestors: vscode.DocumentSymbol[] } | undefined;
    for (const sym of symbols) {
      if (!sym.range.contains(pos)) { continue; }
      const nextAncestors = [...ancestors, sym];
      const child = this._deepestContainingWithAncestors(sym.children, pos, nextAncestors);
      const candidate = child ?? { symbol: sym, ancestors: nextAncestors };
      if (!best || this._rangeSize(candidate.symbol.range) < this._rangeSize(best.symbol.range)) {
        best = candidate;
      }
    }
    return best;
  }

  private _findBySelectionStartWithAncestors(
    symbols: vscode.DocumentSymbol[],
    selectionStart: vscode.Position,
    ancestors: vscode.DocumentSymbol[] = []
  ): { symbol: vscode.DocumentSymbol; ancestors: vscode.DocumentSymbol[] } | undefined {
    for (const sym of symbols) {
      const nextAncestors = [...ancestors, sym];
      if (
        sym.selectionRange.start.line === selectionStart.line &&
        sym.selectionRange.start.character === selectionStart.character
      ) {
        return { symbol: sym, ancestors: nextAncestors };
      }
      const child = this._findBySelectionStartWithAncestors(sym.children, selectionStart, nextAncestors);
      if (child) { return child; }
    }
    return undefined;
  }

  private _nearestOwnerClassName(ancestors: vscode.DocumentSymbol[]): string | undefined {
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const k = ancestors[i].kind;
      if (k === vscode.SymbolKind.Class || k === vscode.SymbolKind.Struct || k === vscode.SymbolKind.Interface) {
        return ancestors[i].name;
      }
    }
    return undefined;
  }

  private _inferCppOwnerClass(name: string, lineText: string, languageId: string): string | undefined {
    if (!this._isCppLanguage(languageId)) { return undefined; }

    const fromName = this._ownerFromQualifiedName(name);
    if (fromName) { return fromName; }

    const simpleName = this._simpleSymbolName(name);
    const m = lineText.match(/([~A-Za-z_][\w:]*)\s*::\s*([~A-Za-z_]\w*)\s*\(/);
    if (!m) { return undefined; }
    const methodName = m[2];
    if (!simpleName || methodName === simpleName || methodName === `~${simpleName}`) {
      return m[1];
    }
    return undefined;
  }

  private _isCppLanguage(languageId: string): boolean {
    return languageId === 'cpp' || languageId === 'c' || languageId === 'cuda-cpp' || languageId === 'objective-cpp';
  }

  private _ownerFromQualifiedName(name: string): string | undefined {
    const noParams = name.replace(/\(.*$/, '').trim();
    const idx = noParams.lastIndexOf('::');
    if (idx <= 0) { return undefined; }
    return noParams.slice(0, idx).trim() || undefined;
  }

  private _simpleSymbolName(name: string): string {
    const noParams = name.replace(/\(.*$/, '').trim();
    const idx = noParams.lastIndexOf('::');
    return idx >= 0 ? noParams.slice(idx + 2) : noParams;
  }

  private _formatLabelWithOwner(name: string, ownerClass: string | undefined, _kind: vscode.SymbolKind): string {
    if (!ownerClass) { return name; }
    return `${ownerClass}::${name}`;
  }

  private _rangeSize(r: vscode.Range): number {
    return (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
  }

  // ── Generic helpers ────────────────────────────────────────────────────────

  private _relativePath(fsPath: string, wsRoot: string): string {
    if (wsRoot && fsPath.startsWith(wsRoot)) {
      return fsPath.slice(wsRoot.length + 1).replace(/\\/g, '/');
    }
    return path.basename(fsPath);
  }

  private _symbolKindName(kind: vscode.SymbolKind): string {
    const names: Partial<Record<vscode.SymbolKind, string>> = {
      [vscode.SymbolKind.File]: 'File',
      [vscode.SymbolKind.Module]: 'Module',
      [vscode.SymbolKind.Namespace]: 'Namespace',
      [vscode.SymbolKind.Class]: 'Class',
      [vscode.SymbolKind.Method]: 'Method',
      [vscode.SymbolKind.Property]: 'Property',
      [vscode.SymbolKind.Field]: 'Field',
      [vscode.SymbolKind.Constructor]: 'Ctor',
      [vscode.SymbolKind.Enum]: 'Enum',
      [vscode.SymbolKind.Interface]: 'Interface',
      [vscode.SymbolKind.Function]: 'Function',
      [vscode.SymbolKind.Variable]: 'Variable',
      [vscode.SymbolKind.Constant]: 'Constant',
      [vscode.SymbolKind.Struct]: 'Struct',
    };
    return names[kind] ?? 'Symbol';
  }

  private _sendEmpty(msg: string): void {
    this._view?.webview.postMessage({ type: 'empty', message: msg });
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src 'unsafe-inline' ${webview.cspSource};
                 script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      background: var(--vscode-panel-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header ─────────────────────────────────────────────────── */
    #header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      min-height: 28px;
      user-select: none;
    }
    #search-btn {
      cursor: pointer;
      padding: 2px 8px;
      font-size: 12px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 3px;
      flex-shrink: 0;
      transition: background 0.15s;
      line-height: 1.4;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    #search-btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    #search-btn .btn-icon {
      font-size: 14px;
      line-height: 1;
    }
    #view-tabs {
      display: inline-flex;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .view-tab {
      cursor: pointer;
      padding: 2px 10px;
      font-size: 12px;
      line-height: 1.4;
      border: none;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      color: var(--vscode-foreground, #d4d4d4);
      border-right: 1px solid var(--vscode-panel-border, #333);
    }
    .view-tab:last-child {
      border-right: none;
    }
    .view-tab.active {
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      color: var(--vscode-tab-activeForeground, #fff);
    }
    #header-spacer { flex: 1; }

    /* ── Content ────────────────────────────────────────────────── */
    #empty-msg {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-disabledForeground, #858585);
      font-size: 12px;
      font-style: italic;
    }

    #content {
      flex: 1;
      overflow: auto;
    }

    .section { display: none; }
    .section.active { display: block; }

    /* ── Tree items ─────────────────────────────────────────────── */
    .tree-node { /* container for row + children */ }
    .tree-row {
      display: flex;
      align-items: center;
      padding: 2px 0;
      cursor: pointer;
      transition: background 0.1s;
      white-space: nowrap;
      overflow: hidden;
    }
    .tree-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
    }
    .tree-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      color: var(--vscode-foreground, #ccc);
      user-select: none;
    }
    .tree-toggle svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .tree-toggle.loading svg {
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .item-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family, monospace);
      flex-shrink: 0;
      line-height: 1;
    }
    .tree-row .item-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .col-name {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      overflow: hidden;
    }
    .col-file {
      width: 140px;
      flex-shrink: 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #858585);
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 8px;
    }
    .col-line {
      width: 50px;
      flex-shrink: 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #858585);
      text-align: right;
      padding-right: 8px;
    }
    .table-header {
      display: flex;
      padding: 3px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, #858585);
      position: sticky;
      top: 0;
      background: var(--vscode-panel-background, #1e1e1e);
      z-index: 1;
      user-select: none;
    }
    .table-header .col-name { padding-left: 28px; }
    .tree-children { /* nested children container */ }

    /* ── Leaf (non-expandable) tree items ────────────────────────── */
    .tree-node[data-leaf="1"] .tree-toggle {
      visibility: hidden;
    }

    /* ── Empty section placeholder ──────────────────────────────── */
    .section-empty {
      padding: 20px;
      text-align: center;
      color: var(--vscode-disabledForeground, #858585);
      font-size: 12px;
      font-style: italic;
    }

    /* ── Graph view ─────────────────────────────────────────────── */
    #graph-container {
      position: relative;
      flex: 1;
      overflow: hidden;
      display: none;
    }
    #graph-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    #graph-hint {
      position: absolute;
      bottom: 6px;
      right: 10px;
      font-size: 10px;
      color: var(--vscode-disabledForeground, #666);
      pointer-events: none;
      user-select: none;
    }
  </style>
  <!-- Dynamic theme symbol-kind colors (updated via postMessage on theme change) -->
  <style id="theme-tokens">${generateThemeTokenCss() + generateSymbolKindCss()}</style>
</head>
<body>
  <div id="header">
    <button id="search-btn" title="Analyze symbol at cursor"><span class="btn-icon">🔍</span> Analysis</button>
    <div id="view-tabs" role="tablist" aria-label="Map View Mode">
      <button id="view-tab-tree" class="view-tab active" role="tab" aria-selected="true" title="Outline view">Outline</button>
      <button id="view-tab-graph" class="view-tab" role="tab" aria-selected="false" title="Horizontal graph view">Horiz</button>
      <button id="view-tab-graph-up" class="view-tab" role="tab" aria-selected="false" title="Vertical graph view">Vert</button>
    </div>
    <span id="header-spacer"></span>
  </div>
  <div id="empty-msg">Place cursor on a symbol, then click "Analysis"</div>
  <div id="content" style="display:none">
    <div class="table-header">
      <div class="col-name">Symbol</div>
      <div class="col-file">File</div>
      <div class="col-line">Line</div>
    </div>
    <div class="section active" id="sec-references"></div>
  </div>
  <div id="graph-container">
    <canvas id="graph-canvas"></canvas>
    <div id="graph-hint">Click = peek · Double-click = open &amp; peek · Ctrl+click = expand/collapse · Scroll = zoom · Drag = pan</div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'ready' });

    const emptyMsg     = document.getElementById('empty-msg');
    const content      = document.getElementById('content');
    const searchBtn    = document.getElementById('search-btn');
    const viewTabTree  = document.getElementById('view-tab-tree');
    const viewTabGraph = document.getElementById('view-tab-graph');
    const viewTabGraphUp = document.getElementById('view-tab-graph-up');
    const graphContainer = document.getElementById('graph-container');
    const graphCanvas   = document.getElementById('graph-canvas');
    const refSection    = document.getElementById('sec-references');

    const loadedNodes = new Set();
    const nodeChildrenCache = new Map();  // nodeId → children items[]
    const expandedNodeIds = new Set();    // nodeIds currently expanded

    // ── View mode: 'tree' | 'graph' | 'graph-up' ─────────────────────────
    let viewMode = 'tree';
    let graphDirection = 'right'; // 'right' | 'up'
    // Store last update data for graph rendering
    let lastUpdateData = null;

    function updateViewTabs() {
      const treeActive = viewMode === 'tree';
      const graphActive = viewMode === 'graph';
      const graphUpActive = viewMode === 'graph-up';
      viewTabTree.classList.toggle('active', treeActive);
      viewTabGraph.classList.toggle('active', graphActive);
      viewTabGraphUp.classList.toggle('active', graphUpActive);
      viewTabTree.setAttribute('aria-selected', treeActive ? 'true' : 'false');
      viewTabGraph.setAttribute('aria-selected', graphActive ? 'true' : 'false');
      viewTabGraphUp.setAttribute('aria-selected', graphUpActive ? 'true' : 'false');
    }

    function isGraphMode(mode) {
      return mode === 'graph' || mode === 'graph-up';
    }

    function setViewMode(mode) {
      viewMode = mode;
      graphDirection = mode === 'graph-up' ? 'up' : 'right';
      updateViewTabs();
      if (isGraphMode(mode)) {
        content.style.display = 'none';
        graphContainer.style.display = 'block';
        if (lastUpdateData) {
          graphBuildFromData(lastUpdateData);
          restoreGraphExpansions();
          graphLayout();
          graphDraw();
        }
      } else {
        graphContainer.style.display = 'none';
        if (lastUpdateData) {
          const rootNode = lastUpdateData.rootNode || null;
          content.style.display = 'block';
          renderTreeList(refSection, rootNode ? [rootNode] : (lastUpdateData.refNodes || []), 0);
          restoreTreeExpansions(refSection);
        }
      }
    }

    viewTabTree.addEventListener('click', () => setViewMode('tree'));
    viewTabGraph.addEventListener('click', () => setViewMode('graph'));
    viewTabGraphUp.addEventListener('click', () => setViewMode('graph-up'));

    // ── Search button ────────────────────────────────────────────────────
    searchBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'search' });
    });

    // ── Messages from extension ──────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'empty') {
        emptyMsg.textContent   = msg.message;
        emptyMsg.style.display = 'flex';
        content.style.display  = 'none';
        graphContainer.style.display = 'none';
        lastUpdateData = null;
        return;
      }

      if (msg.type === 'loading') {
        emptyMsg.textContent   = 'Analyzing ' + msg.symbolName + ' ...';
        emptyMsg.style.display = 'flex';
        content.style.display  = 'none';
        graphContainer.style.display = 'none';
        return;
      }

      if (msg.type === 'themeColors') {
        document.getElementById('theme-tokens').textContent = msg.css;
        // Redraw graph in case it's visible, so node border colors update
        if (isGraphMode(viewMode) && lastUpdateData) { graphDraw(); }
        return;
      }

      if (msg.type === 'update') {
        loadedNodes.clear();
        nodeChildrenCache.clear();
        expandedNodeIds.clear();
        const d = msg.data;
        const rootNode = d.rootNode || null;
        lastUpdateData = d;
        emptyMsg.style.display   = 'none';

        if (rootNode) {
          loadedNodes.add(rootNode.nodeId);
          nodeChildrenCache.set(rootNode.nodeId, d.refNodes || []);
          expandedNodeIds.add(rootNode.nodeId);
        }

        // Tree view (root node included)
        renderTreeList(refSection, rootNode ? [rootNode] : (d.refNodes || []), 0);
        if (rootNode) {
          restoreTreeExpansions(refSection);
        }

        if (viewMode === 'tree') {
          content.style.display = 'block';
          graphContainer.style.display = 'none';
        } else {
          content.style.display = 'none';
          graphContainer.style.display = 'block';
          graphBuildFromData(d);
        }
        return;
      }

      // Children for a tree node (incremental expansion)
      if (msg.type === 'children') {
        const parentNodeId = msg.parentNodeId;
        loadedNodes.add(parentNodeId);
        nodeChildrenCache.set(parentNodeId, msg.items || []);
        expandedNodeIds.add(parentNodeId);

        // ── Graph expand ──────────────────────────────────────────
        if (isGraphMode(viewMode)) {
          graphHandleChildren(parentNodeId, msg.items || []);
          return;
        }

        // ── Tree expand ───────────────────────────────────────────
        const nodeEl = document.querySelector('[data-node-id="' + parentNodeId + '"]');
        if (!nodeEl) return;
        const toggleEl = nodeEl.querySelector(':scope > .tree-row .tree-toggle');
        const childrenEl = nodeEl.querySelector(':scope > .tree-children');

        if (!msg.items || msg.items.length === 0) {
          toggleEl.innerHTML = '';
          toggleEl.classList.remove('loading');
          childrenEl.style.display = 'none';
          return;
        }

        const depth = parseInt(nodeEl.dataset.depth || '0', 10) + 1;
        toggleEl.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="2,6 8,12 14,6"/></svg>';
        toggleEl.classList.remove('loading');
        childrenEl.style.display = 'block';
        childrenEl.innerHTML = msg.items.map(function(item) {
          return renderTreeNodeHtml(item, depth);
        }).join('');
        return;
      }
    });

    // ── Render helpers ───────────────────────────────────────────────────
    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escapeAttr(s) {
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    /** Strip function parameters: "foo(a, b)" → "foo" */
    function stripParams(name) {
      const idx = name.indexOf('(');
      return idx > 0 ? name.substring(0, idx) : name;
    }

    function splitQualifiedName(name) {
      const clean = stripParams(name || '');
      const idx = clean.lastIndexOf('::');
      if (idx <= 0 || idx + 2 >= clean.length) return null;
      return {
        owner: clean.slice(0, idx),
        member: clean.slice(idx + 2),
      };
    }

    function renderQualifiedNameHtml(name, memberKind) {
      const part = splitQualifiedName(name);
      const kindKey = memberKind === 'Ctor' ? 'Constructor' : (memberKind || 'Function');
      const memberColor = 'var(--peek-kind-' + kindKey + ',var(--vscode-symbolIcon-functionForeground,#dcdcaa))';
      if (!part) {
        return '<span style="color:' + memberColor + '">' + escapeHtml(stripParams(name || '')) + '</span>';
      }
      const ownerColor = 'var(--peek-qualified-owner,var(--peek-kind-Class,var(--vscode-symbolIcon-classForeground,var(--vscode-editor-foreground,#d4d4d4))))';
      const sepColor = 'var(--peek-operator,var(--vscode-editor-foreground,#d4d4d4))';
      return '<span style="color:' + ownerColor + '">' + escapeHtml(part.owner) + '</span>'
        + '<span style="color:' + sepColor + '">::</span>'
        + '<span style="color:' + memberColor + '">' + escapeHtml(part.member) + '</span>';
    }

    function renderTreeList(container, items, depth) {
      if (!items || items.length === 0) {
        container.innerHTML = '<div class="section-empty">No results</div>';
        return;
      }
      container.innerHTML = items.map(function(item) {
        return renderTreeNodeHtml(item, depth);
      }).join('');
    }

    function renderTreeNodeHtml(item, depth) {
      const pad = depth * 16;
      const isLeaf = item.nodeId.startsWith('leaf_');
      const nameHtml = renderQualifiedNameHtml(item.label, item.kind || 'Function');
      const kindHtml = item.kind
        ? '<span class="item-icon" style="color:var(--peek-kind-' + (item.kind === 'Ctor' ? 'Constructor' : item.kind) + ',var(--vscode-foreground,#ccc));background-color:color-mix(in srgb,var(--peek-kind-' + (item.kind === 'Ctor' ? 'Constructor' : item.kind) + ',transparent) 18%,transparent)">' + kindSymbol(item.kind) + '</span>'
        : '';
      const toggleChar = isLeaf ? '' : '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>';
      const callLine = item.callLine != null ? item.callLine : item.line;
      const callChar = item.callCharacter != null ? item.callCharacter : item.character;
      return '<div class="tree-node" data-node-id="' + escapeAttr(item.nodeId) + '" data-depth="' + depth + '"'
        + (isLeaf ? ' data-leaf="1"' : '') + '>'
        + '<div class="tree-row"'
        + ' data-uri="' + escapeAttr(item.uri) + '"'
        + ' data-line="' + item.line + '" data-char="' + item.character + '"'
        + ' data-call-line="' + callLine + '" data-call-char="' + callChar + '">'
        + '<div class="col-name" style="padding-left:' + (pad + 4) + 'px">'
        + '<span class="tree-toggle">' + toggleChar + '</span>'
        + kindHtml
        + '<span class="item-name">' + nameHtml + '</span>'
        + '</div>'
        + '<div class="col-file" title="' + escapeAttr(item.detail) + '">' + escapeHtml(item.detail) + '</div>'
        + '<div class="col-line">' + (callLine + 1) + '</div>'
        + '</div>'
        + '<div class="tree-children" style="display:none"></div>'
        + '</div>';
    }

    // ── Restore expansion state helpers ──────────────────────────────────

    /** Recursively restore tree node expansions from shared state */
    function restoreTreeExpansions(containerEl) {
      const treeNodes = containerEl.querySelectorAll(':scope > .tree-node');
      for (const nodeEl of treeNodes) {
        const nodeId = nodeEl.dataset.nodeId;
        if (expandedNodeIds.has(nodeId) && nodeChildrenCache.has(nodeId)) {
          const items = nodeChildrenCache.get(nodeId);
          if (!items || items.length === 0) continue;
          const depth = parseInt(nodeEl.dataset.depth || '0', 10) + 1;
          const toggleEl = nodeEl.querySelector(':scope > .tree-row .tree-toggle');
          const childrenEl = nodeEl.querySelector(':scope > .tree-children');
          toggleEl.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="2,6 8,12 14,6"/></svg>';
          childrenEl.style.display = 'block';
          childrenEl.innerHTML = items.map(function(item) {
            return renderTreeNodeHtml(item, depth);
          }).join('');
          loadedNodes.add(nodeId);
          // Recurse into children
          restoreTreeExpansions(childrenEl);
        }
      }
    }

    /** Recursively restore graph node expansions from shared state */
    function restoreGraphExpansions() {
      let changed = true;
      while (changed) {
        changed = false;
        const nodeMap = {};
        for (const n of gNodes) nodeMap[n.id] = n;
        for (const n of [...gNodes]) {
          if (!n.expanded && expandedNodeIds.has(n.id) && nodeChildrenCache.has(n.id)) {
            const items = nodeChildrenCache.get(n.id);
            if (!items || items.length === 0) continue;
            n.expanded = true;
            loadedNodes.add(n.id);
            const merged = mergeItemsBySymbol(items);
            for (const mg of merged) {
              const item = mg.primary;
              const nid = item.nodeId;
              if (nodeMap[nid]) continue;
              const newNode = {
                id: nid,
                label: item.label,
                kind: item.kind || '',
                x: 0, y: 0, w: 0, h: G_NODE_H,
                children: [],
                expanded: false,
                loading: false,
                data: item,
                parentId: n.id,
                callSites: mg.callSites,
                _callBadgeRects: [],
              };
              gNodes.push(newNode);
              nodeMap[newNode.id] = newNode;
              n.children.push(nid);
              gEdges.push({ from: n.id, to: nid });
            }
            changed = true;
          }
        }
      }
    }

    // ── Click handlers (tree view) ───────────────────────────────────────
    content.addEventListener('click', (e) => {
      const toggle = e.target.closest('.tree-toggle');
      if (toggle) {
        e.stopPropagation();
        const nodeEl = toggle.closest('.tree-node');
        if (!nodeEl) return;
        if (nodeEl.dataset.leaf === '1') return;
        const nodeId = nodeEl.dataset.nodeId;
        const childrenEl = nodeEl.querySelector(':scope > .tree-children');

        if (loadedNodes.has(nodeId)) {
          const isVisible = childrenEl.style.display !== 'none';
          childrenEl.style.display = isVisible ? 'none' : 'block';
          toggle.innerHTML = isVisible
            ? '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>'
            : '<svg viewBox="0 0 16 16"><polyline points="2,6 8,12 14,6"/></svg>';
          if (isVisible) {
            expandedNodeIds.delete(nodeId);
          } else {
            expandedNodeIds.add(nodeId);
          }
        } else {
          toggle.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>';
          toggle.classList.add('loading');
          vscodeApi.postMessage({ type: 'expandRef', nodeId: nodeId });
        }
        return;
      }

      const treeRow = e.target.closest('.tree-row');
      if (treeRow && !e.target.closest('.tree-toggle')) {
        if (e.detail === 1) {
          vscodeApi.postMessage({
            type: 'peekOnly',
            uri: treeRow.dataset.uri,
            line: parseInt(treeRow.dataset.callLine, 10),
            character: parseInt(treeRow.dataset.callChar, 10),
          });
        }
        return;
      }
    });

    // Double-click on tree row: open in editor AND update peek view
    content.addEventListener('dblclick', (e) => {
      const treeRow = e.target.closest('.tree-row');
      if (treeRow && !e.target.closest('.tree-toggle')) {
        vscodeApi.postMessage({
          type: 'jumpTo',
          uri: treeRow.dataset.uri,
          line: parseInt(treeRow.dataset.callLine, 10),
          character: parseInt(treeRow.dataset.callChar, 10),
        });
      }
    });

    // ══════════════════════════════════════════════════════════════════════
    // ── Graph View (Canvas-based) ────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════

    const ctx = graphCanvas.getContext('2d');
    let gNodes = [];   // {id, label, kind, x, y, w, h, children:[], expanded, loading, data, parentId, callSites:[], _callBadgeRects:[]}
    let gEdges = [];   // {from, to}
    let gPan = {x: 0, y: 0};
    let gZoom = 1;
    let gDragging = false;
    let gDragStart = {x: 0, y: 0};
    let gHover = null;
    let gHoverCallSite = -1;  // index of hovered call-site badge (-1 = none)
    let gPendingExpand = null; // nodeId waiting for children
    let gAnimFrame = null;

    const G_NODE_H = 32;
    const G_CALL_ROW_H = 16;  // extra height per call-site badge row
    const G_CALLS_PER_ROW = 5;
    const G_PAD_X = 12;
    const G_PAD_Y = 4;
    const G_LEVEL_GAP_X = 60;
    const G_LEVEL_GAP_Y = 56;
    const G_SIBLING_GAP_Y = 10;
    const G_SIBLING_GAP_X = 10;

    /**
     * Merge tree-node items that refer to the same enclosing symbol into a
     * single entry with multiple call-sites.  Returns an array of
     * { primary: TreeNodeData, callSites: [{callLine, callCharacter, uri}] }.
     */
    function mergeItemsBySymbol(items) {
      if (!items || items.length === 0) return [];
      const groups = new Map(); // key -> { items[], expandableItem }
      const order = [];         // preserve first-seen order of keys
      for (const item of items) {
        const key = item.uri + '#' + item.line + ':' + item.character;
        if (!groups.has(key)) {
          groups.set(key, { items: [], expandableItem: null });
          order.push(key);
        }
        const g = groups.get(key);
        g.items.push(item);
        if (!item.nodeId.startsWith('leaf_') && !g.expandableItem) {
          g.expandableItem = item;
        }
      }
      return order.map(key => {
        const g = groups.get(key);
        const primary = g.expandableItem || g.items[0];
        const callSites = g.items.map(it => ({
          callLine: it.callLine != null ? it.callLine : it.line,
          callCharacter: it.callCharacter != null ? it.callCharacter : it.character,
          uri: it.uri,
        }));
        callSites.sort((a, b) => a.callLine - b.callLine);
        return { primary, callSites };
      });
    }

    function graphBuildFromData(d) {
      gNodes = [];
      gEdges = [];
      gPan = {x: 0, y: 0};
      gZoom = 1;
      gPendingExpand = null;

      // Root node (the queried symbol)
      const rootId = d.rootNode?.nodeId || '__root__';
      gNodes.push({
        id: rootId,
        label: d.rootNode?.label || d.symbolName,
        kind: d.rootNode?.kind || 'Function',
        x: 0, y: 0, w: 0, h: G_NODE_H,
        children: [],
        expanded: true,
        loading: false,
        data: d.rootNode || null,
        parentId: null,
        callSites: null,
        _callBadgeRects: [],
      });

      // Combine refNodes as first-level children (merge duplicates)
      const merged = mergeItemsBySymbol(d.refNodes || []);
      for (const mg of merged) {
        const item = mg.primary;
        const nid = item.nodeId;
        gNodes.push({
          id: nid,
          label: item.label,
          kind: item.kind || '',
          x: 0, y: 0, w: 0, h: G_NODE_H,
          children: [],
          expanded: false,
          loading: false,
          data: item,
          parentId: rootId,
          callSites: mg.callSites,
          _callBadgeRects: [],
        });
        gNodes[0].children.push(nid);
        gEdges.push({ from: rootId, to: nid });
      }

      graphLayout();
      graphDraw();
    }

    /* Measure text width */
    function gTextWidth(text, font) {
      ctx.font = font;
      return ctx.measureText(text).width;
    }

    /* Return prefix symbol for a kind */
    function nodeKindPrefix(kind) {
      const prefixes = {
        'Function':  'f',
        'Method':    'm',
        'Class':     'C',
        'Interface': 'I',
        'Variable':  'v',
        'Constant':  'c',
        'Property':  'p',
        'Field':     'F',
        'Enum':      'E',
        'Module':    'M',
        'Namespace': 'N',
        'Struct':    'S',
        'Ctor':      'K',
        'Global':    'G',
        'Root':      'R',
      };
      return prefixes[kind] || '?';
    }

    /* Return symbol for a kind (used in tree view) */
    function kindSymbol(kind) {
      return nodeKindPrefix(kind);
    }

    /* Parse common CSS color formats into numeric RGBA */
    function parseCssColor(colorText) {
      const t = (colorText || '').trim();
      if (!t) return null;

      // #RGB / #RGBA / #RRGGBB / #RRGGBBAA
      if (t[0] === '#') {
        const h = t.slice(1);
        if (h.length === 3 || h.length === 4) {
          const r = parseInt(h[0] + h[0], 16);
          const g = parseInt(h[1] + h[1], 16);
          const b = parseInt(h[2] + h[2], 16);
          const a = h.length === 4 ? (parseInt(h[3] + h[3], 16) / 255) : 1;
          if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
          return { r, g, b, a };
        }
        if (h.length === 6 || h.length === 8) {
          const r = parseInt(h.slice(0, 2), 16);
          const g = parseInt(h.slice(2, 4), 16);
          const b = parseInt(h.slice(4, 6), 16);
          const a = h.length === 8 ? (parseInt(h.slice(6, 8), 16) / 255) : 1;
          if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
          return { r, g, b, a };
        }
      }

      // rgb(...) / rgba(...)
      const m = t.match(/^rgba?\(([^)]+)\)$/i);
      if (m) {
        const parts = m[1].split(',').map(p => p.trim());
        if (parts.length === 3 || parts.length === 4) {
          const r = Number(parts[0]);
          const g = Number(parts[1]);
          const b = Number(parts[2]);
          const a = parts.length === 4 ? Number(parts[3]) : 1;
          if ([r, g, b, a].some(v => Number.isNaN(v))) return null;
          return {
            r: Math.max(0, Math.min(255, r)),
            g: Math.max(0, Math.min(255, g)),
            b: Math.max(0, Math.min(255, b)),
            a: Math.max(0, Math.min(1, a)),
          };
        }
      }

      return null;
    }

    function colorToRgba(colorText, alpha) {
      const c = parseCssColor(colorText);
      if (!c) { return 'rgba(128,128,128,' + alpha + ')'; }
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    }

    function srgbToLinear(v) {
      const x = v / 255;
      return x <= 0.03928 ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(colorText) {
      const c = parseCssColor(colorText);
      if (!c) return null;
      const r = srgbToLinear(c.r);
      const g = srgbToLinear(c.g);
      const b = srgbToLinear(c.b);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrastRatio(fg, bg) {
      const l1 = relativeLuminance(fg);
      const l2 = relativeLuminance(bg);
      if (l1 === null || l2 === null) return 1;
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    }

    function ensureReadableColor(primary, bg, fallback, minRatio) {
      if (contrastRatio(primary, bg) >= minRatio) return primary;
      if (contrastRatio(fallback, bg) >= minRatio) return fallback;
      const white = '#ffffff';
      const black = '#000000';
      return contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
    }

    function cssVar(styles, name, fallback) {
      const v = (styles.getPropertyValue(name) || '').trim();
      return v || fallback;
    }

    /* Return semi-transparent background color for a kind badge */
    function kindBgColor(kind) {
      const color = nodeKindColor(kind);
      return color ? colorToRgba(color, 0.18) : 'rgba(128,128,128,0.18)';
    }

    /* Return accent color for a kind — reads CSS vars injected from real TextMate theme */
    function nodeKindColor(kind) {
      // 'Ctor' in map data maps to 'Constructor' CSS var
      const cssKind = kind === 'Ctor' ? 'Constructor' : kind;
      const v = getComputedStyle(document.documentElement).getPropertyValue('--peek-kind-' + cssKind).trim();
      return v || null;
    }

    /* Tree layout: left-to-right, depth-first */
    function graphLayout() {
      const dpr = window.devicePixelRatio || 1;
      const cw = graphContainer.clientWidth;
      const ch = graphContainer.clientHeight;
      graphCanvas.width = cw * dpr;
      graphCanvas.height = ch * dpr;
      graphCanvas.style.width = cw + 'px';
      graphCanvas.style.height = ch + 'px';

      const fontSize = 12;
      const font = fontSize + 'px ' + getComputedStyle(document.body).fontFamily;

      // Compute widths and heights
      const callFont = '10px ' + getComputedStyle(document.body).fontFamily;
      const nodeMap = {};
      for (const n of gNodes) {
        nodeMap[n.id] = n;
        const isRootNode = n.id === '__root__';
        const displayLabel = stripParams(n.label);
        const labelW = gTextWidth(displayLabel, isRootNode ? ('bold ' + font) : font);
        let baseW = G_PAD_X * 2 + 19 + labelW;  // 19 = badge(14) + gap(5)

        // Multi-callsite: compute badge row width
        const cs = n.callSites;
        if (cs && cs.length > 1) {
          let maxBadgesRowW = 0;
          for (let rowStart = 0; rowStart < cs.length; rowStart += G_CALLS_PER_ROW) {
            const rowEnd = Math.min(cs.length, rowStart + G_CALLS_PER_ROW);
            let rowW = G_PAD_X; // left padding
            for (let si = rowStart; si < rowEnd; si++) {
              const txt = 'L' + (cs[si].callLine + 1);
              rowW += gTextWidth(txt, callFont) + 8 + 4; // 8=pad, 4=gap
            }
            rowW += G_PAD_X - 4; // right padding minus last gap
            if (rowW > maxBadgesRowW) { maxBadgesRowW = rowW; }
          }
          if (maxBadgesRowW > baseW) { baseW = maxBadgesRowW; }
          const rowCount = Math.ceil(cs.length / G_CALLS_PER_ROW);
          n.h = G_NODE_H + rowCount * G_CALL_ROW_H;
        } else {
          n.h = G_NODE_H;
        }

        n.w = Math.max(baseW, 60);
      }

      // BFS level assignment
      const levels = {};
      const queue = ['__root__'];
      levels['__root__'] = 0;
      while (queue.length > 0) {
        const cur = queue.shift();
        const node = nodeMap[cur];
        if (!node) continue;
        for (const cid of node.children) {
          if (levels[cid] === undefined) {
            levels[cid] = levels[cur] + 1;
            queue.push(cid);
          }
        }
      }

      // Group by level
      const byLevel = {};
      let maxLevel = 0;
      for (const n of gNodes) {
        const lv = levels[n.id] !== undefined ? levels[n.id] : 0;
        if (!byLevel[lv]) byLevel[lv] = [];
        byLevel[lv].push(n);
        if (lv > maxLevel) maxLevel = lv;
      }

      if (graphDirection === 'up') {
        // Position: Y by level (upward), X spread horizontally
        const levelMaxH = {};
        for (let lv = 0; lv <= maxLevel; lv++) {
          const group = byLevel[lv] || [];
          let maxH = 0;
          for (const n of group) {
            if (n.h > maxH) maxH = n.h;
          }
          levelMaxH[lv] = maxH;
        }

        let yOffset = 40;
        let prevLevelOrder = new Map();
        for (let lv = 0; lv <= maxLevel; lv++) {
          const group = (byLevel[lv] || []).slice();

          // Keep sibling ordering stable and independent from expansion order.
          // Primary key: parent order from previous level, then parent x-center,
          // then call-site position/name for deterministic ordering.
          if (lv > 0) {
            group.sort((a, b) => {
              const parentOrderA = prevLevelOrder.get(a.parentId) ?? Number.MAX_SAFE_INTEGER;
              const parentOrderB = prevLevelOrder.get(b.parentId) ?? Number.MAX_SAFE_INTEGER;
              if (parentOrderA !== parentOrderB) return parentOrderA - parentOrderB;

              const parentA = nodeMap[a.parentId];
              const parentB = nodeMap[b.parentId];
              const parentCenterA = parentA ? (parentA.x + parentA.w / 2) : 0;
              const parentCenterB = parentB ? (parentB.x + parentB.w / 2) : 0;
              if (parentCenterA !== parentCenterB) return parentCenterA - parentCenterB;

              const lineA = a.data?.callLine ?? a.data?.line ?? -1;
              const lineB = b.data?.callLine ?? b.data?.line ?? -1;
              if (lineA !== lineB) return lineA - lineB;

              const charA = a.data?.callCharacter ?? a.data?.character ?? -1;
              const charB = b.data?.callCharacter ?? b.data?.character ?? -1;
              if (charA !== charB) return charA - charB;

              return String(a.label || '').localeCompare(String(b.label || ''));
            });
          }

          let totalW = 0;
          for (const n of group) totalW += n.w;
          totalW += Math.max(0, group.length - 1) * G_SIBLING_GAP_X;
          let xCur = (cw / 2) - (totalW / 2);

          for (let i = 0; i < group.length; i++) {
            group[i].x = xCur;
            group[i].y = yOffset;
            xCur += group[i].w + G_SIBLING_GAP_X;
          }

          const currentOrder = new Map();
          for (let i = 0; i < group.length; i++) {
            currentOrder.set(group[i].id, i);
          }
          prevLevelOrder = currentOrder;

          yOffset -= levelMaxH[lv] + G_LEVEL_GAP_Y;
        }
      } else {
        // Position: X by level, Y spread vertically
        let xOffset = 40;
        let prevLevelOrder = new Map();
        for (let lv = 0; lv <= maxLevel; lv++) {
          const group = (byLevel[lv] || []).slice();

          // Keep sibling ordering stable and independent from expansion order.
          // Primary key: parent order from previous level, then parent y-center,
          // then call-site position/name for deterministic ordering.
          if (lv > 0) {
            group.sort((a, b) => {
              const parentOrderA = prevLevelOrder.get(a.parentId) ?? Number.MAX_SAFE_INTEGER;
              const parentOrderB = prevLevelOrder.get(b.parentId) ?? Number.MAX_SAFE_INTEGER;
              if (parentOrderA !== parentOrderB) return parentOrderA - parentOrderB;

              const parentA = nodeMap[a.parentId];
              const parentB = nodeMap[b.parentId];
              const parentCenterA = parentA ? (parentA.y + parentA.h / 2) : 0;
              const parentCenterB = parentB ? (parentB.y + parentB.h / 2) : 0;
              if (parentCenterA !== parentCenterB) return parentCenterA - parentCenterB;

              const lineA = a.data?.callLine ?? a.data?.line ?? -1;
              const lineB = b.data?.callLine ?? b.data?.line ?? -1;
              if (lineA !== lineB) return lineA - lineB;

              const charA = a.data?.callCharacter ?? a.data?.character ?? -1;
              const charB = b.data?.callCharacter ?? b.data?.character ?? -1;
              if (charA !== charB) return charA - charB;

              return String(a.label || '').localeCompare(String(b.label || ''));
            });
          }

          let maxW = 0;
          for (const n of group) {
            if (n.w > maxW) maxW = n.w;
          }
          let totalH = 0;
          for (const n of group) totalH += n.h;
          totalH += (group.length - 1) * G_SIBLING_GAP_Y;
          let yStart = (ch / 2) - (totalH / 2);
          let yCur = yStart;
          for (let i = 0; i < group.length; i++) {
            group[i].x = xOffset;
            group[i].y = yCur;
            yCur += group[i].h + G_SIBLING_GAP_Y;
          }

          const currentOrder = new Map();
          for (let i = 0; i < group.length; i++) {
            currentOrder.set(group[i].id, i);
          }
          prevLevelOrder = currentOrder;

          xOffset += maxW + G_LEVEL_GAP_X;
        }
      }

      // Center the graph horizontally
      if (gNodes.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of gNodes) {
          if (n.x < minX) minX = n.x;
          if (n.x + n.w > maxX) maxX = n.x + n.w;
          if (n.y < minY) minY = n.y;
          if (n.y + n.h > maxY) maxY = n.y + n.h;
        }
        const graphW = maxX - minX;
        const graphH = maxY - minY;
        const offsetX = (cw - graphW) / 2 - minX;
        const offsetY = (ch - graphH) / 2 - minY;
        gPan.x = offsetX;
        gPan.y = offsetY;
      }
    }

    /* Draw */
    function graphDraw() {
      const dpr = window.devicePixelRatio || 1;
      const cw = graphCanvas.width / dpr;
      const ch = graphCanvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(gPan.x, gPan.y);
      ctx.scale(gZoom, gZoom);

      const nodeMap = {};
      for (const n of gNodes) nodeMap[n.id] = n;

      const styles = getComputedStyle(document.body);
      const canvasBg = cssVar(styles, '--vscode-panel-background', '#1e1e1e');
      const fg = (styles.color || '#d4d4d4').trim();
      const dimBase = cssVar(styles, '--vscode-descriptionForeground', '#858585');
      const accentColor = cssVar(styles, '--vscode-panelTitle-activeBorder', '#007acc');
      const nodeBg = cssVar(styles, '--vscode-editorWidget-background', cssVar(styles, '--vscode-sideBarSectionHeader-background', '#252526'));
      const hoverBg = cssVar(styles, '--vscode-list-hoverBackground', 'rgba(255,255,255,0.05)');
      const funcColor = cssVar(styles, '--vscode-symbolIcon-functionForeground', '#dcdcaa');
      const edgeColor = ensureReadableColor(dimBase, canvasBg, fg, 2.2);
      const dimColor = ensureReadableColor(dimBase, nodeBg, fg, 2.2);

      // Draw edges
      ctx.strokeStyle = colorToRgba(edgeColor, 0.8);
      ctx.lineWidth = 1.2;
      for (const e of gEdges) {
        const from = nodeMap[e.from];
        const to = nodeMap[e.to];
        if (!from || !to) continue;
        let x1, y1, x2, y2, cp1x, cp1y, cp2x, cp2y;
        if (graphDirection === 'up') {
          x1 = from.x + from.w / 2;
          y1 = from.y;
          x2 = to.x + to.w / 2;
          y2 = to.y + to.h;
          const cpy = (y1 + y2) / 2;
          cp1x = x1; cp1y = cpy;
          cp2x = x2; cp2y = cpy;
        } else {
          x1 = from.x + from.w;
          y1 = from.y + from.h / 2;
          x2 = to.x;
          y2 = to.y + to.h / 2;
          const cpx = (x1 + x2) / 2;
          cp1x = cpx; cp1y = y1;
          cp2x = cpx; cp2y = y2;
        }

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
        ctx.stroke();

        // Arrow head
        const arrowSize = 5;
        const finalAngle = graphDirection === 'up' ? -Math.PI / 2 : 0;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(finalAngle - 0.4), y2 - arrowSize * Math.sin(finalAngle - 0.4));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(finalAngle + 0.4), y2 - arrowSize * Math.sin(finalAngle + 0.4));
        ctx.stroke();
      }

      // Draw nodes
      const fontSize = 12;
      const font = fontSize + 'px ' + getComputedStyle(document.body).fontFamily;
      for (const n of gNodes) {
        const isHover = gHover === n.id;

        // Node shape: all use rounded rectangle, kind distinguished by prefix icon
        const rawKindColor = nodeKindColor(n.kind) || funcColor;
        const kindBorderColor = ensureReadableColor(rawKindColor, nodeBg, fg, 2.4);
        const nodeFill = isHover ? hoverBg : nodeBg;
        ctx.fillStyle = nodeFill;
        ctx.strokeStyle = isHover ? ensureReadableColor(accentColor, nodeFill, fg, 2.4) : kindBorderColor;
        ctx.lineWidth = isHover ? 2 : 1.5;
        const ncx = n.x + n.w / 2, ncy = n.y + n.h / 2;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(n.x + r, n.y);
        ctx.lineTo(n.x + n.w - r, n.y);
        ctx.quadraticCurveTo(n.x + n.w, n.y, n.x + n.w, n.y + r);
        ctx.lineTo(n.x + n.w, n.y + n.h - r);
        ctx.quadraticCurveTo(n.x + n.w, n.y + n.h, n.x + n.w - r, n.y + n.h);
        ctx.lineTo(n.x + r, n.y + n.h);
        ctx.quadraticCurveTo(n.x, n.y + n.h, n.x, n.y + n.h - r);
        ctx.lineTo(n.x, n.y + r);
        ctx.quadraticCurveTo(n.x, n.y, n.x + r, n.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Loading indicator
        if (n.loading) {
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2;
          const cx = graphDirection === 'up' ? (n.x + n.w / 2) : (n.x + n.w + 10);
          const cy = graphDirection === 'up' ? (n.y - 10) : (n.y + n.h / 2);
          const t = (Date.now() % 1000) / 1000 * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, t, t + Math.PI * 1.2);
          ctx.stroke();
          if (!gAnimFrame) {
            gAnimFrame = requestAnimationFrame(() => { gAnimFrame = null; graphDraw(); });
          }
        }

        // Kind badge + label (centered, single row)
        const hasMultiCS = n.callSites && n.callSites.length > 1;
        const labelY = hasMultiCS ? (n.y + G_NODE_H / 2) : ncy;
        const letter    = nodeKindPrefix(n.kind);
        const badgeW    = 14;
        const badgeH    = 14;
        const badgeGap  = 5;
        const drawFont  = font;
        ctx.font = drawFont;
        const rawLabel  = stripParams(n.label);
        const qn = splitQualifiedName(rawLabel);
        const ownerText = qn ? qn.owner : '';
        const memberText = qn ? qn.member : rawLabel;
        const sepText = qn ? '::' : '';
        const ownerW = ownerText ? gTextWidth(ownerText, drawFont) : 0;
        const sepW = sepText ? gTextWidth(sepText, drawFont) : 0;
        const memberW = gTextWidth(memberText, drawFont);
        const textW = ownerW + sepW + memberW;
        const totalW    = badgeW + badgeGap + textW;
        const startX    = ncx - totalW / 2;

        // Badge rounded-rect background
        ctx.fillStyle = colorToRgba(kindBorderColor, 0.22);
        const bY = labelY - badgeH / 2;
        ctx.beginPath();
        ctx.roundRect(startX, bY, badgeW, badgeH, 3);
        ctx.fill();

        // Badge letter
        ctx.font = 'bold 9px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = kindBorderColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, startX + badgeW / 2, labelY);

        // Label text
        ctx.font = drawFont;
        const ownerRawColor = cssVar(styles, '--peek-qualified-owner', cssVar(styles, '--peek-kind-Class', fg));
        const sepRawColor = cssVar(styles, '--peek-operator', fg);
        const memberColor = ensureReadableColor(rawKindColor, nodeFill, fg, 3.0);
        const ownerColor = ensureReadableColor(ownerRawColor, nodeFill, fg, 3.0);
        const sepColor = ensureReadableColor(sepRawColor, nodeFill, fg, 3.0);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let textX = startX + badgeW + badgeGap;
        if (ownerText) {
          ctx.fillStyle = ownerColor;
          ctx.fillText(ownerText, textX, labelY);
          textX += ownerW;
          ctx.fillStyle = sepColor;
          ctx.fillText('::', textX, labelY);
          textX += sepW;
        }
        ctx.fillStyle = memberColor;
        ctx.fillText(memberText, textX, labelY);

        // ── Call-site line-number badges (only for merged nodes) ──────────
        n._callBadgeRects = [];
        const cs = n.callSites;
        if (cs && cs.length > 1) {
          const cFont = '10px ' + getComputedStyle(document.body).fontFamily;
          ctx.font = cFont;
          const badgeRowY = n.y + G_NODE_H;
          for (let rowStart = 0; rowStart < cs.length; rowStart += G_CALLS_PER_ROW) {
            const rowEnd = Math.min(cs.length, rowStart + G_CALLS_PER_ROW);
            let bx = n.x + G_PAD_X;
            for (let si = rowStart; si < rowEnd; si++) {
              const txt = 'L' + (cs[si].callLine + 1);
              const tw = ctx.measureText(txt).width;
              const bw = tw + 8;
              const bh = 13;
              const rowIndex = Math.floor(si / G_CALLS_PER_ROW);
              const by = badgeRowY + rowIndex * G_CALL_ROW_H + (G_CALL_ROW_H - bh) / 2;

              // Highlight hovered badge
              const isHot = (gHover === n.id && gHoverCallSite === si);

              // Badge background
              ctx.fillStyle = isHot ? colorToRgba(accentColor, 0.35) : colorToRgba(dimColor, 0.18);
              ctx.beginPath();
              ctx.roundRect(bx, by, bw, bh, 2);
              ctx.fill();

              // Badge text
              ctx.fillStyle = isHot
                ? ensureReadableColor(accentColor, nodeFill, fg, 3.0)
                : ensureReadableColor(dimColor, nodeFill, fg, 3.0);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(txt, bx + bw / 2, by + bh / 2);

              n._callBadgeRects.push({ x: bx, y: by, w: bw, h: bh, idx: si });
              bx += bw + 4;
            }
          }
        }
      }

      ctx.restore();
    }

    /* Hit-test: which node is under canvas coords? */
    function graphHitTest(cx, cy) {
      const wx = (cx - gPan.x) / gZoom;
      const wy = (cy - gPan.y) / gZoom;
      for (let i = gNodes.length - 1; i >= 0; i--) {
        const n = gNodes[i];
        if (wx >= n.x && wx <= n.x + n.w + 14 && wy >= n.y && wy <= n.y + n.h) {
          return n;
        }
      }
      return null;
    }

    /* Hit-test call-site badge inside a node; returns badge index or -1 */
    function graphHitTestCallSite(node, cx, cy) {
      if (!node || !node._callBadgeRects || node._callBadgeRects.length === 0) return -1;
      const wx = (cx - gPan.x) / gZoom;
      const wy = (cy - gPan.y) / gZoom;
      for (const r of node._callBadgeRects) {
        if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
          return r.idx;
        }
      }
      return -1;
    }

    /* Handle children arriving from extension (graph mode) */
    function graphHandleChildren(parentNodeId, items) {
      const nodeMap = {};
      for (const n of gNodes) nodeMap[n.id] = n;
      const parent = nodeMap[parentNodeId];
      if (!parent) return;

      parent.loading = false;

      if (items.length === 0) {
        parent.expanded = false;
        graphDraw();
        return;
      }

      parent.expanded = true;
      const merged = mergeItemsBySymbol(items);
      for (const mg of merged) {
        const item = mg.primary;
        const nid = item.nodeId;
        if (nodeMap[nid]) continue; // avoid duplicates
        gNodes.push({
          id: nid,
          label: item.label,
          kind: item.kind || '',
          x: 0, y: 0, w: 0, h: G_NODE_H,
          children: [],
          expanded: false,
          loading: false,
          data: item,
          parentId: parentNodeId,
          callSites: mg.callSites,
          _callBadgeRects: [],
        });
        parent.children.push(nid);
        gEdges.push({ from: parentNodeId, to: nid });
      }

      // Restore previously expanded descendants (if parent was collapsed earlier).
      restoreGraphExpansions();
      graphLayout();
      graphDraw();
    }

    /* Collapse a node: remove all descendants */
    function graphCollapse(node) {
      const nodeMap = {};
      for (const n of gNodes) nodeMap[n.id] = n;
      const toRemove = new Set();
      const stack = [].concat(node.children);
      while (stack.length > 0) {
        const cid = stack.pop();
        toRemove.add(cid);
        const cn = nodeMap[cid];
        if (cn) {
          for (const gc of cn.children) stack.push(gc);
        }
      }
      gNodes = gNodes.filter(n => !toRemove.has(n.id));
      gEdges = gEdges.filter(e => !toRemove.has(e.from) && !toRemove.has(e.to));
      node.children = [];
      node.expanded = false;
      // Keep descendant expansion state so re-expanding this node can restore
      // previously opened descendants from cache.
      expandedNodeIds.delete(node.id);
    }

    // ── Canvas interactions ──────────────────────────────────────────────

    graphCanvas.addEventListener('mousemove', (e) => {
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (gDragging) {
        gPan.x += cx - gDragStart.x;
        gPan.y += cy - gDragStart.y;
        gDragStart.x = cx;
        gDragStart.y = cy;
        graphDraw();
        return;
      }

      const hit = graphHitTest(cx, cy);
      const newHover = hit ? hit.id : null;
      const newCallSite = hit ? graphHitTestCallSite(hit, cx, cy) : -1;
      if (newHover !== gHover || newCallSite !== gHoverCallSite) {
        gHover = newHover;
        gHoverCallSite = newCallSite;
        graphCanvas.style.cursor = hit ? 'pointer' : 'default';
        graphDraw();
      }
    });

    graphCanvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        const rect = graphCanvas.getBoundingClientRect();
        gDragStart.x = e.clientX - rect.left;
        gDragStart.y = e.clientY - rect.top;
        gDragging = true;
      }
    });

    graphCanvas.addEventListener('mouseup', () => { gDragging = false; });
    graphCanvas.addEventListener('mouseleave', () => { gDragging = false; });

    graphCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.2, Math.min(5, gZoom * factor));
      // Zoom towards cursor
      gPan.x = cx - (cx - gPan.x) * (newZoom / gZoom);
      gPan.y = cy - (cy - gPan.y) * (newZoom / gZoom);
      gZoom = newZoom;
      graphDraw();
    }, { passive: false });

    // Click: peek in context window (single), open in editor (double), expand/collapse (ctrl+click)
    graphCanvas.addEventListener('click', (e) => {
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = graphHitTest(cx, cy);
      if (!hit) return;

      // Ctrl+click: expand/collapse
      if (e.ctrlKey || e.metaKey) {
        if (hit.data && hit.data.nodeId && hit.data.nodeId.startsWith('leaf_')) return;

        if (hit.expanded) {
          graphCollapse(hit);
          graphLayout();
          graphDraw();
        } else {
          // Re-expand from cache if available
          if (nodeChildrenCache.has(hit.id)) {
            const cached = nodeChildrenCache.get(hit.id);
            graphHandleChildren(hit.id, cached);
            expandedNodeIds.add(hit.id);
            loadedNodes.add(hit.id);
            restoreGraphExpansions();
            graphLayout();
            graphDraw();
            return;
          }
          if (loadedNodes.has(hit.id)) return;
          hit.loading = true;
          graphDraw();
          vscodeApi.postMessage({ type: 'expandRef', nodeId: hit.id });
        }
        return;
      }

      // Single click: update peek view only (do NOT open editor)
      if (e.detail === 1 && hit.data) {
        const csIdx = graphHitTestCallSite(hit, cx, cy);
        const cs = hit.callSites;
        const cl = (csIdx >= 0 && cs) ? cs[csIdx].callLine : (hit.data.callLine != null ? hit.data.callLine : hit.data.line);
        const cc = (csIdx >= 0 && cs) ? cs[csIdx].callCharacter : (hit.data.callCharacter != null ? hit.data.callCharacter : hit.data.character);
        const cu = (csIdx >= 0 && cs) ? cs[csIdx].uri : hit.data.uri;
        vscodeApi.postMessage({ type: 'peekOnly', uri: cu, line: cl, character: cc });
      }
    });

    // Double-click: open in editor
    graphCanvas.addEventListener('dblclick', (e) => {
      if (e.ctrlKey || e.metaKey) return; // ctrl+dblclick ignored
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = graphHitTest(cx, cy);
      if (!hit || !hit.data) return;
      const csIdx = graphHitTestCallSite(hit, cx, cy);
      const cs = hit.callSites;
      const cl = (csIdx >= 0 && cs) ? cs[csIdx].callLine : (hit.data.callLine != null ? hit.data.callLine : hit.data.line);
      const cc = (csIdx >= 0 && cs) ? cs[csIdx].callCharacter : (hit.data.callCharacter != null ? hit.data.callCharacter : hit.data.character);
      const cu = (csIdx >= 0 && cs) ? cs[csIdx].uri : hit.data.uri;
      vscodeApi.postMessage({ type: 'jumpTo', uri: cu, line: cl, character: cc });
    });

    // Resize observer for canvas
    const resizeObs = new ResizeObserver(() => {
      if (isGraphMode(viewMode) && lastUpdateData) {
        graphLayout();
        graphDraw();
      }
    });
    resizeObs.observe(graphContainer);
  </script>
</body>
</html>`;
  }
}
