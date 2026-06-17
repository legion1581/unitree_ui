import asyncio
import json
import websockets
from dataclasses import dataclass
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

class DDSBridgeServer:
    def __init__(self):
        self.participant = DomainParticipant()
        self.publisher = Publisher(self.participant)
        self.topic = Topic(self.participant, "rt/bt_usb/joystick_data", JoyData_)
        self.writer = DataWriter(self.publisher, self.topic)

    async def handle_client(self, websocket):
        print(f"Client connected from {websocket.remote_address}", flush=True)
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)

                    # Extract axes and buttons from the payload (default to zeros)
                    raw_axes = data.get("axes", [])
                    raw_buttons = data.get("buttons", [])

                    # Ensure exactly 6 axes
                    axes = [0.0] * 6
                    for i in range(min(6, len(raw_axes))):
                        axes[i] = float(raw_axes[i])

                    # Ensure exactly 12 buttons
                    buttons = [0] * 12
                    for i in range(min(12, len(raw_buttons))):
                        buttons[i] = int(bool(raw_buttons[i]))

                    # Construct the DDS message
                    msg = JoyData_(
                        priority=int(data.get("priority", 0)),
                        axes=axes,
                        buttons=buttons
                    )

                    # Publish to DDS
                    self.writer.write(msg)

                    seq = int(data.get("seq", 0))
                    if seq % 20 == 0:
                        print(f"Forwarded to DDS: axes={[f'{a:.2f}' for a in axes]}, buttons={buttons}", flush=True)
                except json.JSONDecodeError:
                    print("Received invalid JSON")
                except Exception as e:
                    print(f"Error processing message: {e}")
        except websockets.exceptions.ConnectionClosed as e:
            print(f"Client disconnected: {e}")
        finally:
            print(f"Connection closed for {websocket.remote_address}")

import sys

async def main():
    bridge = DDSBridgeServer()
    print("Starting WebSocket to Cyclone DDS Bridge on 0.0.0.0:5051", flush=True)
    async with websockets.serve(bridge.handle_client, "0.0.0.0", 5051):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
