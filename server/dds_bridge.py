import asyncio
import json
from dataclasses import dataclass

from aiohttp import web
import aiohttp_cors
from aiortc import RTCPeerConnection, RTCSessionDescription

from cyclonedds.domain import DomainParticipant
from cyclonedds.topic import Topic
from cyclonedds.pub import Publisher, DataWriter
from cyclonedds.idl import IdlStruct
import cyclonedds.idl.types as types
import cyclonedds.idl.annotations as annotate

@dataclass
@annotate.final
class JoyData_(IdlStruct, typename="xterra::msg::dds_::JoyData_"):
    priority: types.uint8
    axes: types.array[types.float32, 6]
    buttons: types.array[types.uint8, 12]

pcs = set()

class DDSBridge:
    def __init__(self):
        self.participant = DomainParticipant()
        self.publisher = Publisher(self.participant)
        self.topic = Topic(self.participant, "rt/bt_usb/joystick_data", JoyData_)
        self.writer = DataWriter(self.publisher, self.topic)

    def handle_message(self, message):
        try:
            data = json.loads(message)
            raw_axes = data.get("axes", [])
            raw_buttons = data.get("buttons", [])

            axes = [0.0] * 6
            for i in range(min(6, len(raw_axes))):
                axes[i] = float(raw_axes[i])

            buttons = [0] * 12
            for i in range(min(12, len(raw_buttons))):
                buttons[i] = int(bool(raw_buttons[i]))

            msg = JoyData_(
                priority=int(data.get("priority", 0)),
                axes=axes,
                buttons=buttons
            )

            self.writer.write(msg)

            seq = int(data.get("seq", 0))
            if seq % 20 == 0:
                print(f"Forwarded to DDS: axes={[f'{a:.2f}' for a in axes]}, buttons={buttons}", flush=True)
        except Exception as e:
            print(f"Error processing message: {e}")

dds_bridge = DDSBridge()

async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("datachannel")
    def on_datachannel(channel):
        print(f"Data channel created: {channel.label}")
        @channel.on("message")
        def on_message(message):
            dds_bridge.handle_message(message)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"Connection state is {pc.connectionState}")
        if pc.connectionState == "failed" or pc.connectionState == "closed":
            await pc.close()
            pcs.discard(pc)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.json_response({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    })

async def on_shutdown(app):
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()

def main():
    app = web.Application()

    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
        )
    })

    cors.add(app.router.add_post("/offer", offer))
    app.on_shutdown.append(on_shutdown)

    print("Starting WebRTC to Cyclone DDS Bridge on 0.0.0.0:8080", flush=True)
    web.run_app(app, host="0.0.0.0", port=8080)

if __name__ == "__main__":
    main()
