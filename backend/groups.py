"""Group chats.

The server never sees a message or a group key in the clear. A group has one
AES key per "version". The browser that makes a new version wraps (encrypts) it
once for every member, using the same ECDH keys the 1:1 chats use, and the
server just stores those wrapped copies. Messages are encrypted with the key.

The key is replaced (version + 1) whenever someone joins, so a new member can't
read what was said before they came, and after someone leaves or is removed,
so they can't read what's said after. Nothing here can decrypt anything.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import base64

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .main import (
    MAX_CT_LEN,
    avatar_url,
    blocked_either_way,
    clean_text,
    current_user,
    friend_status,
    get_conn,
    get_peer,
    manager,
)

router = APIRouter()

MAX_MEMBERS = 30
MAX_GROUPS = 50  # per person
NAME_LIMIT = 40
IV_BYTES = 12
WRAPPED_KEY_BYTES = 48  # 32 byte AES key + 16 byte GCM tag

# every message a member is allowed to see: from the key version they joined at
# onwards, and not from anyone they blocked or who blocked them
VISIBLE = (
    "m.group_id = :g AND m.key_version >= :joined AND m.sender_id NOT IN ("
    "SELECT blocked_id FROM blocks WHERE blocker_id = :me "
    "UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me)"
)

WS_KINDS = ("gmsg", "gtyping", "gread")


class WrapIn(BaseModel):
    user: str
    iv: str
    wk: str


class NewGroup(BaseModel):
    name: str
    members: list[str]
    keys: list[WrapIn]  # version 1 of the key, wrapped for everyone including me


class AddMember(BaseModel):
    username: str
    version: int  # must be the current version + 1
    keys: list[WrapIn]  # the new key, wrapped for everyone including the new member


class Rekey(BaseModel):
    version: int
    keys: list[WrapIn]


class RenameBody(BaseModel):
    name: str


# ---------- helpers ----------


def b64_len(value: str, expected: int) -> bool:
    try:
        return len(base64.b64decode(value, validate=True)) == expected
    except (ValueError, TypeError):
        return False


def blocked_ids(conn, user_id: int) -> set[int]:
    rows = conn.execute(
        "SELECT blocked_id FROM blocks WHERE blocker_id = :me "
        "UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me",
        {"me": user_id},
    ).fetchall()
    return {r[0] for r in rows}


def member_row(conn, gid: int, user_id: int):
    return conn.execute(
        "SELECT joined_version, last_read_id FROM chat_group_members "
        "WHERE group_id = ? AND user_id = ?",
        (gid, user_id),
    ).fetchone()


def get_group(conn, gid: int, user):
    """The group, but only for its members. Everyone else gets the same 404."""
    row = conn.execute(
        "SELECT g.id, g.name, g.owner_id, g.key_version, g.rekey_needed, o.username AS owner "
        "FROM chat_groups g JOIN users o ON o.id = g.owner_id WHERE g.id = ?",
        (gid,),
    ).fetchone()
    mem = member_row(conn, gid, user["id"]) if row else None
    if not row or not mem:
        raise HTTPException(404, "no such group")
    return row, mem


def members_of(conn, gid: int):
    return conn.execute(
        "SELECT u.id, u.username, u.display_name, u.avatar_id, u.public_key, "
        "m.joined_version, m.last_read_id "
        "FROM chat_group_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.group_id = ? ORDER BY m.joined_at, u.id",
        (gid,),
    ).fetchall()


def check_wraps(keys: list[WrapIn], members) -> list[tuple[int, str, str]]:
    """The wrapped keys must be for exactly the people who will be in the group."""
    by_name = {m["username"]: m for m in members}
    for m in members:
        if not m["public_key"]:
            raise HTTPException(400, f"{m['username']} hasn't set up encryption yet")
    got: dict[str, WrapIn] = {}
    for k in keys:
        name = k.user.lower()
        if name in got or name not in by_name:
            raise HTTPException(400, "the keys don't match the members")
        if not b64_len(k.iv, IV_BYTES) or not b64_len(k.wk, WRAPPED_KEY_BYTES):
            raise HTTPException(400, "that doesn't look like a wrapped key")
        got[name] = k
    if set(got) != set(by_name):
        raise HTTPException(400, "the keys don't match the members")
    return [(by_name[n]["id"], k.iv, k.wk) for n, k in got.items()]


def store_wraps(conn, gid: int, version: int, wrapper_id: int, wrapper_pub: str, wraps):
    conn.executemany(
        "INSERT INTO chat_group_keys (group_id, user_id, version, wrapper_id, wrapper_pub, iv, wk) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(gid, uid, version, wrapper_id, wrapper_pub, iv, wk) for uid, iv, wk in wraps],
    )


def my_pub(conn, user_id: int) -> str:
    row = conn.execute("SELECT public_key FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or not row["public_key"]:
        raise HTTPException(400, "your encryption key isn't set up yet")
    return row["public_key"]


def max_message_id(conn, gid: int) -> int:
    return conn.execute(
        "SELECT COALESCE(MAX(id), 0) FROM chat_group_messages WHERE group_id = ?", (gid,)
    ).fetchone()[0]


def unread_count(conn, gid: int, me_id: int, joined: int, last_read: int) -> int:
    return conn.execute(
        f"SELECT COUNT(*) FROM chat_group_messages m WHERE {VISIBLE} "
        "AND m.id > :last AND m.sender_id != :me",
        {"g": gid, "joined": joined, "me": me_id, "last": last_read},
    ).fetchone()[0]


async def notify_group(conn, gid: int, event: str, also: tuple[str, ...] = ()):
    names = {m["username"] for m in members_of(conn, gid)} | set(also)
    for name in names:
        await manager.send_user(name, {"type": "group", "event": event, "group": gid})


def summary(conn, row, me_id: int, mem) -> dict:
    last = conn.execute(
        f"SELECT MAX(m.id) FROM chat_group_messages m WHERE {VISIBLE}",
        {"g": row["id"], "joined": mem["joined_version"], "me": me_id},
    ).fetchone()[0]
    count = conn.execute(
        "SELECT COUNT(*) FROM chat_group_members WHERE group_id = ?", (row["id"],)
    ).fetchone()[0]
    return {
        "id": row["id"],
        "name": row["name"],
        "owner": row["owner"],
        "key_version": row["key_version"],
        "rekey_needed": bool(row["rekey_needed"]),
        "members": count,
        "unread": unread_count(conn, row["id"], me_id, mem["joined_version"], mem["last_read_id"]),
        "last_msg": last,
    }


def detail(conn, gid: int, user) -> dict:
    row, mem = get_group(conn, gid, user)
    out = summary(conn, row, user["id"], mem)
    out["joined_version"] = mem["joined_version"]
    out["members"] = [
        {
            "username": m["username"],
            "display_name": m["display_name"],
            "avatar": avatar_url(m["avatar_id"]),
            "pub": m["public_key"],
            "owner": m["id"] == row["owner_id"],
        }
        for m in members_of(conn, gid)
    ]
    keys = conn.execute(
        "SELECT k.version, u.username AS wrapper, k.wrapper_pub, k.iv, k.wk "
        "FROM chat_group_keys k JOIN users u ON u.id = k.wrapper_id "
        "WHERE k.group_id = ? AND k.user_id = ? ORDER BY k.version",
        (gid, user["id"]),
    ).fetchall()
    out["keys"] = [
        {"version": k["version"], "from": k["wrapper"], "from_pub": k["wrapper_pub"], "iv": k["iv"], "wk": k["wk"]}
        for k in keys
    ]
    return out
