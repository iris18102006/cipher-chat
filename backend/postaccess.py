"""Who can see which post. One place, so the feed, a single post, the pictures on a post and the
"liked by" list can never disagree.

A post is shown to somebody when:
- it is theirs (they always see their own posts, even hidden ones and ones for "only me"), or
- its author is their friend and they have no block with each other, and the post isn't hidden
  by reports, and its audience lets them in: "friends" lets every friend in, "close" only the
  friends the author put on their close friends list, "me" nobody else.

Imported by feed.py and media.py, after main.py has defined everything they need.
"""

import os

from .main import friend_ids

# a post that this many different people reported is hidden until somebody has a look
HIDE_AFTER_REPORTS = 2


def admin_names() -> set[str]:
    """The usernames in CIPHER_ADMINS (comma separated). Read each time, so it can change."""
    raw = os.environ.get("CIPHER_ADMINS", "")
    return {n.strip().lower() for n in raw.split(",") if n.strip()}


def is_admin(user) -> bool:
    return user["username"].lower() in admin_names()


def blocked_with(conn, user_id: int) -> set[int]:
    """Everyone I blocked or who blocked me."""
    rows = conn.execute(
        "SELECT blocked_id FROM blocks WHERE blocker_id = :me "
        "UNION SELECT blocker_id FROM blocks WHERE blocked_id = :me",
        {"me": user_id},
    ).fetchall()
    return {r[0] for r in rows}


def visible_sql(conn, me_id: int, alias: str = "p"):
    """(sql, params): a condition that is true for the posts `me_id` may see.

    The caller adds {"me": me_id} to the parameters."""
    friends = friend_ids(conn, me_id) - blocked_with(conn, me_id)
    params = {f"f{i}": uid for i, uid in enumerate(sorted(friends))}
    ors = [f"{alias}.author_id = :me"]
    if friends:
        marks = ", ".join(":" + name for name in params)
        ors.append(
            f"({alias}.author_id IN ({marks}) AND {alias}.hidden = 0 AND ("
            f"{alias}.audience = 'friends' OR ({alias}.audience = 'close' AND EXISTS ("
            f"SELECT 1 FROM close_friends c WHERE c.owner_id = {alias}.author_id AND c.friend_id = :me))))"
        )
    return "(" + " OR ".join(ors) + ")", params


POST_SELECT = """
    SELECT p.id, p.author_id, p.body, p.shared_id, p.is_share, p.created_at, p.edited_at,
           p.audience, p.hidden, p.reviewed,
           u.username, u.display_name, u.avatar_id,
           u.likes_visibility, u.allow_reposts, u.allow_chat_shares,
           (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
           EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = :me) AS liked,
           (SELECT COUNT(*) FROM posts s WHERE s.shared_id = p.id) AS reposts,
           EXISTS (SELECT 1 FROM post_reports r WHERE r.post_id = p.id AND r.reporter_id = :me) AS reported
    FROM posts p JOIN users u ON u.id = p.author_id
"""


