import json
import os
import tempfile
import time
import hashlib
from pathlib import Path
from threading import Lock
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
FRONTEND_DIR = BASE_DIR / "frontend"
STORE_PATH = BASE_DIR / "backend" / "data" / "history.json"
IMAGES_DIR = BASE_DIR / "backend" / "data" / "images"
STORE_LOCK = Lock()
ENV_LOCK = Lock()
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")

PORT = int(os.getenv("PORT", "3000"))
HOST = os.getenv("HOST", "localhost")
GAPGPT_API_KEY = os.getenv("GAPGPT_API_KEY")
GAPGPT_API_URL = os.getenv("GAPGPT_API_URL")
CHAT_MODEL = os.getenv("CHAT_MODEL")
IMAGE_API_URL = os.getenv("IMAGE_API_URL")
IMAGE_MODEL = os.getenv("IMAGE_MODEL")
IMAGE_SIZE = os.getenv("IMAGE_SIZE", "1024x1024")
ENV_PATH = BASE_DIR / ".env"
PROMPT_MODEL = "gemini-2.5-flash-lite"
SUPPORTED_CHAT_MODELS = frozenset(
    {
        "gpt-5.4-nano",
        "gpt-5.4-mini",
        "gpt-5.4",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
    }
)

if not GAPGPT_API_KEY:
    raise RuntimeError("Missing GAPGPT_API_KEY in .env")
if not GAPGPT_API_URL:
    raise RuntimeError("Missing GAPGPT_API_URL in .env")
if not CHAT_MODEL:
    raise RuntimeError("Missing CHAT_MODEL in .env")
if not IMAGE_API_URL:
    raise RuntimeError("Missing IMAGE_API_URL in .env")
if not IMAGE_MODEL:
    raise RuntimeError("Missing IMAGE_MODEL in .env")

DEFAULT_PROFILE = {"name": "", "job": "", "systemPrompt": "", "responseStyle": ""}
DEFAULT_THEME = "auto"
DEFAULT_ACTIVE_CONVERSATION_ID = None
DEFAULT_CONVERSATION_TITLE = "گفت‌وگوی جدید"

def now_ts():
    return int(time.time())

def json_error(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status

def persist_chat_model(model):
    """Update the running chat model and persist it in the project .env file."""
    model = str(model or "").strip()
    if model not in SUPPORTED_CHAT_MODELS:
        raise ValueError("Invalid model")
    global CHAT_MODEL
    with ENV_LOCK:
        try:
            env_text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
            lines = env_text.splitlines(keepends=True)
            replaced = False
            updated_lines = []
            for line in lines:
                key, separator, _value = line.partition("=")
                if separator and key.strip() == "CHAT_MODEL" and not key.lstrip().startswith("#"):
                    line_ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                    updated_lines.append(f"CHAT_MODEL={model}{line_ending}")
                    replaced = True
                else:
                    updated_lines.append(line)
            if not replaced:
                if updated_lines and not updated_lines[-1].endswith(("\n", "\r")):
                    updated_lines[-1] += "\n"
                updated_lines.append(f"CHAT_MODEL={model}\n")
            fd, temp_name = tempfile.mkstemp(prefix=".env.", suffix=".tmp", dir=str(ENV_PATH.parent), text=True)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                    handle.write("".join(updated_lines))
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, ENV_PATH)
            except Exception:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
                raise
        except OSError:
            raise
        CHAT_MODEL = model
        os.environ["CHAT_MODEL"] = model
    return CHAT_MODEL

def default_state():
    return {
        "version": 2,
        "profile": dict(DEFAULT_PROFILE),
        "theme": DEFAULT_THEME,
        "activeConversationId": DEFAULT_ACTIVE_CONVERSATION_ID,
        "conversations": [],
        "savedImages": [],
    }

def normalize_message(message):
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "").strip()
    if role not in {"user", "assistant", "system"}:
        return None
    content = message.get("content", "")
    if content is None:
        content = ""
    normalized = {"role": role, "content": str(content)}
    if "name" in message:
        normalized["name"] = str(message.get("name") or "")
    return normalized

def normalize_state(state):
    if not isinstance(state, dict):
        state = default_state()
    profile = state.get("profile")
    if not isinstance(profile, dict):
        profile = {}
    normalized_profile = {}
    for key, fallback in DEFAULT_PROFILE.items():
        normalized_profile[key] = str(profile.get(key, fallback) or "")
    theme = str(state.get("theme") or DEFAULT_THEME)
    if theme not in {"auto", "light", "dark"}:
        theme = DEFAULT_THEME
    conversations = state.get("conversations")
    if not isinstance(conversations, list):
        conversations = []
    normalized_conversations = []
    used_ids = set()
    for index, conversation in enumerate(conversations):
        if not isinstance(conversation, dict):
            continue
        conversation_id = str(conversation.get("id") or f"{now_ts()}_{index}_{os.urandom(2).hex()}")
        if conversation_id in used_ids:
            conversation_id = f"{conversation_id}_{os.urandom(2).hex()}"
        used_ids.add(conversation_id)
        title = str(conversation.get("title") or DEFAULT_CONVERSATION_TITLE).strip()
        if not title:
            title = DEFAULT_CONVERSATION_TITLE
        messages = conversation.get("messages")
        if not isinstance(messages, list):
            messages = []
        clean_messages = []
        for message in messages:
            normalized_message = normalize_message(message)
            if normalized_message:
                clean_messages.append(normalized_message)
        created_at = conversation.get("createdAt")
        updated_at = conversation.get("updatedAt")
        try:
            created_at = int(created_at)
        except (TypeError, ValueError):
            created_at = now_ts()
        try:
            updated_at = int(updated_at)
        except (TypeError, ValueError):
            updated_at = created_at
        normalized_conversations.append(
            {
                "id": conversation_id,
                "title": title,
                "messages": clean_messages,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
        )
    normalized_conversations.sort(
        key=lambda item: (item["updatedAt"], item["createdAt"]),
        reverse=True,
    )
    active_id = state.get("activeConversationId")
    if active_id is not None:
        active_id = str(active_id)
    valid_ids = {conversation["id"] for conversation in normalized_conversations}
    if active_id not in valid_ids:
        active_id = normalized_conversations[0]["id"] if normalized_conversations else None
    saved_images = state.get("savedImages")
    if not isinstance(saved_images, list):
        saved_images = []
    saved_images = [str(img) for img in saved_images if img]
    return {
        "version": 2,
        "profile": normalized_profile,
        "theme": theme,
        "activeConversationId": active_id,
        "conversations": normalized_conversations,
        "savedImages": saved_images,
    }

def migrate_legacy_store(data):
    if not isinstance(data, dict):
        return default_state()
    users = data.get("users")
    if isinstance(users, dict) and users:
        legacy_state = users.get("local")
        if not isinstance(legacy_state, dict):
            legacy_state = next((value for value in users.values() if isinstance(value, dict)), None)
        if isinstance(legacy_state, dict):
            return normalize_state(legacy_state)
    return normalize_state(data)

def _load_store_unlocked():
    if not STORE_PATH.exists():
        return default_state()
    try:
        with STORE_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default_state()
    return migrate_legacy_store(data)

def _save_store_unlocked(state):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    normalized = normalize_state(state)
    fd, tmp_name = tempfile.mkstemp(prefix="history.", suffix=".tmp", dir=str(STORE_PATH.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(normalized, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, STORE_PATH)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return normalized

def load_store():
    with STORE_LOCK:
        state = _load_store_unlocked()
        return _save_store_unlocked(state)

def update_store(mutator):
    with STORE_LOCK:
        state = _load_store_unlocked()
        result = mutator(state)
        state = _save_store_unlocked(state)
        return state, result

def get_conversation(state, conversation_id):
    conversation_id = str(conversation_id)
    for conversation in state["conversations"]:
        if conversation["id"] == conversation_id:
            return conversation
    return None

def sort_conversations(state):
    state["conversations"].sort(
        key=lambda item: (item.get("updatedAt", 0), item.get("createdAt", 0)),
        reverse=True,
    )

def conversation_summary(conversation):
    messages = conversation.get("messages") or []
    return {
        "id": conversation["id"],
        "title": conversation.get("title") or DEFAULT_CONVERSATION_TITLE,
        "messageCount": len(messages),
        "createdAt": conversation.get("createdAt"),
        "updatedAt": conversation.get("updatedAt"),
        "lastMessage": messages[-1] if messages else None,
    }

def serialize_conversation(conversation):
    return {
        "id": conversation["id"],
        "title": conversation.get("title") or DEFAULT_CONVERSATION_TITLE,
        "messages": conversation.get("messages") or [],
        "createdAt": conversation.get("createdAt"),
        "updatedAt": conversation.get("updatedAt"),
    }

def create_conversation(state, title=None):
    timestamp = now_ts()
    conversation = {
        "id": f"{timestamp}_{os.urandom(4).hex()}",
        "title": str(title or DEFAULT_CONVERSATION_TITLE).strip() or DEFAULT_CONVERSATION_TITLE,
        "messages": [],
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }
    state["conversations"].insert(0, conversation)
    state["activeConversationId"] = conversation["id"]
    return conversation

def build_system_prompt(profile):
    parts = [
        "You are a precise, helpful, and friendly Persian-language assistant.",
        "Write answers clearly, practically, and in an organized manner whenever possible.",
    ]
    name = str(profile.get("name") or "").strip()
    job = str(profile.get("job") or "").strip()
    custom = str(profile.get("systemPrompt") or "").strip()
    style = str(profile.get("responseStyle") or "").strip()
    if name:
        parts.append(f"User name: {name}")
    if job:
        parts.append(f"User role: {job}")
    if custom:
        parts.append(f"User custom instructions: {custom}")
    if style:
        parts.append(f"Preferred response style: {style}")
    return "\n".join(parts)

def request_upstream_chat(messages, model=None):
    payload = {"model": model or CHAT_MODEL, "messages": messages}
    response = requests.post(
        GAPGPT_API_URL,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
        json=payload,
        timeout=120,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}
    return response.status_code, data

def extract_assistant_content(data):
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                return str(message.get("content") or "").strip()
    for key in ("content", "text", "answer", "response"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raw = data.get("raw")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return ""

def generate_conversation_title(user_content):
    if not user_content:
        return DEFAULT_CONVERSATION_TITLE
    try:
        response = requests.post(
            GAPGPT_API_URL,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
            json={
                "model": PROMPT_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a title generator. Read the user's first message and generate a short, concise title in Persian for the conversation. The title must be a noun phrase, no more than 10 words, and strictly under 30 characters. Only output the title, nothing else."
                    },
                    {"role": "user", "content": f"Generate title for this first message: {user_content}"}
                ]
            },
            timeout=15,
        )
        if response.status_code == 200:
            data = response.json()
            choices = data.get("choices", [])
            if choices and choices[0].get("message"):
                title = choices[0]["message"]["content"].strip()
                if title and len(title) <= 30:
                    return title
        return user_content[:30].strip()
    except Exception:
        return user_content[:30].strip()

def get_saved_images_from_disk():
    images = []
    if IMAGES_DIR.exists():
        for file_path in IMAGES_DIR.iterdir():
            if file_path.is_file() and file_path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp'}:
                images.append(f"/api/images/static/{file_path.name}")
    return sorted(images)

@app.get("/")
def root():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.get("/api/auth/me")
def auth_me():
    return jsonify({"user": {"username": "local", "local": True}})

@app.post("/api/auth/login")
def auth_login_compatibility():
    return jsonify({"user": {"username": "local", "local": True}})

@app.post("/api/auth/logout")
def auth_logout_compatibility():
    return jsonify({"ok": True})

@app.get("/api/state")
def get_state():
    state = load_store()
    return jsonify(
        {
            "profile": state["profile"],
            "theme": state["theme"],
            "activeConversationId": state["activeConversationId"],
            "conversations": [conversation_summary(conversation) for conversation in state["conversations"]],
            "chatModel": CHAT_MODEL,
            "promptModel": PROMPT_MODEL,
        }
    )

@app.get("/api/model")
def get_model():
    return jsonify({"chatModel": CHAT_MODEL, "promptModel": PROMPT_MODEL})

@app.patch("/api/model")
def patch_model():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    model = str(payload.get("model") or "").strip()
    if model not in SUPPORTED_CHAT_MODELS:
        return json_error(
            "Invalid model",
            400,
            availableModels=sorted(SUPPORTED_CHAT_MODELS),
        )
    try:
        selected_model = persist_chat_model(model)
    except OSError:
        return json_error("Failed to persist model configuration", 500)
    return jsonify({"chatModel": selected_model, "promptModel": PROMPT_MODEL})

@app.patch("/api/state")
def patch_state():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    validation_error = None
    def mutate(state):
        nonlocal validation_error
        if "activeConversationId" in payload:
            active_id = payload.get("activeConversationId")
            if active_id is None:
                state["activeConversationId"] = None
            else:
                active_id = str(active_id)
                if get_conversation(state, active_id) is None:
                    validation_error = ("Conversation not found", 404)
                    return
                state["activeConversationId"] = active_id
        if "theme" in payload:
            theme = str(payload.get("theme") or "").strip()
            if theme not in {"auto", "light", "dark"}:
                validation_error = ("Invalid theme", 400)
                return
            state["theme"] = theme
        if "profile" in payload:
            profile = payload.get("profile")
            if not isinstance(profile, dict):
                validation_error = ("profile must be an object", 400)
                return
            for key in DEFAULT_PROFILE:
                if key in profile:
                    state["profile"][key] = str(profile.get(key) or "")
    state, _ = update_store(mutate)
    if validation_error:
        return json_error(*validation_error)
    return jsonify(
        {
            "profile": state["profile"],
            "theme": state["theme"],
            "activeConversationId": state["activeConversationId"],
            "chatModel": CHAT_MODEL,
            "promptModel": PROMPT_MODEL,
        }
    )

@app.get("/api/profile")
def get_profile():
    state = load_store()
    return jsonify({"profile": state["profile"]})

@app.patch("/api/profile")
def patch_profile():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    def mutate(state):
        for key in DEFAULT_PROFILE:
            if key in payload:
                state["profile"][key] = str(payload.get(key) or "")
    state, _ = update_store(mutate)
    return jsonify({"profile": state["profile"]})

@app.get("/api/theme")
def get_theme():
    state = load_store()
    return jsonify({"theme": state["theme"]})

@app.patch("/api/theme")
def patch_theme():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    theme = str(payload.get("theme") or "").strip()
    if theme not in {"auto", "light", "dark"}:
        return json_error("Invalid theme", 400)
    def mutate(state):
        state["theme"] = theme
    update_store(mutate)
    return jsonify({"theme": theme})

@app.get("/api/conversations")
def list_conversations():
    state = load_store()
    sort_conversations(state)
    return jsonify(
        {
            "conversations": [conversation_summary(conversation) for conversation in state["conversations"]],
            "activeConversationId": state["activeConversationId"],
        }
    )

@app.post("/api/conversations")
def create_conversation_endpoint():
    payload = request.get_json(silent=True) if request.is_json else {}
    if not isinstance(payload, dict):
        payload = {}
    def mutate(state):
        return create_conversation(state, payload.get("title"))
    state, created = update_store(mutate)
    conversation = get_conversation(state, created["id"])
    return jsonify({"conversation": serialize_conversation(conversation)}), 201

@app.get("/api/conversations/<conversation_id>")
def get_conversation_endpoint(conversation_id):
    state = load_store()
    conversation = get_conversation(state, conversation_id)
    if conversation is None:
        return json_error("Conversation not found", 404)
    return jsonify({"conversation": serialize_conversation(conversation)})

@app.patch("/api/conversations/<conversation_id>")
def patch_conversation(conversation_id):
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    validation_error = None
    def mutate(state):
        nonlocal validation_error
        conversation = get_conversation(state, conversation_id)
        if conversation is None:
            validation_error = ("Conversation not found", 404)
            return None
        if "title" in payload:
            title = str(payload.get("title") or "").strip()
            conversation["title"] = title or DEFAULT_CONVERSATION_TITLE
        if "messages" in payload:
            messages = payload.get("messages")
            if not isinstance(messages, list):
                validation_error = ("messages must be a list", 400)
                return None
            clean_messages = []
            for message in messages:
                normalized = normalize_message(message)
                if normalized and normalized["role"] in {"user", "assistant"}:
                    clean_messages.append(normalized)
            conversation["messages"] = clean_messages
        conversation["updatedAt"] = now_ts()
        sort_conversations(state)
        return conversation["id"]
    state, updated_id = update_store(mutate)
    if validation_error:
        return json_error(*validation_error)
    conversation = get_conversation(state, updated_id)
    return jsonify({"conversation": serialize_conversation(conversation)})

@app.delete("/api/conversations/<conversation_id>")
def delete_conversation(conversation_id):
    not_found = False
    def mutate(state):
        nonlocal not_found
        index = next(
            (
                index
                for index, conversation in enumerate(state["conversations"])
                if conversation["id"] == str(conversation_id)
            ),
            None,
        )
        if index is None:
            not_found = True
            return
        removed = state["conversations"].pop(index)
        if state.get("activeConversationId") == removed["id"]:
            state["activeConversationId"] = state["conversations"][0]["id"] if state["conversations"] else None
    update_store(mutate)
    if not_found:
        return json_error("Conversation not found", 404)
    return jsonify({"ok": True})

@app.post("/api/conversations/<conversation_id>/messages")
def post_message(conversation_id):
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    content = str(payload.get("content") or "").strip()
    if not content:
        return json_error("content is required", 400)
    model = str(payload.get("model") or CHAT_MODEL).strip()
    conversation_missing = False
    upstream_messages = None
    def append_user_message(state):
        nonlocal conversation_missing
        nonlocal upstream_messages
        conversation = get_conversation(state, conversation_id)
        if conversation is None:
            conversation_missing = True
            return
        conversation["messages"].append({"role": "user", "content": content})
        conversation["updatedAt"] = now_ts()
        state["activeConversationId"] = conversation["id"]
        upstream_messages = [{"role": "system", "content": build_system_prompt(state["profile"])}, *conversation["messages"]]
        sort_conversations(state)
    update_store(append_user_message)
    if conversation_missing:
        return json_error("Conversation not found", 404)
    try:
        status_code, data = request_upstream_chat(upstream_messages, model=model)
        assistant_content = extract_assistant_content(data)
        if status_code >= 400:
            assistant_content = f"خطا در دریافت پاسخ از سرویس مدل.\n\nStatus: {status_code}\nDetails: {assistant_content or data}"
        if not assistant_content:
            assistant_content = "پاسخی دریافت نشد."
        assistant_message = {"role": "assistant", "content": assistant_content}
        def append_assistant_message(state):
            conversation = get_conversation(state, conversation_id)
            if conversation is None:
                return None
            conversation["messages"].append(assistant_message)
            conversation["updatedAt"] = now_ts()
            if len(conversation["messages"]) == 2:
                first_user_message = next(
                    (message for message in conversation["messages"] if message["role"] == "user"),
                    None,
                )
                if first_user_message:
                    title = generate_conversation_title(str(first_user_message.get("content") or ""))
                    if title and len(title) <= 30:
                        conversation["title"] = title
            state["activeConversationId"] = conversation["id"]
            sort_conversations(state)
            return conversation["id"]
        state, updated_id = update_store(append_assistant_message)
        conversation = get_conversation(state, updated_id)
        response_payload = {"conversation": serialize_conversation(conversation), "assistantMessage": assistant_message}
        if status_code >= 400:
            response_payload.update({"error": "Upstream request failed", "status": status_code, "details": data})
            return jsonify(response_payload), 502
        return jsonify(response_payload)
    except requests.RequestException as exc:
        assistant_message = {"role": "assistant", "content": f"خطا در دریافت پاسخ.\n\n{str(exc) or 'Unknown upstream request failure'}"}
        def append_network_error(state):
            conversation = get_conversation(state, conversation_id)
            if conversation is None:
                return None
            conversation["messages"].append(assistant_message)
            conversation["updatedAt"] = now_ts()
            sort_conversations(state)
            return conversation["id"]
        state, updated_id = update_store(append_network_error)
        conversation = get_conversation(state, updated_id)
        return jsonify({"error": "Upstream request failed", "details": str(exc), "conversation": serialize_conversation(conversation), "assistantMessage": assistant_message}), 502

@app.post("/api/chat")
def chat_legacy():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    if not payload.get("model"):
        payload["model"] = CHAT_MODEL
    try:
        response = requests.post(
            GAPGPT_API_URL,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
            json=payload,
            timeout=120,
        )
        try:
            data = response.json()
        except ValueError:
            data = {"raw": response.text}
        return jsonify(data), response.status_code
    except requests.RequestException as exc:
        return jsonify({"error": "Upstream request failed", "details": str(exc)}), 502

@app.get("/api/images")
def get_saved_images():
    images = get_saved_images_from_disk()
    return jsonify({"images": images})

@app.post("/api/images/save")
def save_image():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    image_url = str(payload.get("url") or "").strip()
    if not image_url:
        return json_error("url is required", 400)
    try:
        response = requests.get(image_url, timeout=30)
        if response.status_code != 200:
            return json_error("Failed to download image from URL", 502)
        content_hash = hashlib.md5(response.content).hexdigest()
        timestamp = now_ts()
        filename = f"{timestamp}_{content_hash}_{os.urandom(4).hex()}.png"
        filepath = IMAGES_DIR / filename
        with open(filepath, "wb") as f:
            f.write(response.content)
        saved_url = f"/api/images/static/{filename}"
        return jsonify({"ok": True, "url": saved_url})
    except requests.RequestException as exc:
        return json_error(f"Failed to download image: {str(exc)}", 502)

@app.delete("/api/images/<path:image_url>")
def delete_image(image_url):
    filename = image_url.split("/")[-1]
    filepath = IMAGES_DIR / filename
    try:
        if filepath.exists():
            filepath.unlink()
    except OSError:
        pass
    return jsonify({"ok": True})

@app.get("/api/images/static/<path:filename>")
def serve_image(filename):
    return send_from_directory(str(IMAGES_DIR), filename)

@app.post("/api/images/generate")
def generate_image():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    user_prompt = str(payload.get("prompt") or "").strip()
    if not user_prompt:
        return json_error("prompt is required", 400)
    enhanced_prompt = user_prompt
    try:
        chat_response = requests.post(
            GAPGPT_API_URL,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
            json={
                "model": PROMPT_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are an expert prompt engineer for AI image generation. Your task is to take a simple user description and expand it into a detailed, creative, and visually rich image prompt in Persian. The output should be only the prompt, no extra text. Keep it under 100 words. Focus on style, lighting, composition, and atmosphere."
                    },
                    {"role": "user", "content": f"Create a detailed image prompt based on this: {user_prompt}"}
                ],
            },
            timeout=30,
        )
        if chat_response.status_code == 200:
            chat_data = chat_response.json()
            choices = chat_data.get("choices", [])
            if choices and choices[0].get("message"):
                enhanced_prompt = choices[0]["message"]["content"].strip()
                if not enhanced_prompt:
                    enhanced_prompt = user_prompt
        else:
            enhanced_prompt = user_prompt
    except Exception:
        enhanced_prompt = user_prompt
    try:
        response = requests.post(
            IMAGE_API_URL,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
            json={
                "model": IMAGE_MODEL,
                "prompt": enhanced_prompt,
                "size": IMAGE_SIZE
            },
            timeout=60,
        )
        if response.status_code != 200:
            try:
                error_data = response.json()
            except:
                error_data = {"raw": response.text}
            return json_error(f"Image generation failed: {error_data}", status=response.status_code)
        data = response.json()
        image_url = data.get("data", [{}])[0].get("url")
        if not image_url:
            return json_error("No image URL returned from API", 502)
        return jsonify({"imageUrl": image_url, "enhancedPrompt": enhanced_prompt, "userPrompt": user_prompt})
    except requests.RequestException as exc:
        return json_error(f"Image generation request failed: {str(exc)}", 502)

@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Internal server error"}), 500

if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=os.getenv("FLASK_DEBUG", "0") == "1")
