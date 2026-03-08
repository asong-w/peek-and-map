import * as vscode from 'vscode';
import * as path from 'path';
import { LANG_MAP } from './constants';
import { ContextInfo } from './types';
import { getNonce } from './utils';
import { generateThemeTokenCss, generateSymbolKindCss } from './theme';

export class PeekViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'peekView.view';

  private _view?: vscode.WebviewView;
  private _lastUri?: string;
  private _lastVersion?: number;
  private _lastLine?: number;

  // Tracks the last text editor that had focus.
  // When the Context panel is clicked, the editor loses focus and
  // vscode.window.activeTextEditor becomes undefined; we fall back to
  // this cached reference so updates still work while the panel is active.
  private _lastKnownEditor?: vscode.TextEditor;

  // ── Navigation history (back / forward) ──────────────────────────────────
  private _navBackStack: ContextInfo[] = [];
  private _navForwardStack: ContextInfo[] = [];
  private _currentNavEntry?: ContextInfo;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Called externally whenever the active editor or cursor changes. */
  notifyEditorChange(editor: vscode.TextEditor | undefined): void {
    if (editor) {
      this._lastKnownEditor = editor;
    }
    this.update();
  }

  /** Push current theme token colors to the webview. */
  pushThemeColors(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'themeColors',
      css: generateThemeTokenCss() + generateSymbolKindCss(),
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      // Allow serving files from the whole extension directory (includes media/)
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // ── Messages from webview ──────────────────────────────────────────────
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        // Webview sends 'ready' as the very first thing its inline script does.
        // This is the earliest safe moment to push content into it.
        case 'ready':
          this._resetDedup();
          this.pushThemeColors();
          this.update();
          break;

        // User clicked a line number → navigate to definition location (cross-file)
        case 'jumpToLine': {
          const line = Math.max(0, msg.line as number);
          const pos  = new vscode.Position(line, 0);
          // msg.uri is the definition file's vscode URI; fall back to current editor
          const targetUri = msg.uri
            ? vscode.Uri.parse(msg.uri as string)
            : (vscode.window.activeTextEditor ?? this._lastKnownEditor)?.document.uri;
          if (targetUri) {
            const targetDoc = await vscode.workspace.openTextDocument(targetUri);
            const targetEditor = await vscode.window.showTextDocument(targetDoc, {
              preserveFocus: false,
              preview: false,
            });
            targetEditor.selection = new vscode.Selection(pos, pos);
            targetEditor.revealRange(
              new vscode.Range(pos, pos),
              vscode.TextEditorRevealType.InCenterIfOutsideViewport
            );
          }
          break;
        }

        // Ctrl+click on a token in the context view → resolve definition and
        // navigate *within* the context view itself.
        case 'ctrlClick': {
          const clickLine = msg.line as number;
          const clickChar = msg.character as number;
          const clickUri  = msg.uri
            ? vscode.Uri.parse(msg.uri as string)
            : undefined;
          if (!clickUri) { break; }

          const clickPos = new vscode.Position(clickLine, clickChar);
          try {
            type DefResult = vscode.Location | vscode.LocationLink;
            const defs = await vscode.commands.executeCommand<DefResult[]>(
              'vscode.executeDefinitionProvider',
              clickUri,
              clickPos
            );
            if (defs && defs.length > 0) {
              const loc   = defs[0];
              const isLink = 'targetUri' in loc;
              const defUri  = isLink
                ? (loc as vscode.LocationLink).targetUri
                : (loc as vscode.Location).uri;
              const defRange = isLink
                ? ((loc as vscode.LocationLink).targetSelectionRange ?? (loc as vscode.LocationLink).targetRange)
                : (loc as vscode.Location).range;
              const ctx = await this._getContextFromLocation(defUri, defRange.start);
              if (ctx) {
                // Push current entry onto back stack before navigating
                if (this._currentNavEntry) {
                  this._navBackStack.push(this._currentNavEntry);
                }
                this._navForwardStack = [];
                this._currentNavEntry = ctx;
                this._view!.webview.postMessage({ type: 'update', data: ctx });
                this._sendNavState();
              }
            }
          } catch { /* no provider */ }
          break;
        }

        // Navigation: back / forward
        case 'navBack': {
          if (this._navBackStack.length === 0) { break; }
          if (this._currentNavEntry) {
            this._navForwardStack.push(this._currentNavEntry);
          }
          this._currentNavEntry = this._navBackStack.pop()!;
          this._view!.webview.postMessage({ type: 'update', data: this._currentNavEntry });
          this._sendNavState();
          break;
        }
        case 'navForward': {
          if (this._navForwardStack.length === 0) { break; }
          if (this._currentNavEntry) {
            this._navBackStack.push(this._currentNavEntry);
          }
          this._currentNavEntry = this._navForwardStack.pop()!;
          this._view!.webview.postMessage({ type: 'update', data: this._currentNavEntry });
          this._sendNavState();
          break;
        }
      }
    });

    // Re-render when the panel re-appears
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._resetDedup();
        this.update();
      }
    });
  }

  async update(): Promise<void> {
    if (!this._view || !this._view.visible) {
      return;
    }

    // Prefer live active editor; fall back to last known (panel has focus)
    const editor = vscode.window.activeTextEditor ?? this._lastKnownEditor;
    if (!editor) {
      this._sendEmpty('无打开的编辑器');
      return;
    }

    const doc = editor.document;
    const cursor = editor.selection.active;
    const cursorLine = cursor.line;

    // Skip redundant work
    const key = doc.uri.toString();
    if (
      key === this._lastUri &&
      doc.version === this._lastVersion &&
      cursorLine === this._lastLine
    ) {
      return;
    }
    this._lastUri = key;
    this._lastVersion = doc.version;
    this._lastLine = cursorLine;

    // ── Step 1: definition of the symbol UNDER the cursor ─────────────────
    // Core behavior: cursor on `foo()` → show foo's body.
    type DefResult = vscode.Location | vscode.LocationLink;
    let defLocations: DefResult[] = [];
    try {
      const result = await vscode.commands.executeCommand<DefResult[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        cursor
      );
      if (result && result.length > 0) {
        defLocations = result;
      }
    } catch {
      // No definition provider for this language
    }

    if (defLocations.length > 0) {
      const loc = defLocations[0];
      const isLink = 'targetUri' in loc;
      const defUri  = isLink ? (loc as vscode.LocationLink).targetUri  : (loc as vscode.Location).uri;
      // Prefer targetSelectionRange (tighter), fall back to targetRange / range
      const defRange = isLink
        ? ((loc as vscode.LocationLink).targetSelectionRange ?? (loc as vscode.LocationLink).targetRange)
        : (loc as vscode.Location).range;
      const defPos = defRange.start;

      const ctx = await this._getContextFromLocation(defUri, defPos);
      if (ctx) {
        // Normal cursor-driven update resets the navigation history
        this._navBackStack = [];
        this._navForwardStack = [];
        this._currentNavEntry = ctx;
        this._view.webview.postMessage({ type: 'update', data: ctx });
        this._sendNavState();
        return;
      }
    }

    // No definition found — keep the current content unchanged.
    // (Do NOT fall back to showing the enclosing symbol.)
  }

  /**
   * Directly show the symbol at (uri, pos) in the peek view without changing
   * the active editor.  Called by MapViewProvider on single-click.
   */
  async peekLocation(uri: vscode.Uri, pos: vscode.Position): Promise<void> {
    if (!this._view) { return; }
    const ctx = await this._getContextFromLocation(uri, pos);
    if (ctx) {
      if (this._currentNavEntry) {
        this._navBackStack.push(this._currentNavEntry);
      }
      this._navForwardStack = [];
      this._currentNavEntry = ctx;
      this._view.webview.postMessage({ type: 'update', data: ctx });
      this._sendNavState();
    }
  }

  /**
   * Open `uri`, resolve its document symbols, find the symbol that contains
   * `pos`, and return a ContextInfo for display.  If no symbol covers `pos`
   * (e.g. a .d.ts forward declaration with no body), fall back to the
   * surrounding lines.
   */
  private async _getContextFromLocation(
    uri: vscode.Uri,
    pos: vscode.Position
  ): Promise<ContextInfo | null> {
    let defDoc: vscode.TextDocument;
    try {
      defDoc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return null;
    }

    // Try to get symbols, with one retry for slow language servers
    let symbols: vscode.DocumentSymbol[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri
        );
        if (result && result.length > 0) { symbols = result; break; }
      } catch {}
      if (attempt === 0 && symbols.length === 0) {
        await new Promise<void>((r) => setTimeout(r, 600));
      }
    }

    const fileName = path.basename(uri.fsPath);
    const defUriStr = uri.toString();

    const padding = vscode.workspace
      .getConfiguration('peekView')
      .get<number>('contextPadding', 30);

    const best = this._deepestContainingWithAncestors(symbols, pos);
    if (best) {
      const ownerClass =
        this._nearestOwnerClassName(best.ancestors) ??
        this._inferCppOwnerClass(best.symbol.name, defDoc.lineAt(best.symbol.selectionRange.start.line).text, defDoc.languageId);
      const { code, startLine } = this._expandedText(defDoc, best.symbol.range, padding);
      return {
        code,
        language: LANG_MAP[defDoc.languageId] ?? 'clike',
        startLine,
        cursorLine: pos.line,
        symbolName: this._formatSymbolWithOwner(best.symbol.name, ownerClass, best.symbol.kind),
        symbolKind: this._kindName(best.symbol.kind),
        filePath: uri.fsPath,
        defUri: defUriStr,
        fileName,
      };
    }

    // No symbol wraps the position (header / declaration-only file).
    // Show a window of lines around the definition point.
    // Use a larger default window here so macros / one-liners still get context.
    const fallbackPadding = Math.max(padding, 5);
    const startLine = Math.max(0, pos.line - fallbackPadding);
    const endLine   = Math.min(defDoc.lineCount - 1, pos.line + Math.max(fallbackPadding, 40));
    const range = new vscode.Range(
      startLine, 0,
      endLine, defDoc.lineAt(endLine).text.length
    );
    return {
      code: defDoc.getText(range),
      language: LANG_MAP[defDoc.languageId] ?? 'clike',
      startLine,
      cursorLine: pos.line,
      symbolName: fileName,
      symbolKind: 'File',
      filePath: uri.fsPath,
      defUri: defUriStr,
      fileName,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _resetDedup(): void {
    this._lastUri = undefined;
    this._lastVersion = undefined;
    this._lastLine = undefined;
  }

  private _findContext(
    doc: vscode.TextDocument,
    cursor: vscode.Position,
    symbols: vscode.DocumentSymbol[]
  ): ContextInfo | null {
    const best = this._deepestContainingWithAncestors(symbols, cursor);
    if (!best) { return null; }
    const ownerClass =
      this._nearestOwnerClassName(best.ancestors) ??
      this._inferCppOwnerClass(best.symbol.name, doc.lineAt(best.symbol.selectionRange.start.line).text, doc.languageId);
    const padding = vscode.workspace
      .getConfiguration('peekView')
      .get<number>('contextPadding', 30);
    const { code, startLine } = this._expandedText(doc, best.symbol.range, padding);
    return {
      code,
      language: LANG_MAP[doc.languageId] ?? 'clike',
      startLine,
      cursorLine: cursor.line,
      symbolName: this._formatSymbolWithOwner(best.symbol.name, ownerClass, best.symbol.kind),
      symbolKind: this._kindName(best.symbol.kind),
      filePath: doc.uri.fsPath,
      defUri: doc.uri.toString(),
      fileName: path.basename(doc.uri.fsPath),
    };
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

  private _formatSymbolWithOwner(name: string, ownerClass: string | undefined, _kind: vscode.SymbolKind): string {
    if (!ownerClass) { return name; }
    return `${ownerClass}::${name}`;
  }

  /**
   * Extract text from `doc` covering `range` extended by `padding` lines
   * above and below.  Returns the text and the adjusted start line number.
   */
  private _expandedText(
    doc: vscode.TextDocument,
    range: vscode.Range,
    padding: number
  ): { code: string; startLine: number } {
    const startLine = Math.max(0, range.start.line - padding);
    const endLine   = Math.min(doc.lineCount - 1, range.end.line + padding);
    const expanded  = new vscode.Range(
      startLine, 0,
      endLine, doc.lineAt(endLine).text.length
    );
    return { code: doc.getText(expanded), startLine };
  }

  private _rangeSize(r: vscode.Range): number {
    return (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
  }

  private _kindName(kind: vscode.SymbolKind): string {
    const names: Partial<Record<vscode.SymbolKind, string>> = {
      [vscode.SymbolKind.File]: 'File',
      [vscode.SymbolKind.Module]: 'Module',
      [vscode.SymbolKind.Namespace]: 'Namespace',
      [vscode.SymbolKind.Class]: 'Class',
      [vscode.SymbolKind.Method]: 'Method',
      [vscode.SymbolKind.Property]: 'Property',
      [vscode.SymbolKind.Field]: 'Field',
      [vscode.SymbolKind.Constructor]: 'Constructor',
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

  /** Send current navigation stack state so webview can enable/disable buttons. */
  private _sendNavState(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'navState',
      canBack: this._navBackStack.length > 0,
      canForward: this._navForwardStack.length > 0,
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    // Resolve local resource URIs through VS Code's resource proxy
    const mediaDir    = vscode.Uri.joinPath(this._extensionUri, 'media');
    const prismJs     = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'prism.js'));
    const autoloader  = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'prism-autoloader.min.js'));
    // Language components path for the autoloader (trailing slash required)
    const componentsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'components')).toString() + '/';
    const initialThemeCss = generateThemeTokenCss() + generateSymbolKindCss();

    return /* html */`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src 'unsafe-inline' ${webview.cspSource};
                 script-src 'nonce-${nonce}' ${webview.cspSource};
                 font-src ${webview.cspSource};" />
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

    #header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      min-height: 28px;
      user-select: none;
    }

    #kind-badge {
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

    #symbol-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    #symbol-name .owner {
      color: var(--peek-qualified-owner, var(--peek-kind-Class, var(--vscode-symbolIcon-classForeground, var(--vscode-editor-foreground, #d4d4d4))));
    }
    #symbol-name .scope-op {
      color: var(--peek-operator, var(--vscode-editor-foreground, #d4d4d4));
    }

    #file-name {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, #858585);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
      flex-shrink: 0;
    }

    /* ── Header navigation buttons ────────────────────────────────── */
    .nav-btn {
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      background: transparent;
      color: var(--vscode-foreground, #ccc);
      border: none;
      border-radius: 3px;
      flex-shrink: 0;
      transition: background 0.15s;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
    }
    .nav-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }
    .nav-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .nav-btn svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    #empty-msg {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-disabledForeground, #858585);
      font-size: 12px;
      font-style: italic;
    }

    #code-container {
      flex: 1;
      overflow: auto;
      font-size: var(--ctx-font-size, inherit);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    col.num-col { width: 52px; }

    .line-num {
      padding: 0 10px 0 8px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #858585);
      font-size: 0.85em;
      user-select: none;
      cursor: pointer;
      white-space: nowrap;
      vertical-align: top;
      line-height: 1.5;
    }
    .line-num:hover {
      color: var(--vscode-editorLineNumber-activeForeground, #c6c6c6);
      text-decoration: underline;
    }

    .line-code {
      padding: 0 8px;
      white-space: pre;
      font-family: inherit;
      font-size: inherit;
      line-height: 1.5;
      vertical-align: top;
    }

    tr.cursor-line {
      background: var(--vscode-editor-lineHighlightBackground,
                       rgba(255,255,255,0.07));
    }
    tr.cursor-line .line-num {
      color: var(--vscode-editorLineNumber-activeForeground, #c6c6c6);
      font-weight: bold;
    }

    /* ── Prism base reset ─────────────────────────────────────────── */
    code[class*="language-"],
    pre[class*="language-"] {
      background: transparent !important;
      font-family: inherit;
      font-size: inherit;
      text-shadow: none !important;
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    .token { color: var(--vscode-editor-foreground, #d4d4d4); }

    /* Ctrl+hover: show underline on clickable tokens */
    body.ctrl-held .line-code .token:hover {
      text-decoration: underline;
      cursor: pointer;
    }
  </style>
  <!-- Dynamic theme token colors (updated via postMessage on theme change) -->
  <style id="theme-tokens">${initialThemeCss}</style>
</head>
<body>
  <div id="header">
    <button class="nav-btn" id="nav-back-btn" disabled title="后退 (鼠标侧键)"><svg viewBox="0 0 16 16"><polyline points="10,2 4,8 10,14"/></svg></button>
    <button class="nav-btn" id="nav-forward-btn" disabled title="前进 (鼠标侧键)"><svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg></button>
    <span id="kind-badge">—</span>
    <span id="symbol-name">Peek View</span>
    <span id="file-name"></span>
  </div>
  <div id="empty-msg">初始化中...</div>
  <div id="code-container" style="display:none"></div>

  <!-- Prism 全部来自本地 media/ 目录，无需网络 -->
  <script nonce="${nonce}" src="${prismJs}"></script>
  <script nonce="${nonce}" src="${autoloader}"></script>

  <script nonce="${nonce}">
    // ── 指定 autoloader 从本地加载语言组件 ─────────────────────────────────
    if (typeof Prism !== 'undefined' && Prism.plugins && Prism.plugins.autoloader) {
      Prism.plugins.autoloader.languages_path = '${componentsUri}';
    }

    const vscodeApi = acquireVsCodeApi();

    // ── 立即通知扩展 webview 已就绪 ─────────────────────────────────────────
    // 此代码在 DOM 解析完成后同步运行，是向扩展发送消息的最早时机。
    // 本地脚本加载极快，但即使外部脚本延迟，ready 也会第一时间发出。
    vscodeApi.postMessage({ type: 'ready' });

    // ── DOM 引用 ─────────────────────────────────────────────────────────────
    const kindBadge     = document.getElementById('kind-badge');
    const symbolNameEl  = document.getElementById('symbol-name');
    const emptyMsg      = document.getElementById('empty-msg');
    const codeContainer = document.getElementById('code-container');

    const navBackBtn    = document.getElementById('nav-back-btn');
    const navForwardBtn = document.getElementById('nav-forward-btn');

    let currentCursorLine  = 0;
    let currentDefUri      = null; // vscode URI string of the definition file
    let currentSymbolKind  = null; // last displayed symbol kind
    let pendingRenderArgs  = null; // 等待语法高亮组件加载完成后重绘

    // ── 前进 / 后退按钮 ─────────────────────────────────────────────────────
    navBackBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'navBack' });
    });
    navForwardBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'navForward' });
    });

    // ── 鼠标侧键（后退=3，前进=4）──────────────────────────────────────────
    document.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navBack' });
      } else if (e.button === 4) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navForward' });
      }
    });

    // ── Kind symbol / color helpers (mirrors mapView) ───────────────────────
    function kindSymbol(kind) {
      const map = {
        'Function':    'f',
        'Method':      'm',
        'Class':       'C',
        'Interface':   'I',
        'Variable':    'v',
        'Constant':    'c',
        'Property':    'p',
        'Field':       'F',
        'Enum':        'E',
        'Module':      'M',
        'Namespace':   'N',
        'Struct':      'S',
        'Constructor': 'K',
        'File':        '~',
      };
      return map[kind] || '?';
    }

    function hexToRgba(hex, alpha) {
      const h = hex.replace('#', '');
      if (h.length < 6) { return hex; }
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function kindColor(kind) {
      // Read the CSS var injected from the real TextMate theme (see generateSymbolKindCss).
      const v = getComputedStyle(document.documentElement).getPropertyValue('--peek-kind-' + kind).trim();
      return v || null;
    }

    function applyKindColors(kind) {
      const color = kindColor(kind);
      kindBadge.style.color           = color || 'var(--vscode-foreground, #ccc)';
      kindBadge.style.backgroundColor = color ? hexToRgba(color, 0.18) : 'var(--vscode-badge-background, rgba(100,100,100,0.25))';
      symbolNameEl.style.color        = '';
    }

    function splitQualifiedName(name) {
      const s = (name || '').trim();
      const idx = s.lastIndexOf('::');
      if (idx <= 0 || idx + 2 >= s.length) return null;
      return { owner: s.slice(0, idx), member: s.slice(idx + 2) };
    }

    function renderHeaderSymbolName(name, symbolKind) {
      const part = splitQualifiedName(name || '');
      const kindKey = symbolKind === 'Ctor' ? 'Constructor' : (symbolKind || 'Function');
      const memberColor = kindColor(kindKey) || 'var(--vscode-editor-foreground, #d4d4d4)';
      if (!part) {
        return '<span style="color:' + memberColor + '">' + escapeHtml(name || '') + '</span>';
      }
      return '<span class="owner">' + escapeHtml(part.owner) + '</span>'
        + '<span class="scope-op">::</span>'
        + '<span style="color:' + memberColor + '">' + escapeHtml(part.member) + '</span>';
    }

    // ── 接收来自扩展的消息 ────────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'empty') {
        emptyMsg.textContent        = msg.message;
        emptyMsg.style.display      = 'flex';
        codeContainer.style.display = 'none';
        kindBadge.textContent            = '—';
        kindBadge.style.color           = '';
        kindBadge.style.backgroundColor = '';
        symbolNameEl.textContent        = 'Peek View';
        symbolNameEl.style.color    = '';
        currentSymbolKind           = null;
        document.getElementById('file-name').textContent = '';
        return;
      }

      if (msg.type === 'themeColors') {
        document.getElementById('theme-tokens').textContent = msg.css;
        if (currentSymbolKind) { applyKindColors(currentSymbolKind); }
        return;
      }

      if (msg.type === 'navState') {
        navBackBtn.disabled    = !msg.canBack;
        navForwardBtn.disabled = !msg.canForward;
        return;
      }

      if (msg.type === 'update') {
        const { code, language, startLine, cursorLine,
                symbolName, symbolKind, fileName, defUri } = msg.data;
        currentCursorLine = cursorLine;
        currentDefUri     = defUri || null;

        kindBadge.textContent    = kindSymbol(symbolKind);
        symbolNameEl.innerHTML = renderHeaderSymbolName(symbolName, symbolKind);
        currentSymbolKind = symbolKind;
        applyKindColors(symbolKind);
        document.getElementById('file-name').textContent = fileName ? '  ' + fileName + ':' + (cursorLine + 1) : '';
        emptyMsg.style.display      = 'none';
        codeContainer.style.display = 'block';

        renderCode(code, language, startLine, cursorLine);
      }
    });

    // ── 渲染 ─────────────────────────────────────────────────────────────────
    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function buildTable(hlLines, language, startLine, cursorLine) {
      let html = '<table><colgroup><col class="num-col"><col></colgroup><tbody>';
      for (let i = 0; i < hlLines.length; i++) {
        const absLine    = startLine + i;
        const isCursor   = absLine === cursorLine;
        const rowClass   = isCursor ? ' class="cursor-line"' : '';
        const displayNum = absLine + 1;
        html += '<tr' + rowClass + ' data-line="' + absLine + '">'
          + '<td class="line-num">' + displayNum + '</td>'
          + '<td class="line-code"><code class="language-' + language + '">'
          + hlLines[i] + '</code></td></tr>';
      }
      html += '</tbody></table>';
      return html;
    }

    function renderCode(code, language, startLine, cursorLine) {
      const prismReady = typeof Prism !== 'undefined';
      const grammar    = prismReady && Prism.languages[language];

      if (!grammar && prismReady && Prism.plugins && Prism.plugins.autoloader) {
        // 语言组件尚未加载：先用纯文本渲染，然后异步加载语法并重绘
        const plainLines = escapeHtml(code).split('\\n');
        codeContainer.innerHTML = buildTable(plainLines, language, startLine, cursorLine);
        attachLineClicks();
        scrollCursorIntoView();

        pendingRenderArgs = [code, language, startLine, cursorLine];
        Prism.plugins.autoloader.loadLanguages(language, function () {
          if (pendingRenderArgs && pendingRenderArgs[1] === language) {
            const args = pendingRenderArgs;
            pendingRenderArgs = null;
            renderHighlighted(args[0], args[1], args[2], args[3]);
          }
        });
        return;
      }

      renderHighlighted(code, language, startLine, cursorLine);
    }

    function renderHighlighted(code, language, startLine, cursorLine) {
      let highlighted;
      try {
        const grammar = (typeof Prism !== 'undefined')
          ? (Prism.languages[language] || Prism.languages.clike)
          : null;
        highlighted = grammar
          ? Prism.highlight(code, grammar, language)
          : escapeHtml(code);
      } catch (e) {
        highlighted = escapeHtml(code);
      }

      codeContainer.innerHTML = buildTable(highlighted.split('\\n'), language, startLine, cursorLine);
      attachLineClicks();
      scrollCursorIntoView();
    }

    function attachLineClicks() {
      codeContainer.querySelectorAll('.line-num').forEach((td) => {
        td.addEventListener('click', () => {
          const line = parseInt(td.closest('tr').dataset.line, 10);
          vscodeApi.postMessage({ type: 'jumpToLine', line, uri: currentDefUri });
        });
      });
    }

    // ── Ctrl+click: 在 context 窗口内跳转定义 ────────────────────────────
    // 跟踪 Ctrl 键状态以显示下划线提示
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Control') { document.body.classList.add('ctrl-held'); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Control') { document.body.classList.remove('ctrl-held'); }
    });
    window.addEventListener('blur', () => {
      document.body.classList.remove('ctrl-held');
    });

    codeContainer.addEventListener('click', (e) => {
      if (!e.ctrlKey) { return; }
      const row = e.target.closest('tr[data-line]');
      if (!row) { return; }
      // 不处理行号列
      if (e.target.closest('.line-num')) { return; }

      const line = parseInt(row.dataset.line, 10);
      // 利用 caretRangeFromPoint 计算点击在源码行中的字符偏移
      let character = 0;
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range) {
        const codeCell = row.querySelector('.line-code');
        const walker = document.createTreeWalker(codeCell, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if (node === range.startContainer) {
            character += range.startOffset;
            break;
          }
          character += node.textContent.length;
        }
      }

      e.preventDefault();
      vscodeApi.postMessage({ type: 'ctrlClick', line, character, uri: currentDefUri });
    });

    // 双击空白处 → 跳转到编辑器；双击代码文本 → 正常选中
    codeContainer.addEventListener('dblclick', (e) => {
      const row = e.target.closest('tr[data-line]');
      if (!row) { return; }
      // 行号列双击 → 跳转
      if (e.target.closest('.line-num')) {
        const line = parseInt(row.dataset.line, 10);
        vscodeApi.postMessage({ type: 'jumpToLine', line, uri: currentDefUri });
        return;
      }
      // 如果双击选中了实际文字，当作正常选中，不跳转
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) { return; }
      // 空白区域双击 → 跳转到编辑器
      const line = parseInt(row.dataset.line, 10);
      vscodeApi.postMessage({ type: 'jumpToLine', line, uri: currentDefUri });
    });

    // ── Ctrl+滚轮控制字体大小 ─────────────────────────────────────────────
    const MIN_FONT_SIZE = 8;
    const MAX_FONT_SIZE = 40;
    const FONT_SIZE_STEP = 1;
    // 从 webview state 恢复或使用默认值
    let ctxFontSize = (vscodeApi.getState() && vscodeApi.getState().fontSize) || 0;
    if (ctxFontSize) {
      codeContainer.style.setProperty('--ctx-font-size', ctxFontSize + 'px');
    }

    document.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) { return; }
      e.preventDefault();

      // 首次缩放时读取当前计算字体大小作为基准
      if (!ctxFontSize) {
        ctxFontSize = parseFloat(getComputedStyle(codeContainer).fontSize) || 13;
      }

      const oldSize = ctxFontSize;
      if (e.deltaY < 0) {
        ctxFontSize = Math.min(MAX_FONT_SIZE, ctxFontSize + FONT_SIZE_STEP);
      } else {
        ctxFontSize = Math.max(MIN_FONT_SIZE, ctxFontSize - FONT_SIZE_STEP);
      }
      if (ctxFontSize === oldSize) { return; }

      // 记录当前滚动位置，按字体比例调整，保持第一行不变
      const scrollTop = codeContainer.scrollTop;
      const ratio = ctxFontSize / oldSize;

      codeContainer.style.setProperty('--ctx-font-size', ctxFontSize + 'px');
      codeContainer.scrollTop = scrollTop * ratio;

      vscodeApi.setState({ ...(vscodeApi.getState() || {}), fontSize: ctxFontSize });
    }, { passive: false });

    function scrollCursorIntoView() {
      const row = codeContainer.querySelector('tr.cursor-line');
      if (row) {
        row.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    }
  </script>
</body>
</html>`;
  }
}
