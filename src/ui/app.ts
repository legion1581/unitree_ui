import type { ConnectionCallbacks, ConnectionConfig, ConnectionState, DataChannelMessage } from '../types';
import { ConnectionPanel } from './connection-panel';
import { Joystick } from './components/joystick';
import { GamepadManager } from './components/gamepad-manager';
import { NavBar } from './components/status-bar';
import { ActionBar, G1_STATE, g1ModeToState, r1ModeToState, go2DecodeState, go2McfSeedState,
  GO2_MCF_SEED_STATES, G1_STATE_API_ID, R1_FSM_ERRORS, type RobotAction } from './components/action-bar';
import { PipCamera } from './components/pip-camera';
import { EmergencyStop, type InputSource } from './components/side-buttons';
import { SettingsDrawer } from './components/settings-drawer';
import { StatusPage } from './components/status-page';
import { ServicesPage, type ServiceEntry } from './components/services-page';
import { SettingsPage, type SettingsState } from './components/settings-page';
import { GO2_AUDIO_API, G1_AUDIO_API } from './components/audio-player';
import { MappingPage } from './components/mapping-page';
import { TeachingPage, type TeachAction } from './components/teaching-page';
import { AccountPage } from './components/account-page';
import { BtStatusIcon, type BluetoothStatus } from './components/bt-status-icon';
import { BtPage } from './components/bt-page';
import { AppSettingsPage } from './components/app-settings-page';
import { log } from './logger';
import { ThemeToggle } from './components/theme-toggle';
import { AccountStatusIcon } from './components/account-status-icon';
import { btBackend } from '../api/bt-backend';
import { cloudApi, isG1Family } from '../api/unitree-cloud';
import { theme } from './theme';
import { connectLocal } from '../connection/local-connector';
import { CustomWebRTCConnection } from '../connection/custom-webrtc';
import { promptAesKey } from './components/aes-key-prompt';
import { connectRemote, loginWithEmail } from '../connection/remote-connector';
import { DataChannelHandler } from '../protocol/data-channel';
import { RTC_TOPIC, SPORT_CMD, DATA_CHANNEL_TYPE, G1_TEACH_API, G1_SPORT_DAMP } from '../protocol/topics';
import { ErrorStore } from '../protocol/error-store';
import { ErrorsBadge } from './components/errors-badge';
import { ErrorToastHost } from './components/error-toast';
import { ErrorsPage } from './components/errors-page';
import { AudioRecorder, convertFileToWav } from './audio-recorder';
import type { WebRTCConnection } from '../connection/webrtc';
import type { Scene3D } from './scene/scene';

type Screen = 'landing' | 'connection' | 'hub' | 'control' | 'status' | 'services' | 'settings' | 'app-settings' | 'mapping' | 'account' | 'bt' | 'errors' | 'teaching';

/** Translate raw connector errors into user-facing messages. The G1
 *  RockChip accepts a single WebRTC client at a time — 429 on con_ing
 *  almost always means the Unitree app or a previous browser tab is
 *  still holding the session. 504 fires while the FSM is mid-transition.
 *  Anything else is passed through verbatim. */
function friendlyConnectError(raw: string): string {
  if (/HTTP 429/.test(raw)) {
    return 'Robot busy: another WebRTC client is already connected. Close the Unitree app (or any other tab connected to this robot), wait ~5 seconds, then retry.';
  }
  if (/HTTP 504/.test(raw)) {
    return 'Robot is mid-transition (504 from RockChip). Wait a few seconds for the FSM to settle, then retry.';
  }
  if (/HTTP 403/.test(raw)) {
    return 'Robot refused the connection (403). Check the serial number and AES key.';
  }
  if (/Device rejected/i.test(raw)) {
    return 'Robot rejected the connection — another client may be connected.';
  }
  return raw;
}

// Robot temperatures are transported as signed bytes but often arrive as
// unsigned (0-255). The official webview reinterprets anything > 127 as
// negative (x - 256) — matches index-CtgArt9k.js m(x). Keeps sub-zero
// readings correct and clamps garbage frames.
function signByte(t: number): number {
  return t > 127 ? t - 256 : t;
}

export class App {
  private root: HTMLElement;
  private currentScreen: Screen = 'landing';
  // True when the user is in Account Manager via the landing screen (not via
  // the in-connection hub). Drives where the back button returns to.
  private accountFromLanding = false;

  // Connection state (persists across screens)
  private connectionPanel: ConnectionPanel | null = null;
  private webrtc: WebRTCConnection | null = null;
  private dataHandler: DataChannelHandler | null = null;
  private videoStream: MediaStream | null = null;
  private connectionConfig: ConnectionConfig | null = null;

  // Control UI components
  private navBar: NavBar | null = null;
  private pipCamera: PipCamera | null = null;
  private controlUi: HTMLElement | null = null;
  private actionBar: ActionBar | null = null;
  private scene3d: Scene3D | null = null;
  // Control-view chrome: the settings icon in the navbar opens this
  // drawer, which also hosts BT-remote / gamepad selection (replaces
  // the old SettingBar and the standalone input-source picker).
  private settingsDrawer: SettingsDrawer | null = null;

  // Audio support
  private audioEl: HTMLAudioElement | null = null;
  private pttActive = false;
  private audioRecorder: AudioRecorder | null = null;
  private audioMonitorActive = false;
  /** In-flight audiohub requests keyed by request id → response resolver. */
  private audioPending = new Map<number, (data: unknown) => void>();
  /** In-flight arm (G1 teaching) requests keyed by request id → resolver.
   *  Resolves with { code, data } so callers can branch on the status code. */
  private armPending = new Map<number, (r: { code: number; data: unknown }) => void>();
  /** mcf only: sport request id → go2State to seed into go2McfLast once the send
   *  is acked with code 0 (the app's sQ for Lock/Run/StaticWalk/Endurance). */
  private mcfSeedPending = new Map<number, string>();
  private teachingPage: TeachingPage | null = null;
  /** 1 Hz keepalive sent while recording a teaching action (api 7110,
   *  action_name:"") — the robot stops recording if it goes silent. */
  private teachHeartbeat = 0;
  /** Last successful audio-list (api 1001) response, warmed on connect so the
   *  player can render instantly on open instead of waiting for the robot. */
  private audioListCache: unknown = null;

  // Status page
  private statusPage: StatusPage | null = null;

  // Services page
  private servicesPage: ServicesPage | null = null;
  // Settings page (hub-side duplicate of the WebView SettingBar +
  // APK-only Data > Remote Control and Data > Permission surfaces).
  private settingsPage: SettingsPage | null = null;
  private settingsState: SettingsState = {
    radarOn: false,
    lidarOn: true,
    volume: 0,
    brightness: 0,
    waistLocked: false,
    remoteSwitchOn: false,
    remoteId: '',
    internetRemoteOn: false,
    inputSources: [],
    activeInputSourceId: null,
  };
  private mappingPage: MappingPage | null = null;
  private accountPage: AccountPage | null = null;
  private serviceEntries: ServiceEntry[] = [];
  private serviceReportTimer: ReturnType<typeof setInterval> | null = null;

  // Joystick state
  private joystickState = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private joystickTimer: ReturnType<typeof setInterval> | null = null;
  /** Number of zero-publish ticks remaining after a joystick release.
   *  We need to publish one final zero (or a few, in case the data
   *  channel drops one) so the robot cancels its last velocity command.
   *  Without this, idle-publish suppression strands the robot on the
   *  last non-zero command and it keeps walking. */
  private joystickReleaseTicks = 0;
  private static readonly JOYSTICK_RELEASE_TICKS = 4;

  // Robot fault tracking — single store, lives across reconnects; cleared on disconnect.
  private errorStore = new ErrorStore();
  private errorToastHost: ErrorToastHost | null = null;
  private errorsBadgeFloating: ErrorsBadge | null = null;
  private errorsPage: ErrorsPage | null = null;

  // Bluetooth status (persistent across screens)
  private btStatusIcon: BtStatusIcon | null = null;
  private themeToggle: ThemeToggle | null = null;
  private accountStatusIcon: AccountStatusIcon | null = null;
  private btStatus: BluetoothStatus = {
    robotConnected: false, robotAddress: '',
    remoteConnected: false, remoteName: '', remoteAddress: '',
  };

  // Active input-source state (BT relay or USB/HID gamepad — mutually
  // exclusive; null = on-screen joysticks).
  private activeSourceId: string | null = null;
  private relayUnsub: (() => void) | null = null;
  private leftJoystickWrap: HTMLElement | null = null;
  private rightJoystickWrap: HTMLElement | null = null;
  private btPage: BtPage | null = null;
  private appSettingsPage: AppSettingsPage | null = null;
  // True when BT page is reached via the landing tile (vs the hub).
  // Drives where the back button returns to (mirrors accountFromLanding).
  private btFromLanding = false;

  // Gamepad (USB / wired / Xbox / etc.) detection state
  private gamepadManager: GamepadManager | null = null;
  private gamepadConnected = false;
  private gamepadName = '';

  // Robot state (accumulated from topic messages)
  private robotState: import('./components/status-page').RobotStatus = {
    batteryPercent: 0,
    batteryCurrent: 0,
    batteryVoltage: 0,
    batteryCycles: 0,
    batteryTemp: 0,
    motorStates: [],
    networkType: '',
    footForce: [],
    imuTemp: 0,
    mode: 0,
    gaitType: 0,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    firmwareVersion: '',
    motionMode: '',
    lidarState: '',
    selfTestResults: [],
  };

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = '';
    root.className = 'app-root';

    // Eager theme init — applies data-theme attribute to <html> so CSS picks it up
    theme();

    // Persistent theme toggle (sun/moon) next to the BT icon
    this.themeToggle = new ThemeToggle(document.body);

    // Persistent account-status indicator — leftmost of the three icons.
    // Pure status display: hover for tooltip, no click action.
    this.accountStatusIcon = new AccountStatusIcon(document.body);

    // Persistent error toast host + floating error badge. The toast host renders
    // bottom-right slide-in notifications on `add_error` deltas (snapshot replays
    // are silent). The floating badge appears top-right whenever the active error
    // set is non-empty, except on the control screen where the inline NavBar
    // badge takes over.
    this.errorToastHost = new ErrorToastHost(document.body, this.errorStore);
    this.errorsBadgeFloating = new ErrorsBadge(document.body, this.errorStore, 'floating');

    // Persistent Bluetooth status icon (mounted on document.body so it survives
    // screen changes). Hidden on the control view where the relay icon takes over.
    this.btStatusIcon = new BtStatusIcon(document.body);
    this.btStatusIcon.onStatusChange((s) => {
      this.btStatus = s;
      // Update mapping page's inline BT icon if present.
      this.mappingPage?.setBtStatus(s);
      // BT-remote / gamepad list now also lives in the Settings page +
      // drawer (BT Remote section), so refresh on every status change
      // rather than only on the control screen.
      this.refreshInputSources();
      // If the active BT remote dropped out, fall back to on-screen joysticks.
      if (!s.remoteConnected && this.activeSourceId?.startsWith('bt:')) {
        this.setActiveInputSource(null);
      }
    });

    // Auto-login: if a token is in localStorage, restore it and refresh
    // proactively so the persistent account-status icon shows the right
    // state on first paint of the landing screen. Also prime the local
    // AES-128 key cache from device/bind/list so WebRTC connect can
    // skip the manual key prompt later.
    if (cloudApi.loadSession()) {
      void cloudApi.ensureFreshToken().then(async (ok) => {
        if (!ok) return;
        if (!cloudApi.user) {
          try { await cloudApi.getUserInfo(); } catch { /* ignore */ }
        }
        try { await cloudApi.listDevices(); } catch { /* ignore */ }
      });
    }

    // Background refresh — checks every 5 minutes whether the access
    // token is within 10 minutes of expiry, and rolls it over if so.
    // Without this, the only refresh path during a long session is the
    // 1001-on-request retry, which still leaves the token expired
    // between requests. ensureFreshToken short-circuits when there's
    // no session, so this is safe to leave running across logout.
    setInterval(() => { void cloudApi.ensureFreshToken(); }, 5 * 60 * 1000);

    // Visibilitychange hook — if the tab was hidden for over a minute,
    // refresh on return. Covers laptop-sleep and long-background-tab
    // cases where the 5-minute timer was throttled/paused by the browser.
    let lastHiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAt = Date.now();
      } else if (lastHiddenAt && Date.now() - lastHiddenAt > 60 * 1000) {
        lastHiddenAt = 0;
        void cloudApi.ensureFreshToken();
      }
    });

    // USB / wired gamepad detection (Gamepad API). Long-lived: scans for
    // pads across reconnects, so we only tear it down when the page unloads.
    this.gamepadManager = new GamepadManager((connected, id) => {
      this.gamepadConnected = connected;
      this.gamepadName = id;
      // Refresh on every change — Settings page + drawer both render
      // the BT-remote list, not just the control view.
      this.refreshInputSources();
      // If the active gamepad disappeared, fall back to on-screen joysticks.
      if (!connected && this.activeSourceId?.startsWith('gamepad:')) {
        this.setActiveInputSource(null);
      }
    });
    window.addEventListener('beforeunload', () => this.gamepadManager?.destroy());

    this.showLandingScreen();
  }

  // ── Screen Navigation ──

  private showLandingScreen(): void {
    this.currentScreen = 'landing';
    this.accountFromLanding = false;
    this.btFromLanding = false;
    this.root.innerHTML = '';
    this.root.className = 'app-root landing-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    const wrap = document.createElement('div');
    wrap.className = 'landing-container';

    const title = document.createElement('h2');
    title.className = 'landing-title';
    title.textContent = 'Unitree UI';
    wrap.appendChild(title);

    const tiles = document.createElement('div');
    tiles.className = 'landing-tiles';

    const connectBtn = document.createElement('button');
    connectBtn.className = 'hub-btn hub-btn-primary';
    connectBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg><span>Connect</span>`;
    connectBtn.addEventListener('click', () => this.showConnectionScreen());
    tiles.appendChild(connectBtn);

    const acctBtn = document.createElement('button');
    acctBtn.className = 'hub-btn hub-btn-secondary';
    acctBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>Account Manager</span>`;
    acctBtn.addEventListener('click', () => {
      this.accountFromLanding = true;
      this.showAccountScreen();
    });
    tiles.appendChild(acctBtn);

    const btBtn = document.createElement('button');
    btBtn.className = 'hub-btn hub-btn-secondary';
    btBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5L6.5 17.5"/></svg><span>Bluetooth</span>`;
    btBtn.addEventListener('click', () => {
      this.btFromLanding = true;
      this.showBtScreen();
    });
    tiles.appendChild(btBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'hub-btn hub-btn-secondary';
    settingsBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>Settings</span>`;
    settingsBtn.addEventListener('click', () => this.showAppSettingsScreen());
    tiles.appendChild(settingsBtn);

    wrap.appendChild(tiles);
    this.root.appendChild(wrap);
  }

  private showConnectionScreen(): void {
    this.currentScreen = 'connection';
    this.root.innerHTML = '';
    this.applyConnectionFamilyClass();
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    const modal = document.createElement('div');
    modal.className = 'connection-modal';
    this.root.appendChild(modal);

    this.connectionPanel = new ConnectionPanel(
      modal,
      (config) => this.connect(config),
      () => this.showLandingScreen(),
      () => {
        this.accountFromLanding = true;
        this.showAccountScreen();
      },
      () => this.applyConnectionFamilyClass(),
    );
  }

  /** Set connection-screen background art to match the currently selected
   *  family. Called on screen entry and whenever the user toggles the
   *  Family pill on the cloud-prefs row. */
  private applyConnectionFamilyClass(): void {
    if (this.currentScreen !== 'connection') return;
    const familyMod = cloudApi.connectFamily === 'G1' ? 'connection-family-g1'
      : cloudApi.connectFamily === 'R1' ? 'connection-family-r1'
      : 'connection-family-go2';
    this.root.className = `app-root connection-screen ${familyMod}`;
  }


  private showHubScreen(): void {
    this.currentScreen = 'hub';
    this.root.innerHTML = '';
    this.root.className = 'app-root hub-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    const hub = document.createElement('div');
    hub.className = 'hub-container';

    const isConnected = !!this.webrtc;
    const isRemoteMode = this.connectionConfig?.mode === 'STA-T';

    // Title + connection info — refreshed whenever the Remote-mode picker
    // changes so the header follows the currently selected robot.
    const title = document.createElement('h2');
    title.className = 'hub-title';
    hub.appendChild(title);

    const info = document.createElement('div');
    info.className = 'hub-info';
    hub.appendChild(info);

    const renderHeader = (): void => {
      const sn = this.connectionConfig?.serialNumber || '';
      const robotName = sn ? sn : (isConnected ? 'Connected' : 'Dashboard');
      title.textContent = robotName;

      const infoItems: string[] = [];
      if (sn) infoItems.push(`SN: ${sn}`);
      if (this.connectionConfig?.ip) infoItems.push(`IP: ${this.connectionConfig.ip}`);
      infoItems.push(`Mode: ${this.connectionConfig?.mode || 'N/A'}`);
      if (isConnected) infoItems.push('WebRTC: Connected');
      else if (isRemoteMode) infoItems.push('WebRTC: Not connected');
      info.textContent = infoItems.join(' | ');
    };
    renderHeader();

    // Remote auto-connects from the Connect screen, so the hub is always
    // shown post-validation — no per-mode WebRTC button or robot picker
    // here. Feature buttons render straight away for both Local and Remote.

    // ── Feature buttons ──
    const btnRow = document.createElement('div');
    btnRow.className = 'hub-buttons';
    const needsWebRTC = false;

    // WebView
    const controlBtn = document.createElement('button');
    controlBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-primary'}`;
    controlBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg><span>WebView</span>`;
    if (!needsWebRTC) controlBtn.addEventListener('click', () => this.showControlUi());
    else controlBtn.disabled = true;
    btnRow.appendChild(controlBtn);

    // Status
    const statusBtn = document.createElement('button');
    statusBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    statusBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg><span>Status</span>`;
    if (!needsWebRTC) statusBtn.addEventListener('click', () => this.showStatusScreen());
    else statusBtn.disabled = true;
    btnRow.appendChild(statusBtn);

    // Errors
    const errorsBtn = document.createElement('button');
    errorsBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    errorsBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Errors</span>`;
    if (!needsWebRTC) errorsBtn.addEventListener('click', () => this.showErrorsScreen());
    else errorsBtn.disabled = true;
    btnRow.appendChild(errorsBtn);

    // Services
    const svcBtn = document.createElement('button');
    svcBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    svcBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg><span>Services</span>`;
    if (!needsWebRTC) svcBtn.addEventListener('click', () => this.showServicesScreen());
    else svcBtn.disabled = true;
    btnRow.appendChild(svcBtn);

    // Settings — duplicate of the in-WebView SettingBar (radar / lidar /
    // lamp / volume / waist-lock). Lets the user tweak these from the hub
    // without entering the control view.
    const settingsBtn = document.createElement('button');
    settingsBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    settingsBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg><span>Controls</span>`;
    if (!needsWebRTC) settingsBtn.addEventListener('click', () => this.showSettingsScreen());
    else settingsBtn.disabled = true;
    btnRow.appendChild(settingsBtn);

    // 3D LiDAR Mapping button — Go2 only. The G1 Explorer webview doesn't
    // expose any mapping UI even though the URDF includes a mid360 LiDAR
    // (verified against the decompiled APK 1.9.3 — pages/ has no mapping
    // chunk and the G1 series subscription path skips rt/utlidar/*).
    if (!isG1Family(cloudApi.connectFamily)) {
      const mapBtn = document.createElement('button');
      mapBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
      mapBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg><span>Mapping</span>`;
      if (!needsWebRTC) mapBtn.addEventListener('click', () => this.showMappingScreen());
      else mapBtn.disabled = true;
      btnRow.appendChild(mapBtn);
    }

    // Demo Teaching — G1 only. Record arm/body trajectories on the robot and
    // play them back (native Explorer feature; Go2 has no equivalent). Ported
    // from com.unitree.g1_d.ui.teaching.* over the arm service (api 7106-7113).
    if (isG1Family(cloudApi.connectFamily)) {
      const teachBtn = document.createElement('button');
      teachBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
      teachBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.2 2.7 3 6 3s6-1.8 6-3v-5"/><line x1="22" y1="10" x2="22" y2="15"/></svg><span>Demo Teaching</span>`;
      if (!needsWebRTC) teachBtn.addEventListener('click', () => this.showTeachingScreen());
      else teachBtn.disabled = true;
      btnRow.appendChild(teachBtn);
    }

    // Account Manager lives on the landing page now — no need to surface it
    // again on the hub. Going back to landing (via Disconnect) and clicking
    // Account Manager covers the same flow.

    hub.appendChild(btnRow);

    // Disconnect button — same for Local and Remote (auto-connect means
    // we're always connected here).
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'hub-btn-disconnect';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', () => this.disconnect());
    hub.appendChild(disconnectBtn);

    this.root.appendChild(hub);
  }

  private showControlUi(): void {
    this.currentScreen = 'control';
    this.root.innerHTML = '';
    this.root.className = 'app-root control-screen';
    this.btStatusIcon?.setVisible(false); this.themeToggle?.setVisible(false);
    this.accountStatusIcon?.setVisible(false);
    this.errorsBadgeFloating?.setVisible(false);

    // Overlay container
    this.controlUi = document.createElement('div');
    this.controlUi.className = 'control-overlay';
    this.root.appendChild(this.controlUi);

    this.init3DScene();

    // Nav bar (top) — back goes to hub. The settings icon at the right
    // opens the in-control settings drawer, which is now the sole entry
    // point for BT-remote / gamepad selection (replaces the old passive
    // BT icon and the separate input-source picker).
    // G1 has no WebRTC audio I/O: its firmware disables the megaphone api
    // (PTT) and never streams the mic over the audio track (confirmed — the
    // remote audio track stays muted=true, no media flows). So omit both the
    // PTT and the audio-monitor buttons on G1. The Audio Player (audiohub
    // library, over the data channel) still works on G1. Go2 keeps both.
    const audioNavCallbacks = isG1Family(cloudApi.connectFamily)
      ? {}
      : {
          onPttStart: () => this.onPttStart(),
          onPttEnd: () => this.onPttEnd(),
          onAudioMonitorStart: () => this.onAudioMonitorStart(),
          onAudioMonitorStop: () => this.onAudioMonitorStop(),
        };
    this.navBar = new NavBar(this.controlUi, () => this.goToHub(), this.errorStore, {
      onMenuClick: () => this.openSettingsDrawer(),
      ...audioNavCallbacks,
    });

    // PIP camera. The PIP bubble swaps the 3D scene and the camera between
    // main-view and pip on tap. G1 has no 3D scene (camera is the only
    // view), so the PIP would be empty in one mode and redundant in the
    // other — skip it on humanoid families.
    if (!isG1Family(cloudApi.connectFamily)) {
      this.pipCamera = new PipCamera(this.controlUi);
      if (this.videoStream) {
        this.pipCamera.setStream(this.videoStream);
      }
      this.pipCamera.setOnTap(() => this.toggleViewMode());
    }

    // Settings drawer — mounted on document.body so the slide-in
    // animation isn't clipped by the control overlay.
    this.settingsDrawer = new SettingsDrawer(this.settingsState, this.buildSettingsCallbacks());
    this.refreshInputSources();
    if (this.activeSourceId !== null) {
      // Active source still selected → keep on-screen joysticks hidden.
      if (this.leftJoystickWrap) this.leftJoystickWrap.style.visibility = 'hidden';
      if (this.rightJoystickWrap) this.rightJoystickWrap.style.visibility = 'hidden';
    }

    // Emergency stop
    new EmergencyStop(this.controlUi, (active) => this.sendStop(active));

    // Operation layout
    const opWrapper = document.createElement('div');
    opWrapper.className = 'operation-wrapper';

    const w1 = document.createElement('div');
    w1.className = 'wrapper-1';
    new Joystick(w1, (out) => {
      this.joystickState.lx = out.x;
      this.joystickState.ly = out.y;
    }, () => {
      this.joystickState.lx = 0;
      this.joystickState.ly = 0;
    });
    opWrapper.appendChild(w1);
    this.leftJoystickWrap = w1;

    const w2 = document.createElement('div');
    w2.className = 'wrapper-2';
    this.actionBar = new ActionBar(w2, (action) => {
      if (this.isEmergencyStopped()) { this.notifyEstopBlocked(); return; }
      if (!this.r1ClickGuard(action)) return;
      // Routing is per-row: G1 modes carry topic=SPORT_MOD with api_id=7101,
      // G1 upper-limb gestures carry topic=G1_ARM_REQUEST with api_id=7106,
      // Go2 rows have no topic and fall back to SPORT_MOD.
      const topic = action.topic ?? RTC_TOPIC.SPORT_MOD;
      // publishRequestLogged opens a collapsed devtools group with the
      // structured request inside; the matching response comes through
      // logResponse() in handleTopicMessage.
      const reqId = this.publishRequestLogged(topic, action.apiId, action.param, {
        label: `action ${action.name}`,
        extra: {
          actionName: action.name,
          family: cloudApi.connectFamily,
          g1Key: action.g1Key ?? null,
        },
      });
      // mcf 1:1 (the app's sQ): Lock/Run/StaticWalk/Endurance report BalanceStand
      // in error_code, so the highlight only sticks if we seed go2McfLast on a
      // successful send. Track the request id; apply when its response acks 0.
      if (
        !isG1Family(cloudApi.connectFamily) &&
        this.robotState.motionMode === 'mcf' &&
        reqId !== undefined &&
        action.go2State !== undefined &&
        GO2_MCF_SEED_STATES.has(action.go2State)
      ) {
        this.mcfSeedPending.set(reqId, action.go2State);
      }
    });
    opWrapper.appendChild(w2);

    const w3 = document.createElement('div');
    w3.className = 'wrapper-3';
    new Joystick(w3, (out) => {
      this.joystickState.rx = out.x;
      this.joystickState.ry = out.y;
    }, () => {
      this.joystickState.rx = 0;
      this.joystickState.ry = 0;
    });
    opWrapper.appendChild(w3);
    this.rightJoystickWrap = w3;

    this.controlUi.appendChild(opWrapper);

    this.startJoystickLoop();

    // Re-apply current battery / network state
    if (this.robotState.batteryPercent > 0) {
      this.navBar?.setBattery(this.robotState.batteryPercent);
    }
    if (this.robotState.networkType) {
      this.navBar?.setNetworkType(this.robotState.networkType);
    }

    // Fetch initial states
    if (isG1Family(cloudApi.connectFamily)) {
      // G1 volume is on the voice service; no head lamp (skip vui brightness).
      this.publishRequestLogged(RTC_TOPIC.VOICE, 1005, '', { label: 'voice/get-volume' });
    } else {
      this.publishRequestLogged(RTC_TOPIC.VUI, 1004, undefined, { label: 'vui/get-volume' });
      this.publishRequestLogged(RTC_TOPIC.VUI, 1006, undefined, { label: 'vui/get-brightness' });
    }
    this.publishRequestLogged(RTC_TOPIC.OBSTACLES_AVOID, 1002, undefined, { label: 'obstacles_avoid/get-state' });
  }

  private showStatusScreen(): void {
    this.currentScreen = 'status';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    this.statusPage = new StatusPage(this.root, this.robotState, () => this.goToHub(), {
      mode: this.connectionConfig?.mode,
      ip: this.connectionConfig?.ip,
      serialNumber: this.connectionConfig?.serialNumber,
    });
  }

  private showServicesScreen(): void {
    this.currentScreen = 'services';
    this.root.innerHTML = '';
    this.root.className = 'app-root services-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    this.servicesPage = new ServicesPage(
      this.root,
      () => this.goToHub(),
      (name, enable) => this.toggleService(name, enable),
    );

    // Show cached service data if we have any
    if (this.serviceEntries.length > 0) {
      this.servicesPage.update(this.serviceEntries);
    }

    // Request a service list report (API 1002: SetReportFreq)
    this.requestServiceReport();
  }

  private showSettingsScreen(): void {
    this.currentScreen = 'settings';
    this.root.innerHTML = '';
    this.root.className = 'app-root settings-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    this.settingsPage = new SettingsPage(
      this.root,
      this.settingsState,
      () => this.goToHub(),
      this.buildSettingsCallbacks(),
    );

    this.probeSettingsState();
    this.refreshInputSources();
  }

  /** Single source of truth for the SettingsCallbacks bundle. Both the
   *  hub Settings page and the in-control drawer use this so the same
   *  controls live in both places. */
  private buildSettingsCallbacks() {
    return {
      family: cloudApi.connectFamily,
      onRadarToggle: (enabled: boolean) => this.sendRadarToggle(enabled),
      onLidarToggle: (enabled: boolean) => this.sendLidarToggle(enabled),
      onLampSet: (level: number) => this.sendLamp(level),
      onLedSet: (color: string, blink: boolean) => this.sendLed(color, blink),
      onLedOff: () => this.sendLedOff(),
      onVolumeSet: (level: number) => this.sendVolume(level),
      onWaistLockToggle: (lock: boolean) => this.sendWaistLock(lock),
      onRemoteSwitchToggle: (on: boolean) => this.sendRemoteSwitch(on),
      onRemoteIdSet: (id: string) => this.sendRemoteIdSet(id),
      onInternetRemoteToggle: (on: boolean) => this.sendInternetRemote(on),
      onInputSourceSelect: (id: string | null) => this.setActiveInputSource(id),
      audio: {
        api: isG1Family(cloudApi.connectFamily) ? G1_AUDIO_API : GO2_AUDIO_API,
        publishRequest: (apiId: number, payload: string) => this.publishAudioRequest(apiId, payload),
        getCachedList: () => this.audioListCache,
        onRecordStart: () => this.onAudioPlayerRecordStart(),
        onRecordStop: (onProgress: (pct: number) => void) => this.onAudioPlayerRecordStop(onProgress),
        onUploadFile: (file: File, onProgress: (pct: number) => void) =>
          this.handleAudioUpload(file, onProgress),
      },
    };
  }

  /** Fire the GETs that populate the Settings page / drawer:
   *   - VUI 1004/1006   → volume / brightness
   *   - OBSTACLES 1002  → obstacle-avoid (Go2)
   *   - rm_con 1001     → internet remote permission
   *   - get_rfpower.sh  → BLE remote-control radio state (Go2)
   *
   *  Used on Settings-page entry and on every drawer open. */
  private probeSettingsState(): void {
    if (isG1Family(cloudApi.connectFamily)) {
      // G1's speaker volume is on the voice service (GET 1005); vui 1004
      // never answers on G1. G1 has no head lamp, so skip vui brightness.
      this.publishRequestLogged(RTC_TOPIC.VOICE, 1005, '', { label: 'voice/get-volume' });
    } else {
      this.publishRequestLogged(RTC_TOPIC.VUI, 1004, undefined, { label: 'vui/get-volume' });
      this.publishRequestLogged(RTC_TOPIC.VUI, 1006, undefined, { label: 'vui/get-brightness' });
    }
    this.publishRequestLogged(RTC_TOPIC.OBSTACLES_AVOID, 1002, undefined, { label: 'obstacles_avoid/get-state' });
    this.publishRequestLogged(RTC_TOPIC.PERMISSION_NET, 1001, undefined, { label: 'permission_net/get' });
    if (!isG1Family(cloudApi.connectFamily)) {
      this.runBashScript('get_rfpower.sh');
    }
  }

  private openSettingsDrawer(): void {
    if (!this.settingsDrawer) return;
    // Push the latest cached state into the drawer before opening so
    // toggles aren't stale, then probe the dog for fresh values.
    this.settingsDrawer.setState(this.settingsState);
    this.settingsDrawer.open();
    this.settingsDrawer.refreshAudio();
    this.probeSettingsState();
  }

  private showErrorsScreen(): void {
    this.currentScreen = 'errors';
    this.root.innerHTML = '';
    this.root.className = 'app-root errors-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    this.errorsPage = new ErrorsPage(this.root, this.errorStore, () => this.goToHub());
  }

  private showMappingScreen(): void {
    this.currentScreen = 'mapping';
    this.root.innerHTML = '';
    this.root.className = 'app-root mapping-screen';
    // The mapping page-header has its own inline BT + theme + battery cluster
    // (same shape as NavBar) — hide the body-mounted persistent icons so they
    // don't overlap.
    this.btStatusIcon?.setVisible(false); this.themeToggle?.setVisible(false);
    this.accountStatusIcon?.setVisible(false);
    this.errorsBadgeFloating?.setVisible(false);

    this.mappingPage = new MappingPage(
      this.root,
      () => this.goToHub(),
      (topic, data) => this.dataHandler?.publish(topic, data),
      (topic) => this.dataHandler?.subscribe(topic),
      (topic) => this.dataHandler?.unsubscribe(topic),
      (path, cb) => this.dataHandler?.requestFile(path, cb),
      (path, b64, onProgress) =>
        this.dataHandler
          ? this.dataHandler.pushFile(path, b64, 'uslam_final_pcd', 30 * 1024, onProgress)
          : Promise.reject(new Error('Data channel not ready')),
    );
    // Seed the battery widget with the last-known value so it's not blank
    // until the next LOW_STATE message arrives.
    if (this.robotState.batteryPercent > 0) {
      this.mappingPage.setBattery(this.robotState.batteryPercent);
    }
    // Seed network type so the header shows it on entry.
    if (this.connectionConfig?.mode) {
      this.mappingPage.setNetworkType(this.connectionConfig.mode);
    }
    // Seed motor temp from cached state.
    if (this.robotState.motorStates.length > 0) {
      const temps = this.robotState.motorStates.map((m) => m.temp).filter((t): t is number => Number.isFinite(t));
      if (temps.length > 0) this.mappingPage.setMotorTemp(Math.max(...temps));
    }
    // Forward BT status changes so the inline BT icon stays in sync.
    this.mappingPage.setBtStatus(this.btStatus);

    // Re-send VID enable on the data channel so the video track stays alive
    // when entering the mapping page (it's already on after connection
    // validation, but a duplicate is harmless and keeps the contract obvious).
    this.dataHandler?.publishTyped('', 'on', DATA_CHANNEL_TYPE.VID);

    // Attach the existing video stream to the page's PiP overlay.
    if (this.videoStream) {
      this.mappingPage.setStream(this.videoStream);
    }
  }

  private showAccountScreen(): void {
    this.currentScreen = 'account';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);
    const back = this.accountFromLanding ? () => this.showLandingScreen() : () => this.goToHub();
    this.accountPage = new AccountPage(this.root, back);
  }

  private showBtScreen(): void {
    this.currentScreen = 'bt';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);
    this.btPage?.destroy();
    const back = this.btFromLanding ? () => this.showLandingScreen() : () => this.goToHub();
    this.btPage = new BtPage(this.root, back);
  }

  /** Landing-screen Settings page — app-wide preferences (theme, console
   *  logging). Distinct from the hub's robot Settings page which controls
   *  on-robot state (volume, lidar, etc.). */
  private showAppSettingsScreen(): void {
    this.currentScreen = 'app-settings';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);
    this.appSettingsPage?.destroy();
    this.appSettingsPage = new AppSettingsPage(this.root, () => this.showLandingScreen());
  }

  private goToHub(): void {
    // Clean up control UI resources without disconnecting
    this.stopJoystickLoop();
    this.setActiveInputSource(null);
    this.btPage?.destroy();
    this.btPage = null;
    this.stopBgNoise();
    this.pipCamera?.destroy();
    this.pipCamera = null;
    this.navBar = null;
    this.actionBar = null;
    this.settingsDrawer?.destroy();
    this.settingsDrawer = null;
    this.clearEstopToast();
    this.emergencyStopped = false;
    this.scene3d?.destroy();
    this.scene3d = null;
    this.stopTeachHeartbeat();
    this.teachingPage?.destroy();
    this.teachingPage = null;
    this.statusPage = null;
    this.servicesPage = null;
    this.settingsPage = null;
    this.errorsPage = null;
    this.mappingPage?.destroy();
    this.mappingPage = null;
    this.accountPage?.destroy();
    this.accountPage = null;
    this.viewMode = 'three';
    this.showHubScreen();
  }

  private async init3DScene(): Promise<void> {
    // G1's Explorer webview ships no 3D model — the camera stream IS the
    // view. Skip Scene3D / Go2.glb load; mount the fullscreen video bg
    // immediately and lock viewMode to 'video' so the rest of the UI
    // (toggle, PIP) doesn't try to swap with a non-existent canvas.
    if (isG1Family(cloudApi.connectFamily)) {
      this.viewMode = 'video';
      this.videoBg = document.createElement('video');
      this.videoBg.id = 'video-bg';
      this.videoBg.className = 'video-bg-fullscreen';
      this.videoBg.autoplay = true;
      this.videoBg.playsInline = true;
      this.videoBg.muted = true;
      // Override the .video-bg-fullscreen CSS default of display:none —
      // Go2's setViewMode() does this in the swap path; for G1 we mount
      // the video element straight to visible.
      this.videoBg.style.display = 'block';
      this.root.insertBefore(this.videoBg, this.controlUi);
      this.noiseBgCanvas = document.createElement('canvas');
      this.noiseBgCanvas.id = 'noise-bg';
      this.noiseBgCanvas.className = 'noise-bg-fullscreen';
      this.root.insertBefore(this.noiseBgCanvas, this.controlUi);
      if (this.videoStream) {
        this.videoBg.srcObject = this.videoStream;
      } else {
        // Static-noise placeholder until the WebRTC video track lands.
        // The handler in onVideoTrack swaps the noise canvas off and the
        // video element on (it's already display:block) when stream arrives.
        this.noiseBgCanvas.style.display = 'block';
        this.startBgNoise();
      }
      return;
    }
    try {
      const { Scene3D: S3D } = await import('./scene/scene');
      const canvas = document.createElement('canvas');
      canvas.id = 'three-canvas';
      this.root.insertBefore(canvas, this.controlUi);
      this.scene3d = new S3D(canvas);
      // Surface the APK's toastMsg_4 / _5 — a one-liner indicating the
      // view that was just entered. Reuses the estop-toast surface for
      // visual consistency.
      this.scene3d.onViewChange = (view) => {
        const label = view === 'follow' ? 'Robot view' : 'Holistic view';
        this.showSceneToast(`Switched to ${label}`);
      };
    } catch (err) {
      log.ui.warn('[go2:ui] WebGL not available:', err);
      this.root.classList.add('no-webgl');
    }
  }

  private sceneToastEl: HTMLElement | null = null;
  private sceneToastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Show a transient message inside the 3D view (view-mode change,
   *  in future maybe other passive events). Mirrors the estop toast
   *  surface but lives separately so the two don't fight. */
  private showSceneToast(text: string): void {
    if (this.sceneToastTimer) clearTimeout(this.sceneToastTimer);
    if (!this.sceneToastEl) {
      this.sceneToastEl = document.createElement('div');
      this.sceneToastEl.className = 'scene-toast';
      (this.controlUi ?? document.body).appendChild(this.sceneToastEl);
    }
    this.sceneToastEl.textContent = text;
    this.sceneToastEl.classList.add('show');
    this.sceneToastTimer = setTimeout(() => {
      this.sceneToastEl?.classList.remove('show');
    }, 1500);
  }

  // ── View Toggle: 'three' (3D full, camera PIP) or 'video' (camera full) ──

  private viewMode: 'three' | 'video' = 'three';
  private videoBg: HTMLVideoElement | null = null;
  private noiseBgCanvas: HTMLCanvasElement | null = null;
  private noiseBgAnimId = 0;

  private toggleViewMode(): void {
    this.setViewMode(this.viewMode === 'three' ? 'video' : 'three');
  }

  private setViewMode(mode: 'three' | 'video'): void {
    this.viewMode = mode;
    const threeCanvas = document.getElementById('three-canvas') as HTMLCanvasElement | null;
    if (!threeCanvas) return;

    if (!this.videoBg) {
      this.videoBg = document.createElement('video');
      this.videoBg.id = 'video-bg';
      this.videoBg.className = 'video-bg-fullscreen';
      this.videoBg.autoplay = true;
      this.videoBg.playsInline = true;
      this.videoBg.muted = true;
      this.root.insertBefore(this.videoBg, this.controlUi);
    }

    if (!this.noiseBgCanvas) {
      this.noiseBgCanvas = document.createElement('canvas');
      this.noiseBgCanvas.id = 'noise-bg';
      this.noiseBgCanvas.className = 'noise-bg-fullscreen';
      this.root.insertBefore(this.noiseBgCanvas, this.controlUi);
    }

    threeCanvas.style.display = 'none';
    this.videoBg.style.display = 'none';
    this.noiseBgCanvas.style.display = 'none';
    this.stopBgNoise();

    if (mode === 'three') {
      // Main: 3D voxel map, PIP: camera feed
      threeCanvas.style.display = 'block';
      this.videoBg.srcObject = null;
      this.pipCamera?.showCamera();
    } else {
      // Main: camera feed, PIP: 3D voxel map mirrored
      if (this.videoStream) {
        this.videoBg.srcObject = this.videoStream;
        this.videoBg.style.display = 'block';
      } else {
        this.noiseBgCanvas.style.display = 'block';
        this.startBgNoise();
      }
      this.pipCamera?.showVoxel(threeCanvas);
    }
  }

  private startBgNoise(): void {
    if (this.noiseBgAnimId || !this.noiseBgCanvas) return;
    const canvas = this.noiseBgCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = 320;
    canvas.height = 240;
    const draw = () => {
      const imageData = ctx.createImageData(canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      this.noiseBgAnimId = requestAnimationFrame(draw);
    };
    this.noiseBgAnimId = requestAnimationFrame(draw);
  }

  private stopBgNoise(): void {
    if (this.noiseBgAnimId) {
      cancelAnimationFrame(this.noiseBgAnimId);
      this.noiseBgAnimId = 0;
    }
  }

  // ── Joystick Publishing Loop ──

  private customSeq = 0;
  private customMode = 'move';
  private customOdom: { x: number; y: number; z: number; yaw: number } | null = null;

  private startJoystickLoop(): void {
    this.joystickTimer = setInterval(() => {
      // First, read gamepad if present to potentially switch activeSourceId
      if (this.gamepadManager && this.gamepadManager.currentState && !this.activeSourceId?.startsWith('gamepad:')) {
         const { lx, ly, rx, ry, keys } = this.gamepadManager.currentState;
         // The FlySky FS-i6s emulator maps non-zero default values (like -1 on axes)
         // so we don't automatically lock onto it just from jitter. But we will lock
         // on if the user explicitly wiggles it.
         if (Math.abs(lx) > 0.1 || Math.abs(ly) > 0.1 || Math.abs(rx) > 0.1 || Math.abs(ry) > 0.1 || keys !== 0) {
           this.setActiveInputSource('gamepad:0');
         }
      }

      // Gamepad active → publish its state on the same 20 Hz cadence.
      if (this.activeSourceId?.startsWith('gamepad:') && this.gamepadManager?.currentState) {
        if (this.connectionConfig?.mode === 'CUSTOM') {
          // Custom WebSocket payload
          const gpMatch = this.activeSourceId.match(/^gamepad:(\d+)$/);
          const gpIndex = gpMatch ? parseInt(gpMatch[1], 10) : null;
          // activeSourceId maps to 'gamepad:0', 'gamepad:1' etc.
          const gamepads = Array.from(navigator.getGamepads());
          const gp = gamepads.find(g => g && (gpIndex !== null ? g.index === gpIndex : g.id === this.gamepadManager?.currentState?.id));
          if (gp) {
            // Note: The screenshot shows Left Stick Y is moving `axes[2]` instead of `axes[1]`.
            // We'll read both axes[1] and axes[2] so it works regardless of which stick is used.
            const rawVy = gp.axes.length > 0 ? gp.axes[0] : 0;
            const rawVx1 = gp.axes.length > 1 ? -gp.axes[1] : 0;
            const rawVx2 = gp.axes.length > 2 ? -gp.axes[2] : 0;
            // Use whichever vx axis has the larger magnitude
            const vx = Math.abs(rawVx1) > Math.abs(rawVx2) ? rawVx1 : rawVx2;
            const vy = rawVy;
            const wz = gp.axes.length > 3 ? -gp.axes[3] : 0;
            const deadman = true; // Hardcode to true to ensure movement works

            const axis4 = gp.axes.length > 4 ? gp.axes[4] : 0;
            const axis5 = gp.axes.length > 5 ? gp.axes[5] : 0;

            // Determine custom mode from axis 4 (2-way) and axis 5 (3-way)
            // Axis 4: move vs emergency stop
            let newMode = 'sleep';
            if (axis4 > 0.0) {
              newMode = 'estop';
            } else {
              // Axis 5: sleep, stand, move
              if (axis5 < -0.3) {
                newMode = 'sleep';
              } else if (axis5 > 0.3) {
                newMode = 'move';
              } else {
                newMode = 'stand';
              }
            }
            this.customMode = newMode;

            const payload = {
              seq: this.customSeq++,
              t_ms: Date.now(),
              deadman,
              vx,
              vy,
              wz,
              mode: this.customMode,
              // Send raw axes and buttons for the Xterra simulation
              priority: 0,
              axes: gp.axes,
              buttons: gp.buttons.map(btn => btn.pressed ? 1 : 0),
            };

            if (this.webrtc && typeof (this.webrtc as any).send === 'function') {
              (this.webrtc as any).send(JSON.stringify(payload));
              if (this.customSeq % 20 === 0) {
                 console.log('[gamepad custom payload] sent:', payload);
              }
            }

            // --- LOCAL KINEMATIC SIMULATION HACK ---
            if (this.scene3d) {
              if (!this.customOdom) {
                this.customOdom = { x: 0, y: 0, z: 0, yaw: 0 };
              }
              const dt = 0.05; // 50ms loop matches the setInterval cadence
              const v_forward = vx * 2.0; // scales up speed for visual effect
              const v_side = vy * 1.0;
              const v_turn = wz * 1.5;

              this.customOdom.yaw += v_turn * dt;
              this.customOdom.x += (Math.cos(this.customOdom.yaw) * v_forward - Math.sin(this.customOdom.yaw) * v_side) * dt;
              this.customOdom.y += (Math.sin(this.customOdom.yaw) * v_forward + Math.cos(this.customOdom.yaw) * v_side) * dt;

              const halfYaw = this.customOdom.yaw * 0.5;
              const qw = Math.cos(halfYaw);
              const qz = Math.sin(halfYaw);

              this.scene3d.robotModel.updateOdom(
                { x: this.customOdom.x, y: this.customOdom.y, z: 0 },
                { x: 0, y: 0, z: qz, w: qw }
              );
            }
          }
          return;
        }

        const { lx, ly, rx, ry, keys } = this.gamepadManager.currentState;
        const inUse = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || keys !== 0;
        if (inUse) {
          this.joystickReleaseTicks = App.JOYSTICK_RELEASE_TICKS;
        } else if (this.joystickReleaseTicks <= 0) {
          return;
        } else {
          this.joystickReleaseTicks--;
        }
        if (this.isEmergencyStopped()) { this.notifyEstopBlocked(); this.joystickReleaseTicks = 0; return; }
        this.dataHandler?.publish(RTC_TOPIC.WIRELESS_CONTROLLER, { lx, ly, rx, ry, keys });
        return;
      }
      // BT relay subscribes to remote_state and publishes itself, so skip.
      if (this.activeSourceId?.startsWith('bt:')) return;
      // Default: on-screen joysticks.
      if (this.connectionConfig?.mode === 'CUSTOM') {
        const { lx, ly, rx, ry } = this.joystickState;

        const payload = {
          seq: this.customSeq++,
          t_ms: Date.now(),
          deadman: true, // always send true to ensure robot accepts movement
          vx: ly, // ly is already inverted?
          vy: lx,
          wz: rx,
          mode: this.customMode,
          // Map on-screen joystick state to raw axes for Xterra fallback
          // (assuming standard gamepad mapping: ax0=LeftX, ax1=LeftY, ax2=RightX, ax3=RightY)
          priority: 0,
          axes: [lx, -ly, -rx, -ry, 0, 0],
          buttons: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        };

        if (this.webrtc && typeof (this.webrtc as any).send === 'function') {
          (this.webrtc as any).send(JSON.stringify(payload));
          if (this.customSeq % 20 === 0) {
             console.log('[on-screen custom payload] sent:', payload);
          }
        }

        // --- LOCAL KINEMATIC SIMULATION HACK ---
        if (this.scene3d) {
          if (!this.customOdom) {
            this.customOdom = { x: 0, y: 0, z: 0, yaw: 0 };
          }
          const dt = 0.05; // 50ms loop
          const v_forward = ly * 2.0;
          const v_side = lx * 1.0;
          const v_turn = rx * 1.5;

          this.customOdom.yaw += v_turn * dt;
          this.customOdom.x += (Math.cos(this.customOdom.yaw) * v_forward - Math.sin(this.customOdom.yaw) * v_side) * dt;
          this.customOdom.y += (Math.sin(this.customOdom.yaw) * v_forward + Math.cos(this.customOdom.yaw) * v_side) * dt;

          const halfYaw = this.customOdom.yaw * 0.5;
          const qw = Math.cos(halfYaw);
          const qz = Math.sin(halfYaw);

          this.scene3d.robotModel.updateOdom(
            { x: this.customOdom.x, y: this.customOdom.y, z: 0 },
            { x: 0, y: 0, z: qz, w: qw }
          );
        }

        return;
      }
      const { lx, ly, rx, ry } = this.joystickState;
      const inUse = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0;
      if (inUse) {
        this.joystickReleaseTicks = App.JOYSTICK_RELEASE_TICKS;
      } else if (this.joystickReleaseTicks <= 0) {
        return;
      } else {
        this.joystickReleaseTicks--;
      }
      if (this.isEmergencyStopped()) { this.notifyEstopBlocked(); this.joystickReleaseTicks = 0; return; }
      this.dataHandler?.publish(RTC_TOPIC.WIRELESS_CONTROLLER, { lx, ly, rx, ry });
    }, 50);
  }

  private stopJoystickLoop(): void {
    if (this.joystickTimer) {
      clearInterval(this.joystickTimer);
      this.joystickTimer = null;
    }
  }

  // ── Input Source (BT relay or USB/HID gamepad) ──

  /** Build the picker source list from current BT + gamepad availability
   *  and push it to the navbar input-source icon. Each "kind" currently
   *  has at most one entry (backend constraint); when that grows the list
   *  just gets longer. */
  private refreshInputSources(): void {
    const sources: InputSource[] = [];
    if (this.btStatus.remoteConnected) {
      const label = this.btStatus.remoteName || this.btStatus.remoteAddress || 'BLE remote';
      sources.push({
        id: `bt:${this.btStatus.remoteAddress || 'unknown'}`,
        kind: 'bt',
        label,
      });
    }
    if (this.gamepadConnected) {
      sources.push({
        id: 'gamepad:0',
        kind: 'gamepad',
        label: this.gamepadName || 'USB / wireless gamepad',
      });
    }
    this.settingsState.inputSources = sources;
    this.settingsState.activeInputSourceId = this.activeSourceId;
    this.settingsPage?.setState({
      inputSources: sources,
      activeInputSourceId: this.activeSourceId,
    });
    this.settingsDrawer?.setState({
      inputSources: sources,
      activeInputSourceId: this.activeSourceId,
    });
  }

  /** Switch the active input source. Pass null to fall back to on-screen
   *  joysticks. Tears down the previous source's subscription / state. */
  private setActiveInputSource(id: string | null): void {
    if (id === this.activeSourceId) return;

    // Tear down the previous source.
    if (this.activeSourceId?.startsWith('bt:')) {
      this.relayUnsub?.();
      this.relayUnsub = null;
    }
    // (Gamepad has no per-activation subscription — just stops being read.)

    this.activeSourceId = id;

    if (id === null) {
      // Restore on-screen joysticks.
      if (this.leftJoystickWrap) this.leftJoystickWrap.style.visibility = '';
      if (this.rightJoystickWrap) this.rightJoystickWrap.style.visibility = '';
    } else {
      // Hide on-screen joysticks; zero their state to be safe.
      this.joystickState = { lx: 0, ly: 0, rx: 0, ry: 0 };
      if (this.leftJoystickWrap) this.leftJoystickWrap.style.visibility = 'hidden';
      if (this.rightJoystickWrap) this.rightJoystickWrap.style.visibility = 'hidden';

      if (id.startsWith('bt:')) {
        // Subscribe to BT backend remote_state → publish on every packet (~20 Hz).
        const order = ['R1','L1','Start','Select','R2','L2','F1','F2','A','B','X','Y','Up','Right','Down','Left'];
        this.relayUnsub = btBackend().subscribe('remote_state', (s: { lx: number; ly: number; rx: number; ry: number; buttons: Record<string, boolean> }) => {
          if (!this.dataHandler) return;
          let keys = 0;
          for (let i = 0; i < order.length; i++) {
            if (s.buttons[order[i]]) keys |= (1 << i);
          }
          const inUse = s.lx !== 0 || s.ly !== 0 || s.rx !== 0 || s.ry !== 0 || keys !== 0;
          if (!inUse) return;
          if (this.isEmergencyStopped()) { this.notifyEstopBlocked(); return; }
          this.dataHandler.publish(RTC_TOPIC.WIRELESS_CONTROLLER, {
            lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry, keys,
          });
        });
      }
      // Gamepad path: startJoystickLoop reads gamepadManager.currentState directly.
    }

    this.settingsState.activeInputSourceId = this.activeSourceId;
    this.settingsPage?.setState({ activeInputSourceId: this.activeSourceId });
    this.settingsDrawer?.setState({ activeInputSourceId: this.activeSourceId });
  }

  // ── Video & Topic Subscriptions ──

  private enableVideoAndSubscribe(): void {
    if (!this.dataHandler) return;

    this.dataHandler.publishTyped('', {
      req_type: 'disable_traffic_saving',
      instruction: 'on',
    }, DATA_CHANNEL_TYPE.RTC_INNER_REQ);

    this.dataHandler.publishTyped('', 'on', DATA_CHANNEL_TYPE.VID);
    this.dataHandler.publishTyped('', 'on', DATA_CHANNEL_TYPE.AUD);

    // Subscribe to data topics (matching APK's WebRTC bridge subscriptions).
    // Family-specific paths:
    //   * Go2: bms_state lives inside lowstate; single IMU on imu_state.
    //   * G1:  bms_state arrives on its own topic (rt/lf/bmsstate);
    //          dual IMU on rt/lf/lowstate_doubleimu (Body + Crotch);
    //          no LiDAR / SLAM topics — Explorer doesn't expose them.
    this.dataHandler.subscribe(RTC_TOPIC.LOW_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.LF_SPORT_MOD_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.MULTIPLE_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.SELFTEST);
    this.dataHandler.subscribe(RTC_TOPIC.SERVICE_STATE);
    // Audiohub playback-state — keeps the audio player's play indicator in
    // sync. Go2 pushes full state on rt/audiohub/player/state; G1 only emits
    // a play_state signal on rt/audio_msg/filter. Subscribe to both.
    this.dataHandler.subscribe(RTC_TOPIC.AUDIOHUB_PLAY_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.AUDIO_MSG_FILTER);
    if (isG1Family(cloudApi.connectFamily)) {
      this.dataHandler.subscribe(RTC_TOPIC.BMS_STATE);
      this.dataHandler.subscribe(RTC_TOPIC.SECONDARY_IMU);
      this.dataHandler.subscribe(RTC_TOPIC.G1_ARM_ACTION_STATE);
      // Body/chassis temperature for the status bar — G1 carries it on the
      // mainboard topic (temperature[0]), not in the IMU. Go2 reads it from
      // lowstate.temperature_ntc1, handled inline in handleLowState.
      this.dataHandler.subscribe(RTC_TOPIC.MAIN_BOARD_STATE);
    } else {
      this.dataHandler.subscribe(RTC_TOPIC.ROBOT_ODOM);
      this.dataHandler.subscribe(RTC_TOPIC.LIDAR_ARRAY);
      this.dataHandler.subscribe(RTC_TOPIC.LIDAR_STATE);
      // Enable LiDAR (send 5 times for reliability, like APK).
      // G1 has a mid360 in the URDF but the Explorer webview never
      // toggles it on, so we skip the switch on humanoid families.
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          this.dataHandler?.publish(RTC_TOPIC.LIDAR_SWITCH, 'ON');
        }, i * 100);
      }
    }

    this.dataHandler.onTopicData = (msg) => this.handleTopicMessage(msg);
    this.pollNetworkType();

    // APK init requests: firmware version, motion mode, gas sensor
    this.runBashScript('get_whole_packet_version.sh');
    this.publishRequestLogged(RTC_TOPIC.MOTION_SWITCHER, 1001, undefined, { label: 'motion_switcher/get-mode' });
    this.publishRequestLogged(RTC_TOPIC.GAS_SENSOR, 1002, undefined, { label: 'gas_sensor/get-state' });

    // Warm the audio-library cache so the player renders instantly when the
    // user opens Controls (the robot's first 1001 response is slow). Delayed
    // slightly so it doesn't compete with the initial state probes.
    setTimeout(() => { void this.publishAudioRequest(1001, '{}'); }, 1500);

    // G1 has dedicated hardware + software version scripts
    // (BaseRunner.GET_HARDWARE_VERSION, GET_SOFTWARE_VERSION) per
    // com/unitree/webrtc/data/BaseRunner.java in the decompiled apk.
    if (isG1Family(cloudApi.connectFamily)) {
      this.runBashScript('get_hardware_version.sh');
      this.runBashScript('get_software_version.sh');
      this.runBashScript('get_ip_address.sh');
      // Machine/robot type (G1-only service). Mirrors G1dInfoViewModel:
      // api_id 1001, param {"version":""}; response has robot_type.
      this.publishRequestLogged(RTC_TOPIC.ROBOT_TYPE, 1001, JSON.stringify({ version: '' }), { label: 'robot_type/get' });
    }
  }

  /** id → script line, used to correlate bashrunner responses to the
   *  request that triggered them (multiple scripts share api_id 1001). */
  private bashrunnerPending: Map<number, string> = new Map();

  /** Submit a bashrunner script line. The wire body matches what the
   * Explorer apk emits at WebEventServiceImpl.java:128 — a single 'script'
   * field whose value is "<script.sh> <space-separated args>". Logs the
   * request and tracks the request id so the response handler can route
   * to the right RobotStatus field. */
  private runBashScript(scriptLine: string): number | undefined {
    const id = this.publishRequestLogged(
      RTC_TOPIC.BASHRUNNER, 1001,
      JSON.stringify({ script: scriptLine }),
      { label: `bashrunner: ${scriptLine}` },
    );
    if (id !== undefined) this.bashrunnerPending.set(id, scriptLine);
    return id;
  }

  /** Wrap publishRequest in a collapsed devtools group so every API
   *  call (status / errors / services / controls / mapping pages, plus
   *  action-bar dispatch) renders as a single chevroned line with the
   *  structured request payload tucked inside. The matching response
   *  comes through logResponse() in handleTopicMessage. */
  private publishRequestLogged(
    topic: string,
    apiId: number,
    parameter?: string,
    options?: { priority?: boolean; label?: string; extra?: Record<string, unknown> },
  ): number | undefined {
    if (!this.dataHandler) return undefined;
    const niceLabel = options?.label ?? topic.replace(/^rt\/api\//, '').replace(/\/request$/, '');
    const paramStr = parameter && parameter !== '{}' ? ` param=${parameter}` : '';
    log.ui.group(`[req]  → ${niceLabel} api_id=${apiId}${paramStr}`);
    const reqId = this.dataHandler.publishRequest(topic, apiId, parameter, { priority: options?.priority });
    log.ui.info('request:', {
      topic,
      apiId,
      parameter: parameter ?? '{}',
      priority: options?.priority ?? false,
      requestId: reqId,
      ...options?.extra,
    });
    log.ui.groupEnd();
    return reqId;
  }

  /** Central response logger — called for every rt/api/*\/response from
   *  handleTopicMessage. Each response becomes a collapsed group with
   *  the full header / data payload inside. Errors (header.status.code
   *  != 0) also emit a warn line outside the group so they're visible
   *  without expansion. */
  private logResponse(topic: string, data: unknown): void {
    const d = data as { header?: { identity?: { id?: number; api_id?: number }; status?: { code?: number } }; data?: unknown };
    const code = d?.header?.status?.code;
    const apiId = d?.header?.identity?.api_id;
    const respId = d?.header?.identity?.id;
    const niceLabel = topic.replace(/^rt\/api\//, '').replace(/\/response$/, '');
    const status = code === 0 ? 'OK ' : 'ERR';
    // Short data preview in the header; full payload is inside the group.
    let preview = '';
    if (d?.data !== undefined) {
      const s = typeof d.data === 'string' ? d.data : JSON.stringify(d.data);
      preview = ` data=${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
    }
    log.ui.group(`[resp] ${status} ← ${niceLabel} api_id=${apiId} code=${code}${preview}`);
    log.ui.info('response:', {
      topic,
      apiId,
      code,
      requestId: respId,
      data: d?.data,
      header: d?.header,
    });
    log.ui.groupEnd();
    if (code !== 0 && code !== undefined) {
      log.ui.warn(`[${niceLabel}] api error: api_id=${apiId} code=${code}${R1_FSM_ERRORS[code] ? ` (${R1_FSM_ERRORS[code]})` : ''}`);
      if (R1_FSM_ERRORS[code] && cloudApi.connectFamily === 'R1' && apiId === G1_STATE_API_ID) {
        this.notifyBlocked(`Robot refused the mode change: ${R1_FSM_ERRORS[code]}`);
      }
    }
  }

  /** Lock (true) or unlock (false) the G1 waist motor. Fires
   *  BaseRunner.G1_SETUP_MACHINE_TYPE with arg "6"=lock / "5"=unlock,
   *  per BaseInfoViewModel.kt:570. */
  private sendWaistLock(lock: boolean): void {
    this.settingsState.waistLocked = lock;
    this.runBashScript(`demarcate_setup_machine_type.sh ${lock ? 6 : 5}`);
  }

  private pollNetworkType(): void {
    if (!this.dataHandler) return;
    const uuid = (Date.now() % 2 ** 31 + Math.floor(Math.random() * 1000)).toString();
    this.dataHandler.publishTyped('', {
      req_type: 'public_network_status',
      uuid,
    }, DATA_CHANNEL_TYPE.RTC_INNER_REQ);
  }

  private topicLogCount = 0;

  private handleTopicMessage(msg: DataChannelMessage): void {

    if (msg.type === DATA_CHANNEL_TYPE.RTC_INNER_REQ) {
      const info = msg.info as { status?: string } | undefined;
      if (info?.status) this.handleNetworkStatus(info.status);
      return;
    }

    if (msg.type === DATA_CHANNEL_TYPE.RESPONSE) {
      // Centralised response logger — every rt/api/*\/response gets a
      // collapsed group with the full header + data payload inside.
      // Common G1 error codes: 7303 = wrong service, 3203 = api not
      // implemented, 7404 = FSM_UNAVAILABLE, 7403 = private endpoint.
      if (msg.topic) this.logResponse(msg.topic, msg.data);

      if (msg.topic === 'rt/api/audiohub/response') { this.handleAudiohubResponse(msg.data); return; }
      if (msg.topic === 'rt/api/vui/response') { this.handleVuiResponse(msg.data); return; }
      if (msg.topic === 'rt/api/voice/response') { this.handleVoiceResponse(msg.data); return; }
      if (msg.topic === 'rt/api/obstacles_avoid/response') { this.handleObstacleResponse(msg.data); return; }
      if (msg.topic === 'rt/api/rm_con/response') { this.handlePermissionNetResponse(msg.data); return; }
      if (msg.topic === 'rt/api/bashrunner/response') { this.handleBashrunnerResponse(msg.data); return; }
      if (msg.topic === 'rt/api/motion_switcher/response') { this.handleMotionSwitcherResponse(msg.data); return; }
      if (msg.topic === 'rt/api/robot_state/response') { this.handleRobotStateResponse(msg.data); return; }
      if (msg.topic === 'rt/api/robot_type_service/response') { this.handleRobotTypeResponse(msg.data); return; }
      if (msg.topic === 'rt/api/arm/response') { this.handleArmResponse(msg.data); return; }
      // sport/loco responses are otherwise only logged (logResponse above),
      // but mcf needs the success ack to seed go2McfLast (the app's sQ).
      if (
        msg.topic === 'rt/api/sport/response' ||
        msg.topic === 'rt/api/loco/response'
      ) { this.handleSportResponse(msg.data); return; }
    }

    if (!msg.topic || !msg.data) return;

    switch (msg.topic) {
      case RTC_TOPIC.AUDIOHUB_PLAY_STATE:
        this.handleAudioPlayState(msg.data);
        break;
      case RTC_TOPIC.AUDIO_MSG_FILTER:
        this.handleAudioMsgFilter(msg.data);
        break;
      case RTC_TOPIC.LOW_STATE:
        this.handleLowState(msg.data);
        break;
      case RTC_TOPIC.BMS_STATE:
        // G1 publishes battery on its own topic; payload is the bms_state
        // struct directly (not wrapped under d.bms_state like in lowstate).
        this.handleLowState({ bms_state: msg.data });
        break;
      case RTC_TOPIC.SECONDARY_IMU:
        this.handleSecondaryImu(msg.data);
        break;
      case RTC_TOPIC.MAIN_BOARD_STATE:
        this.handleMainBoardState(msg.data);
        break;
      case RTC_TOPIC.G1_ARM_ACTION_STATE:
        this.handleArmActionState(msg.data);
        break;
      case RTC_TOPIC.ROBOT_ODOM:
        this.handleRobotOdom(msg.data);
        break;
      case RTC_TOPIC.LF_SPORT_MOD_STATE:
        this.handleSportModeState(msg.data);
        break;
      case RTC_TOPIC.LIDAR_ARRAY:
        this.handleLidarData(msg.data);
        break;
      case RTC_TOPIC.MULTIPLE_STATE:
        this.handleMultipleState(msg.data);
        break;
      case RTC_TOPIC.LIDAR_STATE:
        this.handleLidarState(msg.data);
        break;
      case RTC_TOPIC.SELFTEST:
        this.handleSelfTest(msg.data);
        break;
      case RTC_TOPIC.SERVICE_STATE:
        this.handleServiceState(msg.data);
        break;
      case RTC_TOPIC.USLAM_SERVER_LOG:
      case RTC_TOPIC.USLAM_CLOUD_WORLD:
      case RTC_TOPIC.USLAM_ODOM:
      case RTC_TOPIC.USLAM_CLOUD_MAP:
      case RTC_TOPIC.USLAM_LOC_ODOM:
      case RTC_TOPIC.USLAM_LOC_CLOUD:
      case RTC_TOPIC.USLAM_NAV_PATH:
      case RTC_TOPIC.USLAM_GRID_MAP:
        if (this.currentScreen === 'mapping' && this.mappingPage) {
          this.mappingPage.handleTopicMessage(msg.topic!, msg.data);
        }
        break;
    }
  }

  private handleLowState(data: unknown): void {
    const d = data as {
      motor_state?: Array<{
        q: number; dq: number; tau_est: number;
        // Go2 ships temperature as a scalar, G1 as [casing, winding].
        temperature: number | number[];
        lost: number;
        reserve?: number[];
        motorstate?: number;
      }>;
      bms_state?: { soc?: number; current?: number; voltage?: number; cycle?: number; temps?: number[] };
      foot_force?: number[];
      imu_state?: { temperature?: number; rpy?: number[] };
      // Go2 lowstate root carries the pack voltage (V) and a body NTC (°C);
      // G1 doesn't ship these — they're read defensively below.
      power_v?: number;
      temperature_ntc1?: number;
    };


    if (d.motor_state) {
      if (this.scene3d) this.scene3d.robotModel.updateMotorState(d.motor_state);
      if (this.mappingPage) this.mappingPage.updateMotorState(d.motor_state);
      // Go2 lowstate carries 12 real motors followed by zeros; G1 has up to
      // 29 (12 legs + 3 waist + 14 arms). Slice family-aware so the status
      // page sees the full motor set on G1 but stays trim on Go2.
      const motorLimit = isG1Family(cloudApi.connectFamily) ? 29 : 12;
      this.robotState.motorStates = d.motor_state.slice(0, motorLimit).map((m) => {
        // G1's per-motor temperature is an array [casing, winding]; Go2's is
        // a scalar. The summary bar only ever needs one number — pick the
        // hotter of the two on G1 so 'Max Motor Temp' stays meaningful.
        // Filter to finite numbers before Math.max — a dropped frame can
        // surface as NaN/undefined and pollute the navbar.
        const tempArr = Array.isArray(m.temperature) ? m.temperature : undefined;
        // 'Max Motor Temp' in the status bar mirrors the official webview:
        // G1 uses the winding temperature (temperature[1]), Go2 the scalar —
        // both signed-byte corrected. Fall back to casing[0] if winding is
        // absent on a dropped frame. (index-CtgArt9k.js: G1 p()=temperature[1],
        // Go2 f()=temperature, both via m(x)=x>127?x-256:x.)
        let tempScalar = 0;
        if (tempArr) {
          const winding = Number.isFinite(tempArr[1]) ? tempArr[1]
                        : (Number.isFinite(tempArr[0]) ? tempArr[0] : undefined);
          if (winding !== undefined) tempScalar = signByte(winding);
        } else if (Number.isFinite(m.temperature as number)) {
          tempScalar = signByte(m.temperature as number);
        }
        return {
          q: m.q ?? 0,
          dq: m.dq ?? 0,
          tau: m.tau_est ?? 0,
          temp: tempScalar,
          lost: m.lost ?? 0,
          temperature: tempArr,
          reserve: Array.isArray(m.reserve) ? m.reserve : undefined,
          motorstate: typeof m.motorstate === 'number' ? m.motorstate : undefined,
        };
      });
      // Update nav bar max motor temp. Math.max(...[]) is -Infinity and
      // Math.max(...[NaN, ...]) is NaN, so filter to finite numbers and
      // fall back to 0 if nothing remains. Without this the navbar
      // chip can read 'NaN°C' on a fresh G1 connection where motor
      // temperatures arrive on the next frame after the array shape
      // is already established.
      const temps = this.robotState.motorStates.map((m) => m.temp).filter((t): t is number => Number.isFinite(t));
      const maxTemp = temps.length > 0 ? Math.max(...temps) : 0;
      this.navBar?.setMotorTemp(maxTemp);
      this.mappingPage?.setMotorTemp(maxTemp);
    }

    if (d.bms_state) {
      const bms = d.bms_state as Record<string, unknown>;
      if (typeof bms.soc === 'number') {
        this.robotState.batteryPercent = bms.soc;
        this.navBar?.setBattery(bms.soc);
        this.mappingPage?.setBattery(bms.soc);
      }
      if (typeof bms.current === 'number') this.robotState.batteryCurrent = bms.current;
      if (typeof bms.cycle === 'number') this.robotState.batteryCycles = bms.cycle;

      // Voltage + temperatures shape diverges per family — see comments
      // below for the verified payload shapes.
      if (isG1Family(cloudApi.connectFamily)) {
        // G1 rt/lf/bmsstate (verified live capture):
        //   bmsvoltage: [pack_mV, bat_mV, _]   ← pack scalar at [0], bat at [1]
        //   cell_vol:   [c0_mV, c1_mV, …]      ← per-cell, padded to 40
        //   temperature:[MOS, _, BAT1, RES, …] ← per BatteryDataViewmodel.kt
        // Some firmwares may also surface scalar pack_voltage/bat_voltage —
        // accept either shape so a future rename doesn't break us.
        const bmsv = Array.isArray(bms.bmsvoltage) ? bms.bmsvoltage as unknown[] : [];
        const pack = typeof bms.pack_voltage === 'number' ? bms.pack_voltage
                   : (typeof bmsv[0] === 'number' ? bmsv[0] as number : undefined);
        const bat  = typeof bms.bat_voltage  === 'number' ? bms.bat_voltage
                   : (typeof bmsv[1] === 'number' ? bmsv[1] as number : undefined);
        if (pack !== undefined) {
          this.robotState.batteryPackVoltage = pack;
          this.robotState.batteryVoltage = pack;
        }
        if (bat !== undefined) this.robotState.batteryBatVoltage = bat;
        const tempsArr = Array.isArray(bms.temperature) ? bms.temperature
                       : Array.isArray(bms.temps)       ? bms.temps
                       : null;
        if (tempsArr) {
          const numericTemps = (tempsArr as unknown[]).filter((t): t is number => typeof t === 'number');
          this.robotState.batteryTemps = numericTemps;
          if (numericTemps.length > 0) this.robotState.batteryTemp = numericTemps[0];
        }
      } else {
        // Go2 verified live capture: bms_state has no voltage field at
        // all. The pack voltage rides at the lowstate root as `power_v`
        // (in *volts*, not mV — convert so the status page's /1000
        // formatter still works). Battery temps come from `bq_ntc`
        // (BQ fuel-gauge NTCs) and `mcu_ntc` (MCU NTCs).
        if (typeof d.power_v === 'number') {
          this.robotState.batteryVoltage = d.power_v * 1000;
        }
        const bq  = Array.isArray(bms.bq_ntc)  ? (bms.bq_ntc  as unknown[]).filter((t): t is number => typeof t === 'number') : [];
        const mcu = Array.isArray(bms.mcu_ntc) ? (bms.mcu_ntc as unknown[]).filter((t): t is number => typeof t === 'number') : [];
        const all = [...bq, ...mcu];
        if (all.length > 0) this.robotState.batteryTemp = Math.max(...all);
      }
    }

    if (d.foot_force) this.robotState.footForce = d.foot_force;
    if (d.imu_state?.temperature !== undefined) {
      // IMU temperature is its own metric (Status page "IMU Temperature" row),
      // distinct from the chassis/body temperature the status bar shows. Keep
      // it for the Status page but don't feed it to the body-temp readout.
      this.robotState.imuTemp = d.imu_state.temperature;
    }
    // Body/chassis temperature for the status bar. The official webview reads
    // it from lowstate.temperature_ntc1 on Go2 (signed byte); on G1 it arrives
    // on the mainboard topic instead — see handleMainBoardState.
    if (!isG1Family(cloudApi.connectFamily) && typeof d.temperature_ntc1 === 'number') {
      this.navBar?.setBodyTemp(signByte(d.temperature_ntc1));
    }
    // On G1 the lowstate's imu_state IS the torso ("Body") IMU. The
    // Status panel's Body IMU section reads from robotState.bodyImu, so
    // mirror the rpy+temp here. (On Go2 we don't expose a separate Body
    // section, so populating this is harmless.)
    if (isG1Family(cloudApi.connectFamily) && d.imu_state) {
      const im = d.imu_state as { rpy?: number[]; temperature?: number };
      const rpy = (im.rpy && im.rpy.length >= 3 ? im.rpy : [0, 0, 0]).slice(0, 3) as [number, number, number];
      this.robotState.bodyImu = { rpy, temp: typeof im.temperature === 'number' ? im.temperature : 0 };
    }

    // Update status page if visible
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  // G1's pelvis ("Crotch") IMU rides on rt/lf/secondary_imu as a flat
  // G1ImuState payload (rpy + temperature, etc.). The torso ("Body")
  // IMU is whatever already lives in lowstate.imu_state — populated by
  // handleLowState. See BaseInfoViewModel.kt:195 in the decompiled apk.
  private handleSecondaryImu(data: unknown): void {
    const i = data as { rpy?: number[]; temperature?: number };
    const rpy = (i.rpy && i.rpy.length >= 3 ? i.rpy : [0, 0, 0]).slice(0, 3) as [number, number, number];
    this.robotState.crotchImu = { rpy, temp: typeof i.temperature === 'number' ? i.temperature : 0 };
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  // G1/R1/H1 mainboard state (rt/lf/mainboardstate). The official webview's
  // status-bar body temperature is temperature[0] from this topic (signed
  // byte), NOT the IMU temperature. Go2 has no mainboard topic — it uses
  // lowstate.temperature_ntc1 instead (handled in handleLowState).
  private handleMainBoardState(data: unknown): void {
    const d = data as { temperature?: number[] };
    const t = Array.isArray(d.temperature) ? d.temperature[0] : undefined;
    if (typeof t === 'number' && Number.isFinite(t)) {
      this.navBar?.setBodyTemp(signByte(t));
    }
  }

  private handleRobotOdom(data: unknown): void {
    if (!this.scene3d) return;
    const d = data as { pose?: { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } } } };
    const pose = d.pose?.pose;
    if (pose?.position && pose?.orientation) {
      this.scene3d.robotModel.updateOdom(pose.position, pose.orientation);
    }
  }

  private handleSportModeState(data: unknown): void {
    const d = data as {
      position?: number[];
      velocity?: number[];
      imu_state?: { quaternion?: number[] };
      mode?: number;
      fsm_id?: number;
      gait_type?: number;
      error_code?: number;
    };

    // G1 publishes the current locomotion state in `fsm_id` rather than
    // `mode`. Without this fallback the OperaBar would never learn the
    // robot's current state on connect — the user already in Walk2
    // would still see all gestures greyed.
    const currentMode = d.mode ?? d.fsm_id;

    if (d.position) this.robotState.position = d.position;
    if (d.velocity) this.robotState.velocity = d.velocity;
    if (currentMode !== undefined) this.robotState.mode = currentMode;
    if (d.gait_type !== undefined) this.robotState.gaitType = d.gait_type;

    // G1 / R1: feed sportState into the action bar so it can grey out
    // transitions the FSM would reject (Zero Torque / Preparation /
    // Squat-Up / Lie Up need current state = Damp). R1 shares the channel
    // but has its own mode enum (Run on 811, mode 3 = ZeroTorque).
    if (isG1Family(cloudApi.connectFamily) && currentMode !== undefined) {
      const toState = cloudApi.connectFamily === 'R1' ? r1ModeToState : g1ModeToState;
      this.actionBar?.setG1State(toState(currentMode));
    }
    // Go2: highlight the action-bar row matching the robot's live sport state
    // (the blue current-mode indicator). Decoded straight from
    // LF_SPORT_MOD_STATE — relies on the robot, no optimistic guessing. The
    // motion_switcher name selects the mechanism: "mcf" reports the mode in
    // error_code; the other modes report it in the small `mode` enum.
    if (!isG1Family(cloudApi.connectFamily)) {
      this.actionBar?.setGo2State(go2DecodeState(
        { mode: d.mode, gait_type: d.gait_type, error_code: d.error_code },
        this.robotState.motionMode,
      ));
    }

    if (this.scene3d && d.position && d.imu_state?.quaternion) {
      const [px, py, pz] = d.position;
      const [qw, qx, qy, qz] = d.imu_state.quaternion;
      this.scene3d.robotModel.updateOdom(
        { x: px, y: py, z: pz },
        { x: qx, y: qy, z: qz, w: qw },
      );
    }

    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleLidarData(data: unknown): void {
    if (!this.scene3d) return;
    this.scene3d.voxelMap.processCompressed(data);
  }

  private handleVuiResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const apiId = d.header?.identity?.api_id;
    const code = d.header?.status?.code;
    if (code !== 0 || typeof d.data !== 'string') return;
    try {
      const parsed = JSON.parse(d.data) as { volume?: number; brightness?: number };
      if (apiId === 1004 && parsed.volume !== undefined) {
        this.settingsState.volume = parsed.volume;
        this.settingsPage?.setState({ volume: parsed.volume });
        this.settingsDrawer?.setState({ volume: parsed.volume });
      } else if (apiId === 1006 && parsed.brightness !== undefined) {
        this.settingsState.brightness = parsed.brightness;
        this.settingsPage?.setState({ brightness: parsed.brightness });
        this.settingsDrawer?.setState({ brightness: parsed.brightness });
      }
    } catch { /* malformed */ }
  }

  /** G1 voice-service response. The G1 speaker volume lives here (GET api_id
   *  1005) on a 0-100 scale; normalise to our 0-10 slider (÷10). */
  private handleVoiceResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    if (d.header?.status?.code !== 0 || typeof d.data !== 'string') return;
    if (d.header?.identity?.api_id !== 1005) return;
    try {
      const parsed = JSON.parse(d.data) as { volume?: number };
      if (parsed.volume === undefined) return;
      const level = Math.round(parsed.volume / 10); // 0-100 → 0-10
      this.settingsState.volume = level;
      this.settingsPage?.setState({ volume: level });
      this.settingsDrawer?.setState({ volume: level });
    } catch { /* malformed */ }
  }

  /** Cloud / internet-remote permission echo (rm_con topic).
   *  GET (api_id 1001) and SET (api_id 1002) both return
   *  `{ enable_status: 1|2 }` — 2 means enabled. From NetPermissionModel.kt. */
  private handlePermissionNetResponse(data: unknown): void {
    const d = data as {
      header?: { status?: { code?: number } };
      data?: string;
    };
    if (d.header?.status?.code !== 0 || typeof d.data !== 'string') return;
    try {
      const parsed = JSON.parse(d.data) as { enable_status?: number };
      if (parsed.enable_status === undefined) return;
      const on = parsed.enable_status === 2;
      this.settingsState.internetRemoteOn = on;
      this.settingsPage?.setState({ internetRemoteOn: on });
      this.settingsDrawer?.setState({ internetRemoteOn: on });
    } catch { /* malformed */ }
  }

  private handleObstacleResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    if (d.header?.identity?.api_id === 1002 && d.header?.status?.code === 0 && typeof d.data === 'string') {
      try {
        const parsed = JSON.parse(d.data) as { enable?: boolean };
        if (parsed.enable !== undefined) {
          this.settingsState.radarOn = parsed.enable;
          this.settingsPage?.setState({ radarOn: parsed.enable });
          this.settingsDrawer?.setState({ radarOn: parsed.enable });
        }
      } catch { /* malformed */ }
    }
  }

  private handleNetworkStatus(status: string): void {
    let type: string;
    if (status === 'NetworkStatus.ON_4G_CONNECTED') {
      type = '4G';
    } else if (status === 'NetworkStatus.ON_WIFI_CONNECTED') {
      // Use actual connection mode — WiFi could be STA-L or STA-T
      type = this.connectionConfig?.mode || 'STA-L';
    } else if (status === 'Undefined' || status === 'NetworkStatus.DISCONNECTED') {
      setTimeout(() => this.pollNetworkType(), 500);
      return;
    } else {
      type = status;
    }
    this.robotState.networkType = type;
    this.navBar?.setNetworkType(type);
    this.mappingPage?.setNetworkType(type);
  }

  private handleMultipleState(_data: unknown): void {
    // Reserved
  }

  private handleLidarState(data: unknown): void {
    // rt/utlidar/lidar_state provides lidar health/status info
    const d = data as Record<string, unknown>;
    this.robotState.lidarState = JSON.stringify(d);
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleSelfTest(data: unknown): void {
    const d = data as Record<string, unknown>;
    const result = JSON.stringify(d);
    if (!this.robotState.selfTestResults.includes(result)) {
      this.robotState.selfTestResults.push(result);
    }
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleBashrunnerResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { id?: number; api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const code = d.header?.status?.code;
    const id = d.header?.identity?.id;
    const scriptLine = id !== undefined ? this.bashrunnerPending.get(id) : undefined;
    if (id !== undefined) this.bashrunnerPending.delete(id);
    const scriptName = scriptLine ? scriptLine.split(' ')[0] : '?';

    if (code !== 0 || typeof d.data !== 'string') {
      if (scriptLine) log.ui.warn(`[bashrunner] ${scriptName} failed (code=${code})`);
      // Optimistic SettingsPage toggles need to be reverted on failure —
      // re-fire get_rfpower.sh to put the UI back in sync with the dog.
      if (
        scriptName === 'demarcate_turnon_clicker.sh' ||
        scriptName === 'demarcate_turnoff_clicker.sh' ||
        scriptName === 'set_remote_id.sh'
      ) {
        this.runBashScript('get_rfpower.sh');
      }
      return;
    }

    let info: unknown;
    let result: string | undefined;
    try {
      const parsed = JSON.parse(d.data) as { result?: string; info?: unknown; type?: string };
      info = parsed.info;
      result = parsed.result;
    } catch {
      info = d.data;
    }

    // Route by script. The robot replies with `info` shaped per script:
    //   * get_ip_address.sh        -> { wlan0: "...", wlan1: "..." }
    //   * get_hardware_version.sh  -> "10"   (formatted as "2.<n/10>.<n%10>")
    //   * get_software_version.sh  -> "1.4.6"
    //   * get_whole_packet_version.sh -> firmware string
    //
    // Go2 firmware doesn't reliably echo the request `id` back, so script
    // correlation can fail and `scriptName` ends up as '?'. In that case
    // — and on the explicit whole_packet_version path — populate
    // firmwareVersion. This matches main's universal "any bashrunner
    // success → firmware version" behaviour and restores Go2.
    switch (scriptName) {
      case 'get_ip_address.sh': {
        if (info && typeof info === 'object') {
          const ips = info as { wlan0?: string; wlan1?: string; eth0?: string };
          const ip = ips.wlan0 || ips.wlan1 || ips.eth0 || '';
          if (ip) this.robotState.ipAddress = ip;
        }
        break;
      }
      case 'get_hardware_version.sh': {
        // G1 BaseInfoViewModel/G1dInfoViewModel format the version as
        // (info/10) + "." + (info%10) — e.g. info=10 -> "1.0", info=12 -> "1.2".
        // (Our earlier "2.x.x" form added a spurious leading "2.".)
        const raw = typeof info === 'string' ? info : typeof info === 'number' ? String(info) : '';
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) {
          this.robotState.hardwareVersion = `${Math.floor(n / 10)}.${n % 10}`;
        }
        break;
      }
      case 'get_software_version.sh': {
        if (typeof info === 'string') this.robotState.softwareVersion = info;
        break;
      }
      case 'get_rfpower.sh': {
        // Bound when info == "1", off otherwise. RemoteBindActivity.kt:95
        // compares `info` against IcyHeaders.REQUEST_HEADER_ENABLE_METADATA_VALUE
        // — an ExoPlayer constant whose value is literally the string "1"
        // (so reading the decompiled Kotlin as `info == "enable"` is
        // misleading; the wire value is "1"/"0").
        const infoStr = typeof info === 'string' ? info.trim() : '';
        const on = infoStr === '1';
        this.settingsState.remoteSwitchOn = on;
        this.settingsPage?.setState({ remoteSwitchOn: on });
        this.settingsDrawer?.setState({ remoteSwitchOn: on });
        // If the switch is on, fetch the bound ID — APK does the same.
        if (on) this.runBashScript('get_rfid.sh');
        else {
          this.settingsPage?.setState({ remoteId: '' });
          this.settingsDrawer?.setState({ remoteId: '' });
        }
        break;
      }
      case 'get_rfid.sh': {
        const rid = typeof info === 'string' ? info.trim() : '';
        this.settingsState.remoteId = rid;
        this.settingsPage?.setState({ remoteId: rid });
        this.settingsDrawer?.setState({ remoteId: rid });
        break;
      }
      case 'demarcate_turnon_clicker.sh': {
        // Succeeded — radio is on. Re-fetch ID if we don't have one yet.
        this.settingsState.remoteSwitchOn = true;
        this.settingsPage?.setState({ remoteSwitchOn: true });
        this.settingsDrawer?.setState({ remoteSwitchOn: true });
        if (!this.settingsState.remoteId) this.runBashScript('get_rfid.sh');
        break;
      }
      case 'demarcate_turnoff_clicker.sh': {
        this.settingsState.remoteSwitchOn = false;
        this.settingsState.remoteId = '';
        this.settingsPage?.setState({ remoteSwitchOn: false, remoteId: '' });
        this.settingsDrawer?.setState({ remoteSwitchOn: false, remoteId: '' });
        break;
      }
      case 'set_remote_id.sh': {
        // APK refetches the ID on success — do the same.
        this.runBashScript('get_rfid.sh');
        break;
      }
      case 'get_whole_packet_version.sh':
      default: {
        const v = typeof info === 'string' ? info : (result || (typeof d.data === 'string' ? d.data : ''));
        if (v) this.robotState.firmwareVersion = v;
        break;
      }
    }

    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  /** mcf 1:1 (the app's sQ): when a Lock/Run/StaticWalk/Endurance command is
   *  acked with code 0, seed go2McfLast so the highlight holds even while the
   *  robot reports BalanceStand in error_code. Correlated by request id, which
   *  the robot echoes in header.identity.id. */
  private handleSportResponse(data: unknown): void {
    if (this.mcfSeedPending.size === 0) return;
    const d = data as { header?: { identity?: { id?: number }; status?: { code?: number } } };
    const id = d.header?.identity?.id;
    if (id === undefined) return;
    const seed = this.mcfSeedPending.get(id);
    if (seed === undefined) return;
    this.mcfSeedPending.delete(id);
    if (d.header?.status?.code === 0) go2McfSeedState(seed);
  }

  private handleMotionSwitcherResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    if (d.header?.status?.code === 0 && typeof d.data === 'string') {
      try {
        const parsed = JSON.parse(d.data) as { name?: string; mode?: string };
        this.robotState.motionMode = parsed.name || parsed.mode || d.data;
      } catch {
        this.robotState.motionMode = d.data;
      }
      if (this.currentScreen === 'status' && this.statusPage) {
        this.statusPage.update(this.robotState);
      }
    }
  }

  private handleRobotStateResponse(data: unknown): void {
    // Generic response group is emitted upstream in handleTopicMessage
    // via logResponse(). This method only handles the *behavioural*
    // side-effects (ServiceSwitch protected-status, re-fetch).
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const apiId = d.header?.identity?.api_id;

    // ServiceSwitch response (1001) — when the toggle succeeds, re-fetch
    // the service list so the UI reflects the new state.
    if (apiId === 1001) {
      if (typeof d.data === 'string') {
        try {
          const parsed = JSON.parse(d.data) as { status?: number };
          if (parsed.status === 5) {
            // Protected service error (5202) — logResponse already
            // warned on the non-zero header code; flag the specific
            // sub-status for clarity.
            log.ui.warn('[robot_state] service-switch: protected service (status=5)');
          }
        } catch { /* ignore */ }
      }
      this.requestServiceReport();
    }
  }

  /** G1 machine/robot-type response (rt/api/robot_type_service, api 1001).
   *  Payload JSON carries `robot_type` as a string number; store it and
   *  refresh the Status → System tile. */
  private handleRobotTypeResponse(data: unknown): void {
    const d = data as { data?: unknown };
    try {
      let inner: any = d?.data;
      if (typeof inner === 'string') inner = JSON.parse(inner);
      const raw = inner?.robot_type;
      const num = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!Number.isNaN(num)) {
        this.robotState.machineType = num;
        if (this.currentScreen === 'status' && this.statusPage) {
          this.statusPage.update(this.robotState);
        }
      }
    } catch (err) {
      log.ui.error('robot_type parse failed:', err);
    }
  }

  private handleServiceState(data: unknown): void {
    // rt/servicestate may arrive as a JSON string (double-encoded) or parsed array
    let entries: Array<{ name: string; status: number; protect: number | boolean; version?: string }>;
    if (typeof data === 'string') {
      try {
        entries = JSON.parse(data);
      } catch {
        log.ui.warn('[go2:ui] Failed to parse service state string');
        return;
      }
    } else if (Array.isArray(data)) {
      entries = data;
    } else {
      return;
    }

    this.serviceEntries = entries.map((e) => ({
      name: e.name,
      status: e.status,
      protect: !!e.protect,  // convert 0/1 to boolean
      version: e.version || '',
    }));

    if (this.currentScreen === 'services' && this.servicesPage) {
      this.servicesPage.update(this.serviceEntries);
    }
  }

  private requestServiceReport(): void {
    // API 1002: SetReportFreq — tells robot to publish service list to rt/servicestate
    // Duration 60s, auto-repeat before expiry
    this.publishRequestLogged(
      RTC_TOPIC.ROBOT_STATE,
      1002,
      JSON.stringify({ interval: 2, duration: 60 }),
      { label: 'robot_state/set-report-freq' },
    );

    // Clear any existing timer and set up auto-repeat before the 60s expires
    if (this.serviceReportTimer) clearInterval(this.serviceReportTimer);
    this.serviceReportTimer = setInterval(() => {
      if (this.currentScreen === 'services' && this.dataHandler) {
        this.publishRequestLogged(
          RTC_TOPIC.ROBOT_STATE,
          1002,
          JSON.stringify({ interval: 2, duration: 60 }),
          { label: 'robot_state/set-report-freq (repeat)' },
        );
      } else {
        // Stop repeating if we left the services screen
        if (this.serviceReportTimer) {
          clearInterval(this.serviceReportTimer);
          this.serviceReportTimer = null;
        }
      }
    }, 50_000); // Re-request at 50s (before 60s expiry)
  }

  private toggleService(name: string, enable: boolean): void {
    // API 1001: ServiceSwitch
    this.publishRequestLogged(
      RTC_TOPIC.ROBOT_STATE,
      1001,
      JSON.stringify({ name, switch: enable ? 1 : 0 }),
      { label: `robot_state/service-switch ${name}=${enable ? 'on' : 'off'}` },
    );
  }

  // ── Audio PTT ──

  private async onPttStart(): Promise<void> {
    if (this.pttActive || !this.dataHandler) return;
    this.pttActive = true;

    try {
      this.audioRecorder = new AudioRecorder();
      await this.audioRecorder.start();
      this.publishRequestLogged(RTC_TOPIC.AUDIOHUB, 4001, '{}', { label: 'audiohub/enter-megaphone' });
    } catch (err) {
      log.ui.error('PTT audio start failed:', err);
      this.pttActive = false;
    }
  }

  private async onPttEnd(): Promise<void> {
    if (!this.pttActive || !this.dataHandler) return;
    this.pttActive = false;

    try {
      const wav = await this.audioRecorder?.stop();
      this.audioRecorder?.destroy();
      this.audioRecorder = null;

      if (wav) {
        await this.uploadAudioChunks(wav);
      }
      this.publishRequestLogged(RTC_TOPIC.AUDIOHUB, 4002, '{}', { label: 'audiohub/exit-megaphone' });
    } catch (err) {
      log.ui.error('PTT end error:', err);
    }
  }

  private onAudioMonitorStart(): void {
    this.audioMonitorActive = true;
    if (this.audioEl) {
      this.audioEl.play().catch(() => {});
    }
  }

  private onAudioMonitorStop(): void {
    this.audioMonitorActive = false;
    if (this.audioEl) {
      this.audioEl.pause();
    }
  }

  /** Send an audiohub request and resolve with the robot's response payload
   *  (the parsed `data` field). Correlates request→response by request id;
   *  times out after 5 s so callers never hang. */
  private publishAudioRequest(apiId: number, payload: string): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.dataHandler) {
        resolve(null);
        return;
      }
      const reqId = this.publishRequestLogged(RTC_TOPIC.AUDIOHUB, apiId, payload, {
        label: `audiohub/api-${apiId}`,
      });
      if (reqId === undefined) {
        resolve(null);
        return;
      }
      const timer = window.setTimeout(() => {
        this.audioPending.delete(reqId);
        resolve(null);
      }, 10000);
      this.audioPending.set(reqId, (data) => {
        clearTimeout(timer);
        // Cache list responses so the player can render them instantly.
        if (apiId === 1001 && data != null) this.audioListCache = data;
        resolve(data);
      });
    });
  }

  /** Apply an audiohub play-state push (rt/audiohub/player/state) to the
   *  audio player(s) so the playing indicator tracks the robot. The payload
   *  may arrive as a JSON string or a parsed object. */
  private handleAudioPlayState(data: unknown): void {
    let state: { is_playing?: boolean; current_audio_unique_id?: string | null } | null = null;
    try {
      let d: any = data;
      if (typeof d === 'string') d = JSON.parse(d);
      // Some transports wrap the payload under `.data`.
      if (d && typeof d === 'object' && d.data !== undefined && d.is_playing === undefined) {
        d = typeof d.data === 'string' ? JSON.parse(d.data) : d.data;
      }
      if (d && typeof d === 'object') state = d;
    } catch {
      return;
    }
    if (!state) return;
    this.settingsPage?.setAudioPlayState(state);
    this.settingsDrawer?.setAudioPlayState(state);
  }

  /** G1 play-state signal (rt/audio_msg/filter). The payload is a std_msgs
   *  String whose JSON carries `play_state`; play_state === 0 means playback
   *  stopped, so we clear the player's playing indicator. (G1 never publishes
   *  the Go2-style rt/audiohub/player/state topic.) */
  private handleAudioMsgFilter(data: unknown): void {
    try {
      let d: any = data;
      // std_msgs/String wrapper: { data: "<json>" }
      if (d && typeof d === 'object' && typeof d.data === 'string' && d.play_state === undefined) {
        d = d.data;
      }
      if (typeof d === 'string') d = JSON.parse(d);
      if (!d || typeof d !== 'object' || !('play_state' in d)) return;
      if (Number(d.play_state) === 0) {
        this.settingsPage?.setAudioPlayState({ is_playing: false });
        this.settingsDrawer?.setAudioPlayState({ is_playing: false });
      }
    } catch {
      /* ignore malformed audio_msg */
    }
  }

  /** Route an audiohub response back to the awaiting publishAudioRequest. */
  private handleAudiohubResponse(data: unknown): void {
    const d = data as { header?: { identity?: { id?: number } }; data?: unknown };
    const id = d?.header?.identity?.id;
    if (id === undefined) return;
    const resolver = this.audioPending.get(id);
    if (resolver) {
      this.audioPending.delete(id);
      resolver(d?.data);
    }
  }

  // ── G1 Demo Teaching ──────────────────────────────────────────────────────

  /** Send an arm-service request and await its response. Resolves with the
   *  robot status code (0 = ok; 7404 = FSM unavailable) plus the data payload. */
  private publishArmRequest(apiId: number, payload: string = ''): Promise<{ code: number; data: unknown }> {
    return new Promise((resolve) => {
      // Default to an EMPTY-STRING parameter (not '{}') — the official frontend
      // sends parameter:"" for no-param requests, and the teaching stop (7110
      // with no param) only finalizes when the parameter is empty. Sending
      // '{}' is read as a heartbeat and recording never stops.
      const reqId = this.publishRequestLogged(RTC_TOPIC.G1_ARM_REQUEST, apiId, payload, {
        label: `teaching/api-${apiId}`,
      });
      if (reqId === undefined) { resolve({ code: -1, data: null }); return; }
      const timer = window.setTimeout(() => {
        this.armPending.delete(reqId);
        resolve({ code: -1, data: null });
      }, 10000);
      this.armPending.set(reqId, (r) => { clearTimeout(timer); resolve(r); });
    });
  }

  /** Route an arm/response back to the awaiting publishArmRequest. */
  private handleArmResponse(data: unknown): void {
    const d = data as { header?: { identity?: { id?: number }; status?: { code?: number } }; data?: unknown };
    const id = d?.header?.identity?.id;
    if (id === undefined) return;
    const resolver = this.armPending.get(id);
    if (resolver) {
      this.armPending.delete(id);
      resolver({ code: d?.header?.status?.code ?? 0, data: d?.data });
    }
  }

  /** rt/arm/action/state { id } — drives the teaching create/play state
   *  machine (record: -1 active / 0 saved; play: 0 idle / 99 prep / 100 run). */
  private handleArmActionState(data: unknown): void {
    // The robot streams this ~10×/s; only forward it while the teaching page
    // is open (record: id -1 active / 0 saved; play: 0 idle / 99 prep / 100 run).
    if (!this.teachingPage) return;
    let id: number | undefined;
    try {
      let v: any = data;
      if (typeof v === 'string') v = JSON.parse(v);
      // Some transports wrap the payload under `.data` (std_msgs/String).
      if (v && typeof v === 'object' && v.id === undefined && v.data !== undefined) {
        v = typeof v.data === 'string' ? JSON.parse(v.data) : v.data;
      }
      if (v && typeof v === 'object' && typeof v.id === 'number') id = v.id;
    } catch { return; }
    if (id !== undefined) this.teachingPage.setActionState(id);
  }

  /** Parse the teaching list response (api 7107). The robot returns
   *  [[presets],[recorded]] — the app shows index [1]. Accepts a JSON string
   *  or an already-parsed value. */
  private parseTeachList(data: unknown): TeachAction[] {
    let v: any = data;
    try { if (typeof v === 'string') v = JSON.parse(v); } catch { return []; }
    const recorded = Array.isArray(v) ? (v.length > 1 ? v[1] : v[0]) : null;
    if (!Array.isArray(recorded)) return [];
    return recorded
      .filter((a) => a && typeof a.name === 'string')
      .map((a) => ({ name: a.name, id: Number(a.id ?? 0), time: Number(a.time ?? 0) }));
  }

  private startTeachHeartbeat(): void {
    this.stopTeachHeartbeat();
    const beat = JSON.stringify({ action_name: '' });
    this.teachHeartbeat = window.setInterval(() => {
      // Keepalive (1 Hz) — sent silently via the raw channel so it doesn't
      // flood the request log during a recording.
      this.dataHandler?.publishRequest(RTC_TOPIC.G1_ARM_REQUEST, G1_TEACH_API.START, beat);
    }, 1000);
  }

  private stopTeachHeartbeat(): void {
    if (this.teachHeartbeat) { clearInterval(this.teachHeartbeat); this.teachHeartbeat = 0; }
  }

  private showTeachingScreen(): void {
    this.currentScreen = 'teaching';
    this.root.innerHTML = '';
    this.root.className = 'app-root teaching-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.errorsBadgeFloating?.setVisible(true);

    this.teachingPage = new TeachingPage(this.root, () => this.goToHub(), {
      getList: async () => {
        const r = await this.publishArmRequest(G1_TEACH_API.LIST, '');
        return this.parseTeachList(r.data);
      },
      play: async (name) => (await this.publishArmRequest(G1_TEACH_API.PLAY, JSON.stringify({ action_name: name }))).code,
      stopPlay: () => { void this.publishArmRequest(G1_TEACH_API.ARM_TEACH); },
      damp: () => { this.publishRequestLogged(RTC_TOPIC.SPORT_MOD, G1_SPORT_DAMP, JSON.stringify({ data: 1 }), { label: 'teaching/damp' }); },
      rename: async (oldName, newName) =>
        (await this.publishArmRequest(G1_TEACH_API.RENAME, JSON.stringify({ pre_name: oldName, new_name: newName }))).code,
      remove: async (name) => (await this.publishArmRequest(G1_TEACH_API.DELETE, JSON.stringify({ action_name: name }))).code,
      startRecord: async (name) => {
        const r = await this.publishArmRequest(G1_TEACH_API.START, JSON.stringify({ action_name: name }));
        if (r.code === 0) this.startTeachHeartbeat();
        return r.code;
      },
      stopRecord: async () => {
        this.stopTeachHeartbeat();
        return (await this.publishArmRequest(G1_TEACH_API.START)).code; // no param = finalize
      },
      pauseRecord: (pause) => { void this.publishArmRequest(G1_TEACH_API.PAUSE, JSON.stringify({ pause })); },
      deleteRecord: (name) => {
        this.stopTeachHeartbeat();
        void this.publishArmRequest(G1_TEACH_API.DELETE, JSON.stringify({ action_name: name }));
      },
    });
  }

  private async handleAudioUpload(file: File, onProgress?: (pct: number) => void): Promise<void> {
    if (!this.dataHandler) return;

    try {
      // The robot's audiohub only accepts WAV, so decode-and-re-encode any
      // picked file (MP3/OGG/M4A/WAV) to 16-bit PCM WAV before uploading.
      const wav = await convertFileToWav(file);
      const bytes = new Uint8Array(wav);

      // Enforce the robot's 10 MB ceiling (post-conversion). At 16 kHz mono
      // that's ~5 minutes of audio.
      const MAX_BYTES = 10 * 1024 * 1024;
      if (bytes.length > MAX_BYTES) {
        const mb = (bytes.length / 1024 / 1024).toFixed(1);
        const mins = Math.floor((MAX_BYTES - 44) / (16000 * 2) / 60);
        alert(
          `Converted audio is ${mb} MB — over the robot's 10 MB limit.\n` +
          `Please pick a clip under ~${mins} minutes.`,
        );
        throw new Error('audio exceeds 10MB after conversion');
      }

      const filename = file.name.replace(/\.[^/.]+$/, '');
      await this.uploadWavToLibrary(wav, filename, onProgress);
    } catch (err) {
      log.ui.error('Audio upload failed:', err);
      throw err;
    }
  }

  /** Save a WAV buffer to the robot's audio library via api 2001 (chunked,
   *  base64, 60 KB blocks). Used by both file upload and the player's record
   *  button — both persist a named entry that shows up in the list (unlike the
   *  megaphone PTT path, which only broadcasts live and saves nothing). */
  private async uploadWavToLibrary(
    wav: ArrayBuffer,
    filename: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const bytes = new Uint8Array(wav);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64Data = btoa(binary);

    const createTime = Math.floor(Date.now() / 1000);
    const chunkSize = 61440;
    const chunks: string[] = [];
    for (let i = 0; i < base64Data.length; i += chunkSize) {
      chunks.push(base64Data.substring(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        current_block_index: i + 1,
        total_block_number: chunks.length,
        current_block_size: chunks[i].length,
        block_content: chunks[i],
        file_name: filename,
        file_type: 'wav',
        create_time: createTime,
        file_size: bytes.length,
      };
      await this.publishAudioRequest(2001, JSON.stringify(payload));
      onProgress?.(Math.round(((i + 1) / chunks.length) * 100));
    }
  }

  // ── Audio player record (saves to library, unlike the megaphone PTT) ──

  private async onAudioPlayerRecordStart(): Promise<void> {
    if (this.audioRecorder) return;
    try {
      this.audioRecorder = new AudioRecorder();
      await this.audioRecorder.start();
    } catch (err) {
      log.ui.error('Audio record start failed:', err);
      this.audioRecorder?.destroy();
      this.audioRecorder = null;
      throw err;
    }
  }

  private async onAudioPlayerRecordStop(onProgress?: (pct: number) => void): Promise<void> {
    const recorder = this.audioRecorder;
    this.audioRecorder = null;
    if (!recorder) return;
    try {
      const wav = await recorder.stop();
      recorder.destroy();
      if (!wav) return; // too short / cancelled
      // Auto-name with the local time; user can rename via the kebab menu.
      const d = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const name = `Rec ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      await this.uploadWavToLibrary(wav, name, onProgress);
    } catch (err) {
      log.ui.error('Audio record save failed:', err);
      recorder.destroy();
      throw err;
    }
  }

  private async uploadAudioChunks(wav: ArrayBuffer): Promise<void> {
    if (!this.dataHandler) return;

    const base64 = Array.from(new Uint8Array(wav))
      .map(b => String.fromCharCode(b))
      .join('');
    const b64Str = btoa(base64);
    const chunkSize = 61440;
    const chunks = [];

    for (let i = 0; i < b64Str.length; i += chunkSize) {
      chunks.push(b64Str.substring(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        current_block_index: i + 1,
        total_block_number: chunks.length,
        current_block_size: chunks[i].length,
        block_content: chunks[i],
      };
      await this.publishRequestAsync(RTC_TOPIC.AUDIOHUB, 4003, JSON.stringify(payload));
    }

    // Calculate playback duration: (wav_size - 44_header_bytes) / (16000_hz * 2_bytes_per_sample)
    const playbackDuration = (wav.byteLength - 44) / (16000 * 2);
    // Wait for audio to finish playing before exiting megaphone mode
    // Add 500ms buffer for safety
    const delayMs = Math.ceil(playbackDuration * 1000) + 500;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  private publishRequestAsync(topic: string, apiId: number, parameter?: string): Promise<void> {
    return new Promise((resolve) => {
      this.publishRequestLogged(topic, apiId, parameter, { label: `audiohub/upload-chunk` });
      // Small delay between chunks to avoid overwhelming the channel
      setTimeout(resolve, 50);
    });
  }

  // ── Connection ──

  private async connect(config: ConnectionConfig): Promise<void> {
    if (this.webrtc) {
      this.disconnect();
      return;
    }

    this.connectionConfig = config;
    this.connectionPanel?.setConnecting(true);
    this.connectionPanel?.setStatus('Connecting...', 'info');

    const callbacks: ConnectionCallbacks = {
      onStateChange: (state: ConnectionState) => this.onStateChange(state),
      onValidated: () => {
        this.connectionPanel?.setStatus('Validated!', 'success');
        setTimeout(() => {
          this.enableVideoAndSubscribe();
          this.showHubScreen();
        }, 500);
      },
      onMessage: (msg: DataChannelMessage) => {
        if (this.dataHandler) this.dataHandler.handleMessage(msg);
      },
      onVideoTrack: (stream: MediaStream) => {
        this.videoStream = stream;
        this.pipCamera?.setStream(stream);
        this.mappingPage?.setStream(stream);
        if (this.viewMode === 'video' && this.videoBg) {
          this.videoBg.srcObject = stream;
          this.videoBg.style.display = 'block';
          if (this.noiseBgCanvas) this.noiseBgCanvas.style.display = 'none';
          this.stopBgNoise();
        }
      },
      onAudioTrack: (stream: MediaStream) => {
        if (!this.audioEl) {
          this.audioEl = document.createElement('audio');
          this.audioEl.style.cssText = 'position:absolute;width:0;height:0;opacity:0;';
          document.body.appendChild(this.audioEl);
        }
        this.audioEl.srcObject = stream;
      },
    };

    const onStep = (msg: string) => this.connectionPanel?.setStatus(msg, 'info');

    try {
      if (config.mode === 'STA-T') {
        // Remote: kick off WebRTC immediately — same UX as Local/AP. The
        // hub is shown in the onValidated callback.
        if (!config.token) throw new Error('Not logged in');
        if (!config.serialNumber) throw new Error('No robot selected');
        this.webrtc = await connectRemote(config.serialNumber, config.token, callbacks, onStep);
      } else if (config.mode === 'CUSTOM') {
        if (!config.ip) throw new Error('IP address required');
        this.webrtc = new CustomWebRTCConnection(config.ip, callbacks) as any;
      } else {
        if (!config.ip) throw new Error('IP address required');
        this.webrtc = await connectLocal(config.ip, config.mode as 'STA-L' | 'AP', callbacks, onStep, {
          sn: config.serialNumber,
          promptKey: (sn, opts) => promptAesKey(sn, opts),
        });
      }
      if (config.mode !== 'CUSTOM') {
        this.dataHandler = new DataChannelHandler(this.webrtc as WebRTCConnection, callbacks);
      } else {
        this.dataHandler = null;
      }
      // Wire the error-message handler immediately — the robot sends its first
      // "errors" snapshot the same tick as "Validation Ok.", which is BEFORE
      // the onValidated callback runs. Don't wait for validation here.
      if (this.dataHandler) {
        this.dataHandler.onErrorMessage = (type, data) => this.errorStore.applyWireMessage(type, data);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Connection failed';
      this.connectionPanel?.setStatus(friendlyConnectError(raw), 'error');
      this.connectionPanel?.setConnecting(false);
      this.webrtc?.close();
      this.webrtc = null;
    }
  }

  private onStateChange(state: ConnectionState): void {
    switch (state) {
      case 'connecting':
        const protocolName = this.connectionConfig?.mode === 'CUSTOM' ? 'WebSocket' : 'WebRTC';
        this.connectionPanel?.setStatus(`${protocolName} connecting...`, 'info');
        break;
      case 'connected':
        this.connectionPanel?.setConnected(true);
        this.connectionPanel?.setStatus('Connected, awaiting validation...', 'info');
        break;
      case 'disconnected':
        if (this.currentScreen === 'connection') {
          // Failure during the initial handshake (e.g. 429 from con_ing,
          // peer reject). The catch block in connect() owns the error
          // message and webrtc cleanup; just reset the button state and
          // let the user see the panel error / retry. Calling disconnect()
          // here would wipe the panel and dump them to the landing screen
          // before the error message ever rendered.
          this.connectionPanel?.setConnecting(false);
        } else {
          // Lost connection while in hub/control/status — show message and go back
          this.disconnect();
          this.connectionPanel?.setStatus('Connection lost — robot disconnected', 'error');
        }
        break;
      case 'failed':
        if (this.currentScreen === 'connection') {
          this.connectionPanel?.setStatus('WebRTC connection failed — check network', 'error');
          this.connectionPanel?.setConnecting(false);
          this.webrtc?.close();
          this.webrtc = null;
        } else {
          this.disconnect();
          this.connectionPanel?.setStatus('WebRTC connection failed — check network', 'error');
        }
        break;
    }
  }

  // ── Robot Commands ──

  private sendStop(active: boolean): void {
    this.emergencyStopped = active;
    if (!active) return;
    // E-stop sends a priority Damp request. For G1/R1 the damp command
    // is encoded as api_id=7101 (G1State) with parameter {"data":1};
    // for Go2 it's the plain api_id=1001 (Damp). Both go to SPORT_MOD
    // with header.policy.priority=1 so the FSM bypasses the current
    // command queue. The old code sent Go2's StopMove + Damp on every
    // family, which G1 silently rejects with code 7404.
    if (isG1Family(cloudApi.connectFamily)) {
      this.publishRequestLogged(
        RTC_TOPIC.SPORT_MOD,
        7101,
        '{"data":1}',
        { priority: true, label: 'estop g1: damp (G1State data=1)' },
      );
    } else {
      this.publishRequestLogged(
        RTC_TOPIC.SPORT_MOD,
        SPORT_CMD.Damp,
        '{}',
        { priority: true, label: 'estop go2: damp' },
      );
    }
  }

  // ── Emergency-stop lockout ──
  //
  // While the e-stop is engaged the APK rejects joystick + action-bar
  // commands and surfaces a throttled toast (`ToastMsg("toastMsg_2")`)
  // — see `main-h84O7oJU.js` useOperaBarHook + useRTC handler. We do
  // the same: every guarded callsite calls `notifyEstopBlocked()` and
  // the throttle ensures the message never flashes more than once per
  // second even if the user keeps jiggling the joystick.
  private emergencyStopped = false;
  private estopToastEl: HTMLElement | null = null;
  private estopToastTimer: ReturnType<typeof setTimeout> | null = null;
  private estopToastLastShownAt = 0;

  /** True when the e-stop is engaged. Joystick + sport-action paths
   *  check this and bail with a toast rather than publishing. */
  private isEmergencyStopped(): boolean {
    return this.emergencyStopped;
  }

  /** Throttled "release the emergency stop first" toast — shows at most
   *  once per second, auto-dismisses after ~2.5 s. Mounts onto the
   *  control overlay so it sits below the navbar's e-stop button. */
  private notifyEstopBlocked(): void {
    this.notifyBlocked('Emergency stop engaged — swipe the red bar right to release.');
  }

  /** R1 click-time rules, mirroring the official webview's opera-bar handler
   *  (`switch (H)` in index-BXEK_QdB.js). It greys nothing out; it just
   *  refuses two cases on the way out:
   *    • Zero Torque unless the robot is already damping — the webview shows
   *      toastMsg_29 ("Please confirm that you are currently in the damping
   *      state") and sends nothing. The robot agrees: every locomotion state
   *      black-lists ZeroTorque, so it would answer 1001 anyway.
   *    • Run while already running — a no-op there, so don't spam the FSM.
   *  Returns false to swallow the click. */
  private r1ClickGuard(action: RobotAction): boolean {
    if (cloudApi.connectFamily !== 'R1' || action.apiId !== G1_STATE_API_ID) return true;
    const state = r1ModeToState(this.robotState.mode);
    if (action.g1Key === G1_STATE.ZeroTorque && state !== G1_STATE.Damp) {
      this.notifyBlocked('Zero Torque needs the robot to be in Damping first.');
      return false;
    }
    return !(action.g1Key === G1_STATE.Run && state === G1_STATE.Run);
  }

  /** Shared transient toast used by the guarded paths. Throttled to once per
   *  second so a held joystick (or a jabbed action row) can't strobe it. */
  private notifyBlocked(message: string): void {
    const now = performance.now();
    if (now - this.estopToastLastShownAt < 1000) return;
    this.estopToastLastShownAt = now;

    if (this.estopToastTimer) clearTimeout(this.estopToastTimer);
    if (!this.estopToastEl) {
      this.estopToastEl = document.createElement('div');
      this.estopToastEl.className = 'estop-blocked-toast';
      (this.controlUi ?? document.body).appendChild(this.estopToastEl);
    }
    this.estopToastEl.textContent = message;
    this.estopToastEl.classList.add('show');
    this.estopToastTimer = setTimeout(() => {
      this.estopToastEl?.classList.remove('show');
    }, 2500);
  }

  private clearEstopToast(): void {
    if (this.estopToastTimer) {
      clearTimeout(this.estopToastTimer);
      this.estopToastTimer = null;
    }
    this.estopToastEl?.remove();
    this.estopToastEl = null;
  }

  private sendRadarToggle(enabled: boolean): void {
    this.settingsState.radarOn = enabled;
    this.publishRequestLogged(
      RTC_TOPIC.OBSTACLES_AVOID, 1001,
      JSON.stringify({ enable: enabled }),
      { label: `obstacles_avoid/set-radar ${enabled ? 'on' : 'off'}` },
    );
  }

  private sendLidarToggle(enabled: boolean): void {
    this.settingsState.lidarOn = enabled;
    const state = enabled ? 'ON' : 'OFF';
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.dataHandler?.publish(RTC_TOPIC.LIDAR_SWITCH, state), i * 100);
    }
    if (!enabled) this.scene3d?.voxelMap.clear();
    this.scene3d?.robotModel.setRadarSpinning(enabled);
  }

  private sendLamp(level: number): void {
    this.settingsState.brightness = level;
    this.publishRequestLogged(
      RTC_TOPIC.VUI, 1005,
      JSON.stringify({ brightness: level }),
      { label: `vui/set-brightness ${level}` },
    );
  }

  /** Set the RGB status LED to a named colour (vui api_id 1007). `time` is the
   *  on-duration in seconds (999 ≈ persistent, matching the app); `flash_cycle`
   *  is the blink period in milliseconds (the SDK example uses 500). Colours:
   *  white/red/yellow/blue/green/cyan/purple. */
  private sendLed(color: string, blink: boolean): void {
    const param: Record<string, unknown> = { color, time: 999 };
    if (blink) param.flash_cycle = 500;
    this.publishRequestLogged(
      RTC_TOPIC.VUI, 1007,
      JSON.stringify(param),
      { label: `vui/led-set ${color}${blink ? ' blink' : ''}` },
    );
  }

  /** Turn the RGB status LED off (vui api_id 1008). */
  private sendLedOff(): void {
    this.publishRequestLogged(
      RTC_TOPIC.VUI, 1008, '{}',
      { label: 'vui/led-quit' },
    );
  }

  private sendVolume(level: number): void {
    this.settingsState.volume = level;
    if (isG1Family(cloudApi.connectFamily)) {
      // G1 speaker volume is on the voice service, scale 0-100; map our 0-10
      // slider level back up (×10).
      this.publishRequestLogged(
        RTC_TOPIC.VOICE, 1006,
        JSON.stringify({ volume: level * 10 }),
        { label: `voice/set-volume ${level * 10}` },
      );
    } else {
      this.publishRequestLogged(
        RTC_TOPIC.VUI, 1003,
        JSON.stringify({ volume: level }),
        { label: `vui/set-volume ${level}` },
      );
    }
  }

  /** Toggle the dog's RF remote-control radio. APK fires
   *  demarcate_turnon_clicker.sh / demarcate_turnoff_clicker.sh via the
   *  BashRunner topic; the on path also re-fetches the bound ID. */
  private sendRemoteSwitch(enabled: boolean): void {
    this.runBashScript(enabled ? 'demarcate_turnon_clicker.sh' : 'demarcate_turnoff_clicker.sh');
  }

  /** Bind a new BLE remote by ID — APK fires set_remote_id.sh <id>.
   *  Response is followed by an automatic get_rfid.sh re-read. */
  private sendRemoteIdSet(id: string): void {
    const trimmed = id.trim();
    if (!trimmed) return;
    this.runBashScript(`set_remote_id.sh ${trimmed}`);
  }

  /** Toggle the cloud / internet remote-connection permission.
   *  rt/api/rm_con/request — api_id 1002, params { enable_status: 2|1 }.
   *  enable_status == 2 means enabled. Verified from NetPermissionModel.kt. */
  private sendInternetRemote(enabled: boolean): void {
    this.settingsState.internetRemoteOn = enabled;
    this.publishRequestLogged(
      RTC_TOPIC.PERMISSION_NET,
      1002,
      JSON.stringify({ enable_status: enabled ? 2 : 1 }),
      { label: `permission_net/set ${enabled ? 'on' : 'off'}` },
    );
  }

  private disconnect(): void {
    const wasRemote = this.connectionConfig?.mode === 'STA-T';

    this.stopJoystickLoop();
    this.setActiveInputSource(null);
    this.stopBgNoise();
    this.dataHandler?.destroy();
    this.dataHandler = null;
    this.webrtc?.close();
    this.webrtc = null;
    this.videoStream = null;
    this.videoBg = null;
    this.noiseBgCanvas = null;
    this.pipCamera?.destroy();
    this.pipCamera = null;
    this.navBar = null;
    this.actionBar = null;
    this.settingsDrawer?.destroy();
    this.settingsDrawer = null;
    this.audioEl?.pause();
    this.audioEl?.remove();
    this.audioEl = null;
    this.pttActive = false;
    this.audioMonitorActive = false;
    this.audioRecorder?.destroy();
    this.audioRecorder = null;
    this.audioListCache = null;
    this.audioPending.clear();
    this.armPending.clear();
    this.mcfSeedPending.clear();
    this.stopTeachHeartbeat();
    this.teachingPage?.destroy();
    this.teachingPage = null;
    this.clearEstopToast();
    this.emergencyStopped = false;
    this.statusPage = null;
    this.servicesPage = null;
    this.settingsPage = null;
    this.errorsPage = null;
    this.errorStore.clear();
    this.mappingPage?.destroy();
    this.mappingPage = null;
    this.accountPage?.destroy();
    this.accountPage = null;
    this.appSettingsPage?.destroy();
    this.appSettingsPage = null;
    this.serviceEntries = [];
    this.settingsState = {
      radarOn: false, lidarOn: true, volume: 0, brightness: 0, waistLocked: false,
      remoteSwitchOn: false, remoteId: '', internetRemoteOn: false,
      inputSources: [], activeInputSourceId: null,
    };
    if (this.serviceReportTimer) {
      clearInterval(this.serviceReportTimer);
      this.serviceReportTimer = null;
    }
    this.scene3d?.destroy();
    this.scene3d = null;
    this.viewMode = 'three';
    if (this.sceneToastTimer) { clearTimeout(this.sceneToastTimer); this.sceneToastTimer = null; }
    this.sceneToastEl?.remove();
    this.sceneToastEl = null;

    // Auto-connect means the hub is always backed by an active WebRTC
    // session. On disconnect (any mode) drop back to landing — re-entering
    // Connect → robot will re-establish the session.
    void wasRemote;
    this.connectionConfig = null;
    this.showLandingScreen();
  }
}
