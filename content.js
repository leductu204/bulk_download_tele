(() => {
  if (window.top !== window) return;

  // Telegram renders each message or shared-media row inside one of these.
  const CARD_SELECTOR = "[data-mid], [data-message-id], .search-super-item, .bubble, .Message, .message, .im_message, .ListItem";
  const TXT_NAME = /\S\.txt\b/i;
  const SCROLL_WAIT_MS = 2000;
  const IDLE_LIMIT = 3;
  const QUEUE_BUFFER = 40;
  // A click whose download hasn't appeared in Chrome by then frees its slot
  // (bigger files get longer, since Telegram fetches them before saving).
  const START_TIMEOUT_MS = 15000;
  const START_BYTES_PER_SEC = 100 * 1024;
  const FINISH_TIMEOUT_MS = 5 * 60 * 1000;

  const cardCache = new WeakMap();
  let harvested = new WeakSet();

  const state = {
    running: false,
    countOnly: false,
    label: "",
    scroller: null,
    direction: 1,
    channelId: "",
    from: 1,
    limit: 0,
    parallel: 4,
    skipDone: true,
    history: new Set(),
    seenKeys: new Set(),
    timedOut: new Set(),
    queue: [],
    inFlight: new Map(),
    scanned: 0,
    selected: 0,
    selectedBytes: 0,
    unknownSize: 0,
    alreadyDone: 0,
    alreadyBytes: 0,
    completed: 0,
    completedBytes: 0,
    failed: 0,
    missed: 0,
    unconfirmed: 0,
    clickError: "",
    scanDone: false,
    idleRounds: 0,
    lastProgressAt: 0
  };

  const css = `
    #tg-txt-downloader { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px;
      width: 300px; padding: 12px; border-radius: 12px; color: #fff;
      background: #17212b; box-shadow: 0 4px 24px #0006; font: 13px Arial,sans-serif; }
    #tg-txt-downloader * { box-sizing: border-box; }
    #tg-txt-downloader button { flex: 1; border: 0; border-radius: 7px; padding: 8px 10px; cursor: pointer;
      color: #fff; background: #2aabee; font-weight: 600; }
    #tg-txt-downloader button.secondary { background: #2b5278; }
    #tg-txt-downloader button.stop { background: #e35d6a; }
    #tg-txt-downloader button.link { flex: none; padding: 0; background: none; color: #6ab3f3; font-weight: 400; }
    #tg-txt-downloader button:disabled { opacity: 0.5; cursor: default; }
    #tg-txt-downloader .row { display: flex; gap: 8px; align-items: center; }
    #tg-txt-downloader .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    #tg-txt-downloader .title { font-weight: 700; margin-bottom: 8px; }
    #tg-txt-downloader label { display: block; margin-bottom: 8px; color: #91a4b7; font-size: 12px; }
    #tg-txt-downloader input { display: block; width: 100%; margin-top: 4px; padding: 7px 8px;
      border: 1px solid #2b3a4a; border-radius: 7px; color: #fff; background: #0e1621; font: inherit; }
    #tg-txt-downloader input[type=checkbox] { display: inline-block; width: auto; margin: 0 6px 0 0; vertical-align: middle; }
    #tg-txt-downloader input:focus { outline: none; border-color: #2aabee; }
    #tg-txt-downloader input:disabled { opacity: 0.6; }
    #tg-txt-status { margin-top: 8px; color: #c8d6e5; line-height: 1.4; white-space: pre-line; }
    #tg-txt-downloader .history { justify-content: space-between; margin-top: 8px; color: #91a4b7; font-size: 12px; }
    #tg-txt-downloader small { display: block; margin-top: 7px; color: #91a4b7; }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.appendChild(style);

  const panel = document.createElement("section");
  panel.id = "tg-txt-downloader";
  panel.innerHTML = `
    <div class="title">Telegram TXT Downloader</div>
    <label>Thư mục trong Downloads (để trống = theo tên channel)
      <input id="tg-txt-folder" placeholder="telegram-txt/<tên channel>" spellcheck="false"></label>
    <div class="grid">
      <label>Từ file số<input id="tg-txt-from" type="number" min="1" step="1" placeholder="1"></label>
      <label>Số file<input id="tg-txt-limit" type="number" min="1" step="1" placeholder="Tất cả"></label>
      <label>Song song<input id="tg-txt-parallel" type="number" min="1" max="10" step="1" placeholder="4"></label>
    </div>
    <label><input id="tg-txt-skip" type="checkbox" checked>Bỏ qua file đã tải trước đó</label>
    <div class="row"><button id="tg-txt-start">Tải .txt</button>
      <button id="tg-txt-count" class="secondary">Đếm dung lượng</button>
      <button id="tg-txt-stop" class="stop" hidden>Dừng</button></div>
    <div id="tg-txt-status">Mở tab Files của channel (hoặc khung chat) rồi bấm nút.</div>
    <div class="row history"><span id="tg-txt-history"></span>
      <button id="tg-txt-clear" class="link">Xóa lịch sử</button></div>
    <small>Muốn lưu sang ổ khác: đổi vị trí tải xuống trong Cài đặt Chrome.
      Chỉ đọc channel đang mở; không thu thập tài khoản hay mật khẩu.</small>`;
  document.documentElement.appendChild(panel);

  const $ = selector => panel.querySelector(selector);
  const startButton = $("#tg-txt-start");
  const countButton = $("#tg-txt-count");
  const stopButton = $("#tg-txt-stop");
  const clearButton = $("#tg-txt-clear");
  const status = $("#tg-txt-status");
  const historyInfo = $("#tg-txt-history");
  const folderInput = $("#tg-txt-folder");
  const fromInput = $("#tg-txt-from");
  const limitInput = $("#tg-txt-limit");
  const parallelInput = $("#tg-txt-parallel");
  const skipInput = $("#tg-txt-skip");
  const controls = [folderInput, fromInput, limitInput, parallelInput, skipInput, clearButton];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function notify(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      // Extension was reloaded; this page needs a refresh to talk to it again.
      return Promise.resolve(null);
    }
  }

  // After the extension is reloaded, the panel left on an open tab loses its
  // connection and every chrome.* call throws until the page is refreshed.
  const RELOAD_HINT = "Extension vừa được cập nhật. Hãy F5 (tải lại) trang Telegram rồi thử lại.";
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  chrome.storage.local.get(["customFolder", "settings"]).then(saved => {
    if (saved.customFolder) folderInput.value = saved.customFolder;
    if (saved.settings?.parallel) parallelInput.value = saved.settings.parallel;
    if (saved.settings && "skipDone" in saved.settings) skipInput.checked = saved.settings.skipDone;
  });
  function saveSettings() {
    if (!extensionAlive()) return;
    chrome.storage.local.set({
      customFolder: folderInput.value.trim(),
      settings: { parallel: parallelInput.value, skipDone: skipInput.checked }
    });
  }
  [folderInput, parallelInput, skipInput].forEach(input => input.addEventListener("change", saveSettings));

  function setStatus(text) { status.textContent = text; }
  function setRunning(running) {
    state.running = running;
    startButton.hidden = running;
    countButton.hidden = running;
    stopButton.hidden = !running;
    controls.forEach(control => { control.disabled = running; });
  }

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function sizeText() {
    const unknown = state.unknownSize ? `, ${state.unknownSize} file không rõ dung lượng` : "";
    return `${formatBytes(state.selectedBytes)}${unknown}`;
  }

  function render() {
    const lines = [];
    if (state.countOnly) {
      lines.push(`${state.label}: đã quét ${state.scanned} file`);
      lines.push(`Trong phạm vi: ${state.selected} file, ${sizeText()}`);
      if (state.alreadyDone) {
        const restBytes = Math.max(0, state.selectedBytes - state.alreadyBytes);
        lines.push(`Đã tải trước: ${state.alreadyDone} (${formatBytes(state.alreadyBytes)}) · còn lại: ${state.selected - state.alreadyDone} (${formatBytes(restBytes)})`);
      }
    } else {
      lines.push(`${state.label}: quét ${state.scanned} · chọn ${state.selected} (${sizeText()})`);
      lines.push(`Đang tải ${state.inFlight.size} · xong ${state.completed} (${formatBytes(state.completedBytes)})${state.failed ? ` · lỗi ${state.failed}` : ""}`);
      const extras = [];
      if (state.skipDone && state.alreadyDone) extras.push(`bỏ qua ${state.alreadyDone} đã tải`);
      if (state.missed) extras.push(`bỏ lỡ ${state.missed}`);
      if (state.unconfirmed) extras.push(`chưa xác nhận ${state.unconfirmed}`);
      if (extras.length) lines.push(extras.join(" · "));
      if (state.clickError) lines.push(`Không bấm được: ${state.clickError}`);
      else if (state.running && state.inFlight.size && Date.now() - state.lastProgressAt > 30000) {
        lines.push("Chưa có file nào tải xong trong 30 giây. Xem chrome://downloads có file mới không rồi báo lại.");
      }
    }
    setStatus(lines.join("\n"));
  }

  function channelName() {
    const selectors = [
      ".chat-info .peer-title", ".tg_head_peer_title", ".chat-info-wrapper h1", ".chat-info-wrapper h2",
      "[class*='chat-title']", "[class*='ChatTitle']", "header h1", "header h2",
      "header [title]"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const name = (element?.getAttribute("title") || element?.innerText || "").trim();
      if (name && name.length < 100 && !/^telegram(?: web)?$/i.test(name)) return name;
    }
    const title = document.title.replace(/\s*[-|]\s*Telegram.*$/i, "").trim();
    return title && !/^telegram(?: web)?$/i.test(title) ? title : "unknown-channel";
  }

  // The URL hash holds the chat id (#-100…, #@name), which stays stable even if
  // the channel is renamed, so download history follows the right channel.
  function channelId() {
    let hash = location.hash.replace(/^#/, "").split("?")[0];
    try { hash = decodeURIComponent(hash); } catch { /* keep raw hash */ }
    return hash.trim() || channelName();
  }

  function historyKey(id = channelId()) { return `done:${id}`; }

  async function loadHistory(id) {
    const key = historyKey(id);
    return new Set((await chrome.storage.local.get(key))[key] || []);
  }

  async function refreshHistoryInfo() {
    try {
      historyInfo.textContent = `Channel này đã tải: ${(await loadHistory()).size} file`;
    } catch {
      historyInfo.textContent = "";
    }
  }
  refreshHistoryInfo();
  window.addEventListener("hashchange", refreshHistoryInfo);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[historyKey()]) refreshHistoryInfo();
  });

  let clearArmedAt = 0;
  clearButton.addEventListener("click", async () => {
    if (Date.now() - clearArmedAt > 3000) {
      clearArmedAt = Date.now();
      clearButton.textContent = "Bấm lần nữa để xóa";
      setTimeout(() => { clearButton.textContent = "Xóa lịch sử"; }, 3000);
      return;
    }
    clearArmedAt = 0;
    clearButton.textContent = "Xóa lịch sử";
    if (!extensionAlive()) {
      setStatus(RELOAD_HINT);
      return;
    }
    await chrome.storage.local.remove(historyKey());
    refreshHistoryInfo();
  });

  // File names often contain spaces ("13K Mix 20.05.txt"), so keep the whole text node.
  function fileNameFrom(card) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const match = (node.nodeValue || "").trim().match(/^.*?\S\.txt\b/i);
      if (match) return match[0].slice(0, 180);
    }
    return "telegram-file.txt";
  }

  // Reads the size Telegram prints under the name ("493 KB · May 20"). The
  // name is removed so names like "5MB.txt" are not mistaken for a size, and
  // the last match wins so "120 KB / 493 KB" progress text yields the total.
  function sizeFrom(card, name) {
    const text = (card.textContent || "").replace(name, " ");
    const last = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)\b/gi)].at(-1);
    if (!last) return null;
    const power = { B: 0, KB: 1, MB: 2, GB: 3 }[last[2].toUpperCase()];
    return parseFloat(last[1].replace(",", ".")) * 1024 ** power;
  }

  // Prefer Telegram's message id; otherwise drop size/progress text, which
  // changes while a download runs and would make the same file look new.
  function fileKey(card, name) {
    const holder = card.closest("[data-mid], [data-message-id]") ||
      card.querySelector("[data-mid], [data-message-id], [data-doc-id]");
    const id = holder && (holder.getAttribute("data-mid") || holder.getAttribute("data-message-id") ||
      holder.getAttribute("data-doc-id"));
    if (id) return `id:${id}`;
    const text = (card.textContent || "")
      .replace(/[\d.,]+\s*[KMG]?B\b/gi, "")
      .replace(/\d+\s*%/g, "")
      .replace(/[\/·•\s]+/g, " ")
      .trim();
    return `text:${name}|${text.slice(0, 200)}`;
  }

  function describe(card) {
    const name = fileNameFrom(card);
    return { key: fileKey(card, name), name, size: sizeFrom(card, name) };
  }

  function txtCount(element) {
    return ((element.textContent || "").match(/\.txt\b/gi) || []).length;
  }

  // Climb from the filename to the largest ancestor that still holds only this
  // one file, so layouts without known message classes still yield one card per file.
  function cardFor(element, scope) {
    let el = element;
    for (let depth = 0; depth < 12; depth++) {
      if (el.matches(CARD_SELECTOR)) return el;
      const parent = el.parentElement;
      if (!parent || parent === scope || parent === document.body || txtCount(parent) > 1) return el;
      el = parent;
    }
    return el;
  }

  // Returns cards in DOM order. Cards already handled this run are skipped
  // early so each round only pays for newly loaded rows.
  function collectCards(scope, includeHarvested = false) {
    const cards = new Set();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const element = node.parentElement;
      if (!element || !/\.txt\b/i.test(node.nodeValue || "")) continue;
      let card = cardCache.get(element);
      if (!card) {
        if (panel.contains(element)) continue;
        card = cardFor(element, scope);
        cardCache.set(element, card);
      }
      if (!includeHarvested && harvested.has(card)) continue;
      if (TXT_NAME.test(card.textContent || "")) cards.add(card);
    }
    return [...cards];
  }

  function scrollableAncestor(element) {
    for (let el = element; el && el !== document.documentElement; el = el.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
        el.scrollHeight > el.clientHeight + 20) return el;
    }
    return document.scrollingElement;
  }

  // Use the scroll area that holds the most .txt files: the Files tab when it
  // is open, otherwise the chat history.
  function pickScroller() {
    const counts = new Map();
    for (const card of collectCards(document.body, true)) {
      const scroller = scrollableAncestor(card);
      counts.set(scroller, (counts.get(scroller) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  // A queued card can be re-rendered by Telegram before its turn comes.
  function relocate(key) {
    return collectCards(state.scroller, true).find(card => describe(card).key === key) || null;
  }

  function downloadLink(root) {
    return [...root.querySelectorAll("a[href]")].find(a => {
      const href = a.href || "";
      return /\.txt(?:$|[?&#])/i.test(href) || /download/i.test(a.getAttribute("aria-label") || "");
    });
  }

  function downloadButton(root) {
    return [...root.querySelectorAll("button, [role=button], a")].find(el => {
      const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent]
        .filter(Boolean).join(" ");
      return /download|tải xuống|save/i.test(label);
    });
  }

  // Telegram's download handler sits on the file icon / document block inside
  // the row, so aim at the icon, the same spot a person would click.
  const CLICK_HINTS = [
    ".document-download", ".document-ico", ".file-icon-container",
    "[class*='file-icon']", "[class*='document-ico']", "[class*='FileIcon']"
  ];
  function clickTargetFor(card) {
    const button = downloadButton(card);
    if (button) return button;
    for (const selector of CLICK_HINTS) {
      const element = card.querySelector(selector);
      if (element) return element;
    }
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (TXT_NAME.test(node.nodeValue || "") && node.parentElement) return node.parentElement;
    }
    return card;
  }

  // Telegram Web ignores clicks created by page scripts, so the background
  // sends a real mouse click at the element's on-screen position. The element
  // is scrolled into view first, and the panel lets the click pass through
  // in case it covers the row.
  // Returns "ok", "covered" (something else sits on the row, so the click
  // would land on the wrong thing) or "error" (the click could not be sent).
  async function clickLikeUser(element, card) {
    panel.style.pointerEvents = "none";
    try {
      let point = null;
      for (let attempt = 0; attempt < 2 && !point; attempt++) {
        element.scrollIntoView({ block: "center" });
        await sleep(attempt ? 400 : 150);
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && card.contains(hit)) point = { x, y };
      }
      if (!point) return "covered";
      const response = await notify({ type: "click", ...point });
      if (!response?.ok) throw new Error(response?.error || "không có phản hồi từ extension");
      state.clickError = "";
      return "ok";
    } catch (error) {
      state.clickError = String(error.message || error);
      console.warn("[tg-txt] click failed", error);
      return "error";
    } finally {
      await sleep(50);
      panel.style.pointerEvents = "";
    }
  }

  function onFileFinished(key, ok, size) {
    if (!state.seenKeys.has(key)) return;
    state.inFlight.delete(key);
    if (state.timedOut.delete(key)) state.unconfirmed--;
    state.lastProgressAt = Date.now();
    if (ok) {
      state.completed++;
      state.completedBytes += size || 0;
    } else {
      state.failed++;
    }
    render();
  }

  function freeSlot(key) {
    state.inFlight.delete(key);
    state.timedOut.add(key);
    state.unconfirmed++;
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "file-finished") {
      onFileFinished(message.key, message.ok, message.size);
    } else if (message?.type === "file-started") {
      const flight = state.inFlight.get(message.key);
      if (flight) Object.assign(flight, { started: true, since: Date.now() });
      state.lastProgressAt = Date.now();
    } else if (message?.type === "file-started-unmatched") {
      // Some click turned into a download we couldn't identify; release the
      // oldest click still waiting so the queue keeps moving.
      const waiting = [...state.inFlight].find(([, flight]) => !flight.started);
      if (waiting) freeSlot(waiting[0]);
      state.lastProgressAt = Date.now();
    }
  });

  async function triggerDownload(card, item) {
    const file = { key: item.key, name: item.name, size: item.size, channelId: state.channelId };
    const link = downloadLink(card);
    if (link) {
      notify({ type: "download", url: link.href, ...file });
      return "ok";
    }
    // Tell the background which file is coming so it can match Chrome's
    // download to it and record it once it really finishes.
    await notify({ type: "expect", ...file });
    const result = await clickLikeUser(clickTargetFor(card), card);
    if (result !== "ok") notify({ type: "unexpect", key: item.key });
    return result;
  }

  // Assigns list positions in display order (newest first) and decides which
  // files this run should download or count.
  function harvest() {
    const cards = collectCards(state.scroller);
    if (state.direction < 0) cards.reverse();
    let found = 0;
    for (const card of cards) {
      if (state.scanDone) break;
      harvested.add(card);
      const info = describe(card);
      if (state.seenKeys.has(info.key)) continue;
      state.seenKeys.add(info.key);
      found++;
      state.scanned++;
      if (state.scanned < state.from) continue;

      if (state.history.has(info.key)) {
        state.alreadyDone++;
        state.alreadyBytes += info.size || 0;
        if (state.skipDone && !state.countOnly) continue;
      }
      state.selected++;
      if (info.size === null) state.unknownSize++; else state.selectedBytes += info.size;
      if (!state.countOnly) state.queue.push({ ...info, card });
      if (state.limit && state.selected >= state.limit) state.scanDone = true;
    }
    return found;
  }

  // Keeps exactly `parallel` downloads running; a slot frees up when the
  // background reports the file finished (or after a timeout). Clicks are
  // sent one at a time because each needs the row on screen.
  async function pump() {
    const now = Date.now();
    for (const [key, flight] of state.inFlight) {
      const limit = flight.started ? FINISH_TIMEOUT_MS
        : START_TIMEOUT_MS + flight.size / START_BYTES_PER_SEC * 1000;
      if (now - flight.since > limit) freeSlot(key);
    }
    while (state.running && state.queue.length && state.inFlight.size < state.parallel) {
      const item = state.queue.shift();
      const card = item.card.isConnected ? item.card : relocate(item.key);
      if (!card) {
        state.missed++;
        continue;
      }
      state.inFlight.set(item.key, { since: Date.now(), started: false, size: item.size || 0 });
      const result = await triggerDownload(card, item);
      if (result === "covered") {
        // Not recorded in history, so the next run picks it up again.
        state.inFlight.delete(item.key);
        state.missed++;
      } else if (result === "error") {
        // The click never reached Telegram: put the file back and stop
        // instead of burning through the whole list.
        state.inFlight.delete(item.key);
        state.queue.unshift(item);
        finish("Đã dừng vì lỗi");
        return;
      }
    }
  }

  // Jumping straight to the end makes Telegram load the next page at once;
  // the wait ends as soon as the list grows instead of after a fixed delay.
  async function scrollToEnd() {
    const scroller = state.scroller;
    const height = scroller.scrollHeight;
    if (state.idleRounds > 0) {
      scroller.scrollTop -= state.direction * scroller.clientHeight;
      await sleep(80);
    }
    scroller.scrollTop = state.direction > 0 ? scroller.scrollHeight : 0;
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < SCROLL_WAIT_MS) {
      await sleep(100);
      if (scroller.scrollHeight !== height) return true;
    }
    return false;
  }

  async function run() {
    while (state.running) {
      if (!extensionAlive()) {
        finish(RELOAD_HINT);
        return;
      }
      if (!state.scroller.isConnected) {
        finish("Khung danh sách đã bị đóng");
        return;
      }
      const found = harvest();
      if (!state.countOnly) await pump();
      if (!state.running) return;

      if (!state.scanDone && (state.countOnly || state.queue.length < QUEUE_BUFFER)) {
        const grew = await scrollToEnd();
        state.idleRounds = grew || found ? 0 : state.idleRounds + 1;
        if (state.idleRounds >= IDLE_LIMIT) state.scanDone = true;
      } else {
        await sleep(250);
      }
      if (!state.running) return;
      if (!state.countOnly) notify({ type: "keepalive" });

      if (state.scanDone && !state.queue.length && !state.inFlight.size) {
        finish("Hoàn tất");
        return;
      }
      state.label = state.scanDone ? "Đang tải nốt" : state.countOnly ? "Đang đếm" : "Đang quét";
      render();
    }
  }

  function finish(label) {
    setRunning(false);
    state.label = label;
    render();
    if (!state.countOnly) {
      notify({ type: "keepalive" });
      notify({ type: "release-debugger" });
    }
    refreshHistoryInfo();
  }

  function positiveInt(input, fallback) {
    const value = Math.floor(Number(input.value));
    return value > 0 ? value : fallback;
  }

  async function start(countOnly) {
    if (!extensionAlive()) {
      setStatus(RELOAD_HINT);
      return;
    }
    const scroller = pickScroller();
    if (!scroller) {
      setStatus("Không thấy file .txt nào trên màn hình. Mở tab Files của channel rồi thử lại.");
      return;
    }

    harvested = new WeakSet();
    Object.assign(state, {
      countOnly,
      label: countOnly ? "Đang đếm" : "Đang quét",
      scroller,
      channelId: channelId(),
      from: positiveInt(fromInput, 1),
      limit: positiveInt(limitInput, 0),
      parallel: Math.min(10, positiveInt(parallelInput, 4)),
      skipDone: skipInput.checked,
      seenKeys: new Set(),
      timedOut: new Set(),
      queue: [],
      inFlight: new Map(),
      scanned: 0, selected: 0, selectedBytes: 0, unknownSize: 0, alreadyDone: 0, alreadyBytes: 0,
      completed: 0, completedBytes: 0, failed: 0, missed: 0, unconfirmed: 0, clickError: "",
      scanDone: false, idleRounds: 0, lastProgressAt: Date.now()
    });
    try {
      state.history = await loadHistory(state.channelId);
    } catch {
      state.history = new Set();
    }

    // Chat history opens at the bottom and loads older messages upwards; the
    // Files tab opens at the top and loads more downwards.
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 50;
    state.direction = atBottom && scroller.scrollTop > 0 ? -1 : 1;
    if (state.direction === 1) scroller.scrollTop = 0;

    setRunning(true);
    if (!countOnly) {
      saveSettings();
      const folder = folderInput.value.trim();
      const response = await notify({ type: "set-channel-folder", channel: channelName(), folder });
      setStatus(`Lưu vào Downloads/${response?.folder || folder || "telegram-txt"}`);
    }
    run();
  }

  startButton.addEventListener("click", () => start(false));
  countButton.addEventListener("click", () => start(true));
  stopButton.addEventListener("click", () => {
    state.queue = [];
    finish(state.inFlight.size ? "Đã dừng (file đang tải dở vẫn tiếp tục)" : "Đã dừng");
  });
})();
