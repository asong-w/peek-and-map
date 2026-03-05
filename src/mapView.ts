import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNodeData } from './types';
import { getNonce } from './utils';
import { PeekViewProvider } from './peekView';

export class MapViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mapView.view';

  private _view?: vscode.WebviewView;
  private _lastKnownEditor?: vscode.TextEditor;

  // Node maps for lazy tree expansion
  private _refNodeMap = new Map<string, { uri: vscode.Uri; position: vscode.Position }>();
  private _callerNodeMap = new Map<string, vscode.CallHierarchyItem>();
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
          break;

        case 'search':
          await this._doSearch();
          break;

        case 'expandRef':
          await this._expandRef(msg.nodeId as string);
          break;

        case 'expandIncoming':
          await this._expandIncoming(msg.nodeId as string);
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

  private _allocCallerNodeId(item: vscode.CallHierarchyItem): string {
    const id = `c${++this._nodeCounter}`;
    this._callerNodeMap.set(id, item);
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
    this._callerNodeMap.clear();
    this._nodeCounter = 0;

    // Show loading state
    this._view.webview.postMessage({ type: 'loading', symbolName: word });

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    // ── References hierarchy (first level) ─────────────────────────────────
    const refNodes = await this._resolveReferencingSymbols(doc.uri, queryPos, wsRoot);

    // ── Call hierarchy callers (first level) ────────────────────────────────
    let callers: TreeNodeData[] = [];
    try {
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy', doc.uri, queryPos
      );
      if (items && items.length > 0) {
        const rootItem = items[0];
        try {
          const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls', rootItem
          );
          if (incoming) {
            for (const call of incoming) {
              const from = call.from;
              const nodeId = this._allocCallerNodeId(from);
              let preview = '';
              try {
                const d = await vscode.workspace.openTextDocument(from.uri);
                preview = d.lineAt(from.selectionRange.start.line).text.trim();
              } catch { /* ignore */ }
              callers.push({
                nodeId,
                label: from.name,
                detail: this._relativePath(from.uri.fsPath, wsRoot),
                line: from.selectionRange.start.line,
                character: from.selectionRange.start.character,
                callLine: call.fromRanges[0]?.start.line ?? from.selectionRange.start.line,
                callCharacter: call.fromRanges[0]?.start.character ?? from.selectionRange.start.character,
                uri: from.uri.toString(),
                kind: this._symbolKindName(from.kind),
                preview,
              });
            }
          }
        } catch { /* no incoming calls */ }
      }
    } catch { /* no call hierarchy provider */ }

    this._view.webview.postMessage({
      type: 'update',
      data: {
        symbolName: word,
        fileName: path.basename(doc.uri.fsPath),
        refNodes,
        callers,
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

    const seen = new Map<string, TreeNodeData>();
    for (const loc of locs) {
      let refDoc: vscode.TextDocument;
      try {
        refDoc = await vscode.workspace.openTextDocument(loc.uri);
      } catch { continue; }

      const symbols = await this._getDocumentSymbols(loc.uri);
      const enclosing = this._deepestContaining(symbols, loc.range.start);

      if (!enclosing) {
        // Reference at file/global scope — show as leaf node
        const key = loc.uri.toString() + '#loc:' + loc.range.start.line + ':' + loc.range.start.character;
        if (!seen.has(key)) {
          seen.set(key, {
            nodeId: `leaf_${++this._nodeCounter}`, // not stored in map → not expandable
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
        }
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

      // Deduplicate by enclosing symbol identity
      const key = loc.uri.toString() + '#sym:' + symStart.line + ':' + symStart.character;
      if (seen.has(key)) { continue; }

      const nodeId = this._allocRefNodeId(loc.uri, symStart);
      seen.set(key, {
        nodeId,
        label: enclosing.name,
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

    return Array.from(seen.values());
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

  // ── Expand: Incoming Calls (Callers) ───────────────────────────────────────

  private async _expandIncoming(nodeId: string): Promise<void> {
    if (!this._view) { return; }
    const item = this._callerNodeMap.get(nodeId);
    if (!item) {
      this._view.webview.postMessage({ type: 'children', parentNodeId: nodeId, items: [] });
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    try {
      const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls', item
      );
      const children: TreeNodeData[] = [];
      if (incoming) {
        for (const call of incoming) {
          const from = call.from;
          const childId = this._allocCallerNodeId(from);
          let preview = '';
          try {
            const d = await vscode.workspace.openTextDocument(from.uri);
            preview = d.lineAt(from.selectionRange.start.line).text.trim();
          } catch { /* ignore */ }
          children.push({
            nodeId: childId,
            label: from.name,
            detail: this._relativePath(from.uri.fsPath, wsRoot),
            line: from.selectionRange.start.line,
            character: from.selectionRange.start.character,
            callLine: call.fromRanges[0]?.start.line ?? from.selectionRange.start.line,
            callCharacter: call.fromRanges[0]?.start.character ?? from.selectionRange.start.character,
            uri: from.uri.toString(),
            kind: this._symbolKindName(from.kind),
            preview,
          });
        }
      }
      this._view.webview.postMessage({ type: 'children', parentNodeId: nodeId, items: children });
    } catch {
      this._view.webview.postMessage({ type: 'children', parentNodeId: nodeId, items: [] });
    }
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
    #search-btn, #view-toggle-btn {
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
    #search-btn:hover, #view-toggle-btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    #search-btn .btn-icon, #view-toggle-btn .btn-icon {
      font-size: 14px;
      line-height: 1;
    }
    #symbol-name {
      font-weight: 600;
      color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    #file-name {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #858585);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
      flex-shrink: 0;
    }

    /* ── Tab bar ────────────────────────────────────────────────── */
    #tabs {
      display: flex;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      user-select: none;
    }
    .tab {
      padding: 4px 14px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-foreground, #ccc);
      border-bottom: 2px solid transparent;
      transition: background 0.15s;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .tab:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }
    .tab.active {
      color: var(--vscode-panelTitle-activeForeground, #fff);
      border-bottom-color: var(--vscode-panelTitle-activeBorder, #007acc);
    }
    .tab .count {
      font-size: 10px;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      min-width: 16px;
      text-align: center;
    }

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
      font-size: 13px;
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      display: inline-block;
      line-height: 1;
    }
    .tree-row .item-name {
      font-weight: 600;
      color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
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
</head>
<body>
  <div id="header">
    <button id="search-btn" title="Analyze symbol at cursor"><span class="btn-icon">🔍</span> Analysis</button>
    <button id="view-toggle-btn" title="Toggle Graph / Tree view"><span class="btn-icon">📽️</span> View</button>
    <span id="symbol-name">Select a symbol, then click "Analysis"</span>
    <span id="file-name"></span>
  </div>
  <div id="tabs">
    <div class="tab active" data-tab="references">References <span class="count" id="count-ref">0</span></div>
    <div class="tab" data-tab="callers">Callers <span class="count" id="count-in">0</span></div>
  </div>
  <div id="empty-msg">Place cursor on a symbol, then click "Analysis"</div>
  <div id="content" style="display:none">
    <div class="table-header">
      <div class="col-name">Symbol</div>
      <div class="col-file">File</div>
      <div class="col-line">Line</div>
    </div>
    <div class="section active" id="sec-references"></div>
    <div class="section" id="sec-callers"></div>
  </div>
  <div id="graph-container">
    <canvas id="graph-canvas"></canvas>
    <div id="graph-hint">Click = peek · Double-click = open &amp; peek · Ctrl+click = expand/collapse · Scroll = zoom · Drag = pan</div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'ready' });

    const symbolNameEl = document.getElementById('symbol-name');
    const fileNameEl   = document.getElementById('file-name');
    const emptyMsg     = document.getElementById('empty-msg');
    const content      = document.getElementById('content');
    const searchBtn    = document.getElementById('search-btn');
    const viewToggleBtn = document.getElementById('view-toggle-btn');
    const graphContainer = document.getElementById('graph-container');
    const graphCanvas   = document.getElementById('graph-canvas');
    const tabsEl        = document.getElementById('tabs');

    const sections = {
      references: document.getElementById('sec-references'),
      callers:    document.getElementById('sec-callers'),
    };
    const counts = {
      references: document.getElementById('count-ref'),
      callers:    document.getElementById('count-in'),
    };

    let activeTab = 'references';
    const loadedNodes = new Set();

    // ── View mode: 'tree' or 'graph' ─────────────────────────────────────
    let viewMode = 'tree';
    // Store last update data for graph rendering
    let lastUpdateData = null;

    const TREE_ICON = '';
    const GRAPH_ICON = '';

    function setViewMode(mode) {
      viewMode = mode;
      if (mode === 'graph') {
        content.style.display = 'none';
        tabsEl.style.display = 'none';
        graphContainer.style.display = 'block';
        if (lastUpdateData) {
          graphBuildFromData(lastUpdateData);
        }
      } else {
        graphContainer.style.display = 'none';
        tabsEl.style.display = 'flex';
        if (lastUpdateData) {
          content.style.display = 'block';
        }
      }
    }

    viewToggleBtn.addEventListener('click', () => {
      setViewMode(viewMode === 'tree' ? 'graph' : 'tree');
    });

    // ── Search button ────────────────────────────────────────────────────
    searchBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'search' });
    });

    // ── Tab switching ────────────────────────────────────────────────────
    tabsEl.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      const name = tab.dataset.tab;
      if (!name || name === activeTab) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.values(sections).forEach(s => s.classList.remove('active'));
      sections[name].classList.add('active');
      activeTab = name;
    });

    // ── Messages from extension ──────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'empty') {
        emptyMsg.textContent   = msg.message;
        emptyMsg.style.display = 'flex';
        content.style.display  = 'none';
        graphContainer.style.display = 'none';
        symbolNameEl.textContent = msg.message;
        fileNameEl.textContent = '';
        lastUpdateData = null;
        return;
      }

      if (msg.type === 'loading') {
        emptyMsg.textContent   = 'Analyzing ' + msg.symbolName + ' ...';
        emptyMsg.style.display = 'flex';
        content.style.display  = 'none';
        graphContainer.style.display = 'none';
        symbolNameEl.textContent = msg.symbolName;
        fileNameEl.textContent = '';
        return;
      }

      if (msg.type === 'update') {
        loadedNodes.clear();
        const d = msg.data;
        lastUpdateData = d;
        symbolNameEl.textContent = d.symbolName;
        fileNameEl.textContent   = d.fileName ? '  ' + d.fileName : '';
        emptyMsg.style.display   = 'none';

        // Tree view
        renderTreeList(sections.references, d.refNodes, 0);
        renderTreeList(sections.callers, d.callers, 0);
        counts.references.textContent = '' + d.refNodes.length;
        counts.callers.textContent    = '' + d.callers.length;

        if (viewMode === 'tree') {
          content.style.display = 'block';
          graphContainer.style.display = 'none';
          tabsEl.style.display = 'flex';
        } else {
          content.style.display = 'none';
          tabsEl.style.display = 'none';
          graphContainer.style.display = 'block';
          graphBuildFromData(d);
        }
        return;
      }

      // Children for a tree node (incremental expansion)
      if (msg.type === 'children') {
        const parentNodeId = msg.parentNodeId;
        loadedNodes.add(parentNodeId);

        // ── Graph expand ──────────────────────────────────────────
        if (viewMode === 'graph') {
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
      const kindHtml = item.kind
        ? '<span class="item-icon" style="color:' + (nodeKindColor(item.kind) || 'inherit') + '">' + kindSymbol(item.kind) + '</span>'
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
        + '<span class="item-name">' + escapeHtml(stripParams(item.label)) + '</span>'
        + '</div>'
        + '<div class="col-file" title="' + escapeAttr(item.detail) + '">' + escapeHtml(item.detail) + '</div>'
        + '<div class="col-line">' + (callLine + 1) + '</div>'
        + '</div>'
        + '<div class="tree-children" style="display:none"></div>'
        + '</div>';
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
        } else {
          toggle.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>';
          toggle.classList.add('loading');
          const section = nodeEl.closest('.section');
          let msgType;
          if (section && section.id === 'sec-references') {
            msgType = 'expandRef';
          } else {
            msgType = 'expandIncoming';
          }
          vscodeApi.postMessage({ type: msgType, nodeId: nodeId });
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
    let gNodes = [];   // {id, label, kind, x, y, w, h, children:[], expanded, loading, data, parentId}
    let gEdges = [];   // {from, to}
    let gPan = {x: 0, y: 0};
    let gZoom = 1;
    let gDragging = false;
    let gDragStart = {x: 0, y: 0};
    let gHover = null;
    let gPendingExpand = null; // nodeId waiting for children
    let gAnimFrame = null;

    const G_NODE_H = 32;
    const G_PAD_X = 12;
    const G_PAD_Y = 4;
    const G_LEVEL_GAP_X = 60;
    const G_SIBLING_GAP_Y = 10;

    function graphBuildFromData(d) {
      gNodes = [];
      gEdges = [];
      gPan = {x: 0, y: 0};
      gZoom = 1;
      gPendingExpand = null;

      // Root node (the queried symbol)
      const rootId = '__root__';
      gNodes.push({
        id: rootId,
        label: d.symbolName,
        kind: 'Root',
        x: 0, y: 0, w: 0, h: G_NODE_H,
        children: [],
        expanded: true,
        loading: false,
        data: null,
        parentId: null,
      });

      // Combine refNodes + callers as first-level children
      const allChildren = [].concat(d.refNodes || [], d.callers || []);
      for (const item of allChildren) {
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
        'Function':  '⨍',
        'Method':    '◈',
        'Class':     '◆',
        'Interface': '◇',
        'Variable':  '▽',
        'Constant':  '▼',
        'Property':  '◉',
        'Field':     '○',
        'Enum':      '▣',
        'Module':    '◫',
        'Namespace': '◧',
        'Struct':    '▢',
        'Ctor':      '⊕',
        'Global':    '◎',
        'Root':      '★',
      };
      return prefixes[kind] || '•';
    }

    /* Return symbol for a kind (used in tree view) */
    function kindSymbol(kind) {
      return nodeKindPrefix(kind);
    }

    /* Return accent color for a kind */
    function nodeKindColor(kind) {
      const kindColors = {
        'Function':  '#3b82f6',
        'Method':    '#8b5cf6',
        'Class':     '#f59e0b',
        'Interface': '#06b6d4',
        'Variable':  '#10b981',
        'Constant':  '#10b981',
        'Property':  '#ec4899',
        'Field':     '#ec4899',
        'Enum':      '#f97316',
        'Module':    '#6366f1',
        'Namespace': '#6366f1',
        'Struct':    '#f59e0b',
        'Ctor':      '#8b5cf6',
        'Global':    '#6b7280',
      };
      return kindColors[kind] || null;
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

      // Compute widths
      const nodeMap = {};
      for (const n of gNodes) {
        nodeMap[n.id] = n;
        const isRootNode = n.id === '__root__';
        const prefix = nodeKindPrefix(n.kind);
        const displayLabel = prefix + ' ' + stripParams(n.label);
        const labelW = gTextWidth(displayLabel, isRootNode ? ('bold ' + font) : font);
        n.w = G_PAD_X * 2 + labelW;
        if (n.w < 60) n.w = 60;
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

      // Position: X by level, Y spread vertically
      let xOffset = 40;
      for (let lv = 0; lv <= maxLevel; lv++) {
        const group = byLevel[lv] || [];
        let maxW = 0;
        for (const n of group) {
          if (n.w > maxW) maxW = n.w;
        }
        const totalH = group.length * G_NODE_H + (group.length - 1) * G_SIBLING_GAP_Y;
        let yStart = (ch / 2) - (totalH / 2);
        for (let i = 0; i < group.length; i++) {
          group[i].x = xOffset;
          group[i].y = yStart + i * (G_NODE_H + G_SIBLING_GAP_Y);
        }
        xOffset += maxW + G_LEVEL_GAP_X;
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

      const fg = getComputedStyle(document.body).color || '#d4d4d4';
      const dimColor = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#858585';
      const accentColor = getComputedStyle(document.body).getPropertyValue('--vscode-panelTitle-activeBorder') || '#007acc';
      const nodeBg = getComputedStyle(document.body).getPropertyValue('--vscode-sideBarSectionHeader-background') || '#252526';
      const hoverBg = getComputedStyle(document.body).getPropertyValue('--vscode-list-hoverBackground') || 'rgba(255,255,255,0.05)';
      const badgeBg = getComputedStyle(document.body).getPropertyValue('--vscode-badge-background') || '#4d4d4d';
      const badgeFg = getComputedStyle(document.body).getPropertyValue('--vscode-badge-foreground') || '#fff';
      const funcColor = getComputedStyle(document.body).getPropertyValue('--vscode-symbolIcon-functionForeground') || '#dcdcaa';

      // Draw edges
      ctx.strokeStyle = dimColor;
      ctx.lineWidth = 1.2;
      for (const e of gEdges) {
        const from = nodeMap[e.from];
        const to = nodeMap[e.to];
        if (!from || !to) continue;
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        const cpx = (x1 + x2) / 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(cpx, y1, cpx, y2, x2, y2);
        ctx.stroke();

        // Arrow head
        const arrowSize = 5;
        const angle = Math.atan2(y2 - (y1 + y2) / 2, x2 - cpx);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(angle - 0.4), y2 - arrowSize * Math.sin(angle - 0.4));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(angle + 0.4), y2 - arrowSize * Math.sin(angle + 0.4));
        ctx.stroke();
      }

      // Draw nodes
      const fontSize = 12;
      const font = fontSize + 'px ' + getComputedStyle(document.body).fontFamily;
      for (const n of gNodes) {
        const isHover = gHover === n.id;
        const isRoot = n.id === '__root__';

        // Node shape: all use rounded rectangle, kind distinguished by prefix icon
        const kindBorderColor = nodeKindColor(n.kind) || dimColor;
        ctx.fillStyle = isHover ? (hoverBg.includes('rgba') ? 'rgba(255,255,255,0.1)' : hoverBg) : nodeBg;
        ctx.strokeStyle = isRoot ? accentColor : (isHover ? accentColor : kindBorderColor);
        ctx.lineWidth = isRoot ? 2.5 : 1.5;
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
          const cx = n.x + n.w + 10;
          const cy = n.y + n.h / 2;
          const t = (Date.now() % 1000) / 1000 * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, t, t + Math.PI * 1.2);
          ctx.stroke();
          if (!gAnimFrame) {
            gAnimFrame = requestAnimationFrame(() => { gAnimFrame = null; graphDraw(); });
          }
        }

        // Expand indicator (small +/- badge)
        if (n.id !== '__root__' && !n.data?.nodeId?.startsWith('leaf_')) {
          const badgeR = 6;
          const bx = n.x + n.w + 2;
          const by = n.y + n.h / 2;
          ctx.fillStyle = badgeBg;
          ctx.beginPath();
          ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = badgeFg;
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.expanded ? '−' : '+', bx, by);
        }

        // Label with kind prefix (centered, single row)
        const prefix = nodeKindPrefix(n.kind);
        const displayLabel = prefix + ' ' + stripParams(n.label);
        ctx.font = isRoot ? ('bold ' + font) : font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Draw prefix in kind color, label in function color
        const prefixW = gTextWidth(prefix + ' ', ctx.font);
        const labelW = gTextWidth(displayLabel, ctx.font);
        const labelStartX = ncx - labelW / 2;
        ctx.fillStyle = kindBorderColor;
        ctx.textAlign = 'left';
        ctx.fillText(prefix, labelStartX, ncy);
        ctx.fillStyle = isRoot ? accentColor : funcColor;
        ctx.fillText(stripParams(n.label), labelStartX + prefixW, ncy);
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
      for (const item of items) {
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
        });
        parent.children.push(nid);
        gEdges.push({ from: parentNodeId, to: nid });
      }

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
      // Also remove from loadedNodes
      for (const rid of toRemove) loadedNodes.delete(rid);
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
      if (newHover !== gHover) {
        gHover = newHover;
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
        if (hit.id === '__root__') return;
        if (hit.data && hit.data.nodeId && hit.data.nodeId.startsWith('leaf_')) return;

        if (hit.expanded) {
          graphCollapse(hit);
          graphLayout();
          graphDraw();
        } else {
          if (loadedNodes.has(hit.id)) return;
          hit.loading = true;
          graphDraw();
          let msgType = hit.id.startsWith('c') ? 'expandIncoming' : 'expandRef';
          vscodeApi.postMessage({ type: msgType, nodeId: hit.id });
        }
        return;
      }

      // Single click: update peek view only (do NOT open editor)
      if (e.detail === 1 && hit.data) {
        vscodeApi.postMessage({
          type: 'peekOnly',
          uri: hit.data.uri,
          line: hit.data.callLine != null ? hit.data.callLine : hit.data.line,
          character: hit.data.callCharacter != null ? hit.data.callCharacter : hit.data.character,
        });
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
      vscodeApi.postMessage({
        type: 'jumpTo',
        uri: hit.data.uri,
        line: hit.data.callLine != null ? hit.data.callLine : hit.data.line,
        character: hit.data.callCharacter != null ? hit.data.callCharacter : hit.data.character,
      });
    });

    // Resize observer for canvas
    const resizeObs = new ResizeObserver(() => {
      if (viewMode === 'graph' && lastUpdateData) {
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
