let currentFolder = "telegram-txt/unknown-channel";
let lastActivity = 0;
// Files the page clicked that Chrome has not created a download for yet.
let pending = [];
// Chrome download id -> file info, until the download completes or fails.
let tracked = {};

// Telegram finishes fetching a file and hands it to Chrome some time after the
// click, so keep routing downloads for a while after the last scan round.
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

function safePart(value, fallback) {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 100) || fallback;
}

// Allows "a/b" subfolders under Downloads while rejecting "..", drive letters, etc.
function safeFolder(value, fallback) {
  const parts = String(value || "").split(/[\\/]+/)
    .map(part => safePart(part, ""))
    .filter(Boolean);
  return parts.length ? parts.slice(0, 5).join("/") : fallback;
}

// The service worker can be stopped mid-run, so mirror its state to session storage.
function persist() {
  chrome.storage.session.set({ currentFolder, lastActivity, pending, tracked });
}

function touch() {
  lastActivity = Date.now();
  persist();
}

const ready = chrome.storage.session.get(["currentFolder", "lastActivity", "pending", "tracked"]).then(saved => {
  if (saved.currentFolder) currentFolder = saved.currentFolder;
  if (saved.lastActivity) lastActivity = saved.lastActivity;
  if (saved.pending) pending = saved.pending;
  if (saved.tracked) tracked = saved.tracked;
});

function fileInfo(message, tabId) {
  return {
    key: String(message.key || ""),
    name: String(message.name || ""),
    size: Number(message.size) || 0,
    channelId: String(message.channelId || ""),
    tabId
  };
}

function report(file, ok) {
  if (file.tabId == null) return;
  chrome.tabs.sendMessage(file.tabId, { type: "file-finished", key: file.key, size: file.size, ok })
    .catch(() => {});
}

// History writes are serialized so simultaneous completions don't overwrite each other.
let historyWrites = Promise.resolve();
function markDone(file) {
  if (!file.key || !file.channelId) return;
  historyWrites = historyWrites.then(async () => {
    const storageKey = `done:${file.channelId}`;
    const done = (await chrome.storage.local.get(storageKey))[storageKey] || [];
    if (done.includes(file.key)) return;
    done.push(file.key);
    await chrome.storage.local.set({ [storageKey]: done });
  }).catch(() => {});
}

// Match a new Chrome download to the clicked file: by name first, then by the
// closest size, since Telegram may save a name slightly differently.
function claimPending(baseName, totalBytes) {
  const now = Date.now();
  pending = pending.filter(file => now - file.at < PENDING_TTL_MS);
  const normalize = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  let index = pending.findIndex(file => normalize(file.name) === normalize(baseName));
  if (index < 0 && totalBytes > 0) {
    let bestDiff = Infinity;
    pending.forEach((file, i) => {
      if (!file.size) return;
      const diff = Math.abs(file.size - totalBytes) / totalBytes;
      if (diff < bestDiff) { bestDiff = diff; index = i; }
    });
    if (bestDiff > 0.1) index = -1;
  }
  return index < 0 ? null : pending.splice(index, 1)[0];
}

// Telegram Web ignores script-generated clicks (isTrusted = false), so clicks
// are sent through the DevTools protocol, which the page sees as a real mouse.
const attachedTabs = new Set();

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // Still attached from before the service worker restarted.
    if (!/already attached/i.test(String(error?.message || error))) throw error;
  }
  attachedTabs.add(tabId);
}

async function releaseDebugger(tabId) {
  if (!attachedTabs.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

async function trustedClick(tabId, x, y) {
  if (tabId == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid click target");
  await attachDebugger(tabId);
  const send = params => chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { x, y, ...params });
  await send({ type: "mouseMoved" });
  await send({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1 });
  await send({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 });
}

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  switch (message?.type) {
    case "set-channel-folder": {
      const channelFolder = `telegram-txt/${safePart(message.channel, "unknown-channel")}`;
      currentFolder = safeFolder(message.folder, channelFolder);
      touch();
      return { ok: true, folder: currentFolder };
    }
    case "keepalive":
      touch();
      return { ok: true };
    case "expect":
      pending.push({ ...fileInfo(message, tabId), at: Date.now() });
      touch();
      return { ok: true };
    // A click that never reached Telegram; drop it so it can't be matched later.
    case "unexpect":
      pending = pending.filter(file => file.key !== String(message.key || ""));
      persist();
      return { ok: true };
    case "click":
      await trustedClick(tabId, Number(message.x), Number(message.y));
      return { ok: true };
    case "release-debugger":
      await releaseDebugger(tabId);
      return { ok: true };
    case "download": {
      if (typeof message.url !== "string") return { ok: false };
      const file = fileInfo(message, tabId);
      try {
        const id = await chrome.downloads.download({
          url: message.url,
          filename: `${currentFolder}/${safePart(file.name, "telegram-file.txt")}`,
          conflictAction: "uniquify",
          saveAs: false
        });
        tracked[id] = file;
        touch();
        return { ok: true };
      } catch (error) {
        report(file, false);
        return { ok: false, error: String(error) };
      }
    }
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(() => handleMessage(message, sender))
    .then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
  return true;
});

// Telegram's own document-card click creates the download (usually from a
// blob: or service-worker URL), so use the filename hook to put it in the folder.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) return;
  const fromTelegramWeb = [item.url, item.finalUrl, item.referrer]
    .some(url => /^(?:blob:)?https:\/\/web\.telegram\.org\//i.test(url || ""));
  if (!fromTelegramWeb) return;

  ready.then(() => {
    const baseName = (item.filename || "").split(/[\\/]/).pop();
    const isTxt = /\.txt$/i.test(baseName) || /^text\/plain/i.test(item.mime || "");
    const file = claimPending(baseName, item.totalBytes || item.fileSize);
    if (file) {
      tracked[item.id] = file;
      persist();
      if (file.tabId != null) {
        chrome.tabs.sendMessage(file.tabId, { type: "file-started", key: file.key }).catch(() => {});
      }
    } else if (isTxt && pending.length && pending[0].tabId != null) {
      // Can't tell which click this is, so don't record history for it, but
      // let the page free a parallel slot instead of waiting for a timeout.
      chrome.tabs.sendMessage(pending[0].tabId, { type: "file-started-unmatched" }).catch(() => {});
    }
    const active = Date.now() - lastActivity <= ACTIVE_WINDOW_MS;
    if (!file && !(active && isTxt)) {
      suggest();
      return;
    }
    suggest({
      filename: `${currentFolder}/${safePart(baseName, "telegram-file.txt")}`,
      conflictAction: "uniquify"
    });
  });
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  const result = delta.state?.current;
  if (result !== "complete" && result !== "interrupted") return;
  ready.then(() => {
    const file = tracked[delta.id];
    if (!file) return;
    delete tracked[delta.id];
    persist();
    if (result === "complete") markDone(file);
    report(file, result === "complete");
  });
});
