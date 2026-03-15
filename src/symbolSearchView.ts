import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from './utils';
import { buildKindIconFunction, getThemeColorsCss, symbolKindToName } from './viewCommon';
import { PeekViewProvider } from './peekView';

interface SymbolSearchResultItem {
  name: string;
  containerName: string;
  kind: string;
  uri: string;
  relativePath: string;
  line: number;
  character: number;
}

type SearchMode = 'exact' | 'fuzzy';
type SortMode = 'relevance' | 'name-asc' | 'name-desc' | 'kind' | 'path';

export class SymbolSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'symbolSearch.view';
  private static readonly SEARCH_MODE_STATE_KEY = 'symbolSearch.searchMode';
  private static readonly SORT_MODE_STATE_KEY = 'symbolSearch.sortMode';

  private _view?: vscode.WebviewView;
  private _searchSeq = 0;
  private _searchMode: SearchMode;
  private _sortMode: SortMode;
  private _peekView?: PeekViewProvider;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._searchMode = this._normalizeSearchMode(
      this._context.workspaceState.get<string>(SymbolSearchViewProvider.SEARCH_MODE_STATE_KEY)
    );
    this._sortMode = this._normalizeSortMode(
      this._context.workspaceState.get<string>(SymbolSearchViewProvider.SORT_MODE_STATE_KEY)
    );
  }

  private _normalizeSearchMode(mode: unknown): SearchMode {
    return mode === 'fuzzy' ? 'fuzzy' : 'exact';
  }

  private _normalizeSortMode(mode: unknown): SortMode {
    return mode === 'name-asc' || mode === 'name-desc' || mode === 'kind' || mode === 'path'
      ? mode
      : 'relevance';
  }

  private async _savePreferences(mode: SearchMode, sortMode: SortMode): Promise<void> {
    this._searchMode = this._normalizeSearchMode(mode);
    this._sortMode = this._normalizeSortMode(sortMode);
    await this._context.workspaceState.update(SymbolSearchViewProvider.SEARCH_MODE_STATE_KEY, this._searchMode);
    await this._context.workspaceState.update(SymbolSearchViewProvider.SORT_MODE_STATE_KEY, this._sortMode);
  }

  pushThemeColors(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'themeColors',
      css: getThemeColorsCss(),
    });
  }

  pushInteractionConfig(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({
      type: 'interactionConfig',
      singleClickAction: this._getSingleClickAction(),
    });
  }

  private _getSingleClickAction(): 'peekOnly' | 'jumpTo' {
    const raw = vscode.workspace.getConfiguration('symbolSearch').get<string>('singleClickAction', 'peekOnly');
    return raw === 'jumpTo' ? 'jumpTo' : 'peekOnly';
  }

  setPeekView(pv: PeekViewProvider): void {
    this._peekView = pv;
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
      if (msg.type === 'ready') {
        this.pushThemeColors();
        this.pushInteractionConfig();
        webviewView.webview.postMessage({
          type: 'initPreferences',
          mode: this._searchMode,
          sortMode: this._sortMode,
        });
        webviewView.webview.postMessage({
          type: 'results',
          requestId: 0,
          query: '',
          items: [],
          total: 0,
        });
        return;
      }

      if (msg.type === 'queryChange') {
        const query = typeof msg.query === 'string' ? msg.query : '';
        const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
        const fuzzy = Boolean(msg.fuzzy);
        const sortMode = this._normalizeSortMode(msg.sortMode);
        await this._search(query, requestId, fuzzy, sortMode);
        return;
      }

      if (msg.type === 'setPreferences') {
        const mode: SearchMode = Boolean(msg.fuzzy) ? 'fuzzy' : 'exact';
        const sortMode = this._normalizeSortMode(msg.sortMode);
        await this._savePreferences(mode, sortMode);
        return;
      }

      if (msg.type === 'peekOnly') {
        const uriRaw = typeof msg.uri === 'string' ? msg.uri : '';
        const line = typeof msg.line === 'number' ? msg.line : 0;
        const character = typeof msg.character === 'number' ? msg.character : 0;
        if (!uriRaw) { return; }
        await this._peekLocation(vscode.Uri.parse(uriRaw), line, character);
        return;
      }

      if (msg.type === 'jumpTo') {
        const uriRaw = typeof msg.uri === 'string' ? msg.uri : '';
        const line = typeof msg.line === 'number' ? msg.line : 0;
        const character = typeof msg.character === 'number' ? msg.character : 0;
        if (!uriRaw) { return; }
        const uri = vscode.Uri.parse(uriRaw);
        await this._peekLocation(uri, line, character);
        await this._openLocation(uri, line, character);
      }
    });
  }

  private async _search(query: string, requestId: number, fuzzy: boolean, sortMode: SortMode): Promise<void> {
    if (!this._view) { return; }

    const trimmed = query.trim();
    const currentSeq = ++this._searchSeq;

    if (!trimmed) {
      this._view.webview.postMessage({
        type: 'results',
        requestId,
        query: '',
        items: [] as SymbolSearchResultItem[],
        total: 0,
      });
      return;
    }

    this._view.webview.postMessage({ type: 'loading', requestId, query: trimmed });

    const keywords = this._splitKeywords(trimmed);
    const providerQuery = keywords[0] ?? trimmed;

    let rawItems: vscode.SymbolInformation[] = [];
    try {
      const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        providerQuery
      );
      rawItems = result ?? [];
    } catch {
      rawItems = [];
    }

    if (!this._view || currentSeq !== this._searchSeq) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const maxResults = 300;
    const filteredItems = rawItems.filter((item) => {
      const name = item.name ?? '';
      const containerName = item.containerName ?? '';
      const kind = this._kindToString(item.kind);
      const source = `${name} ${containerName} ${kind}`;
      return this._matchesAllKeywords(source, keywords, fuzzy);
    });

    const sortedItems = this._sortItems(filteredItems, sortMode);

    const items = sortedItems.slice(0, maxResults).map((item) => {
      const fsPath = item.location.uri.fsPath;
      const relativePath = workspaceRoot
        ? path.relative(workspaceRoot, fsPath).replace(/\\/g, '/')
        : fsPath;
      return {
        name: item.name,
        containerName: item.containerName ?? '',
        kind: this._kindToString(item.kind),
        uri: item.location.uri.toString(),
        relativePath,
        line: item.location.range.start.line,
        character: item.location.range.start.character,
      } satisfies SymbolSearchResultItem;
    });

    this._view.webview.postMessage({
      type: 'results',
      requestId,
      query: trimmed,
      items,
      total: filteredItems.length,
      fuzzy,
      sortMode,
    });
  }

  private _sortItems(items: vscode.SymbolInformation[], sortMode: SortMode): vscode.SymbolInformation[] {
    if (sortMode === 'relevance') {
      return items;
    }

    const getKind = (item: vscode.SymbolInformation): string => this._kindToString(item.kind);
    const sorted = [...items].sort((left, right) => {
      if (sortMode === 'name-asc' || sortMode === 'name-desc') {
        const leftName = (left.name ?? '').toLowerCase();
        const rightName = (right.name ?? '').toLowerCase();
        const result = leftName.localeCompare(rightName);
        return sortMode === 'name-desc' ? -result : result;
      }

      if (sortMode === 'kind') {
        const kindResult = getKind(left).localeCompare(getKind(right));
        if (kindResult !== 0) {
          return kindResult;
        }
        return (left.name ?? '').toLowerCase().localeCompare((right.name ?? '').toLowerCase());
      }

      const leftPath = left.location.uri.fsPath.toLowerCase();
      const rightPath = right.location.uri.fsPath.toLowerCase();
      const pathResult = leftPath.localeCompare(rightPath);
      if (pathResult !== 0) {
        return pathResult;
      }
      return (left.name ?? '').toLowerCase().localeCompare((right.name ?? '').toLowerCase());
    });

    return sorted;
  }

  private _splitKeywords(query: string): string[] {
    return query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  private _matchesAllKeywords(source: string, keywords: string[], fuzzy: boolean): boolean {
    const sourceLower = source.toLowerCase();
    if (keywords.length === 0) {
      return true;
    }

    return keywords.every((keyword) => (
      fuzzy
        ? this._isFuzzyMatch(sourceLower, keyword)
        : sourceLower.includes(keyword)
    ));
  }

  private _isFuzzyMatch(source: string, query: string): boolean {
    const queryLower = query.toLowerCase();
    if (!queryLower) {
      return true;
    }
    let queryIndex = 0;
    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
      if (source[sourceIndex].toLowerCase() === queryLower[queryIndex]) {
        queryIndex++;
        if (queryIndex >= queryLower.length) {
          return true;
        }
      }
    }
    return false;
  }

  private async _openLocation(uri: vscode.Uri, line: number, character: number): Promise<void> {
    const safeLine = Math.max(0, line);
    const safeCharacter = Math.max(0, character);
    const pos = new vscode.Position(safeLine, safeCharacter);
    const range = new vscode.Range(pos, pos);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async _peekLocation(uri: vscode.Uri, line: number, character: number): Promise<void> {
    const safeLine = Math.max(0, line);
    const safeCharacter = Math.max(0, character);
    await this._peekView?.peekLocation(uri, new vscode.Position(safeLine, safeCharacter));
  }

  private _kindToString(kind: vscode.SymbolKind): string {
    return symbolKindToName(kind);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const initialThemeCss = getThemeColorsCss();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Symbol Search</title>
  <style nonce="${nonce}">
    :root {
      --pm-border: var(--vscode-panel-border, var(--vscode-editorWidget-border));
      --pm-fg-muted: var(--vscode-descriptionForeground, var(--vscode-foreground));
      --pm-bg-hover: var(--vscode-list-hoverBackground, var(--vscode-editorHoverWidget-background));
      --pm-bg-active: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground));
      --pm-fg-active: var(--vscode-list-activeSelectionForeground, var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)));
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font: 12px/1.45 var(--vscode-font-family);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    #top-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #mode-tabs {
      display: inline-flex;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      overflow: hidden;
      flex-shrink: 0;
      width: fit-content;
    }

    .mode-tab {
      cursor: pointer;
      padding: 2px 10px;
      font-size: 12px;
      line-height: 1.4;
      border: none;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      color: var(--vscode-foreground, #d4d4d4);
      border-right: 1px solid var(--vscode-panel-border, #333);
    }

    .mode-tab:last-child {
      border-right: none;
    }

    .mode-tab.active {
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      color: var(--vscode-tab-activeForeground, #fff);
    }

    #sort-wrap {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    #sort-wrap label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
    }

    #sort-mode {
      height: 22px;
      font-size: 12px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, #333));
      background: var(--vscode-dropdown-background, var(--vscode-sideBarSectionHeader-background, #252526));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #d4d4d4));
      border-radius: 4px;
      padding: 0 6px;
    }

    .search-row {
      display: flex;
      align-items: center;
    }

    .input-wrap {
      flex: 1;
      border: 1px solid var(--pm-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-input-background);
    }

    #queryInput {
      width: 100%;
      border: 0;
      outline: none;
      padding: 8px 10px;
      color: var(--vscode-input-foreground);
      background: transparent;
      font: inherit;
    }

    #queryInput::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .status {
      color: var(--pm-fg-muted);
      min-height: 18px;
    }

    .list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--pm-border);
      border-radius: 6px;
    }

    .item {
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--pm-border);
      cursor: pointer;
      display: grid;
      gap: 2px;
    }

    .item:last-child {
      border-bottom: 0;
    }

    .item:hover {
      background: var(--pm-bg-hover);
    }

    .item:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      background: var(--pm-bg-active);
      color: var(--pm-fg-active);
    }

    .row-1 {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }

    .name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .kind-icon {
      font-size: 13px;
      line-height: 1;
      white-space: nowrap;
    }

    .row-2 {
      color: var(--pm-fg-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 11px;
    }

    .empty {
      padding: 14px 10px;
      color: var(--pm-fg-muted);
    }
  </style>
  <style id="theme-tokens">${initialThemeCss}</style>
</head>
<body>
  <div id="top-controls">
    <div id="mode-tabs" role="tablist" aria-label="Search Mode">
      <button id="mode-tab-exact" class="mode-tab active" role="tab" aria-selected="true" title="Exact search mode">Exact</button>
      <button id="mode-tab-fuzzy" class="mode-tab" role="tab" aria-selected="false" title="Fuzzy search mode">Fuzzy</button>
    </div>
    <div id="sort-wrap">
      <label for="sort-mode">Sort</label>
      <select id="sort-mode" title="Sort search results">
        <option value="relevance">Relevance</option>
        <option value="name-asc">Name (A-Z)</option>
        <option value="name-desc">Name (Z-A)</option>
        <option value="kind">Kind</option>
        <option value="path">Path</option>
      </select>
    </div>
  </div>
  <div class="search-row">
    <div class="input-wrap">
      <input id="queryInput" type="text" placeholder="Search workspace symbols..." />
    </div>
  </div>
  <div id="status" class="status">Type to search symbols in workspace.</div>
  <div id="resultList" class="list"></div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const modeTabExact = document.getElementById('mode-tab-exact');
    const modeTabFuzzy = document.getElementById('mode-tab-fuzzy');
    const sortModeSelect = document.getElementById('sort-mode');
    const queryInput = document.getElementById('queryInput');
    const statusEl = document.getElementById('status');
    const listEl = document.getElementById('resultList');

    let requestId = 0;
    let debounceTimer = undefined;
    let fuzzyMode = false;
    let sortMode = 'relevance';
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

    function updateModeTabs() {
      if (modeTabExact) {
        modeTabExact.classList.toggle('active', !fuzzyMode);
        modeTabExact.setAttribute('aria-selected', fuzzyMode ? 'false' : 'true');
      }
      if (modeTabFuzzy) {
        modeTabFuzzy.classList.toggle('active', fuzzyMode);
        modeTabFuzzy.setAttribute('aria-selected', fuzzyMode ? 'true' : 'false');
      }
    }

    function setSearchMode(nextFuzzy) {
      const normalized = Boolean(nextFuzzy);
      if (normalized === fuzzyMode) {
        return;
      }
      fuzzyMode = normalized;
      updateModeTabs();
      persistPreferences();
      sendQuery();
    }

    function setSortMode(nextSortMode) {
      const normalized = String(nextSortMode || 'relevance');
      if (normalized === sortMode) {
        return;
      }
      sortMode = normalized;
      if (sortModeSelect) {
        sortModeSelect.value = sortMode;
      }
      persistPreferences();
      sendQuery();
    }

    function persistPreferences() {
      vscodeApi.postMessage({
        type: 'setPreferences',
        fuzzy: fuzzyMode,
        sortMode,
      });
    }

    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function stripParams(name) {
      const idx = String(name || '').indexOf('(');
      return idx > 0 ? String(name).substring(0, idx) : String(name || '');
    }

    function splitQualifiedName(name) {
      const clean = stripParams(name || '');
      const idx = clean.lastIndexOf('::');
      if (idx <= 0 || idx + 2 >= clean.length) {
        return null;
      }
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

    ${buildKindIconFunction('kindIcon')}

    function sendQuery() {
      requestId += 1;
      vscodeApi.postMessage({
        type: 'queryChange',
        requestId,
        query: queryInput.value,
        fuzzy: fuzzyMode,
        sortMode,
      });
    }

    function onInput() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(sendQuery, 120);
    }

    function renderItems(items) {
      if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="empty">No symbols found.</div>';
        return;
      }

      listEl.innerHTML = items.map((item) => {
        const kindRaw = String(item.kind || 'Symbol');
        const kind = escapeHtml(kindRaw);
        const icon = kindIcon(kindRaw);
        const nameHtml = renderQualifiedNameHtml(item.name || '', kindRaw);
        const container = escapeHtml(item.containerName || '');
        const relativePath = escapeHtml(item.relativePath || '');
        const character = Number(item.character || 0);
        const containerPart = container ? container + ' · ' : '';
        const line = Number(item.line || 0);
        return '<button class="item" data-uri="' + escapeHtml(item.uri || '') + '" data-line="' + line + '" data-character="' + character + '">' +
          '<div class="row-1">' +
            '<span class="kind-icon" style="color:var(--peek-kind-' + kind + ',var(--vscode-foreground,#ccc))" title="' + kind + '">' + icon + '</span>' +
            '<span class="name">' + nameHtml + '</span>' +
          '</div>' +
          '<div class="row-2">' + containerPart + relativePath + '</div>' +
        '</button>';
      }).join('');
    }

    listEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest('.item');
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const uri = button.dataset.uri || '';
      const line = Number(button.dataset.line || '0');
      const character = Number(button.dataset.character || '0');
      if (!uri) {
        return;
      }
      if (event.detail === 1) {
        postSingleClickNavigation(uri, line, character);
      }
    });

    listEl.addEventListener('dblclick', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest('.item');
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const uri = button.dataset.uri || '';
      const line = Number(button.dataset.line || '0');
      const character = Number(button.dataset.character || '0');
      if (!uri) {
        return;
      }
      vscodeApi.postMessage({
        type: 'jumpTo',
        uri,
        line,
        character,
      });
    });

    queryInput.addEventListener('input', onInput);
    if (modeTabExact) {
      modeTabExact.addEventListener('click', () => setSearchMode(false));
    }
    if (modeTabFuzzy) {
      modeTabFuzzy.addEventListener('click', () => setSearchMode(true));
    }
    if (sortModeSelect) {
      sortModeSelect.addEventListener('change', () => setSortMode(sortModeSelect.value));
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }

      if (msg.type === 'themeColors') {
        const themeStyle = document.getElementById('theme-tokens');
        if (themeStyle) {
          themeStyle.textContent = String(msg.css || '');
        }
        return;
      }

      if (msg.type === 'interactionConfig') {
        singleClickAction = normalizeSingleClickAction(msg.singleClickAction);
        return;
      }

      if (msg.type === 'loading') {
        if (typeof msg.requestId === 'number' && msg.requestId !== requestId) {
          return;
        }
        statusEl.textContent = 'Searching...';
        return;
      }

      if (msg.type === 'results') {
        if (typeof msg.requestId === 'number' && msg.requestId !== requestId && msg.requestId !== 0) {
          return;
        }
        const query = String(msg.query || '').trim();
        const total = Number(msg.total || 0);
        const fuzzy = Boolean(msg.fuzzy);
        const currentSortMode = String(msg.sortMode || sortMode);
        if (!query) {
          statusEl.textContent = 'Type to search symbols in workspace.';
          listEl.innerHTML = '<div class="empty">Enter a keyword to start searching.</div>';
          return;
        }
        statusEl.textContent = total > 300
          ? ('Showing first 300 results (total ' + total + ')' + (fuzzy ? ' · fuzzy' : '') + ' · ' + currentSortMode + '.')
          : (total + ' result' + (total === 1 ? '' : 's') + (fuzzy ? ' · fuzzy' : '') + ' · ' + currentSortMode + '.');
        renderItems(Array.isArray(msg.items) ? msg.items : []);
        return;
      }

      if (msg.type === 'initPreferences') {
        fuzzyMode = String(msg.mode || 'exact') === 'fuzzy';
        sortMode = String(msg.sortMode || 'relevance');
        updateModeTabs();
        if (sortModeSelect) {
          sortModeSelect.value = sortMode;
        }
        return;
      }
    });

    vscodeApi.postMessage({ type: 'ready' });
    updateModeTabs();
    queryInput.focus();
  </script>
</body>
</html>`;
  }
}
