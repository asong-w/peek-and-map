import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNodeData } from './types';
import { getNonce } from './utils';
import { PeekViewProvider } from './peekView';
import { buildKindIconFunction, getThemeColorsCss, symbolKindToName } from './viewCommon';

export class MapViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mapView.view';
  private static readonly VIEW_MODE_STATE_KEY = 'mapView.viewMode';
  private static readonly GRAPH_DIRECTION_STATE_KEY = 'mapView.graphDirection';
  private static readonly DEFAULT_INSTANCE_ID = '__default__';

  private _view?: vscode.WebviewView;
  private _lastKnownEditor?: vscode.TextEditor;

  // Per-instance node maps for lazy tree expansion
  private _instanceSessions = new Map<string, {
    refNodeMap: Map<string, { uri: vscode.Uri; position: vscode.Position; pathSymbolKeys: string[] }>;
    nodeCounter: number;
  }>();
  private _peekView?: PeekViewProvider;
  private _viewMode: 'tree' | 'graph';
  private _graphDirection: 'up' | 'down' | 'left' | 'right';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    const rawMode = this._context.workspaceState.get<string>(MapViewProvider.VIEW_MODE_STATE_KEY);
    this._viewMode = this._normalizeViewMode(
      rawMode
    );
    const fallbackDirection = rawMode === 'graph-up' ? 'up' : 'right';
    this._graphDirection = this._normalizeGraphDirection(
      this._context.workspaceState.get<string>(MapViewProvider.GRAPH_DIRECTION_STATE_KEY),
      fallbackDirection
    );
  }

  private _normalizeViewMode(mode: unknown): 'tree' | 'graph' {
    return mode === 'graph' || mode === 'graph-up' ? 'graph' : 'tree';
  }

  private _normalizeGraphDirection(
    direction: unknown,
    fallback: 'up' | 'down' | 'left' | 'right' = 'right'
  ): 'up' | 'down' | 'left' | 'right' {
    return direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right'
      ? direction
      : fallback;
  }

  private _normalizeInstanceId(instanceId: unknown): string {
    if (typeof instanceId !== 'string' || !instanceId.trim()) {
      return MapViewProvider.DEFAULT_INSTANCE_ID;
    }
    return instanceId.trim();
  }

  private _getOrCreateSession(instanceId: string): {
    refNodeMap: Map<string, { uri: vscode.Uri; position: vscode.Position; pathSymbolKeys: string[] }>;
    nodeCounter: number;
  } {
    let session = this._instanceSessions.get(instanceId);
    if (!session) {
      session = {
        refNodeMap: new Map<string, { uri: vscode.Uri; position: vscode.Position; pathSymbolKeys: string[] }>(),
        nodeCounter: 0,
      };
      this._instanceSessions.set(instanceId, session);
    }
    return session;
  }

  private async _saveViewState(mode: unknown, direction: unknown): Promise<void> {
    this._viewMode = this._normalizeViewMode(mode);
    this._graphDirection = this._normalizeGraphDirection(direction, this._graphDirection);
    await this._context.workspaceState.update(MapViewProvider.VIEW_MODE_STATE_KEY, this._viewMode);
    await this._context.workspaceState.update(MapViewProvider.GRAPH_DIRECTION_STATE_KEY, this._graphDirection);
  }

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
    this._view.webview.postMessage({ type: 'themeColors', css: getThemeColorsCss() });
  }

  /** Push map interaction sensitivities to the webview. */
  pushInteractionConfig(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'interactionConfig',
      wheelPanSensitivity: this._getConfigNumber('wheelPanSensitivity', 1, 0.05, 5),
      wheelTiltPanSensitivity: this._getConfigNumber('wheelTiltPanSensitivity', 0.28, 0.05, 5),
      singleClickAction: this._getSingleClickAction(),
    });
  }

  private _getSingleClickAction(): 'peekOnly' | 'jumpTo' {
    const raw = vscode.workspace.getConfiguration('mapView').get<string>('singleClickAction', 'peekOnly');
    return raw === 'jumpTo' ? 'jumpTo' : 'peekOnly';
  }

  private _getConfigNumber(key: string, fallback: number, min: number, max: number): number {
    const raw = vscode.workspace.getConfiguration('mapView').get<number>(key, fallback);
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, raw));
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
          this.pushInteractionConfig();
          webviewView.webview.postMessage({
            type: 'initViewState',
            mode: this._viewMode,
            direction: this._graphDirection,
          });
          break;

        case 'search':
          await this._doSearch(this._normalizeInstanceId(msg.instanceId));
          break;

        case 'expandRef':
          await this._expandRef(this._normalizeInstanceId(msg.instanceId), msg.nodeId as string);
          break;

        case 'closeInstance':
          this._instanceSessions.delete(this._normalizeInstanceId(msg.instanceId));
          break;

        case 'requestRenameInstance': {
          const instanceId = this._normalizeInstanceId(msg.instanceId);
          const currentTitle = typeof msg.currentTitle === 'string' ? msg.currentTitle : '';
          const nextTitle = await vscode.window.showInputBox({
            title: 'Rename Map Instance',
            prompt: 'Enter a new instance name',
            value: currentTitle,
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? null : 'Name cannot be empty',
          });
          if (typeof nextTitle === 'string' && nextTitle.trim()) {
            webviewView.webview.postMessage({
              type: 'instanceRenamed',
              instanceId,
              title: nextTitle.trim(),
            });
          }
          break;
        }

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

        case 'setViewState':
          await this._saveViewState(msg.mode, msg.direction);
          break;

        case 'setViewMode':
          await this._saveViewState(msg.mode, this._graphDirection);
          break;
      }
    });
  }

  // ── Node ID allocation ─────────────────────────────────────────────────────

  private _symbolPositionKey(uri: vscode.Uri, position: vscode.Position): string {
    return `${uri.toString()}#sym:${position.line}:${position.character}`;
  }

  private _allocRefNodeId(
    session: {
      refNodeMap: Map<string, { uri: vscode.Uri; position: vscode.Position; pathSymbolKeys: string[] }>;
      nodeCounter: number;
    },
    uri: vscode.Uri,
    position: vscode.Position,
    pathSymbolKeys: Set<string>
  ): string {
    const id = `r${++session.nodeCounter}`;
    session.refNodeMap.set(id, {
      uri,
      position,
      pathSymbolKeys: [...pathSymbolKeys],
    });
    return id;
  }

  // ── Search (button-triggered) ──────────────────────────────────────────────

  private async _doSearch(instanceId: string): Promise<void> {
    if (!this._view) { return; }
    const session = this._getOrCreateSession(instanceId);

    const editor = vscode.window.activeTextEditor ?? this._lastKnownEditor;
    if (!editor) {
      this._sendEmpty('No active editor', instanceId);
      return;
    }

    const doc = editor.document;
    const cursor = editor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(cursor);
    if (!wordRange) {
      this._sendEmpty('Cursor is not on a symbol', instanceId);
      return;
    }
    const word = doc.getText(wordRange);
    const queryPos = cursor;

    // Clear maps for new search
    session.refNodeMap.clear();
    session.nodeCounter = 0;

    // Show loading state
    this._view.webview.postMessage({ type: 'loading', symbolName: word, instanceId });

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    // ── References hierarchy (first level) ─────────────────────────────────
    const refNodes = await this._resolveReferencingSymbols(session, doc.uri, queryPos, wsRoot);

    // Resolve current symbol + optional owning class for root label/kind
    let rootKind = '';
    let rootLabel = word;
    let rootIsDeclaration = false;
    let containerMismatch = false;
    try {
      const symbols = await this._getDocumentSymbols(doc.uri);
      const found = this._deepestContainingWithAncestors(symbols, queryPos);
      if (found && this._symbolNameMatchesWord(found.symbol.name, word)) {
        const ownerClass =
          this._nearestOwnerClassName(found.ancestors) ??
          this._inferCppOwnerClass(found.symbol.name, doc.lineAt(found.symbol.selectionRange.start.line).text, doc.languageId);
        rootKind = this._symbolKindNameWithOwner(found.symbol.kind, found.symbol.name, ownerClass, doc.languageId);
        rootLabel = this._formatLabelWithOwner(found.symbol.name, ownerClass, found.symbol.kind);
        rootIsDeclaration = this._isFunctionDeclarationSymbol(found.symbol, doc);
      } else if (found) {
        containerMismatch = true;
      }
    } catch {
      // keep fallback word
    }

    if (!rootKind) {
      try {
        const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', doc.uri, queryPos
        );
        if (items && items.length > 0) {
          const matched = items.find((it) => this._symbolNameMatchesWord(it.name, word));
          if (matched) {
            const ownerClass = this._ownerFromQualifiedName(matched.name);
            rootKind = this._symbolKindNameWithOwner(matched.kind, matched.name, ownerClass, doc.languageId);
          }
        }
      } catch { /* no call hierarchy provider */ }
    }

    if (!rootKind && containerMismatch) {
      rootKind = 'Variable';
    }

    this._view.webview.postMessage({
      type: 'update',
      instanceId,
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
          kind: rootKind || 'Symbol',
          isDeclaration: rootIsDeclaration,
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
    session: {
      refNodeMap: Map<string, { uri: vscode.Uri; position: vscode.Position; pathSymbolKeys: string[] }>;
      nodeCounter: number;
    },
    uri: vscode.Uri,
    pos: vscode.Position,
    wsRoot: string,
    ancestorPathSymbolKeys: Set<string> = new Set<string>()
  ): Promise<TreeNodeData[]> {
    let locs: vscode.Location[] | undefined;
    try {
      locs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, pos
      );
    } catch { /* no reference provider */ }
    if (!locs || locs.length === 0) { return []; }

    const targetSymbols = await this._getDocumentSymbols(uri);
    const targetSymbol = this._deepestContaining(targetSymbols, pos);
    const targetSymStart = targetSymbol?.selectionRange.start;
    let targetDoc: vscode.TextDocument | undefined;
    try {
      targetDoc = await vscode.workspace.openTextDocument(uri);
    } catch {
      targetDoc = undefined;
    }
    const targetIsDeclaration = !!(targetSymbol && targetDoc && this._isFunctionDeclarationSymbol(targetSymbol, targetDoc));
    const targetWithAncestors = targetSymStart
      ? this._findBySelectionStartWithAncestors(targetSymbols, targetSymStart)
      : undefined;
    const targetOwnerClass = targetWithAncestors && targetSymbol && targetDoc
      ? (
        this._nearestOwnerClassName(targetWithAncestors.ancestors)
        ?? this._inferCppOwnerClass(
          targetSymbol.name,
          targetDoc.lineAt(targetSymStart!.line).text,
          targetDoc.languageId
        )
      )
      : undefined;
    const targetSimpleName = targetSymbol ? this._simpleSymbolName(targetSymbol.name) : '';
    const targetKey = this._symbolPositionKey(uri, targetSymStart ?? pos);
    const pathSymbolKeys = new Set<string>(ancestorPathSymbolKeys);
    pathSymbolKeys.add(targetKey);

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
          nodeId: `leaf_${++session.nodeCounter}`,
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
        targetSymStart &&
        symStart.line === targetSymStart.line &&
        symStart.character === targetSymStart.character
      ) {
        continue;
      }

      const isDeclaration = this._isFunctionDeclarationSymbol(enclosing, refDoc);

      const found =
        this._findBySelectionStartWithAncestors(symbols, symStart) ??
        this._deepestContainingWithAncestors(symbols, loc.range.start);
      const ownerClass = found
        ? (
          this._nearestOwnerClassName(found.ancestors) ??
          this._inferCppOwnerClass(enclosing.name, refDoc.lineAt(symStart.line).text, refDoc.languageId)
        )
        : this._inferCppOwnerClass(enclosing.name, refDoc.lineAt(symStart.line).text, refDoc.languageId);

      // Declaration symbol should not be considered as "referenced by its own definition".
      if (
        targetIsDeclaration &&
        !isDeclaration &&
        this._isFunctionLikeSymbol(enclosing.kind) &&
        this._simpleSymbolName(enclosing.name) === targetSimpleName &&
        ((ownerClass ?? '') === (targetOwnerClass ?? ''))
      ) {
        continue;
      }

      // First occurrence of this enclosing symbol → expandable; subsequent → leaf
      const symKey = loc.uri.toString() + '#sym:' + symStart.line + ':' + symStart.character;
      if (pathSymbolKeys.has(symKey)) {
        continue;
      }
      const isFirst = !firstSeenKeys.has(symKey);
      if (isFirst) { firstSeenKeys.add(symKey); }

      const nodeId = isFirst
        ? this._allocRefNodeId(session, loc.uri, symStart, new Set<string>([...pathSymbolKeys, symKey]))
        : `leaf_${++session.nodeCounter}`;

      result.push({
        nodeId,
        label: this._formatLabelWithOwner(enclosing.name, ownerClass, enclosing.kind),
        detail: this._relativePath(loc.uri.fsPath, wsRoot),
        line: symStart.line,
        character: symStart.character,
        callLine: loc.range.start.line,
        callCharacter: loc.range.start.character,
        uri: loc.uri.toString(),
        kind: this._symbolKindNameWithOwner(enclosing.kind, enclosing.name, ownerClass, refDoc.languageId),
        isDeclaration,
        preview: refDoc.lineAt(symStart.line).text.trim(),
      });
    }

    return result;
  }

  // ── Expand: Reference hierarchy ────────────────────────────────────────────

  private async _expandRef(instanceId: string, nodeId: string): Promise<void> {
    if (!this._view) { return; }
    const session = this._getOrCreateSession(instanceId);
    const info = session.refNodeMap.get(nodeId);
    if (!info) {
      this._view.webview.postMessage({ type: 'children', instanceId, parentNodeId: nodeId, items: [] });
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const children = await this._resolveReferencingSymbols(
      session,
      info.uri,
      info.position,
      wsRoot,
      new Set<string>(info.pathSymbolKeys)
    );
    this._view.webview.postMessage({ type: 'children', instanceId, parentNodeId: nodeId, items: children });
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

  private _symbolNameMatchesWord(symbolName: string, word: string): boolean {
    const w = word.trim();
    if (!w) { return false; }
    const simple = this._simpleSymbolName(symbolName).trim();
    if (simple === w || simple === `~${w}`) { return true; }
    if (simple.startsWith(w + '<')) { return true; }
    return false;
  }

  private _isFunctionLikeSymbol(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Function
      || kind === vscode.SymbolKind.Method
      || kind === vscode.SymbolKind.Constructor;
  }

  private _isFunctionDeclarationSymbol(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): boolean {
    if (!this._isFunctionLikeSymbol(symbol.kind)) {
      return false;
    }

    const lineText = doc.lineAt(symbol.selectionRange.start.line).text;
    const tail = lineText.slice(symbol.selectionRange.start.character);
    if (!/\{/.test(tail) && /;\s*(?:\/\/.*)?$/.test(tail)) {
      return true;
    }

    if (symbol.range.start.line === symbol.range.end.line) {
      const rangeText = doc.getText(symbol.range).trim();
      if (!/\{/.test(rangeText) && /;\s*(?:\/\/.*)?$/.test(rangeText)) {
        return true;
      }
    }

    return false;
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
    return symbolKindToName(kind);
  }

  private _symbolKindNameWithOwner(
    kind: vscode.SymbolKind,
    name: string,
    ownerClass: string | undefined,
    languageId: string
  ): string {
    const base = this._symbolKindName(kind);
    if (!ownerClass || !this._isCppLanguage(languageId) || base !== 'Function') {
      return base;
    }
    const simple = this._simpleSymbolName(name);
    const ownerSimple = ownerClass.split('::').pop()?.trim() || ownerClass;
    if (simple === ownerSimple || simple === `~${ownerSimple}`) {
      return 'Constructor';
    }
    return 'Method';
  }

  private _sendEmpty(msg: string, instanceId: string): void {
    this._view?.webview.postMessage({ type: 'empty', message: msg, instanceId });
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const initialThemeCss = getThemeColorsCss();

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

    #pane-host {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
    }
    #pane-host.mode-single {
      flex-direction: column;
    }
    #pane-host.mode-horizontal {
      flex-direction: column;
    }
    #pane-host.mode-vertical {
      flex-direction: row;
    }
    .pane-shell {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #pane-host.mode-horizontal .pane-shell + .pane-shell {
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    #pane-host.mode-vertical .pane-shell + .pane-shell {
      border-left: 1px solid var(--vscode-panel-border, #333);
    }

    #instance-tabs-bar {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      background: var(--vscode-sideBar-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      min-height: 30px;
      overflow: hidden;
    }
    #instance-tabs {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 4px;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .instance-tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 8px;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      background: var(--vscode-tab-inactiveBackground, #2d2d2d);
      color: var(--vscode-tab-inactiveForeground, #ccc);
      cursor: pointer;
      flex-shrink: 0;
      max-width: 200px;
    }
    .instance-tab.active {
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      color: var(--vscode-tab-activeForeground, #fff);
    }
    .instance-tab-title {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .instance-tab-close {
      width: 14px;
      height: 14px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      line-height: 1;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .instance-tab-close:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
    }
    #instance-add-btn {
      width: 24px;
      height: 22px;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      background: var(--vscode-tab-inactiveBackground, #2d2d2d);
      color: var(--vscode-foreground, #d4d4d4);
      cursor: pointer;
      flex-shrink: 0;
    }
    .instance-context-menu {
      position: fixed;
      min-width: 140px;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #333));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      z-index: 1000;
    }
    .instance-context-menu[hidden] {
      display: none;
    }
    .instance-context-item {
      width: 100%;
      height: 24px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-menu-foreground, var(--vscode-foreground, #d4d4d4));
      text-align: left;
      padding: 0 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .instance-context-item:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));
    }

    #split-context-menu {
      position: fixed;
      min-width: 160px;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #333));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      z-index: 1100;
    }
    #split-context-menu[hidden] {
      display: none;
    }
    .split-context-item {
      width: 100%;
      height: 24px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-menu-foreground, var(--vscode-foreground, #d4d4d4));
      text-align: left;
      padding: 0 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .split-context-item:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));
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
    #graph-direction-wrap {
      display: none;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      flex-shrink: 0;
    }
    #graph-direction-wrap label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
    }
    #graph-direction {
      height: 22px;
      font-size: 12px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, #333));
      background: var(--vscode-dropdown-background, var(--vscode-sideBarSectionHeader-background, #252526));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #d4d4d4));
      border-radius: 4px;
      padding: 0 6px;
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
      width: 15px;
      height: 15px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
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
  </style>
  <!-- Dynamic theme symbol-kind colors (updated via postMessage on theme change) -->
  <style id="theme-tokens">${initialThemeCss}</style>
</head>
<body>
  <div id="pane-host" class="mode-single"></div>

  <template id="pane-template">
    <div id="instance-tabs-bar">
      <div id="instance-tabs" role="tablist" aria-label="Reference analysis instances"></div>
    </div>
    <div id="header">
      <button id="search-btn" title="Analyze symbol at cursor"><span class="btn-icon">🔍</span> Analysis</button>
      <div id="view-tabs" role="tablist" aria-label="Map View Mode">
        <button id="view-tab-tree" class="view-tab active" role="tab" aria-selected="true" title="Outline view">Outline</button>
        <button id="view-tab-graph" class="view-tab" role="tab" aria-selected="false" title="Graph view">Graph</button>
      </div>
      <div id="graph-direction-wrap">
        <label for="graph-direction">Direction</label>
        <select id="graph-direction" title="Graph growth direction">
          <option value="right">Right</option>
          <option value="left">Left</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
        </select>
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
    </div>
    <div id="instance-context-menu" class="instance-context-menu" hidden>
      <button class="instance-context-item" data-action="rename">Rename</button>
      <button class="instance-context-item" data-action="close-others">Close Others</button>
      <button class="instance-context-item" data-action="copy-right">Copy to Right</button>
      <button class="instance-context-item" data-action="move-other-pane">Move to Other Pane</button>
      <button class="instance-context-item" data-action="copy-other-pane">Copy to Other Pane</button>
    </div>
  </template>

  <div id="split-context-menu" hidden>
    <button class="split-context-item" data-action="split-horizontal">Split Horizontally</button>
    <button class="split-context-item" data-action="split-vertical">Split Vertically</button>
    <button class="split-context-item" data-action="switch-horizontal">Switch to Horizontal Split</button>
    <button class="split-context-item" data-action="switch-vertical">Switch to Vertical Split</button>
    <button class="split-context-item" data-action="swap-panes">Swap Pane Positions</button>
    <button class="split-context-item" data-action="restore-single">Back to Single Pane</button>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'ready' });

    const paneHost = document.getElementById('pane-host');
    const paneTemplate = document.getElementById('pane-template');
    const splitContextMenu = document.getElementById('split-context-menu');
    const splitHorizontalMenuItem = splitContextMenu.querySelector('[data-action="split-horizontal"]');
    const splitVerticalMenuItem = splitContextMenu.querySelector('[data-action="split-vertical"]');
    const switchHorizontalMenuItem = splitContextMenu.querySelector('[data-action="switch-horizontal"]');
    const switchVerticalMenuItem = splitContextMenu.querySelector('[data-action="switch-vertical"]');
    const swapPanesMenuItem = splitContextMenu.querySelector('[data-action="swap-panes"]');
    const restoreSingleMenuItem = splitContextMenu.querySelector('[data-action="restore-single"]');
    const paneControllers = new Map();
    let paneIdSeed = 0;
    let globalInstanceSeed = 0;
    let currentSplitMode = 'single';
    let latestThemeCss = '';
    let latestInteractionConfig = null;
    let latestViewState = { mode: 'tree', direction: 'right' };

    function createPaneShell(paneId) {
      const shell = document.createElement('section');
      shell.className = 'pane-shell';
      shell.dataset.paneId = paneId;
      shell.appendChild(paneTemplate.content.cloneNode(true));
      paneHost.appendChild(shell);
      return shell;
    }

    function createPaneController(paneRoot, paneId) {

    const emptyMsg     = paneRoot.querySelector('#empty-msg');
    const content      = paneRoot.querySelector('#content');
    const instanceTabs = paneRoot.querySelector('#instance-tabs');
    const instanceContextMenu = paneRoot.querySelector('#instance-context-menu');
    const moveOtherPaneMenuItem = instanceContextMenu.querySelector('[data-action="move-other-pane"]');
    const copyOtherPaneMenuItem = instanceContextMenu.querySelector('[data-action="copy-other-pane"]');
    const searchBtn    = paneRoot.querySelector('#search-btn');
    const viewTabTree  = paneRoot.querySelector('#view-tab-tree');
    const viewTabGraph = paneRoot.querySelector('#view-tab-graph');
    const graphDirectionWrap = paneRoot.querySelector('#graph-direction-wrap');
    const graphDirectionSelect = paneRoot.querySelector('#graph-direction');
    const graphContainer = paneRoot.querySelector('#graph-container');
    const graphCanvas   = paneRoot.querySelector('#graph-canvas');
    const refSection    = paneRoot.querySelector('#sec-references');

    let defaultNewMode = 'tree';
    let defaultNewDirection = 'right';
    const instanceStateMap = new Map();
    const instanceOrder = [];
    let activeInstanceId = '';
    let contextMenuInstanceId = '';

    let loadedNodes = new Set();
    let nodeChildrenCache = new Map();  // nodeId → children items[]
    let expandedNodeIds = new Set();    // nodeIds currently expanded

    // ── View mode: 'tree' | 'graph' ─────────────────────────────────────
    let viewMode = 'tree';
    let graphDirection = 'right'; // 'up' | 'down' | 'left' | 'right'
    // Store last update data for graph rendering
    let lastUpdateData = null;

    function createInstanceState(id, title, mode, direction) {
      return {
        id,
        title,
        viewMode: mode,
        graphDirection: direction,
        loadedNodes: new Set(),
        nodeChildrenCache: new Map(),
        expandedNodeIds: new Set(),
        lastUpdateData: null,
      };
    }

    function cloneNodeChildrenCache(sourceMap) {
      const cloned = new Map();
      for (const [nodeId, items] of sourceMap.entries()) {
        const copiedItems = Array.isArray(items)
          ? items.map(function(item) { return Object.assign({}, item); })
          : [];
        cloned.set(nodeId, copiedItems);
      }
      return cloned;
    }

    function cloneLastUpdateData(data) {
      if (!data) { return null; }
      try {
        return JSON.parse(JSON.stringify(data));
      } catch {
        return null;
      }
    }

    function insertInstanceOrder(instanceId, afterInstanceId) {
      const existingIdx = instanceOrder.indexOf(instanceId);
      if (existingIdx >= 0) {
        instanceOrder.splice(existingIdx, 1);
      }
      if (!afterInstanceId) {
        instanceOrder.push(instanceId);
        return;
      }
      const idx = instanceOrder.indexOf(afterInstanceId);
      if (idx < 0) {
        instanceOrder.push(instanceId);
        return;
      }
      instanceOrder.splice(idx + 1, 0, instanceId);
    }

    function bindInstanceState(state) {
      activeInstanceId = state.id;
      loadedNodes = state.loadedNodes;
      nodeChildrenCache = state.nodeChildrenCache;
      expandedNodeIds = state.expandedNodeIds;
      viewMode = state.viewMode;
      graphDirection = state.graphDirection;
      lastUpdateData = state.lastUpdateData;
    }

    function syncActiveState() {
      const state = instanceStateMap.get(activeInstanceId);
      if (!state) return;
      state.viewMode = viewMode;
      state.graphDirection = graphDirection;
      state.lastUpdateData = lastUpdateData;
      state.loadedNodes = loadedNodes;
      state.nodeChildrenCache = nodeChildrenCache;
      state.expandedNodeIds = expandedNodeIds;
    }

    function renderInstanceTabs() {
      const html = instanceOrder.map(function(instanceId) {
        const state = instanceStateMap.get(instanceId);
        if (!state) { return ''; }
        const active = state.id === activeInstanceId;
        return '<div class="instance-tab' + (active ? ' active' : '') + '" data-instance-id="' + escapeAttr(state.id) + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '">'
          + '<span class="instance-tab-title" title="' + escapeAttr(state.title) + '">' + escapeHtml(state.title) + '</span>'
          + '<button class="instance-tab-close" data-instance-id="' + escapeAttr(state.id) + '" title="Close">×</button>'
          + '</div>';
      }).join('')
        + '<button id="instance-add-btn" title="New analysis instance">+</button>';
      instanceTabs.innerHTML = html;
    }

    function applyActiveStateUi() {
      updateViewTabs();
      if (!lastUpdateData) {
        emptyMsg.textContent = 'Place cursor on a symbol, then click "Analysis"';
        emptyMsg.style.display = 'flex';
        content.style.display = 'none';
        graphContainer.style.display = 'none';
        return;
      }

      emptyMsg.style.display = 'none';
      if (isGraphMode(viewMode)) {
        content.style.display = 'none';
        graphContainer.style.display = 'block';
        graphBuildFromData(lastUpdateData);
        restoreGraphExpansions();
        graphLayout();
        graphDraw();
      } else {
        graphContainer.style.display = 'none';
        content.style.display = 'block';
        const rootNode = lastUpdateData.rootNode || null;
        renderTreeList(refSection, rootNode ? [rootNode] : (lastUpdateData.refNodes || []), 0);
        restoreTreeExpansions(refSection);
      }
    }

    function activateInstance(instanceId) {
      const next = instanceStateMap.get(instanceId);
      if (!next) return;
      if (activeInstanceId) {
        syncActiveState();
      }
      bindInstanceState(next);
      renderInstanceTabs();
      applyActiveStateUi();
    }

    function addInstance(options) {
      const opts = options || {};
      let id = opts.instanceId;
      let title = opts.title;
      if (!id) {
        globalInstanceSeed += 1;
        id = 'inst_' + globalInstanceSeed;
        title = title || ('Ref ' + globalInstanceSeed);
      } else {
        title = title || id;
      }
      if (instanceStateMap.has(id)) {
        activateInstance(id);
        return id;
      }
      const mode = normalizeViewMode(opts.mode || defaultNewMode);
      const direction = normalizeGraphDirection(opts.direction || defaultNewDirection);
      const state = createInstanceState(id, title, mode, direction);
      if (opts.fromState) {
        state.loadedNodes = new Set(opts.fromState.loadedNodes || []);
        state.nodeChildrenCache = cloneNodeChildrenCache(opts.fromState.nodeChildrenCache || new Map());
        state.expandedNodeIds = new Set(opts.fromState.expandedNodeIds || []);
        state.lastUpdateData = cloneLastUpdateData(opts.fromState.lastUpdateData);
      }
      instanceStateMap.set(id, state);
      insertInstanceOrder(id, opts.afterInstanceId);
      activateInstance(id);
      return id;
    }

    function removeInstanceInternal(instanceId, options) {
      const opts = options || {};
      if (!instanceStateMap.has(instanceId)) return;
      if (instanceStateMap.size === 1 && !opts.force) return;
      const idx = instanceOrder.indexOf(instanceId);
      instanceStateMap.delete(instanceId);
      if (idx >= 0) {
        instanceOrder.splice(idx, 1);
      }
      if (!opts.skipCloseMessage) {
        vscodeApi.postMessage({ type: 'closeInstance', instanceId });
      }
      hideInstanceContextMenu();
      if (instanceOrder.length === 0) {
        addInstance();
        return;
      }
      const nextId = instanceOrder[idx] || instanceOrder[idx - 1] || instanceOrder[0];
      activateInstance(nextId);
    }

    function buildTransferPayload(instanceId, options) {
      const opts = options || {};
      const state = instanceStateMap.get(instanceId);
      if (!state) { return null; }
      return {
        instanceId: opts.preserveInstanceId ? state.id : undefined,
        title: state.title,
        mode: state.viewMode,
        direction: state.graphDirection,
        fromState: {
          loadedNodes: new Set(state.loadedNodes),
          nodeChildrenCache: cloneNodeChildrenCache(state.nodeChildrenCache),
          expandedNodeIds: new Set(state.expandedNodeIds),
          lastUpdateData: cloneLastUpdateData(state.lastUpdateData),
        },
      };
    }

    function closeAllInstances() {
      for (const id of instanceOrder) {
        vscodeApi.postMessage({ type: 'closeInstance', instanceId: id });
      }
    }

    function importTransferredInstance(payload) {
      if (!payload) { return ''; }
      return addInstance({
        instanceId: payload.instanceId,
        title: payload.title,
        mode: payload.mode,
        direction: payload.direction,
        fromState: payload.fromState,
      });
    }

    function closeOtherInstances(keepId) {
      if (!instanceStateMap.has(keepId)) { return; }
      if (instanceStateMap.size <= 1) { return; }
      const ids = [...instanceOrder];
      for (const id of ids) {
        if (id === keepId) { continue; }
        instanceStateMap.delete(id);
        vscodeApi.postMessage({ type: 'closeInstance', instanceId: id });
      }
      instanceOrder.length = 0;
      instanceOrder.push(keepId);
      activateInstance(keepId);
      hideInstanceContextMenu();
    }

    function copyInstanceToRight(instanceId) {
      const state = instanceStateMap.get(instanceId);
      if (!state) { return; }
      const copiedTitle = state.title + ' Copy';
      addInstance({
        afterInstanceId: instanceId,
        title: copiedTitle,
        mode: state.viewMode,
        direction: state.graphDirection,
        fromState: state,
      });
      hideInstanceContextMenu();
    }

    function renameInstance(instanceId) {
      const state = instanceStateMap.get(instanceId);
      if (!state) { return; }
      vscodeApi.postMessage({
        type: 'requestRenameInstance',
        instanceId,
        currentTitle: state.title,
      });
      hideInstanceContextMenu();
    }

    function hideInstanceContextMenu() {
      contextMenuInstanceId = '';
      instanceContextMenu.hidden = true;
    }

    function showInstanceContextMenu(instanceId, clientX, clientY) {
      contextMenuInstanceId = instanceId;
      const multiPane = paneControllers.size > 1;
      if (moveOtherPaneMenuItem) {
        moveOtherPaneMenuItem.style.display = multiPane ? '' : 'none';
      }
      if (copyOtherPaneMenuItem) {
        copyOtherPaneMenuItem.style.display = multiPane ? '' : 'none';
      }
      instanceContextMenu.hidden = false;
      instanceContextMenu.style.left = clientX + 'px';
      instanceContextMenu.style.top = clientY + 'px';
      const rect = instanceContextMenu.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 4;
      const maxY = window.innerHeight - rect.height - 4;
      const x = Math.max(4, Math.min(clientX, maxX));
      const y = Math.max(4, Math.min(clientY, maxY));
      instanceContextMenu.style.left = x + 'px';
      instanceContextMenu.style.top = y + 'px';
    }

    instanceTabs.addEventListener('click', (event) => {
      const addBtn = event.target.closest('#instance-add-btn');
      if (addBtn) {
        addInstance();
        return;
      }
      const closeBtn = event.target.closest('.instance-tab-close');
      if (closeBtn) {
        event.stopPropagation();
        removeInstanceInternal(closeBtn.dataset.instanceId);
        return;
      }
      const tabEl = event.target.closest('.instance-tab');
      if (!tabEl) return;
      activateInstance(tabEl.dataset.instanceId);
    });

    instanceTabs.addEventListener('contextmenu', (event) => {
      const tabEl = event.target.closest('.instance-tab');
      if (!tabEl) { return; }
      event.preventDefault();
      const instanceId = tabEl.dataset.instanceId;
      activateInstance(instanceId);
      showInstanceContextMenu(instanceId, event.clientX, event.clientY);
    });

    instanceContextMenu.addEventListener('click', (event) => {
      const item = event.target.closest('.instance-context-item');
      if (!item || !contextMenuInstanceId) { return; }
      const action = item.dataset.action;
      if (action === 'rename') {
        renameInstance(contextMenuInstanceId);
      } else if (action === 'close-others') {
        closeOtherInstances(contextMenuInstanceId);
      } else if (action === 'copy-right') {
        copyInstanceToRight(contextMenuInstanceId);
      } else if (action === 'move-other-pane') {
        moveOrCopyInstanceToOtherPane(paneId, contextMenuInstanceId, true);
        hideInstanceContextMenu();
      } else if (action === 'copy-other-pane') {
        moveOrCopyInstanceToOtherPane(paneId, contextMenuInstanceId, false);
        hideInstanceContextMenu();
      }
    });

    document.addEventListener('click', (event) => {
      if (instanceContextMenu.hidden) { return; }
      if (!event.target.closest('#instance-context-menu')) {
        hideInstanceContextMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideInstanceContextMenu();
      }
    });

    window.addEventListener('blur', hideInstanceContextMenu);
    instanceTabs.addEventListener('scroll', hideInstanceContextMenu);

    addInstance();

    function updateViewTabs() {
      const treeActive = viewMode === 'tree';
      const graphActive = viewMode === 'graph';
      viewTabTree.classList.toggle('active', treeActive);
      viewTabGraph.classList.toggle('active', graphActive);
      viewTabTree.setAttribute('aria-selected', treeActive ? 'true' : 'false');
      viewTabGraph.setAttribute('aria-selected', graphActive ? 'true' : 'false');
      graphDirectionWrap.style.display = graphActive ? 'inline-flex' : 'none';
    }

    function isGraphMode(mode) {
      return mode === 'graph';
    }

    function normalizeViewMode(mode) {
      return mode === 'graph' || mode === 'graph-up' ? 'graph' : 'tree';
    }

    function normalizeGraphDirection(direction) {
      return direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right'
        ? direction
        : 'right';
    }

    function setViewState(mode, direction, options) {
      const opts = options || {};
      viewMode = normalizeViewMode(mode);
      graphDirection = normalizeGraphDirection(direction != null ? direction : graphDirection);
      graphDirectionSelect.value = graphDirection;
      updateViewTabs();
      if (isGraphMode(viewMode)) {
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

      if (opts.persist !== false) {
        defaultNewMode = viewMode;
        defaultNewDirection = graphDirection;
        vscodeApi.postMessage({ type: 'setViewState', mode: viewMode, direction: graphDirection });
      }
      syncActiveState();
    }

    viewTabTree.addEventListener('click', () => setViewState('tree', graphDirection));
    viewTabGraph.addEventListener('click', () => setViewState('graph', graphDirection));
    graphDirectionSelect.addEventListener('change', () => setViewState('graph', graphDirectionSelect.value));

    // ── Search button ────────────────────────────────────────────────────
    searchBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'search', instanceId: activeInstanceId });
    });

    // ── Messages from extension ──────────────────────────────────────────
    function handleMessage(msg) {
      const msgInstanceId = msg && typeof msg.instanceId === 'string' ? msg.instanceId : activeInstanceId;

      if (msg.type === 'empty') {
        if (msgInstanceId !== activeInstanceId) { return; }
        emptyMsg.textContent   = msg.message;
        emptyMsg.style.display = 'flex';
        content.style.display  = 'none';
        graphContainer.style.display = 'none';
        lastUpdateData = null;
        loadedNodes.clear();
        nodeChildrenCache.clear();
        expandedNodeIds.clear();
        syncActiveState();
        return;
      }

      if (msg.type === 'loading') {
        if (msgInstanceId !== activeInstanceId) { return; }
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

      if (msg.type === 'interactionConfig') {
        gWheelPanSensitivity = clampSensitivity(msg.wheelPanSensitivity, 1);
        gWheelTiltPanSensitivity = clampSensitivity(msg.wheelTiltPanSensitivity, 0.28);
        singleClickAction = normalizeSingleClickAction(msg.singleClickAction);
        return;
      }

      if (msg.type === 'instanceRenamed') {
        const state = instanceStateMap.get(msg.instanceId);
        if (!state) { return; }
        state.title = String(msg.title || state.title);
        renderInstanceTabs();
        return;
      }

      if (msg.type === 'initViewState') {
        defaultNewMode = normalizeViewMode(msg.mode);
        defaultNewDirection = normalizeGraphDirection(msg.direction);
        setViewState(msg.mode, msg.direction, { persist: false });
        syncActiveState();
        return;
      }

      if (msg.type === 'initViewMode') {
        setViewState(msg.mode, graphDirection, { persist: false });
        return;
      }

      if (msg.type === 'update') {
        if (msgInstanceId !== activeInstanceId) { return; }
        loadedNodes.clear();
        nodeChildrenCache.clear();
        expandedNodeIds.clear();
        const d = msg.data;
        const activeState = instanceStateMap.get(activeInstanceId);
        if (activeState && d && d.symbolName) {
          activeState.title = String(d.symbolName);
          renderInstanceTabs();
        }
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
        syncActiveState();
        return;
      }

      // Children for a tree node (incremental expansion)
      if (msg.type === 'children') {
        if (msgInstanceId !== activeInstanceId) { return; }
        const parentNodeId = msg.parentNodeId;
        loadedNodes.add(parentNodeId);
        nodeChildrenCache.set(parentNodeId, msg.items || []);
        expandedNodeIds.add(parentNodeId);
        syncActiveState();

        // ── Graph expand ──────────────────────────────────────────
        if (isGraphMode(viewMode)) {
          graphHandleChildren(parentNodeId, msg.items || []);
          return;
        }

        // ── Tree expand ───────────────────────────────────────────
        const nodeEl = paneRoot.querySelector('[data-node-id="' + parentNodeId + '"]');
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
    }

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
      const kindKey = memberKind || 'Function';
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
        ? '<span class="item-icon" style="color:var(--peek-kind-' + item.kind + ',var(--vscode-foreground,#ccc))">' + kindSymbol(item.kind) + '</span>'
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
                isDeclaration: !!item.isDeclaration,
                noChildren: false,
                x: 0, y: 0, w: 0, h: G_NODE_H,
                children: [],
                expanded: false,
                loading: false,
                data: item,
                parentId: n.id,
                callSites: mg.callSites,
                _callBadgeRects: [],
                _toggleRect: null,
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

    function toggleTreeNode(nodeEl, toggleEl) {
      if (!nodeEl || !toggleEl) { return; }
      if (nodeEl.dataset.leaf === '1') { return; }
      const nodeId = nodeEl.dataset.nodeId;
      const childrenEl = nodeEl.querySelector(':scope > .tree-children');
      if (!childrenEl) { return; }

      if (loadedNodes.has(nodeId)) {
        const isVisible = childrenEl.style.display !== 'none';
        childrenEl.style.display = isVisible ? 'none' : 'block';
        toggleEl.innerHTML = isVisible
          ? '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>'
          : '<svg viewBox="0 0 16 16"><polyline points="2,6 8,12 14,6"/></svg>';
        if (isVisible) {
          expandedNodeIds.delete(nodeId);
        } else {
          expandedNodeIds.add(nodeId);
        }
      } else {
        toggleEl.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="6,2 12,8 6,14"/></svg>';
        toggleEl.classList.add('loading');
        vscodeApi.postMessage({ type: 'expandRef', instanceId: activeInstanceId, nodeId: nodeId });
      }
    }

    function toggleGraphNode(hit) {
      if (!hit || !graphNodeCanToggle(hit)) { return true; }
      if (hit.expanded) {
        graphAnimateCollapse(hit, () => {
          graphRelayoutKeepView(hit.id, () => {
            graphCollapse(hit);
          });
          graphDraw();
        });
        return true;
      }

      if (nodeChildrenCache.has(hit.id)) {
        const cached = nodeChildrenCache.get(hit.id);
        graphHandleChildren(hit.id, cached);
        if (cached && cached.length > 0) {
          expandedNodeIds.add(hit.id);
        }
        loadedNodes.add(hit.id);
        return true;
      }
      if (loadedNodes.has(hit.id)) { return true; }
      hit.loading = true;
      graphDraw();
      vscodeApi.postMessage({ type: 'expandRef', instanceId: activeInstanceId, nodeId: hit.id });
      return true;
    }

    // ── Click handlers (tree view) ───────────────────────────────────────
    content.addEventListener('click', (e) => {
      const toggle = e.target.closest('.tree-toggle');
      if (toggle) {
        e.stopPropagation();
        const nodeEl = toggle.closest('.tree-node');
        toggleTreeNode(nodeEl, toggle);
        return;
      }

      const treeRow = e.target.closest('.tree-row');
      if (treeRow && !e.target.closest('.tree-toggle')) {
        if (e.ctrlKey) {
          const nodeEl = treeRow.closest('.tree-node');
          const toggleEl = nodeEl ? nodeEl.querySelector(':scope > .tree-row .tree-toggle') : null;
          toggleTreeNode(nodeEl, toggleEl);
          return;
        }
        if (e.detail === 1) {
          postSingleClickNavigation(
            treeRow.dataset.uri,
            parseInt(treeRow.dataset.callLine, 10),
            parseInt(treeRow.dataset.callChar, 10)
          );
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
    let gNodes = [];   // {id, label, kind, x, y, w, h, children:[], expanded, loading, data, parentId, callSites:[], _callBadgeRects:[], _toggleRect}
    let gEdges = [];   // {from, to}
    let gPan = {x: 0, y: 0};
    let gZoom = 1;
    let gDragging = false;
    let gDragStart = {x: 0, y: 0};
    let gHover = null;
    let gHoverCallSite = -1;  // index of hovered call-site badge (-1 = none)
    let gPendingExpand = null; // nodeId waiting for children
    let gAnimFrame = null;
    let gLayoutAnimFrame = null;
    let gCollapseAnimFrame = null;
    let gWheelPanSensitivity = 1;
    let gWheelTiltPanSensitivity = 0.28;
    let singleClickAction = 'peekOnly';

    function normalizeSingleClickAction(action) {
      return action === 'jumpTo' ? 'jumpTo' : 'peekOnly';
    }

    function postSingleClickNavigation(uri, line, character) {
      vscodeApi.postMessage({
        type: singleClickAction === 'jumpTo' ? 'jumpTo' : 'peekOnly',
        uri,
        line,
        character,
      });
    }

    const G_NODE_H = 24;
    const G_CALL_ROW_H = 14;  // extra height per call-site badge row
    const G_CALLS_PER_ROW = 5;
    const G_NODE_PAD_L = 6;
    const G_NODE_PAD_R = 8;
    const G_DECL_RIGHT_EXTRA = 6;
    const G_PAD_Y = 3;
    const G_KIND_BADGE_W = 12;
    const G_KIND_BADGE_GAP = 3;
    const G_CALL_BADGE_PAD_X = 6;
    const G_CALL_BADGE_GAP = 3;
    const G_CALL_BADGE_H = 12;
    const G_LEVEL_GAP_X = 50;
    const G_LEVEL_GAP_Y = 46;
    const G_SIBLING_GAP_Y = 8;
    const G_SIBLING_GAP_X = 8;
    const G_LAYOUT_ANIM_MS = 180;
    const G_COLLAPSE_ANIM_MS = 160;

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
      if (gCollapseAnimFrame) {
        cancelAnimationFrame(gCollapseAnimFrame);
        gCollapseAnimFrame = null;
      }
      if (gLayoutAnimFrame) {
        cancelAnimationFrame(gLayoutAnimFrame);
        gLayoutAnimFrame = null;
      }
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
        isDeclaration: !!d.rootNode?.isDeclaration,
        noChildren: false,
        x: 0, y: 0, w: 0, h: G_NODE_H,
        children: [],
        expanded: true,
        loading: false,
        data: d.rootNode || null,
        parentId: null,
        callSites: null,
        _callBadgeRects: [],
        _toggleRect: null,
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
          isDeclaration: !!item.isDeclaration,
          noChildren: false,
          x: 0, y: 0, w: 0, h: G_NODE_H,
          children: [],
          expanded: false,
          loading: false,
          data: item,
          parentId: rootId,
          callSites: mg.callSites,
          _callBadgeRects: [],
          _toggleRect: null,
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

    /* Return icon-like symbol for a kind */
    ${buildKindIconFunction('nodeKindIcon')}

    function graphNodeCanToggle(node) {
      if (!node) return false;
      if (node.noChildren) return false;
      if (!node.data || !node.data.nodeId) return true;
      return !String(node.data.nodeId).startsWith('leaf_');
    }

    /* Return symbol for a kind (used in tree view) */
    function kindSymbol(kind) {
      return nodeKindIcon(kind);
    }

    function isDeclarationNode(node) {
      if (!node || !node.isDeclaration) return false;
      return node.kind === 'Function' || node.kind === 'Method' || node.kind === 'Constructor';
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

    function clampSensitivity(value, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) { return fallback; }
      return Math.max(0.05, Math.min(5, n));
    }

    /* Return semi-transparent background color for a kind badge */
    function kindBgColor(kind) {
      const color = nodeKindColor(kind);
      return color ? colorToRgba(color, 0.18) : 'rgba(128,128,128,0.18)';
    }

    /* Return accent color for a kind — reads CSS vars injected from real TextMate theme */
    function nodeKindColor(kind) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--peek-kind-' + kind).trim();
      return v || null;
    }

    /* Tree layout: parent centered on the geometric center of its expanded subtree */
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

      const callFont = '10px ' + getComputedStyle(document.body).fontFamily;
      const nodeMap = {};
      for (const n of gNodes) {
        nodeMap[n.id] = n;
        const isRootNode = n.id === '__root__';
        const displayLabel = stripParams(n.label);
        const qn = splitQualifiedName(displayLabel);
        const useTwoLineLabel = (graphDirection === 'up' || graphDirection === 'down') && !!(qn && qn.owner);
        const ownerText = qn ? qn.owner : '';
        const memberText = qn ? qn.member : displayLabel;
        const ownerW = ownerText ? gTextWidth(ownerText, isRootNode ? ('bold ' + font) : font) : 0;
        const sepW = ownerText ? gTextWidth('::', isRootNode ? ('bold ' + font) : font) : 0;
        const memberW = gTextWidth(memberText, isRootNode ? ('bold ' + font) : font);
        const labelW = useTwoLineLabel ? Math.max(ownerW + sepW, memberW) : (ownerW + sepW + memberW);
        let baseW = G_NODE_PAD_L + G_NODE_PAD_R + G_KIND_BADGE_W + G_KIND_BADGE_GAP + labelW;
        if (isDeclarationNode(n)) {
          baseW += G_DECL_RIGHT_EXTRA;
        }

        const twoLineHeaderH = useTwoLineLabel ? Math.max(G_NODE_H, fontSize * 2 + G_PAD_Y * 2 + 2) : G_NODE_H;
        n._labelTwoLine = useTwoLineLabel;
        n._labelOwner = ownerText;
        n._labelMember = memberText;
        n._headerH = twoLineHeaderH;

        const cs = n.callSites;
        if (cs && cs.length > 1) {
          let maxBadgesRowW = 0;
          for (let rowStart = 0; rowStart < cs.length; rowStart += G_CALLS_PER_ROW) {
            const rowEnd = Math.min(cs.length, rowStart + G_CALLS_PER_ROW);
            let rowW = G_NODE_PAD_L;
            for (let si = rowStart; si < rowEnd; si++) {
              const txt = 'L' + (cs[si].callLine + 1);
              rowW += gTextWidth(txt, callFont) + G_CALL_BADGE_PAD_X + G_CALL_BADGE_GAP;
            }
            rowW += G_NODE_PAD_R - G_CALL_BADGE_GAP;
            if (rowW > maxBadgesRowW) { maxBadgesRowW = rowW; }
          }
          if (maxBadgesRowW > baseW) { baseW = maxBadgesRowW; }
          const rowCount = Math.ceil(cs.length / G_CALLS_PER_ROW);
          n.h = twoLineHeaderH + rowCount * G_CALL_ROW_H;
        } else {
          n.h = twoLineHeaderH;
        }

        n.w = Math.max(baseW, 60);
      }

      if (gNodes.length === 0) {
        return;
      }

      const rootNode = nodeMap['__root__'] || gNodes.find(n => n.parentId == null) || gNodes[0];
      const rootId = rootNode.id;

      const compareNodeIds = (aId, bId) => {
        const a = nodeMap[aId];
        const b = nodeMap[bId];
        if (!a || !b) return String(aId).localeCompare(String(bId));

        const lineA = a.data?.callLine ?? a.data?.line ?? -1;
        const lineB = b.data?.callLine ?? b.data?.line ?? -1;
        if (lineA !== lineB) return lineA - lineB;

        const charA = a.data?.callCharacter ?? a.data?.character ?? -1;
        const charB = b.data?.callCharacter ?? b.data?.character ?? -1;
        if (charA !== charB) return charA - charB;

        return String(a.label || '').localeCompare(String(b.label || ''));
      };

      const childIdsOf = (node) => {
        return (node.children || [])
          .filter(cid => !!nodeMap[cid])
          .slice()
          .sort(compareNodeIds);
      };

      const levels = {};
      const queue = [rootId];
      levels[rootId] = 0;
      while (queue.length > 0) {
        const curId = queue.shift();
        const cur = nodeMap[curId];
        if (!cur) continue;
        const nextLevel = levels[curId] + 1;
        for (const cid of childIdsOf(cur)) {
          if (levels[cid] === undefined) {
            levels[cid] = nextLevel;
            queue.push(cid);
          }
        }
      }

      for (const n of gNodes) {
        if (levels[n.id] === undefined) {
          levels[n.id] = 0;
        }
      }

      let maxLevel = 0;
      for (const n of gNodes) {
        if (levels[n.id] > maxLevel) {
          maxLevel = levels[n.id];
        }
      }

      const levelMaxW = {};
      const levelMaxH = {};
      for (let lv = 0; lv <= maxLevel; lv++) {
        levelMaxW[lv] = 0;
        levelMaxH[lv] = 0;
      }
      for (const n of gNodes) {
        const lv = levels[n.id] ?? 0;
        if (n.w > levelMaxW[lv]) levelMaxW[lv] = n.w;
        if (n.h > levelMaxH[lv]) levelMaxH[lv] = n.h;
      }

      const colLeft = {};
      const rowTop = {};
      colLeft[0] = 40;
      rowTop[0] = 40;

      if (graphDirection === 'right') {
        for (let lv = 1; lv <= maxLevel; lv++) {
          colLeft[lv] = colLeft[lv - 1] + levelMaxW[lv - 1] + G_LEVEL_GAP_X;
        }
      } else if (graphDirection === 'left') {
        for (let lv = 1; lv <= maxLevel; lv++) {
          colLeft[lv] = colLeft[lv - 1] - G_LEVEL_GAP_X - levelMaxW[lv];
        }
      }

      if (graphDirection === 'down') {
        for (let lv = 1; lv <= maxLevel; lv++) {
          rowTop[lv] = rowTop[lv - 1] + levelMaxH[lv - 1] + G_LEVEL_GAP_Y;
        }
      } else if (graphDirection === 'up') {
        for (let lv = 1; lv <= maxLevel; lv++) {
          rowTop[lv] = rowTop[lv - 1] - G_LEVEL_GAP_Y - levelMaxH[lv];
        }
      }

      const spanCache = new Map();
      const calcSubtreeSpan = (nodeId, horizontalGrowth, visiting = new Set()) => {
        const cached = spanCache.get(nodeId);
        if (cached && cached.axis === horizontalGrowth) {
          return cached.span;
        }

        const node = nodeMap[nodeId];
        if (!node) return 0;
        if (visiting.has(nodeId)) {
          return horizontalGrowth ? node.h : node.w;
        }

        visiting.add(nodeId);
        const ownSpan = horizontalGrowth ? node.h : node.w;
        const childIds = childIdsOf(node).filter(cid => levels[cid] === (levels[nodeId] + 1));
        let childrenSpan = 0;
        for (let i = 0; i < childIds.length; i++) {
          const cSpan = calcSubtreeSpan(childIds[i], horizontalGrowth, visiting);
          childrenSpan += cSpan;
          if (i > 0) {
            childrenSpan += horizontalGrowth ? G_SIBLING_GAP_Y : G_SIBLING_GAP_X;
          }
        }
        visiting.delete(nodeId);

        const span = Math.max(ownSpan, childrenSpan || 0);
        spanCache.set(nodeId, { axis: horizontalGrowth, span });
        return span;
      };

      if (graphDirection === 'left' || graphDirection === 'right') {
        spanCache.clear();
        const placeVertical = (nodeId, topY) => {
          const node = nodeMap[nodeId];
          if (!node) return;

          const lv = levels[nodeId] ?? 0;
          const subtreeSpan = calcSubtreeSpan(nodeId, true);
          const nodeCenterY = topY + subtreeSpan / 2;
          node.y = nodeCenterY - node.h / 2;
          node.x = graphDirection === 'left'
            ? (colLeft[lv] + levelMaxW[lv] - node.w)
            : colLeft[lv];

          const childIds = childIdsOf(node).filter(cid => levels[cid] === (lv + 1));
          if (childIds.length === 0) return;

          let childrenTotal = 0;
          const childSpans = [];
          for (let i = 0; i < childIds.length; i++) {
            const sp = calcSubtreeSpan(childIds[i], true);
            childSpans.push(sp);
            childrenTotal += sp;
            if (i > 0) childrenTotal += G_SIBLING_GAP_Y;
          }

          let childTop = topY + (subtreeSpan - childrenTotal) / 2;
          for (let i = 0; i < childIds.length; i++) {
            placeVertical(childIds[i], childTop);
            childTop += childSpans[i] + G_SIBLING_GAP_Y;
          }
        };

        placeVertical(rootId, 40);
      } else {
        spanCache.clear();
        const placeHorizontal = (nodeId, leftX) => {
          const node = nodeMap[nodeId];
          if (!node) return;

          const lv = levels[nodeId] ?? 0;
          const subtreeSpan = calcSubtreeSpan(nodeId, false);
          const nodeCenterX = leftX + subtreeSpan / 2;
          node.x = nodeCenterX - node.w / 2;
          node.y = graphDirection === 'up'
            ? (rowTop[lv] + levelMaxH[lv] - node.h)
            : rowTop[lv];

          const childIds = childIdsOf(node).filter(cid => levels[cid] === (lv + 1));
          if (childIds.length === 0) return;

          let childrenTotal = 0;
          const childSpans = [];
          for (let i = 0; i < childIds.length; i++) {
            const sp = calcSubtreeSpan(childIds[i], false);
            childSpans.push(sp);
            childrenTotal += sp;
            if (i > 0) childrenTotal += G_SIBLING_GAP_X;
          }

          let childLeft = leftX + (subtreeSpan - childrenTotal) / 2;
          for (let i = 0; i < childIds.length; i++) {
            placeHorizontal(childIds[i], childLeft);
            childLeft += childSpans[i] + G_SIBLING_GAP_X;
          }
        };

        placeHorizontal(rootId, 40);
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

    function graphRelayoutKeepView(anchorNodeId, mutateGraphFn) {
      const prevZoom = gZoom;
      const prevPan = { x: gPan.x, y: gPan.y };
      const cw = graphContainer.clientWidth;
      const ch = graphContainer.clientHeight;
      const prevNodeState = new Map();
      for (const n of gNodes) {
        prevNodeState.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
      }

      let anchorScreen = null;
      if (anchorNodeId) {
        const before = gNodes.find(n => n.id === anchorNodeId);
        if (before) {
          const ax = before.x + before.w / 2;
          const ay = before.y + before.h / 2;
          anchorScreen = {
            x: prevPan.x + ax * prevZoom,
            y: prevPan.y + ay * prevZoom,
          };
        }
      }

      const focusWorldX = (cw / 2 - prevPan.x) / prevZoom;
      const focusWorldY = (ch / 2 - prevPan.y) / prevZoom;

      mutateGraphFn();
      graphLayout();

      gZoom = prevZoom;

      if (anchorNodeId && anchorScreen) {
        const after = gNodes.find(n => n.id === anchorNodeId);
        if (after) {
          const ax = after.x + after.w / 2;
          const ay = after.y + after.h / 2;
          gPan.x = anchorScreen.x - ax * gZoom;
          gPan.y = anchorScreen.y - ay * gZoom;
          graphAnimateLayoutTransition(prevNodeState, prevPan, { x: gPan.x, y: gPan.y }, anchorNodeId, G_LAYOUT_ANIM_MS);
          return;
        }
      }

      gPan.x = cw / 2 - focusWorldX * gZoom;
      gPan.y = ch / 2 - focusWorldY * gZoom;
      graphAnimateLayoutTransition(prevNodeState, prevPan, { x: gPan.x, y: gPan.y }, anchorNodeId, G_LAYOUT_ANIM_MS);
    }

    function graphAnimateLayoutTransition(prevNodeState, prevPan, targetPan, anchorNodeId, durationMs) {
      if (gCollapseAnimFrame) {
        cancelAnimationFrame(gCollapseAnimFrame);
        gCollapseAnimFrame = null;
      }
      if (gLayoutAnimFrame) {
        cancelAnimationFrame(gLayoutAnimFrame);
        gLayoutAnimFrame = null;
      }

      const targetNodeState = new Map();
      for (const n of gNodes) {
        targetNodeState.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
      }

      const clearNodeAnimationOpacity = () => {
        for (const n of gNodes) {
          n._animOpacity = null;
        }
      };

      const startNodeState = new Map();
      const anchorStart = anchorNodeId ? prevNodeState.get(anchorNodeId) : undefined;
      for (const n of gNodes) {
        const from = prevNodeState.get(n.id)
          ?? (n.parentId ? prevNodeState.get(n.parentId) : undefined)
          ?? anchorStart
          ?? targetNodeState.get(n.id);
        startNodeState.set(n.id, from);

        // Initialize node positions to start-state for smooth interpolation.
        n.x = from.x;
        n.y = from.y;
        n.w = from.w;
        n.h = from.h;
      }

      gPan.x = prevPan.x;
      gPan.y = prevPan.y;

      if (!durationMs || durationMs <= 0) {
        for (const n of gNodes) {
          const to = targetNodeState.get(n.id);
          if (!to) continue;
          n.x = to.x;
          n.y = to.y;
          n.w = to.w;
          n.h = to.h;
        }
        clearNodeAnimationOpacity();
        gPan.x = targetPan.x;
        gPan.y = targetPan.y;
        graphDraw();
        return;
      }

      const startTime = performance.now();
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

      const tick = (now) => {
        const elapsed = now - startTime;
        const t = Math.max(0, Math.min(1, elapsed / durationMs));
        const e = easeOutCubic(t);

        for (const n of gNodes) {
          const from = startNodeState.get(n.id);
          const to = targetNodeState.get(n.id);
          if (!from || !to) continue;
          n.x = from.x + (to.x - from.x) * e;
          n.y = from.y + (to.y - from.y) * e;
          n.w = from.w + (to.w - from.w) * e;
          n.h = from.h + (to.h - from.h) * e;
          n._animOpacity = prevNodeState.has(n.id) ? 1 : e;
        }

        gPan.x = prevPan.x + (targetPan.x - prevPan.x) * e;
        gPan.y = prevPan.y + (targetPan.y - prevPan.y) * e;
        graphDraw();

        if (t < 1) {
          gLayoutAnimFrame = requestAnimationFrame(tick);
        } else {
          clearNodeAnimationOpacity();
          gLayoutAnimFrame = null;
        }
      };

      gLayoutAnimFrame = requestAnimationFrame(tick);
    }

    function graphCollectDescendantIds(node) {
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
      return toRemove;
    }

    function graphAnimateCollapse(node, onDone) {
      if (!node) {
        onDone();
        return;
      }

      const toRemove = graphCollectDescendantIds(node);
      if (toRemove.size === 0) {
        onDone();
        return;
      }

      if (gLayoutAnimFrame) {
        cancelAnimationFrame(gLayoutAnimFrame);
        gLayoutAnimFrame = null;
      }
      if (gCollapseAnimFrame) {
        cancelAnimationFrame(gCollapseAnimFrame);
        gCollapseAnimFrame = null;
      }

      const startState = new Map();
      for (const n of gNodes) {
        if (toRemove.has(n.id)) {
          startState.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
        }
      }

      const targetCx = node.x + node.w / 2;
      const targetCy = node.y + node.h / 2;
      const targetW = Math.max(8, node.w * 0.3);
      const targetH = Math.max(8, node.h * 0.3);
      const targetX = targetCx - targetW / 2;
      const targetY = targetCy - targetH / 2;

      const startTime = performance.now();
      const easeInCubic = (t) => t * t * t;

      const tick = (now) => {
        const elapsed = now - startTime;
        const t = Math.max(0, Math.min(1, elapsed / G_COLLAPSE_ANIM_MS));
        const e = easeInCubic(t);

        for (const n of gNodes) {
          if (!toRemove.has(n.id)) continue;
          const from = startState.get(n.id);
          if (!from) continue;
          n.x = from.x + (targetX - from.x) * e;
          n.y = from.y + (targetY - from.y) * e;
          n.w = from.w + (targetW - from.w) * e;
          n.h = from.h + (targetH - from.h) * e;
          n._animOpacity = 1 - e;
        }

        graphDraw();

        if (t < 1) {
          gCollapseAnimFrame = requestAnimationFrame(tick);
        } else {
          for (const n of gNodes) {
            if (toRemove.has(n.id)) {
              n._animOpacity = null;
            }
          }
          gCollapseAnimFrame = null;
          onDone();
        }
      };

      gCollapseAnimFrame = requestAnimationFrame(tick);
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
      for (const e of gEdges) {
        const from = nodeMap[e.from];
        const to = nodeMap[e.to];
        if (!from || !to) continue;
        const fromOpacity = from._animOpacity != null ? Math.max(0, Math.min(1, from._animOpacity)) : 1;
        const toOpacity = to._animOpacity != null ? Math.max(0, Math.min(1, to._animOpacity)) : 1;
        const edgeOpacity = Math.min(fromOpacity, toOpacity);
        if (edgeOpacity <= 0.01) { continue; }

        ctx.save();
        ctx.globalAlpha = edgeOpacity;
        ctx.strokeStyle = colorToRgba(edgeColor, 0.8);
        ctx.lineWidth = 0.95;
        let x1, y1, x2, y2, cp1x, cp1y, cp2x, cp2y;
        if (graphDirection === 'up' || graphDirection === 'down') {
          x1 = from.x + from.w / 2;
          y1 = graphDirection === 'up' ? from.y : (from.y + from.h);
          x2 = to.x + to.w / 2;
          y2 = graphDirection === 'up' ? (to.y + to.h) : to.y;
          const cpy = (y1 + y2) / 2;
          cp1x = x1; cp1y = cpy;
          cp2x = x2; cp2y = cpy;
        } else {
          x1 = graphDirection === 'left' ? from.x : (from.x + from.w);
          y1 = from.y + from.h / 2;
          x2 = graphDirection === 'left' ? (to.x + to.w) : to.x;
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
        const arrowSize = 4;
        let finalAngle = 0;
        if (graphDirection === 'up') {
          finalAngle = -Math.PI / 2;
        } else if (graphDirection === 'down') {
          finalAngle = Math.PI / 2;
        } else if (graphDirection === 'left') {
          finalAngle = Math.PI;
        }
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(finalAngle - 0.4), y2 - arrowSize * Math.sin(finalAngle - 0.4));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - arrowSize * Math.cos(finalAngle + 0.4), y2 - arrowSize * Math.sin(finalAngle + 0.4));
        ctx.stroke();
        ctx.restore();
      }

      // Draw nodes
      const fontSize = 12;
      const font = fontSize + 'px ' + getComputedStyle(document.body).fontFamily;
      for (const n of gNodes) {
        const isHover = gHover === n.id;
        n._toggleRect = null;
        const nodeOpacity = n._animOpacity != null ? Math.max(0, Math.min(1, n._animOpacity)) : 1;
        if (nodeOpacity <= 0.01) {
          continue;
        }
        ctx.save();
        ctx.globalAlpha = nodeOpacity;

        // Node shape: function declaration nodes use right trapezoid; others use rounded rectangle
        const rawKindColor = nodeKindColor(n.kind) || funcColor;
        const kindBorderColor = ensureReadableColor(rawKindColor, nodeBg, fg, 2.4);
        const nodeFill = isHover ? hoverBg : nodeBg;
        ctx.fillStyle = nodeFill;
        ctx.strokeStyle = isHover ? ensureReadableColor(accentColor, nodeFill, fg, 2.4) : kindBorderColor;
        ctx.lineWidth = isHover ? 1.35 : 1;
        const ncx = n.x + n.w / 2, ncy = n.y + n.h / 2;
        ctx.beginPath();
        if (isDeclarationNode(n)) {
          const slant = Math.max(8, Math.min(14, n.w * 0.14));
          if (graphDirection === 'left') {
            ctx.moveTo(n.x + slant, n.y);
            ctx.lineTo(n.x + n.w, n.y);
            ctx.lineTo(n.x + n.w, n.y + n.h);
            ctx.lineTo(n.x, n.y + n.h);
          } else {
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(n.x + n.w - slant, n.y);
            ctx.lineTo(n.x + n.w, n.y + n.h);
            ctx.lineTo(n.x, n.y + n.h);
          }
        } else {
          const r = 4;
          ctx.moveTo(n.x + r, n.y);
          ctx.lineTo(n.x + n.w - r, n.y);
          ctx.quadraticCurveTo(n.x + n.w, n.y, n.x + n.w, n.y + r);
          ctx.lineTo(n.x + n.w, n.y + n.h - r);
          ctx.quadraticCurveTo(n.x + n.w, n.y + n.h, n.x + n.w - r, n.y + n.h);
          ctx.lineTo(n.x + r, n.y + n.h);
          ctx.quadraticCurveTo(n.x, n.y + n.h, n.x, n.y + n.h - r);
          ctx.lineTo(n.x, n.y + r);
          ctx.quadraticCurveTo(n.x, n.y, n.x + r, n.y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Loading indicator
        if (n.loading) {
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2;
          let cx = n.x + n.w + 10;
          let cy = n.y + n.h / 2;
          if (graphDirection === 'up') {
            cx = n.x + n.w / 2;
            cy = n.y - 10;
          } else if (graphDirection === 'down') {
            cx = n.x + n.w / 2;
            cy = n.y + n.h + 10;
          } else if (graphDirection === 'left') {
            cx = n.x - 10;
            cy = n.y + n.h / 2;
          }
          const t = (Date.now() % 1000) / 1000 * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, t, t + Math.PI * 1.2);
          ctx.stroke();
          if (!gAnimFrame) {
            gAnimFrame = requestAnimationFrame(() => { gAnimFrame = null; graphDraw(); });
          }
        }

        // Kind badge + label (supports two-line qualified names in vertical mode)
        const hasMultiCS = n.callSites && n.callSites.length > 1;
        const headerH = n._headerH || G_NODE_H;
        const labelCenterY = n.y + headerH / 2;
        const letter    = nodeKindIcon(n.kind);
        const badgeW    = G_KIND_BADGE_W;
        const badgeH    = G_KIND_BADGE_W;
        const badgeGap  = G_KIND_BADGE_GAP;
        const drawFont  = font;
        ctx.font = drawFont;
        const rawLabel  = stripParams(n.label);
        const qn = splitQualifiedName(rawLabel);
        const useTwoLineLabel = !!n._labelTwoLine;
        const ownerText = n._labelOwner != null ? n._labelOwner : (qn ? qn.owner : '');
        const memberText = n._labelMember != null ? n._labelMember : (qn ? qn.member : rawLabel);
        const sepText = ownerText ? '::' : '';
        const ownerW = ownerText ? gTextWidth(ownerText, drawFont) : 0;
        const sepW = sepText ? gTextWidth(sepText, drawFont) : 0;
        const memberW = gTextWidth(memberText, drawFont);
        const textW = useTwoLineLabel ? Math.max(ownerW + sepW, memberW) : (ownerW + sepW + memberW);
        const totalContentW = badgeW + badgeGap + textW;
        const startX = graphDirection === 'left'
          ? (n.x + n.w - G_NODE_PAD_R - totalContentW)
          : (n.x + G_NODE_PAD_L);

        // Badge symbol
        ctx.font = '600 9px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = kindBorderColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, startX + badgeW / 2, labelCenterY);

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
        if (useTwoLineLabel && ownerText) {
          const lineGap = 2;
          const firstLineY = labelCenterY - (fontSize / 2 + lineGap / 2);
          const secondLineY = labelCenterY + (fontSize / 2 + lineGap / 2);

          ctx.fillStyle = ownerColor;
          ctx.fillText(ownerText, textX, firstLineY);
          ctx.fillStyle = sepColor;
          ctx.fillText('::', textX + ownerW, firstLineY);

          ctx.fillStyle = memberColor;
          ctx.fillText(memberText, textX, secondLineY);
        } else {
          if (ownerText) {
            ctx.fillStyle = ownerColor;
            ctx.fillText(ownerText, textX, labelCenterY);
            textX += ownerW;
            ctx.fillStyle = sepColor;
            ctx.fillText('::', textX, labelCenterY);
            textX += sepW;
          }
          ctx.fillStyle = memberColor;
          ctx.fillText(memberText, textX, labelCenterY);
        }

        // Expand/collapse toggle icon (on node extension side)
        if (graphNodeCanToggle(n) || n.noChildren) {
          const toggleSize = 12;
          const toggleGap = 4;
          let tx;
          let ty;
          if (graphDirection === 'up') {
            tx = n.x + n.w / 2 - toggleSize / 2;
            ty = n.y - toggleGap - toggleSize;
          } else if (graphDirection === 'down') {
            tx = n.x + n.w / 2 - toggleSize / 2;
            ty = n.y + n.h + toggleGap;
          } else if (graphDirection === 'left') {
            tx = n.x - toggleGap - toggleSize;
            ty = n.y + n.h / 2 - toggleSize / 2;
          } else {
            tx = n.x + n.w + toggleGap;
            ty = n.y + n.h / 2 - toggleSize / 2;
          }
          const isInteractiveToggle = graphNodeCanToggle(n);
          n._toggleRect = isInteractiveToggle ? { x: tx, y: ty, w: toggleSize, h: toggleSize } : null;

          const toggleHover = (gHover === n.id && gHoverCallSite === -2 && isInteractiveToggle);
          const cx = tx + toggleSize / 2;
          const cy = ty + toggleSize / 2;

          if (n.noChildren) {
            ctx.fillStyle = colorToRgba(dimColor, 0.10);
            ctx.strokeStyle = colorToRgba(dimColor, 0.85);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillStyle = toggleHover ? colorToRgba(accentColor, 0.28) : colorToRgba(dimColor, 0.16);
            ctx.strokeStyle = toggleHover ? ensureReadableColor(accentColor, nodeFill, fg, 2.2) : colorToRgba(dimColor, 0.75);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(tx, ty, toggleSize, toggleSize, 3);
            ctx.fill();
            ctx.stroke();

            ctx.strokeStyle = toggleHover
              ? ensureReadableColor(accentColor, nodeFill, fg, 3.0)
              : ensureReadableColor(dimColor, nodeFill, fg, 3.0);
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy);
            ctx.lineTo(cx + 3, cy);
            if (!n.expanded) {
              ctx.moveTo(cx, cy - 3);
              ctx.lineTo(cx, cy + 3);
            }
            ctx.stroke();
          }
        }

        // ── Call-site line-number badges (only for merged nodes) ──────────
        n._callBadgeRects = [];
        const cs = n.callSites;
        if (cs && cs.length > 1) {
          const cFont = '10px ' + getComputedStyle(document.body).fontFamily;
          ctx.font = cFont;
          const badgeRowY = n.y + headerH;
          for (let rowStart = 0; rowStart < cs.length; rowStart += G_CALLS_PER_ROW) {
            const rowEnd = Math.min(cs.length, rowStart + G_CALLS_PER_ROW);
            let bx = graphDirection === 'left'
              ? (n.x + n.w - G_NODE_PAD_R)
              : (n.x + G_NODE_PAD_L);
            for (let si = rowStart; si < rowEnd; si++) {
              const txt = 'L' + (cs[si].callLine + 1);
              const tw = ctx.measureText(txt).width;
              const bw = tw + G_CALL_BADGE_PAD_X;
              const bh = G_CALL_BADGE_H;
              const rowIndex = Math.floor(si / G_CALLS_PER_ROW);
              const by = badgeRowY + rowIndex * G_CALL_ROW_H + (G_CALL_ROW_H - bh) / 2;

              // Highlight hovered badge
              const isHot = (gHover === n.id && gHoverCallSite === si);

              // Badge background
              ctx.fillStyle = isHot ? colorToRgba(accentColor, 0.35) : colorToRgba(dimColor, 0.18);
              const badgeX = graphDirection === 'left' ? (bx - bw) : bx;
              ctx.beginPath();
              ctx.roundRect(badgeX, by, bw, bh, 2);
              ctx.fill();

              // Badge text
              ctx.fillStyle = isHot
                ? ensureReadableColor(accentColor, nodeFill, fg, 3.0)
                : ensureReadableColor(dimColor, nodeFill, fg, 3.0);
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              if (graphDirection === 'left') {
                const drawX = badgeX;
                ctx.fillText(txt, drawX + bw / 2, by + bh / 2);
                n._callBadgeRects.push({ x: drawX, y: by, w: bw, h: bh, idx: si });
                bx = drawX - G_CALL_BADGE_GAP;
              } else {
                ctx.fillText(txt, bx + bw / 2, by + bh / 2);
                n._callBadgeRects.push({ x: bx, y: by, w: bw, h: bh, idx: si });
                bx += bw + G_CALL_BADGE_GAP;
              }
            }
          }
        }

        ctx.restore();
      }

      ctx.restore();
    }

    /* Hit-test: which node is under canvas coords? */
    function graphHitTest(cx, cy) {
      const wx = (cx - gPan.x) / gZoom;
      const wy = (cy - gPan.y) / gZoom;
      for (let i = gNodes.length - 1; i >= 0; i--) {
        const n = gNodes[i];
        const r = n._toggleRect;
        const minX = r ? Math.min(n.x, r.x) : n.x;
        const maxX = r ? Math.max(n.x + n.w, r.x + r.w) : (n.x + n.w);
        const minY = r ? Math.min(n.y, r.y) : n.y;
        const maxY = r ? Math.max(n.y + n.h, r.y + r.h) : n.y + n.h;
        if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
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

    function graphHitTestToggle(node, cx, cy) {
      if (!node || !node._toggleRect) return false;
      const wx = (cx - gPan.x) / gZoom;
      const wy = (cy - gPan.y) / gZoom;
      const r = node._toggleRect;
      return wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
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
        parent.noChildren = true;
        graphDraw();
        return;
      }

      graphRelayoutKeepView(parentNodeId, () => {
        parent.expanded = true;
        parent.noChildren = false;
        const merged = mergeItemsBySymbol(items);
        for (const mg of merged) {
          const item = mg.primary;
          const nid = item.nodeId;
          if (nodeMap[nid]) continue; // avoid duplicates
          gNodes.push({
            id: nid,
            label: item.label,
            kind: item.kind || '',
            isDeclaration: !!item.isDeclaration,
            noChildren: false,
            x: 0, y: 0, w: 0, h: G_NODE_H,
            children: [],
            expanded: false,
            loading: false,
            data: item,
            parentId: parentNodeId,
            callSites: mg.callSites,
            _callBadgeRects: [],
            _toggleRect: null,
          });
          parent.children.push(nid);
          gEdges.push({ from: parentNodeId, to: nid });
        }

        // Restore previously expanded descendants (if parent was collapsed earlier).
        restoreGraphExpansions();
      });
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
      let newCallSite = -1;
      if (hit) {
        if (graphHitTestToggle(hit, cx, cy)) {
          newCallSite = -2;
        } else {
          newCallSite = graphHitTestCallSite(hit, cx, cy);
        }
      }
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
      if (e.ctrlKey) {
        const rect = graphCanvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.max(0.2, Math.min(5, gZoom * factor));
        // Zoom towards cursor
        gPan.x = cx - (cx - gPan.x) * (newZoom / gZoom);
        gPan.y = cy - (cy - gPan.y) * (newZoom / gZoom);
        gZoom = newZoom;
      } else if (e.shiftKey) {
        const dx = Math.abs(e.deltaX) > 0.01 ? e.deltaX : e.deltaY;
        gPan.x -= dx * gWheelPanSensitivity;
      } else {
        gPan.x -= e.deltaX * gWheelTiltPanSensitivity;
        gPan.y -= e.deltaY * gWheelPanSensitivity;
      }
      graphDraw();
    }, { passive: false });

    graphCanvas.addEventListener('contextmenu', (e) => {
      if (!lastUpdateData) { return; }
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = graphHitTest(cx, cy);
      if (hit) { return; }
      e.preventDefault();
      hideInstanceContextMenu();
      showSplitContextMenu(e.clientX, e.clientY);
    });

    // Click: peek in context window (single), open in editor (double), expand/collapse (+/- icon)
    graphCanvas.addEventListener('click', (e) => {
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = graphHitTest(cx, cy);
      if (!hit) return;

      if (e.ctrlKey) {
        toggleGraphNode(hit);
        return;
      }

      if (graphHitTestToggle(hit, cx, cy)) {
        toggleGraphNode(hit);
        return;
      }

      // Single click: update peek view only (do NOT open editor)
      if (e.detail === 1 && hit.data) {
        const csIdx = graphHitTestCallSite(hit, cx, cy);
        const cs = hit.callSites;
        const cl = (csIdx >= 0 && cs) ? cs[csIdx].callLine : (hit.data.callLine != null ? hit.data.callLine : hit.data.line);
        const cc = (csIdx >= 0 && cs) ? cs[csIdx].callCharacter : (hit.data.callCharacter != null ? hit.data.callCharacter : hit.data.character);
        const cu = (csIdx >= 0 && cs) ? cs[csIdx].uri : hit.data.uri;
        postSingleClickNavigation(cu, cl, cc);
      }
    });

    // Double-click: open in editor
    graphCanvas.addEventListener('dblclick', (e) => {
      const rect = graphCanvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const hit = graphHitTest(cx, cy);
      if (!hit || !hit.data) return;
      if (graphHitTestToggle(hit, cx, cy)) return;
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

    return {
      paneId,
      paneRoot,
      hasInstance(instanceId) {
        return instanceStateMap.has(instanceId);
      },
      getInstanceIds() {
        return [...instanceOrder];
      },
      getTransferPayload(instanceId, options) {
        return buildTransferPayload(instanceId, options);
      },
      importTransferredInstance,
      removeInstance(instanceId, options) {
        removeInstanceInternal(instanceId, options);
      },
      closeAllInstances,
      handleMessage,
    };
    }

    function createPaneControllerAndMount() {
      paneIdSeed += 1;
      const paneId = 'pane_' + paneIdSeed;
      const shell = createPaneShell(paneId);
      const controller = createPaneController(shell, paneId);
      paneControllers.set(paneId, controller);
      if (latestThemeCss) {
        controller.handleMessage({ type: 'themeColors', css: latestThemeCss });
      }
      if (latestInteractionConfig) {
        controller.handleMessage(Object.assign({ type: 'interactionConfig' }, latestInteractionConfig));
      }
      controller.handleMessage({
        type: 'initViewState',
        mode: latestViewState.mode,
        direction: latestViewState.direction,
      });
      return controller;
    }

    function hideSplitContextMenu() {
      splitContextMenu.hidden = true;
    }

    function showSplitContextMenu(clientX, clientY) {
      const multiPane = paneControllers.size > 1;
      const horizontal = currentSplitMode === 'horizontal';
      if (splitHorizontalMenuItem) {
        splitHorizontalMenuItem.style.display = multiPane ? 'none' : '';
      }
      if (splitVerticalMenuItem) {
        splitVerticalMenuItem.style.display = multiPane ? 'none' : '';
      }
      if (switchHorizontalMenuItem) {
        switchHorizontalMenuItem.style.display = multiPane && !horizontal ? '' : 'none';
      }
      if (switchVerticalMenuItem) {
        switchVerticalMenuItem.style.display = multiPane && horizontal ? '' : 'none';
      }
      if (swapPanesMenuItem) {
        swapPanesMenuItem.style.display = multiPane ? '' : 'none';
      }
      if (restoreSingleMenuItem) {
        restoreSingleMenuItem.style.display = multiPane ? '' : 'none';
      }
      splitContextMenu.hidden = false;
      splitContextMenu.style.left = clientX + 'px';
      splitContextMenu.style.top = clientY + 'px';
      const rect = splitContextMenu.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 4;
      const maxY = window.innerHeight - rect.height - 4;
      splitContextMenu.style.left = Math.max(4, Math.min(clientX, maxX)) + 'px';
      splitContextMenu.style.top = Math.max(4, Math.min(clientY, maxY)) + 'px';
    }

    function ensureSecondPane() {
      if (paneControllers.size >= 2) { return; }
      createPaneControllerAndMount();
    }

    function getOtherPaneController(sourcePaneId, options) {
      const opts = options || {};
      if (opts.ensurePane) {
        ensureSecondPane();
      }
      for (const pane of paneControllers.values()) {
        if (pane.paneId !== sourcePaneId) {
          return pane;
        }
      }
      return null;
    }

    function moveOrCopyInstanceToOtherPane(sourcePaneId, instanceId, isMove) {
      const sourcePane = paneControllers.get(sourcePaneId);
      if (!sourcePane || !instanceId) { return; }
      const wasSinglePane = paneControllers.size <= 1;
      const targetPane = getOtherPaneController(sourcePaneId, { ensurePane: true });
      if (!targetPane) { return; }
      if (wasSinglePane) {
        setSplitMode('vertical');
      }

      const payload = sourcePane.getTransferPayload(instanceId, { preserveInstanceId: isMove });
      if (!payload) { return; }
      if (!isMove) {
        payload.title = payload.title + ' Copy';
      }
      targetPane.importTransferredInstance(payload);

      if (isMove) {
        sourcePane.removeInstance(instanceId, {
          force: true,
          skipCloseMessage: true,
        });
      }
    }

    function setSplitMode(mode) {
      currentSplitMode = mode === 'horizontal' || mode === 'vertical' ? mode : 'single';
      paneHost.classList.remove('mode-single', 'mode-horizontal', 'mode-vertical');
      if (currentSplitMode === 'horizontal') {
        paneHost.classList.add('mode-horizontal');
      } else if (currentSplitMode === 'vertical') {
        paneHost.classList.add('mode-vertical');
      } else {
        paneHost.classList.add('mode-single');
      }
    }

    function swapPanePositions() {
      const shells = paneHost.querySelectorAll('.pane-shell');
      if (shells.length < 2) { return; }
      paneHost.insertBefore(shells[1], shells[0]);
    }

    function restoreSinglePane() {
      if (paneControllers.size <= 1) {
        setSplitMode('single');
        return;
      }
      const panes = [...paneControllers.values()];
      const keeper = panes[0];
      for (let i = 1; i < panes.length; i += 1) {
        const pane = panes[i];
        const ids = pane.getInstanceIds();
        for (const id of ids) {
          const payload = pane.getTransferPayload(id, { preserveInstanceId: true });
          if (payload) {
            keeper.importTransferredInstance(payload);
          }
        }
        pane.paneRoot.remove();
        paneControllers.delete(pane.paneId);
      }
      if (keeper && !paneHost.contains(keeper.paneRoot)) {
        paneHost.appendChild(keeper.paneRoot);
      }
      setSplitMode('single');
    }

    createPaneControllerAndMount();
    setSplitMode('single');

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) { return; }

      if (msg.type === 'themeColors') {
        latestThemeCss = String(msg.css || '');
        for (const pane of paneControllers.values()) {
          pane.handleMessage(msg);
        }
        return;
      }

      if (msg.type === 'interactionConfig') {
        latestInteractionConfig = {
          wheelPanSensitivity: msg.wheelPanSensitivity,
          wheelTiltPanSensitivity: msg.wheelTiltPanSensitivity,
          singleClickAction: msg.singleClickAction,
        };
        for (const pane of paneControllers.values()) {
          pane.handleMessage(msg);
        }
        return;
      }

      if (msg.type === 'initViewState') {
        latestViewState = {
          mode: msg.mode === 'graph' ? 'graph' : 'tree',
          direction: msg.direction === 'left' || msg.direction === 'right' || msg.direction === 'up' || msg.direction === 'down'
            ? msg.direction
            : 'right',
        };
        for (const pane of paneControllers.values()) {
          pane.handleMessage(msg);
        }
        return;
      }

      if (typeof msg.instanceId === 'string' && msg.instanceId) {
        for (const pane of paneControllers.values()) {
          if (pane.hasInstance(msg.instanceId)) {
            pane.handleMessage(msg);
            return;
          }
        }
      }

      const firstPane = paneControllers.values().next().value;
      if (firstPane) {
        firstPane.handleMessage(msg);
      }
    });

    document.addEventListener('contextmenu', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) { return; }
      if (target.closest('.instance-tab, .instance-tab-close, .instance-context-menu, .instance-context-item, .tree-row, .tree-toggle, canvas, button, select, input, textarea')) {
        return;
      }
      event.preventDefault();
      showSplitContextMenu(event.clientX, event.clientY);
    });

    splitContextMenu.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) { return; }
      const item = event.target.closest('.split-context-item');
      if (!item) { return; }
      const action = item.dataset.action;
      if (action === 'split-horizontal') {
        ensureSecondPane();
        setSplitMode('horizontal');
      } else if (action === 'split-vertical') {
        ensureSecondPane();
        setSplitMode('vertical');
      } else if (action === 'switch-horizontal') {
        setSplitMode('horizontal');
      } else if (action === 'switch-vertical') {
        setSplitMode('vertical');
      } else if (action === 'swap-panes') {
        swapPanePositions();
      } else if (action === 'restore-single') {
        restoreSinglePane();
      }
      hideSplitContextMenu();
    });

    document.addEventListener('click', (event) => {
      if (splitContextMenu.hidden) { return; }
      if (!(event.target instanceof Element)) { return; }
      if (!event.target.closest('#split-context-menu')) {
        hideSplitContextMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideSplitContextMenu();
      }
    });

    window.addEventListener('blur', hideSplitContextMenu);
  </script>
</body>
</html>`;
  }
}
