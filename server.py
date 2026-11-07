"""Run cipher-chat: python server.py  ->  http://127.0.0.1:8000"""
import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=os.environ.get("CIPHER_HOST", "127.0.0.1"),
        port=8000,
    )
