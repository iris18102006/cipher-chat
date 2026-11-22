"""Comments under posts.

Anybody who can see a post can comment on it, and what they write is plain text (never rendered as
html) that the server checks like a post (moderation.py). You can edit and delete your own comments,
and the person whose post it is can delete any comment under it, so nobody has to leave somebody
else's words on their own post. Comments from somebody you have a block with are left out for you.

Comments go with their post: when a post is deleted, so are its comments.

Imported by main.py at the very bottom, after feed.py.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .feed import clean_words, need_post, person
from .main import current_user, get_conn, manager
from .postaccess import Viewer

router = APIRouter()

COMMENT_LIMIT = 300  # characters in a comment
COMMENTS_PAGE = 20
COMMENTS_PER_WINDOW = 20  # how many comments one person can make ...
COMMENT_WINDOW = 5 * 60  # ... in this many seconds
_recent: dict[int, deque] = defaultdict(deque)  # user id -> when they last commented (in memory)

COMMENT_SELECT = """
    SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, c.edited_at,
           u.username, u.display_name, u.avatar_id
    FROM post_comments c JOIN users u ON u.id = c.author_id
"""
