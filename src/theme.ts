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
function resolveActiveThemeTokenColors(): TokenColorRule[] {
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
  if (rules.length === 0) { return ''; }
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
  if (rules.length === 0) { return ''; }
  let css = '';
  for (const [prismToken, tmScopes] of Object.entries(PRISM_TO_TEXTMATE)) {
    const setting = findBestSetting(tmScopes, rules);
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
