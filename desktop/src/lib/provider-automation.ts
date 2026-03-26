"use client";

export type ProviderAutomationKind = "deepseek" | "chatgpt";

export type WebviewLike = {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

export type ProviderAutomationResult<T> = {
  rawText: string;
  jsonText: string | null;
  parsedJson: T | null;
  chatUrl: string | null;
};

type RunProviderPromptParams = {
  kind: ProviderAutomationKind;
  webview: WebviewLike | null | undefined;
  prompt: string;
  startFreshChat?: boolean;
};

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripGoogleRefSuffix(line: string): string {
  return line.replace(/\s-\d+(?:-\d+)?\.?$/, "");
}

function stripGoogleRefSuffixFromText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => stripGoogleRefSuffix(line))
    .join("\n");
}

async function execInWebview<T>(webview: WebviewLike | null | undefined, code: string): Promise<T | null> {
  if (typeof webview?.executeJavaScript !== "function") return null;
  try {
    return (await webview.executeJavaScript(code, true)) as T;
  } catch {
    return null;
  }
}

async function waitForTruthyResult<T>(
  webview: WebviewLike | null | undefined,
  code: string,
  description: string,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  intervalMs = 500
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await execInWebview<T>(webview, code);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readChatUrl(webview: WebviewLike | null | undefined): Promise<string | null> {
  const href = await execInWebview<string>(webview, "location.href");
  return typeof href === "string" && /^https?:\/\//i.test(href.trim()) ? href.trim() : null;
}

function extractJsonObjectText(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const fencedMatches = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  for (let index = fencedMatches.length - 1; index >= 0; index -= 1) {
    const fenced = fencedMatches[index]?.[1]?.trim();
    if (!fenced) continue;
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // try earlier fenced blocks
    }
  }

  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = trimmed.slice(start, index + 1).trim();
        try {
          JSON.parse(candidate);
          candidates.push(candidate);
        } catch {
          // ignore invalid candidate
        }
        start = -1;
        depth = 0;
      }
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function parseJsonValue<T>(jsonText: string | null): T | null {
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

async function ensureDeepSeekReady(webview: WebviewLike | null | undefined): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_READY_TIMEOUT_MS) {
    const state = await execInWebview<{ ready: boolean; loginRequired: boolean }>(
      webview,
      `(function(){
        var composer = document.querySelector('textarea[placeholder="Message DeepSeek"]') || document.querySelector('textarea.d96f2d2a');
        var body = document.body;
        var text = body ? (body.innerText || '').toLowerCase() : '';
        var loginRequired =
          text.indexOf('log in') !== -1 ||
          text.indexOf('login') !== -1 ||
          !!document.querySelector('form[action*="login"], [data-testid*="login"], a[href*="login"]');
        return { ready: Boolean(composer), loginRequired: loginRequired };
      })();`
    );
    if (state?.ready) return;
    if (state?.loginRequired && Date.now() - startedAt > 5_000) {
      throw new Error("DeepSeek session is not logged in. Use Load session or sign in, then retry automation.");
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for DeepSeek composer");
}

async function startFreshDeepSeekChat(webview: WebviewLike | null | undefined): Promise<void> {
  await execInWebview(
    webview,
    `(function(){
      try {
        var buttons = document.querySelectorAll('div.ds-icon-button.ds-icon-button--xl.ds-icon-button--sizing-container[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          if (path && path.getAttribute('d') && path.getAttribute('d').indexOf('9.2192 6.36949') !== -1) {
            buttons[i].click();
            return true;
          }
        }
      } catch (error) {}
      return false;
    })();`
  );
  await sleep(900);
}

async function runDeepSeekPrompt(webview: WebviewLike | null | undefined, prompt: string): Promise<string> {
  await ensureDeepSeekReady(webview);
  const escapedPrompt = JSON.stringify(prompt);
  const setOk = await execInWebview<boolean>(
    webview,
    `(function(){
      var ta = document.querySelector('textarea[placeholder="Message DeepSeek"]') || document.querySelector('textarea.d96f2d2a');
      if (!ta) return false;
      var prompt = ${escapedPrompt};
      var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      if (nativeSetter) nativeSetter.call(ta, prompt);
      else ta.value = prompt;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();`
  );
  if (!setOk) throw new Error("DeepSeek composer is not ready");

  await waitForTruthyResult<boolean>(
    webview,
    `(function(){
      var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].classList.contains('ds-icon-button--disabled')) continue;
        var path = buttons[i].querySelector('svg path');
        var d = path && path.getAttribute('d');
        if (d && d.indexOf('8.3125') !== -1) return true;
      }
      return false;
    })();`,
    "DeepSeek send button",
    10_000,
    300
  );

  const clicked = await execInWebview<boolean>(
    webview,
    `(function(){
      var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].classList.contains('ds-icon-button--disabled')) continue;
        var path = buttons[i].querySelector('svg path');
        var d = path && path.getAttribute('d');
        if (d && d.indexOf('8.3125') !== -1) {
          buttons[i].click();
          return true;
        }
      }
      return false;
    })();`
  );
  if (!clicked) throw new Error("Could not click the DeepSeek send button");

  const startedAt = Date.now();
  let sawGenerating = false;
  while (Date.now() - startedAt < DEFAULT_GENERATION_TIMEOUT_MS) {
    const generationState = await execInWebview<{ generating: boolean; ready: boolean }>(
      webview,
      `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
        var generating = false;
        var ready = false;
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          var d = path && path.getAttribute('d');
          if (d && (d.indexOf('M2 4.88') !== -1 || d.indexOf('2 4.88') !== -1)) generating = true;
          if (d && d.indexOf('8.3125') !== -1 && buttons[i].classList.contains('ds-icon-button--disabled')) ready = true;
        }
        return { generating: generating, ready: ready };
      })();`
    );
    if (!generationState) {
      await sleep(500);
      continue;
    }
    if (generationState.generating) sawGenerating = true;
    if (sawGenerating && generationState.ready) break;
    await sleep(500);
  }

  const rawText = await execInWebview<string>(
    webview,
    `(function(){
      function nodeToMarkdown(node) {
        if (!node) return '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        var el = node;
        var tag = el.tagName;
        if (tag === 'BR') return '\\n';
        var block = tag === 'P' || tag === 'DIV' || tag === 'LI';
        var style = el.getAttribute('style') || '';
        var className = el.getAttribute('class') || '';
        var bold =
          tag === 'STRONG' ||
          tag === 'B' ||
          /font-weight\\s*:\\s*(bold|[5-9]00)/i.test(style) ||
          /(font-(semi)?bold|font-black|font-medium|font-semibold)/i.test(className) ||
          /\\b(bold|semibold)\\b/i.test(className);
        var text = '';
        for (var i = 0; i < el.childNodes.length; i++) text += nodeToMarkdown(el.childNodes[i]);
        if (block && text && text.charAt(text.length - 1) !== '\\n') text += '\\n';
        if (!text) return '';
        if (bold) return '**' + text + '**';
        return text;
      }
      var messages = document.querySelectorAll('.ds-message');
      for (var i = messages.length - 1; i >= 0; i--) {
        var markdowns = messages[i].querySelectorAll('.ds-markdown');
        if (!markdowns.length) continue;
        for (var j = markdowns.length - 1; j >= 0; j--) {
          var markdown = markdowns[j];
          if (!markdown) continue;
          var raw = nodeToMarkdown(markdown);
          if (!raw) raw = (markdown.innerText || markdown.textContent || '').trim();
          if (!raw) continue;
          raw = raw.replace(/\\r\\n/g, '\\n');
          raw = raw.replace(/\\n{3,}/g, '\\n\\n');
          raw = raw.replace(/[^\\S\\n]+/g, ' ');
          raw = raw.trim();
          if (!raw) continue;
          var fence = String.fromCharCode(96, 96, 96);
          if (raw.indexOf(fence) === 0 || raw.charAt(0) === '{' || /^(final answer|answer|最终答案|回答)[:：]?/i.test(raw)) {
            return raw;
          }
        }
        var lastMarkdown = markdowns[markdowns.length - 1];
        if (!lastMarkdown) continue;
        var fallback = nodeToMarkdown(lastMarkdown);
        if (!fallback) fallback = (lastMarkdown.innerText || lastMarkdown.textContent || '').trim();
        if (!fallback) continue;
        fallback = fallback.replace(/\\r\\n/g, '\\n');
        fallback = fallback.replace(/\\n{3,}/g, '\\n\\n');
        fallback = fallback.replace(/[^\\S\\n]+/g, ' ');
        return fallback.trim();
      }
      return '';
    })();`
  );
  if (!rawText || !rawText.trim()) throw new Error("DeepSeek did not return any response text");
  return stripGoogleRefSuffixFromText(rawText.trim());
}

async function ensureChatGptReady(webview: WebviewLike | null | undefined): Promise<void> {
  await waitForTruthyResult<boolean>(
    webview,
    `(function(){
      var composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('textarea[placeholder*="Message"]') ||
        document.querySelector('div[contenteditable="true"][data-testid="prompt-textarea"]') ||
        document.querySelector('div[contenteditable="true"]#prompt-textarea');
      return Boolean(composer);
    })();`,
    "ChatGPT composer"
  );
}

async function startFreshChatGptChat(webview: WebviewLike | null | undefined): Promise<void> {
  await execInWebview(
    webview,
    `(function(){
      function tryClick(selector) {
        var element = document.querySelector(selector);
        if (element && typeof element.click === 'function') {
          element.click();
          return true;
        }
        return false;
      }
      return (
        tryClick('button[aria-label*="New chat"]') ||
        tryClick('a[aria-label*="New chat"]') ||
        tryClick('nav a[href="/"]') ||
        tryClick('a[href="/"]')
      );
    })();`
  );
  await sleep(1200);
}

async function runChatGptPrompt(webview: WebviewLike | null | undefined, prompt: string): Promise<string> {
  await ensureChatGptReady(webview);
  const beforeSignature = await execInWebview<string>(
    webview,
    `(function(){
      var nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (!nodes.length) return '';
      var last = nodes[nodes.length - 1];
      return (last.innerText || last.textContent || '').trim();
    })();`
  );
  const escapedPrompt = JSON.stringify(prompt);
  const setOk = await execInWebview<boolean>(
    webview,
    `(function(){
      var composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"][data-testid="prompt-textarea"]') ||
        document.querySelector('div[contenteditable="true"]#prompt-textarea');
      if (composer) {
        composer.focus();
        var text = ${escapedPrompt};
        try {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, text);
        } catch (error) {
          composer.textContent = text;
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return true;
      }
      var textarea = document.querySelector('textarea[placeholder*="Message"]');
      if (textarea) {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (nativeSetter) nativeSetter.call(textarea, ${escapedPrompt});
        else textarea.value = ${escapedPrompt};
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })();`
  );
  if (!setOk) throw new Error("ChatGPT composer is not ready");

  await waitForTruthyResult<boolean>(
    webview,
    `(function(){
      var button =
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send prompt"]') ||
        document.querySelector('button[aria-label*="Send message"]');
      return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    })();`,
    "ChatGPT send button",
    10_000,
    300
  );

  const sent = await execInWebview<boolean>(
    webview,
    `(function(){
      var button =
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send prompt"]') ||
        document.querySelector('button[aria-label*="Send message"]');
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
        button.click();
        return true;
      }
      var composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"][data-testid="prompt-textarea"]') ||
        document.querySelector('div[contenteditable="true"]#prompt-textarea');
      if (composer) {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
        return true;
      }
      return false;
    })();`
  );
  if (!sent) throw new Error("Could not submit the ChatGPT prompt");

  const startedAt = Date.now();
  let sawResponseStart = false;
  let stableCount = 0;
  let lastAssistantText = "";
  while (Date.now() - startedAt < DEFAULT_GENERATION_TIMEOUT_MS) {
    const status = await execInWebview<{ generating: boolean; assistantText: string; assistantCount: number }>(
      webview,
      `(function(){
        var stopButton =
          document.querySelector('button[data-testid="stop-button"]') ||
          document.querySelector('button[aria-label*="Stop generating"]') ||
          document.querySelector('button[aria-label*="Stop streaming"]');
        var nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
        var text = '';
        if (nodes.length) {
          var last = nodes[nodes.length - 1];
          text = (last.innerText || last.textContent || '').trim();
        }
        return { generating: Boolean(stopButton), assistantText: text, assistantCount: nodes.length };
      })();`
    );
    if (!status) {
      await sleep(600);
      continue;
    }
    if (status.generating || (status.assistantText && status.assistantText !== (beforeSignature || ""))) {
      sawResponseStart = true;
    }
    if (status.assistantText && status.assistantText === lastAssistantText) stableCount += 1;
    else stableCount = 0;
    lastAssistantText = status.assistantText || "";
    if (sawResponseStart && !status.generating && status.assistantText && stableCount >= 2) {
      break;
    }
    await sleep(900);
  }
  if (!lastAssistantText.trim()) throw new Error("ChatGPT did not return any response text");
  return lastAssistantText.trim();
}

export async function runProviderPrompt<T>(params: RunProviderPromptParams): Promise<ProviderAutomationResult<T>> {
  if (!params.prompt.trim()) {
    throw new Error("Prompt is empty");
  }
  if (typeof params.webview?.executeJavaScript !== "function") {
    throw new Error("Provider webview is not available");
  }
  if (params.startFreshChat) {
    if (params.kind === "deepseek") await startFreshDeepSeekChat(params.webview);
    else await startFreshChatGptChat(params.webview);
  }
  const rawText = params.kind === "deepseek"
    ? await runDeepSeekPrompt(params.webview, params.prompt)
    : await runChatGptPrompt(params.webview, params.prompt);
  const jsonText = extractJsonObjectText(rawText);
  return {
    rawText,
    jsonText,
    parsedJson: parseJsonValue<T>(jsonText),
    chatUrl: await readChatUrl(params.webview),
  };
}
