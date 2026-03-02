import * as vscode from 'vscode';
import { PeekViewProvider } from './peekView';
import { MapViewProvider } from './mapView';

export function activate(context: vscode.ExtensionContext): void {
  const peekprovider = new PeekViewProvider(context.extensionUri);
  const mapProvider = new MapViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PeekViewProvider.viewType,
      peekprovider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MapViewProvider.viewType,
      mapProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 记录最后聚焦的编辑器（面板获得聚焦时 activeTextEditor 变为 undefined）
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      peekprovider.notifyEditorChange(editor);
      mapProvider.notifyEditorChange(editor);
    })
  );

  // 光标/选区变化
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      peekprovider.notifyEditorChange(e.textEditor);
    })
  );

  // 文档内容变化（符号范围可能改变）
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor
        ?? vscode.window.visibleTextEditors.find(ed => ed.document === e.document);
      if (editor) {
        peekprovider.notifyEditorChange(editor);
      }
    })
  );

  // 主题变更时重新推送 token 颜色
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      // Small delay so VS Code finishes applying the new theme internally
      setTimeout(() => peekprovider.pushThemeColors(), 300);
    })
  );

  // 命令：手动打开/聚焦面板
  context.subscriptions.push(
    vscode.commands.registerCommand('peekView.reveal', () => {
      vscode.commands.executeCommand('peekView.view.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mapView.reveal', () => {
      vscode.commands.executeCommand('mapView.view.focus');
    })
  );
}

export function deactivate(): void {}
