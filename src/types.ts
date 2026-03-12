import * as vscode from 'vscode';

export interface ContextInfo {
  code: string;
  language: string;
  startLine: number;  // 0-based, first line of the shown block
  cursorLine: number; // 0-based, line to highlight/scroll to (definition position)
  symbolName: string;
  symbolKind: string;
  filePath: string;   // absolute path of the definition file
  defUri: string;     // vscode URI string — used for cross-file jump
  fileName: string;   // basename shown in the header
}

export interface TreeNodeData {
  nodeId: string;
  label: string;
  detail: string;
  line: number;
  character: number;
  callLine: number;       // line where the reference/call actually occurs
  callCharacter: number;  // character where the reference/call actually occurs
  uri: string;
  kind?: string;
  isDeclaration?: boolean;
  preview: string;
}

export interface TokenColorRule {
  scope?: string | string[];
  settings: { foreground?: string; fontStyle?: string };
}
