"""GIFs for chats.

There are two places a GIF can come from:

1. Your own GIF library: GIFs and pictures you uploaded to keep (up to MAX_GIFS). This always works.
2. GIPHY search, only if the person running the server set CIPHER_GIPHY_KEY (a free key from
   developers.giphy.com). The browser never talks to GIPHY: it asks this server, the server asks
   GIPHY and passes the pictures on. That keeps the page's strict content policy (no other
   sites), and keeps people's addresses away from GIPHY. The server only ever fetches from
   GIPHY's own picture hosts, over https, and doesn't follow redirects.

Sending a GIF in a chat is the same as sending any picture: the browser downloads it, locks it and
sends it like a file, so the chat itself stays end-to-end encrypted. Only the search words go
through the server (and GIPHY), never what is said in the chat.

Imported by main.py at the very bottom, after everything it needs is defined.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import moderation
from .main import MAX_GIF_UPLOAD, MAX_GIFS, clean_text, current_user, get_conn, process_image, read_body
from .security import SlidingLimiter

router = APIRouter()

