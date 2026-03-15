import * as vscode from 'vscode';
import { generateThemeTokenCss, generateSymbolKindCss } from './theme';

const SYMBOL_KIND_NAMES: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Array]: 'Array',
  [vscode.SymbolKind.Boolean]: 'Boolean',
  [vscode.SymbolKind.Class]: 'Class',
  [vscode.SymbolKind.Constant]: 'Constant',
  [vscode.SymbolKind.Constructor]: 'Constructor',
  [vscode.SymbolKind.Enum]: 'Enum',
  [vscode.SymbolKind.EnumMember]: 'EnumMember',
  [vscode.SymbolKind.Event]: 'Event',
  [vscode.SymbolKind.Field]: 'Field',
  [vscode.SymbolKind.File]: 'File',
  [vscode.SymbolKind.Function]: 'Function',
  [vscode.SymbolKind.Interface]: 'Interface',
  [vscode.SymbolKind.Key]: 'Key',
  [vscode.SymbolKind.Method]: 'Method',
  [vscode.SymbolKind.Module]: 'Module',
  [vscode.SymbolKind.Namespace]: 'Namespace',
  [vscode.SymbolKind.Null]: 'Null',
  [vscode.SymbolKind.Number]: 'Number',
  [vscode.SymbolKind.Object]: 'Object',
  [vscode.SymbolKind.Operator]: 'Operator',
  [vscode.SymbolKind.Package]: 'Package',
  [vscode.SymbolKind.Property]: 'Property',
  [vscode.SymbolKind.String]: 'String',
  [vscode.SymbolKind.Struct]: 'Struct',
  [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
  [vscode.SymbolKind.Variable]: 'Variable',
};

const SYMBOL_KIND_ICONS: Record<string, string> = {
  Array: '🗂️',
  Boolean: '⚖️',
  Class: '📱',
  Constant: '⭐',
  Constructor: '📲',
  Enum: '🏷️',
  EnumMember: '🔖',
  Event: '🎯',
  Field: '🟠',
  File: '📄',
  Function: '💿',
  Global: '🔵',
  Interface: '🔗',
  Key: '🗝️',
  Method: '📀',
  Module: '📦',
  Namespace: '📃',
  Null: '⭕',
  Number: '🔢',
  Object: '🧰',
  Operator: '➗',
  Package: '🗃️',
  Property: '🟢',
  String: '🧵',
  Struct: '💲',
  TypeParameter: '🧬',
  Variable: '🔷',
};

export function getThemeColorsCss(): string {
  return generateThemeTokenCss() + generateSymbolKindCss();
}

export function symbolKindToName(kind: vscode.SymbolKind): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'Symbol';
}

export function buildKindIconFunction(functionName: string): string {
  return `
    function ${functionName}(kind) {
      const icons = ${JSON.stringify(SYMBOL_KIND_ICONS)};
      return icons[kind] || '•';
    }
  `;
}
