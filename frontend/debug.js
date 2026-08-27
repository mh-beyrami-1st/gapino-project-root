(function () {
  if (window.__gapinoDebugBootLoaded) return;

  window.__gapinoDebugBootLoaded = true;

  var params = new URLSearchParams(window.location.search);
  var DEBUG_ENABLED =
    params.get("debug") === "1" ||
    params.get("debug") === "true" ||
    params.get("d") === "1";

  var MAX_ENTRIES = 500;
  var PANEL_STATE_KEY = "gapino-debug-panel-state";

  var originalConsole = {
    log: typeof console.log === "function" ? console.log.bind(console) : null,
    warn: typeof console.warn === "function" ? console.warn.bind(console) : null,
    error: typeof console.error === "function" ? console.error.bind(console) : null
  };

  window.__GapinoDebugEnabled = DEBUG_ENABLED;
  window.__gapinoDebugQueue = Array.isArray(window.__gapinoDebugQueue)
    ? window.__gapinoDebugQueue
    : [];

  function safeStringify(value) {
    try {
      if (typeof value === "string") return value;

      return JSON.stringify(
        value,
        function (_key, item) {
          if (typeof item === "bigint") {
            return item.toString() + "n";
          }

          if (item instanceof Error) {
            return {
              name: item.name,
              message: item.message,
              stack: item.stack
            };
          }

          return item;
        },
        2
      );
    } catch (error) {
      try {
        return String(value);
      } catch (_error) {
        return "[unserializable]";
      }
    }
  }

  function joinArgs(args) {
    return Array.prototype.slice
      .call(args)
      .map(function (item) {
        return typeof item === "string"
          ? item
          : safeStringify(item);
      })
      .join(" ");
  }

  function formatTime(timestamp) {
    var date = new Date(timestamp || Date.now());

    return [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join(":") + "." + String(date.getMilliseconds()).padStart(3, "0");
  }

  function normalizeType(type) {
    if (type === "warn" || type === "error") {
      return type;
    }

    return "log";
  }

  function normalizeEntry(type, message, meta, stack) {
    return {
      type: normalizeType(type),
      message: message == null ? "" : String(message),
      meta: meta == null ? "" : String(meta),
      stack: stack == null ? "" : String(stack),
      timestamp: Date.now()
    };
  }

  function trimQueue() {
    var overflow =
      window.__gapinoDebugQueue.length - MAX_ENTRIES;

    if (overflow > 0) {
      window.__gapinoDebugQueue.splice(0, overflow);
    }
  }

  function pushEntry(entry) {
    window.__gapinoDebugQueue.push(entry);
    trimQueue();
  }

  function getPanelState() {
    try {
      var value = sessionStorage.getItem(PANEL_STATE_KEY);

      if (value === "hidden" || value === "minimized") {
        return value;
      }
    } catch (_error) {
      return "visible";
    }

    return "visible";
  }

  function setPanelState(state) {
    try {
      sessionStorage.setItem(PANEL_STATE_KEY, state);
    } catch (_error) {
      return;
    }
  }

  function createElement(tagName, options) {
    var element = document.createElement(tagName);
    var config = options || {};

    if (config.id) {
      element.id = config.id;
    }

    if (config.className) {
      element.className = config.className;
    }

    if (config.text != null) {
      element.textContent = String(config.text);
    }

    if (config.type) {
      element.type = config.type;
    }

    if (config.title) {
      element.title = config.title;
    }

    return element;
  }

  function ensureStyle() {
    if (document.getElementById("gapino-debug-style")) {
      return;
    }

    var style = document.createElement("style");

    style.id = "gapino-debug-style";
    style.textContent = `
      #gapino-debug-panel,
      #gapino-debug-launcher {
        box-sizing: border-box;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      #gapino-debug-panel *,
      #gapino-debug-launcher * {
        box-sizing: border-box;
      }

      #gapino-debug-panel {
        position: fixed;
        left: max(12px, env(safe-area-inset-left));
        right: max(12px, env(safe-area-inset-right));
        bottom: max(12px, env(safe-area-inset-bottom));
        height: 34vh;
        min-height: 180px;
        max-height: 55vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        direction: ltr;
        color: #e5e7eb;
        background: rgba(10, 10, 10, 0.96);
        border: 1px solid rgba(239, 68, 68, 0.35);
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        z-index: 2147483647;
      }

      #gapino-debug-panel[data-state="hidden"] {
        display: none;
      }

      #gapino-debug-panel[data-state="minimized"] {
        height: 44px;
        min-height: 44px;
      }

      #gapino-debug-panel[data-state="minimized"] #gapino-debug-body {
        display: none;
      }

      #gapino-debug-header {
        min-height: 44px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 10px 0 12px;
        color: #fff;
        background: rgba(239, 68, 68, 0.12);
        border-bottom: 1px solid rgba(239, 68, 68, 0.2);
        font-size: 12px;
        font-weight: 700;
        user-select: none;
        -webkit-user-select: none;
      }

      #gapino-debug-header-info {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #gapino-debug-title {
        white-space: nowrap;
      }

      #gapino-debug-counters {
        display: flex;
        align-items: center;
        gap: 5px;
        color: #9ca3af;
        font-size: 10px;
        font-weight: 600;
      }

      .gapino-debug-counter {
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
      }

      #gapino-debug-warn-count {
        color: #fde68a;
      }

      #gapino-debug-error-count {
        color: #fecaca;
      }

      #gapino-debug-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      #gapino-debug-header button {
        appearance: none;
        min-height: 30px;
        margin: 0;
        padding: 5px 8px;
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
      }

      #gapino-debug-header button:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      #gapino-debug-header button:active {
        transform: scale(0.96);
      }

      #gapino-debug-body {
        flex: 1;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 10px;
        font-size: 12px;
        line-height: 1.5;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
        -webkit-overflow-scrolling: touch;
      }

      .gapino-debug-entry {
        margin-bottom: 8px;
        padding: 8px 10px;
        overflow: hidden;
        color: #dbeafe;
        background: rgba(255, 255, 255, 0.04);
        border-left: 4px solid #60a5fa;
        border-radius: 10px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .gapino-debug-entry.warn {
        color: #fde68a;
        background: rgba(245, 158, 11, 0.08);
        border-left-color: #f59e0b;
      }

      .gapino-debug-entry.error {
        color: #fecaca;
        background: rgba(239, 68, 68, 0.08);
        border-left-color: #ef4444;
      }

      .gapino-debug-entry-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
        color: #9ca3af;
        font-size: 10px;
      }

      .gapino-debug-entry-type {
        font-weight: 800;
        text-transform: uppercase;
      }

      .gapino-debug-entry.log .gapino-debug-entry-type {
        color: #93c5fd;
      }

      .gapino-debug-entry.warn .gapino-debug-entry-type {
        color: #fbbf24;
      }

      .gapino-debug-entry.error .gapino-debug-entry-type {
        color: #f87171;
      }

      .gapino-debug-message {
        color: inherit;
      }

      .gapino-debug-meta {
        margin-top: 5px;
        color: #9ca3af;
        font-size: 11px;
      }

      .gapino-debug-stack {
        margin-top: 7px;
        padding-top: 7px;
        color: #d1d5db;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        white-space: pre-wrap;
      }

      #gapino-debug-empty {
        display: flex;
        min-height: 100%;
        align-items: center;
        justify-content: center;
        color: #6b7280;
        text-align: center;
      }

      #gapino-debug-launcher {
        position: fixed;
        right: max(14px, env(safe-area-inset-right));
        bottom: max(14px, env(safe-area-inset-bottom));
        min-width: 52px;
        height: 42px;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 12px;
        color: #fff;
        background: rgba(17, 24, 39, 0.96);
        border: 1px solid rgba(239, 68, 68, 0.45);
        border-radius: 999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        touch-action: manipulation;
        z-index: 2147483647;
      }

      #gapino-debug-launcher[data-visible="true"] {
        display: flex;
      }

      #gapino-debug-launcher-badge {
        min-width: 18px;
        height: 18px;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        color: #fff;
        background: #ef4444;
        border-radius: 999px;
        font-size: 9px;
      }

      #gapino-debug-launcher-badge[data-visible="true"] {
        display: flex;
      }

      @media (max-width: 640px) {
        #gapino-debug-panel {
          left: 6px;
          right: 6px;
          bottom: max(6px, env(safe-area-inset-bottom));
          height: 42vh;
          max-height: 65vh;
        }

        #gapino-debug-header {
          gap: 6px;
          padding-left: 9px;
          padding-right: 7px;
        }

        #gapino-debug-header-actions {
          gap: 4px;
        }

        #gapino-debug-header button {
          min-height: 29px;
          padding: 5px 7px;
          font-size: 10px;
        }

        #gapino-debug-counters {
          display: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function buildEntryElement(item) {
    var entry = createElement("div", {
      className:
        "gapino-debug-entry " +
        normalizeType(item.type)
    });

    var header = createElement("div", {
      className: "gapino-debug-entry-header"
    });

    var type = createElement("span", {
      className: "gapino-debug-entry-type",
      text: normalizeType(item.type)
    });

    var time = createElement("time", {
      className: "gapino-debug-entry-time",
      text: formatTime(item.timestamp)
    });

    var message = createElement("div", {
      className: "gapino-debug-message",
      text: item.message || ""
    });

    header.appendChild(type);
    header.appendChild(time);

    entry.appendChild(header);
    entry.appendChild(message);

    if (item.meta) {
      entry.appendChild(
        createElement("div", {
          className: "gapino-debug-meta",
          text: item.meta
        })
      );
    }

    if (item.stack) {
      entry.appendChild(
        createElement("div", {
          className: "gapino-debug-stack",
          text: item.stack
        })
      );
    }

    return entry;
  }

  function getEntryCounts() {
    return window.__gapinoDebugQueue.reduce(
      function (counts, item) {
        var type = normalizeType(item.type);

        counts.total += 1;
        counts[type] += 1;

        return counts;
      },
      {
        total: 0,
        log: 0,
        warn: 0,
        error: 0
      }
    );
  }

  function updateCounters() {
    var counts = getEntryCounts();
    var total = document.getElementById("gapino-debug-total-count");
    var warns = document.getElementById("gapino-debug-warn-count");
    var errors = document.getElementById("gapino-debug-error-count");
    var badge = document.getElementById("gapino-debug-launcher-badge");

    if (total) {
      total.textContent = String(counts.total);
    }

    if (warns) {
      warns.textContent = "W " + counts.warn;
    }

    if (errors) {
      errors.textContent = "E " + counts.error;
    }

    if (badge) {
      badge.textContent = String(counts.error);
      badge.dataset.visible =
        counts.error > 0 ? "true" : "false";
    }
  }

  function updateEmptyState() {
    var body = document.getElementById("gapino-debug-body");

    if (!body) return;

    var empty = document.getElementById("gapino-debug-empty");
    var hasEntries = window.__gapinoDebugQueue.length > 0;

    if (hasEntries && empty) {
      empty.remove();
      return;
    }

    if (!hasEntries && !empty) {
      body.appendChild(
        createElement("div", {
          id: "gapino-debug-empty",
          text: "No debug entries"
        })
      );
    }
  }

  function scrollToBottom() {
    var body = document.getElementById("gapino-debug-body");

    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function renderQueue() {
    if (!DEBUG_ENABLED) return;

    var body = document.getElementById("gapino-debug-body");

    if (!body) return;

    body.replaceChildren();

    window.__gapinoDebugQueue.forEach(function (item) {
      body.appendChild(buildEntryElement(item));
    });

    updateEmptyState();
    updateCounters();
    scrollToBottom();
  }

  function createButton(id, text, title) {
    return createElement("button", {
      id: id,
      text: text,
      title: title,
      type: "button"
    });
  }

  function formatEntriesForClipboard() {
    return window.__gapinoDebugQueue
      .map(function (item) {
        var parts = [
          "[" + formatTime(item.timestamp) + "]",
          "[" + normalizeType(item.type).toUpperCase() + "]",
          item.message || ""
        ];

        if (item.meta) {
          parts.push(item.meta);
        }

        if (item.stack) {
          parts.push(item.stack);
        }

        return parts.join("\n");
      })
      .join("\n\n");
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    var successful = false;

    try {
      successful = document.execCommand("copy");
    } catch (_error) {
      successful = false;
    }

    textarea.remove();

    return successful;
  }

  function copyEntries(button) {
    var text = formatEntriesForClipboard();
    var originalText = button.textContent;

    function showResult(successful) {
      button.textContent = successful ? "Copied" : "Failed";

      window.setTimeout(function () {
        button.textContent = originalText;
      }, 1200);
    }

    if (!text) {
      showResult(false);
      return;
    }

    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      navigator.clipboard
        .writeText(text)
        .then(function () {
          showResult(true);
        })
        .catch(function () {
          showResult(fallbackCopy(text));
        });

      return;
    }

    showResult(fallbackCopy(text));
  }

  function clearEntries() {
    window.__gapinoDebugQueue.length = 0;
    renderQueue();
  }

  function applyPanelState(state) {
    var panel = document.getElementById("gapino-debug-panel");
    var launcher = document.getElementById("gapino-debug-launcher");
    var minimizeButton = document.getElementById("gapino-debug-minimize");

    if (!panel || !launcher) return;

    var normalizedState =
      state === "hidden" || state === "minimized"
        ? state
        : "visible";

    panel.dataset.state = normalizedState;
    launcher.dataset.visible =
      normalizedState === "hidden" ? "true" : "false";

    if (minimizeButton) {
      minimizeButton.textContent =
        normalizedState === "minimized"
          ? "Expand"
          : "Minimize";
    }

    setPanelState(normalizedState);
  }

  function showPanel() {
    applyPanelState("visible");
    scrollToBottom();
  }

  function hidePanel() {
    applyPanelState("hidden");
  }

  function toggleMinimize() {
    var panel = document.getElementById("gapino-debug-panel");

    if (!panel) return;

    applyPanelState(
      panel.dataset.state === "minimized"
        ? "visible"
        : "minimized"
    );
  }

  function togglePanel() {
    var panel = document.getElementById("gapino-debug-panel");

    if (!panel) {
      ensurePanel();
      return;
    }

    if (panel.dataset.state === "hidden") {
      showPanel();
    } else {
      hidePanel();
    }
  }

  function ensureLauncher() {
    var existing = document.getElementById("gapino-debug-launcher");

    if (existing) {
      return existing;
    }

    var launcher = createElement("button", {
      id: "gapino-debug-launcher",
      type: "button",
      title: "Show Gapino debug console"
    });

    var label = createElement("span", {
      text: "DEBUG"
    });

    var badge = createElement("span", {
      id: "gapino-debug-launcher-badge",
      text: "0"
    });

    launcher.appendChild(label);
    launcher.appendChild(badge);

    launcher.addEventListener("click", showPanel);

    document.body.appendChild(launcher);

    return launcher;
  }

  function ensurePanel() {
    if (!DEBUG_ENABLED || !document.body) {
      return null;
    }

    ensureStyle();
    ensureLauncher();

    var existing = document.getElementById("gapino-debug-panel");

    if (existing) {
      return existing;
    }

    var panel = createElement("div", {
      id: "gapino-debug-panel"
    });

    var header = createElement("div", {
      id: "gapino-debug-header"
    });

    var headerInfo = createElement("div", {
      id: "gapino-debug-header-info"
    });

    var title = createElement("span", {
      id: "gapino-debug-title",
      text: "GAPINO DEBUG"
    });

    var counters = createElement("div", {
      id: "gapino-debug-counters"
    });

    var totalCount = createElement("span", {
      id: "gapino-debug-total-count",
      className: "gapino-debug-counter",
      text: "0"
    });

    var warnCount = createElement("span", {
      id: "gapino-debug-warn-count",
      className: "gapino-debug-counter",
      text: "W 0"
    });

    var errorCount = createElement("span", {
      id: "gapino-debug-error-count",
      className: "gapino-debug-counter",
      text: "E 0"
    });

    var actions = createElement("div", {
      id: "gapino-debug-header-actions"
    });

    var copyButton = createButton(
      "gapino-debug-copy",
      "Copy",
      "Copy all debug entries"
    );

    var clearButton = createButton(
      "gapino-debug-clear",
      "Clear",
      "Clear all debug entries"
    );

    var minimizeButton = createButton(
      "gapino-debug-minimize",
      "Minimize",
      "Minimize debug console"
    );

    var hideButton = createButton(
      "gapino-debug-hide",
      "Hide",
      "Hide debug console"
    );

    var body = createElement("div", {
      id: "gapino-debug-body"
    });

    counters.appendChild(totalCount);
    counters.appendChild(warnCount);
    counters.appendChild(errorCount);

    headerInfo.appendChild(title);
    headerInfo.appendChild(counters);

    actions.appendChild(copyButton);
    actions.appendChild(clearButton);
    actions.appendChild(minimizeButton);
    actions.appendChild(hideButton);

    header.appendChild(headerInfo);
    header.appendChild(actions);

    panel.appendChild(header);
    panel.appendChild(body);

    document.body.appendChild(panel);

    copyButton.addEventListener("click", function () {
      copyEntries(copyButton);
    });

    clearButton.addEventListener("click", clearEntries);
    minimizeButton.addEventListener("click", toggleMinimize);
    hideButton.addEventListener("click", hidePanel);

    renderQueue();
    applyPanelState(getPanelState());

    return panel;
  }

  function appendEntry(type, message, meta, stack) {
    if (!DEBUG_ENABLED) return null;

    var entry = normalizeEntry(type, message, meta, stack);

    pushEntry(entry);

    var panel = ensurePanel();

    if (!panel) {
      return entry;
    }

    var body = document.getElementById("gapino-debug-body");

    if (!body) {
      return entry;
    }

    var empty = document.getElementById("gapino-debug-empty");

    if (empty) {
      empty.remove();
    }

    body.appendChild(buildEntryElement(entry));

    while (body.children.length > MAX_ENTRIES) {
      body.firstElementChild.remove();
    }

    updateCounters();
    scrollToBottom();

    return entry;
  }

  window.__gapinoDebugLog = function (message, meta) {
    return appendEntry("log", message, meta || "");
  };

  window.__gapinoDebugWarn = function (message, meta) {
    return appendEntry("warn", message, meta || "");
  };

  window.__gapinoDebugError = function (message, meta, stack) {
    return appendEntry(
      "error",
      message,
      meta || "",
      stack || ""
    );
  };

  window.__gapinoDebug = {
    enabled: DEBUG_ENABLED,
    show: showPanel,
    hide: hidePanel,
    toggle: togglePanel,
    clear: clearEntries,
    minimize: toggleMinimize,
    entries: function () {
      return window.__gapinoDebugQueue.slice();
    },
    copy: function () {
      return formatEntriesForClipboard();
    }
  };

  if (DEBUG_ENABLED) {
    console.log = function () {
      appendEntry(
        "log",
        joinArgs(arguments),
        "[console.log]"
      );

      if (originalConsole.log) {
        originalConsole.log.apply(null, arguments);
      }
    };

    console.warn = function () {
      appendEntry(
        "warn",
        joinArgs(arguments),
        "[console.warn]"
      );

      if (originalConsole.warn) {
        originalConsole.warn.apply(null, arguments);
      }
    };

    console.error = function () {
      appendEntry(
        "error",
        joinArgs(arguments),
        "[console.error]"
      );

      if (originalConsole.error) {
        originalConsole.error.apply(null, arguments);
      }
    };
  }

  window.addEventListener(
    "error",
    function (event) {
      if (!DEBUG_ENABLED) return;

      var location =
        (event.filename || "[inline]") +
        ":" +
        (event.lineno || 0) +
        ":" +
        (event.colno || 0);

      appendEntry(
        "error",
        event.message || "Unhandled error",
        location,
        event.error && event.error.stack
          ? event.error.stack
          : ""
      );
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    function (event) {
      if (!DEBUG_ENABLED) return;

      var reason = event.reason;

      var message =
        reason && reason.message
          ? reason.message
          : "Unhandled promise rejection";

      var stack =
        reason && reason.stack
          ? reason.stack
          : safeStringify(reason);

      appendEntry(
        "error",
        message,
        "[unhandled promise]",
        stack
      );
    }
  );

  window.addEventListener("keydown", function (event) {
    if (!DEBUG_ENABLED) return;

    var modifier = event.ctrlKey || event.metaKey;

    if (
      modifier &&
      event.shiftKey &&
      String(event.key).toLowerCase() === "d"
    ) {
      event.preventDefault();
      togglePanel();
    }
  });

  function bootDebugPanel() {
    if (!DEBUG_ENABLED) return;

    ensurePanel();

    appendEntry(
      "log",
      "Debug panel initialized",
      window.location.href
    );
  }

  if (DEBUG_ENABLED) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        bootDebugPanel,
        { once: true }
      );
    } else {
      bootDebugPanel();
    }
  }
})();
