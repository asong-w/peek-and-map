import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PRISM_TO_TEXTMATE } from './constants';
import { TokenColorRule } from './types';

// ── Theme color extraction ──────────────────────────────────────────────────

/** Strip single-line and multi-line comments from JSONC text, respecting quoted strings. */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    if (inStr) {
      if (text[i] === '\\') { result += text.slice(i, i + 2); i += 2; continue; }
      if (text[i] === '"') { inStr = false; }
      result += text[i++];
    } else if (text[i] === '"') {
      inStr = true; result += text[i++];
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { i++; }
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
      i += 2;
    } else {
      result += text[i++];
    }
  }
  return result;
}

function parseJsonc(text: string): any {
  return JSON.parse(stripJsonComments(text).replace(/,\s*([}\]])/g, '$1'));
}

function fallbackPrismTokenColors(): Record<string, string> {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light) {
    return {
      comment: '#6a737d',
      string: '#032f62',
      keyword: '#d73a49',
      function: '#6f42c1',
      className: '#6f42c1',
      number: '#005cc5',
      boolean: '#005cc5',
      operator: '#d73a49',
      property: '#005cc5',
      variable: '#24292e',
      punctuation: '#586069',
    };
  }
  if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
    return {
      comment: '#7ca668',
      string: '#ce9178',
      keyword: '#569cd6',
      function: '#dcdcaa',
      className: '#4ec9b0',
      number: '#b5cea8',
      boolean: '#569cd6',
      operator: '#d4d4d4',
      property: '#9cdcfe',
      variable: '#d4d4d4',
      punctuation: '#d4d4d4',
    };
  }
  return {
    comment: '#6a9955',
    string: '#ce9178',
    keyword: '#569cd6',
    function: '#dcdcaa',
    className: '#4ec9b0',
    number: '#b5cea8',
    boolean: '#569cd6',
    operator: '#d4d4d4',
    property: '#9cdcfe',
    variable: '#d4d4d4',
    punctuation: '#d4d4d4',
  };
}

function fallbackSymbolKindColors(): Record<string, string> {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light) {
    return {
      Function: '#6f42c1',
      Method: '#6f42c1',
      Constructor: '#6f42c1',
      Class: '#005cc5',
      Interface: '#005cc5',
      Struct: '#005cc5',
      Enum: '#d73a49',
      Variable: '#24292e',
      Constant: '#005cc5',
      Property: '#005cc5',
      Field: '#005cc5',
      Module: '#24292e',
      Namespace: '#24292e',
      File: '#586069',
      owner: '#005cc5',
      operator: '#24292e',
    };
  }
  if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
    return {
      Function: '#dcdcaa',
      Method: '#dcdcaa',
      Constructor: '#dcdcaa',
      Class: '#4ec9b0',
      Interface: '#4ec9b0',
      Struct: '#4ec9b0',
      Enum: '#c586c0',
      Variable: '#d4d4d4',
      Constant: '#9cdcfe',
      Property: '#9cdcfe',
      Field: '#9cdcfe',
      Module: '#4ec9b0',
      Namespace: '#4ec9b0',
      File: '#d4d4d4',
      owner: '#4ec9b0',
      operator: '#d4d4d4',
    };
  }
  return {
    Function: '#dcdcaa',
    Method: '#dcdcaa',
    Constructor: '#dcdcaa',
    Class: '#4ec9b0',
    Interface: '#4ec9b0',
    Struct: '#4ec9b0',
    Enum: '#c586c0',
    Variable: '#9cdcfe',
    Constant: '#4fc1ff',
    Property: '#9cdcfe',
    Field: '#9cdcfe',
    Module: '#4ec9b0',
    Namespace: '#4ec9b0',
    File: '#d4d4d4',
    owner: '#4ec9b0',
    operator: '#d4d4d4',
  };
}

/** Recursively load tokenColors from a theme file and its `include` ancestors. */
function loadThemeTokenColors(filePath: string): TokenColorRule[] {
  try {
    const data = parseJsonc(fs.readFileSync(filePath, 'utf-8'));
    let rules: TokenColorRule[] = [];
    if (data.include) {
      rules = loadThemeTokenColors(path.join(path.dirname(filePath), data.include));
    }
    if (Array.isArray(data.tokenColors)) {
      rules = [...rules, ...data.tokenColors];
    }
    return rules;
  } catch {
    return [];
  }
}

/** Resolve the active color theme's tokenColor rules by finding its extension. */
function (): TokenColorRule[] {
  const themeId = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!themeId) { return []; }
  for (const ext of vscode.extensions.all) {
    const themes: any[] | undefined = ext.packageJSON?.contributes?.themes;
    if (!themes) { continue; }
    for (const t of themes) {
      if (t.id === themeId || t.label === themeId) {
        return loadThemeTokenColors(path.join(ext.extensionPath, t.path));
      }
    }
  }
  return [];
}

/**
 * For the given target TextMate scopes, find the best matching foreground
 * color from the theme rules.  TextMate matching: ruleScope is a prefix of
 * targetScope (e.g. rule "keyword" matches target "keyword.control").
 */
function findBestSetting(
  targetScopes: string[],
  rules: TokenColorRule[]
): { foreground?: string; fontStyle?: string } | undefined {
  for (const target of targetScopes) {
    let best: TokenColorRule | undefined;
    let bestLen = -1;
    for (const rule of rules) {
      if (!rule.scope || !rule.settings?.foreground) { continue; }
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
      for (const s of scopes) {
        const rs = s.trim();
        if (target === rs || target.startsWith(rs + '.')) {
          if (rs.length > bestLen) { bestLen = rs.length; best = rule; }
        }
      }
    }
    if (best) { return best.settings; }
  }
  return undefined;
}

// ── Symbol-kind → TextMate scopes ────────────────────────────────────────────
const SYMBOL_KIND_TO_TM: Record<string, string[]> = {
  'Function':    ['entity.name.function', 'support.function'],
  'Method':      ['entity.name.function', 'support.function'],
  'Constructor': ['entity.name.function', 'support.function'],
  'Class':       ['entity.name.type', 'entity.name.class', 'support.class'],
  'Interface':   ['entity.name.type', 'entity.name.interface', 'support.class'],
  'Struct':      ['entity.name.type', 'entity.name.struct'],
  'Enum':        ['entity.name.type', 'entity.name.enum'],
  'Variable':    ['variable', 'variable.other'],
  'Constant':    ['variable.other.constant', 'constant.other', 'constant'],
  'Property':    ['variable.other.property', 'support.type.property-name', 'variable'],
  'Field':       ['variable.other.property', 'variable.other.readwrite.member', 'variable'],
  'Module':      ['entity.name.namespace', 'entity.name.module', 'entity.name.type'],
  'Namespace':   ['entity.name.namespace', 'entity.name.module', 'entity.name.type'],
  'File':        ['string', 'variable'],
};

/**
 * Generate CSS custom properties like `--peek-kind-Function: #dcdcaa;`
 * so the webview can reference the real theme color for each symbol kind.
 */
export function generateSymbolKindCss(): string {
  const rules = resolveActiveThemeTokenColors();
  if (rules.length === 0) {
    const fallback = fallbackSymbolKindColors();
    let vars = ':root {\n';
    for (const [kind, color] of Object.entries(fallback)) {
      if (kind === 'owner' || kind === 'operator') { continue; }
      vars += `  --peek-kind-${kind}: ${color};\n`;
    }
    vars += `  --peek-qualified-owner: ${fallback.owner};\n`;
    vars += `  --peek-operator: ${fallback.operator};\n`;
    vars += '}\n';
    return vars;
  }
  let vars = ':root {\n';
  for (const [kind, scopes] of Object.entries(SYMBOL_KIND_TO_TM)) {
    const setting = findBestSetting(scopes, rules);
    if (setting?.foreground) {
      vars += `  --peek-kind-${kind}: ${setting.foreground};\n`;
    }
  }

  const ownerSetting = findBestSetting(
    ['entity.name.type', 'entity.name.class', 'support.class'],
    rules
  );
  if (ownerSetting?.foreground) {
    vars += `  --peek-qualified-owner: ${ownerSetting.foreground};\n`;
  }

  const operatorSetting = findBestSetting(
    [
      'punctuation.separator.scope-resolution',
      'keyword.operator.scope-resolution',
      'keyword.operator',
      'punctuation.separator',
    ],
    rules
  );
  if (operatorSetting?.foreground) {
    vars += `  --peek-operator: ${operatorSetting.foreground};\n`;
  }

  vars += '}\n';
  return vars;
}

/** Generate CSS for all Prism token classes from the current VS Code theme. */
export function generateThemeTokenCss(): string {
  const rules = resolveActiveThemeTokenColors();
  if (rules.length === 0) {
    const fallback = fallbackPrismTokenColors();
    let css = '';
    const map: Record<string, string> = {
      comment: fallback.comment,
      prolog: fallback.comment,
      doctype: fallback.comment,
      cdata: fallback.comment,
      punctuation: fallback.punctuation,
      property: fallback.property,
      tag: fallback.keyword,
      boolean: fallback.boolean,
      number: fallback.number,
      constant: fallback.number,
      symbol: fallback.number,
      selector: fallback.className,
      attrName: fallback.property,
      string: fallback.string,
      char: fallback.string,
      builtin: fallback.className,
      inserted: fallback.string,
      operator: fallback.operator,
      entity: fallback.operator,
      url: fallback.string,
      atrule: fallback.keyword,
      attrValue: fallback.string,
      keyword: fallback.keyword,
      function: fallback.function,
      className: fallback.className,
      regex: fallback.string,
      important: fallback.keyword,
      variable: fallback.variable,
      deleted: '#f14c4c',
    };
    for (const [token, color] of Object.entries(map)) {
      css += `.token.${token} { color: ${color}; }\n`;
    }
    return css;
  }
  let css = '';
  for (const [prismToken, tmScopes] of Object.entries(PRISM_TO_TEXTMATE)) {
    const setting = findBestSetting(tmScopes, rules);resolveActiveThemeTokenColors
    if (setting?.foreground) {
      css += `.token.${prismToken} { color: ${setting.foreground};`;
      if (setting.fontStyle) {
        if (setting.fontStyle.includes('italic')) { css += ' font-style: italic;'; }
        if (setting.fontStyle.includes('bold')) { css += ' font-weight: bold;'; }
        if (setting.fontStyle.includes('underline')) { css += ' text-decoration: underline;'; }
      }
      css += ' }\n';
    }
  }
  return css;
}
