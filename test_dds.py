from cyclonedds.idl import IdlStruct
import cyclonedds.idl.types as types
from dataclasses import dataclass

@dataclass
class JoyData_(IdlStruct, typename="xterra::msg::dds_::JoyData_"):
    priority: types.uint8
    axes: types.array[types.float32, 6]
    buttons: types.array[types.uint8, 12]

msg = JoyData_(priority=0, axes=[0.0]*6, buttons=[0]*12)
print(msg)
