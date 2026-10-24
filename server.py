import asyncio
import websockets

clients = set()

async def handler(ws):
    clients.add(ws)
    try:
        async for msg in ws:
            for c in clients:
                if c is not ws:
                    await c.send(msg)
    finally:
        clients.discard(ws)

async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("relay running on ws://localhost:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
