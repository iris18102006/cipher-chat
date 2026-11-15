"""Security helpers for cipher-chat: response headers, rate limiting and who is really connecting.

This file imports nothing from main.py, so main.py, blobs.py and the tests can all use it.
"""

import os
import time
from collections import defaultdict

from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection
