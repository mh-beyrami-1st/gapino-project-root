import base64
import hmac
import json
import os
import secrets
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

import psycopg2
import psycopg2.extras
import psycopg2.pool
import requests
from dotenv import load_dotenv
from flask import (
    Flask,
    Response,
    g,
    jsonify,
    redirect,
    request,
    send_from_directory,
    stream_with_context,
)
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
FRONTEND_DIR = BASE_DIR / "frontend"
DATABASE_URL = os.getenv("DATABASE_URL")
DATABASE_LOCK = RLock()

USE_LOCAL_POOL = os.getenv("USE_LOCAL_POOL", "1") == "1"
_DB_POOL = None
_DB_POOL_LOCK = RLock()
_POOL_FAILED = False

STATE_CACHE = {}
STATE_CACHE_TTL = 30.0
STATE_CACHE_LOCK = RLock()

SCHEMA_VERSION = "4"
DEFAULT_MODEL_ID = "gpt-5.6-sol"


app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False

PORT = int(os.getenv("PORT", 3000))
HOST = os.getenv("HOST", "0.0.0.0")
GAPGPT_API_KEY = os.getenv("GAPGPT_API_KEY")
GAPGPT_API_URL = os.getenv("GAPGPT_API_URL")
IMAGE_GENERATION_API_URL = os.getenv("IMAGE_GENERATION_API_URL") or (GAPGPT_API_URL or "").replace(
    "/chat/completions", "/images/generations"
)
PROMPT_MODEL = "gemini-3.1-flash-lite"
SESSION_TTL = 60 * 60 * 24 * 30
SESSION_COOKIE_NAME = "gapino_session"
SESSION_SERIALIZER = URLSafeTimedSerializer(
    os.getenv("SESSION_SECRET") or GAPGPT_API_KEY,
    salt="gapino-session",
)
SUPPORTED_CHAT_MODELS = frozenset(
    {
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gemini-3.1-pro-preview",
        "gemini-3.6-flash",
        "gemini-3.1-flash-lite",
    }
)
IMAGE_INPUT_MODEL = "gpt-5.6-sol"
IMAGE_GENERATION_MODELS = {
    "gpt": "gpt-image-1-mini",
    "gemini": "gapgpt/z-image",
}
DEFAULT_USERS = {
    "admin": "Mohammad1389",
    "user": "123456",
}

if not GAPGPT_API_KEY:
    raise RuntimeError("Missing GAPGPT_API_KEY in .env")
if not GAPGPT_API_URL:
    raise RuntimeError("Missing GAPGPT_API_URL in .env")


class PostgreSQLConnection:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return self.connection.__exit__(exc_type, exc_value, traceback)

    def cursor(self):
        return self.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def execute(self, query, parameters=None):
        cursor = self.cursor()
        cursor.execute(query, parameters)
        return cursor

    def executemany(self, query, parameters):
        cursor = self.cursor()
        cursor.executemany(query, parameters)
        return cursor

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def close(self):
        try:
            self.connection.close()
        except Exception:
            pass


def _get_pool():
    global _DB_POOL, _POOL_FAILED
    if not USE_LOCAL_POOL or _POOL_FAILED:
        return None
    if _DB_POOL is not None:
        return _DB_POOL
    with _DB_POOL_LOCK:
        if _DB_POOL is not None:
            return _DB_POOL
        try:
            _DB_POOL = psycopg2.pool.ThreadedConnectionPool(
                minconn=2,
                maxconn=8,
                dsn=DATABASE_URL,
                connect_timeout=15,
                options="-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
            )
            return _DB_POOL
        except Exception:
            _POOL_FAILED = True
            return None


def _connect_raw():
    try:
        return psycopg2.connect(
            DATABASE_URL,
            connect_timeout=15,
            options="-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
        )
    except Exception:
        return psycopg2.connect(DATABASE_URL, connect_timeout=15)


@contextmanager
def database_connection():
    if not DATABASE_URL:
        raise RuntimeError("Missing DATABASE_URL in .env")

    pool = _get_pool()
    if pool is not None:
        raw = None
        try:
            raw = pool.getconn()
            if raw.closed:
                pool.putconn(raw, close=True)
                raw = pool.getconn()
        except Exception:
            raw = None
        if raw is not None:
            wrapper = PostgreSQLConnection(raw)
            try:
                yield wrapper
            except Exception:
                try:
                    raw.rollback()
                except Exception:
                    pass
                raise
            finally:
                try:
                    if raw.closed:
                        pool.putconn(raw, close=True)
                    else:
                        raw.rollback()
                        pool.putconn(raw)
                except Exception:
                    try:
                        pool.putconn(raw, close=True)
                    except Exception:
                        pass
            return

    connection = None
    in_request = False
    try:
        connection = getattr(g, "_db_connection", None)
        in_request = True
    except RuntimeError:
        in_request = False

    if connection is None:
        raw = _connect_raw()
        connection = PostgreSQLConnection(raw)
        if in_request:
            g._db_connection = connection

    try:
        yield connection
    except Exception:
        try:
            connection.rollback()
        except Exception:
            pass
        raise
    finally:
        if not in_request:
            try:
                connection.close()
            except Exception:
                pass


@app.teardown_appcontext
def _teardown_db_connection(exc):
    connection = g.pop("_db_connection", None)
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            pass
        try:
            connection.close()
        except Exception:
            pass


_INIT_DONE = False


def _fast_init():
    global _INIT_DONE
    if _INIT_DONE:
        return True
    try:
        with database_connection() as connection:
            cursor = connection.execute(
                "SELECT value FROM app_state WHERE key = %s",
                ("schema_version",),
            )
            row = cursor.fetchone()
            if row and row["value"] == SCHEMA_VERSION:
                _INIT_DONE = True
                return True
            return False
    except Exception:
        return False


def initialize_database():
    global _INIT_DONE
    if _fast_init():
        return
    with database_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                owner_username TEXT NOT NULL DEFAULT 'admin',
                title TEXT NOT NULL,
                model_id TEXT,
                pinned BOOLEAN NOT NULL DEFAULT FALSE,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                image TEXT,
                image_url TEXT,
                message_key TEXT,
                parent_key TEXT,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
                ON messages(session_id, timestamp, id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_timestamp_unique
                ON messages(session_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_conversations_owner
                ON conversations(owner_username, updated_at DESC);
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                username TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
                ON sessions(expires_at);
                """)
            cursor.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name IN ('messages', 'conversations', 'sessions')"
            )
            columns_by_table = {}
            for row in cursor.fetchall():
                columns_by_table.setdefault(row["table_name"], set()).add(row["column_name"])
            message_columns = columns_by_table.get("messages", set())
            conversation_columns = columns_by_table.get("conversations", set())
            session_columns = columns_by_table.get("sessions", set())
            if "owner_username" not in conversation_columns:
                cursor.execute("ALTER TABLE conversations ADD COLUMN owner_username TEXT NOT NULL DEFAULT 'admin'")
            if "model_id" not in conversation_columns:
                cursor.execute("ALTER TABLE conversations ADD COLUMN model_id TEXT")
            if "pinned" not in conversation_columns:
                cursor.execute("ALTER TABLE conversations ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE")
            if "username" not in session_columns:
                cursor.execute("ALTER TABLE sessions ADD COLUMN username TEXT NOT NULL DEFAULT 'admin'")
            if "image" not in message_columns:
                cursor.execute("ALTER TABLE messages ADD COLUMN image TEXT")
            if "image_url" not in message_columns:
                cursor.execute("ALTER TABLE messages ADD COLUMN image_url TEXT")
            if "message_key" not in message_columns:
                cursor.execute("ALTER TABLE messages ADD COLUMN message_key TEXT")
            if "parent_key" not in message_columns:
                cursor.execute("ALTER TABLE messages ADD COLUMN parent_key TEXT")
            cursor.execute(
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'timestamp'"
            )
            timestamp_column = cursor.fetchone()
            if timestamp_column and timestamp_column["data_type"] != "bigint":
                cursor.execute("ALTER TABLE messages ALTER COLUMN timestamp TYPE BIGINT")
            cursor.execute(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                ("schema_version", SCHEMA_VERSION),
            )
        connection.commit()
    _INIT_DONE = True


initialize_database()

DEFAULT_PROFILE = {"name": "", "job": "", "systemPrompt": "", "responseStyle": ""}
DEFAULT_THEME = "auto"
DEFAULT_ACTIVE_CONVERSATION_ID = None
DEFAULT_CONVERSATION_TITLE = "گفت‌وگوی جدید"


def now_ts():
    return int(time.time())


def now_ts_ms():
    return int(time.time() * 1000)


def json_error(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status


def repair_mojibake(value):
    if not isinstance(value, str):
        return value
    mojibake_markers = ("Ø", "Ù", "Ú", "â", "Ã", "\x80", "\x8c", "\x9d")
    if not any(marker in value for marker in mojibake_markers):
        return value
    try:
        repaired = value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    return repaired if any("\u0600" <= char <= "\u06ff" for char in repaired) else value


def normalize_model_id(model_id):
    model_id = str(model_id or "").strip()
    if model_id not in SUPPORTED_CHAT_MODELS:
        return DEFAULT_MODEL_ID
    return model_id


def verify_credentials(username, password):
    normalized_username = str(username or "").strip().lower()
    expected_password = DEFAULT_USERS.get(normalized_username)
    if not expected_password:
        return False
    return hmac.compare_digest(
        str(password or "").encode("utf-8"),
        expected_password.encode("utf-8"),
    )


def issue_session_token(username):
    token = SESSION_SERIALIZER.dumps({"username": username})
    now = now_ts()
    with DATABASE_LOCK:
        with database_connection() as connection:
            with connection:
                connection.execute(
                    "INSERT INTO sessions (token, username, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                    (token, username, now, now + SESSION_TTL),
                )
                connection.execute("DELETE FROM sessions WHERE expires_at < %s", (now,))
    return token


def is_valid_session(token):
    if not token:
        return False
    try:
        payload = SESSION_SERIALIZER.loads(token, max_age=SESSION_TTL)
        return str(payload.get("username") or "").lower() in DEFAULT_USERS
    except (BadSignature, SignatureExpired, AttributeError):
        pass
    return False


def revoke_session(token):
    if not token:
        return
    with DATABASE_LOCK:
        with database_connection() as connection:
            with connection:
                connection.execute("DELETE FROM sessions WHERE token = %s", (token,))


def get_session_token():
    return request.cookies.get(SESSION_COOKIE_NAME, "")


def get_current_username():
    token = get_session_token()
    if not token:
        return ""
    try:
        payload = SESSION_SERIALIZER.loads(token, max_age=SESSION_TTL)
        username = str(payload.get("username") or "").lower()
        return username if username in DEFAULT_USERS else ""
    except (BadSignature, SignatureExpired, AttributeError):
        return ""


def invalidate_state_cache(owner_username=None):
    with STATE_CACHE_LOCK:
        if owner_username:
            STATE_CACHE.pop(owner_username, None)
        else:
            STATE_CACHE.clear()


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
    normalized = {"role": role, "content": repair_mojibake(str(content))}
    image = message.get("image")
    if isinstance(image, str) and image.startswith("data:image/"):
        normalized["image"] = image
    image_url = message.get("imageUrl") or message.get("image_url")
    if isinstance(image_url, str) and image_url.startswith(("https://", "http://", "data:image/")):
        normalized["imageUrl"] = image_url
    if "name" in message:
        normalized["name"] = str(message.get("name") or "")
    if message.get("_id"):
        normalized["_id"] = str(message["_id"])
    if message.get("_parentId"):
        normalized["_parentId"] = str(message["_parentId"])
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
        model_id = normalize_model_id(conversation.get("modelId") or conversation.get("model_id"))
        pinned = bool(conversation.get("pinned", False))
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
                "modelId": model_id,
                "pinned": pinned,
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


def _load_store_unlocked(owner_username="admin"):
    with database_connection() as connection:
        conversations = []
        conversation_rows = connection.execute(
            "SELECT id, title, model_id, pinned, created_at, updated_at FROM conversations "
            "WHERE owner_username = %s ORDER BY updated_at DESC, created_at DESC",
            (owner_username,),
        ).fetchall()
        message_rows = connection.execute(
            "SELECT m.session_id, m.role, m.content, m.image, m.image_url, m.message_key, m.parent_key "
            "FROM messages m JOIN conversations c ON c.id = m.session_id "
            "WHERE c.owner_username = %s ORDER BY m.timestamp ASC, m.id ASC",
            (owner_username,),
        ).fetchall()
        messages_by_session = {}
        for row in message_rows:
            messages_by_session.setdefault(row["session_id"], []).append(
                {
                    "role": row["role"],
                    "content": row["content"],
                    **({"image": row["image"]} if row["image"] else {}),
                    **({"imageUrl": row["image_url"]} if row["image_url"] else {}),
                    **({"_id": row["message_key"]} if row["message_key"] else {}),
                    **({"_parentId": row["parent_key"]} if row["parent_key"] else {}),
                }
            )
        for row in conversation_rows:
            conversations.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "modelId": row["model_id"] or DEFAULT_MODEL_ID,
                    "pinned": bool(row["pinned"]),
                    "messages": messages_by_session.get(row["id"], []),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
            )
        state_values = {
            row["key"]: row["value"]
            for row in connection.execute(
                "SELECT key, value FROM app_state WHERE key LIKE %s", (f"{owner_username}:%",)
            ).fetchall()
        }
    state = default_state()
    try:
        state["profile"] = json.loads(state_values.get(f"{owner_username}:profile", "{}"))
    except json.JSONDecodeError:
        state["profile"] = {}
    state["theme"] = state_values.get(f"{owner_username}:theme", DEFAULT_THEME)
    state["activeConversationId"] = state_values.get(f"{owner_username}:activeConversationId")
    state["conversations"] = conversations
    return normalize_state(state)


def _save_store_unlocked(state, owner_username="admin"):
    normalized = normalize_state(state)
    with database_connection() as connection:
        with connection:
            current_ids = [c["id"] for c in normalized["conversations"]]
            if current_ids:
                placeholders = ",".join(["%s"] * len(current_ids))
                connection.execute(
                    f"DELETE FROM conversations WHERE owner_username = %s AND id NOT IN ({placeholders})",
                    (owner_username, *current_ids),
                )
            else:
                connection.execute(
                    "DELETE FROM conversations WHERE owner_username = %s",
                    (owner_username,),
                )
            for conversation in normalized["conversations"]:
                connection.execute(
                    """
                    INSERT INTO conversations (id, owner_username, title, model_id, pinned, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        title = EXCLUDED.title,
                        model_id = EXCLUDED.model_id,
                        pinned = EXCLUDED.pinned,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        conversation["id"],
                        owner_username,
                        conversation["title"],
                        conversation["modelId"],
                        conversation["pinned"],
                        conversation["createdAt"],
                        conversation["updatedAt"],
                    ),
                )
            for conversation in normalized["conversations"]:
                messages = conversation["messages"]
                current_keys = [m.get("_id") for m in messages if m.get("_id")]
                if current_keys:
                    placeholders = ",".join(["%s"] * len(current_keys))
                    connection.execute(
                        f"DELETE FROM messages WHERE session_id = %s AND message_key IS NOT NULL AND message_key NOT IN ({placeholders})",
                        (conversation["id"], *current_keys),
                    )
                else:
                    connection.execute(
                        "DELETE FROM messages WHERE session_id = %s AND message_key IS NOT NULL",
                        (conversation["id"],),
                    )
                current_timestamps = [conversation["createdAt"] + i for i in range(len(messages))]
                if current_timestamps:
                    placeholders = ",".join(["%s"] * len(current_timestamps))
                    connection.execute(
                        f"DELETE FROM messages WHERE session_id = %s AND timestamp NOT IN ({placeholders})",
                        (conversation["id"], *current_timestamps),
                    )
                else:
                    connection.execute(
                        "DELETE FROM messages WHERE session_id = %s",
                        (conversation["id"],),
                    )
            all_messages = []
            for conversation in normalized["conversations"]:
                for index, message in enumerate(conversation["messages"]):
                    all_messages.append(
                        (
                            conversation["id"],
                            message["role"],
                            message["content"],
                            message.get("image"),
                            message.get("imageUrl"),
                            message.get("_id"),
                            message.get("_parentId"),
                            conversation["createdAt"] + index,
                        )
                    )
            if all_messages:
                connection.executemany(
                    """
                    INSERT INTO messages (session_id, role, content, image, image_url, message_key, parent_key, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (session_id, timestamp) DO UPDATE SET
                        role = EXCLUDED.role,
                        content = EXCLUDED.content,
                        image = EXCLUDED.image,
                        image_url = EXCLUDED.image_url,
                        message_key = EXCLUDED.message_key,
                        parent_key = EXCLUDED.parent_key
                    """,
                    all_messages,
                )
            state_values = {
                f"{owner_username}:profile": json.dumps(normalized["profile"], ensure_ascii=False),
                f"{owner_username}:theme": normalized["theme"],
                f"{owner_username}:activeConversationId": normalized["activeConversationId"] or "",
            }
            connection.executemany(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                state_values.items(),
            )
    return normalized


def load_store(owner_username=None):
    owner_username = owner_username or get_current_username() or "admin"
    now = time.time()
    with STATE_CACHE_LOCK:
        cached = STATE_CACHE.get(owner_username)
        if cached and now - cached["ts"] < STATE_CACHE_TTL:
            return cached["state"]
    with DATABASE_LOCK:
        state = _load_store_unlocked(owner_username)
    with STATE_CACHE_LOCK:
        STATE_CACHE[owner_username] = {"state": state, "ts": time.time()}
    return state


def update_store(mutator, owner_username=None):
    owner_username = owner_username or get_current_username() or "admin"
    with DATABASE_LOCK:
        state = _load_store_unlocked(owner_username)
        result = mutator(state)
        state = _save_store_unlocked(state, owner_username)
    with STATE_CACHE_LOCK:
        STATE_CACHE[owner_username] = {"state": state, "ts": time.time()}
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
        "modelId": conversation.get("modelId") or DEFAULT_MODEL_ID,
        "pinned": bool(conversation.get("pinned", False)),
        "messageCount": len(messages),
        "createdAt": conversation.get("createdAt"),
        "updatedAt": conversation.get("updatedAt"),
        "lastMessage": messages[-1] if messages else None,
    }


def serialize_conversation(conversation):
    return {
        "id": conversation["id"],
        "title": conversation.get("title") or DEFAULT_CONVERSATION_TITLE,
        "modelId": conversation.get("modelId") or DEFAULT_MODEL_ID,
        "pinned": bool(conversation.get("pinned", False)),
        "messages": conversation.get("messages") or [],
        "createdAt": conversation.get("createdAt"),
        "updatedAt": conversation.get("updatedAt"),
    }


def _insert_conversation_row(conversation, owner_username):
    with database_connection() as connection:
        with connection:
            connection.execute(
                "INSERT INTO conversations (id, owner_username, title, model_id, pinned, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    conversation["id"],
                    owner_username,
                    conversation["title"],
                    conversation["modelId"],
                    conversation["pinned"],
                    conversation["createdAt"],
                    conversation["updatedAt"],
                ),
            )
            connection.execute(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (f"{owner_username}:activeConversationId", conversation["id"]),
            )
    invalidate_state_cache(owner_username)


def _delete_conversation_row(conversation_id, owner_username):
    with database_connection() as connection:
        with connection:
            cursor = connection.execute(
                "DELETE FROM conversations WHERE id = %s AND owner_username = %s RETURNING id",
                (str(conversation_id), owner_username),
            )
            deleted = cursor.fetchone()
            if not deleted:
                return False
            connection.execute(
                "DELETE FROM app_state WHERE key = %s AND value = %s",
                (f"{owner_username}:activeConversationId", str(conversation_id)),
            )
    invalidate_state_cache(owner_username)
    return True


def _set_active_conversation(conversation_id, owner_username):
    with database_connection() as connection:
        with connection:
            if conversation_id:
                cursor = connection.execute(
                    "SELECT 1 FROM conversations WHERE id = %s AND owner_username = %s",
                    (str(conversation_id), owner_username),
                )
                if not cursor.fetchone():
                    return False
                connection.execute(
                    "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    (f"{owner_username}:activeConversationId", str(conversation_id)),
                )
            else:
                connection.execute(
                    "DELETE FROM app_state WHERE key = %s",
                    (f"{owner_username}:activeConversationId",),
                )
    invalidate_state_cache(owner_username)
    return True


def _set_theme(theme, owner_username):
    with database_connection() as connection:
        with connection:
            connection.execute(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (f"{owner_username}:theme", theme),
            )
    invalidate_state_cache(owner_username)


def _set_profile(profile, owner_username):
    with database_connection() as connection:
        with connection:
            connection.execute(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (
                    f"{owner_username}:profile",
                    json.dumps(profile, ensure_ascii=False),
                ),
            )
    invalidate_state_cache(owner_username)


def _get_profile(owner_username):
    with database_connection() as connection:
        cursor = connection.execute(
            "SELECT value FROM app_state WHERE key = %s",
            (f"{owner_username}:profile",),
        )
        row = cursor.fetchone()
    if not row:
        return dict(DEFAULT_PROFILE)
    try:
        data = json.loads(row["value"])
    except json.JSONDecodeError:
        return dict(DEFAULT_PROFILE)
    result = {}
    for key, fallback in DEFAULT_PROFILE.items():
        result[key] = str(data.get(key, fallback) or "")
    return result


def _append_message_to_conversation(conversation_id, message, owner_username, model_id=None, title=None):
    now = now_ts()
    msg_ts = now_ts_ms()
    with database_connection() as connection:
        with connection:
            cursor = connection.execute(
                "SELECT 1 FROM conversations WHERE id = %s AND owner_username = %s",
                (str(conversation_id), owner_username),
            )
            if not cursor.fetchone():
                return False

            connection.execute(
                """
                INSERT INTO messages (session_id, role, content, image, image_url, message_key, parent_key, timestamp)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (session_id, timestamp) DO UPDATE SET
                    role = EXCLUDED.role,
                    content = EXCLUDED.content,
                    image = EXCLUDED.image,
                    image_url = EXCLUDED.image_url,
                    message_key = EXCLUDED.message_key,
                    parent_key = EXCLUDED.parent_key
                """,
                (
                    str(conversation_id),
                    message.get("role") or "user",
                    message.get("content") or "",
                    message.get("image"),
                    message.get("imageUrl"),
                    message.get("_id"),
                    message.get("_parentId"),
                    msg_ts,
                ),
            )

            if model_id and title:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s, model_id = %s, title = %s WHERE id = %s",
                    (now, model_id, title, str(conversation_id)),
                )
            elif model_id:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s, model_id = %s WHERE id = %s",
                    (now, model_id, str(conversation_id)),
                )
            elif title:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s, title = %s WHERE id = %s",
                    (now, title, str(conversation_id)),
                )
            else:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s WHERE id = %s",
                    (now, str(conversation_id)),
                )

            connection.execute(
                "INSERT INTO app_state (key, value) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (f"{owner_username}:activeConversationId", str(conversation_id)),
            )

    invalidate_state_cache(owner_username)
    return True


def _load_conversation_messages(conversation_id, owner_username):
    with database_connection() as connection:
        rows = connection.execute(
            "SELECT m.role, m.content, m.image, m.image_url, m.message_key, m.parent_key "
            "FROM messages m JOIN conversations c ON c.id = m.session_id "
            "WHERE m.session_id = %s AND c.owner_username = %s "
            "ORDER BY m.timestamp ASC, m.id ASC",
            (str(conversation_id), owner_username),
        ).fetchall()
    return [
        {
            "role": row["role"],
            "content": row["content"],
            **({"image": row["image"]} if row["image"] else {}),
            **({"imageUrl": row["image_url"]} if row["image_url"] else {}),
            **({"_id": row["message_key"]} if row["message_key"] else {}),
            **({"_parentId": row["parent_key"]} if row["parent_key"] else {}),
        }
        for row in rows
    ]


def _load_conversation_meta(conversation_id, owner_username):
    with database_connection() as connection:
        cursor = connection.execute(
            "SELECT id, title, model_id, pinned, created_at, updated_at "
            "FROM conversations WHERE id = %s AND owner_username = %s",
            (str(conversation_id), owner_username),
        )
        row = cursor.fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "title": row["title"],
        "modelId": row["model_id"] or DEFAULT_MODEL_ID,
        "pinned": bool(row["pinned"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _update_conversation_fields(conversation_id, owner_username, title=None, model_id=None, pinned=None):
    sets = []
    values = []
    if title is not None:
        sets.append("title = %s")
        values.append(title)
    if model_id is not None:
        sets.append("model_id = %s")
        values.append(model_id)
    if pinned is not None:
        sets.append("pinned = %s")
        values.append(pinned)
    sets.append("updated_at = %s")
    values.append(now_ts())
    values.extend([str(conversation_id), owner_username])
    with database_connection() as connection:
        with connection:
            cursor = connection.execute(
                f"UPDATE conversations SET {', '.join(sets)} WHERE id = %s AND owner_username = %s RETURNING id",
                tuple(values),
            )
            updated = cursor.fetchone()
    if not updated:
        return False
    invalidate_state_cache(owner_username)
    return True


def _replace_conversation_messages(conversation_id, messages, owner_username, title=None):
    now = now_ts()
    with database_connection() as connection:
        with connection:
            cursor = connection.execute(
                "SELECT 1 FROM conversations WHERE id = %s AND owner_username = %s",
                (str(conversation_id), owner_username),
            )
            if not cursor.fetchone():
                return False

            connection.execute(
                "DELETE FROM messages WHERE session_id = %s",
                (str(conversation_id),),
            )

            rows = []
            for index, message in enumerate(messages):
                rows.append(
                    (
                        str(conversation_id),
                        message.get("role") or "user",
                        message.get("content") or "",
                        message.get("image"),
                        message.get("imageUrl"),
                        message.get("_id"),
                        message.get("_parentId"),
                        now_ts_ms() + index,
                    )
                )
            if rows:
                connection.executemany(
                    """
                    INSERT INTO messages (session_id, role, content, image, image_url, message_key, parent_key, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    rows,
                )

            if title is not None:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s, title = %s WHERE id = %s",
                    (now, title, str(conversation_id)),
                )
            else:
                connection.execute(
                    "UPDATE conversations SET updated_at = %s WHERE id = %s",
                    (now, str(conversation_id)),
                )
    invalidate_state_cache(owner_username)
    return True


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


def request_upstream_chat(messages, model):
    payload = {"model": model, "messages": messages}
    response = requests.post(
        GAPGPT_API_URL,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
        json=payload,
        timeout=120,
    )
    response.encoding = "utf-8"
    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}
    return response.status_code, data


def extract_stream_delta(data):
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    choice = choices[0]
    delta = choice.get("delta")
    if isinstance(delta, dict):
        value = delta.get("content")
        if isinstance(value, str):
            return repair_mojibake(value)
    message = choice.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return repair_mojibake(message["content"])
    return ""


def upstream_message(message):
    if message.get("role") == "user" and message.get("image"):
        return {
            "role": "user",
            "content": [
                {"type": "text", "text": str(message.get("content") or "")},
                {"type": "image_url", "image_url": {"url": message["image"]}},
            ],
        }
    return {"role": message["role"], "content": str(message.get("content") or "")}


def wants_image_generation(content):
    text = str(content or "").lower()
    image_words = ("عکس", "تصویر", "تصویری", "image", "photo", "picture", "artwork")
    request_words = (
        "بساز",
        "بسازید",
        "ساخت",
        "تولید",
        "درست کن",
        "درستش کن",
        "بکش",
        "طراحی کن",
        "رندر کن",
        "میخوام",
        "می‌خوام",
        "می خواهم",
        "generate",
        "create",
        "make",
        "draw",
        "render",
    )
    return any(word in text for word in image_words) and any(word in text for word in request_words)


def provider_for_model(model):
    return "gpt" if str(model).startswith("gpt-") else "gemini"


def generate_image_prompt(user_content, model):
    status, data = request_upstream_chat(
        [
            {
                "role": "system",
                "content": "Turn the user's request into one polished, detailed English image-generation prompt. Preserve requested subjects, style, composition, lighting, aspect ratio and any Persian text exactly. Output only the prompt.",
            },
            {"role": "user", "content": user_content},
        ],
        model,
    )
    prompt = extract_assistant_content(data)
    return prompt if status < 400 and prompt else str(user_content)


def request_upstream_image(prompt, model):
    response = requests.post(
        IMAGE_GENERATION_API_URL,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
        json={"model": model, "prompt": prompt, "size": "1024x1024"},
        timeout=180,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}
    return response.status_code, data


def extract_generated_image_url(data):
    if not isinstance(data, dict):
        return ""
    items = data.get("data")
    if isinstance(items, list) and items and isinstance(items[0], dict):
        url = items[0].get("url")
        if url:
            return str(url)
        encoded = items[0].get("b64_json")
        if encoded:
            return f"data:image/png;base64,{encoded}"
    return str(data.get("url") or data.get("image_url") or "")


def extract_assistant_content(data):
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                return repair_mojibake(str(message.get("content") or "").strip())
    for key in ("content", "text", "answer", "response"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return repair_mojibake(value.strip())
    raw = data.get("raw")
    if isinstance(raw, str) and raw.strip():
        return repair_mojibake(raw.strip())
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
                        "content": "You are a title generator. Read the user's first message and generate a short, concise title in Persian for the conversation. The title must be a noun phrase, no more than 10 words, and strictly under 30 characters. Only output the title, nothing else.",
                    },
                    {"role": "user", "content": f"Generate title for this first message: {user_content}"},
                ],
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


PUBLIC_API_PATHS = {
    "/api/auth/login",
    "/api/auth/status",
}


@app.before_request
def require_auth():
    path = request.path or ""
    if path in PUBLIC_API_PATHS:
        return None
    if not path.startswith("/api/"):
        return None
    token = get_session_token()
    if not is_valid_session(token):
        return json_error("Authentication required", 401)
    return None


@app.get("/api/auth/status")
def auth_status():
    token = get_session_token()
    return jsonify({"authenticated": is_valid_session(token), "username": get_current_username()})


@app.post("/api/auth/login")
def auth_login():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    username = str(payload.get("username") or "")
    password = str(payload.get("password") or "")
    if not verify_credentials(username, password):
        return json_error("Invalid credentials", 401)
    token = issue_session_token(username.strip().lower())
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


@app.get("/")
def root():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/chat")
@app.get("/chat/<path:_chat_path>")
def chat_page(_chat_path=None):
    if not is_valid_session(get_session_token()):
        return redirect("/")
    if _chat_path and _chat_path.endswith("/photo.jpg"):
        chat_segment = _chat_path.rsplit("/", 1)[0]
        conversation_id = chat_segment.strip()
        conversation = next(
            (
                item
                for item in load_store().get("conversations", [])
                if "".join(char for char in item["id"] if char.isdigit()) == conversation_id
            ),
            None,
        )
        if conversation is None:
            return json_error("Conversation not found", 404)
        image_url = next(
            (
                message.get("imageUrl")
                for message in reversed(conversation.get("messages") or [])
                if message.get("imageUrl")
            ),
            "",
        )
        if not image_url:
            return json_error("Image not found", 404)
        if image_url.startswith(("https://", "http://")):
            return redirect(image_url)
        if image_url.startswith("data:image/") and "," in image_url:
            header, encoded = image_url.split(",", 1)
            try:
                return Response(base64.b64decode(encoded), mimetype=header.split(";", 1)[0].split(":", 1)[1])
            except (ValueError, IndexError):
                return json_error("Invalid image data", 500)
        return json_error("Image not found", 404)
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:frontend_path>")
def frontend_files(frontend_path):
    if frontend_path == "api" or frontend_path.startswith("api/"):
        return json_error("Not found", 404)
    requested_file = FRONTEND_DIR / frontend_path
    if requested_file.is_file():
        return send_from_directory(FRONTEND_DIR, frontend_path)
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/state")
def get_state():
    state = load_store()
    return jsonify(
        {
            "profile": state["profile"],
            "theme": state["theme"],
            "activeConversationId": state["activeConversationId"],
            "conversations": [conversation_summary(conversation) for conversation in state["conversations"]],
            "promptModel": PROMPT_MODEL,
        }
    )


@app.patch("/api/state")
def patch_state():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    owner = get_current_username() or "admin"

    if "activeConversationId" in payload:
        active_id = payload.get("activeConversationId")
        if active_id is not None:
            active_id = str(active_id)
            if not _set_active_conversation(active_id, owner):
                return json_error("Conversation not found", 404)
        else:
            _set_active_conversation(None, owner)

    if "theme" in payload:
        theme = str(payload.get("theme") or "").strip()
        if theme not in {"auto", "light", "dark"}:
            return json_error("Invalid theme", 400)
        _set_theme(theme, owner)

    if "profile" in payload:
        profile = payload.get("profile")
        if not isinstance(profile, dict):
            return json_error("profile must be an object", 400)
        current = _get_profile(owner)
        for key in DEFAULT_PROFILE:
            if key in profile:
                current[key] = str(profile.get(key) or "")
        _set_profile(current, owner)

    with STATE_CACHE_LOCK:
        cached = STATE_CACHE.get(owner)
    if cached:
        state = cached["state"]
    else:
        state = load_store(owner)
    return jsonify(
        {
            "profile": state["profile"],
            "theme": state["theme"],
            "activeConversationId": state["activeConversationId"],
            "promptModel": PROMPT_MODEL,
        }
    )


@app.get("/api/profile")
def get_profile():
    owner = get_current_username() or "admin"
    return jsonify({"profile": _get_profile(owner)})


@app.patch("/api/profile")
def patch_profile():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    owner = get_current_username() or "admin"
    current = _get_profile(owner)
    for key in DEFAULT_PROFILE:
        if key in payload:
            current[key] = str(payload.get(key) or "")
    _set_profile(current, owner)
    return jsonify({"profile": current})


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
    owner = get_current_username() or "admin"
    _set_theme(theme, owner)
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
    owner = get_current_username() or "admin"
    timestamp = now_ts()
    conversation = {
        "id": f"{timestamp}{secrets.randbelow(1_000_000):06d}",
        "title": str(payload.get("title") or DEFAULT_CONVERSATION_TITLE).strip() or DEFAULT_CONVERSATION_TITLE,
        "modelId": normalize_model_id(payload.get("modelId")),
        "pinned": False,
        "messages": [],
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }
    _insert_conversation_row(conversation, owner)
    return jsonify({"conversation": serialize_conversation(conversation)}), 201


@app.get("/api/conversations/<conversation_id>")
def get_conversation_endpoint(conversation_id):
    owner = get_current_username() or "admin"
    meta = _load_conversation_meta(conversation_id, owner)
    if meta is None:
        return json_error("Conversation not found", 404)
    meta["messages"] = _load_conversation_messages(conversation_id, owner)
    return jsonify({"conversation": serialize_conversation(meta)})


@app.patch("/api/conversations/<conversation_id>")
def patch_conversation(conversation_id):
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    owner = get_current_username() or "admin"

    title = None
    model_id = None
    pinned = None

    if "title" in payload:
        title = str(payload.get("title") or "").strip() or DEFAULT_CONVERSATION_TITLE
    if "modelId" in payload:
        model_id = str(payload.get("modelId") or "").strip()
        if model_id not in SUPPORTED_CHAT_MODELS:
            return json_error("Invalid model", 400)
    if "pinned" in payload:
        pinned = bool(payload.get("pinned"))

    if "messages" in payload:
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return json_error("messages must be a list", 400)
        clean_messages = []
        for message in messages:
            normalized = normalize_message(message)
            if normalized and normalized["role"] in {"user", "assistant"}:
                clean_messages.append(normalized)
        if not _replace_conversation_messages(conversation_id, clean_messages, owner, title):
            return json_error("Conversation not found", 404)
    else:
        if title is not None or model_id is not None or pinned is not None:
            if not _update_conversation_fields(conversation_id, owner, title, model_id, pinned):
                return json_error("Conversation not found", 404)

    meta = _load_conversation_meta(conversation_id, owner)
    if meta is None:
        return json_error("Conversation not found", 404)
    meta["messages"] = _load_conversation_messages(conversation_id, owner)
    return jsonify({"conversation": serialize_conversation(meta)})


@app.delete("/api/conversations/<conversation_id>")
def delete_conversation(conversation_id):
    owner = get_current_username() or "admin"
    if not _delete_conversation_row(conversation_id, owner):
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
    image = payload.get("image")
    if image is not None:
        image = str(image)
    if not content and not image:
        return json_error("content or image is required", 400)
    if image and (not image.startswith("data:image/") or len(image) > 7_000_000):
        return json_error("Invalid image payload", 400)
    model = str(payload.get("model") or "").strip()
    if model not in SUPPORTED_CHAT_MODELS:
        return json_error("Invalid model", 400, availableModels=sorted(SUPPORTED_CHAT_MODELS))
    if image and model != IMAGE_INPUT_MODEL:
        return json_error("Image input is only available with Sol", 400)

    owner = get_current_username() or "admin"
    meta = _load_conversation_meta(conversation_id, owner)
    if meta is None:
        return json_error("Conversation not found", 404)

    messages = _load_conversation_messages(conversation_id, owner)
    user_message = {"role": "user", "content": content}
    if image:
        user_message["image"] = image
    messages.append(user_message)

    upstream_messages = [
        {"role": "system", "content": build_system_prompt(_get_profile(owner))},
        *(upstream_message(m) for m in messages),
    ]

    _append_message_to_conversation(conversation_id, user_message, owner)

    try:
        if wants_image_generation(content):
            provider = provider_for_model(model)
            image_prompt = generate_image_prompt(content, model)
            status_code, data = request_upstream_image(image_prompt, IMAGE_GENERATION_MODELS[provider])
            image_url = extract_generated_image_url(data)
            assistant_content = ""
            if status_code < 400 and image_url:
                assistant_content = "تصویر آماده شد."
            elif status_code < 400:
                assistant_content = "تصویر تولید شد، اما نشانی فایل در پاسخ سرویس موجود نبود."
            assistant_message = {
                "role": "assistant",
                "content": assistant_content,
                **({"imageUrl": image_url} if image_url else {}),
            }
        else:
            status_code, data = request_upstream_chat(upstream_messages, model=model)
            assistant_content = extract_assistant_content(data)
            assistant_message = {"role": "assistant", "content": assistant_content}
        if status_code >= 400:
            assistant_content = (
                f"خطا در دریافت پاسخ از سرویس مدل.\n\n" f"Status: {status_code}\nDetails: {assistant_content or data}"
            )
        if not assistant_content:
            assistant_content = "پاسخی دریافت نشد."
        assistant_message["content"] = assistant_content

        title_update = None
        if len(messages) == 1:
            title = generate_conversation_title(content)
            if title and len(title) <= 30:
                title_update = title

        _append_message_to_conversation(conversation_id, assistant_message, owner, model_id=model, title=title_update)

        updated_meta = _load_conversation_meta(conversation_id, owner)
        response_payload = {
            "conversation": serialize_conversation(updated_meta),
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
        _append_message_to_conversation(conversation_id, assistant_message, owner)
        updated_meta = _load_conversation_meta(conversation_id, owner)
        return (
            jsonify(
                {
                    "error": "Upstream request failed",
                    "details": str(exc),
                    "conversation": serialize_conversation(updated_meta),
                    "assistantMessage": assistant_message,
                }
            ),
            502,
        )


@app.post("/api/conversations/<conversation_id>/messages/stream")
def stream_message(conversation_id):
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    content = str(payload.get("content") or "").strip()
    image = str(payload.get("image") or "")
    model = str(payload.get("model") or "").strip()
    client_message_id = str(payload.get("clientMessageId") or "").strip()
    if not content and not image:
        return json_error("content or image is required", 400)
    if model not in SUPPORTED_CHAT_MODELS:
        return json_error("Invalid model", 400)
    if image and model != IMAGE_INPUT_MODEL:
        return json_error("Image input is only available with Sol", 400)

    owner = get_current_username() or "admin"
    meta = _load_conversation_meta(conversation_id, owner)
    if meta is None:
        return json_error("Conversation not found", 404)

    messages = _load_conversation_messages(conversation_id, owner)
    user_message = {
        "role": "user",
        "content": content,
        "_id": client_message_id or f"user_{now_ts()}_{secrets.token_hex(3)}",
    }
    if image:
        user_message["image"] = image
    messages.append(user_message)

    context_messages = [
        {"role": "system", "content": build_system_prompt(_get_profile(owner))},
        *(upstream_message(m) for m in messages),
    ]

    _append_message_to_conversation(conversation_id, user_message, owner, model_id=model)

    def sse(event, data):
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    @stream_with_context
    def generate():
        full_content = ""
        image_url = ""
        try:
            if wants_image_generation(content):
                image_prompt = generate_image_prompt(content, model)
                status, data = request_upstream_image(image_prompt, IMAGE_GENERATION_MODELS[provider_for_model(model)])
                image_url = extract_generated_image_url(data)
                full_content = "تصویر آماده شد." if status < 400 and image_url else "تصویر تولید نشد."
                yield sse("delta", {"content": full_content, "imageUrl": image_url})
            else:
                response = requests.post(
                    GAPGPT_API_URL,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {GAPGPT_API_KEY}"},
                    json={"model": model, "messages": context_messages, "stream": True},
                    timeout=120,
                    stream=True,
                )
                response.encoding = "utf-8"
                if response.status_code >= 400:
                    try:
                        details = response.json()
                    except ValueError:
                        details = response.text
                    full_content = (
                        f"خطا در دریافت پاسخ از سرویس مدل.\n\nStatus: {response.status_code}\nDetails: {details}"
                    )
                    yield sse("delta", {"content": full_content})
                else:
                    for line in response.iter_lines(decode_unicode=True):
                        if not line or not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            delta = extract_stream_delta(json.loads(raw))
                        except json.JSONDecodeError:
                            delta = ""
                        if delta:
                            full_content += delta
                            yield sse("delta", {"content": delta})
                    if not full_content:
                        status, fallback = request_upstream_chat(context_messages, model)
                        full_content = extract_assistant_content(fallback) or "پاسخی دریافت نشد."
                        yield sse("delta", {"content": full_content})

            assistant_message = {
                "role": "assistant",
                "content": full_content or "پاسخی دریافت نشد.",
                "_id": f"assistant_{now_ts()}_{secrets.token_hex(3)}",
                "_parentId": user_message["_id"],
            }
            if image_url:
                assistant_message["imageUrl"] = image_url

            title_update = None
            if len(messages) == 1:
                title = generate_conversation_title(content)
                if title and len(title) <= 30:
                    title_update = title

            _append_message_to_conversation(conversation_id, assistant_message, owner, title=title_update)

            updated_meta = _load_conversation_meta(conversation_id, owner)
            updated_meta["messages"] = _load_conversation_messages(conversation_id, owner)
            yield sse(
                "done", {"conversation": serialize_conversation(updated_meta), "assistantMessage": assistant_message}
            )
        except requests.RequestException as exc:
            yield sse("error", {"message": str(exc) or "خطا در دریافت پاسخ"})
        except Exception as exc:  # pragma: no cover - defensive, keeps the SSE stream intact
            yield sse("error", {"message": str(exc) or "خطای نامشخص در پردازش پاسخ"})

    return Response(
        generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.post("/api/chat")
def chat_legacy():
    if not request.is_json:
        return json_error("Request must be JSON", 415)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return json_error("Invalid JSON body", 400)
    model = str(payload.get("model") or "").strip()
    if model not in SUPPORTED_CHAT_MODELS:
        return json_error("Invalid model", 400, availableModels=sorted(SUPPORTED_CHAT_MODELS))
    payload["model"] = model
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
