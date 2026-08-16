# R1 Action List (FSM states)

Every persistent posture, gait, and motion on the Unitree **R1** is a single FSM
state, selected by one API. This is different from the Go2 sport API (many
distinct command IDs) — on R1 you send **one api_id and change the `fsm_id`**.

Most of the table below is **not exposed by the official Explorer app**.

## The API

| | Value |
|---|---|
| **DDS/WebRTC service** | `sport` (`LOCO_SERVICE_NAME`) |
| **Request topic** | `rt/api/sport/request` (`RTC_TOPIC.SPORT_MOD`) |
| **Set state** | api_id **`7101`** — `ROBOT_API_ID_LOCO_SET_FSM_ID` |
| **Read state** | api_id **`7001`** — `ROBOT_API_ID_LOCO_GET_FSM_ID` |
| **Set velocity** | api_id **`7105`** — `ROBOT_API_ID_LOCO_SET_VELOCITY` |
| **Set motion** (sub-clip) | api_id **`7108`** — `LocoServer::SetMotion` (see "Triggering actions within a state") |
| **Parameter** | JSON `{"data": <value>}` — except `7105`, which takes `{"velocity":[vx,vy,omega],"duration":<s>}`, and `7108`, which takes an **array** (below) |
| **Server handler** | `LocoServer::SetFsmId` → `changeState(fsm_id)` |

> **api_id 7108 is per-service.** On the **sport/loco** topic (`rt/api/sport/request`)
> 7108 = `SetMotion`. The *same number* on the **arm** topic (`rt/api/arm/request`)
> is an arm-teach command — they don't collide because api_id is scoped per service.
> The R1 loco service registers exactly `7001 GetFsmId, 7101 SetFsmId, 7105
> SetVelocity, 7108 SetMotion`; the 7108 handler logs `"Call SetMotion ..."`.

R1 reuses the G1 `7xxx` api_id scheme. The current mode is echoed back in
`SportModeState.fsm_id` on `rt/lf/sportmodestate`.

Example request parameter to start Kung Fu:

```json
{ "data": 607 }
```

## FSM state table

Policy paths below are relative to the motion net root; states without a policy
are analytic controllers (no neural net).

### Basic / static states

| fsm_id | Internal name | App label | Policy | Notes |
|------:|---------------|-----------|--------|-------|
| 0   | `ZeroTorque` | Zero Torque | — (analytic) | motors free |
| 1   | `Damping`    | Damping | — (analytic) | soft-stop / relax |
| 4   | `Stance`     | **Lock** (Preparation) | — (analytic) | app calls this "Lock" |
| 5   | `Keep`       | Keep | — (analytic) | hold current pose |
| 6   | `MoveTo`     | Move To | — (analytic) | |
| 7   | `SitDown`    | Sit Down | — (analytic) | |
| −1  | `Root`       | — | — | internal super-state, not selectable |
| −11 | `Init`       | — | — | internal |
| −12 | `Static`     | — | — | internal super-state |

### Recovery / posture

| fsm_id | Internal name | Policy | Meaning |
|------:|---------------|--------|---------|
| 701 | `Qishen` (起身)  | `qishen/r1_air_tangqi_faceup.onnx` + `qishen/r1_air_tangqi_facedown.onnx` | **Stand up from ground** — face-up **and** face-down policies, so it recovers from either back or belly |
| 702 | `Tangxia` (躺下) | `tangxia/r1_tangxia_qili.onnx` | **Lie down** |

On the BLE remote both 701 and 702 are bound to the same combo
(`R1_hold` + `X_long`), so it behaves as a **lie ↔ stand toggle**.

### Locomotion / motion

| fsm_id | Internal name | Policy | Notes |
|------:|---------------|--------|-------|
| 800 | `Motion` | — | generic motion super-state |
| 804 | `MimicActor` | `mimic_actor/model.onnx` | mimic / teleop — **gone on current firmware** (code 1003) |
| 805 | `MimicPunch` | `mimic_punch/model.onnx` | mimic punch (2 policies) — **gone on current firmware** (code 1003) |
| 811 | `AmpMotion22Dof` | `amp_motion_22dof/actor.onnx` | **Run** (app label) |
| 812 | `AmpMotion` | `amp_motion/actor.onnx` | AMP motion, 24-dof |
| 813 | `Locomotion24DofStraightKnee` | `locomotion_24dof_straight_knee/actor.onnx` | walk, straight knee |
| 814 | `Locomotion24DofWalk` | `locomotion_24dof_walk/actor.onnx` | walk, 24-dof |
| 815 | `AmpLocomotion` | `amp_locomotion/policy_10k.onnx` | AMP locomotion |
| 816 | `ArmSdkLocomotion` | `arm_sdk_locomotion/policy_32.5k.onnx` | locomotion + arm-SDK — **armsdk white-list only** |
| 830 | `Locomotion20Dofs` | `locomotion_20dofs/25000amp6_cwdata_011.onnx` | 20-dof locomotion |
| 831 | `LocomotionArmsdk` | `locomotion_armsdk/r1air_armsdk_loco23000.onnx` | locomotion + arm-SDK — **armsdk white-list only** |

### Dances / martial arts

| fsm_id | Internal name | Policy | App label |
|------:|---------------|--------|-----------|
| 601 | `dance1_subject2_segment1` | `dances/dance1_subject2_niuniuwu/policy_80k.onnx` | Dance 1 |
| 602 | `dance1_subject2_segment2_hard` | `dances/dance1_subject2/dance1_subject2_hard_80k-120k.onnx` | Dance 2 |
| 603 | `dance1_subject2_segment3_hard` | `dances/dance1_subject2/dance1_subject2_hard_80k-120k.onnx` | Dance 3 |
| 604 | `niuniu` | `dance_niuniu/policy.onnx` | Niuniu Dance |
| 605 | `weibosite` | `dance_weibosite/policy.onnx` | Weibosite Dance |
| 606 | `weibosite_CJJ` | — | *(disabled)* |
| 607 | `gongfu_2` (功夫) | `dances/gongfu_jiequandao/policy_80k.onnx` | **Kung Fu** |
| 608 | `jiequandao` (截拳道) | `dances/gongfu_jiequandao/policy_80k.onnx` | **Jeet Kune Do** |

Note: Kung Fu (607) and Jeet Kune Do (608) share the same policy
(`gongfu_jiequandao/policy_80k.onnx`) but play different motion segments.

## Reachability

There are **two independent lists**, and they do different jobs. Confusing them
is the easiest way to misread this firmware.

### 1. `set_fsm_white_list` / `set_fsm_black_list` — what gates *switching*

These live in the **current** state's own config and name the states you may
switch **to** from there. An empty white list means "anything except the black
list". This is the only thing that can reject a `SetFsmId`:

| While in | May switch to |
|---|---|
| **Stance** (4, "Lock"), SitDown, MoveTo, Qishen, Tangxia, dances, **MimicActor, MimicPunch** | *(empty — anything)* |
| Damping (1), Keep (5) | ZeroTorque, Damping, Stance, Keep |
| ZeroTorque (0) | Stance, Keep, Damping |
| AmpMotion22Dof (811, "Run") | Damping, Stance, Tangxia |
| AmpLocomotion (815), Locomotion20Dofs (830) | Damping, Stance, Tangxia, LocomotionArmsdkGait |
| Locomotion24DofStraightKnee (813), Locomotion24DofWalk (814), AmpMotion (812) | Damping |
| LocomotionGait, LocomotionArmsdk (831), ArmSdkLocomotion (816) | Damping, Stance |
| LocomotionArmsdkGait | Damping, Stance, AmpLocomotion |

Every locomotion state additionally black-lists `ZeroTorque` and `Keep`.

**Consequence: 804 / 805 are reachable only from a state with an empty white
list — in practice `Stance` (4, the app's "Lock").** You cannot enter a mimic
state from Damping, ZeroTorque, Keep, or from **Run (811)**. The same is true of
813 / 814: Lock → 813 works, Run → 813 does not.

- `armsdk` control is only accepted in **816**, **831** or **833**.
- The universal escape hatch is `Damping` (`{"data":1}`), allowed from every
  state above.

A refused `SetFsmId` answers with **api error code 1001** — the literal
`SetFsmIdHandler::handle` stores when `StateMachine::changeState()` fails. So
from 813 (Walk Straight Knee) a request for Lock returns `code=1001`, and the
only way out is **Damping first, then Lock**. The official Explorer app gets the
same 1001; this is enforced entirely on the robot.

### 2. `white_list.yaml` — what gates *reporting* only

```yaml
white_list: ["ZeroTorque", "Damping", "Stance", "AmpMotion22Dof", "AmpMotion",
  "Locomotion20Dofs", "LocomotionGait", "LocomotionArmsdkGait", "AmpLocomotion",
  "ArmSdkLocomotion", "LocomotionArmsdk", "Qishen", "Tangxia",
  "dance1_subject2_segment1", "dance1_subject2_segment2",
  "dance1_subject2_segment3", "niuniuwu", "gongfu", "jiequandao"]
```

`LocoServer::SendSportMode()` and `SendSportModeLF()` publish the state **only
while the current state's name is in this list**, and `GetFsmId` (7001) refuses
for the same reason (*"FSM state name '…' not in white list, deny returning
fsm_id"*). `SetFsmId` (7101) does **not** consult it at all: it parses `data`
and hands it straight to the state machine.

So this list does not stop you entering anything. What it does is make the
robot **go silent**: in a non-listed state `rt/lf/sportmodestate` stops being
published entirely and `fsm_id` freezes at whatever was last reported. The
states this affects — see `R1_UNREPORTED_FSM` in `action-bar.ts` — are
**5, 6, 7, 800, 804, 805, 813, 814**. Any client tracking the mode has to adopt
those optimistically on send and treat the next report as "we've left".

### Live motion set on current firmware

There is **no `Twist` motion**. The dance set is smaller than the id table
suggests — **601 and 605 are commented out** in both `dances.yaml` and
`dances_air.yaml`, so they don't exist as states:

| Config | Live dance ids |
|---|---|
| `dances.yaml` (EDU) | 602, 603, 604, 607, 608 |
| `dances_air.yaml` (**AIR**) | **602, 604, 607** |

Two states also exist that predate no earlier notes: **`LocomotionGait`** and
**`LocomotionArmsdkGait`** (`LocomotionArmsdkGaitCore`, id **833** per the
`armsdk` list in `white_list.yaml`; `LocomotionGait`'s id isn't stated in any
config — 832 by adjacency, unverified). Neither class exists on older
firmware, so they are new.

## Speed profile (R2 + UP / DOWN)

### There are exactly two

`speed_profile_` is an `int` that only ever holds **0 (low)** or **1 (high)** —
no ladder, no levels in between. `AmpMotionCore::handleSpeedAdjustmentInput()`
runs once per control tick from `update()` and does:

```cpp
if (!use_legacy_speed_adjustment_) {                     // the shipping path
  if (isKeyHold(0x10 /*R2*/) && isKeyPressed(0x1000 /*UP*/)   && speed_profile_ != 1)
      { speed_profile_ = 1; resetSpeedLimits(); LOG("speed_profile: high, vx_forward_max=" << max_cmd_[0]); }
  if (isKeyHold(0x10 /*R2*/) && isKeyPressed(0x4000 /*DOWN*/) && speed_profile_ != 0)
      { speed_profile_ = 0; resetSpeedLimits(); LOG("speed_profile: low, vx_forward_max="  << max_cmd_[0]); }
}
```

and `resetSpeedLimits()` re-derives the limit from scratch:

```cpp
max_cmd_ = init_max_cmd_;                                     // [1.0, 0.6, 1.0]
if (!use_legacy_ && speed_profile_ == 1) max_cmd_[0] = high_speed_vx_;   // 2.5 m/s
max_cmd_[0] = std::min(max_cmd_[0], temperature_vx_limit_);   // 5.0 normal / 1.0 hot
cmd_limit_  = max_cmd_;
```

So on Run (811, `AmpMotion22Dof`):

| profile | forward limit | source |
|---|---|---|
| low (default) | **1.0 m/s** | `init_max_cmd[0]` in `amp_motion_22dof.yaml` |
| high | **2.5 m/s** | hardcoded in the `AmpMotionCore` constructor |

`normal_temperature_speed_limits: 5.0` / `high_temperature_speed_limits: 1.0`
is the cap the `std::min` applies — when a winding crosses
`winding_high_temperature` (130 °C) or a driver crosses 85 °C, high collapses
onto 1.0 and the two profiles become identical. Lateral and yaw limits (0.6 /
1.0) never change; only vx does.

`AmpMotionCore::enter()` writes `speed_profile_ = 0` and calls
`resetSpeedLimits()`, so **every entry into Run starts on low**.

`AmpLocomotion` carries the same two-profile code with its own numbers —
`low_speed_forward_vx_limit: 0.9` / `high_speed_forward_vx_limit: 2.3` in
`amp_locomotion.yaml`. `Locomotion20Dofs` (830, the AIR redirect target) has no
speed handler at all: fixed `default_vx_forward_limit: 1.0`.

### Legacy mode (built but switched off)

`setUseLegacySpeedAdjustment(bool)` selects an older incremental scheme, and the
flag is initialised to **false** in the constructor with no caller anywhere in
the controller — it is dead in shipping firmware. For reference, it is a ±step
ladder rather than a toggle, on different keys:

| combo | effect |
|---|---|
| R1 hold + UP / DOWN | `max_cmd[0] ± 0.5`, floor 0, logs `x_cmd_max_gamepad:` |
| R1 hold + RIGHT / LEFT | `max_cmd[1] ± 0.25`, floor 0, logs `y_cmd_max_gamepad:` |
| R2 hold + UP / DOWN | `max_cmd[2] ± 0.5`, floor 0, logs `yaw_cmd_max_gamepad:` |

There is no upper clamp on the legacy ladder other than the temperature `min()`.

### It is a command clamp, not a policy input

The profile never reaches the network. `buildVelocityCommand()` multiplies the
normalised joystick axis by `cmd_limit_[i]`, and that product is what lands in
the observation vector. `amp_motion_22dof.yaml` spells the layout out:

```
# 3 + 3 + 22 + 22 + 22 = 72
num_obs: 72        # ang_vel(3) + cmd vx/vy/wz(3) + dof_pos(22) + dof_vel(22) + last_action(22)
memory_size: 5
```

Three command floats, no discrete speed/gait channel — the policy only ever sees
"go 0.8 m/s forward", never "you are in high mode". And the three motion model
slots collapse onto one file, so there is not even a net swap:

```yaml
walk_slow_model: ".../20250915_15-25-57__58600/actor.onnx"   ┐
walk_fast_model: ".../20250915_15-25-57__58600/actor.onnx"   ├─ same weights
run_model:       ".../20250915_15-25-57__58600/actor.onnx"   ┘
stance_model:    ".../20250919_16-11-28__68000/actor.onnx"   ← the only other net
```

Ramping is per-tick on the command, not instant: `vx_acc_up_delta: 0.02` /
`vx_acc_down_delta: 0.05` at 50 Hz, i.e. ~1 m/s of extra top speed takes about a
second to build.

(`AmpLocomotion` is the exception to the "no net swap" rule — its config gates
`run_model` on `vx: [1.5, 100]` and `turn_model` on `|wz| ≥ 1.0` with
`|vx|,|vy| ≤ 0.3`, so crossing 1.5 m/s there really does switch networks. That
still keys off the command value, not off `speed_profile_`.)

### The profile is unreachable from a client

Two separate walls, either one sufficient:

**No api.** `ROBOT_API_ID_LOCO_SET_SPEED_MODE = 7107` exists as a constant, but
`LocoServer::Init` binds only 7001 / 7101 / 7105 / 7108 — the sole 7107 reference
in the controller is inside `G1ArmActionClient::Init()`.

**No key channel either.** Replaying the R2 + UP gesture on
`rt/wirelesscontroller` cannot work: the loco service's subscriber for that topic
reads **only the four axes** —

```cpp
// Bridge ctor, WirelessController_ subscriber
gamepad.setUpWirelessControllerData(msg.lx(), msg.ly(), msg.rx(), msg.ry());
```

— and `WirelessController_::keys()` is never called by application code at all
(its only references are inside the CycloneDDS serializer templates). Buttons
reach the `Gamepad` state machine through exactly one path: the LowState
subscriber memcpy's `LowState_.wireless_remote` (40 bytes, straight from the
physical remote) into the gamepad buffer and calls `Gamepad::update()`. Nothing
a WebRTC client publishes can put a key into that buffer.

### What works instead: SetVelocity (7105) ignores the limit

`AmpMotionCore::controllerTask()`:

```cpp
target = buildVelocityCommand(gamepad_axes);   // axes .* cmd_limit_  ← profile applies here
api_duration_ -= dt;
if (api_duration_ > 0 && target.norm() < 0.1)  // only while the sticks are released
    target = api_velocity_;                    // used RAW — never multiplied by cmd_limit_
```

`api_velocity_` and `api_duration_` are written by the `SetVelocity` handler, and
nothing downstream clamps them back to `cmd_limit_`, so 7105 commands whatever vx
it asks for regardless of the profile. Two conditions: the joystick axes must be
near zero (a client using this must stop publishing sticks), and `api_duration_`
decays by `dt` per control step, so the request has to be repeated. The normal
`vx_acc_up_delta` ramp still applies, so speed builds over about a second rather
than stepping.

**And there is no readback.** R1 publishes `unitree_hg::msg::dds_::SportModeState_`,
a 16-byte struct with exactly four members — `fsm_id_`, `fsm_mode_`, `task_id_`,
`task_time_` — and `Bridge::SendSportMode{,LF}()` writes **only `fsm_id`** before
`Write()`, so the other three are always 0. There is no `speed_level` field at all
(the webview's `speed_level: n.speed_level ?? 0` is inherited from the Go2
message shape and always reads 0 here). The full loco api set for reference:

| api_id | name |
|---:|---|
| 7001 | `GET_FSM_ID` ✅ served |
| 7002 | `GET_FSM_MODE` — not bound |
| 7007 | `GET_ARM_SDK_STATUS` — not bound |
| 7101 | `SET_FSM_ID` ✅ served |
| 7105 | `SET_VELOCITY` ✅ served |
| 7106 | `SET_ARM_TASK` (arm topic) |
| 7107 | `SET_SPEED_MODE` — **not bound** |
| 7108 | `SET_PUNCH_API` ✅ served (this is SetMotion) |
| 7109 | `SET_ARM_SDK_STATUS` — not bound |

## Remote-control bindings

Transitions are declared per state as `state_change_map` entries of the form
`- TargetState: ["<key>_<event>", …]`, where the event is one of
`pressed / released / hold / idle / double / long (2 s) / long5s (5 s)`.

| From | Combo | To |
|---|---|---|
| any locomotion (811-816, 830, 831) | **L2 hold + B held 5 s** | Damping |
| any locomotion | **L2 hold + UP** | Stance (Lock) |
| 811 / 815 / 830 / `LocomotionGait` | **L2 hold + X long** | Tangxia (lie down) |
| 811 / 815 / 830 / `LocomotionGait` | **L2 hold + LEFT long** | SitDown |
| dances (601-608) | **L2 hold + B long** (2 s) *or* **START double-click** | Damping |
| **804 / 805**, Qishen, Tangxia, SitDown | **L2 hold + B** (instant) | Damping |
| Stance (Lock) | **R2 hold + A** | AmpLocomotion |
| Stance | **R2 hold + X** | LocomotionGait |
| Stance | **R2 hold + Y** | LocomotionArmsdkGait |
| Stance | **L2 hold + X long** | Qishen (stand up from ground) |
| Damping | **L2 hold + Y** | ZeroTorque |
| Damping / ZeroTorque | **L2 hold + UP** | Stance |
| Damping / ZeroTorque | **START double-click** | Keep |

### There is no remote combo for 804 / 805

The bindings exist in the config but are **commented out**, in both
`fsm/motion.yaml` and `fsm/statics/stance.yaml`:

```yaml
  # - MimicPunch: ["R1_hold", "A_pressed"]
  # - MimicActor: ["R1_hold", "B_pressed"]
```

So R1+A / R1+B were the intended combos and are dead on this firmware — the
mimic states are reachable **only** through `SetFsmId` (7101). Once inside,
the remote does work for clip selection (`motion_button_map`), and L2+B still
gets you out.

## Stopping, interrupting, and getting up after a fall

Three different things, often confused:

| Want | Remote | API |
|---|---|---|
| **E-stop** (motors compliant, robot flops) | **L2 + B** — instant in mimic/dance-adjacent states, **5 s hold in locomotion** | `SetFsmId {"data":1}` (Damping) |
| **Motors fully free** | **L2 + Y** from Damping | `SetFsmId {"data":0}` (ZeroTorque) |
| **Cut a running mimic clip short** | **START double-click** | *(none — see below)* |
| **Drop queued clips** | — | `SetMotion {"data":[0,1]}` |
| **Stand up after a fall** | **L2 + X long** from Stance | `SetFsmId {"data":701}` (Qishen) |

Notes that matter in practice:

- **Damping is the e-stop.** It's white-listed, so `{"data":1}` is accepted from
  every state including 804/805 — it's the one command that always lands. The
  robot goes limp, so expect it to drop where it stands.
- **The 5-second hold is real.** In locomotion states the config asks for
  `B_long5s`, which is `KeyState 6` at a 5000 ms threshold. Only the mimic,
  recovery and sit states use the instant `B_pressed`.
- **Clips can't be interrupted by the API.** `SetMotion` with terminator `1`
  clears the *queue* only; the running clip plays to its last frame because
  both the button path and the queue path are gated on
  `frame_counter >= total_frames`. The single exception is the START
  double-click abort at the top of `MimicCore::update()`, which force-sets the
  frame counter past the end and clears the queue. That's a clip abort, not a
  stop — the robot stays in the mimic state on its default clip.
- **Falls are detected, not auto-recovered.** `MimicCore` tracks a
  `FallDownState` and, for 805, has `front_get_up_traj_name` /
  `back_get_up_traj_name` wired to `get_up` (remote: L2+UP) — 804 leaves all
  four get-up/get-down names **empty**, so the actor state has no self-recovery
  at all. From a fall, the reliable sequence is Damping → Stance → Qishen (701),
  which carries both face-up and face-down policies.

## Triggering actions *within* a state (804 MimicActor / 805 MimicPunch)

> ⚠️ **Removed on current firmware.** The state names `MimicActor` and
> `MimicPunch` no longer exist — `SetFsmId {"data":805}` answers
> **`code=1003`** ("invalid fsm id"), i.e. `findState()` found nothing. They
> were present on older firmware, which is what the material below describes.
> Current firmware still ships `mimic_{actor,punch}.yaml`, all the
> `trajs/mimic_*` CSVs and the ONNX policies — leftovers with no state to run
> them. Same story for `SimpleMotion`; conversely `LocomotionGait` and
> `LocomotionArmsdkGait` are new. So the material below is reference for the sim
> (the policies load fine in mujoco), not something the robot will execute.

804 and 805 are **not single motions** — each is one policy that plays a *library
of clips*. `SetFsmId` (7101) only **enters** the state; **which clip plays is a
second selection**. Two independent channels do that selection:

| Channel | Transport | Works for | How |
|---|---|---|---|
| **Remote / gamepad** | `rt/wirelesscontroller` (button bits) | 804 **and** 805 | button gesture → `motion_button_map` |
| **SetMotion API** | `rt/api/sport/request`, api_id **7108** | **805 only** | `{"data": [<id>…, 0]}` |

The catch: only **805 MimicPunch** clips carry an `api_id`, so only they are
reachable by the `SetMotion` API. **804 MimicActor** clips have **no `api_id`**
(`offline_trajs: [50, 0, 0]`), so they're reachable **only** from the physical
remote (there is no per-clip API for the actor, and button state cannot be
injected over `rt/wirelesscontroller` — see Channel 1).

### How the controller actually picks a clip

Both states are the same C++ class, `ucontrol::state::MimicCore` — they differ
only by the config file (`mimic_name: actor | punch`). `MimicCore::update()`
runs once per 50 Hz tick and does, in order:

1. **Abort** — a double-click of **START** (`0x0004`) force-finishes the running
   clip and clears the api queue.
2. **Button-map scan** — walk `motion_button_map`, first match wins.
3. **API queue** — pop the front of a `std::deque<int>` fed by `SetMotion`, look
   the id up in the `api_id → traj name` map built from `offline_trajs`.

Both 2 and 3 are gated on the same idle test —
`frame_counter == 0 || frame_counter >= total_frames_of_current_clip` — so **a
clip can never be interrupted**, only queued behind. Whichever wins calls
`set_motion_api(name)`, which also arms that clip's cooldown
(`offline_trajs[2] / dt`); the button path refuses while the cooldown is live
and logs `Motion: <name>, cooling time remain: <n>` (every current punch clip
has `cool_time: 0`, so this is dormant today).

### The button gesture is not a plain press

The match predicate reads the on-robot `Gamepad` key states, not raw bits:

| `motion_button_map` entry | Required key state |
|---|---|
| single key — `["button_X_"]` | **`DOUBLE_CLICK`** — two presses ≤ **500 ms** apart |
| combo — `["button_UP_", "button_R1_"]` | **first** key `PRESSED` (a fresh edge) **+ every other** key `HOLD` |

`KeyState` is `0 IDLE, 1 HOLD, 2 PRESSED, 3 RELEASED, 4 DOUBLE_CLICK,
5 LONG_PRESS (2 s), 6 LONG_PRESS_5S (5 s)`. `Gamepad::update()` advances each
key one step per call, but only once the raw bit has been identical across its
**3-sample history** (a debounce), and it is called both from the main loop and
from every LowState message. Holding a bit therefore does **nothing** for a
single-key clip (which wants `DOUBLE_CLICK`), and for a combo the modifier must
already have reached `HOLD` before the trigger's fresh edge.

### 804 · MimicActor — 3 performances, **button-only**

| Button | Clip | 
|---|---|
| **X** | `vq_actor_Take_111` |
| **B** | `vq_actor_Take_125` |
| **A** | `vq_actor_Take_142` |
| *(none)* | `vq_default` — idle/rest embedding (stands still) |

No `SetMotion` path — press the button (or emulate it, see Channel 1 below).

### 805 · MimicPunch — ~20 moves, **button + api_id**

| Buttons | Move (meaning) | SetMotion `api_id` |
|---|---|---:|
| **X** | 057 — **defense** (防御) | **64** |
| **A** | 093 | 81 |
| **B** | 090 | 80 |
| **Y** | 094 — ready (预备) | 82 |
| **UP** | 035 — turn in place (原地掉头) | 60 |
| **LEFT / RIGHT / DOWN** | 051 variants | 61 / 62 / 63 |
| **UP+R1 / LEFT+R1 / RIGHT+R1 / DOWN+R1** | 007 hand variants | 0 / 1 / 2 / 3 |
| **UP+R2 / LEFT+R2 / RIGHT+R2** | 018 leg variants | 20 / 21 / 22 |
| **DOWN+R2** | 020 | 23 |
| **SELECT+R1** | 026 — big hand | 40 |
| **SELECT+R2** | 042 — big hand | 41 |
| **DOWN+L2** | 061 — get-up / get-down | 201 |
| **UP+L2** | get-up (internal) | *(none)* |
| **LEFT+L2** | 067 | *(none)* |

### Channel 1 — the physical remote (both states, no API)

The controller reads `motion_button_map` and plays the clip whose button
gesture the `Gamepad` state machine just observed. `keys` is a `uint16`
bitfield (from the `unitree_sdk2` gamepad struct, LSB first):

```
bit  0 R1     bit  4 R2     bit  8 A      bit 12 up
bit  1 L1     bit  5 L2     bit  9 B      bit 13 right
bit  2 start  bit  6 F1     bit 10 X      bit 14 down
bit  3 select bit  7 F2     bit 11 Y      bit 15 left
```

Examples: defense = `X` = `1<<10` = `0x0400`; big hand = `SELECT+R1` =
`(1<<3)|(1<<0)` = `0x0009`; get-up = `L2+UP` = `(1<<5)|(1<<12)` = `0x1020`.

> ⚠️ **This channel is not reachable from a client.** Publishing a
> `unitree_go::msg::dds_::WirelessController_` on `rt/wirelesscontroller` with
> `keys` set does nothing: the loco service's subscriber for that topic reads
> only the four axes —
>
> ```cpp
> gamepad.setUpWirelessControllerData(msg.lx(), msg.ly(), msg.rx(), msg.ry());
> ```
>
> — and `WirelessController_::keys()` is never called by application code
> (its only references are inside the CycloneDDS serializer templates). Buttons
> enter the `Gamepad` through exactly one path: the LowState subscriber memcpy's
> `LowState_.wireless_remote` (40 bytes, straight from the physical remote) into
> the gamepad buffer and calls `Gamepad::update()`. The axes are therefore
> drivable over WebRTC and the buttons are not — which is why every
> button-gated behaviour in this document (clip selection, the speed profile,
> the `state_change_map` transitions) is remote-only.

### Channel 2 — SetMotion API (805 only)

`LocoServer::SetMotion` parses `data` into a `std::vector<float>` and reads the
**last element as a terminator**, so the parameter is always an array of ≥2
entries — a scalar `{"data": 64}` is rejected with *"At least two values are
required, end value (0/1) !"*.

| Terminator | Effect |
|---|---|
| `0` | append every preceding id to the clip queue |
| `1` | clear the queue and drop the pending clip |

```
1. SetFsmId : api_id 7101, param {"data": 805}
2. SetMotion: api_id 7108, param {"data": [64, 0]}          # queue defense
   SetMotion: api_id 7108, param {"data": [82, 64, 80, 0]}  # queue a 3-move playlist
   SetMotion: api_id 7108, param {"data": [0, 1]}           # flush the queue
```

Ids are clamped on-robot to `[0, 1000]`; an id missing from `offline_trajs` logs
`punch api: <n> not found !` and is skipped. There is **no query API** for the
live id set — the `Get motion ids:` log line is just the controller echoing back
what you queued.

## In this app

The app mirrors the official R1 webview: **`R1_MODES` exposes the four modes the
webview does** — Damping (1), Zero Torque (0), Lock (4), Run (811), in that
order — plus the lie ↔ stand pair (701 / 702) and the dance / martial-arts set
(601-604, 607, 608, where 604 `niuniuwu` 扭扭舞 is labelled **Twist**), and Sit
Down (7).
`R1_ACTIONS` is the 13 arm gestures on api 7106. Nothing else is exposed: the
rest of the FSM table above is documentation, not buttons.

Behaviour copied from the webview:

- **Grey-out** follows `r1RowDisabled`, transcribed from the webview's
  `OperaBar` template (the `menu-item` class binding appends `"disable"` per
  condition). Only three of those clauses are guarded by `series == "R1"`:

  | live state | greyed |
  |---|---|
  | Damping | **Run** |
  | Zero Torque | **Run** |
  | Damping / Zero Torque / Lock | **all arm gestures** |

  Every other clause in that binding is `series == "G1"` and must not be applied
  to R1 — doing so is what used to grey Lock and Zero Torque while in Run. The
  webview greys nothing from the full per-state transition table, which is why
  Lock stays live in 813 and the FSM answers 1001 instead; we match that.
  The webview additionally disables every row while a command is in flight,
  while the joystick is moving, or while the e-stop is engaged; we cover the
  e-stop case through the existing lockout.
- **`r1ClickGuard` (app.ts)** reproduces the webview's two click-time rules:
  Zero Torque is refused unless the robot is already damping (the webview's
  `toastMsg_29`), and Run is a no-op while already running. Everything else is
  sent, and the FSM has the final say.
- **`r1ModeToState`** is a transcription of the webview's `Yo` mode map, fed the
  same way the webview feeds it: `mode ?? fsm_id`. 3 → ZeroTorque, and Run
  covers 811 / 816 / 830 / 831 because an AIR robot redirects a request for 811
  to 830 on-robot.
- **Error codes are decoded** (`R1_FSM_ERRORS`): a failed 7101 logs and toasts
  what 1001 / 1002 / 1003 actually mean instead of a bare number.

The e-stop sends `7101 {"data":1}` (Damping) with `priority: true`. Damping
appears in every state's `set_fsm_white_list`, so it is the one transition that
is always accepted — including from states that refuse everything else.
