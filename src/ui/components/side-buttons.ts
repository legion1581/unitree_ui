// LiDAR icon SVGs (simple 3D scan/point cloud icon)
const LIDAR_SVG_ON = `<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#6879e4" stroke-width="2" stroke-linecap="round">
  <circle cx="12" cy="12" r="2"/>
  <path d="M12 2a10 10 0 0 1 0 20"/>
  <path d="M12 2a10 10 0 0 0 0 20"/>
  <path d="M12 6a6 6 0 0 1 0 12"/>
  <path d="M12 6a6 6 0 0 0 0 12"/>
</svg>`;

const LIDAR_SVG_OFF = `<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round">
  <circle cx="12" cy="12" r="2"/>
  <path d="M12 2a10 10 0 0 1 0 20"/>
  <path d="M12 2a10 10 0 0 0 0 20"/>
  <path d="M12 6a6 6 0 0 1 0 12"/>
  <path d="M12 6a6 6 0 0 0 0 12"/>
</svg>`;

// Relay Remote icon — classic gamepad silhouette with two sticks and a D-pad
const RELAY_SVG = (color: string) => `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <!-- Body shape (two rounded grips joined by central bridge) -->
  <path d="M7 8 C3 8, 2 13, 3 17 C3.5 19, 5 20, 7 19.5 L10 17 L16 17 L19 19.5 C21 20, 22.5 19, 23 17 C24 13, 23 8, 19 8 Z"/>
  <!-- Left stick -->
  <circle cx="8" cy="13" r="1.8" fill="${color}" stroke="none"/>
  <!-- Right stick -->
  <circle cx="18" cy="13" r="1.8" fill="${color}" stroke="none"/>
</svg>`;

// Gamepad icon — controller with sticks and a plus sign
const GAMEPAD_SVG = (color: string) => `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 9 C3.5 9, 2.5 12.5, 3.5 16 C4 17.5, 5.5 18.5, 7.5 18 L10.5 16.5 L15.5 16.5 L18.5 18 C20.5 18.5, 22 17.5, 22.5 16 C23.5 12.5, 22.5 9, 20 9 Z"/>
  <circle cx="9" cy="13" r="1.6" fill="${color}" stroke="none"/>
  <circle cx="17" cy="13" r="1.6" fill="${color}" stroke="none"/>
  <path d="M12.5 11v5M10 13.5h5" stroke-width="1.3"/>
</svg>`;

// Waist-lock padlock icon (G1)
const WAIST_LOCK_SVG = (color: string) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="11" width="16" height="10" rx="2"/>
  <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
</svg>`;

import { isG1Family } from '../../api/unitree-cloud';
import type { RobotFamily } from '../../api/unitree-cloud';

export type InputSourceKind = 'bt' | 'gamepad';

export interface InputSource {
  /** Stable id, e.g. `bt:AA:BB:CC` or `gamepad:0`. Used for selection. */
  id: string;
  kind: InputSourceKind;
  label: string;
}

export interface SettingCallbacks {
  onRadarToggle: (enabled: boolean) => void;
  onLampSet: (level: number) => void;
  onVolumeSet: (level: number) => void;
  onLidarToggle: (enabled: boolean) => void;
  /** Activate a specific input source by id, or pass null to deactivate. */
  onInputSourceSelect: (id: string | null) => void;
  /** Optional Waist-Lock toggle — only rendered when handler is provided
   *  (G1 only). The flag indicates the desired locked state. */
  onWaistLockToggle?: (lock: boolean) => void;
  /** Robot family. G1 hides the Go2-specific buttons (Radar / LiDAR /
   *  Lamp) and shows a Waist Lock toggle in their place. */
  family?: RobotFamily;
}

export class SettingBar {
  private container: HTMLElement;
  private radarOn = false;
  private lidarOn = true;
  private radarBtn!: HTMLButtonElement;
  private volumeBtn!: HTMLButtonElement;
  private lampBtn!: HTMLButtonElement;
  private inputSourceBtn!: HTMLButtonElement;
  private waistLockBtn: HTMLButtonElement | null = null;
  private waistLocked = false;
  private volumeLevel = 0;
  private lampLevel = 0;
  private inputSources: InputSource[] = [];
  private activeSourceId: string | null = null;
  private callbacks: SettingCallbacks;

  constructor(parent: HTMLElement, callbacks: SettingCallbacks) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.container.className = 'setting-bar';

    const isG1 = isG1Family(callbacks.family ?? 'Go2');
    // Humanoid-family checks above cover G1 + R1; the waist motor is G1-only.
    const isActualG1 = (callbacks.family ?? 'Go2') === 'G1';

    // Radar / LiDAR / Lamp are quadruped-only controls (obstacle avoid,
    // mid360 toggle, head-lamp brightness). G1 has no equivalents in
    // the Explorer webview so we skip them.
    if (!isG1) {
      this.radarBtn = this.createBtn('/sprites/icon_radar.png', 'Radar');
      this.radarBtn.addEventListener('click', () => {
        this.radarOn = !this.radarOn;
        const img = this.radarBtn.querySelector('img')!;
        img.src = this.radarOn ? '/sprites/icon_radar_on.png' : '/sprites/icon_radar.png';
        callbacks.onRadarToggle(this.radarOn);
      });
      this.container.appendChild(this.radarBtn);

      const lidarBtn = this.createSvgBtn(LIDAR_SVG_ON, 'LiDAR');
      lidarBtn.addEventListener('click', () => {
        this.lidarOn = !this.lidarOn;
        lidarBtn.innerHTML = this.lidarOn ? LIDAR_SVG_ON : LIDAR_SVG_OFF;
        callbacks.onLidarToggle(this.lidarOn);
      });
      this.container.appendChild(lidarBtn);
    }

    // Volume button (kept on both families).
    this.volumeBtn = this.createBtn('/sprites/icon_volume.png', 'Volume');
    this.volumeBtn.addEventListener('click', () => {
      this.toggleSlider(this.volumeBtn, 'Vol', this.volumeLevel, (val) => {
        this.volumeLevel = val;
        const img = this.volumeBtn.querySelector('img')!;
        img.src = val > 0 ? '/sprites/icon_volume_on.png' : '/sprites/icon_volume.png';
        callbacks.onVolumeSet(val);
      });
    });
    this.container.appendChild(this.volumeBtn);

    if (!isG1) {
      this.lampBtn = this.createBtn('/sprites/icon_lamp.png', 'Light');
      this.lampBtn.addEventListener('click', () => {
        this.toggleSlider(this.lampBtn, 'Light', this.lampLevel, (val) => {
          this.lampLevel = val;
          const img = this.lampBtn.querySelector('img')!;
          img.src = val > 0 ? '/sprites/icon_lamp_on.png' : '/sprites/icon_lamp.png';
          callbacks.onLampSet(val);
        });
      });
      this.container.appendChild(this.lampBtn);
    }

    // Waist Lock — G1 only, and that means G1 proper, not the whole humanoid
    // family: R1 has no waist motor and the R1 Explorer app shows no such
    // control. Fires BaseRunner.G1_SETUP_MACHINE_TYPE (script
    // demarcate_setup_machine_type.sh) with arg "6" (lock) / "5" (unlock)
    // per the decompiled BaseInfoViewModel.kt:570.
    if (isActualG1 && callbacks.onWaistLockToggle) {
      this.waistLockBtn = this.createSvgBtn(WAIST_LOCK_SVG('#666'), 'Waist Unlocked');
      this.waistLockBtn.addEventListener('click', () => {
        this.waistLocked = !this.waistLocked;
        this.updateWaistLockVisual();
        callbacks.onWaistLockToggle?.(this.waistLocked);
      });
      this.container.appendChild(this.waistLockBtn);
    }

    // Unified input-source button. Disabled while no BT remote / gamepad is
    // available. Click opens a picker showing every connected source so the
    // user can choose which one drives the robot (mutually exclusive).
    this.inputSourceBtn = this.createSvgBtn(RELAY_SVG('#444'), 'Input Source');
    this.inputSourceBtn.disabled = true;
    this.inputSourceBtn.style.position = 'relative';
    this.inputSourceBtn.addEventListener('click', () => {
      if (this.inputSources.length === 0) return;
      this.toggleSourcePicker();
    });
    this.container.appendChild(this.inputSourceBtn);
    this.updateInputSourceVisual();

    parent.appendChild(this.container);
  }

  private updateWaistLockVisual(): void {
    if (!this.waistLockBtn) return;
    this.waistLockBtn.innerHTML = WAIST_LOCK_SVG(this.waistLocked ? '#6879e4' : '#666');
    const lbl = document.createElement('span');
    lbl.textContent = this.waistLocked ? 'Waist Locked' : 'Waist Unlocked';
    // createSvgBtn writes a <span> sibling to the <svg>. Replace it.
    const existingLbl = this.waistLockBtn.querySelector('span');
    if (existingLbl) existingLbl.textContent = lbl.textContent;
    else this.waistLockBtn.appendChild(lbl);
  }

  /** Push the full list of currently-available input sources (BT remotes,
   *  USB/HID gamepads, …). Pass an empty list to mark no source available. */
  setInputSources(sources: InputSource[]): void {
    this.inputSources = sources.slice();
    // If the active source vanished, the App layer is responsible for calling
    // setActiveInputSource(null). We just refresh visuals & open picker.
    this.updateInputSourceVisual();
    // Re-render picker rows if it's open.
    const popup = this.inputSourceBtn.querySelector('.source-picker') as HTMLElement | null;
    if (popup) {
      this.renderSourcePickerRows(popup);
    }
  }

  /** Mark which source is currently driving the robot (or null = none). */
  setActiveInputSource(id: string | null): void {
    this.activeSourceId = id;
    this.updateInputSourceVisual();
  }

  private updateInputSourceVisual(): void {
    const available = this.inputSources.length > 0;
    const active = this.activeSourceId !== null
      && this.inputSources.some(s => s.id === this.activeSourceId);

    const color = !available ? '#444' : (active ? '#42CF55' : '#ccc');
    this.inputSourceBtn.innerHTML = RELAY_SVG(color);
    this.inputSourceBtn.disabled = !available;
    this.inputSourceBtn.style.cursor = available ? 'pointer' : 'not-allowed';
    this.inputSourceBtn.style.opacity = available ? '1' : '0.5';

    let tooltip: string;
    if (!available) {
      tooltip = 'Connect a BLE remote or plug in a USB/wireless gamepad';
    } else if (active) {
      const src = this.inputSources.find(s => s.id === this.activeSourceId);
      tooltip = src
        ? `Active: ${src.label} — click to switch / disable`
        : 'Input source active — click to switch';
    } else {
      tooltip = `Click to choose remote (${this.inputSources.length} available)`;
    }
    this.inputSourceBtn.title = tooltip;
  }

  private toggleSourcePicker(): void {
    const existing = this.inputSourceBtn.querySelector('.source-picker');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'source-picker';
    Object.assign(popup.style, {
      position: 'absolute',
      top: '100%',
      right: '0',
      marginTop: '8px',
      background: '#1a1d23',
      borderRadius: '8px',
      padding: '6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      zIndex: '30',
      minWidth: '220px',
      // Cap height to ~2 rows; anything more scrolls. Keeps the popup clear
      // of the e-stop slider that lives just below the setting bar.
      maxHeight: '92px',
      overflowY: 'auto',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    });

    this.renderSourcePickerRows(popup);
    this.inputSourceBtn.appendChild(popup);

    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && !this.inputSourceBtn.contains(e.target as Node)) {
        popup.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        popup.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', onKey);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  private renderSourcePickerRows(popup: HTMLElement): void {
    popup.innerHTML = '';

    if (this.inputSources.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No remotes available';
      Object.assign(empty.style, { color: '#888', padding: '8px', fontSize: '12px' });
      popup.appendChild(empty);
      return;
    }

    for (const source of this.inputSources) {
      const isActive = source.id === this.activeSourceId;
      const row = document.createElement('button');
      row.type = 'button';
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        border: 'none',
        borderRadius: '6px',
        background: isActive ? 'rgba(66, 207, 85, 0.15)' : 'transparent',
        color: '#eee',
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
      });
      row.addEventListener('mouseenter', () => {
        if (!isActive) row.style.background = 'rgba(255,255,255,0.06)';
      });
      row.addEventListener('mouseleave', () => {
        if (!isActive) row.style.background = 'transparent';
      });

      const icon = document.createElement('span');
      icon.style.display = 'inline-flex';
      icon.style.flex = '0 0 auto';
      const iconColor = isActive ? '#42CF55' : '#aaa';
      icon.innerHTML = source.kind === 'gamepad' ? GAMEPAD_SVG(iconColor) : RELAY_SVG(iconColor);
      // Shrink row icon
      const svgEl = icon.querySelector('svg');
      if (svgEl) { svgEl.setAttribute('width', '20'); svgEl.setAttribute('height', '20'); }
      row.appendChild(icon);

      const label = document.createElement('span');
      label.textContent = source.label;
      label.style.flex = '1';
      label.style.fontSize = '13px';
      row.appendChild(label);

      const status = document.createElement('span');
      status.textContent = isActive ? 'ON' : '';
      Object.assign(status.style, {
        color: '#42CF55',
        fontSize: '11px',
        fontWeight: '600',
        letterSpacing: '0.5px',
      });
      row.appendChild(status);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        // Click same source → deactivate; click different → switch.
        const newId = isActive ? null : source.id;
        popup.remove();
        this.callbacks.onInputSourceSelect(newId);
      });

      popup.appendChild(row);
    }
  }

  setRadar(enabled: boolean): void {
    this.radarOn = enabled;
    const img = this.radarBtn.querySelector('img')!;
    img.src = enabled ? '/sprites/icon_radar_on.png' : '/sprites/icon_radar.png';
  }

  setVolume(level: number): void {
    this.volumeLevel = level;
    const img = this.volumeBtn.querySelector('img')!;
    img.src = level > 0 ? '/sprites/icon_volume_on.png' : '/sprites/icon_volume.png';
  }

  setBrightness(level: number): void {
    this.lampLevel = level;
    const img = this.lampBtn.querySelector('img')!;
    img.src = level > 0 ? '/sprites/icon_lamp_on.png' : '/sprites/icon_lamp.png';
  }

  private createBtn(iconSrc: string, alt: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'setting-btn';
    const img = document.createElement('img');
    img.src = iconSrc;
    img.alt = alt;
    img.draggable = false;
    btn.appendChild(img);
    return btn;
  }

  private createSvgBtn(svgHtml: string, _alt: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'setting-btn';
    btn.innerHTML = svgHtml;
    return btn;
  }

  private toggleSlider(
    anchor: HTMLElement,
    label: string,
    initialValue: number,
    onChange: (val: number) => void,
  ): void {
    const existing = anchor.querySelector('.slider-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'slider-popup';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.value = String(initialValue);

    const valueLabel = document.createElement('span');
    valueLabel.className = 'slider-value';
    valueLabel.textContent = `${label}: ${initialValue}`;

    range.addEventListener('input', () => {
      const val = parseInt(range.value, 10);
      valueLabel.textContent = `${label}: ${val}`;
      onChange(val);
    });

    popup.appendChild(range);
    popup.appendChild(valueLabel);
    anchor.style.position = 'relative';
    anchor.appendChild(popup);

    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        popup.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

/** APK-matching emergency stop. The button grows leftward as the user
 *  drags left; on release it snaps (with a 300 ms tween) to either the
 *  resting 65 px width or the full 190 px width depending on drag
 *  distance, and toggles the emergency-stop state at the threshold.
 *
 *  Cross-checked against decompiled `main-h84O7oJU.js` (Vue component
 *  data-v-2551f7f0) — same bounds, same tween length, same activate /
 *  cancel thresholds. */
export class EmergencyStop {
  private static REST_WIDTH = 65;
  private static FULL_WIDTH = 190;
  private static SWIPE_THRESHOLD = 30;
  private static TWEEN_MS = 300;

  private container: HTMLElement;
  private arrowEl: HTMLElement;
  private dragArea: HTMLElement;
  private activated = false;
  private animating = false;
  private startX = 0;
  /** Pixels currently rendered (live during drag, snaps on release). */
  private currentWidth: number = EmergencyStop.REST_WIDTH;
  /** Width to snap back to after a partial drag (REST_WIDTH or FULL_WIDTH). */
  private restWidth: number = EmergencyStop.REST_WIDTH;
  private animFrame: number | null = null;

  constructor(parent: HTMLElement, private onStop: (active: boolean) => void) {
    this.container = document.createElement('div');
    this.container.className = 'emergency-stop';
    this.container.style.width = `${EmergencyStop.REST_WIDTH}px`;

    this.arrowEl = document.createElement('span');
    this.arrowEl.className = 'estop-arrow';
    this.arrowEl.innerHTML = '&#x00AB;'; // « double left arrow

    const label = document.createElement('span');
    label.className = 'estop-label';
    label.textContent = 'STOP';

    this.container.appendChild(this.arrowEl);
    this.container.appendChild(label);

    // Invisible drag overlay (APK: operation_bar 120% width, 180% height).
    this.dragArea = document.createElement('div');
    this.dragArea.className = 'estop-drag-area';
    this.container.appendChild(this.dragArea);

    this.dragArea.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.dragArea.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.dragArea.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.dragArea.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    parent.appendChild(this.container);
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.animating) return;
    this.startX = e.clientX;
    this.dragArea.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.animating || !this.dragArea.hasPointerCapture(e.pointerId)) return;
    // Left drag (dx < 0) grows the width, right drag shrinks it. The
    // right edge stays anchored — only the left edge moves.
    const dx = e.clientX - this.startX;
    this.setWidth(EmergencyStop.clamp(this.restWidth - dx));
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.animating) return;
    this.dragArea.releasePointerCapture(e.pointerId);
    const { REST_WIDTH, FULL_WIDTH, SWIPE_THRESHOLD } = EmergencyStop;
    const dx = e.clientX - this.startX; // positive = dragged right
    this.setWidth(EmergencyStop.clamp(this.currentWidth));

    if (dx < -SWIPE_THRESHOLD) {
      // Past the activation threshold — go full and flip on.
      if (this.currentWidth < FULL_WIDTH) {
        this.tween(this.currentWidth, FULL_WIDTH, () => {
          this.restWidth = FULL_WIDTH;
          this.setActivated(true);
        });
      } else {
        this.setActivated(true);
      }
    } else if (dx < 0) {
      // Pulled left but not far enough — snap back to rest (REST_WIDTH).
      if (this.currentWidth >= FULL_WIDTH) return;
      this.tween(this.currentWidth, REST_WIDTH, () => {
        this.restWidth = REST_WIDTH;
      });
    } else if (dx > SWIPE_THRESHOLD) {
      // Past the cancel threshold — shrink to rest and flip off.
      if (this.currentWidth > REST_WIDTH) {
        this.tween(this.currentWidth, REST_WIDTH, () => {
          this.restWidth = REST_WIDTH;
          this.setActivated(false);
        });
      } else {
        this.setActivated(false);
      }
    } else if (dx > 0) {
      // Pulled right but not far enough — snap back to full (FULL_WIDTH).
      if (this.currentWidth <= REST_WIDTH) return;
      this.tween(this.currentWidth, FULL_WIDTH, () => {
        this.restWidth = FULL_WIDTH;
      });
    }
  }

  private setWidth(w: number): void {
    this.currentWidth = w;
    this.container.style.width = `${w}px`;
  }

  private tween(from: number, to: number, onComplete: () => void): void {
    if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
    this.animating = true;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / EmergencyStop.TWEEN_MS);
      this.setWidth(from + (to - from) * t);
      if (t < 1) {
        this.animFrame = requestAnimationFrame(step);
      } else {
        this.animFrame = null;
        this.animating = false;
        onComplete();
      }
    };
    this.animFrame = requestAnimationFrame(step);
  }

  private setActivated(on: boolean): void {
    if (this.activated === on) return;
    this.activated = on;
    this.container.classList.toggle('animation', on);
    this.arrowEl.classList.toggle('active', on);
    this.onStop(on);
  }

  private static clamp(w: number): number {
    if (w < EmergencyStop.REST_WIDTH) return EmergencyStop.REST_WIDTH;
    if (w > EmergencyStop.FULL_WIDTH) return EmergencyStop.FULL_WIDTH;
    return w;
  }
}
