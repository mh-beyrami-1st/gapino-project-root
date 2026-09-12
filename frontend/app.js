const DEFAULT_PROFILE = { name: "", job: "", systemPrompt: "", responseStyle: "" };
const DEFAULT_MODEL_ID = "gpt-5.4-nano";
const MODEL_STORAGE_KEY = "gapino.selectedModel";
const MODEL_PROVIDERS = [
  {
    id: "gpt",
    label: "GPT 5.4",
    subtitle: "OpenAI",
    models: [
      { id: "gpt-5.4-nano", label: "GPT 5.4 Nano", strength: "ضعیف", tone: "weak" },
      { id: "gpt-5.4-mini", label: "GPT 5.4 Mini", strength: "متوسط", tone: "medium" },
      { id: "gpt-5.4", label: "GPT 5.4", strength: "قوی", tone: "strong" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini 2.5",
    subtitle: "Google",
    models: [
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", strength: "متوسط", tone: "medium" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", strength: "قوی", tone: "strong" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", strength: "قوی", tone: "strong" },
    ],
  },
];
const MODEL_OPTIONS = MODEL_PROVIDERS.flatMap((provider) => provider.models);
const THEME_MODES = ["auto", "light", "dark"];

const pinGateEl = document.getElementById("pinGate");
const pinFormEl = document.getElementById("pinForm");
const pinInputEl = document.getElementById("pinInput");
const pinErrorEl = document.getElementById("pinError");
const appEl = document.getElementById("app");

const emptyStateEl = document.getElementById("emptyState");
const messagesSectionEl = document.getElementById("messagesSection");
const chatMainEl = document.getElementById("chatMain");
const userInputEl = document.getElementById("userInput");
const sendBtnEl = document.getElementById("sendBtn");
const themeToggleEl = document.getElementById("themeToggle");
const menuBtnEl = document.getElementById("menuBtn");
const drawerEl = document.getElementById("drawer");
const overlayEl = document.getElementById("overlay");
const closeDrawerBtnEl = document.getElementById("closeDrawerBtn");
const newChatBtnEl = document.getElementById("newChatBtn");
const chatListEl = document.getElementById("chatList");
const profileBtnEl = document.getElementById("profileBtn");
const profileModalEl = document.getElementById("profileModal");
const closeProfileBtnEl = document.getElementById("closeProfileBtn");
const profileResponseStyleEl = document.getElementById("profileResponseStyle");
const profileNameEl = document.getElementById("profileName");
const profileJobEl = document.getElementById("profileJob");
const profileSystemPromptEl = document.getElementById("profileSystemPrompt");
const saveProfileBtnEl = document.getElementById("saveProfileBtn");
const topbarTitleEl = document.getElementById("topbarTitle");
const modelPickerBtnEl = document.getElementById("modelPickerBtn");
const modelMenuEl = document.getElementById("modelMenu");
const modelQuickBtnEl = document.getElementById("modelQuickBtn");
const modelQuickMenuEl = document.getElementById("modelQuickMenu");
const modelQuickRangeEl = document.getElementById("modelQuickRange");
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

let chats = [];
let activeChatId = null;
let currentProfile = { ...DEFAULT_PROFILE };
let currentTheme = "auto";
let isSending = false;
let pendingDeleteChatId = null;
let selectedModelId = readStoredModel();
let appInitialized = false;

function nowTs() { return Date.now(); }
function readStoredModel() {
  try {
    const stored = localStorage.getItem(MODEL_STORAGE_KEY);
    return MODEL_OPTIONS.some((option) => option.id === stored) ? stored : DEFAULT_MODEL_ID;
  } catch {
    return DEFAULT_MODEL_ID;
  }
}
function getSelectedModel() {
  return MODEL_OPTIONS.find((option) => option.id === selectedModelId) || MODEL_OPTIONS.find((option) => option.id === DEFAULT_MODEL_ID);
}
function getProviderForModel(modelId) {
  return MODEL_PROVIDERS.find((provider) => provider.models.some((model) => model.id === modelId)) || MODEL_PROVIDERS[0];
}
function persistSelectedModel() {
  try { localStorage.setItem(MODEL_STORAGE_KEY, selectedModelId); } catch { /* localStorage may be unavailable */ }
}
function setSelectedModel(modelId, persist = false) {
  const option = MODEL_OPTIONS.find((item) => item.id === modelId) || MODEL_OPTIONS.find((item) => item.id === DEFAULT_MODEL_ID);
  const provider = getProviderForModel(option.id);
  selectedModelId = option.id;
  if (topbarTitleEl) topbarTitleEl.textContent = provider.label;
  if (modelPickerBtnEl) modelPickerBtnEl.title = provider.label;
  if (modelQuickBtnEl) modelQuickBtnEl.title = `${provider.label}: ${option.label}`;
  if (modelMenuEl) {
    modelMenuEl.querySelectorAll("[data-provider]").forEach((button) => {
      const isSelected = button.dataset.provider === provider.id;
      button.setAttribute("aria-selected", String(isSelected));
    });
  }
  if (modelQuickMenuEl) {
    modelQuickMenuEl.querySelectorAll("[data-model]").forEach((button) => {
      const isSelected = button.dataset.model === selectedModelId;
      button.setAttribute("aria-selected", String(isSelected));
    });
  }
  if (persist) persistSelectedModel();
}
function closeModelMenu() {
  if (modelMenuEl) {
    modelMenuEl.classList.remove("open");
    modelMenuEl.hidden = true;
  }
  if (modelPickerBtnEl) modelPickerBtnEl.setAttribute("aria-expanded", "false");
}
function openModelMenu() {
  if (!modelMenuEl) return;
  closeModelQuickMenu();
  modelMenuEl.hidden = false;
  modelMenuEl.classList.add("open");
  if (modelPickerBtnEl) modelPickerBtnEl.setAttribute("aria-expanded", "true");
}
function toggleModelMenu() {
  if (modelMenuEl && modelMenuEl.classList.contains("open")) closeModelMenu();
  else openModelMenu();
}
function closeModelQuickMenu() {
  if (modelQuickMenuEl) {
    modelQuickMenuEl.hidden = true;
    modelQuickMenuEl.classList.remove("open");
  }
  if (modelQuickBtnEl) modelQuickBtnEl.setAttribute("aria-expanded", "false");
}
function openModelQuickMenu() {
  if (!modelQuickMenuEl) return;
  closeModelMenu();
  renderModelQuickMenu();
  modelQuickMenuEl.hidden = false;
  modelQuickMenuEl.classList.add("open");
  if (modelQuickBtnEl) modelQuickBtnEl.setAttribute("aria-expanded", "true");
}
function toggleModelQuickMenu() {
  if (modelQuickMenuEl && modelQuickMenuEl.classList.contains("open")) closeModelQuickMenu();
  else openModelQuickMenu();
}
function renderModelMenu() {
  if (!modelMenuEl) return;
  modelMenuEl.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "model-menu-heading";
  heading.textContent = "مدل‌های گفتگو";
  modelMenuEl.appendChild(heading);
  MODEL_PROVIDERS.forEach((provider) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-option";
    button.dataset.provider = provider.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(provider.id === getProviderForModel(selectedModelId).id));

    const name = document.createElement("span");
    name.className = "model-option-name";
    name.textContent = provider.label;

    const modelCount = document.createElement("span");
    modelCount.className = "model-option-count";
    modelCount.textContent = provider.subtitle;

    const check = document.createElement("span");
    check.className = "model-option-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";

    button.appendChild(name);
    button.appendChild(modelCount);
    button.appendChild(check);
    button.addEventListener("click", () => {
      const currentProvider = getProviderForModel(selectedModelId);
      const nextModelId = currentProvider.id === provider.id
        ? selectedModelId
        : provider.models[0].id;
      setSelectedModel(nextModelId, true);
      renderModelQuickMenu();
      closeModelMenu();
    });
    modelMenuEl.appendChild(button);
  });
  setSelectedModel(selectedModelId);
}
function renderModelQuickMenu() {
  if (!modelQuickMenuEl || !modelQuickRangeEl) return;
  const provider = getProviderForModel(selectedModelId);
  const selectedIndex = Math.max(0, provider.models.findIndex((option) => option.id === selectedModelId));
  const maxIndex = Math.max(1, provider.models.length - 1);
  modelQuickRangeEl.max = String(maxIndex);
  modelQuickRangeEl.value = String(selectedIndex);
  modelQuickRangeEl.style.setProperty("--quick-progress", `${(selectedIndex / maxIndex) * 100}%`);
  modelQuickRangeEl.setAttribute("aria-valuetext", provider.models[selectedIndex]?.label || "");
}
function toNumber(value, fallback = nowTs()) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return null;
  return { role: message.role, content: String(message.content || "") };
}
function normalizeProfile(profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  return { name: String(source.name || ""), job: String(source.job || ""), systemPrompt: String(source.systemPrompt || ""), responseStyle: String(source.responseStyle || "") };
}
function normalizeTheme(theme) { return THEME_MODES.includes(theme) ? theme : "auto"; }
function normalizeConversation(conversation) {
  if (!conversation || typeof conversation !== "object") return null;
  const messages = Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage).filter(Boolean) : [];
  return { id: String(conversation.id || `${nowTs()}`), title: String(conversation.title || "گفت‌وگوی جدید"), messages, createdAt: toNumber(conversation.createdAt), updatedAt: toNumber(conversation.updatedAt) };
}
function normalizeConversationSummary(conversation) {
  if (!conversation || typeof conversation !== "object") return null;
  return { id: String(conversation.id || `${nowTs()}`), title: String(conversation.title || "گفت‌وگوی جدید"), messages: [], createdAt: toNumber(conversation.createdAt), updatedAt: toNumber(conversation.updatedAt) };
}
function sortChats() {
  chats.sort((a, b) => {
    const diff = toNumber(b.updatedAt, 0) - toNumber(a.updatedAt, 0);
    if (diff !== 0) return diff;
    return toNumber(b.createdAt, 0) - toNumber(a.createdAt, 0);
  });
}
async function apiRequest(path, options = {}) {
  const init = {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  };
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    showPinGate();
    const error = new Error("Authentication required");
    error.status = 401;
    error.data = data;
    throw error;
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
function getProfile() { return { ...currentProfile }; }
function setProfile(profile) { currentProfile = normalizeProfile(profile); }
function getResolvedTheme(theme) {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return mediaQuery && mediaQuery.matches ? "dark" : "light";
}
function applyTheme(theme, persist = false) {
  const nextTheme = normalizeTheme(theme);
  const resolvedTheme = getResolvedTheme(nextTheme);
  currentTheme = nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.dataset.resolvedTheme = resolvedTheme;
  if (themeToggleEl) { themeToggleEl.dataset.theme = nextTheme; themeToggleEl.setAttribute("aria-label", `تم: ${nextTheme}`); themeToggleEl.title = `تم: ${nextTheme}`; }
  if (persist) { apiRequest("/api/theme", { method: "PATCH", body: JSON.stringify({ theme: nextTheme }) }).catch(console.error); }
}
function cycleTheme() {
  const currentIndex = THEME_MODES.indexOf(currentTheme);
  const nextTheme = THEME_MODES[(currentIndex + 1) % THEME_MODES.length];
  applyTheme(nextTheme, true);
}
function buildSystemPrompt() {
  const profile = getProfile();
  const parts = ["You are a precise, helpful, and friendly Persian-language assistant.", "Write answers clearly, practically, and in an organized manner whenever possible."];
  if (profile.name) parts.push(`User name: ${profile.name}`);
  if (profile.job) parts.push(`User role: ${profile.job}`);
  if (profile.systemPrompt) parts.push(`User custom instructions: ${profile.systemPrompt}`);
  if (profile.responseStyle) parts.push(`Preferred response style: ${profile.responseStyle}`);
  return parts.join("\n");
}
function getActiveChat() { return chats.find((chat) => chat.id === activeChatId) || null; }
function upsertConversation(conversation, preserveExistingMessages = true) {
  const normalized = normalizeConversation(conversation);
  if (!normalized) return null;
  const index = chats.findIndex((item) => item.id === normalized.id);
  if (index === -1) { chats.unshift(normalized); } else {
    const existing = chats[index];
    chats[index] = { ...existing, ...normalized, messages: normalized.messages.length > 0 || !preserveExistingMessages ? normalized.messages : existing.messages || [] };
  }
  sortChats();
  return normalized;
}
async function loadConversationDetail(conversationId) {
  if (!conversationId) return null;
  const existing = getActiveChat();
  if (existing && existing.id === String(conversationId) && existing.messages.length > 0) return existing;
  const data = await apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}`);
  return upsertConversation(data.conversation || data, true);
}
async function syncActiveConversationId(conversationId) {
  if (!conversationId) return;
  await apiRequest("/api/state", { method: "PATCH", body: JSON.stringify({ activeConversationId: String(conversationId) }) });
}
async function createChat(title = "گفت‌وگوی جدید") {
  const data = await apiRequest("/api/conversations", { method: "POST", body: JSON.stringify({}) });
  const conversation = data.conversation || data;
  upsertConversation(conversation, false);
  activeChatId = String(conversation.id);
  await syncActiveConversationId(activeChatId);
  renderChatList();
  renderActiveChat();
  return conversation;
}
async function ensureActiveChat() {
  let chat = getActiveChat();
  if (!chat) {
    if (chats.length > 0) { activeChatId = chats[0].id; await syncActiveConversationId(activeChatId).catch(console.error); chat = getActiveChat(); } else { chat = await createChat(); }
  }
  if (chat && (!chat.messages || chat.messages.length === 0)) { await loadConversationDetail(chat.id).catch(console.error); chat = getActiveChat(); }
  return chat;
}
async function setActiveChat(chatId) {
  activeChatId = String(chatId);
  renderChatList();
  renderActiveChat();
  closeDrawer();
  await syncActiveConversationId(activeChatId);
  await loadConversationDetail(activeChatId);
  renderChatList();
  renderActiveChat();
}
function showDeleteConfirmModal(chatId) {
  pendingDeleteChatId = chatId;
  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.add("show");
  openOverlay();
}
function closeDeleteConfirmModal() {
  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.remove("show");
  closeOverlayIfIdle();
  pendingDeleteChatId = null;
}
async function confirmDeleteChat() {
  if (!pendingDeleteChatId) return;
  await deleteChat(pendingDeleteChatId);
  closeDeleteConfirmModal();
}
async function deleteChat(chatId) {
  const id = String(chatId);
  const index = chats.findIndex((chat) => chat.id === id);
  if (index === -1) return;
  await apiRequest(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  chats.splice(index, 1);
  if (activeChatId === id) { activeChatId = chats[0] ? chats[0].id : null; if (activeChatId) await syncActiveConversationId(activeChatId).catch(console.error); }
  if (chats.length === 0) { await createChat(); return; }
  renderChatList();
  renderActiveChat();
}
async function updateChatTitle(chatId, title) {
  const id = String(chatId);
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  const cleanTitle = String(title || "").trim() || "گفت‌وگوی جدید";
  const data = await apiRequest(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: cleanTitle }) });
  upsertConversation(data.conversation || data, false);
  renderChatList();
  renderActiveChat();
}
function updateChatTitleFromFirstMessage(chat) {
  if (!chat || chat.title !== "گفت‌وگوی جدید") return;
  const firstUserMessage = chat.messages.find((message) => message.role === "user");
  if (!firstUserMessage) return;
  const raw = String(firstUserMessage.content || "").trim();
  const title = raw.replace(/\s+/g, " ");
  chat.title = title.slice(0, 36) || "گفت‌وگوی جدید";
}
function openOverlay() { if (overlayEl) overlayEl.classList.add("show"); }
function closeOverlayIfIdle() {
  const drawerOpen = drawerEl && drawerEl.classList.contains("open");
  const profileOpen = profileModalEl && profileModalEl.classList.contains("show");
  const deleteConfirmOpen = document.getElementById("deleteConfirmModal") && document.getElementById("deleteConfirmModal").classList.contains("show");
  if (!drawerOpen && !profileOpen && !deleteConfirmOpen && overlayEl) overlayEl.classList.remove("show");
}
function openDrawer() { if (drawerEl) drawerEl.classList.add("open"); openOverlay(); }
function closeDrawer() { if (drawerEl) drawerEl.classList.remove("open"); closeOverlayIfIdle(); }
function openProfileModal() {
  const profile = getProfile();
  if (profileResponseStyleEl) profileResponseStyleEl.value = profile.responseStyle;
  if (profileNameEl) profileNameEl.value = profile.name;
  if (profileJobEl) profileJobEl.value = profile.job;
  if (profileSystemPromptEl) profileSystemPromptEl.value = profile.systemPrompt;
  if (profileModalEl) profileModalEl.classList.add("show");
  openOverlay();
}
function closeProfileModal() { if (profileModalEl) profileModalEl.classList.remove("show"); closeOverlayIfIdle(); }
function autoResizeTextarea() {
  if (!userInputEl) return;
  userInputEl.style.height = "auto";
  userInputEl.style.height = `${userInputEl.scrollHeight}px`;
}
function scrollToBottom() { requestAnimationFrame(() => { if (chatMainEl) chatMainEl.scrollTop = chatMainEl.scrollHeight; }); }
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html;
}
function renderMarkdownToHtml(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let inCodeBlock = false;
  let codeLines = [];
  let inList = false;
  function closeList() { if (inList) { html.push("</ul>"); inList = false; } }
  function closeCodeBlock() { html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`); codeLines = []; inCodeBlock = false; }
  function isMarkdownTableSeparator(line) { return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim()); }
  function splitMarkdownTableRow(line) { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }
  function renderMarkdownTable(sourceLines, startIndex) {
    const headerCells = splitMarkdownTableRow(sourceLines[startIndex]);
    let index = startIndex + 2;
    const rows = [];
    while (index < sourceLines.length && sourceLines[index].trim().startsWith("|")) { rows.push(splitMarkdownTableRow(sourceLines[index])); index += 1; }
    const header = headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("");
    const body = rows.map((row) => { const cells = headerCells.map((_, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] || "")}</td>`).join(""); return `<tr>${cells}</tr>`; }).join("");
    return { html: `<div class="markdown-table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`, nextIndex: index };
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) { if (inCodeBlock) { closeCodeBlock(); } else { closeList(); inCodeBlock = true; codeLines = []; } continue; }
    if (inCodeBlock) { codeLines.push(line); continue; }
    if (index + 1 < lines.length && trimmed.includes("|") && isMarkdownTableSeparator(lines[index + 1])) {
      closeList();
      const table = renderMarkdownTable(lines, index);
      html.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }
    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) { closeList(); html.push("<hr>"); continue; }
    if (!trimmed) {
      closeList();
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      closeList();
      const level = Math.min(trimmed.match(/^#+/)[0].length, 6);
      const content = trimmed.replace(/^#{1,6}\s+/, "");
      html.push(`<h${level}>${renderInlineMarkdown(content)}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${renderInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  if (inCodeBlock) closeCodeBlock();
  closeList();
  return html.join("");
}
function isLatexOnly(text) { const value = String(text || "").trim(); return /^\$\$[\s\S]+\$\$$/.test(value) || /^\\\[[\s\S]+\\\]$/.test(value) || /^\\\([\s\S]+\\\)$/.test(value); }
function normalizeLatex(text) { return String(text || "").replace(/\\\[/g, "$$").replace(/\\\]/g, "$$").replace(/\\\(/g, "$").replace(/\\\)/g, "$"); }
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    if (button) {
      const previousLabel = button.getAttribute("aria-label") || "کپی";
      button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
      setTimeout(() => {
        button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
      }, 1200);
    }
  } catch (error) { console.error("Copy failed:", error); }
}
function createCopyButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-btn icon-only";
  button.setAttribute("aria-label", "کپی");
  button.title = "کپی";
  button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
  button.addEventListener("click", () => copyText(text, button));
  return button;
}
function createRegenerateButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-btn icon-only";
  button.setAttribute("aria-label", "تولید مجدد");
  button.title = "تولید مجدد";
  button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M12 4V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"></path></svg>`;
  button.addEventListener("click", () => regenerateLastReply());
  return button;
}
function createIconButton(label, svgPath) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-btn icon-only";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="${svgPath}"></path></svg>`;
  return button;
}
function renderUserMessage(msg) {
  if (!messagesSectionEl) return;
  const wrapper = document.createElement("div");
  wrapper.className = "message user-wrap";
  const bubble = document.createElement("div");
  bubble.className = "message user";
  bubble.textContent = String(msg.content || "");
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "message-actions-overlay";
  actionsDiv.appendChild(createCopyButton(msg.content));
  const editBtn = createIconButton("ویرایش", "M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z");
  editBtn.addEventListener("click", () => {
     const chat = getActiveChat();
     if(!chat) return;
     const index = chat.messages.indexOf(msg);
     if(index === -1) return;
     const wrapperClone = wrapper.cloneNode(true);
     const textarea = document.createElement("textarea");
     textarea.className = "composer-input";
     textarea.value = msg.content;
     textarea.style.width = "100%";
     textarea.style.padding = "12px 16px";
     textarea.style.borderRadius = "20px";
     textarea.style.border = "1px solid var(--composer-border)";
     textarea.style.background = "var(--composer-bg)";
     textarea.style.color = "var(--text-color)";
     textarea.style.fontSize = "16px";
     textarea.style.resize = "none";
     textarea.style.marginBottom = "8px";
     textarea.rows = 3;
     const saveBtn = document.createElement("button");
     saveBtn.textContent = "ذخیره";
     saveBtn.className = "primary-btn";
     saveBtn.style.minHeight = "30px";
     saveBtn.style.padding = "4px 16px";
     saveBtn.style.fontSize = "13px";
     const cancelBtn = document.createElement("button");
     cancelBtn.textContent = "لغو";
     cancelBtn.className = "primary-btn";
     cancelBtn.style.background = "transparent";
     cancelBtn.style.color = "var(--text-color)";
     cancelBtn.style.minHeight = "30px";
     cancelBtn.style.padding = "4px 16px";
     cancelBtn.style.fontSize = "13px";
     const btnWrapper = document.createElement("div");
     btnWrapper.style.display = "flex";
     btnWrapper.style.gap = "8px";
     btnWrapper.style.justifyContent = "flex-end";
     btnWrapper.appendChild(cancelBtn);
     btnWrapper.appendChild(saveBtn);
     wrapperClone.innerHTML = "";
     wrapperClone.appendChild(textarea);
     wrapperClone.appendChild(btnWrapper);
     const parent = messagesSectionEl;
     const oldNode = wrapper;
     parent.replaceChild(wrapperClone, oldNode);
     textarea.focus();
     textarea.style.height = "auto";
     textarea.style.height = textarea.scrollHeight + "px";
     textarea.oninput = () => { textarea.style.height = "auto"; textarea.style.height = textarea.scrollHeight + "px"; };
     cancelBtn.onclick = () => { renderActiveChat(); };
     saveBtn.onclick = async () => {
       const newContent = textarea.value.trim();
       if(!newContent) return;
       chat.messages[index].content = newContent;
       await saveConversationMessages(chat.id, chat.messages, chat.title);
       renderActiveChat();
       await regenerateLastReply(index);
     };
  });
  actionsDiv.appendChild(editBtn);
  wrapper.appendChild(bubble);
  wrapper.appendChild(actionsDiv);
  return wrapper;
}
function renderMessages(messages) {
  if (!messagesSectionEl) return;
  messagesSectionEl.innerHTML = "";
  const groups = new Map();
  const orderedGroups = [];
  let lastUserMsgId = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      msg._id = msg._id || `${nowTs()}_${i}`;
      let group = groups.get(msg._id);
      if (!group) {
        group = { id: msg._id, user: msg, versions: [] };
        groups.set(msg._id, group);
        orderedGroups.push(group);
      } else {
        group.user = msg;
      }
      lastUserMsgId = msg._id;
    } else if (msg.role === "assistant") {
      let parentId = msg._parentId || lastUserMsgId;
      if (!parentId) {
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === "user") {
            parentId = messages[j]._id || `${nowTs()}_${j}`;
            break;
          }
        }
      }
      if (parentId) {
        let group = groups.get(parentId);
        if (!group) {
          group = { id: parentId, user: null, versions: [] };
          groups.set(parentId, group);
          orderedGroups.push(group);
        }
        group.versions.push(msg);
      }
    }
  }
  for (const group of orderedGroups) {
    if (group.user) {
      messagesSectionEl.appendChild(renderUserMessage(group.user));
    }
    if (group.versions.length > 0) {
      const versions = group.versions;
      const total = versions.length;
      const currentIndex = total - 1;
      const currentMsg = versions[currentIndex];
      const wrapper = document.createElement("div");
      wrapper.className = "message assistant-wrap";
      wrapper.dataset.parent = group.id;
      wrapper.dataset.currentVersion = currentIndex;
      const content = document.createElement("div");
      content.className = "assistant-content";
      const messageText = String(currentMsg.content || "");
      const normalized = normalizeLatex(messageText);
      if (isLatexOnly(messageText)) { content.textContent = normalized; } else { content.innerHTML = renderMarkdownToHtml(normalized); }
      wrapper.appendChild(content);
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "message-actions-overlay";
      actionsDiv.appendChild(createCopyButton(messageText));
      actionsDiv.appendChild(createRegenerateButton());
      wrapper.appendChild(actionsDiv);
      if (total > 1) {
        const paginationDiv = document.createElement("div");
        paginationDiv.className = "message-version-pagination";
        const prevBtn = document.createElement("button");
        prevBtn.textContent = "<";
        prevBtn.disabled = currentIndex === 0;
        const nextBtn = document.createElement("button");
        nextBtn.textContent = ">";
        nextBtn.disabled = currentIndex === total - 1;
        const counterSpan = document.createElement("span");
        counterSpan.textContent = `${currentIndex + 1} / ${total}`;
        const updateVersion = (idx) => {
          wrapper.dataset.currentVersion = idx;
          const targetMsg = versions[idx];
          const newText = String(targetMsg.content || "");
          const newNorm = normalizeLatex(newText);
          if (isLatexOnly(newText)) { content.textContent = newNorm; } else { content.innerHTML = renderMarkdownToHtml(newNorm); }
          actionsDiv.innerHTML = "";
          actionsDiv.appendChild(createCopyButton(newText));
          const regenBtn = createRegenerateButton();
          regenBtn.addEventListener("click", () => regenerateLastReply());
          actionsDiv.appendChild(regenBtn);
          prevBtn.disabled = idx === 0;
          nextBtn.disabled = idx === total - 1;
          counterSpan.textContent = `${idx + 1} / ${total}`;
          try {
            if (typeof renderMathInElement === "function") {
              renderMathInElement(content, { delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }, { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }], throwOnError: false });
            }
          } catch (error) { console.error(error); }
        };
        prevBtn.addEventListener("click", () => updateVersion(currentIndex - 1));
        nextBtn.addEventListener("click", () => updateVersion(currentIndex + 1));
        paginationDiv.appendChild(prevBtn);
        paginationDiv.appendChild(counterSpan);
        paginationDiv.appendChild(nextBtn);
        wrapper.appendChild(paginationDiv);
      }
      messagesSectionEl.appendChild(wrapper);
      try {
        if (typeof renderMathInElement === "function") {
          renderMathInElement(content, { delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }, { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }], throwOnError: false });
        }
      } catch (error) { console.error(error); }
    }
  }
  scrollToBottom();
}
function renderActiveChat() {
  const chat = getActiveChat();
  const hasMessages = chat && Array.isArray(chat.messages) && chat.messages.length > 0;
  if (emptyStateEl) emptyStateEl.style.display = hasMessages ? "none" : "";
  if (messagesSectionEl) messagesSectionEl.style.display = hasMessages ? "" : "none";
  renderMessages(chat ? chat.messages : []);
}
function renderChatList() {
  if (!chatListEl) return;
  chatListEl.innerHTML = "";
  for (const chat of chats) {
    chatListEl.appendChild(createChatItem(chat));
  }
}
function createChatItem(chat) {
  const item = document.createElement("div");
  item.className = "chat-item";
  if (chat.id === activeChatId) item.classList.add("active");
  const chatButton = document.createElement("button");
  chatButton.type = "button";
  chatButton.className = "chat-item-btn";
  chatButton.textContent = chat.title || "گفت‌وگوی جدید";
  chatButton.addEventListener("click", () => { void setActiveChat(chat.id); });
  const dropdownContainer = document.createElement("div");
  dropdownContainer.className = "chat-item-actions-dropdown";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "dropdown-menu-btn";
  toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  const renameItem = document.createElement("button");
  renameItem.className = "dropdown-item";
  renameItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span>ویرایش عنوان</span>`;
  renameItem.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.classList.remove("show");
    const input = document.createElement("input");
    input.className = "chat-item-input";
    input.value = chat.title || "";
    const finish = (commit) => { if (commit) { void updateChatTitle(chat.id, input.value); } else { renderChatList(); } };
    input.addEventListener("keydown", (keyboardEvent) => { if (keyboardEvent.key === "Enter") finish(true); if (keyboardEvent.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
    item.innerHTML = "";
    item.appendChild(input);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
  const deleteItem = document.createElement("button");
  deleteItem.className = "dropdown-item danger";
  deleteItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>حذف</span>`;
  deleteItem.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.classList.remove("show");
    showDeleteConfirmModal(chat.id);
  });
  const toggleMenu = (event) => {
    event.stopPropagation();
    const isOpen = menu.classList.contains("show");
    document.querySelectorAll(".dropdown-menu.show").forEach(m => m.classList.remove("show"));
    if(!isOpen) {
      menu.classList.add("show");
      const rect = toggleBtn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 200) {
        menu.classList.add("open-up");
        menu.classList.remove("open-down");
      } else {
        menu.classList.add("open-down");
        menu.classList.remove("open-up");
      }
    }
  };
  document.addEventListener("click", (e) => {
    if (!dropdownContainer.contains(e.target)) {
      menu.classList.remove("show");
    }
  });
  toggleBtn.addEventListener("click", toggleMenu);
  menu.appendChild(renameItem);
  const divider = document.createElement("hr");
  divider.style.cssText = "border: 0; border-top: 1px solid var(--border-color); margin: 4px 0;";
  menu.appendChild(divider);
  menu.appendChild(deleteItem);
  dropdownContainer.appendChild(toggleBtn);
  dropdownContainer.appendChild(menu);
  item.appendChild(chatButton);
  item.appendChild(dropdownContainer);
  return item;
}
function updateSendingState(value) {
  isSending = value;
  if (sendBtnEl) sendBtnEl.disabled = value;
  if (userInputEl) userInputEl.disabled = value;
  if (modelQuickBtnEl) modelQuickBtnEl.disabled = value;
}
function showLoadingIndicator(userMsgId) {
  if (!messagesSectionEl) return;
  const existing = document.querySelector(`.message.assistant-wrap[data-parent="${userMsgId}"]`);
  if (existing) existing.remove();
  const indicator = document.createElement("div");
  indicator.className = "message assistant-wrap loading-indicator";
  indicator.dataset.parent = userMsgId;
  indicator.innerHTML = `<div class="loading-dots" role="status" aria-label="در حال دریافت پاسخ"><span></span><span></span><span></span></div>`;
  const messages = Array.from(messagesSectionEl.children);
  let insertAfter = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const el = messages[i];
    if (el.classList.contains("message") && el.dataset.parent === userMsgId) {
        insertAfter = el;
        break;
    }
  }
  if (insertAfter) {
    insertAfter.after(indicator);
  } else {
    messagesSectionEl.appendChild(indicator);
  }
  scrollToBottom();
}
function hideLoadingIndicator() {
  const indicators = document.querySelectorAll(".loading-indicator");
  indicators.forEach(el => el.remove());
}
function extractAssistantContent(data) {
  if (!data || typeof data !== "object") return "";
  const choices = data.choices;
  if (Array.isArray(choices) && choices[0] && choices[0].message) { return String(choices[0].message.content || "").trim(); }
  for (const key of ["content", "text", "answer", "response"]) { if (typeof data[key] === "string" && data[key].trim()) return data[key].trim(); }
  if (typeof data.raw === "string" && data.raw.trim()) return data.raw.trim();
  return "";
}
async function requestAssistantReply(messages, model = selectedModelId) {
  const response = await apiRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify({ model, messages: [{ role: "system", content: buildSystemPrompt() }, ...messages.map((message) => ({ role: message.role, content: String(message.content || "") }))] })
  });
  return response;
}
async function saveConversationMessages(chatId, messages, title) {
  const payload = { messages: messages.map((message) => ({ role: message.role, content: String(message.content || "") })) };
  if (title) payload.title = title;
  const data = await apiRequest(`/api/conversations/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify(payload) });
  upsertConversation(data.conversation || data, false);
  renderChatList();
  renderActiveChat();
}
async function sendMessage(promptOverride = null) {
  if (isSending) return;
  let chat = await ensureActiveChat();
  if (!chat) return;
  const rawText = typeof promptOverride === "string" && promptOverride.length > 0 ? promptOverride : userInputEl ? userInputEl.value : "";
  const text = String(rawText || "").trim();
  if (!text) return;
  updateSendingState(true);
  if (sendBtnEl) {
    sendBtnEl.disabled = true;
    sendBtnEl.innerHTML = `<div class="spinner"></div>`;
    sendBtnEl.style.display = "flex";
    sendBtnEl.style.alignItems = "center";
    sendBtnEl.style.justifyContent = "center";
  }
  const tempUserMsgId = `${nowTs()}`;
  const tempUserMsg = { role: "user", content: text, _id: tempUserMsgId };
  chat.messages.push(tempUserMsg);
  renderActiveChat();
  if (userInputEl) { userInputEl.value = ""; autoResizeTextarea(); }
  try {
    const data = await apiRequest(`/api/conversations/${encodeURIComponent(chat.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text, model: selectedModelId })
    });
    const updatedConversation = data.conversation || data;
    upsertConversation(updatedConversation, false);
    activeChatId = String(updatedConversation.id || chat.id);
    renderChatList();
    renderActiveChat();
  } catch (error) {
    console.error("sendMessage failed:", error);
    if (userInputEl) userInputEl.value = text;
    alert("خطا در ارسال پیام: " + (error.message || ""));
  } finally {
    updateSendingState(false);
    if (sendBtnEl) {
      sendBtnEl.disabled = false;
      sendBtnEl.innerHTML = `<svg viewBox="0 0 24 24" class="icon-send" aria-hidden="true"><path d="M12 19V5m0 0 6 6m-6-6-6 6" /></svg>`;
      sendBtnEl.style.display = "";
      sendBtnEl.style.alignItems = "";
      sendBtnEl.style.justifyContent = "";
    }
    if (userInputEl) userInputEl.focus();
  }
}
async function regenerateLastReply(userMsgIndex = null) {
  if (isSending) return;
  const chat = await ensureActiveChat();
  if (!chat) return;
  let lastUserIndex = -1;
  let userMsgId = null;
  if (userMsgIndex !== null && userMsgIndex >= 0 && userMsgIndex < chat.messages.length && chat.messages[userMsgIndex].role === "user") {
    lastUserIndex = userMsgIndex;
    userMsgId = chat.messages[lastUserIndex]._id || `${nowTs()}_${lastUserIndex}`;
    chat.messages[lastUserIndex]._id = userMsgId;
  } else {
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) { if (chat.messages[index].role === "user") { lastUserIndex = index; break; } }
    if (lastUserIndex === -1) return;
    userMsgId = chat.messages[lastUserIndex]._id || `${nowTs()}_${lastUserIndex}`;
    chat.messages[lastUserIndex]._id = userMsgId;
  }
  const truncatedMessages = chat.messages.slice(0, lastUserIndex + 1);
  chat.messages = chat.messages.filter((m, i) => i <= lastUserIndex || (m.role !== "assistant"));
  showLoadingIndicator(userMsgId);
  updateSendingState(true);
  try {
    const response = await requestAssistantReply(truncatedMessages);
    const assistantReply = extractAssistantContent(response) || "پاسخی دریافت نشد.";
    chat.messages.push({ role: "assistant", content: assistantReply, _parentId: userMsgId });
    if (!chat.title || chat.title === "گفت‌وگوی جدید") updateChatTitleFromFirstMessage(chat);
    await saveConversationMessages(chat.id, chat.messages, chat.title);
    renderChatList();
    renderActiveChat();
  } catch (error) { console.error(error); } finally {
    updateSendingState(false);
    hideLoadingIndicator();
    if (userInputEl) userInputEl.focus();
  }
}
async function handleNewChat() {
  const chat = getActiveChat();
  if (chat && chat.messages && chat.messages.length === 0) {
    closeDrawer();
    if (userInputEl) userInputEl.focus();
    return;
  }
  await createChat();
  closeDrawer();
  if (userInputEl) userInputEl.focus();
}
function handleOverlayClick() {
  closeModelMenu();
  closeModelQuickMenu();
  closeDrawer();
  closeProfileModal();
  closeDeleteConfirmModal();
}
async function saveProfile() {
  const profile = { name: profileNameEl ? profileNameEl.value.trim() : "", job: profileJobEl ? profileJobEl.value.trim() : "", systemPrompt: profileSystemPromptEl ? profileSystemPromptEl.value.trim() : "", responseStyle: profileResponseStyleEl ? profileResponseStyleEl.value.trim() : "" };
  const data = await apiRequest("/api/profile", { method: "PATCH", body: JSON.stringify(profile) });
  setProfile(data.profile || profile);
}
async function initializeState() {
  if (appInitialized) return;
  appInitialized = true;
  applyTheme("auto", false);
  const state = await apiRequest("/api/state");
  setProfile(state.profile || {});
  applyTheme(state.theme || "auto", false);
  chats = Array.isArray(state.conversations) ? state.conversations.map(normalizeConversationSummary).filter(Boolean) : [];
  sortChats();
  activeChatId = state.activeConversationId ? String(state.activeConversationId) : chats[0] ? chats[0].id : null;
  if (!activeChatId) { const created = await createChat(); activeChatId = String(created.id); } else { await loadConversationDetail(activeChatId).catch(console.error); }
  renderChatList();
  renderActiveChat();
  autoResizeTextarea();
}

/* ----------------------------------------------------------------------- */
/* Auth (PIN)                                                               */
/* ----------------------------------------------------------------------- */
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    const data = await res.json();
    return !!(data && data.authenticated);
  } catch {
    return false;
  }
}
function showPinGate() {
  if (pinGateEl) pinGateEl.setAttribute("aria-hidden", "false");
  if (appEl) appEl.setAttribute("aria-hidden", "true");
  if (pinInputEl) pinInputEl.focus();
}
function hidePinGate() {
  if (pinGateEl) pinGateEl.setAttribute("aria-hidden", "true");
  if (appEl) appEl.setAttribute("aria-hidden", "false");
}
async function submitPin(pin) {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ pin }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
if (pinFormEl) {
  pinFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pin = pinInputEl ? pinInputEl.value.trim() : "";
    if (!pin) return;
    if (pinErrorEl) pinErrorEl.hidden = true;
    const ok = await submitPin(pin);
    if (ok) {
      hidePinGate();
      if (pinInputEl) pinInputEl.value = "";
      await initializeState();
    } else {
      if (pinErrorEl) pinErrorEl.hidden = false;
      if (pinInputEl) {
        pinInputEl.value = "";
        pinInputEl.focus();
      }
    }
  });
}

/* ----------------------------------------------------------------------- */
/* Boot                                                                     */
/* ----------------------------------------------------------------------- */
if (sendBtnEl) sendBtnEl.addEventListener("click", (event) => { event.preventDefault(); void sendMessage(); });
if (modelQuickBtnEl) modelQuickBtnEl.addEventListener("click", (event) => { event.stopPropagation(); toggleModelQuickMenu(); });
if (modelQuickRangeEl) {
  modelQuickRangeEl.addEventListener("input", () => {
    const provider = getProviderForModel(selectedModelId);
    const index = Math.min(provider.models.length - 1, Math.max(0, Number(modelQuickRangeEl.value) || 0));
    modelQuickRangeEl.style.setProperty("--quick-progress", `${(index / Math.max(1, provider.models.length - 1)) * 100}%`);
    modelQuickRangeEl.setAttribute("aria-valuetext", provider.models[index]?.label || "");
  });
  modelQuickRangeEl.addEventListener("change", () => {
    const provider = getProviderForModel(selectedModelId);
    const index = Math.min(provider.models.length - 1, Math.max(0, Number(modelQuickRangeEl.value) || 0));
    const nextModelId = provider.models[index].id;
    if (nextModelId === selectedModelId) return;
    setSelectedModel(nextModelId, true);
    renderModelQuickMenu();
  });
}
if (userInputEl) userInputEl.addEventListener("input", autoResizeTextarea);
if (modelPickerBtnEl) modelPickerBtnEl.addEventListener("click", (event) => { event.stopPropagation(); toggleModelMenu(); });
if (menuBtnEl) menuBtnEl.addEventListener("click", openDrawer);
if (closeDrawerBtnEl) closeDrawerBtnEl.addEventListener("click", closeDrawer);
if (overlayEl) overlayEl.addEventListener("click", handleOverlayClick);
if (newChatBtnEl) newChatBtnEl.onclick = () => { void handleNewChat(); };
if (profileBtnEl) profileBtnEl.addEventListener("click", openProfileModal);
if (closeProfileBtnEl) closeProfileBtnEl.addEventListener("click", closeProfileModal);
if (saveProfileBtnEl) saveProfileBtnEl.addEventListener("click", () => { void saveProfile().then(() => closeProfileModal()).catch(console.error); });
if (themeToggleEl) themeToggleEl.addEventListener("click", cycleTheme);
if (mediaQuery) {
  const onThemeChange = () => { if (currentTheme === "auto") applyTheme("auto", false); };
  if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", onThemeChange);
  else if (mediaQuery.addListener) mediaQuery.addListener(onThemeChange);
}
document.addEventListener("click", (event) => {
  if (modelMenuEl && modelPickerBtnEl && !modelMenuEl.contains(event.target) && !modelPickerBtnEl.contains(event.target)) closeModelMenu();
  if (modelQuickMenuEl && modelQuickBtnEl && !modelQuickMenuEl.contains(event.target) && !modelQuickBtnEl.contains(event.target)) closeModelQuickMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModelMenu();
    closeModelQuickMenu();
  }
});

const deleteConfirmModalHTML = `
<div id="deleteConfirmModal" class="modal" aria-hidden="true">
  <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="deleteConfirmTitle">
    <div class="modal-header">
      <h2 id="deleteConfirmTitle">حذف گفت‌وگو</h2>
      <button type="button" id="closeDeleteConfirmBtn" class="icon-btn" aria-label="بستن پنجره">
        <svg viewBox="0 0 24 24" class="icon-close" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <div class="modal-body">
      <p>آیا از حذف این گفت‌وگو اطمینان دارید؟</p>
    </div>
    <div class="modal-footer" style="display: flex; gap: 12px; justify-content: flex-end;">
      <button type="button" id="cancelDeleteBtn" class="primary-btn" style="background: transparent; color: var(--text-color);">لغو</button>
      <button type="button" id="confirmDeleteBtn" class="primary-btn" style="background: #c94b4b;">حذف</button>
    </div>
  </div>
</div>
`;
document.body.insertAdjacentHTML("beforeend", deleteConfirmModalHTML);

document.getElementById("closeDeleteConfirmBtn").addEventListener("click", closeDeleteConfirmModal);
document.getElementById("cancelDeleteBtn").addEventListener("click", closeDeleteConfirmModal);
document.getElementById("confirmDeleteBtn").addEventListener("click", confirmDeleteChat);

renderModelMenu();
renderModelQuickMenu();
setSelectedModel(selectedModelId);

(async () => {
  const authed = await checkAuth();
  if (authed) {
    hidePinGate();
    await initializeState();
  } else {
    showPinGate();
  }
})();
