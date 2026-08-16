import { RTC_TOPIC, SPORT_CMD } from '../../protocol/topics';
import { cloudApi, isG1Family, type RobotFamily } from '../../api/unitree-cloud';

/** G1 sport-state values — the canonical string names the on-robot
 *  state machine uses. The gating rules below compare against these
 *  exact strings when deciding which rows to disable. */
export const G1_STATE = {
  Idle:        'idle',
  ZeroTorque:  'zeroTorque',
  Damp:        'damping',
  Squat:       'squat',
  Seating:     'seating',
  Preparation: 'preparation',
  Walk:        'walk_g1',
  Walk2:       'walk2_g1',
  Run:         'run_g1',
  Step:        'step',
  Stand:       'stand',
  Dance:       'dance_g1',
  Climb:       'climb',
  Combat:      'combat',
  SquatUp:     'squatUp',
  LieUp:       'lieUp',
} as const;
export type G1State = (typeof G1_STATE)[keyof typeof G1_STATE];

/** Map the numeric mode published in LF_SPORT_MOD_STATE to a G1State
 *  name. Falls back to ZeroTorque when mode is null/NaN — that's the
 *  state the robot defaults to before the first sport-mode-state
 *  message arrives. */
export function g1ModeToState(mode: number | undefined): G1State {
  if (mode === undefined || Number.isNaN(mode)) return G1_STATE.ZeroTorque;
  switch (mode) {
    case 0:   return G1_STATE.ZeroTorque;
    case 1:   return G1_STATE.Damp;
    case 2:   return G1_STATE.Squat;
    case 3:   return G1_STATE.Seating;
    case 4:   return G1_STATE.Preparation;
    case 500: return G1_STATE.Walk;
    case 501: return G1_STATE.Walk2;
    case 503: return G1_STATE.Dance;
    case 706: return G1_STATE.Squat;
    case 801:
    case 802: return G1_STATE.Run;
    case 812: return G1_STATE.Climb;
    default:  return G1_STATE.Idle;
  }
}

/** R1 mode→state map — a transcription of the official webview's `Yo` table
 *  (index-BXEK_QdB.js). The webview normalises the topic the same way we do,
 *  `mode ?? fsm_id ?? 0`, then indexes this map; anything unlisted falls
 *  through to Idle, which simply means "no row highlights".
 *
 *  Note 3 → ZeroTorque (not Seating as on G1), and Run covering 811 plus the
 *  816 / 830 / 831 aliases — on an AIR robot a request for 811 is redirected
 *  on-robot to 830 (`AmpMotionCore::entryGuard`), so both must map to Run. */
export function r1ModeToState(mode: number | undefined): G1State {
  if (mode === undefined || Number.isNaN(mode)) return G1_STATE.ZeroTorque;
  switch (mode) {
    case 0:   return G1_STATE.ZeroTorque;
    case 1:   return G1_STATE.Damp;
    case 2:   return G1_STATE.Squat;
    case 3:   return G1_STATE.ZeroTorque;
    case 4:   return G1_STATE.Preparation;
    case 500: return G1_STATE.Walk;
    case 501: return G1_STATE.Walk2;
    case 503: return G1_STATE.Dance;
    case 706: return G1_STATE.Squat;
    case 811:
    case 816:
    case 830:
    case 831: return G1_STATE.Run;
    default:  return G1_STATE.Idle;
  }
}

export interface RobotAction {
  apiId: number;
  name: string;
  icon: string;
  /** JSON parameter string sent with the request. Defaults to '{}'. */
  param?: string;
  /** Optional override of the publish topic. Defaults to SPORT_MOD for Go2. */
  topic?: string;
  /** Which robot families support this action. Defaults to ['Go2'] when omitted. */
  families?: ReadonlyArray<RobotFamily>;
  /** G1 only: protocol key (state name for modes, gesture name like
   *  'shakeHands_1' for arm actions). The gating rules below are keyed
   *  on these strings — keep them stable. */
  g1Key?: string;
  /** Go2 only: the SPORT_STATE this row represents (lowercase app name, e.g.
   *  'freeBound'). The current-mode highlight matches it against the robot's
   *  live state decoded from LF_SPORT_MOD_STATE via go2DecodeState(). Only
   *  persistent modes carry one (one-shot tricks don't). */
  go2State?: string;
}

// Go2 sport-state decoding. The robot runs one of several motion-control modes
// (motion_switcher name: normal / advanced / ai / ai-w / mcf). These are
// robot-agnostic — they apply across AIR / PRO / EDU. Which FIELD carries the
// current mode depends on the active mode:
//
//  • normal / advanced / ai / ai-w: the active mode is the SMALL mode-dependent
//    enum in LF_SPORT_MOD_STATE.mode (0-20). go2DecodeState() below uses the AI
//    map, the one exposing the AI gaits (FreeBound/FreeJump/FreeAvoid).
//  • mcf: `mode` stays 0; the active mode is reported in `error_code` as a full
//    mode CODE (NOT a bitfield), decoded via GO2_ERR_MODE_MAP. A robot in
//    FreeBound under mcf reports error_code=2008, mode=0.
//
// The caller (app.ts) picks the mechanism from the motion_switcher name.
const GO2_MODE_MAP: Record<number, string> = {
  0: 'idle',
  1: 'balanceStand',
  2: 'pose',
  3: 'locomotion',
  5: 'lieDown',
  6: 'jointLock',
  7: 'damping',
  8: 'recoveryStand',
  9: 'freeWalk',
  10: 'sit',
  15: 'freeBound',
  16: 'freeJump',
  17: 'freeAvoid',
  18: 'stair',
  19: 'stand',
  20: 'crossStep',
};
// gait_type index → gait name.
const GO2_GAIT = ['idle', 'walk', 'run', 'stair', 'downStair', 'adjust'];

// mcf mode — error_code value → action-bar go2State. Unlike the other modes,
// error_code here is a full mode code, not a bitfield. (Note: command api_ids
// differ from these state codes — e.g. the FreeJump command is 2047 but the
// robot reports 2009 while jumping.) A few codes are normalised to the row tag
// the standard `mode` decoder already uses, so one row highlights under either
// mode: StandUp(1002)=lock→jointLock, StandDown(1004)=crouch→lieDown,
// StaticWalk(1015)→walk, WalkStair(2010)→stair.
const GO2_ERR_MODE_MAP: Record<number, string> = {
  0: 'idle',
  100: 'freeWalk',
  1001: 'damping',
  1002: 'jointLock',
  1004: 'lieDown',
  1005: 'move',
  1006: 'hello',
  1007: 'sit',
  1013: 'balanceStand',
  1015: 'walk',
  1016: 'run',
  1017: 'batteryLife',
  1091: 'pose',
  2007: 'freeAvoid',
  2008: 'freeBound',
  2009: 'freeJump',
  2010: 'stair',
  2011: 'handStand',
  2016: 'crossStep',
  2017: 'backStand',
  2019: 'leadFollow',
  2021: 'rageMode',
};

export interface Go2SportRaw {
  mode?: number;
  gait_type?: number;
  error_code?: number;
}

// mcf persistent "last real mode": a BalanceStand / idle / unknown frame keeps
// showing the previously selected gait instead of dropping the highlight — under
// mcf you stay "in" the chosen gait until you switch to another.
let go2McfLast = 'freeWalk';

/** mcf mode: decode the active mode straight from error_code, which is a full
 *  mode code here, not a bitfield. */
export function go2DecodeStateMcf(err: number): string {
  if (!err) return 'freeWalk';
  const mapped = GO2_ERR_MODE_MAP[err];
  if (mapped === 'idle' || mapped === 'hello') return 'freeWalk';
  if (mapped === 'balanceStand' || !mapped) return go2McfLast;
  go2McfLast = mapped;
  return mapped;
}

/** Seed the mcf "last real mode" (the app's sQ()): on a SUCCESSFUL send of Lock
 *  / Run / Static Walk / Endurance the app writes go2McfLast directly, because
 *  in those standing-ish states the robot reports BalanceStand in error_code, so
 *  the highlight would otherwise fall through. Caller passes the row's go2State. */
export function go2McfSeedState(state: string): void {
  go2McfLast = state;
}

/** The exact set of states the app seeds optimistically on a successful send
 *  (sQ for StandUp/Run/StaticWalk/BatteryLife), in this project's row tags. */
export const GO2_MCF_SEED_STATES: ReadonlySet<string> = new Set([
  'jointLock', // StandUp (lock)
  'run',       // Run
  'walk',      // StaticWalk
  'batteryLife', // BatteryLife (Endurance)
]);

/** Decode the Go2's current SPORT_STATE for the action-bar highlight.
 *  `motionMode` is the motion_switcher name: 'mcf' reads the mode out of
 *  error_code (go2DecodeStateMcf); every other mode reports it in the small
 *  `mode` enum. error_code bits (non-mcf modes): 0=continuousGait, 1=standOut,
 *  4=batteryLife, 5=leadFollow. Returns 'balanceStand' when idle (mode 0). */
export function go2DecodeState(d: Go2SportRaw, motionMode?: string): string {
  if (motionMode === 'mcf') return go2DecodeStateMcf(d.error_code ?? 0);
  const mode = d.mode ?? 0;
  const gait = d.gait_type ?? 0;
  const err = d.error_code ?? 0;
  if (!mode) return 'balanceStand';
  if ((err >> 1) & 1) return 'standOut';
  const continuousGait = err & 1;
  if ((err >> 4) & 1) return 'batteryLife';
  if ((err >> 5) & 1) return 'leadFollow';
  const state = GO2_MODE_MAP[mode];
  const gaitName = GO2_GAIT[gait] ?? 'walk';
  if (!state || state === 'idle') return 'balanceStand';
  if (state === 'damping' || state === 'jointLock') return state;
  const locomotionGaits = ['run', 'stair', 'downStair'];
  if (state === 'locomotion' || locomotionGaits.includes(gaitName) || continuousGait === 1) {
    switch (gaitName) {
      case 'walk': return continuousGait ? 'continuousWalk' : 'walk';
      case 'run': return continuousGait ? 'continuousRun' : 'run';
      case 'stair': return 'stair';
      case 'downStair': return 'downStair';
      default: return 'walk';
    }
  }
  return state;
}

const DATA_TRUE = '{"data":true}';

// G1 uses two distinct request IDs:
//   G1State = 7101       — full-body postures/gaits (Zero Torque, Walk, ...)
//   G1UpperLimbs = 7106  — upper-limb gestures (Handshake, Hug, ...)
// The mode/gesture index goes in the parameter as {"data": N}, not in api_id.
// And the topic splits by type: modes → rt/api/sport/request,
// upper-limb gestures → rt/api/arm/request.
export const G1_STATE_API_ID = 7101;
const G1_UPPER_LIMBS_API_ID = 7106;
const wrap = (n: number): string => `{"data":${n}}`;

// Family tagging policy: each list below is single-family.
const GO2: ReadonlyArray<RobotFamily> = ['Go2'];
const G1:  ReadonlyArray<RobotFamily> = ['G1'];
const R1:  ReadonlyArray<RobotFamily> = ['R1'];

/** Go2 actions (tricks/gestures) — fire to rt/api/sport/request. */
export const GO2_ACTIONS: RobotAction[] = [
  { apiId: SPORT_CMD.Wallow, name: 'Roll Over', icon: '/icons/rollOver.svg', families: GO2 },
  { apiId: SPORT_CMD.Stretch, name: 'Stretch', icon: '/icons/stretch.svg', families: GO2 },
  { apiId: SPORT_CMD.Hello, name: 'Shake Hand', icon: '/icons/shakeHands.svg', families: GO2 },
  { apiId: SPORT_CMD.FingerHeart, name: 'Heart', icon: '/icons/showHeart.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontPounce, name: 'Pounce', icon: '/icons/pounceForward.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontJump, name: 'Jump Fwd', icon: '/icons/jumpForward.svg', families: GO2 },
  { apiId: SPORT_CMD.Scrape, name: 'Greet', icon: '/icons/newYear.svg', families: GO2 },
  { apiId: SPORT_CMD.Dance1, name: 'Dance 1', icon: '/icons/dance1.svg', families: GO2 },
  { apiId: SPORT_CMD.Dance2, name: 'Dance 2', icon: '/icons/dance2.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontFlip, name: 'Front Flip', icon: '/sprites/icon_flip_forward.png', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.BackFlip, name: 'Back Flip', icon: '/icons/hand_stand.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.LeftFlip, name: 'Left Flip', icon: '/icons/mode_bound.svg', param: DATA_TRUE, families: GO2 },
  // Moved from modes: these are one-shot postures, not persistent modes
  { apiId: SPORT_CMD.Damp, name: 'Damping', icon: '/icons/mode_damping.svg', families: GO2, go2State: 'damping' },
  { apiId: SPORT_CMD.Sit, name: 'Sit Down', icon: '/icons/sitDown.svg', families: GO2, go2State: 'sit' },
  { apiId: SPORT_CMD.StandDown, name: 'Crouch', icon: '/icons/lieDown.svg', families: GO2, go2State: 'lieDown' },
  { apiId: SPORT_CMD.StandUp, name: 'Lock On', icon: '/icons/mode_locking.svg', families: GO2, go2State: 'jointLock' },
];

/** Go2 modes (persistent postures) — fire to rt/api/sport/request. */
export const GO2_MODES: RobotAction[] = [
  { apiId: SPORT_CMD.FreeWalk, name: 'Free Walk', icon: '/icons/mode_freeWalk.svg', param: DATA_TRUE, families: GO2, go2State: 'freeWalk' },
  { apiId: SPORT_CMD.Pose, name: 'Pose', icon: '/icons/mode_pose.svg', param: DATA_TRUE, families: GO2, go2State: 'pose' },
  { apiId: SPORT_CMD.SwitchGait, name: 'Run', icon: '/icons/mode_run.svg', param: '{"data":1}', families: GO2, go2State: 'run' },
  { apiId: SPORT_CMD.WalkStair, name: 'Walk Stair', icon: '/icons/mode_climbingStairs.svg', param: DATA_TRUE, families: GO2, go2State: 'stair' },
  { apiId: SPORT_CMD.StaticWalk, name: 'Static Walk', icon: '/icons/mode_walk.svg', param: DATA_TRUE, families: GO2, go2State: 'walk' },
  { apiId: SPORT_CMD.EconomicGait, name: 'Endurance', icon: '/icons/mode_batteryLife.svg', param: DATA_TRUE, families: GO2, go2State: 'batteryLife' },
  { apiId: SPORT_CMD.LeadFollow, name: 'Leash', icon: '/icons/mode_traction.svg', param: DATA_TRUE, families: GO2, go2State: 'leadFollow' },
  { apiId: SPORT_CMD.HandStand, name: 'Hand Stand', icon: '/icons/hand_stand.svg', param: DATA_TRUE, families: GO2, go2State: 'handStand' },
  { apiId: SPORT_CMD.FreeAvoid, name: 'Free Avoid', icon: '/icons/mode_ai_avoid.svg', param: DATA_TRUE, families: GO2, go2State: 'freeAvoid' },
  { apiId: SPORT_CMD.FreeBound, name: 'Bound', icon: '/icons/mode_ai_bound.svg', param: DATA_TRUE, families: GO2, go2State: 'freeBound' },
  { apiId: SPORT_CMD.FreeJump, name: 'Jump', icon: '/icons/mode_bound.svg', param: DATA_TRUE, families: GO2, go2State: 'freeJump' },
  { apiId: SPORT_CMD.RecoveryStand, name: 'Stand', icon: '/icons/mode_stand.svg', families: GO2, go2State: 'balanceStand' },
  { apiId: SPORT_CMD.CrossStep, name: 'Cross Step', icon: '/icons/mode_crossStep.svg', param: DATA_TRUE, families: GO2, go2State: 'crossStep' },
  // Moved from actions: these are persistent postures (remain active until next command)
  { apiId: SPORT_CMD.BackStand, name: 'Rear Stand', icon: '/icons/mode_ai_stand.svg', param: DATA_TRUE, families: GO2, go2State: 'backStand' },
  { apiId: SPORT_CMD.RageMode, name: 'Rage', icon: '/icons/mode_runaway.svg', param: DATA_TRUE, families: GO2, go2State: 'rageMode' },
];

// G1 mode/gesture indices. Every G1 row carries the same api_id (7101
// for modes, 7106 for upper-limb gestures); the index goes in `param`.
/** G1 actions (arm gestures) — published on rt/api/arm/request, api_id=7106.
 *  `g1Key` is the canonical gesture name the gating rules key on. */
export const G1_ACTIONS: RobotAction[] = [
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(27), g1Key: 'shakeHands_1',        name: 'Handshake',     icon: '/icons/g1/icon_active_shakeHands.svg',           families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(18), g1Key: 'highFive',            name: 'High Five',     icon: '/icons/g1/icon_active_highFiveCmd.svg',          families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(19), g1Key: 'hug',                 name: 'Hug',           icon: '/icons/g1/icon_active_hug.svg',                  families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(26), g1Key: 'hightWave',           name: 'High Wave',     icon: '/icons/g1/icon_active_hightWave.svg',            families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(17), g1Key: 'clamp',               name: 'Clap',          icon: '/icons/g1/icon_active_clamp.svg',                families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(25), g1Key: 'lowWave',             name: 'Face Wave',     icon: '/icons/g1/icon_active_lowWave.svg',              families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(12), g1Key: 'blowKiss',            name: 'Left Kiss',     icon: '/icons/g1/icon_active_blowKiss.svg',             families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(20), g1Key: 'makeHeartBothHands',  name: 'Arm Heart',     icon: '/icons/g1/icon_active_makeHeartBothHands.svg',   families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(21), g1Key: 'makeHeartSingleHands',name: 'Right Heart',   icon: '/icons/g1/icon_active_makeHeartSingleHands.svg', families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(24), g1Key: 'ultramanRay',         name: 'X-Ray',         icon: '/icons/g1/icon_active_ultramanRay.svg',          families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(15), g1Key: 'bothHandsUp',         name: 'Hands Up',      icon: '/icons/g1/icon_active_bothHandsUp.svg',          families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(23), g1Key: 'singleHandsUp',       name: 'Right Hand Up', icon: '/icons/g1/icon_active_singleHandsUp.svg',        families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(22), g1Key: 'refuse',              name: 'Reject',        icon: '/icons/g1/icon_active_refuse.svg',               families: G1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(36), g1Key: 'forwardPush',         name: 'Forward Push',  icon: '/icons/g1/icon_active_forwardPush.svg',          families: G1 },
  // No dedicated releaseArm icon yet — reuse shakeHands.svg as a placeholder.
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(99), g1Key: 'releaseArm',          name: 'Release Arm',   icon: '/icons/g1/icon_active_shakeHands.svg',           families: G1 },
];

/** G1 modes (persistent postures / gaits) — published on rt/api/sport/request, api_id=7101.
 *  `g1Key` is the canonical state name the gating rules key on. */
export const G1_MODES: RobotAction[] = [
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(1),   g1Key: G1_STATE.Damp,        name: 'Damping',             icon: '/icons/g1/icon_model_damping.svg',     families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(0),   g1Key: G1_STATE.ZeroTorque,  name: 'Zero Torque',         icon: '/icons/g1/icon_model_zeroTorque.svg',  families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(4),   g1Key: G1_STATE.Preparation, name: 'Preparation',         icon: '/icons/g1/icon_model_preparation.svg', families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(3),   g1Key: G1_STATE.Seating,     name: 'Seating',             icon: '/icons/g1/icon_model_seating.svg',     families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(801), g1Key: G1_STATE.Run,         name: 'Run',                 icon: '/icons/g1/icon_model_run.svg',         families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(500), g1Key: G1_STATE.Walk,        name: 'Walk',                icon: '/icons/g1/icon_model_g1_walk.svg',     families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(501), g1Key: G1_STATE.Walk2,       name: 'Walk(Control waist)', icon: '/icons/g1/icon_model_g1_walk.svg',     families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(503), g1Key: G1_STATE.Dance,       name: 'Dance',               icon: '/icons/g1/icon_model_dance_g1.svg',    families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(706), g1Key: G1_STATE.Squat,       name: 'Squat',               icon: '/icons/g1/icon_model_squat.svg',       families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(706), g1Key: G1_STATE.SquatUp,     name: 'Squat-Up',            icon: '/icons/g1/icon_model_squatUp.svg',     families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(702), g1Key: G1_STATE.LieUp,       name: 'Lie Up',              icon: '/icons/g1/icon_model_lieUp.svg',       families: G1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(812), g1Key: G1_STATE.Climb,       name: 'Climb',               icon: '/icons/g1/icon_model_climb.svg',       families: G1 },
];

/** R1 actions (arm gestures) — same arm channel as G1 (rt/api/arm/request,
 *  api_id=7106). Extracted from the Explorer 2.1.2 R1 builder `ege`
 *  activeCmdList: identical to G1 except R1 omits the two heart gestures
 *  (makeHeartBothHands / makeHeartSingleHands), which are dead code in the
 *  R1 builder. Icons are shared with G1. */
export const R1_ACTIONS: RobotAction[] = [
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(27), g1Key: 'shakeHands_1',  name: 'Handshake',     icon: '/icons/g1/icon_active_shakeHands.svg',   families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(18), g1Key: 'highFive',      name: 'High Five',     icon: '/icons/g1/icon_active_highFiveCmd.svg',  families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(19), g1Key: 'hug',           name: 'Hug',           icon: '/icons/g1/icon_active_hug.svg',          families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(26), g1Key: 'hightWave',     name: 'High Wave',     icon: '/icons/g1/icon_active_hightWave.svg',    families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(17), g1Key: 'clamp',         name: 'Clap',          icon: '/icons/g1/icon_active_clamp.svg',        families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(25), g1Key: 'lowWave',       name: 'Face Wave',     icon: '/icons/g1/icon_active_lowWave.svg',      families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(12), g1Key: 'blowKiss',      name: 'Left Kiss',     icon: '/icons/g1/icon_active_blowKiss.svg',     families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(24), g1Key: 'ultramanRay',   name: 'X-Ray',         icon: '/icons/g1/icon_active_ultramanRay.svg',  families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(15), g1Key: 'bothHandsUp',   name: 'Hands Up',      icon: '/icons/g1/icon_active_bothHandsUp.svg',  families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(23), g1Key: 'singleHandsUp', name: 'Right Hand Up', icon: '/icons/g1/icon_active_singleHandsUp.svg', families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(22), g1Key: 'refuse',        name: 'Reject',        icon: '/icons/g1/icon_active_refuse.svg',       families: R1 },
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(36), g1Key: 'forwardPush',   name: 'Forward Push',  icon: '/icons/g1/icon_active_forwardPush.svg',  families: R1 },
  // No dedicated releaseArm icon yet — reuse shakeHands.svg as a placeholder.
  { topic: RTC_TOPIC.G1_ARM_REQUEST, apiId: G1_UPPER_LIMBS_API_ID, param: wrap(99), g1Key: 'releaseArm',    name: 'Release Arm',   icon: '/icons/g1/icon_active_shakeHands.svg',   families: R1 },
];

/** R1 modes (persistent postures) — same sport channel as G1 (api_id=7101,
 *  ROBOT_API_ID_LOCO_SET_FSM_ID; param {"data":<fsm_id>}).
 *
 *  The first four rows are the modes R1 exposes in the official app:
 *  Damp / Zero Torque / Preparation / Run. Two R1-specific quirks vs G1:
 *  Preparation is labelled "Lock" and Run rides on mode id 811 (not 801) —
 *  internally the `AmpMotion22Dof` FSM state.
 *
 *  The remaining rows are the full R1 FSM state table (base ids plus the
 *  dance / martial-arts motions). These are NOT in the official app — they
 *  carry no g1Key so the action bar leaves them always-enabled for testing
 *  (no current-mode highlight, no state gating). See docs/r1_action_list.md.
 *  On the robot most motions are only reachable from a locomotion state
 *  (enter Run first), and some are white-listed (armsdk: 816 / 831 only). */
export const R1_MODES: RobotAction[] = [
  // The four modes the official R1 webview exposes, in its order
  // (index-BXEK_QdB.js `modelCmdList: [v, x, A, y]`).
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(1),   g1Key: G1_STATE.Damp,        name: 'Damping',     icon: '/icons/g1/icon_model_damping.svg',    families: R1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(0),   g1Key: G1_STATE.ZeroTorque,  name: 'Zero Torque', icon: '/icons/g1/icon_model_zeroTorque.svg', families: R1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(4),   g1Key: G1_STATE.Preparation, name: 'Lock',        icon: '/icons/g1/icon_model_preparation.svg',families: R1 },
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(811), g1Key: G1_STATE.Run,         name: 'Run',         icon: '/icons/g1/icon_model_run.svg',        families: R1 },

  // Kept beyond the webview: the lie <-> stand pair and the dance / martial
  // arts set. All are plain SetFsmId rows; the robot answers 1003 for any the
  // firmware doesn't build (the AIR dance set is only 602 / 604 / 607).
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(701), name: 'Stand Up',     icon: '/icons/g1/icon_model_standActive.svg', families: R1 }, // Qishen 起身
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(702), name: 'Lie Down',     icon: '/icons/g1/icon_active_lieDown.svg',    families: R1 }, // Tangxia 躺下
  // SitDown is an analytic state (no policy). Its own white list is empty, so
  // you can leave it for anything; getting IN needs a state that permits it —
  // Lock does, Damping / Run do not. Not in white_list.yaml, so the robot stops
  // reporting fsm_id while sitting and no row will highlight.
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(7),   name: 'Sit Down',     icon: '/icons/g1/icon_model_seating.svg',     families: R1 }, // SitDown
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(601), name: 'Dance 1',      icon: '/icons/g1/icon_active_dance1.svg',     families: R1 }, // dance1_subject2_segment1
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(602), name: 'Dance 2',      icon: '/icons/g1/icon_active_dance2.svg',     families: R1 }, // dance1_subject2_segment2
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(603), name: 'Dance 3',      icon: '/icons/g1/icon_model_dance_g1.svg',    families: R1 }, // dance1_subject2_segment3
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(604), name: 'Twist',        icon: '/icons/g1/icon_model_dance_g1.svg',    families: R1 }, // niuniuwu 扭扭舞
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(607), name: 'Kung Fu',      icon: '/icons/g1/icon_model_combat.svg',      families: R1 }, // gongfu 功夫
  { topic: RTC_TOPIC.SPORT_MOD, apiId: G1_STATE_API_ID, param: wrap(608), name: 'Jeet Kune Do', icon: '/icons/g1/icon_model_combat.svg',      families: R1 }, // jiequandao 截拳道
];

// Legacy aliases retained so anything importing the old names keeps working.
export const ALL_ACTIONS = GO2_ACTIONS;
export const ALL_MODES = GO2_MODES;

/** Pick the action / mode list for the given (or current) family. */
export function actionsForFamily(family: RobotFamily = cloudApi.connectFamily): RobotAction[] {
  if (family === 'R1') return R1_ACTIONS;
  return family === 'G1' ? G1_ACTIONS : GO2_ACTIONS;
}
export function modesForFamily(family: RobotFamily = cloudApi.connectFamily): RobotAction[] {
  if (family === 'R1') return R1_MODES;
  return family === 'G1' ? G1_MODES : GO2_MODES;
}

/** Whether this action is supported on the given (or current) robot family. */
export function actionSupports(a: RobotAction, family: RobotFamily = cloudApi.connectFamily): boolean {
  return (a.families ?? GO2).includes(family);
}

// Key sets used by the G1 gating rules.
const G1_DAMP_TARGETS: ReadonlyArray<string> = [
  G1_STATE.ZeroTorque, G1_STATE.Preparation, G1_STATE.SquatUp, G1_STATE.LieUp,
];
const G1_PREPARATION_TARGETS: ReadonlyArray<string> = [
  G1_STATE.Damp, G1_STATE.Walk, G1_STATE.Walk2, G1_STATE.Run,
];
const G1_LOCOMOTION_STATES: ReadonlyArray<string> = [
  G1_STATE.Walk, G1_STATE.Walk2, G1_STATE.Run,
];
const G1_RUN_HIDDEN_GESTURES: ReadonlyArray<string> = [
  'hug', 'makeHeartBothHands', 'bothHandsUp', 'singleHandsUp',
];

/** Decide whether a G1 action/mode item should be enabled given the
 *  current sport state. Order and conditions are deliberate — change
 *  them only after re-checking the full state-transition matrix.
 *
 *  `type` distinguishes arm gestures from full-body modes; the
 *  arm-gestures-only-during-locomotion rule depends on it. */
export function actionEnabledForG1State(
  a: RobotAction,
  state: G1State,
  type: 'action' | 'mode',
): boolean {
  const k = a.g1Key;
  if (!k) return true;

  // Rule: not in Damp → ZeroTorque / Preparation / SquatUp / LieUp disabled.
  if (state !== G1_STATE.Damp && G1_DAMP_TARGETS.includes(k)) return false;

  // Rule: in ZeroTorque → only Damp is enabled.
  if (state === G1_STATE.ZeroTorque && k !== G1_STATE.Damp) return false;

  // Rule: in Squat → only Damp is enabled.
  if (state === G1_STATE.Squat && k !== G1_STATE.Damp) return false;

  // Rule: in Damp → only ZeroTorque / Preparation / SquatUp / LieUp enabled
  //                 (also disables Damp itself so it can't be re-pressed).
  if (state === G1_STATE.Damp && !G1_DAMP_TARGETS.includes(k)) return false;

  // Rule: in Preparation → only Damp / Walk / Walk2 / Run enabled.
  if (state === G1_STATE.Preparation && !G1_PREPARATION_TARGETS.includes(k)) return false;

  // Rule: arm gestures require a locomotion-active state.
  if (type === 'action' && !G1_LOCOMOTION_STATES.includes(state)) return false;

  // Rule: in Run, 4 specific gestures are hidden (treat as disabled here).
  if (state === G1_STATE.Run && G1_RUN_HIDDEN_GESTURES.includes(k)) return false;

  return true;
}

/** `SetFsmId` (7101) status codes, from the on-robot `SetFsmIdHandler::handle`:
 *  1001/1002 are `StateMachine::changeState()` returning false (the current
 *  state's white/black list refused it); 1003 is the catch block, reached when
 *  `findState(id)` returns null and it throws `"invalid fsm id: …"`. */
export const R1_FSM_ERRORS: Record<number, string> = {
  1001: 'transition refused by the current state',
  1002: 'transition refused by the current state',
  1003: 'invalid fsm id — that state does not exist on this firmware',
};

/** R1 grey-out rules, transcribed from the official webview's `OperaBar`
 *  template — the `menu-item` class binding in index-BXEK_QdB.js, which appends
 *  `"disable"` per condition. Of that long list only three clauses are guarded
 *  by `series == "R1"`; every other clause is `series == "G1"` and must NOT be
 *  applied here (that mistake is what used to grey Lock and Zero Torque in Run):
 *
 *    l == Damp        && row == Run                        → disable
 *    l == ZeroTorque  && row == Run                        → disable
 *    [Damp, ZeroTorque, Preparation].includes(l) && active → disable
 *
 *  Both Run rules agree with the robot: `damping.yaml` and `zero_torque.yaml`
 *  white-list only ZeroTorque/Damping/Stance/Keep, so 811 would be refused.
 *  The third means arm gestures only light up once the robot is actually
 *  standing on a locomotion policy.
 *
 *  Note what is deliberately NOT here: the webview greys nothing based on the
 *  full per-state transition table, which is why pressing Lock from 813 gets
 *  you a live button and an `1001` from the FSM. We match that behaviour. */
export function r1RowDisabled(
  a: RobotAction,
  state: G1State,
  type: 'action' | 'mode',
): boolean {
  if (a.g1Key === G1_STATE.Run && (state === G1_STATE.Damp || state === G1_STATE.ZeroTorque)) {
    return true;
  }
  return type === 'action'
    && (state === G1_STATE.Damp || state === G1_STATE.ZeroTorque || state === G1_STATE.Preparation);
}

export type ActionCallback = (action: RobotAction) => void;

interface ShortcutRef {
  type: 'action' | 'mode';
  index: number;
}

/** Default shortcut bar items */
const DEFAULT_SHORTCUTS: ShortcutRef[] = [
  { type: 'action', index: 0 },
  { type: 'action', index: 1 },
  { type: 'action', index: 2 },
  { type: 'action', index: 3 },
  { type: 'action', index: 4 },
];

export class ActionBar {
  private container: HTMLElement;
  private island: HTMLElement;
  private popup: HTMLElement | null = null;
  private onAction: ActionCallback;
  private editing = false;

  /** Current G1 sport state, derived from LF_SPORT_MOD_STATE.mode by
   *  the host app via setG1State(). Defaults to Idle (treated as
   *  "unknown" → permissive). */
  private g1State: G1State = G1_STATE.Idle;
  /** Current Go2 sport state (SPORT_STATE name) decoded from
   *  LF_SPORT_MOD_STATE.mode, set via setGo2State(). undefined = no active
   *  persistent mode (idle/unknown) → nothing highlighted. */
  private go2State: string | undefined;

  // Items that appear in the shortcut bar
  private shortcuts: ShortcutRef[];

  // Touch scroll state
  private scrollStartX = 0;
  private scrollLeft = 0;
  private isDragging = false;
  private hasDragged = false;

  constructor(parent: HTMLElement, onAction: ActionCallback) {
    this.onAction = onAction;
    this.shortcuts = [...DEFAULT_SHORTCUTS];

    this.container = document.createElement('div');
    this.container.className = 'action-bar-container';

    // Oval transparent island
    this.island = document.createElement('div');
    this.island.className = 'action-island';

    // Grid icon button (4-square) on the left
    const gridBtn = document.createElement('button');
    gridBtn.className = 'action-grid-btn';
    gridBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="1" y="1" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="12" y="1" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="1" y="12" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="12" y="12" width="7" height="7" rx="1.5" fill="white"/>
    </svg>`;
    gridBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopup();
    });
    this.island.appendChild(gridBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'action-island-divider';
    this.island.appendChild(divider);

    // Scrollable action area
    const scrollArea = document.createElement('div');
    scrollArea.className = 'action-island-scroll';
    scrollArea.id = 'action-island-scroll';
    this.island.appendChild(scrollArea);

    this.container.appendChild(this.island);
    this.buildShortcutItems();
    this.setupScrollHandlers();
    parent.appendChild(this.container);
  }

  private buildShortcutItems(): void {
    const scrollArea = this.island.querySelector('#action-island-scroll')!;
    scrollArea.innerHTML = '';

    for (const ref of this.shortcuts) {
      const list = ref.type === 'action' ? actionsForFamily() : modesForFamily();
      const action = list[ref.index];
      if (!action) continue;
      if (!actionSupports(action)) continue;
      const enabled = this.isActionEnabled(action, ref.type);
      const isCurrent = this.isCurrentMode(action);
      let cls = 'action-island-item';
      if (!enabled) cls += ' action-disabled';
      if (isCurrent) cls += ' action-current';
      const btn = document.createElement('button');
      btn.className = cls;
      btn.disabled = !enabled;
      btn.innerHTML = `
        <div class="action-icon-wrap" style="--icon:url('${action.icon}')">
          <img src="${action.icon}" alt="${action.name}" draggable="false" />
        </div>
        <span>${action.name}</span>
      `;
      btn.addEventListener('click', (e) => {
        if (this.hasDragged) { e.preventDefault(); return; }
        if (!this.isActionEnabled(action, ref.type)) return;
        btn.classList.add('active-state');
        setTimeout(() => btn.classList.remove('active-state'), 300);
        this.onAction(action);
      });
      scrollArea.appendChild(btn);
    }

    // "+" add button at the end of carousel (opens popup in edit mode)
    const addBtn = document.createElement('button');
    addBtn.className = 'action-island-item action-add-btn';
    addBtn.innerHTML = `
      <div class="action-icon-wrap">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" stroke-dasharray="4 3"/>
          <line x1="12" y1="7" x2="12" y2="17" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round"/>
          <line x1="7" y1="12" x2="17" y2="12" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <span>Add</span>
    `;
    addBtn.addEventListener('click', (e) => {
      if (this.hasDragged) { e.preventDefault(); return; }
      this.openPopupInEditMode();
    });
    scrollArea.appendChild(addBtn);
  }

  private setupScrollHandlers(): void {
    const scrollArea = this.island.querySelector('#action-island-scroll') as HTMLElement;
    if (!scrollArea) return;

    scrollArea.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.hasDragged = false;
      this.scrollStartX = e.clientX;
      this.scrollLeft = scrollArea.scrollLeft;
      scrollArea.style.cursor = 'grabbing';
    });

    scrollArea.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.scrollStartX;
      if (Math.abs(dx) > 5) this.hasDragged = true;
      scrollArea.scrollLeft = this.scrollLeft - dx;
    });

    const endDrag = () => {
      this.isDragging = false;
      const scrollArea = this.island.querySelector('#action-island-scroll') as HTMLElement;
      if (scrollArea) scrollArea.style.cursor = '';
    };
    scrollArea.addEventListener('pointerup', endDrag);
    scrollArea.addEventListener('pointercancel', endDrag);
  }

  // ── Popup (Action/Mode grid with Edit mode) ──

  private togglePopup(): void {
    if (this.popup) {
      this.closePopup();
      return;
    }
    this.openPopup();
  }

  private openPopup(): void {
    this.editing = false;
    this.popup = document.createElement('div');
    this.popup.className = 'action-popup';

    const header = document.createElement('div');
    header.className = 'action-popup-header';
    header.innerHTML = `<span class="action-popup-title">All</span>`;
    const editBtn = document.createElement('button');
    editBtn.className = 'action-popup-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      this.editing = !this.editing;
      editBtn.textContent = this.editing ? 'Done' : 'Edit';
      this.rebuildPopupGrid();
    });
    header.appendChild(editBtn);
    this.popup.appendChild(header);

    // Action section
    const actionSection = document.createElement('div');
    actionSection.className = 'action-popup-section';
    actionSection.innerHTML = '<div class="action-popup-section-title">Action</div>';
    const actionGrid = document.createElement('div');
    actionGrid.className = 'action-popup-grid';
    actionGrid.id = 'popup-action-grid';
    actionSection.appendChild(actionGrid);
    this.popup.appendChild(actionSection);

    // Mode section
    const modeSection = document.createElement('div');
    modeSection.className = 'action-popup-section';
    modeSection.innerHTML = '<div class="action-popup-section-title">Mode</div>';
    const modeGrid = document.createElement('div');
    modeGrid.className = 'action-popup-grid';
    modeGrid.id = 'popup-mode-grid';
    modeSection.appendChild(modeGrid);
    this.popup.appendChild(modeSection);

    this.container.appendChild(this.popup);
    this.rebuildPopupGrid();

    const closeHandler = (e: PointerEvent) => {
      if (this.popup && !this.popup.contains(e.target as Node) &&
          !(e.target as HTMLElement).closest('.action-grid-btn')) {
        this.closePopup();
        document.removeEventListener('pointerdown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeHandler), 0);
  }

  private closePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
      this.editing = false;
    }
  }

  private rebuildPopupGrid(): void {
    const actionGrid = this.popup?.querySelector('#popup-action-grid');
    const modeGrid = this.popup?.querySelector('#popup-mode-grid');
    if (!actionGrid || !modeGrid) return;

    actionGrid.innerHTML = '';
    modeGrid.innerHTML = '';

    actionsForFamily().forEach((action, idx) => {
      actionGrid.appendChild(this.createPopupItem(action, idx, 'action'));
    });

    modesForFamily().forEach((mode, idx) => {
      modeGrid.appendChild(this.createPopupItem(mode, idx, 'mode'));
    });
  }

  private isInShortcuts(type: 'action' | 'mode', index: number): boolean {
    return this.shortcuts.some((s) => s.type === type && s.index === index);
  }

  private createPopupItem(action: RobotAction, itemIdx: number, type: 'action' | 'mode'): HTMLElement {
    const item = document.createElement('div');
    const enabled = this.isActionEnabled(action, type);
    const isCurrent = this.isCurrentMode(action);
    let cls = 'action-popup-item';
    if (!enabled) cls += ' action-disabled';
    if (isCurrent) cls += ' action-current';
    item.className = cls;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'action-popup-icon';
    iconWrap.style.setProperty('--icon', `url('${action.icon}')`);
    iconWrap.innerHTML = `<img src="${action.icon}" alt="${action.name}" draggable="false" />`;
    item.appendChild(iconWrap);

    const label = document.createElement('span');
    label.className = 'action-popup-label';
    label.textContent = action.name;
    item.appendChild(label);

    if (this.editing) {
      const isInBar = this.isInShortcuts(type, itemIdx);
      const badge = document.createElement('div');
      badge.className = `action-popup-badge ${isInBar ? 'badge-remove' : 'badge-add'}`;
      badge.textContent = isInBar ? '−' : '+';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isInBar) {
          this.shortcuts = this.shortcuts.filter((s) => !(s.type === type && s.index === itemIdx));
        } else {
          this.shortcuts.push({ type, index: itemIdx });
        }
        this.buildShortcutItems();
        this.rebuildPopupGrid();
      });
      item.appendChild(badge);
    } else {
      item.addEventListener('click', () => {
        if (!this.isActionEnabled(action, type)) return;
        this.onAction(action);
        this.closePopup();
      });
    }

    return item;
  }

  /** Highlight the row matching the robot's current sport state — the
   *  "blue" current-mode indicator in the Unitree app. G1 matches on g1Key
   *  vs the FSM state; Go2 matches on go2State vs the decoded `mode`. */
  private isCurrentMode(action: RobotAction): boolean {
    if (isG1Family(cloudApi.connectFamily)) {
      return action.g1Key !== undefined && action.g1Key === this.g1State;
    }
    return action.go2State !== undefined && action.go2State === this.go2State;
  }

  /** Whether the given action should be active right now. Go2 rows are
   *  always enabled; G1 rows consult the full rule set against the
   *  most recent state pushed via setG1State(). */
  private isActionEnabled(action: RobotAction, type: 'action' | 'mode'): boolean {
    // R1 has its own small rule set (r1RowDisabled) taken from the webview's
    // OperaBar template — deliberately NOT the G1 rules below, and deliberately
    // not the full FSM transition table: the webview leaves a row live and lets
    // the robot answer 1001, and so do we.
    if (cloudApi.connectFamily === 'R1') return !r1RowDisabled(action, this.g1State, type);
    if (!isG1Family(cloudApi.connectFamily)) return true;
    return actionEnabledForG1State(action, this.g1State, type);
  }

  /** Called by the host (app.ts) when LF_SPORT_MOD_STATE arrives.
   *  Re-renders the shortcut bar and, if open, the popup. */
  setG1State(state: G1State): void {
    if (this.g1State === state) return;
    this.g1State = state;
    this.buildShortcutItems();
    if (this.popup) this.rebuildPopupGrid();
  }

  /** Called by the host (app.ts) when LF_SPORT_MOD_STATE arrives for Go2.
   *  `state` is the SPORT_STATE name decoded from the robot's reported mode
   *  (go2DecodeState). Re-renders so the matching row shows the highlight. */
  setGo2State(state: string | undefined): void {
    if (this.go2State === state) return;
    this.go2State = state;
    this.buildShortcutItems();
    if (this.popup) this.rebuildPopupGrid();
  }

  private openPopupInEditMode(): void {
    if (this.popup) this.closePopup();
    this.openPopup();
    // Switch to edit mode
    this.editing = true;
    const editBtn = this.popup?.querySelector('.action-popup-edit-btn') as HTMLButtonElement;
    if (editBtn) editBtn.textContent = 'Done';
    this.rebuildPopupGrid();
  }

  toggleMode(): void {
    this.togglePopup();
  }
}
