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
SIG_BYTES = 64  # an ECDSA P-256 signature in the raw r||s form Web Crypto makes

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
        "SELECT u.id, u.username, u.display_name, u.avatar_id, u.public_key, u.sign_pub, "
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
            "sign_pub": m["sign_pub"],
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


# ---------- routes ----------


@router.post("/api/groups")
async def create_group(body: NewGroup, user=Depends(current_user), conn=Depends(get_conn)):
    name = clean_text(body.name, NAME_LIMIT, "group name")
    if not name:
        raise HTTPException(400, "give the group a name")
    names = {n.lower() for n in body.members}
    names.discard(user["username"])
    if not names:
        raise HTTPException(400, "pick at least one friend")
    if len(names) + 1 > MAX_MEMBERS:
        raise HTTPException(400, f"a group can have {MAX_MEMBERS} people at most")
    mine = conn.execute(
        "SELECT COUNT(*) FROM chat_group_members WHERE user_id = ?", (user["id"],)
    ).fetchone()[0]
    if mine >= MAX_GROUPS:
        raise HTTPException(400, f"you're already in {MAX_GROUPS} groups")

    others = []
    for n in sorted(names):
        p = get_peer(conn, n)
        if friend_status(conn, user["id"], p["id"]) != "friends" or blocked_either_way(conn, user["id"], p["id"]):
            raise HTTPException(400, f"{n} isn't your friend, you can only add friends")
        others.append(p)
    me = conn.execute(
        "SELECT id, username, public_key FROM users WHERE id = ?", (user["id"],)
    ).fetchone()
    pub = my_pub(conn, user["id"])
    wraps = check_wraps(body.keys, [me, *others])

    cur = conn.execute("INSERT INTO chat_groups (name, owner_id) VALUES (?, ?)", (name, user["id"]))
    gid = cur.lastrowid
    conn.executemany(
        "INSERT INTO chat_group_members (group_id, user_id, joined_version) VALUES (?, ?, 1)",
        [(gid, uid) for uid, _, _ in wraps],
    )
    store_wraps(conn, gid, 1, user["id"], pub, wraps)
    conn.commit()
    await notify_group(conn, gid, "updated")
    return detail(conn, gid, user)


@router.get("/api/groups")
def list_groups(user=Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute(
        "SELECT g.id, g.name, g.owner_id, g.key_version, g.rekey_needed, o.username AS owner "
        "FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id "
        "JOIN users o ON o.id = g.owner_id WHERE m.user_id = ?",
        (user["id"],),
    ).fetchall()
    return [summary(conn, r, user["id"], member_row(conn, r["id"], user["id"])) for r in rows]


@router.get("/api/groups/{gid}")
def get_group_detail(gid: int, user=Depends(current_user), conn=Depends(get_conn)):
    return detail(conn, gid, user)


@router.put("/api/groups/{gid}")
async def rename_group(gid: int, body: RenameBody, user=Depends(current_user), conn=Depends(get_conn)):
    row, _ = get_group(conn, gid, user)
    if row["owner_id"] != user["id"]:
        raise HTTPException(403, "only the owner can rename the group")
    name = clean_text(body.name, NAME_LIMIT, "group name")
    if not name:
        raise HTTPException(400, "give the group a name")
    conn.execute("UPDATE chat_groups SET name = ? WHERE id = ?", (name, gid))
    conn.commit()
    await notify_group(conn, gid, "updated")
    return detail(conn, gid, user)


@router.post("/api/groups/{gid}/members")
async def add_member(gid: int, body: AddMember, user=Depends(current_user), conn=Depends(get_conn)):
    row, _ = get_group(conn, gid, user)
    target = get_peer(conn, body.username)
    if target["id"] == user["id"] or member_row(conn, gid, target["id"]):
        raise HTTPException(409, "they're already in this group")
    if friend_status(conn, user["id"], target["id"]) != "friends" or blocked_either_way(
        conn, user["id"], target["id"]
    ):
        raise HTTPException(403, "you can only add your friends")
    current = members_of(conn, gid)
    if len(current) + 1 > MAX_MEMBERS:
        raise HTTPException(400, f"a group can have {MAX_MEMBERS} people at most")
    if body.version != row["key_version"] + 1:
        raise HTTPException(409, "the group changed while you were adding them, try again")
    target_full = conn.execute(
        "SELECT id, username, public_key FROM users WHERE id = ?", (target["id"],)
    ).fetchone()
    wraps = check_wraps(body.keys, [*current, target_full])
    pub = my_pub(conn, user["id"])

    # the version check is also the lock: if two people change the key at once, one loses
    won = conn.execute(
        "UPDATE chat_groups SET key_version = ?, rekey_needed = 0 WHERE id = ? AND key_version = ?",
        (body.version, gid, row["key_version"]),
    ).rowcount
    if won != 1:
        conn.rollback()
        raise HTTPException(409, "the group changed while you were adding them, try again")
    conn.execute(
        "INSERT INTO chat_group_members (group_id, user_id, joined_version, last_read_id) "
        "VALUES (?, ?, ?, ?)",
        (gid, target["id"], body.version, max_message_id(conn, gid)),
    )
    store_wraps(conn, gid, body.version, user["id"], pub, wraps)
    conn.commit()
    await notify_group(conn, gid, "updated")
    return detail(conn, gid, user)


@router.delete("/api/groups/{gid}/members/{username}")
async def remove_member(gid: int, username: str, user=Depends(current_user), conn=Depends(get_conn)):
    row, _ = get_group(conn, gid, user)
    target = get_peer(conn, username)
    if not member_row(conn, gid, target["id"]):
        raise HTTPException(404, "they're not in this group")
    leaving = target["id"] == user["id"]
    if not leaving and row["owner_id"] != user["id"]:
        raise HTTPException(403, "only the owner can remove people")

    conn.execute(
        "DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?", (gid, target["id"])
    )
    conn.execute("DELETE FROM chat_group_keys WHERE group_id = ? AND user_id = ?", (gid, target["id"]))
    # their look for this group goes with them
    conn.execute(
        "DELETE FROM chat_themes WHERE kind = 'group' AND target_id = ? AND user_id = ?",
        (gid, target["id"]),
    )
    left = members_of(conn, gid)
    if not left:
        conn.execute("DELETE FROM chat_groups WHERE id = ?", (gid,))
        conn.execute("DELETE FROM chat_themes WHERE kind = 'group' AND target_id = ?", (gid,))
        conn.commit()
        await manager.send_user(target["username"], {"type": "group", "event": "removed", "group": gid})
        return {"deleted": True}
    if row["owner_id"] == target["id"]:
        conn.execute("UPDATE chat_groups SET owner_id = ? WHERE id = ?", (left[0]["id"], gid))
    # whoever is left has to pick a new key, so the person who just went can't read on
    conn.execute("UPDATE chat_groups SET rekey_needed = 1 WHERE id = ?", (gid,))
    conn.commit()
    await manager.send_user(target["username"], {"type": "group", "event": "removed", "group": gid})
    await notify_group(conn, gid, "updated")
    return {"deleted": False}


@router.post("/api/groups/{gid}/rekey")
async def rekey_group(gid: int, body: Rekey, user=Depends(current_user), conn=Depends(get_conn)):
    row, _ = get_group(conn, gid, user)
    if body.version != row["key_version"] + 1:
        raise HTTPException(409, "somebody else already did it")
    wraps = check_wraps(body.keys, members_of(conn, gid))
    pub = my_pub(conn, user["id"])
    won = conn.execute(
        "UPDATE chat_groups SET key_version = ?, rekey_needed = 0 WHERE id = ? AND key_version = ?",
        (body.version, gid, row["key_version"]),
    ).rowcount
    if won != 1:
        conn.rollback()
        raise HTTPException(409, "somebody else already did it")
    store_wraps(conn, gid, body.version, user["id"], pub, wraps)
    conn.commit()
    await notify_group(conn, gid, "updated")
    return detail(conn, gid, user)


@router.get("/api/groups/{gid}/messages")
def group_history(
    gid: int,
    before: int | None = None,
    limit: int = Query(50, ge=1, le=100),
    user=Depends(current_user),
    conn=Depends(get_conn),
):
    _, mem = get_group(conn, gid, user)
    rows = conn.execute(
        f"SELECT m.id, m.sender_id, u.username AS sender, m.key_version, m.iv, m.ct, m.sig, m.created_at "
        f"FROM chat_group_messages m JOIN users u ON u.id = m.sender_id "
        f"WHERE {VISIBLE} AND (:before IS NULL OR m.id < :before) "
        f"ORDER BY m.id DESC LIMIT :limit",
        {"g": gid, "joined": mem["joined_version"], "me": user["id"], "before": before, "limit": limit},
    ).fetchall()
    # who has read up to where, so my own messages can say "seen by ..."
    blocked = blocked_ids(conn, user["id"])
    readers = [
        (m["username"], m["last_read_id"])
        for m in members_of(conn, gid)
        if m["id"] != user["id"] and m["id"] not in blocked
    ]
    out = []
    for r in reversed(rows):
        mine = r["sender_id"] == user["id"]
        out.append(
            {
                "id": r["id"],
                "from": r["sender"],
                "v": r["key_version"],
                "iv": r["iv"],
                "ct": r["ct"],
                "sig": r["sig"],
                "ts": r["created_at"],
                "seen_by": [n for n, last in readers if last >= r["id"]] if mine else [],
            }
        )
    return out


# ---------- websocket: called from main.py's socket loop ----------


async def handle_ws(conn, me_id: int, me: str, data: dict) -> bool:
    """Handle group messages, typing and read marks. Returns False if it isn't a group event."""
    kind = data.get("type")
    if kind not in WS_KINDS:
        return False
    gid = data.get("group")
    if not isinstance(gid, int) or isinstance(gid, bool):
        return True
    mem = member_row(conn, gid, me_id)
    if not mem:
        if kind == "gmsg":
            await manager.send_user(
                me, {"type": "gmsg-rejected", "group": gid, "cid": data.get("cid"), "reason": "not_member"}
            )
        return True

    blocked = blocked_ids(conn, me_id)

    def audience(version: int = 10**9) -> set[str]:
        """Everyone else in the group who can read key `version` (default: everyone)."""
        rows = conn.execute(
            "SELECT u.id, u.username FROM chat_group_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.group_id = ? AND m.user_id != ? AND m.joined_version <= ?",
            (gid, me_id, version),
        ).fetchall()
        return {r["username"] for r in rows if r["id"] not in blocked}

    if kind == "gtyping":
        for name in audience():
            await manager.send_user(
                name, {"type": "gtyping", "group": gid, "from": me, "state": bool(data.get("state"))}
            )

    elif kind == "gmsg":
        v, iv, ct = data.get("v"), data.get("iv"), data.get("ct")
        if not (isinstance(v, int) and isinstance(iv, str) and isinstance(ct, str)) or isinstance(v, bool):
            return True
        if len(iv) > 32 or not iv or not ct:
            return True
        # the signature is optional here (older browsers send none) but if it's there it
        # has to be the right size. The server can't check it, only the members' browsers can
        sig = data.get("sig")
        if sig is not None and not (isinstance(sig, str) and b64_len(sig, SIG_BYTES)):
            await manager.send_user(
                me, {"type": "gmsg-rejected", "group": gid, "cid": data.get("cid"), "reason": "bad_sig"}
            )
            return True
        if len(ct) > MAX_CT_LEN:
            await manager.send_user(
                me, {"type": "gmsg-rejected", "group": gid, "cid": data.get("cid"), "reason": "too_long"}
            )
            return True
        current = conn.execute("SELECT key_version FROM chat_groups WHERE id = ?", (gid,)).fetchone()[0]
        # you can only write with a key version you actually hold
        holds = conn.execute(
            "SELECT 1 FROM chat_group_keys WHERE group_id = ? AND user_id = ? AND version = ?",
            (gid, me_id, v),
        ).fetchone()
        if v > current or not holds:
            await manager.send_user(
                me, {"type": "gmsg-rejected", "group": gid, "cid": data.get("cid"), "reason": "bad_key"}
            )
            return True
        cur = conn.execute(
            "INSERT INTO chat_group_messages (group_id, sender_id, key_version, iv, ct, sig) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (gid, me_id, v, iv, ct, sig),
        )
        msg_id = cur.lastrowid
        # writing means I've read everything up to here
        conn.execute(
            "UPDATE chat_group_members SET last_read_id = MAX(last_read_id, ?) "
            "WHERE group_id = ? AND user_id = ?",
            (msg_id, gid, me_id),
        )
        conn.commit()
        ts = conn.execute(
            "SELECT created_at FROM chat_group_messages WHERE id = ?", (msg_id,)
        ).fetchone()[0]
        payload = {
            "type": "gmsg",
            "group": gid,
            "id": msg_id,
            "from": me,
            "v": v,
            "iv": iv,
            "ct": ct,
            "sig": sig,
            "ts": ts,
            "cid": data.get("cid"),
        }
        # people who joined after this key version can't read it, so they don't get it
        for name in audience(v):
            await manager.send_user(name, payload)
        await manager.send_user(me, {**payload, "seen_by": []})

    elif kind == "gread":
        upto = max_message_id(conn, gid)
        conn.execute(
            "UPDATE chat_group_members SET last_read_id = MAX(last_read_id, ?) "
            "WHERE group_id = ? AND user_id = ?",
            (upto, gid, me_id),
        )
        conn.commit()
        await manager.send_user(me, {"type": "gread-sync", "group": gid})
        for name in audience():
            await manager.send_user(name, {"type": "gseen", "group": gid, "by": me, "upto": upto})

    return True
