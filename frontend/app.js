const DEFAULT_PROFILE = { name: "", job: "", systemPrompt: "", responseStyle: "" };
const DEFAULT_MODEL_ID = "gpt-5.6-sol";
const MODEL_PROVIDERS = [
  {
    id: "gpt",
    label: "GPT",
    subtitle: "OpenAI",
    models: [
      { id: "gpt-5.6-luna", label: "Luna", strength: "سریع", tone: "weak" },
      { id: "gpt-5.6-terra", label: "Terra", strength: "متوسط", tone: "medium" },
      { id: "gpt-5.6-sol", label: "Sol", strength: "دقیق", tone: "strong", acceptsImages: true },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    subtitle: "Google",
    models: [
      { id: "gemini-3.1-flash-lite", label: "Flash Lite", strength: "سریع", tone: "weak" },
      { id: "gemini-3.6-flash", label: "Flash", strength: "متوسط", tone: "medium" },
      { id: "gemini-3.1-pro-preview", label: "Pro", strength: "دقیق", tone: "strong" },
    ],
  },
];
const MODEL_OPTIONS = MODEL_PROVIDERS.flatMap((provider) => provider.models);
const THEME_MODES = ["auto", "light", "dark"];

function getModelDisplayName(modelId) {
  const names = {
    "gpt-5.6-sol": "GPT 5.6 Sol",
    "gpt-5.6-terra": "GPT 5.6 Terra",
    "gpt-5.6-luna": "GPT 5.6 Luna",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  };
  return names[modelId] || "GPT 5.6 Sol";
}

const pinGateEl = document.getElementById("pinGate");
const pinFormEl = document.getElementById("pinForm");
const usernameInputEl = document.getElementById("usernameInput");
const passwordInputEl = document.getElementById("passwordInput");
const pinErrorEl = document.getElementById("pinError");
const appEl = document.getElementById("app");
const appToastEl = document.getElementById("appToast");

const emptyStateEl = document.getElementById("emptyState");
const messagesSectionEl = document.getElementById("messagesSection");
const chatMainEl = document.getElementById("chatMain");
const userInputEl = document.getElementById("userInput");
const sendBtnEl = document.getElementById("sendBtn");
const scrollToBottomBtnEl = document.getElementById("scrollToBottomBtn");

function applyDisplayMode() {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  document.documentElement.classList.toggle("standalone", isStandalone);
}
applyDisplayMode();
const themeToggleEl = document.getElementById("themeToggle");
const menuBtnEl = document.getElementById("menuBtn");
const drawerEl = document.getElementById("drawer");
const overlayEl = document.getElementById("overlay");
const closeDrawerBtnEl = document.getElementById("closeDrawerBtn");
const newChatBtnEl = document.getElementById("newChatBtn");
const chatListEl = document.getElementById("chatList");
const profileBtnEl = document.getElementById("profileBtn");
const topbarNewChatBtnEl = document.getElementById("topbarNewChatBtn");
const logoutBtnEl = document.getElementById("logoutBtn");
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
const modelSliderLabelsEl = document.getElementById("modelSliderLabels");
const attachImageBtnEl = document.getElementById("attachImageBtn");
const imageInputEl = document.getElementById("imageInput");
const attachmentMenuEl = document.getElementById("attachmentMenu");
const attachmentImageOptionEl = document.getElementById("attachmentImageOption");
const imagePreviewEl = document.getElementById("imagePreview");
const imagePreviewThumbEl = document.getElementById("imagePreviewThumb");
const removeImageBtnEl = document.getElementById("removeImageBtn");
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

let chats = [];
let activeChatId = null;
let currentProfile = { ...DEFAULT_PROFILE };
let currentTheme = "auto";
let isSending = false;
let pendingDeleteChatId = null;
let selectedModelId = DEFAULT_MODEL_ID;
let appInitialized = false;
let pendingImageDataUrl = "";
let scrollSentinelObserver = null;
let scrollSentinelEl = null;

function nowTs() { return Date.now(); }
function chatRouteId(chatOrId) {
  const id = typeof chatOrId === "object" ? chatOrId?.id : chatOrId;
  return String(id || "").replace(/\D/g, "") || "0";
}
function chatPath(chat) {
  if (!chat) return "/chat";
  return `/chat/${chatRouteId(chat)}`;
}
function syncChatUrl(chat, replace = false) {
  if (!window.history || !chat) return;
  const nextPath = chatPath(chat);
  if (window.location.pathname === nextPath) return;
  window.history[replace ? "replaceState" : "pushState"]({ chatId: chat.id }, "", nextPath);
}
function chatIdFromPath() {
  const match = window.location.pathname.match(/^\/chat\/(\d+)$/);
  if (!match) return null;
  const routeId = match[1];
  return chats.find((chat) => chatRouteId(chat) === routeId)?.id || null;
}
function showToast(message) {
  if (!appToastEl) return;
  const toast = document.createElement("div");
  toast.className = "app-toast-item";
  toast.textContent = message;
  appToastEl.hidden = false;
  appToastEl.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => {
      toast.remove();
      if (!appToastEl.childElementCount) appToastEl.hidden = true;
    }, 280);
  }, 2200);
}
function getSelectedModel() {
  return MODEL_OPTIONS.find((option) => option.id === selectedModelId) || MODEL_OPTIONS.find((option) => option.id === DEFAULT_MODEL_ID);
}
function getProviderForModel(modelId) {
  return MODEL_PROVIDERS.find((provider) => provider.models.some((model) => model.id === modelId)) || MODEL_PROVIDERS[0];
}
function setSelectedModel(modelId, persist = false) {
  const option = MODEL_OPTIONS.find((item) => item.id === modelId) || MODEL_OPTIONS.find((item) => item.id === DEFAULT_MODEL_ID);
  const provider = getProviderForModel(option.id);
  selectedModelId = option.id;

  if (persist) {
    const chat = getActiveChat();
    if (chat && chat.modelId !== option.id) {
      chat.modelId = option.id;
      void saveConversationModel(chat.id, option.id);
    }
  }

  if (topbarTitleEl) topbarTitleEl.textContent = getModelDisplayName(option.id);
  if (modelPickerBtnEl) modelPickerBtnEl.title = getModelDisplayName(option.id);
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
  updateImageAttachmentAvailability();
}
function isActiveChatModelLocked() {
  const chat = getActiveChat();
  return Boolean(chat && Array.isArray(chat.messages) && chat.messages.length > 0);
}
function updateModelLockState() {
  const locked = isActiveChatModelLocked() || isSending;
  if (modelPickerBtnEl) {
    modelPickerBtnEl.disabled = locked;
    modelPickerBtnEl.title = locked ? "مدل پس از شروع گفتگو قفل است" : getProviderForModel(selectedModelId).label;
  }
  if (modelQuickBtnEl) {
    modelQuickBtnEl.disabled = locked;
    modelQuickBtnEl.title = locked ? "مدل پس از شروع گفتگو قفل است" : `${getProviderForModel(selectedModelId).label}: ${getSelectedModel().label}`;
  }
  if (locked) {
    closeModelMenu();
    closeModelQuickMenu();
  }
}
function modelAcceptsImages() { return Boolean(getSelectedModel()?.acceptsImages); }
function updateImageAttachmentAvailability() {
  if (!attachImageBtnEl || !attachmentImageOptionEl) return;
  const enabled = modelAcceptsImages() && !isSending;
  attachImageBtnEl.disabled = isSending;
  attachmentImageOptionEl.disabled = !enabled;
  attachmentImageOptionEl.title = enabled ? "افزودن تصویر" : "افزودن تصویر فقط با مدل Sol فعال است";
  if (!modelAcceptsImages() && pendingImageDataUrl) clearPendingImage();
}
function closeAttachmentMenu() {
  if (attachmentMenuEl) attachmentMenuEl.hidden = true;
  if (attachImageBtnEl) attachImageBtnEl.setAttribute("aria-expanded", "false");
}
function closeAllMenus() {
  closeModelMenu();
  closeModelQuickMenu();
  closeAttachmentMenu();
  document.querySelectorAll(".dropdown-menu.show").forEach((menu) => menu.classList.remove("show"));
}
function toggleAttachmentMenu() {
  if (!attachmentMenuEl || !attachImageBtnEl || isSending) return;
  const willOpen = attachmentMenuEl.hidden;
  if (willOpen) closeAllMenus();
  attachmentMenuEl.hidden = !willOpen;
  attachImageBtnEl.setAttribute("aria-expanded", String(willOpen));
}
function clearPendingImage() {
  pendingImageDataUrl = "";
  if (imageInputEl) imageInputEl.value = "";
  if (attachImageBtnEl) attachImageBtnEl.classList.remove("has-image");
  if (imagePreviewThumbEl) imagePreviewThumbEl.removeAttribute("src");
  if (imagePreviewEl) imagePreviewEl.hidden = true;
}
function showPendingImagePreview(imageDataUrl) {
  if (!imageDataUrl) { clearPendingImage(); return; }
  if (imagePreviewThumbEl) imagePreviewThumbEl.src = imageDataUrl;
  if (imagePreviewEl) imagePreviewEl.hidden = false;
}
function closeModelMenu() {
  if (modelMenuEl) {
    modelMenuEl.classList.remove("open");
    modelMenuEl.hidden = true;
  }
  if (modelPickerBtnEl) modelPickerBtnEl.setAttribute("aria-expanded", "false");
}
function openModelMenu() {
  if (!modelMenuEl || isActiveChatModelLocked() || isSending) return;
  closeAllMenus();
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
  if (!modelQuickMenuEl || isActiveChatModelLocked() || isSending) return;
  closeAllMenus();
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
  if (modelSliderLabelsEl) {
    modelSliderLabelsEl.innerHTML = "";
    provider.models.forEach((model) => {
      const label = document.createElement("span");
      label.textContent = model.label.replace("Flash ", "");
      modelSliderLabelsEl.appendChild(label);
    });
  }
}
function toNumber(value, fallback = nowTs()) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeModelId(modelId) {
  return MODEL_OPTIONS.some((option) => option.id === modelId) ? modelId : DEFAULT_MODEL_ID;
}
function normalizeMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return null;
  const normalized = { role: message.role, content: String(message.content || "") };
  if (typeof message.image === "string" && message.image.startsWith("data:image/")) normalized.image = message.image;
  if (typeof message.imageUrl === "string" && (message.imageUrl.startsWith("data:image/") || /^https?:\/\//.test(message.imageUrl))) normalized.imageUrl = message.imageUrl;
  if (message._id) normalized._id = String(message._id);
  if (message._parentId) normalized._parentId = String(message._parentId);
  return normalized;
}
function normalizeProfile(profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  return { name: String(source.name || ""), job: String(source.job || ""), systemPrompt: String(source.systemPrompt || ""), responseStyle: String(source.responseStyle || "") };
}
function normalizeTheme(theme) { return THEME_MODES.includes(theme) ? theme : "auto"; }
function normalizeConversation(conversation) {
  if (!conversation || typeof conversation !== "object") return null;
  const messages = Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage).filter(Boolean) : [];
  return {
    id: String(conversation.id || `${nowTs()}`),
    title: String(conversation.title || "گفت‌وگوی جدید"),
    modelId: normalizeModelId(conversation.modelId),
    messages,
    createdAt: toNumber(conversation.createdAt),
    updatedAt: toNumber(conversation.updatedAt),
  };
}
function normalizeConversationSummary(conversation) {
  if (!conversation || typeof conversation !== "object") return null;
  return {
    id: String(conversation.id || `${nowTs()}`),
    title: String(conversation.title || "گفت‌وگوی جدید"),
    modelId: normalizeModelId(conversation.modelId),
    messages: [],
    createdAt: toNumber(conversation.createdAt),
    updatedAt: toNumber(conversation.updatedAt),
  };
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
async function streamApiRequest(path, body, onEvent) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const rawEvent of events) {
      const eventName = rawEvent.match(/^event:\s*(.+)$/m)?.[1] || "message";
      const rawData = rawEvent.match(/^data:\s*(.+)$/m)?.[1];
      if (!rawData) continue;
      let payload;
      try { payload = JSON.parse(rawData); } catch (error) { console.error("Invalid stream event:", error); continue; }
      if (eventName === "error") throw new Error(payload.message || "خطا در دریافت پاسخ");
      onEvent(eventName, payload);
    }
    if (done) break;
  }
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
  try { localStorage.setItem("gapino.theme", nextTheme); } catch {}
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
    chats[index] = {
      ...existing,
      ...normalized,
      modelId: normalized.modelId || existing.modelId || DEFAULT_MODEL_ID,
      messages: normalized.messages.length > 0 || !preserveExistingMessages ? normalized.messages : existing.messages || [],
    };
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
  await apiRequest("/api/state", { method: "PATCH", body: JSON.stringify({ activeConversationId: conversationId ? String(conversationId) : null }) });
}
async function createChat(title = "گفت‌وگوی جدید") {
  const data = await apiRequest("/api/conversations", { method: "POST", body: JSON.stringify({ modelId: selectedModelId }) });
  const conversation = data.conversation || data;
  upsertConversation(conversation, false);
  activeChatId = String(conversation.id);
  await syncActiveConversationId(activeChatId);
  renderChatList();
  renderActiveChat();
  syncChatUrl(conversation);
  return conversation;
}
async function ensureActiveChat() {
  let chat = getActiveChat();
  if (!chat) {
    chat = await createChat();
  }
  if (chat && (!chat.messages || chat.messages.length === 0)) { await loadConversationDetail(chat.id).catch(console.error); chat = getActiveChat(); }
  return chat;
}
async function setActiveChat(chatId) {
  activeChatId = String(chatId);
  renderChatList();
  renderActiveChat();
  syncChatUrl(getActiveChat());
  closeDrawer();
  await syncActiveConversationId(activeChatId);
  await loadConversationDetail(activeChatId);
  const chat = getActiveChat();
  if (chat && chat.modelId) setSelectedModel(chat.modelId, false);
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
  showToast("گفت‌وگو حذف شد");
}
async function deleteChat(chatId) {
  const id = String(chatId);
  const index = chats.findIndex((chat) => chat.id === id);
  if (index === -1) return;
  await apiRequest(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  chats.splice(index, 1);
  if (activeChatId === id) { activeChatId = chats[0] ? chats[0].id : null; await syncActiveConversationId(activeChatId).catch(console.error); }
  renderChatList();
  renderActiveChat();
  const nextChat = getActiveChat();
  if (nextChat) syncChatUrl(nextChat, true);
  else window.history.replaceState({}, "", "/chat");
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
  syncChatUrl(getActiveChat(), true);
  showToast("عنوان گفت‌وگو ویرایش شد");
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
function openDrawer() { closeAllMenus(); if (drawerEl) drawerEl.classList.add("open"); openOverlay(); }
function closeDrawer() { if (drawerEl) drawerEl.classList.remove("open"); closeOverlayIfIdle(); }
function openProfileModal() {
  closeAllMenus();
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
function scrollToBottom() {
  if (!chatMainEl) return;
  chatMainEl.scrollTop = chatMainEl.scrollHeight;
  if (scrollToBottomBtnEl) scrollToBottomBtnEl.hidden = true;
  requestAnimationFrame(() => {
    if (!chatMainEl) return;
    chatMainEl.scrollTop = chatMainEl.scrollHeight;
    if (scrollToBottomBtnEl) scrollToBottomBtnEl.hidden = true;
  });
}
function ensureScrollSentinel() {
  if (!messagesSectionEl || !chatMainEl) return;
  if (scrollSentinelObserver) {
    scrollSentinelObserver.disconnect();
    scrollSentinelObserver = null;
  }
  if (scrollSentinelEl && scrollSentinelEl.parentNode) {
    scrollSentinelEl.parentNode.removeChild(scrollSentinelEl);
  }
  scrollSentinelEl = document.createElement("div");
  scrollSentinelEl.className = "scroll-sentinel";
  scrollSentinelEl.setAttribute("aria-hidden", "true");
  messagesSectionEl.appendChild(scrollSentinelEl);
  scrollSentinelObserver = new IntersectionObserver(
    (entries) => {
      if (!scrollToBottomBtnEl) return;
      const entry = entries[0];
      scrollToBottomBtnEl.hidden = entry.isIntersecting;
    },
    { root: chatMainEl, rootMargin: "0px 0px 100px 0px", threshold: 0 }
  );
  scrollSentinelObserver.observe(scrollSentinelEl);
}
function detectDirection(text) {
  const value = String(text || "");
  const rtl = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const ltr = /[A-Za-z]/;
  for (const character of value) {
    if (rtl.test(character)) return "rtl";
    if (ltr.test(character)) return "ltr";
  }
  return "rtl";
}
const markdownRenderer = window.markdownit({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (code, language) =>
    `<pre data-language="${String(language || "Code")}" data-lang="${String(language || "plaintext")}"><code class="language-${String(language || "plaintext")}">${window.markdownit().utils.escapeHtml(code)}</code></pre>`,
})
  .use(window.markdownitTexmath, { engine: window.katex, delimiters: "dollars" })
  .use(window.markdownitTaskLists, { enabled: true, label: true, labelAfter: true });
function renderMarkdown(markdown) {
  return markdownRenderer.render(normalizeLatex(markdown));
}
function normalizeLatex(text) {
  let value = String(text || "");

  value = value.replace(/\\\[/g, "$$$$");
  value = value.replace(/\\\]/g, "$$$$");
  value = value.replace(/\\\(/g, "$");
  value = value.replace(/\\\)/g, "$");

  value = value.replace(/\$\$2ex\]/g, "\\\\[2ex]");
  value = value.replace(/\$\$(\d+(?:\.\d+)?)ex\]/g, "\\\\[$1ex]");

  value = value.replace(/\$\$\s*\n\s*\$\$/g, "");
  value = value.replace(/\$\$\n\$\$/g, "");
  value = value.replace(/\$\$[ \t]+/g, "$$$$");
  value = value.replace(/[ \t]+\$\$/g, "$$$$");
  value = value.replace(/\$\$\s*\n/g, "$$$$\n");
  value = value.replace(/\n\s*\$\$/g, "\n$$$$");
  value = value.replace(/\$\$\$\$/g, "$$$$");

  value = wrapOrphanEnvironments(value);
  value = splitGluedDisplayMath(value);
  value = stripCasesRowSpacing(value);

  value = value.replace(/\$\$\s*\n\s*\$\$/g, "");
  value = value.replace(/\$\$\n\$\$/g, "");
  value = value.replace(/\$\$\$\$/g, "$$$$");

  return value;
}
function wrapOrphanEnvironments(text) {
  const envPattern = /\\begin\{(\w+)\}[\s\S]*?\\end\{\1\}/g;
  return text.replace(envPattern, (match, _name, offset, source) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + match.length);
    const openCount = (before.match(/\$\$/g) || []).length;
    const closeCount = (after.match(/\$\$/g) || []).length;
    const alreadyOpen = openCount % 2 === 1;
    const alreadyClosed = closeCount % 2 === 1;
    if (alreadyOpen && alreadyClosed) return match;
    if (alreadyOpen && !alreadyClosed) return `${match}\n$$$$`;
    if (!alreadyOpen && alreadyClosed) return `$$$$\n${match}`;
    return `$$$$\n${match}\n$$$$`;
  });
}
function splitGluedDisplayMath(text) {
  const pattern = /\$\$([\s\S]*?)\$\$/g;
  return text.replace(pattern, (match, body) => {
    const casesOpen = (body.match(/\\begin\{/g) || []).length;
    const casesClose = (body.match(/\\end\{/g) || []).length;
    if (casesOpen !== casesClose) return match;
    const splitIndex = findGluedSplit(body);
    if (splitIndex === -1) return match;
    const first = body.slice(0, splitIndex).trim();
    const second = body.slice(splitIndex).trim();
    if (!first || !second) return match;
    return `$$${first}$$\n\n$$${second}$$`;
  });
}
function findGluedSplit(body) {
  const casesEnd = body.lastIndexOf("\\end{cases}");
  if (casesEnd !== -1) {
    const after = casesEnd + "\\end{cases}".length;
    const tail = body.slice(after);
    const tailMatch = tail.search(/[A-Za-z]\s*\([^)]*\)\s*=/);
    if (tailMatch !== -1) {
      const idx = after + tailMatch;
      if (isBalancedFragment(body.slice(0, idx))) return idx;
    }
  }
  const fnPattern = /[A-Za-z]\s*\([^)]*\)\s*=\s*(?:\\begin|\\frac|\\sum|\\int|\\left|\\[a-zA-Z]+)/g;
  let match;
  while ((match = fnPattern.exec(body)) !== null) {
    const idx = match.index;
    if (idx === 0) continue;
    if (isBalancedFragment(body.slice(0, idx))) return idx;
  }
  return -1;
}
function isBalancedFragment(fragment) {
  const braces = (fragment.match(/\{/g) || []).length - (fragment.match(/\}/g) || []).length;
  if (braces !== 0) return false;
  const left = (fragment.match(/\\left/g) || []).length;
  const right = (fragment.match(/\\right/g) || []).length;
  if (left !== right) return false;
  return true;
}
function stripCasesRowSpacing(text) {
  const pattern = /\\begin\{cases\}([\s\S]*?)\\end\{cases\}/g;
  return text.replace(pattern, (match, body) => {
    const cleaned = body.replace(/\\\\\s*\[\s*\d+(?:\.\d+)?\s*(?:ex|pt|em|cm|mm|in)\s*\]/g, "\\\\");
    return `\\begin{cases}${cleaned}\\end{cases}`;
  });
}
function attachCodeCopyButtons(container) {
  if (!container) return;
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy-btn")) return;
    const code = pre.querySelector("code");
    if (!code) return;
    const languageClass = pre.dataset.lang || "plaintext";
    if (!code.classList.contains(`language-${languageClass}`)) code.classList.add(`language-${languageClass}`);
    if (!code.dataset.highlighted && typeof window.hljs === "object" && window.hljs) {
      try {
        window.hljs.highlightElement(code);
        code.dataset.highlighted = "true";
      } catch (error) {
        console.error("Code highlighting failed:", error);
      }
    }
    const header = document.createElement("div");
    header.className = "code-block-header";
    const language = document.createElement("span");
    language.className = "code-language-label";
    language.textContent = pre.dataset.language || "Code";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-btn";
    button.setAttribute("aria-label", "کپی کد");
    button.title = "کپی کد";
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/></svg>`;
    button.addEventListener("click", () => copyText(code.textContent || "", button));
    header.appendChild(language);
    header.appendChild(button);
    pre.prepend(header);
  });
}
async function copyText(text, button) {
  const value = String(text || "");
  const markCopied = () => {
    if (!button) return;
    button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
    setTimeout(() => {
      button.innerHTML = `<svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
    }, 1200);
  };
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Copy command failed");
    }
    markCopied();
  } catch (error) { console.error("Copy failed:", error); showToast("کپی کردن انجام نشد"); }
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
  const stack = document.createElement("div");
  stack.className = "user-message-stack";
  const bubble = document.createElement("div");
  bubble.className = "message user";
  bubble.setAttribute("dir", detectDirection(msg.content));
  if (msg.image) {
    const image = document.createElement("img");
    image.className = "message-image user-message-image";
    image.src = msg.image;
    image.alt = "تصویر ارسال‌شده";
    bubble.appendChild(image);
  }
  if (msg.content) {
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = String(msg.content || "");
    bubble.appendChild(text);
  }
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
  stack.appendChild(bubble);
  stack.appendChild(actionsDiv);
  wrapper.appendChild(stack);
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
      const isStreaming = Boolean(currentMsg._streaming);
      const content = document.createElement("div");
      content.className = "assistant-content";
      const renderVersionImage = (message) => {
        wrapper.querySelector(".generated-image-frame")?.remove();
        if (!message.imageUrl) return;
        const imageFrame = document.createElement("div");
        imageFrame.className = "generated-image-frame";
        const image = document.createElement("img");
        image.className = "message-image generated-message-image";
        image.src = message.imageUrl;
        image.alt = "تصویر تولیدشده";
        image.loading = "lazy";
        const download = document.createElement("a");
        download.className = "generated-image-download";
        download.href = message.imageUrl;
        download.download = "gapino-generated-image.png";
        download.setAttribute("aria-label", "دانلود تصویر");
        download.title = "دانلود تصویر";
        download.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        imageFrame.append(image, download);
        wrapper.insertBefore(imageFrame, content);
      };
      const messageText = String(currentMsg.content || "");
      content.setAttribute("dir", detectDirection(messageText));
      content.innerHTML = renderMarkdown(messageText);
      attachCodeCopyButtons(content);
      wrapper.appendChild(content);
      renderVersionImage(currentMsg);
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "message-actions-overlay";
      if (!isStreaming) {
        actionsDiv.appendChild(createCopyButton(messageText));
        actionsDiv.appendChild(createRegenerateButton());
      }
      if (total > 1 && !isStreaming) {
        const paginationDiv = document.createElement("div");
        paginationDiv.className = "message-version-pagination";
        const undoBtn = document.createElement("button");
        undoBtn.textContent = "‹";
        undoBtn.setAttribute("aria-label", "نسخهٔ قبلی");
        undoBtn.title = "نسخهٔ قبلی";
        undoBtn.disabled = currentIndex === 0;
        const redoBtn = document.createElement("button");
        redoBtn.textContent = "›";
        redoBtn.setAttribute("aria-label", "نسخهٔ بعدی");
        redoBtn.title = "نسخهٔ بعدی";
        redoBtn.disabled = currentIndex === total - 1;
        const counterSpan = document.createElement("span");
        counterSpan.textContent = `${currentIndex + 1} / ${total}`;
        const updateVersion = (idx) => {
          wrapper.dataset.currentVersion = idx;
          const targetMsg = versions[idx];
          const newText = String(targetMsg.content || "");
          content.setAttribute("dir", detectDirection(newText));
          content.innerHTML = renderMarkdown(newText);
          renderVersionImage(targetMsg);
          attachCodeCopyButtons(content);
          actionsDiv.querySelectorAll(".meta-btn").forEach((button) => button.remove());
          actionsDiv.appendChild(createCopyButton(newText));
          const regenBtn = createRegenerateButton();
          regenBtn.addEventListener("click", () => regenerateLastReply());
          actionsDiv.appendChild(regenBtn);
          actionsDiv.appendChild(paginationDiv);
          undoBtn.disabled = idx === 0;
          redoBtn.disabled = idx === total - 1;
          counterSpan.textContent = `${idx + 1} / ${total}`;
        };
        undoBtn.addEventListener("click", () => updateVersion(Number(wrapper.dataset.currentVersion) - 1));
        redoBtn.addEventListener("click", () => updateVersion(Number(wrapper.dataset.currentVersion) + 1));
        paginationDiv.appendChild(undoBtn);
        paginationDiv.appendChild(counterSpan);
        paginationDiv.appendChild(redoBtn);
        actionsDiv.appendChild(paginationDiv);
      }
      if (!isStreaming) wrapper.appendChild(actionsDiv);
      messagesSectionEl.appendChild(wrapper);
    }
  }
  ensureScrollSentinel();
  scrollToBottom();
}
function renderActiveChat() {
  const chat = getActiveChat();
  const hasMessages = chat && Array.isArray(chat.messages) && chat.messages.length > 0;
  if (emptyStateEl) emptyStateEl.style.display = hasMessages ? "none" : "";
  if (messagesSectionEl) messagesSectionEl.style.display = hasMessages ? "" : "none";
  renderMessages(chat ? chat.messages : []);
  updateModelLockState();
}
function renderChatList() {
  if (!chatListEl) return;
  chatListEl.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("li");
    empty.className = "chat-list-empty";
    empty.textContent = "گفت‌وگویی یافت نشد";
    chatListEl.appendChild(empty);
    return;
  }
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
    closeAllMenus();
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
  updateModelLockState();
  updateImageAttachmentAvailability();
}
function setSendButtonLoading(loading) {
  if (!sendBtnEl) return;
  sendBtnEl.disabled = loading;
  sendBtnEl.innerHTML = loading
    ? `<div class="spinner"></div>`
    : `<svg viewBox="0 0 24 24" class="icon-send" aria-hidden="true"><path d="M12 19V5m0 0 6 6m-6-6-6 6" /></svg>`;
  sendBtnEl.style.display = loading ? "flex" : "";
  sendBtnEl.style.alignItems = loading ? "center" : "";
  sendBtnEl.style.justifyContent = loading ? "center" : "";
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
  const payload = { messages: messages.map((message) => ({ role: message.role, content: String(message.content || ""), ...(message.image ? { image: message.image } : {}), ...(message.imageUrl ? { imageUrl: message.imageUrl } : {}) })) };
  if (title) payload.title = title;
  const data = await apiRequest(`/api/conversations/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify(payload) });
  upsertConversation(data.conversation || data, false);
  renderChatList();
  renderActiveChat();
}
async function saveConversationModel(chatId, modelId) {
  try {
    await apiRequest(`/api/conversations/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    });
  } catch (error) {
    console.error("Failed to save conversation model:", error);
  }
}
async function sendMessage(promptOverride = null) {
  if (isSending) return;
  let chat = await ensureActiveChat();
  if (!chat) return;
  const rawText = typeof promptOverride === "string" && promptOverride.length > 0 ? promptOverride : userInputEl ? userInputEl.value : "";
  const text = String(rawText || "").trim();
  if (!text && !pendingImageDataUrl) return;
  if (pendingImageDataUrl && !modelAcceptsImages()) return;
  updateSendingState(true);
  setSendButtonLoading(true);
  const tempUserMsgId = `${nowTs()}`;
  const image = pendingImageDataUrl;
  const chatModelId = chat.modelId || selectedModelId;
  const tempUserMsg = { role: "user", content: text, ...(image ? { image } : {}), _id: tempUserMsgId };
  chat.messages.push(tempUserMsg);
  renderActiveChat();
  if (userInputEl) { userInputEl.value = ""; autoResizeTextarea(); }
  clearPendingImage();
  try {
    chat.messages.push({ role: "assistant", content: "", _parentId: tempUserMsgId, _id: `stream_${nowTs()}`, _streaming: true });
    renderActiveChat();
    const currentStreamingReply = chat.messages.find((message) => message._streaming);
    let updatedConversation = null;
    await streamApiRequest(
      `/api/conversations/${encodeURIComponent(chat.id)}/messages/stream`,
      { content: text, image, model: chatModelId, clientMessageId: tempUserMsgId },
      (eventName, payload) => {
        if (eventName === "delta" && currentStreamingReply) {
          currentStreamingReply.content += String(payload.content || "");
          if (payload.imageUrl) currentStreamingReply.imageUrl = payload.imageUrl;
          renderActiveChat();
        }
        if (eventName === "done") updatedConversation = payload.conversation || null;
      }
    );
    if (currentStreamingReply) delete currentStreamingReply._streaming;
    if (!updatedConversation) throw new Error("پاسخ گفتگو دریافت نشد.");
    upsertConversation(updatedConversation, false);
    activeChatId = String(updatedConversation.id || chat.id);
    renderChatList();
    renderActiveChat();
  } catch (error) {
    console.error("sendMessage failed:", error);
    if (userInputEl) userInputEl.value = text;
    if (image) { pendingImageDataUrl = image; if (attachImageBtnEl) attachImageBtnEl.classList.add("has-image"); showPendingImagePreview(image); }
    showToast("خطا در ارسال پیام");
  } finally {
    updateSendingState(false);
    setSendButtonLoading(false);
    if (userInputEl) userInputEl.focus();
  }
}
async function typeAssistantReply(message, content) {
  const text = String(content || "");
  const chunkSize = Math.max(1, Math.ceil(text.length / 90));
  message.content = "";
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    message.content += text.slice(offset, offset + chunkSize);
    renderActiveChat();
    await new Promise((resolve) => window.setTimeout(resolve, 14));
  }
  if (!text) renderActiveChat();
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
  updateSendingState(true);
  setSendButtonLoading(true);
  showLoadingIndicator(userMsgId);
  try {
    const response = await requestAssistantReply(truncatedMessages, chat.modelId || selectedModelId);
    const assistantReply = extractAssistantContent(response) || "پاسخی دریافت نشد.";
    const streamingReply = { role: "assistant", content: "", _parentId: userMsgId, _id: `stream_${nowTs()}`, _streaming: true };
    chat.messages.push(streamingReply);
    renderActiveChat();
    await typeAssistantReply(streamingReply, assistantReply);
    delete streamingReply._streaming;
    if (!chat.title || chat.title === "گفت‌وگوی جدید") updateChatTitleFromFirstMessage(chat);
    await saveConversationMessages(chat.id, chat.messages, chat.title);
    renderChatList();
    renderActiveChat();
  } catch (error) { console.error(error); } finally {
    updateSendingState(false);
    setSendButtonLoading(false);
    hideLoadingIndicator();
    if (userInputEl) userInputEl.focus();
  }
}
async function handleNewChat() {
  activeChatId = null;
  await syncActiveConversationId(null).catch(console.error);
  window.history.pushState({}, "", "/chat");
  renderChatList();
  renderActiveChat();
  closeDrawer();
  showToast("آمادهٔ گفت‌وگوی جدید");
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
  showToast("تغییرات پروفایل ذخیره شد");
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
  const routeChatId = chatIdFromPath();
  if (routeChatId && chats.some((chat) => chat.id === routeChatId)) activeChatId = routeChatId;
  if (activeChatId) await loadConversationDetail(activeChatId).catch(console.error);
  const initialChat = getActiveChat();
  if (initialChat && initialChat.modelId) setSelectedModel(initialChat.modelId, false);
  renderChatList();
  renderActiveChat();
  if (activeChatId) syncChatUrl(getActiveChat(), true);
  autoResizeTextarea();
  scrollToBottom();
}
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
  if (usernameInputEl) usernameInputEl.focus();
}
function hidePinGate() {
  if (pinGateEl) pinGateEl.setAttribute("aria-hidden", "true");
  if (appEl) appEl.setAttribute("aria-hidden", "false");
}
async function submitLogin(username, password) {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
if (pinFormEl) {
  pinFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = usernameInputEl ? usernameInputEl.value.trim() : "";
    const password = passwordInputEl ? passwordInputEl.value : "";
    if (!username || !password) return;
    if (pinErrorEl) pinErrorEl.hidden = true;
    const ok = await submitLogin(username, password);
    if (ok) {
      hidePinGate();
      if (usernameInputEl) usernameInputEl.value = "";
      if (passwordInputEl) passwordInputEl.value = "";
      if (window.location.pathname === "/") window.history.replaceState({}, "", "/chat");
      await initializeState();
    } else {
      if (pinErrorEl) pinErrorEl.hidden = false;
      if (passwordInputEl) passwordInputEl.value = "";
      if (usernameInputEl) usernameInputEl.focus();
    }
  });
}

if (sendBtnEl) sendBtnEl.addEventListener("click", (event) => { event.preventDefault(); void sendMessage(); });
if (scrollToBottomBtnEl) scrollToBottomBtnEl.addEventListener("click", scrollToBottom);
if (attachImageBtnEl) attachImageBtnEl.addEventListener("click", (event) => { event.stopPropagation(); toggleAttachmentMenu(); });
if (attachmentImageOptionEl) attachmentImageOptionEl.addEventListener("click", () => { if (modelAcceptsImages() && imageInputEl) imageInputEl.click(); closeAttachmentMenu(); });
if (removeImageBtnEl) removeImageBtnEl.addEventListener("click", clearPendingImage);
if (imageInputEl) imageInputEl.addEventListener("change", () => {
  const file = imageInputEl.files && imageInputEl.files[0];
  if (!file) return;
  if (!modelAcceptsImages()) { clearPendingImage(); return; }
  if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) { showToast("فقط تصویر تا ۵ مگابایت قابل ارسال است"); clearPendingImage(); return; }
  const reader = new FileReader();
  reader.onload = () => { pendingImageDataUrl = String(reader.result || ""); if (attachImageBtnEl) attachImageBtnEl.classList.add("has-image"); showPendingImagePreview(pendingImageDataUrl); };
  reader.readAsDataURL(file);
});
if (modelQuickBtnEl) modelQuickBtnEl.addEventListener("click", (event) => { event.stopPropagation(); toggleModelQuickMenu(); });
if (modelQuickRangeEl) {
  modelQuickRangeEl.addEventListener("input", () => {
    const provider = getProviderForModel(selectedModelId);
    const index = Math.min(provider.models.length - 1, Math.max(0, Number(modelQuickRangeEl.value) || 0));
    modelQuickRangeEl.style.setProperty("--quick-progress", `${(index / Math.max(1, provider.models.length - 1)) * 100}%`);
    modelQuickRangeEl.setAttribute("aria-valuetext", provider.models[index]?.label || "");
  });
  modelQuickRangeEl.addEventListener("change", () => {
    if (isActiveChatModelLocked() || isSending) return;
    const provider = getProviderForModel(selectedModelId);
    const index = Math.min(provider.models.length - 1, Math.max(0, Number(modelQuickRangeEl.value) || 0));
    const nextModelId = provider.models[index].id;
    if (nextModelId === selectedModelId) return;
    setSelectedModel(nextModelId, true);
    renderModelQuickMenu();
  });
}
if (userInputEl) userInputEl.addEventListener("input", autoResizeTextarea);
if (modelPickerBtnEl) modelPickerBtnEl.addEventListener("click", (event) => { event.stopPropagation(); if (!isActiveChatModelLocked()) toggleModelMenu(); });
if (menuBtnEl) menuBtnEl.addEventListener("click", openDrawer);
if (closeDrawerBtnEl) closeDrawerBtnEl.addEventListener("click", closeDrawer);
if (overlayEl) overlayEl.addEventListener("click", handleOverlayClick);
if (newChatBtnEl) newChatBtnEl.onclick = () => { void handleNewChat(); };
if (topbarNewChatBtnEl) topbarNewChatBtnEl.addEventListener("click", () => {
  void handleNewChat().catch(console.error);
});
if (logoutBtnEl) logoutBtnEl.addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (error) { console.error(error); }
  closeDrawer();
  appInitialized = false;
  chats = [];
  activeChatId = null;
  window.history.replaceState({}, "", "/");
  showPinGate();
});
if (profileBtnEl) profileBtnEl.addEventListener("click", openProfileModal);
if (profileModalEl) profileModalEl.addEventListener("click", (event) => { if (event.target === profileModalEl) closeProfileModal(); });
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
  if (attachmentMenuEl && attachImageBtnEl && !attachmentMenuEl.contains(event.target) && !attachImageBtnEl.contains(event.target)) closeAttachmentMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModelMenu();
    closeModelQuickMenu();
    closeAttachmentMenu();
  }
});
window.addEventListener("popstate", async () => {
  const chatId = chatIdFromPath();
  if (chatId && chats.some((chat) => chat.id === chatId)) await setActiveChat(chatId);
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
setSelectedModel(DEFAULT_MODEL_ID, false);

(async () => {
  const authed = await checkAuth();
  if (authed) {
    hidePinGate();
    if (window.location.pathname === "/") window.history.replaceState({}, "", "/chat");
    await initializeState();
  } else {
    showPinGate();
  }
})();