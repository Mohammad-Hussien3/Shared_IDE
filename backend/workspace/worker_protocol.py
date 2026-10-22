"""Private, length-delimited JSON protocol. No logging of payloads or credentials."""
import asyncio
import json
import struct

MAX_FRAME = 512 * 1024  # includes JSON escaping for a 64 KiB source


async def receive(reader, limit=MAX_FRAME):
    size = struct.unpack('!I', await reader.readexactly(4))[0]
    if size > limit or size == 0:
        raise ValueError('Invalid worker frame size.')
    message = json.loads(await reader.readexactly(size))
    if not isinstance(message, dict):
        raise ValueError('Invalid worker message.')
    return message


async def send(writer, message):
    data = json.dumps(message, ensure_ascii=True).encode()
    if len(data) > MAX_FRAME:
        raise ValueError('Worker message is too large.')
    writer.write(struct.pack('!I', len(data)) + data)
    await asyncio.wait_for(writer.drain(), 5)
