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
class JoystickData(IdlStruct, typename="JoystickData"):
    seq: types.int32
    t_ms: types.int64
    deadman: bool
    vx: types.float32
    vy: types.float32
    wz: types.float32
    mode: str

class DDSBridgeServer:
    def __init__(self):
        self.participant = DomainParticipant()
        self.publisher = Publisher(self.participant)
        self.topic = Topic(self.participant, "rt/bt_usb/joystick_data", JoystickData)
        self.writer = DataWriter(self.publisher, self.topic)

    async def handle_client(self, websocket):
        print(f"Client connected from {websocket.remote_address}", flush=True)
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    # Construct the DDS message
                    msg = JoystickData(
                        seq=int(data.get("seq", 0)),
                        t_ms=int(data.get("t_ms", 0)),
                        deadman=bool(data.get("deadman", False)),
                        vx=float(data.get("vx", 0.0)),
                        vy=float(data.get("vy", 0.0)),
                        wz=float(data.get("wz", 0.0)),
                        mode=str(data.get("mode", "sleep"))
                    )
                    # Publish to DDS
                    self.writer.write(msg)
                    if msg.seq % 20 == 0:
                        print(f"Forwarded to DDS: mode={msg.mode}, vx={msg.vx:.2f}, vy={msg.vy:.2f}, wz={msg.wz:.2f}, deadman={msg.deadman}", flush=True)
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
