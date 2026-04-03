"""Simple TCP proxy: localhost:8123 → homeassistant.local:8123."""

import asyncio
import sys

REMOTE_HOST = "homeassistant.local"
REMOTE_PORT = 8123
LOCAL_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        writer.close()


async def handle(local_r: asyncio.StreamReader, local_w: asyncio.StreamWriter) -> None:
    try:
        remote_r, remote_w = await asyncio.open_connection(REMOTE_HOST, REMOTE_PORT)
    except OSError as e:
        print(f"Cannot reach {REMOTE_HOST}:{REMOTE_PORT}: {e}", file=sys.stderr)
        local_w.close()
        return
    await asyncio.gather(pipe(local_r, remote_w), pipe(remote_r, local_w))


async def main() -> None:
    server = await asyncio.start_server(handle, "127.0.0.1", LOCAL_PORT)
    print(f"Proxying localhost:{LOCAL_PORT} → {REMOTE_HOST}:{REMOTE_PORT}")
    async with server:
        await server.serve_forever()


asyncio.run(main())
