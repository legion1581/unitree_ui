import { isG1Family } from '../../api/unitree-cloud';
import type { RobotFamily } from '../../api/unitree-cloud';
import type { InputSource, InputSourceKind } from './side-buttons';
import { AudioPlayer, type AudioPlayerCallbacks } from './audio-player';

/** Robot speaker volume is stored 0–10; both official apps show it ×10 as a
 *  percentage (0 → "0%", 10 → "100%"). */
const volumePercent = (v: number): string => `${v * 10}%`;

export interface SettingsState {
  radarOn: boolean;
  lidarOn: boolean;
  volume: number;
  brightness: number;
  waistLocked: boolean;
  remoteSwitchOn: boolean;
  remoteId: string;
  internetRemoteOn: boolean;
  /** Currently-available BT remotes + USB/HID gamepads. Set by
   *  App.refreshInputSources(); rendered by the BT Remote section. */
  inputSources: InputSource[];
  /** ID of the active source (matches an entry in `inputSources`) or
   *  null when on-screen joysticks are driving. */
  activeInputSourceId: string | null;
}

export interface SettingsCallbacks {
  onRadarToggle: (enabled: boolean) => void;
  onLidarToggle: (enabled: boolean) => void;
  onLampSet: (level: number) => void;
  /** Set the RGB status LED to a named colour, optionally blinking
   *  (vui api 1007). Go2 only. */
  onLedSet?: (color: string, blink: boolean) => void;
  /** Turn the RGB status LED off (vui api 1008). Go2 only. */
  onLedOff?: () => void;
  onVolumeSet: (level: number) => void;
  onWaistLockToggle?: (lock: boolean) => void;
  /** Toggle the BLE remote-control radio on the dog (Go2 only). */
  onRemoteSwitchToggle?: (enabled: boolean) => void;
  /** Bind a new remote ID — fires set_remote_id.sh. */
  onRemoteIdSet?: (id: string) => void;
  /** Toggle the cloud / internet remote-connection permission. */
  onInternetRemoteToggle?: (enabled: boolean) => void;
  /** Switch the active BLE/gamepad relay. Pass null to deactivate
   *  (falls back to the on-screen joysticks). */
  onInputSourceSelect?: (id: string | null) => void;
  /** When provided, an APK-style Audio Player section is rendered (audiohub
   *  record / upload / list / play / loop / rename / delete). */
  audio?: AudioPlayerCallbacks;
  family?: RobotFamily;
}

/**
 * Hub-side Settings tab. Duplicates the in-WebView SettingBar controls
 * (obstacle-avoid radar, LiDAR, head-lamp brightness, volume, G1 waist lock)
 * plus two APK-only surfaces that aren't in the WebView SettingBar at all:
 *
 *   - Remote Control switch + ID (mirrors APK Data > Remote Control;
 *     bashrunner get_rfpower / get_rfid / set_remote_id /
 *     demarcate_turnon_clicker / demarcate_turnoff_clicker)
 *   - Internet remote connection permission (mirrors APK Data >
 *     Permission; rt/api/rm_con/request api_id 1001/1002)
 *
 * State sync flows through `setState()` from App's bashrunner / VUI /
 * OBSTACLE / rm_con response handlers.
 */
export class SettingsPage {
  private container: HTMLElement;
  private state: SettingsState;
  private callbacks: SettingsCallbacks;

  private radarToggleEl: HTMLInputElement | null = null;
  private lidarToggleEl: HTMLInputElement | null = null;
  private waistToggleEl: HTMLInputElement | null = null;
  private volumeSliderEl: HTMLInputElement | null = null;
  private volumeValueEl: HTMLSpanElement | null = null;
  private brightnessSliderEl: HTMLInputElement | null = null;
  private brightnessValueEl: HTMLSpanElement | null = null;
  private remoteToggleEl: HTMLInputElement | null = null;
  private remoteIdRowEl: HTMLElement | null = null;
  private remoteIdValueEl: HTMLSpanElement | null = null;
  private internetToggleEl: HTMLInputElement | null = null;
  // BT Remote section refs — rebuilt whenever input sources change.
  private btRemoteToggleEl: HTMLInputElement | null = null;
  private btRemoteDescEl: HTMLElement | null = null;
  private btRemoteListEl: HTMLElement | null = null;
  /** Last source selected by the user — re-used when the master switch
   *  is flipped back on so the same remote keeps driving (until it
   *  disconnects or the user picks something else). */
  private btRemoteLastActiveId: string | null = null;
  private audioPlayer: AudioPlayer | null = null;

  constructor(
    parent: HTMLElement,
    initial: SettingsState,
    onBack: (() => void) | null,
    callbacks: SettingsCallbacks,
  ) {
    this.state = { ...initial };
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.className = 'settings-page';

    // Page-header is skipped when onBack is null — embedded mode for the
    // in-WebView drawer, which renders its own chrome (title + close).
    if (onBack) {
      const header = document.createElement('div');
      header.className = 'page-header';
      const backBtn = document.createElement('button');
      backBtn.className = 'page-back-btn';
      backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
      backBtn.addEventListener('click', onBack);
      header.appendChild(backBtn);
      const title = document.createElement('h2');
      title.textContent = 'Controls';
      header.appendChild(title);
      this.container.appendChild(header);
    }

    const content = document.createElement('div');
    content.className = 'page-content';

    const isG1 = isG1Family(callbacks.family ?? 'Go2');
    // isG1 covers the humanoid family (G1 + R1); the waist motor is G1-only.
    const isActualG1 = (callbacks.family ?? 'Go2') === 'G1';

    // ── Multimedia ── speaker + lamp (audio + lighting output).
    const multimedia = this.buildCategory('Multimedia');
    multimedia.appendChild(this.buildSliderSection(
      'Speaker Volume',
      'Voice prompts and beeps (0 = mute).',
      this.state.volume,
      (val) => {
        this.state.volume = val;
        callbacks.onVolumeSet(val);
      },
      (slider, value) => {
        this.volumeSliderEl = slider;
        this.volumeValueEl = value;
      },
      // The robot stores volume 0–10; both official apps display it as a
      // percentage (×10), matching the speaker-volume read-out.
      volumePercent,
    ));
    if (!isG1) {
      multimedia.appendChild(this.buildSliderSection(
        'Head Lamp',
        'Front flashlight brightness (0 = off).',
        this.state.brightness,
        (val) => {
          this.state.brightness = val;
          callbacks.onLampSet(val);
        },
        (slider, value) => {
          this.brightnessSliderEl = slider;
          this.brightnessValueEl = value;
        },
      ));
      // RGB status LED — colour swatches + blink toggle + off (vui 1007/1008).
      if (callbacks.onLedSet && callbacks.onLedOff) {
        multimedia.appendChild(this.buildLedSection(callbacks.onLedSet, callbacks.onLedOff));
      }
    }
    this.appendIfPopulated(content, multimedia);

    // ── Navigation ── obstacle avoidance + LiDAR (perception / motion).
    // Both are quadruped-only — G1 has no equivalents.
    if (!isG1) {
      const navigation = this.buildCategory('Navigation');
      navigation.appendChild(this.buildToggleSection(
        'Obstacle Avoidance',
        'Enable the radar-based obstacle-avoidance assist while moving.',
        this.state.radarOn,
        (on) => {
          this.state.radarOn = on;
          callbacks.onRadarToggle(on);
        },
        (el) => { this.radarToggleEl = el; },
      ));
      navigation.appendChild(this.buildToggleSection(
        'LiDAR',
        'Stream MID-360 point cloud data (also drives the SLAM scene).',
        this.state.lidarOn,
        (on) => {
          this.state.lidarOn = on;
          callbacks.onLidarToggle(on);
        },
        (el) => { this.lidarToggleEl = el; },
      ));
      this.appendIfPopulated(content, navigation);
    }

    // ── Other Settings ── BT Remote (both families), waist lock (G1 only —
    // R1 has no waist motor and its Explorer app exposes no such control),
    // Remote Control radio (Go2), Internet Remote Connection permission.
    const other = this.buildCategory('Other Settings');
    if (callbacks.onInputSourceSelect) {
      other.appendChild(this.buildBtRemoteSection());
    }
    if (isActualG1 && callbacks.onWaistLockToggle) {
      other.appendChild(this.buildToggleSection(
        'Waist Lock',
        'Locks the waist motor (demarcate_setup_machine_type.sh 6=lock / 5=unlock).',
        this.state.waistLocked,
        (locked) => {
          this.state.waistLocked = locked;
          callbacks.onWaistLockToggle?.(locked);
        },
        (el) => { this.waistToggleEl = el; },
      ));
    }
    if (!isG1 && callbacks.onRemoteSwitchToggle && callbacks.onRemoteIdSet) {
      other.appendChild(this.buildRemoteControlSection());
    }
    if (callbacks.onInternetRemoteToggle) {
      other.appendChild(this.buildInternetRemoteSection());
    }
    this.appendIfPopulated(content, other);

    // ── Audio Player ── APK-style audiohub recorder / library.
    if (callbacks.audio) {
      const audioCat = this.buildCategory('Audio Player');
      this.audioPlayer = new AudioPlayer(callbacks.audio);
      audioCat.appendChild(this.audioPlayer.element);
      this.appendIfPopulated(content, audioCat);
    }

    this.container.appendChild(content);
    parent.appendChild(this.container);
  }

  /** Refresh the audio library list (e.g. after an external PTT recording). */
  refreshAudio(): void {
    this.audioPlayer?.refresh();
  }

  /** Push a robot play-state update into the audio player. */
  setAudioPlayState(state: { is_playing?: boolean; current_audio_unique_id?: string | null }): void {
    this.audioPlayer?.setPlayState(state);
  }

  /** Tear down owned child components. */
  destroy(): void {
    this.audioPlayer?.destroy();
    this.audioPlayer = null;
  }

  /** Create a category container with a title header. The container
   *  starts empty; sections are appended afterwards. Caller decides
   *  whether to mount the container based on whether anything got
   *  appended (see `appendIfPopulated`). */
  private buildCategory(title: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'settings-category';
    const h = document.createElement('div');
    h.className = 'settings-category-title';
    h.textContent = title;
    wrap.appendChild(h);
    return wrap;
  }

  /** Mount a category onto the content area only if it has at least one
   *  section under it. The category title alone is not enough — empty
   *  categories (e.g. G1's empty Navigation) would just be visual noise. */
  private appendIfPopulated(parent: HTMLElement, category: HTMLElement): void {
    // children > 1 because the title element is always present.
    if (category.children.length > 1) parent.appendChild(category);
  }

  /** Sync state pushed back from the robot.
   *
   * Sources:
   *   - VUI 1004/1006 → volume / brightness
   *   - OBSTACLE 1002 → radarOn
   *   - bashrunner get_rfpower.sh / get_rfid.sh /
   *     demarcate_turn{on,off}_clicker.sh / set_remote_id.sh
   *     → remoteSwitchOn / remoteId
   *   - rm_con 1001 → internetRemoteOn
   */
  setState(partial: Partial<SettingsState>): void {
    if (partial.radarOn !== undefined) {
      this.state.radarOn = partial.radarOn;
      if (this.radarToggleEl) this.radarToggleEl.checked = partial.radarOn;
    }
    if (partial.lidarOn !== undefined) {
      this.state.lidarOn = partial.lidarOn;
      if (this.lidarToggleEl) this.lidarToggleEl.checked = partial.lidarOn;
    }
    if (partial.volume !== undefined) {
      this.state.volume = partial.volume;
      if (this.volumeSliderEl) this.volumeSliderEl.value = String(partial.volume);
      if (this.volumeValueEl) this.volumeValueEl.textContent = volumePercent(partial.volume);
    }
    if (partial.brightness !== undefined) {
      this.state.brightness = partial.brightness;
      if (this.brightnessSliderEl) this.brightnessSliderEl.value = String(partial.brightness);
      if (this.brightnessValueEl) this.brightnessValueEl.textContent = String(partial.brightness);
    }
    if (partial.waistLocked !== undefined) {
      this.state.waistLocked = partial.waistLocked;
      if (this.waistToggleEl) this.waistToggleEl.checked = partial.waistLocked;
    }
    if (partial.remoteSwitchOn !== undefined) {
      this.state.remoteSwitchOn = partial.remoteSwitchOn;
      if (this.remoteToggleEl) this.remoteToggleEl.checked = partial.remoteSwitchOn;
      if (this.remoteIdRowEl) this.remoteIdRowEl.style.display = partial.remoteSwitchOn ? '' : 'none';
    }
    if (partial.remoteId !== undefined) {
      this.state.remoteId = partial.remoteId;
      if (this.remoteIdValueEl) {
        this.remoteIdValueEl.textContent = partial.remoteId || '—';
      }
    }
    if (partial.internetRemoteOn !== undefined) {
      this.state.internetRemoteOn = partial.internetRemoteOn;
      if (this.internetToggleEl) this.internetToggleEl.checked = partial.internetRemoteOn;
    }
    if (partial.inputSources !== undefined) {
      this.state.inputSources = partial.inputSources;
      this.refreshBtRemoteSection();
    }
    if (partial.activeInputSourceId !== undefined) {
      this.state.activeInputSourceId = partial.activeInputSourceId;
      if (partial.activeInputSourceId) this.btRemoteLastActiveId = partial.activeInputSourceId;
      this.refreshBtRemoteSection();
    }
  }

  private buildToggleSection(
    title: string,
    description: string,
    initial: boolean,
    onChange: (enabled: boolean) => void,
    register: (el: HTMLInputElement) => void,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'settings-section';

    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = title;
    text.appendChild(t);
    const d = document.createElement('div');
    d.className = 'settings-desc';
    d.textContent = description;
    text.appendChild(d);

    const ctrl = document.createElement('label');
    ctrl.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.addEventListener('change', () => onChange(input.checked));
    const slider = document.createElement('span');
    slider.className = 'settings-toggle-slider';
    ctrl.appendChild(input);
    ctrl.appendChild(slider);

    section.appendChild(text);
    section.appendChild(ctrl);
    register(input);
    return section;
  }

  private buildSliderSection(
    title: string,
    description: string,
    initial: number,
    onChange: (val: number) => void,
    register: (slider: HTMLInputElement, value: HTMLSpanElement) => void,
    formatValue: (v: number) => string = String,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'settings-section settings-section-slider';

    const head = document.createElement('div');
    head.className = 'settings-section-head';
    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = title;
    text.appendChild(t);
    const d = document.createElement('div');
    d.className = 'settings-desc';
    d.textContent = description;
    text.appendChild(d);
    head.appendChild(text);

    const value = document.createElement('span');
    value.className = 'settings-slider-value';
    value.textContent = formatValue(initial);
    head.appendChild(value);

    section.appendChild(head);

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'settings-slider';
    range.min = '0';
    range.max = '10';
    range.value = String(initial);
    range.addEventListener('input', () => {
      const val = parseInt(range.value, 10);
      value.textContent = formatValue(val);
      onChange(val);
    });
    section.appendChild(range);

    register(range, value);
    return section;
  }

  /** RGB status-light control: a row of colour swatches, a Blink toggle, and
   *  an Off button. Picking a swatch sends vui 1007 with the current blink
   *  state; Off sends vui 1008. The Go2's named colours come from the VUI
   *  service (white/red/yellow/blue/green/cyan/purple). */
  private buildLedSection(
    onLedSet: (color: string, blink: boolean) => void,
    onLedOff: () => void,
  ): HTMLElement {
    const LED_COLORS: { name: string; hex: string }[] = [
      { name: 'white', hex: '#ffffff' },
      { name: 'red', hex: '#ff3b3b' },
      { name: 'yellow', hex: '#ffe11a' },
      { name: 'green', hex: '#36e04a' },
      { name: 'cyan', hex: '#28e0e0' },
      { name: 'blue', hex: '#5566ff' },
      { name: 'purple', hex: '#a64dff' },
    ];

    let selected: string | null = null;
    let blink = false;

    const section = document.createElement('div');
    section.className = 'settings-section settings-section-slider';

    const head = document.createElement('div');
    head.className = 'settings-section-head';
    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = 'Status LED';
    text.appendChild(t);
    const d = document.createElement('div');
    d.className = 'settings-desc';
    d.textContent = 'Head RGB light — pick a colour, toggle blink, or turn off.';
    text.appendChild(d);
    head.appendChild(text);

    // Top-right control cluster: Blink toggle + Off button.
    const corner = document.createElement('div');
    corner.style.cssText = 'display:flex;align-items:center;gap:10px;flex:0 0 auto;';

    const blinkLabel = document.createElement('label');
    blinkLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary,#b0b3bb);cursor:pointer;';
    blinkLabel.title = 'Blink the LED';
    const blinkToggle = document.createElement('label');
    blinkToggle.className = 'settings-toggle';
    const blinkInput = document.createElement('input');
    blinkInput.type = 'checkbox';
    blinkInput.addEventListener('change', () => {
      blink = blinkInput.checked;
      // Re-apply to the active colour so the change takes effect immediately.
      if (selected) onLedSet(selected, blink);
    });
    const blinkSliderEl = document.createElement('span');
    blinkSliderEl.className = 'settings-toggle-slider';
    blinkToggle.appendChild(blinkInput);
    blinkToggle.appendChild(blinkSliderEl);
    const blinkTextEl = document.createElement('span');
    blinkTextEl.textContent = 'Blink';
    blinkLabel.appendChild(blinkTextEl);
    blinkLabel.appendChild(blinkToggle);

    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = 'Off';
    off.style.cssText =
      'padding:5px 14px;border-radius:6px;border:1px solid #3a3d45;' +
      'background:rgba(255,255,255,.06);color:#c3c9e9;font-size:13px;cursor:pointer;flex:0 0 auto;';

    corner.appendChild(blinkLabel);
    corner.appendChild(off);
    head.appendChild(corner);
    section.appendChild(head);

    // Swatch row.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;';

    const swatchEls: HTMLButtonElement[] = [];
    const markSelected = () => {
      swatchEls.forEach((el) => {
        const on = el.dataset.color === selected;
        el.style.outline = on ? '2px solid #fff' : '2px solid transparent';
        el.style.transform = on ? 'scale(1.12)' : 'scale(1)';
      });
    };

    for (const c of LED_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.dataset.color = c.name;
      sw.title = c.name;
      sw.setAttribute('aria-label', `Set LED ${c.name}`);
      sw.style.cssText =
        `width:26px;height:26px;border-radius:50%;border:1.5px solid rgba(0,0,0,.35);cursor:pointer;` +
        `background:${c.hex};outline:2px solid transparent;outline-offset:1px;transition:transform .12s,outline-color .12s;padding:0;`;
      sw.addEventListener('click', () => {
        selected = c.name;
        markSelected();
        onLedSet(c.name, blink);
      });
      swatchEls.push(sw);
      row.appendChild(sw);
    }
    section.appendChild(row);

    off.addEventListener('click', () => {
      selected = null;
      markSelected();
      onLedOff();
    });

    return section;
  }

  /** "Remote Control" — switch + (when on) read-only ID row with Edit button. */
  private buildRemoteControlSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'settings-section settings-section-stack';

    const head = document.createElement('div');
    head.className = 'settings-section-head';

    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = 'Remote Control';
    text.appendChild(t);
    const d = document.createElement('div');
    d.className = 'settings-desc';
    d.textContent = 'Enable the dog’s RF remote-control receiver and bind a controller by ID.';
    text.appendChild(d);
    head.appendChild(text);

    const ctrl = document.createElement('label');
    ctrl.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.state.remoteSwitchOn;
    input.addEventListener('change', () => {
      // Optimistic UI: leave it checked until response comes back. If the
      // bashrunner errors, App.setState() will flip it back.
      this.callbacks.onRemoteSwitchToggle?.(input.checked);
    });
    const slider = document.createElement('span');
    slider.className = 'settings-toggle-slider';
    ctrl.appendChild(input);
    ctrl.appendChild(slider);
    head.appendChild(ctrl);
    this.remoteToggleEl = input;

    section.appendChild(head);

    // ID row — hidden until the switch is on (matches APK Group visibility).
    const idRow = document.createElement('div');
    idRow.className = 'settings-id-row';
    idRow.style.display = this.state.remoteSwitchOn ? '' : 'none';

    const idLabel = document.createElement('span');
    idLabel.className = 'settings-id-label';
    idLabel.textContent = 'Remote Control ID';
    idRow.appendChild(idLabel);

    const idValue = document.createElement('span');
    idValue.className = 'settings-id-value';
    idValue.textContent = this.state.remoteId || '—';
    idRow.appendChild(idValue);

    const editBtn = document.createElement('button');
    editBtn.className = 'settings-id-edit';
    editBtn.textContent = 'Change';
    editBtn.addEventListener('click', () => this.openIdEditModal());
    idRow.appendChild(editBtn);

    section.appendChild(idRow);
    this.remoteIdRowEl = idRow;
    this.remoteIdValueEl = idValue;

    return section;
  }

  /** "Internet remote connection" — toggle with disclaimer modal on enable. */
  private buildInternetRemoteSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'settings-section';

    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = 'Internet Remote Connection';
    text.appendChild(t);
    const d = document.createElement('div');
    d.className = 'settings-desc';
    d.textContent = 'Allow the robot to connect to Unitree’s cloud relay so it can be reached over the internet (STA-T).';
    text.appendChild(d);

    const ctrl = document.createElement('label');
    ctrl.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.state.internetRemoteOn;
    input.addEventListener('change', () => {
      if (input.checked) {
        // Show the same disclaimer the APK shows (net_open_tip).
        // Revert the toggle while the modal is open; only flip it back on
        // confirmation. Cancel leaves the switch in the off state.
        input.checked = false;
        this.openInternetRemoteDisclaimer(() => {
          input.checked = true;
          this.callbacks.onInternetRemoteToggle?.(true);
        });
      } else {
        this.callbacks.onInternetRemoteToggle?.(false);
      }
    });
    const slider = document.createElement('span');
    slider.className = 'settings-toggle-slider';
    ctrl.appendChild(input);
    ctrl.appendChild(slider);

    section.appendChild(text);
    section.appendChild(ctrl);
    this.internetToggleEl = input;
    return section;
  }

  /** Inline modal — text input. Used for "Change Remote Control ID". */
  private openIdEditModal(): void {
    const overlay = document.createElement('div');
    overlay.className = 'settings-modal-overlay';

    const card = document.createElement('div');
    card.className = 'settings-modal-card';

    const title = document.createElement('div');
    title.className = 'settings-modal-title';
    title.textContent = 'Change Remote Control ID';
    card.appendChild(title);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-modal-input';
    input.placeholder = 'Enter Remote Control ID';
    input.value = this.state.remoteId || '';
    card.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'settings-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'settings-modal-btn settings-modal-btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const confirm = document.createElement('button');
    confirm.className = 'settings-modal-btn settings-modal-btn-primary';
    confirm.textContent = 'Confirm';
    confirm.addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) return;
      overlay.remove();
      this.callbacks.onRemoteIdSet?.(v);
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    setTimeout(() => input.focus(), 0);
  }

  /** Disclaimer modal (mirrors APK `net_open_tip`). Calls `onConfirm` only
   *  if the user accepts; closing or clicking Cancel leaves things off. */
  private openInternetRemoteDisclaimer(onConfirm: () => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'settings-modal-overlay';

    const card = document.createElement('div');
    card.className = 'settings-modal-card';

    const title = document.createElement('div');
    title.className = 'settings-modal-title';
    title.textContent = 'Internet Remote Connection';
    card.appendChild(title);

    const body = document.createElement('div');
    body.className = 'settings-modal-body';
    body.textContent =
      'Please note that when the robot’s network connection is authorized and enabled by you and the connection is successful, some very basic device information (e.g., the device ID and health status) may be uploaded to the server.';
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'settings-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'settings-modal-btn settings-modal-btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const confirm = document.createElement('button');
    confirm.className = 'settings-modal-btn settings-modal-btn-primary';
    confirm.textContent = 'Allow';
    confirm.addEventListener('click', () => {
      overlay.remove();
      onConfirm();
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  /** "BT Remote" section — master switch + (when >1 source) a scrollable
   *  list of available BLE remotes / gamepads. Switch is disabled when
   *  no source is connected; flipping it on activates the most recently
   *  used source (or the first one if none was previously active). */
  private buildBtRemoteSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'settings-section settings-section-stack';

    const head = document.createElement('div');
    head.className = 'settings-section-head';

    const text = document.createElement('div');
    text.className = 'settings-text';
    const t = document.createElement('div');
    t.className = 'settings-title';
    t.textContent = 'BT and USB Remote';
    text.appendChild(t);
    const desc = document.createElement('div');
    desc.className = 'settings-desc';
    text.appendChild(desc);
    head.appendChild(text);

    const ctrl = document.createElement('label');
    ctrl.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => this.handleBtRemoteToggle(input.checked));
    const slider = document.createElement('span');
    slider.className = 'settings-toggle-slider';
    ctrl.appendChild(input);
    ctrl.appendChild(slider);
    head.appendChild(ctrl);

    section.appendChild(head);

    const list = document.createElement('div');
    list.className = 'settings-bt-remote-list';
    section.appendChild(list);

    this.btRemoteToggleEl = input;
    this.btRemoteDescEl = desc;
    this.btRemoteListEl = list;

    this.refreshBtRemoteSection();
    return section;
  }

  /** Re-render the switch state, description text, and source list to
   *  match the current state. Called from buildBtRemoteSection() and
   *  from setState({ inputSources, activeInputSourceId }). */
  private refreshBtRemoteSection(): void {
    if (!this.btRemoteToggleEl || !this.btRemoteDescEl || !this.btRemoteListEl) return;

    const sources = this.state.inputSources;
    const active = sources.find((s) => s.id === this.state.activeInputSourceId) ?? null;
    const haveSources = sources.length > 0;

    // Master switch
    this.btRemoteToggleEl.checked = active !== null;
    this.btRemoteToggleEl.disabled = !haveSources;

    // Description
    if (!haveSources) {
      this.btRemoteDescEl.textContent = 'No BT or USB remote connected.';
    } else if (active) {
      this.btRemoteDescEl.textContent = `Relaying input from ${active.label}.`;
    } else if (sources.length === 1) {
      this.btRemoteDescEl.textContent = `Available: ${sources[0].label}. Switch on to start relaying.`;
    } else {
      this.btRemoteDescEl.textContent = `${sources.length} sources available. Pick one below to start relaying.`;
    }

    // Source list — only when there's more than one to pick between,
    // otherwise the master switch is the whole UI. Rendered fresh every
    // call so we don't carry stale rows.
    this.btRemoteListEl.innerHTML = '';
    if (sources.length > 1) {
      this.btRemoteListEl.style.display = '';
      for (const source of sources) {
        this.btRemoteListEl.appendChild(this.buildBtRemoteRow(source, source.id === active?.id));
      }
    } else {
      this.btRemoteListEl.style.display = 'none';
    }
  }

  private buildBtRemoteRow(source: InputSource, isActive: boolean): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-bt-remote-row';
    row.dataset.active = isActive ? 'true' : 'false';

    const icon = document.createElement('span');
    icon.className = 'settings-bt-remote-icon';
    icon.innerHTML = btRemoteSvg(source.kind, isActive ? '#42CF55' : '#8a8e96');
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'settings-bt-remote-label';
    label.textContent = source.label;
    row.appendChild(label);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'settings-bt-remote-badge';
      badge.textContent = 'ON';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => {
      // Toggle behaviour: clicking the active row deactivates it; any
      // other row becomes the new active source.
      const newId = isActive ? null : source.id;
      this.btRemoteLastActiveId = source.id;
      this.callbacks.onInputSourceSelect?.(newId);
    });
    return row;
  }

  /** Master switch handler. Off → deactivate. On → reactivate the last
   *  used source, or the first available one if none. */
  private handleBtRemoteToggle(on: boolean): void {
    if (!on) {
      this.callbacks.onInputSourceSelect?.(null);
      return;
    }
    const sources = this.state.inputSources;
    if (sources.length === 0) return;
    const preferred = sources.find((s) => s.id === this.btRemoteLastActiveId);
    const target = preferred ?? sources[0];
    this.btRemoteLastActiveId = target.id;
    this.callbacks.onInputSourceSelect?.(target.id);
  }
}

const RELAY_SVG = (color: string) => `<svg width="18" height="18" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 8 C3 8, 2 13, 3 17 C3.5 19, 5 20, 7 19.5 L10 17 L16 17 L19 19.5 C21 20, 22.5 19, 23 17 C24 13, 23 8, 19 8 Z"/>
  <circle cx="8" cy="13" r="1.8" fill="${color}" stroke="none"/>
  <circle cx="18" cy="13" r="1.8" fill="${color}" stroke="none"/>
</svg>`;

const GAMEPAD_SVG = (color: string) => `<svg width="18" height="18" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 9 C3.5 9, 2.5 12.5, 3.5 16 C4 17.5, 5.5 18.5, 7.5 18 L10.5 16.5 L15.5 16.5 L18.5 18 C20.5 18.5, 22 17.5, 22.5 16 C23.5 12.5, 22.5 9, 20 9 Z"/>
  <circle cx="9" cy="13" r="1.6" fill="${color}" stroke="none"/>
  <circle cx="17" cy="13" r="1.6" fill="${color}" stroke="none"/>
  <path d="M12.5 11v5M10 13.5h5" stroke-width="1.3"/>
</svg>`;

function btRemoteSvg(kind: InputSourceKind, color: string): string {
  return kind === 'gamepad' ? GAMEPAD_SVG(color) : RELAY_SVG(color);
}
