import * as vscode from 'vscode';
import * as path from 'path';
import { LANG_MAP } from './constants';
import { ContextInfo, PeekContextBundle } from './types';
import { getNonce } from './utils';
import { buildKindIconFunction, getThemeColorsCss, symbolKindToName } from './viewCommon';

export class PeekViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'peekView.view';

  private _view?: vscode.WebviewView;
  private _lastUri?: string;
  private _lastVersion?: number;
  private _lastLine?: number;
  private _isLocked = false;

  // Tracks the last text editor that had focus.
  // When the Context panel is clicked, the editor loses focus and
  // vscode.window.activeTextEditor becomes undefined; we fall back to
  // this cached reference so updates still work while the panel is active.
  private _lastKnownEditor?: vscode.TextEditor;

  // ── Navigation history ring (back / forward) ─────────────────────────────
  // New entries are always appended by cursor-driven updates and in-view jumps.
  // When capacity is reached, the oldest entry is overwritten (ring semantics).
  private _navHistoryRing: PeekContextBundle[] = [];
  private _navHistoryIndex = -1;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Called externally whenever the active editor or cursor changes. */
  notifyEditorChange(editor: vscode.TextEditor | undefined): void {
    if (editor) {
      this._lastKnownEditor = editor;
    }
    this.update({ editorDriven: true });
  }

  /** Push current theme token colors to the webview. */
  pushThemeColors(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'themeColors',
      css: getThemeColorsCss(),
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
          this._sendLockState();
          this.update();
          break;

        case 'toggleLock': {
          this._isLocked = Boolean(msg.locked);
          this._sendLockState();
          if (!this._isLocked) {
            this._resetDedup();
            this.update();
          }
          break;
        }

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
            const bundle = await this._resolveDefinitionBundle(defs ?? []);
            if (bundle) {
              this._appendCurrentBundle(bundle);
            }
          } catch { /* no provider */ }
          break;
        }

        // Navigation: back / forward
        case 'navBack': {
          this._moveHistory(-1);
          break;
        }
        case 'navForward': {
          this._moveHistory(1);
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

  async update(options: { editorDriven?: boolean } = {}): Promise<void> {
    if (!this._view || !this._view.visible) {
      return;
    }

    if (options.editorDriven && this._isLocked) {
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
      const bundle = await this._resolveDefinitionBundle(defLocations);
      if (bundle) {
        this._appendCurrentBundle(bundle);
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
      this._appendCurrentContext(ctx);
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
      const anchorLine = best.symbol.range.start.line;
      const { code, startLine } = this._expandedText(defDoc, best.symbol.range, padding);
      return {
        code,
        language: LANG_MAP[defDoc.languageId] ?? 'clike',
        startLine,
        cursorLine: anchorLine,
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
    return symbolKindToName(kind);
  }

  private _sendEmpty(msg: string): void {
    this._view?.webview.postMessage({ type: 'empty', message: msg });
  }

  private _sendLockState(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({ type: 'lockState', locked: this._isLocked });
  }

  private async _resolveDefinitionBundle(defs: Array<vscode.Location | vscode.LocationLink>): Promise<PeekContextBundle | null> {
    const contexts: ContextInfo[] = [];
    const seen = new Set<string>();

    for (const loc of defs) {
      const isLink = 'targetUri' in loc;
      const defUri = isLink ? (loc as vscode.LocationLink).targetUri : (loc as vscode.Location).uri;
      // Use the start of the declaration when available so Peek lands at the
      // beginning of the definition block instead of the symbol's selection.
      const defRange = isLink
        ? ((loc as vscode.LocationLink).targetSelectionRange ?? (loc as vscode.LocationLink).targetRange)
        : (loc as vscode.Location).range;
      if (!defRange) { continue; }

      const focusPos = isLink && (loc as vscode.LocationLink).targetRange
        ? (loc as vscode.LocationLink).targetRange.start
        : defRange.start;

      const key = `${defUri.toString()}|${defRange.start.line}:${defRange.start.character}`;
      if (seen.has(key)) { continue; }
      seen.add(key);

      const ctx = await this._getContextFromLocation(defUri, focusPos);
      if (ctx) {
        contexts.push(ctx);
      }
    }

    if (contexts.length === 0) {
      return null;
    }
    return { contexts, selectedIndex: 0 };
  }

  private _appendCurrentContext(next: ContextInfo): void {
    this._appendCurrentBundle({ contexts: [next], selectedIndex: 0 });
  }

  private _appendCurrentBundle(next: PeekContextBundle): void {
    if (!this._view) { return; }

    const normalized = this._normalizeBundle(next);

    // If we are currently in the middle of history (after going back),
    // appending a new entry starts a new branch and drops forward entries.
    if (this._navHistoryIndex < this._navHistoryRing.length - 1) {
      this._navHistoryRing.splice(this._navHistoryIndex + 1);
    }

    const limit = this._historyCacheLimit();
    if (this._navHistoryRing.length < limit) {
      this._navHistoryRing.push(normalized);
    } else {
      // Ring behavior: full capacity -> overwrite the oldest entry.
      this._navHistoryRing.shift();
      this._navHistoryRing.push(normalized);
    }

    this._navHistoryIndex = this._navHistoryRing.length - 1;
    this._view.webview.postMessage({ type: 'update', data: normalized });
    this._sendNavState();
  }

  private _moveHistory(delta: -1 | 1): void {
    if (!this._view) { return; }
    this._trimHistoryToLimit();
    if (this._navHistoryRing.length === 0 || this._navHistoryIndex < 0) { return; }

    const nextIndex = this._navHistoryIndex + delta;
    if (nextIndex < 0 || nextIndex >= this._navHistoryRing.length) { return; }

    this._navHistoryIndex = nextIndex;
    const entry = this._navHistoryRing[this._navHistoryIndex];
    this._view.webview.postMessage({ type: 'update', data: entry });
    this._sendNavState();
  }

  private _normalizeBundle(bundle: PeekContextBundle): PeekContextBundle {
    const contexts = bundle.contexts.filter(Boolean);
    const selectedIndex = contexts.length === 0
      ? 0
      : Math.max(0, Math.min(bundle.selectedIndex ?? 0, contexts.length - 1));
    return { contexts, selectedIndex };
  }

  private _trimHistoryToLimit(): void {
    const limit = this._historyCacheLimit();
    if (this._navHistoryRing.length <= limit) { return; }

    const overflow = this._navHistoryRing.length - limit;
    this._navHistoryRing.splice(0, overflow);
    this._navHistoryIndex = Math.max(0, this._navHistoryIndex - overflow);
    if (this._navHistoryIndex >= this._navHistoryRing.length) {
      this._navHistoryIndex = this._navHistoryRing.length - 1;
    }
  }

  private _historyCacheLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('peekView')
      .get<number>('historyCacheLimit', 15);
    const n = Number.isFinite(configured) ? configured : 15;
    return Math.max(5, Math.min(50, Math.floor(n)));
  }

  /** Send current navigation stack state so webview can enable/disable buttons. */
  private _sendNavState(): void {
    if (!this._view) { return; }
    this._trimHistoryToLimit();
    this._view.webview.postMessage({
      type: 'navState',
      canBack: this._navHistoryIndex > 0,
      canForward: this._navHistoryIndex >= 0 && this._navHistoryIndex < this._navHistoryRing.length - 1,
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
    const initialThemeCss = getThemeColorsCss();

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
      font-size: 11px;
      font-weight: 600;
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
    .nav-btn.active {
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e639c);
    }
    .nav-btn.active:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, #1177bb);
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
      flex: 1;
      min-height: 0;
      color: var(--vscode-disabledForeground, #858585);
      font-size: 12px;
      font-style: italic;
    }

    #main {
      flex: 1;
      min-height: 0;
      display: none;
      width: 100%;
    }

    #definition-list {
      width: 260px;
      flex-shrink: 0;
      min-width: 220px;
      max-width: 360px;
      border-right: 1px solid var(--vscode-panel-border, #333);
      background: var(--vscode-sideBar-background, var(--vscode-panel-background, #1e1e1e));
      overflow: hidden;
      display: none;
      flex-direction: column;
    }

    #definition-splitter {
      width: 6px;
      flex-shrink: 0;
      display: none;
      cursor: col-resize;
      background: transparent;
      position: relative;
      user-select: none;
      touch-action: none;
    }

    #definition-splitter::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 50%;
      width: 1px;
      transform: translateX(-50%);
      background: transparent;
    }

    #definition-splitter:hover::before,
    body.dragging-splitter #definition-splitter::before {
      background: var(--vscode-focusBorder, #007acc);
    }

    .def-list-title {
      padding: 8px 10px 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      user-select: none;
      flex-shrink: 0;
    }

    .def-list-items {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 0 0 6px;
    }

    .def-item {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border: none;
      border-radius: 0;
      background: transparent;
      color: var(--vscode-foreground, #d4d4d4);
      text-align: left;
      cursor: pointer;
      outline: none;
      border-left: 3px solid transparent;
      transition: background 0.12s, border-color 0.12s;
    }

    .def-item:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    }

    .def-item.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.28));
      border-left-color: var(--vscode-focusBorder, #007acc);
    }

    .def-item:focus-visible {
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, #007acc);
    }

    .def-item-main {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .def-item-symbol {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .def-item-kind {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
    }

    .def-item-detail {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #code-container {
      flex: 1;
      min-width: 0;
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
    <button class="nav-btn" id="lock-btn" title="锁定：忽略编辑器光标更新（视图内导航仍可用）">🔓</button>
    <button class="nav-btn" id="nav-back-btn" disabled title="后退 (鼠标侧键)"><svg viewBox="0 0 16 16"><polyline points="10,2 4,8 10,14"/></svg></button>
    <button class="nav-btn" id="nav-forward-btn" disabled title="前进 (鼠标侧键)"><svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg></button>
    <span id="kind-badge">—</span>
    <span id="symbol-name">Peek View</span>
    <span id="file-name"></span>
  </div>
  <div id="empty-msg">初始化中...</div>
  <div id="main">
    <aside id="definition-list" aria-label="定义候选列表"></aside>
    <div id="definition-splitter" role="separator" aria-orientation="vertical" aria-label="调整定义列表宽度"></div>
    <div id="code-container"></div>
  </div>

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
    const mainPane      = document.getElementById('main');
    const definitionList = document.getElementById('definition-list');
    const definitionSplitter = document.getElementById('definition-splitter');
    const codeContainer = document.getElementById('code-container');

    const navBackBtn    = document.getElementById('nav-back-btn');
    const navForwardBtn = document.getElementById('nav-forward-btn');
    const lockBtn       = document.getElementById('lock-btn');

    let currentCursorLine  = 0;
    let currentDefUri      = null; // vscode URI string of the definition file
    let currentSymbolKind  = null; // last displayed symbol kind
    let currentContexts    = [];
    let currentSelectedIndex = 0;
    let definitionListWidth = 260;
    let isDraggingSplitter = false;
    let pendingRenderArgs  = null; // 等待语法高亮组件加载完成后重绘
    let isLocked           = false;

    const SPLITTER_MIN_WIDTH = 220;
    const SPLITTER_MAX_WIDTH = 360;

    const savedState = vscodeApi.getState() || {};
    if (Number.isFinite(savedState.definitionListWidth)) {
      definitionListWidth = Math.max(
        SPLITTER_MIN_WIDTH,
        Math.min(SPLITTER_MAX_WIDTH, Math.floor(savedState.definitionListWidth))
      );
      definitionList.style.width = definitionListWidth + 'px';
    }

    // ── 前进 / 后退按钮 ─────────────────────────────────────────────────────
    navBackBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'navBack' });
    });
    navForwardBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'navForward' });
    });
    lockBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'toggleLock', locked: !isLocked });
    });

    definitionSplitter.addEventListener('pointerdown', (e) => {
      if (currentContexts.length <= 1) { return; }
      isDraggingSplitter = true;
      document.body.classList.add('dragging-splitter');
      definitionSplitter.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
      if (!isDraggingSplitter) { return; }
      const mainRect = mainPane.getBoundingClientRect();
      const nextWidth = Math.max(
        SPLITTER_MIN_WIDTH,
        Math.min(SPLITTER_MAX_WIDTH, Math.round(e.clientX - mainRect.left))
      );
      definitionListWidth = nextWidth;
      definitionList.style.width = nextWidth + 'px';
      vscodeApi.setState({ ...(vscodeApi.getState() || {}), definitionListWidth: nextWidth, fontSize: (vscodeApi.getState() || {}).fontSize });
    });

    document.addEventListener('pointerup', () => {
      if (!isDraggingSplitter) { return; }
      isDraggingSplitter = false;
      document.body.classList.remove('dragging-splitter');
    });

    document.addEventListener('pointercancel', () => {
      if (!isDraggingSplitter) { return; }
      isDraggingSplitter = false;
      document.body.classList.remove('dragging-splitter');
    });

    definitionList.addEventListener('keydown', (e) => {
      if (currentContexts.length <= 1) { return; }
      let nextIndex = currentSelectedIndex;
      if (e.key === 'ArrowDown') {
        nextIndex += 1;
      } else if (e.key === 'ArrowUp') {
        nextIndex -= 1;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = currentContexts.length - 1;
      } else {
        return;
      }

      e.preventDefault();
      selectDefinition(nextIndex, true);
    });

    function applyLockState(locked) {
      isLocked = !!locked;
      lockBtn.textContent = isLocked ? '🔒' : '🔓';
      lockBtn.classList.toggle('active', isLocked);
      lockBtn.title = isLocked
        ? '已锁定：忽略编辑器光标更新（视图内导航仍可用）'
        : '锁定：忽略编辑器光标更新（视图内导航仍可用）';
    }

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
    ${buildKindIconFunction('kindSymbol')}

    function kindColor(kind) {
      // Read the CSS var injected from the real TextMate theme (see generateSymbolKindCss).
      const v = getComputedStyle(document.documentElement).getPropertyValue('--peek-kind-' + kind).trim();
      return v || null;
    }

    function applyKindColors(kind) {
      const color = kindColor(kind);
      kindBadge.style.color    = color || 'var(--vscode-foreground, #ccc)';
      symbolNameEl.style.color = '';
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

    function normalizeBundle(data) {
      const contexts = Array.isArray(data && data.contexts) ? data.contexts : [];
      const selectedIndex = contexts.length === 0
        ? 0
        : Math.max(0, Math.min(Number.isInteger(data && data.selectedIndex) ? data.selectedIndex : 0, contexts.length - 1));
      return { contexts, selectedIndex };
    }

    function renderDefinitionList() {
      const count = currentContexts.length;
      if (count <= 1) {
        definitionList.style.display = 'none';
        definitionSplitter.style.display = 'none';
        definitionList.innerHTML = '';
        return;
      }

      definitionList.style.display = 'flex';
      definitionSplitter.style.display = 'block';
      const items = currentContexts.map((ctx, index) => {
        const selected = index === currentSelectedIndex;
        const fileLabel = ctx.fileName ? ctx.fileName : 'unknown';
        const lineLabel = (ctx.cursorLine + 1);
        const symbolKind = ctx.symbolKind ? ctx.symbolKind : 'Symbol';
        const title = escapeHtml(ctx.symbolName || fileLabel);
        const detail = escapeHtml(fileLabel + ':' + lineLabel);
        return '<button type="button" class="def-item' + (selected ? ' selected' : '') + '" data-index="' + index + '" role="option" aria-selected="' + (selected ? 'true' : 'false') + '">' +
          '<div class="def-item-main"><span class="def-item-kind">' + escapeHtml(kindSymbol(symbolKind)) + '</span><span class="def-item-symbol">' + title + '</span></div>' +
          '<div class="def-item-detail">' + detail + '</div>' +
        '</button>';
      }).join('');

      definitionList.innerHTML = '<div class="def-list-title">多个定义</div><div class="def-list-items" role="listbox" aria-label="定义候选列表">' + items + '</div>';

      definitionList.querySelectorAll('.def-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectDefinition(parseInt(btn.dataset.index, 10), true);
        });
      });
    }

    function renderCurrentContext() {
      const ctx = currentContexts[currentSelectedIndex];
      if (!ctx) { return; }

      currentCursorLine = ctx.cursorLine;
      currentDefUri     = ctx.defUri || null;

      kindBadge.textContent = kindSymbol(ctx.symbolKind);
      symbolNameEl.innerHTML = renderHeaderSymbolName(ctx.symbolName, ctx.symbolKind);
      currentSymbolKind = ctx.symbolKind;
      applyKindColors(ctx.symbolKind);
      document.getElementById('file-name').textContent = ctx.fileName ? '  ' + ctx.fileName + ':' + (ctx.cursorLine + 1) : '';

      renderCode(ctx.code, ctx.language, ctx.startLine, ctx.cursorLine);
      refreshDefinitionListSelection();
    }

    function refreshDefinitionListSelection() {
      definitionList.querySelectorAll('.def-item').forEach((btn) => {
        const active = parseInt(btn.dataset.index, 10) === currentSelectedIndex;
        btn.classList.toggle('selected', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    function selectDefinition(index, focusItem) {
      if (!currentContexts.length) { return; }
      const nextIndex = Math.max(0, Math.min(index, currentContexts.length - 1));
      if (nextIndex === currentSelectedIndex) {
        if (focusItem) { focusDefinitionItem(nextIndex); }
        return;
      }

      currentSelectedIndex = nextIndex;
      renderCurrentContext();
      renderDefinitionList();
      if (focusItem) {
        focusDefinitionItem(nextIndex);
      }
    }

    function focusDefinitionItem(index) {
      const btn = definitionList.querySelector('.def-item[data-index="' + index + '"]');
      if (btn) {
        btn.focus({ preventScroll: true });
      }
    }

    // ── 接收来自扩展的消息 ────────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'empty') {
        emptyMsg.textContent        = msg.message;
        emptyMsg.style.display      = 'flex';
        mainPane.style.display      = 'none';
        definitionList.innerHTML    = '';
        definitionList.style.display = 'none';
        definitionSplitter.style.display = 'none';
        kindBadge.textContent            = '—';
        kindBadge.style.color           = '';
        symbolNameEl.textContent        = 'Peek View';
        symbolNameEl.style.color    = '';
        currentSymbolKind           = null;
        document.getElementById('file-name').textContent = '';
        currentContexts = [];
        currentSelectedIndex = 0;
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

      if (msg.type === 'lockState') {
        applyLockState(msg.locked);
        return;
      }

      if (msg.type === 'update') {
        const bundle = normalizeBundle(msg.data);
        currentContexts = bundle.contexts;
        currentSelectedIndex = bundle.selectedIndex;
        emptyMsg.style.display = 'none';
        mainPane.style.display = 'flex';
        renderDefinitionList();
        renderCurrentContext();
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
