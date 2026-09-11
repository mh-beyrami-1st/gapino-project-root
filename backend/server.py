import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
FRONTEND_DIR = BASE_DIR / "frontend"
DATABASE_PATH = BASE_DIR / "backend" / "data" / "database.db"
DATABASE_LOCK = RLock()
ENV_LOCK = RLock()

# Static files are served explicitly below so unknown client-side routes can
# fall back to index.html (useful for PWA navigation and browser refreshes).
app = Flask(__name__, static_folder=None)

PORT = int(os.getenv("PORT", 3000))
HOST = "0.0.0.0"
GAPGPT_API_KEY = os.getenv("GAPGPT_API_KEY")
GAPGPT_API_URL = os.getenv("GAPGPT_API_URL")
CHAT_MODEL = os.getenv("CHAT_MODEL")
APP_PIN_HASH = os.getenv("APP_PIN_HASH", "")
ENV_PATH = BASE_DIR / ".env"
PROMPT_MODEL = "gemini-2.5-flash-lite"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 days
SESSION_COOKIE_NAME = "gapino_session"
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
if not APP_PIN_HASH:
    raise RuntimeError("Missing APP_PIN_HASH in .env")


@contextmanager
def database_connection():
    """Yield a configured SQLite connection and always close it afterwards."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(
        DATABASE_PATH,
        timeout=30,
        check_same_thread=False,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    try:
        yield connection
    finally:
        connection.close()


def initialize_database():
    with database_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
                ON messages(session_id, timestamp, id);
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
                ON sessions(expires_at);
            """
        )
        connection.commit()


initialize_database()

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


# ---------------------------------------------------------------------------
# Authentication helpers
# ---------------------------------------------------------------------------

def _hash_pin(pin: str) -> str:
    return "sha256:" + hashlib.sha256(pin.encode("utf-8")).hexdigest()


def verify_pin(pin: str) -> bool:
    if not APP_PIN_HASH or not pin:
        return False
    return hmac.compare_digest(_hash_pin(pin), APP_PIN_HASH)


def issue_session_token() -> str:
    token = secrets.token_urlsafe(32)
    now = now_ts()
    with DATABASE_LOCK:
        with database_connection() as connection:
            with connection:
                connection.execute(
                    "INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)",
                    (token, now, now + SESSION_TTL),
                )
                connection.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    return token


def is_valid_session(token: str) -> bool:
    if not token:
        return False
    now = now_ts()
    with DATABASE_LOCK:
        with database_connection() as connection:
            row = connection.execute(
                "SELECT expires_at FROM sessions WHERE token = ?", (token,)
            ).fetchone()
    return bool(row and row["expires_at"] > now)


def revoke_session(token: str) -> None:
    if not token:
        return
    with DATABASE_LOCK:
        with database_connection() as connection:
            with connection:
                connection.execute("DELETE FROM sessions WHERE token = ?", (token,))


def get_session_token() -> str:
    return request.cookies.get(SESSION_COOKIE_NAME, "")


# ---------------------------------------------------------------------------
# Model persistence
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

def default_state():
    return {
        "version": 2,
        "profile": dict(DEFAULT_PROFILE),
        "theme": DEFAULT_THEME,
        "activeConversationId": DEFAULT_ACTIVE_CONVERSATION_ID,
        "conversations": [],
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
    return {
        "version": 2,
        "profile": normalized_profile,
        "theme": theme,
        "activeConversationId": active_id,
        "conversations": normalized_conversations,
    }


def _load_store_unlocked():
    """Read the application state from SQLite into the API's state shape."""
    with database_connection() as connection:
        conversations = []
        conversation_rows = connection.execute(
            "SELECT id, title, created_at, updated_at FROM conversations "
            "ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        message_rows = connection.execute(
            "SELECT session_id, role, content FROM messages ORDER BY timestamp ASC, id ASC"
        ).fetchall()
        messages_by_session = {}
        for row in message_rows:
            messages_by_session.setdefault(row["session_id"], []).append(
                {"role": row["role"], "content": row["content"]}
            )
        for row in conversation_rows:
            conversations.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "messages": messages_by_session.get(row["id"], []),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
            )
        state_values = {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM app_state").fetchall()
        }
    state = default_state()
    try:
        state["profile"] = json.loads(state_values.get("profile", "{}"))
    except json.JSONDecodeError:
        state["profile"] = {}
    state["theme"] = state_values.get("theme", DEFAULT_THEME)
    state["activeConversationId"] = state_values.get("activeConversationId")
    state["conversations"] = conversations
    return normalize_state(state)


def _save_store_unlocked(state):
    """Persist a complete normalized state atomically in one SQLite transaction."""
    normalized = normalize_state(state)
    with database_connection() as connection:
        with connection:
            connection.execute("DELETE FROM messages")
            connection.execute("DELETE FROM conversations")
            connection.executemany(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [
                    (
                        conversation["id"],
                        conversation["title"],
                        conversation["createdAt"],
                        conversation["updatedAt"],
                    )
                    for conversation in normalized["conversations"]
                ],
            )
            connection.executemany(
                "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                [
                    (
                        conversation["id"],
                        message["role"],
                        message["content"],
                        conversation["createdAt"] + index,
                    )
                    for conversation in normalized["conversations"]
                    for index, message in enumerate(conversation["messages"])
                ],
            )
            state_values = {
                "profile": json.dumps(normalized["profile"], ensure_ascii=False),
                "theme": normalized["theme"],
                "activeConversationId": normalized["activeConversationId"] or "",
            }
            connection.executemany(
                "INSERT INTO app_state (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                state_values.items(),
            )
    return normalized


def load_store():
    with DATABASE_LOCK:
        return _load_store_unlocked()


def update_store(mutator):
    with DATABASE_LOCK:
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


# ---------------------------------------------------------------------------
# Auth middleware + endpoints
# ---------------------------------------------------------------------------

PUBLIC_API_PATHS = {
    "/api/auth/login",
    "/api/auth/status",
}


@app.before_request
def require_auth():
    path = request.path or ""
    # Public API endpoints
    if path in PUBLIC_API_PATHS:
        return None
    # Only guard API routes; static/front-end assets are served freely
    if not path.startswith("/api/"):
        return None
    token = get_session_token()
    if not is_valid_session(token):
        return json_error("Authentication required", 401)
    return None


@app.get("/api/auth/status")
def auth_status():
    token = get_session_token()
    return jsonify({"authenticated": is_valid_session(token)})


@app.post("/api/auth/login")
def auth_login():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    pin = str(payload.get("pin") or "")
    if not verify_pin(pin):
        return json_error("Invalid PIN", 401)
    token = issue_session_token()
    response = jsonify({"ok": True})
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="Lax",
        secure=request.is_secure,
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def auth_logout():
    token = get_session_token()
    revoke_session(token)
    response = jsonify({"ok": True})
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return response


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:frontend_path>")
def frontend_files(frontend_path):
    """Serve frontend assets and fall back to index.html for client-side routes."""
    if frontend_path == "api" or frontend_path.startswith("api/"):
        return json_error("Not found", 404)
    requested_file = FRONTEND_DIR / frontend_path
    if requested_file.is_file():
        return send_from_directory(FRONTEND_DIR, frontend_path)
    return send_from_directory(FRONTEND_DIR, "index.html")


# ---------------------------------------------------------------------------
# State / model endpoints
# ---------------------------------------------------------------------------

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
        upstream_messages = [
            {"role": "system", "content": build_system_prompt(state["profile"])},
            *conversation["messages"],
        ]
        sort_conversations(state)

    update_store(append_user_message)
    if conversation_missing:
        return json_error("Conversation not found", 404)

    try:
        status_code, data = request_upstream_chat(upstream_messages, model=model)
        assistant_content = extract_assistant_content(data)
        if status_code >= 400:
            assistant_content = (
                f"خطا در دریافت پاسخ از سرویس مدل.\n\n"
                f"Status: {status_code}\nDetails: {assistant_content or data}"
            )
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
        response_payload = {
            "conversation": serialize_conversation(conversation),
            "assistantMessage": assistant_message,
        }
        if status_code >= 400:
            response_payload.update({"error": "Upstream request failed", "status": status_code, "details": data})
            return jsonify(response_payload), 502
        return jsonify(response_payload)
    except requests.RequestException as exc:
        assistant_message = {
            "role": "assistant",
            "content": f"خطا در دریافت پاسخ.\n\n{str(exc) or 'Unknown upstream request failure'}",
        }

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
        return (
            jsonify(
                {
                    "error": "Upstream request failed",
                    "details": str(exc),
                    "conversation": serialize_conversation(conversation),
                    "assistantMessage": assistant_message,
                }
            ),
            502,
        )


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


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=os.getenv("FLASK_DEBUG", "0") == "1")