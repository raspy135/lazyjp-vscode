// lazyjp - convert the current line of romaji-ish text into natural Japanese
// with an LLM, in the background. Ported from the pem editor's lazyjp command.
//
// VS Code's extension host is single-threaded and async, so this is much simpler
// than the pem version: no threads/locks, no idle hooks. The one careful piece is
// applying the result to the ORIGINAL line after the request returns, even if the
// cursor/line numbers moved meanwhile -- handled by tracking each pending line
// through onDidChangeTextDocument.

import * as vscode from 'vscode';
import { convert, lineDelta } from './api';

interface Pending {
  uri: vscode.Uri;
  line: number;       // current best guess of the original line, kept up to date
  src: string;
  cancelled: boolean; // the line was edited/deleted while we waited -> don't apply
}

// --- module state (safe as plain vars: single-threaded event loop) ---
let secrets: vscode.SecretStorage;
let continuous = false;
let previousResponseId: string | undefined;
let lastFileKey: string | undefined;
const pending: Pending[] = [];
// Serializes API calls while in continuous mode so concurrent conversions can't
// fork the previous_response_id chain (the pem gpt_lock equivalent).
let chain: Promise<void> = Promise.resolve();

const KEY_SECRET = 'lazyjp.openaiKey';

export function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  continuous = cfg().get<boolean>('continuous', false);

  context.subscriptions.push(
    vscode.commands.registerCommand('lazyjp.convertLine', convertLine),
    vscode.commands.registerCommand('lazyjp.toggleContinuous', toggleContinuous),
    vscode.commands.registerCommand('lazyjp.resetSession', resetSession),
    vscode.commands.registerCommand('lazyjp.setApiKey', setApiKey),
    vscode.workspace.onDidChangeTextDocument(trackPendingLines),
  );
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Moving-line tracking
// ---------------------------------------------------------------------------

function trackPendingLines(e: vscode.TextDocumentChangeEvent) {
  const uri = e.document.uri.toString();
  for (const p of pending) {
    if (p.cancelled || p.uri.toString() !== uri) {
      continue;
    }
    for (const c of e.contentChanges) {
      const startLine = c.range.start.line;
      const endLine = c.range.end.line;
      if (endLine < p.line) {
        // Edit entirely above the target line: shift the target.
        p.line += lineDelta(startLine, endLine, c.text);
      } else if (startLine <= p.line && p.line <= endLine) {
        // Cancel only if the target line's text actually changed (e.g. user
        // typed on it). A newline inserted at the end of the line leaves the
        // text intact, so don't cancel in that case.
        if (p.line >= e.document.lineCount ||
            e.document.lineAt(p.line).text !== p.src) {
          p.cancelled = true;
        }
      }
      // Edit entirely below the target: no effect on its line number.
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function convertLine() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const uri = editor.document.uri;
  const line = editor.selection.active.line;
  const src = editor.document.lineAt(line).text;
  if (!src.trim()) {
    status('lazyjp: empty line');
    return;
  }

  // Dedupe: ignore a repeat trigger on a line already being converted.
  const uriStr = uri.toString();
  if (pending.some(p => !p.cancelled && p.uri.toString() === uriStr && p.line === line)) {
    status('lazyjp: this line is already converting...');
    return;
  }

  // Per-file reset (continuous mode): a new file starts a fresh conversation.
  if (continuous && uriStr !== lastFileKey) {
    previousResponseId = undefined;
  }
  lastFileKey = uriStr;

  const p: Pending = { uri, line, src, cancelled: false };
  pending.push(p);

  // In continuous mode run through the chain so turns stay sequential; otherwise
  // fire concurrently.
  const resultPromise = continuous ? enqueue(() => runConversion(src)) : runConversion(src);
  vscode.window.setStatusBarMessage('$(sync~spin) lazyjp...', resultPromise.then(() => {}, () => {}));

  try {
    const text = await resultPromise;
    await applyResult(p, text);
  } catch (err: any) {
    vscode.window.showErrorMessage('lazyjp: ' + (err?.message || String(err)));
  } finally {
    const i = pending.indexOf(p);
    if (i >= 0) {
      pending.splice(i, 1);
    }
  }
}

function toggleContinuous() {
  continuous = !continuous;
  if (continuous) {
    previousResponseId = undefined; // begin a fresh chat when enabling
  }
  status(`lazyjp continuous mode: ${continuous ? 'ON (more tokens)' : 'OFF (cheap)'}`);
}

function resetSession() {
  previousResponseId = undefined;
  status('lazyjp: session reset (next conversion starts a new chat)');
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({
    prompt: 'OpenAI API key for lazyjp',
    password: true,
    ignoreFocusOut: true,
  });
  if (key && key.trim()) {
    await secrets.store(KEY_SECRET, key.trim());
    status('lazyjp: API key saved');
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

async function getKey(): Promise<string | undefined> {
  let key = await secrets.get(KEY_SECRET);
  if (!key) {
    await setApiKey();
    key = await secrets.get(KEY_SECRET);
  }
  return key;
}

async function runConversion(src: string): Promise<string> {
  const c = cfg();
  const key = await getKey();
  if (!key) {
    throw new Error('no API key set (run "lazyjp: Set API Key")');
  }
  const result = await convert({
    baseUrl: c.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: c.get<string>('model', 'gpt-5.4-mini'),
    prompt: c.get<string>('prompt', ''),
    src,
    key,
    effort: c.get<string>('reasoningEffort', ''),
    // Only chain in continuous mode.
    previousResponseId: continuous ? previousResponseId : undefined,
  });
  if (continuous && result.responseId) {
    previousResponseId = result.responseId;
  }
  return result.text;
}

async function applyResult(p: Pending, result: string) {
  if (p.cancelled) {
    return; // the line was edited/deleted while waiting
  }
  if (!result) {
    vscode.window.showWarningMessage('lazyjp: empty result, line unchanged');
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(p.uri);
  } catch {
    return; // file gone
  }
  if (p.line < 0 || p.line >= doc.lineCount) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(p.uri, doc.lineAt(p.line).range, result);
  // applyEdit works regardless of which editor has focus and does NOT move the
  // user's cursor (unlike editor.edit).
  await vscode.workspace.applyEdit(edit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('lazyjp');
}

function status(msg: string) {
  vscode.window.setStatusBarMessage(msg, 3000);
}

// Run fn after the current chain link resolves; advance the chain. Used to keep
// continuous-mode turns strictly sequential.
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}
