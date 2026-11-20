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


