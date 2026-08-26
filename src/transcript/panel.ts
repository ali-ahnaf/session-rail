/**
 * Read-only webview rendering a session's or agent's transcript.
 *
 * This module only *reads* transcript files — v1 never writes into a session,
 * never sends input, and has no auto-tailing. The user must click "Reload" to
 * see new content.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

import * as vscode from 'vscode';

import type { AgentNode, SessionNode, TranscriptRecord } from '../model/types';
import { safely, safelyAsync } from '../util/log';

const MAX_TAIL_BYTES = 512 * 1024;

// Record `type` values that are bookkeeping, never a renderable turn.
const BOOKKEEPING_TYPES = new Set(['queue-operation', 'attachment', 'snapshot']);

interface ParsedMessage {
  readonly role: string;
  readonly content: unknown;
}

interface TailResult {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export class TranscriptPanel {
  private static readonly panels = new Map<string, TranscriptPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly transcriptPath: string | undefined;
  private readonly title: string;

  private constructor(target: SessionNode | AgentNode) {
    const info = TranscriptPanel.targetInfo(target);
    this.title = info.title;
    this.transcriptPath = info.transcriptPath;

    // `retainContextWhenHidden` is deliberately NOT set. It keeps the whole
    // webview DOM — up to MAX_TAIL_BYTES of rendered transcript — alive for as
    // long as the tab exists, hidden or not, and VS Code's own docs call out its
    // memory cost. A hidden panel here has nothing worth retaining: VS Code
    // re-applies `webview.html` when the tab is revealed, so the content comes
    // back on its own, and the only DOM state that matters across a hide is the
    // scroll position, which the page checkpoints through `setState` instead.
    this.panel = vscode.window.createWebviewPanel(
      'sessionRail.transcript',
      this.title,
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );

    this.panel.onDidDispose(() => {
      TranscriptPanel.panels.delete(info.id);
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isReloadMessage(message)) {
        void safelyAsync('TranscriptPanel.reload', () => this.render(), undefined);
      }
    });

    void safelyAsync('TranscriptPanel.render(initial)', () => this.render(), undefined);
  }

  /** Show the transcript for `target`, reusing an existing panel if one is open. */
  static show(context: vscode.ExtensionContext, target: SessionNode | AgentNode): void {
    void context; // no persisted/global state needed yet; kept for API-contract stability.
    const info = TranscriptPanel.targetInfo(target);
    const existing = TranscriptPanel.panels.get(info.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const created = new TranscriptPanel(target);
    TranscriptPanel.panels.set(info.id, created);
  }

  /** Dispose every open transcript panel. */
  static disposeAll(): void {
    for (const panel of TranscriptPanel.panels.values()) {
      panel.panel.dispose();
    }
    TranscriptPanel.panels.clear();
  }

  private static targetInfo(target: SessionNode | AgentNode): {
    id: string;
    title: string;
    transcriptPath: string | undefined;
  } {
    if (target.kind === 'session') {
      return { id: target.id, title: target.name, transcriptPath: target.transcriptPath };
    }
    return { id: target.id, title: target.agentType, transcriptPath: target.transcriptPath };
  }

  private async render(): Promise<void> {
    const nonce = generateNonce();
    if (!this.transcriptPath) {
      this.panel.webview.html = renderHtml(
        nonce,
        this.title,
        '<p class="empty">No transcript file found.</p>',
        this.panel.webview.cspSource,
      );
      return;
    }

    const tail = await safelyAsync<TailResult | undefined>(
      `TranscriptPanel.readTail(${this.transcriptPath})`,
      () => readTranscriptTail(this.transcriptPath as string),
      undefined,
    );

    if (!tail) {
      this.panel.webview.html = renderHtml(
        nonce,
        this.title,
        '<p class="empty">Could not read the transcript file.</p>',
        this.panel.webview.cspSource,
      );
      return;
    }

    const records = parseRecords(tail.lines);
    const body = renderRecords(records, tail.truncated);
    this.panel.webview.html = renderHtml(nonce, this.title, body, this.panel.webview.cspSource);
  }
}

function isReloadMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { command?: unknown }).command === 'reload'
  );
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Read only the last MAX_TAIL_BYTES of `filePath`. Bytes up to the first
 * newline in that window are discarded (they belong to a line that started
 * before the window), so the result starts on a line boundary. The remaining
 * text is split into lines for NDJSON parsing.
 */
async function readTranscriptTail(filePath: string): Promise<TailResult> {
  const stat = await fs.promises.stat(filePath);
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  const truncated = start > 0;
  const length = stat.size - start;

  const handle = await fs.promises.open(filePath, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString('utf8');
  } finally {
    await handle.close();
  }

  if (truncated) {
    const newlineIndex = text.indexOf('\n');
    text = newlineIndex === -1 ? '' : text.slice(newlineIndex + 1);
  }

  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return { lines, truncated };
}

/** Parse NDJSON lines into TranscriptRecords. A bad line (e.g. truncated) is dropped, never thrown. */
function parseRecords(lines: readonly string[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    const record = safely<TranscriptRecord | undefined>(
      'parseTranscriptLine',
      () => {
        const parsed: unknown = JSON.parse(line);
        return isRecordLike(parsed) ? (parsed as TranscriptRecord) : undefined;
      },
      undefined,
    );
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function isRecordLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** Narrow `record.message` into a role + content pair, or undefined if it doesn't fit. */
function extractMessage(message: unknown): ParsedMessage | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const obj = message as { role?: unknown; content?: unknown };
  const role = typeof obj.role === 'string' ? obj.role : 'unknown';
  if (!('content' in obj)) {
    return undefined;
  }
  return { role, content: obj.content };
}

function renderRecords(records: readonly TranscriptRecord[], truncated: boolean): string {
  const parts: string[] = [];
  if (truncated) {
    parts.push(
      '<p class="notice">Showing only the last 512 KB of this transcript — earlier turns were skipped.</p>',
    );
  }

  let rendered = 0;
  for (const record of records) {
    if (record.type && BOOKKEEPING_TYPES.has(record.type)) {
      continue;
    }
    const parsed = extractMessage(record.message);
    if (!parsed) {
      continue;
    }
    const turnHtml = renderTurn(parsed);
    if (turnHtml) {
      parts.push(turnHtml);
      rendered++;
    }
  }

  if (rendered === 0) {
    parts.push('<p class="empty">No renderable turns found in this transcript.</p>');
  }

  return parts.join('\n');
}

function renderTurn(parsed: ParsedMessage): string | undefined {
  const blocksHtml = renderContent(parsed.content);
  if (!blocksHtml) {
    return undefined;
  }
  const roleClass = escapeHtml(parsed.role.replace(/[^a-z0-9_-]/gi, '_'));
  return `<section class="turn turn-${roleClass}"><div class="role">${escapeHtml(parsed.role)}</div>${blocksHtml}</section>`;
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? `<p class="text">${escapeHtml(content)}</p>` : '';
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => renderBlock(block))
      .filter((html): html is string => Boolean(html))
      .join('\n');
  }
  return '';
}

function renderBlock(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) {
    return undefined;
  }
  const obj = block as { type?: unknown };
  switch (obj.type) {
    case 'text':
      return renderTextBlock(obj as { text?: unknown });
    case 'tool_use':
      return renderToolUseBlock(obj as { name?: unknown; input?: unknown });
    case 'tool_result':
      return renderToolResultBlock(obj as { content?: unknown });
    case 'thinking':
      return undefined; // thinking blocks are omitted entirely
    default:
      return undefined;
  }
}

function renderTextBlock(block: { text?: unknown }): string | undefined {
  const text = typeof block.text === 'string' ? block.text : undefined;
  if (!text || text.trim().length === 0) {
    return undefined;
  }
  // `.text` is styled `white-space: pre-wrap`, which already renders literal
  // newlines as line breaks — do not also inject <br>, or breaks double up.
  return `<p class="text">${escapeHtml(text)}</p>`;
}

function renderToolUseBlock(block: { name?: unknown; input?: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = safeJsonStringify(block.input);
  return (
    `<details class="tool-use"><summary>&#9656; ${escapeHtml(name)}</summary>` +
    `<pre>${escapeHtml(input)}</pre></details>`
  );
}

function renderToolResultBlock(block: { content?: unknown }): string {
  const full = safely<string>('stringify tool_result content', () => stringifyToolResultContent(block.content), '');
  const summary = summarizeToolResult(full);
  return (
    `<details class="tool-result"><summary>&#9656; result: ${escapeHtml(summary)}</summary>` +
    `<pre>${escapeHtml(full)}</pre></details>`
  );
}

function stringifyToolResultContent(content: unknown): string {
  if (content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((entry) => {
        if (typeof entry === 'object' && entry !== null && typeof (entry as { text?: unknown }).text === 'string') {
          return (entry as { text: string }).text;
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return safeJsonStringify(content);
}

/**
 * `JSON.stringify` returns the runtime value `undefined` (not the string
 * `"undefined"`) when given `undefined`, despite TypeScript's lib typing the
 * return as `string`. Guard that case explicitly so callers never hand an
 * actual `undefined` to `escapeHtml`.
 */
function safeJsonStringify(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  const result: string | undefined = JSON.stringify(value, null, 2);
  return result ?? '';
}

/** Collapse an already-stringified tool_result to a single-line preview. */
function summarizeToolResult(full: string): string {
  const flattened = full.trim().replace(/\s+/g, ' ');
  const limit = 120;
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened || '(empty)';
}

/** Escape every piece of transcript content before interpolating it into HTML. No exceptions. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `cspSource` (VS Code's `webview.cspSource`, e.g. `vscode-webview://<id>`) must
 * be included in `style-src` alongside our nonce: VS Code injects its own
 * default-styles `<style>` block into the document — the one that actually
 * defines the `--vscode-*` custom properties this page reads — and a strict
 * `style-src` would otherwise block it, silently blanking the theme.
 */
function renderHtml(nonce: string, title: string, body: string, cspSource: string): string {
  const csp = `default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family, sans-serif);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    padding: 0 16px 32px;
  }
  .toolbar {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 12px;
  }
  button#reload {
    background: none;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-textLink-foreground);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .notice, .empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .turn {
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 10px 0;
  }
  .role {
    text-transform: uppercase;
    font-size: 0.75em;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .text {
    white-space: pre-wrap;
    margin: 4px 0;
  }
  details {
    margin: 6px 0;
  }
  details summary {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
  }
  pre {
    color: var(--vscode-textPreformat-foreground);
    white-space: pre-wrap;
    overflow-x: auto;
    margin: 6px 0 0;
  }
</style>
</head>
<body>
<div class="toolbar"><button id="reload">Reload</button></div>
<div id="content">${body}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('reload').addEventListener('click', () => {
    vscode.postMessage({ command: 'reload' });
  });

  // The panel is not retained while hidden, so this script re-runs every time
  // the tab is revealed. Webview state survives that teardown; restore the
  // scroll offset so a hide/show round-trip looks like the tab never moved.
  const saved = vscode.getState();
  if (saved && typeof saved.scrollY === 'number') {
    window.scrollTo(0, saved.scrollY);
  }
  let pending = 0;
  window.addEventListener('scroll', () => {
    if (pending !== 0) {
      return;
    }
    // Coalesced: scroll fires per frame and each setState is a round-trip to
    // the extension host.
    pending = window.setTimeout(() => {
      pending = 0;
      vscode.setState({ scrollY: window.scrollY });
    }, 150);
  });
</script>
</body>
</html>`;
}
