"""The feed: short posts that you and your friends can see.

Posts are plain text (never rendered as html) and, like everything on a profile, they are
not encrypted: only messages are. You see your own posts and your friends' posts, nobody
else's, and nothing from someone you have a block with.

A post can be shared. A share is a post of its own (with an optional note) that points at the
original. Sharing never opens the original up to more people: a friend of yours who isn't a
friend of the author sees that you shared something, but not what it says.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .main import avatar_url, clean_text, current_user, friend_ids, get_conn, manager

router = APIRouter()

POST_LIMIT = 500  # characters in a post
NOTE_LIMIT = 300  # characters in the note on a share
FEED_PAGE = 20
POSTS_PER_WINDOW = 15  # how many posts and shares one person can make ...
POST_WINDOW = 10 * 60  # ... in this many seconds
_recent: dict[int, deque] = defaultdict(deque)  # user id -> when they last posted (in memory)


class PostBody(BaseModel):
    body: str


class ShareBody(BaseModel):
    body: str = ""
