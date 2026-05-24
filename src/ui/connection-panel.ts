import type { ConnectionMode, ConnectionConfig } from '../types';
import { MODE_LABELS, DEFAULT_AP_IP } from '../connection/modes';
import { scanForRobots, type ScanResult } from '../connection/network-scan';
import { cloudApi, FAMILY_LABEL, type RobotDevice } from '../api/unitree-cloud';
import { buildCloudPrefsRow } from './components/cloud-prefs';

export type ConnectHandler = (config: ConnectionConfig) => void;

/**
 * Connection panel — Local / AP / Remote chooser.
 * Login lives in the Account Manager; this panel only consumes the cached
 * cloudApi session. Remote mode is disabled when logged out (the option
 * label hints to log in via the Account Manager).
 */
export class ConnectionPanel {
  private container: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private ipInput!: HTMLInputElement;
  private connectBtn!: HTMLButtonElement;
  private detectBtn!: HTMLButtonElement;
  private scanBtn!: HTMLButtonElement;
  private scanSnInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private robotPickerGroup!: HTMLElement;
  private robotSelect!: HTMLSelectElement;
  private remoteHintEl!: HTMLElement;
  private selectedSn = '';
  private devices: RobotDevice[] = [];
  private onConnect: ConnectHandler;
  private onBack: () => void;
  private onAccountManager: () => void;
  private onFamilyChange: (() => void) | null;
  private authUnsub: () => void;

  constructor(
    parent: HTMLElement,
    onConnect: ConnectHandler,
    onBack: () => void,
    onAccountManager: () => void,
    onFamilyChange?: () => void,
  ) {
    this.container = document.createElement('div');
    this.container.className = 'connection-panel';
    this.onConnect = onConnect;
    this.onBack = onBack;
    this.onAccountManager = onAccountManager;
    this.onFamilyChange = onFamilyChange ?? null;
    this.build();
    parent.appendChild(this.container);

    // Re-render on login/logout so the Remote option flips between disabled
    // and "show robot picker".
    this.authUnsub = cloudApi.onAuthChange(() => {
      this.refreshDevicesForRemote();
      this.updateVisibility();
    });
  }

  destroy(): void {
    this.authUnsub();
    this.container.remove();
  }

  private build(): void {
    this.container.innerHTML = `
      <div class="conn-back-row">
        <button id="conn-back-btn" class="conn-back-link" type="button">
          <svg class="conn-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Main page</span>
        </button>
      </div>
      <h2 class="conn-title">Connect to <span id="conn-family-label"></span></h2>
      <div id="conn-prefs-slot"></div>
      <div class="form-group">
        <label for="mode-select">Connection Mode</label>
        <select id="mode-select"></select>
        <div id="remote-hint" class="conn-remote-hint" style="display:none;"></div>
      </div>
      <div class="form-group" id="ip-group">
        <div id="scan-sn-row" style="margin-bottom:10px;display:none;">
          <label for="scan-sn-input">Robot SN</label>
          <input type="text" id="scan-sn-input" placeholder="e.g. B42D2000OBIB1F" autocomplete="off" spellcheck="false" />
        </div>
        <label for="ip-input">Robot IP Address</label>
        <div class="ip-row">
          <input type="text" id="ip-input" placeholder="192.168.12.1" />
          <button id="detect-btn" class="btn-scan" title="Auto-detect robot IP from network gateway (use in AP mode)">Detect</button>
          <button id="scan-btn" class="btn-scan" title="Scan network (broadcast + per-SN sweep for known devices)">Scan</button>
        </div>
        <div id="scan-results" class="scan-results" style="display:none;"></div>
      </div>
      <div class="form-group" id="robot-picker-group" style="display:none">
        <label>Choose Robot</label>
        <select id="robot-select"><option value="">-- Select robot --</option></select>
      </div>
      <button id="connect-btn" class="btn-connect">Connect</button>
      <div id="connection-status" class="status"></div>
    `;

    this.modeSelect = this.container.querySelector('#mode-select')!;
    this.ipInput = this.container.querySelector('#ip-input')!;
    this.connectBtn = this.container.querySelector('#connect-btn')!;
    this.detectBtn = this.container.querySelector('#detect-btn')!;
    this.scanBtn = this.container.querySelector('#scan-btn')!;
    this.scanSnInput = this.container.querySelector('#scan-sn-input')!;
    this.scanSnInput.addEventListener('input', () => {
      // Persist last SN per family so reopening Connect remembers it.
      const fam = cloudApi.connectFamily;
      try { localStorage.setItem(`unitree_last_sn_${fam.toLowerCase()}`, this.scanSnInput.value.trim()); } catch { /* ignore */ }
    });
    this.statusEl = this.container.querySelector('#connection-status')!;
    this.robotPickerGroup = this.container.querySelector('#robot-picker-group')!;
    this.robotSelect = this.container.querySelector('#robot-select')!;
    this.remoteHintEl = this.container.querySelector('#remote-hint')!;
    const backBtn = this.container.querySelector('#conn-back-btn') as HTMLButtonElement;
    backBtn.addEventListener('click', () => this.onBack());

    for (const [mode, label] of Object.entries(MODE_LABELS)) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }

    // Cloud preferences row — Connect screen picks the *connect* family
    // (independent of the account family used to sign cloud requests).
    // Re-render the heading on change so "Connect to <family>" stays in
    // sync with the picker.
    const familyLabel = this.container.querySelector('#conn-family-label') as HTMLElement;
    const onPrefChange = (): void => {
      familyLabel.textContent = FAMILY_LABEL[cloudApi.connectFamily];
      this.onFamilyChange?.();
      // Restore the last IP + SN typed for *this* family. Each is
      // family-namespaced so a switch (e.g. G1 → Go2) doesn't carry
      // the previous family's IP into the field — that used to
      // silently connect to the wrong robot.
      const fam = cloudApi.connectFamily.toLowerCase();
      try {
        this.ipInput.value = localStorage.getItem(`unitree_last_ip_${fam}`) || '';
      } catch { /* ignore */ }
      try {
        this.scanSnInput.value = localStorage.getItem(`unitree_last_sn_${fam}`) || '';
      } catch { /* ignore */ }
      // Re-evaluate so the G1-only SN row appears/hides as the
      // user toggles the Family pill.
      this.updateVisibility();
    };
    onPrefChange();
    const prefsSlot = this.container.querySelector('#conn-prefs-slot') as HTMLElement;
    // Region lives on the Account Manager login screen — Connect only needs
    // the family switch (Go2 / G1) since it picks the visual label and the
    // local-network scan filter.
    prefsSlot.replaceWith(buildCloudPrefsRow({
      showRegion: false,
      getFamily: () => cloudApi.connectFamily,
      setFamily: (f) => cloudApi.setConnectFamily(f),
      onChange: onPrefChange,
    }));

    this.modeSelect.addEventListener('change', () => {
      // Block selecting Remote while logged out — bounce back to STA-L.
      if (this.modeSelect.value === 'STA-T' && !cloudApi.isLoggedIn) {
        this.modeSelect.value = 'STA-L';
      }
      this.updateVisibility();
    });
    this.connectBtn.addEventListener('click', () => this.handleConnect());

    // Enter key triggers connect
    const handleEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); this.handleConnect(); } };
    this.container.addEventListener('keydown', handleEnter);
    this.detectBtn.addEventListener('click', () => this.handleDetect());
    this.scanBtn.addEventListener('click', () => this.handleScan());
    this.robotSelect.addEventListener('change', () => {
      this.selectedSn = this.robotSelect.value;
    });

    this.modeSelect.value = 'STA-L';

    // Family pill onChange already populated the IP for the active
    // family (see onPrefChange below). No legacy unitree_last_ip read
    // here — that was shared across families and led to connecting to
    // the wrong robot on family switch.

    // Pre-populate the robot picker if the user is already logged in
    // (e.g. from auto-login at app start).
    this.refreshDevicesForRemote();
    this.updateVisibility();
  }

  private updateVisibility(): void {
    const mode = this.modeSelect.value as ConnectionMode;
    const isRemote = mode === 'STA-T';
    const ipGroup = this.container.querySelector('#ip-group') as HTMLElement;

    // Remote option label flips based on auth state. The <option> stays
    // selectable so users can see the entry, but the change handler bounces
    // the selection back to STA-L when they're logged out.
    const remoteOpt = Array.from(this.modeSelect.options).find(o => o.value === 'STA-T');
    if (remoteOpt) {
      if (cloudApi.isLoggedIn) {
        remoteOpt.textContent = MODE_LABELS['STA-T'];
        remoteOpt.disabled = false;
      } else {
        remoteOpt.textContent = `${MODE_LABELS['STA-T']} (log in via Account Manager)`;
        remoteOpt.disabled = true;
      }
    }

    ipGroup.style.display = isRemote ? 'none' : '';
    // SN-targeted scan only matters for G1 — Go2 firmware doesn't gate
    // multicast replies on the SN field, so the regular Scan button
    // is sufficient there.
    const snRow = this.container.querySelector('#scan-sn-row') as HTMLElement | null;
    if (snRow) snRow.style.display = (!isRemote && cloudApi.connectFamily === 'G1') ? '' : 'none';
    this.robotPickerGroup.style.display = isRemote && cloudApi.isLoggedIn && this.devices.length > 1 ? '' : 'none';

    // Inline hint under the mode selector covers the remaining cases:
    // logged-in single-robot ("ready"), logged-in zero-robots ("bind one"),
    // logged-out ("login required").
    if (isRemote) {
      if (!cloudApi.isLoggedIn) {
        this.remoteHintEl.textContent = 'Login required — open Account Manager';
        this.remoteHintEl.style.display = '';
      } else if (this.devices.length === 0) {
        this.remoteHintEl.innerHTML = 'No robots bound to this account. <a href="#" id="open-acct-link">Open Account Manager</a> to bind one.';
        this.remoteHintEl.style.display = '';
        const link = this.remoteHintEl.querySelector('#open-acct-link') as HTMLAnchorElement | null;
        link?.addEventListener('click', (e) => { e.preventDefault(); this.onAccountManager(); });
      } else if (this.devices.length === 1) {
        const d = this.devices[0];
        this.remoteHintEl.textContent = `Robot: ${d.alias || d.sn}`;
        this.remoteHintEl.style.display = '';
        this.selectedSn = d.sn;
      } else {
        this.remoteHintEl.style.display = 'none';
      }
    } else {
      this.remoteHintEl.style.display = 'none';
    }

    if (mode === 'AP') {
      if (!this.ipInput.value || this.ipInput.value === DEFAULT_AP_IP) {
        this.ipInput.value = DEFAULT_AP_IP;
      }
      this.ipInput.readOnly = false;
      this.ipInput.placeholder = 'Robot IP (e.g. 192.168.123.161)';
    } else {
      this.ipInput.readOnly = false;
      if (this.ipInput.value === DEFAULT_AP_IP && mode === 'STA-L') {
        this.ipInput.value = '';
        this.ipInput.placeholder = 'Robot IP on local network';
      }
    }
  }

  /** Fetch the device list when logged in and rebuild the picker.
   *  Called on construct and on login state changes. */
  private refreshDevicesForRemote(): void {
    if (!cloudApi.isLoggedIn) {
      this.devices = [];
      this.populateRobotSelect();
      return;
    }
    void cloudApi.listDevices().then((devices) => {
      this.devices = devices;
      this.populateRobotSelect();
      this.updateVisibility();
    }).catch(() => { /* leave devices as-is on error */ });
  }

  private populateRobotSelect(): void {
    this.robotSelect.innerHTML = '<option value="">-- Select robot --</option>';
    for (const d of this.devices) {
      const opt = document.createElement('option');
      opt.value = d.sn;
      opt.textContent = `${d.alias || d.sn} — ${d.series} [${d.sn}]`;
      this.robotSelect.appendChild(opt);
    }
    if (this.devices.length === 1) {
      this.robotSelect.value = this.devices[0].sn;
      this.selectedSn = this.devices[0].sn;
    }
  }

  private handleConnect(): void {
    const mode = this.modeSelect.value as ConnectionMode;

    if (mode === 'STA-T') {
      if (!cloudApi.isLoggedIn) {
        this.setStatus('Login required — open Account Manager', 'error');
        return;
      }
      const sn = this.selectedSn || this.robotSelect.value || (this.devices.length === 1 ? this.devices[0].sn : '');
      if (!sn) {
        this.setStatus('Please select a robot', 'error');
        return;
      }
      this.onConnect({
        mode,
        ip: '',
        token: cloudApi.accessToken,
        serialNumber: sn,
        email: '',
        password: '',
      });
    } else {
      const ip = this.ipInput.value.trim();
      // Persist the IP for next launch — only for Local modes; AP mode's
      // 192.168.12.1 is hardcoded so storing it is harmless but the
      // STA-L IP is the value that actually changes per network.
      // Family-namespaced so switching G1 ↔ Go2 doesn't carry over a
      // foreign IP and silently target the wrong robot.
      if (ip) try { localStorage.setItem(`unitree_last_ip_${cloudApi.connectFamily.toLowerCase()}`, ip); } catch { /* ignore */ }
      // Thread the SN through so the local connector can look up the
      // cached AES-128 key on the data2=3 path (G1 ≥ 1.5.1). Sources,
      // in order: typed value → first cloud-bound device of this family
      // → empty (connector will fall back to promptKey).
      const typedSn = this.scanSnInput.value.trim();
      const familyDevs = this.devices.filter((d) => d.series === cloudApi.connectFamily);
      const sn = typedSn || (familyDevs.length === 1 ? familyDevs[0].sn : '');
      this.onConnect({
        mode,
        ip,
        token: '',
        serialNumber: sn,
        email: '',
        password: '',
      });
    }
  }

  private async handleDetect(): Promise<void> {
    this.detectBtn.disabled = true;
    this.detectBtn.textContent = '...';
    try {
      const resp = await fetch('/gateway', { signal: AbortSignal.timeout(4000) });
      const data = await resp.json() as { gateway: string | null };
      if (data.gateway) {
        this.ipInput.value = data.gateway;
        this.setStatus(`Detected gateway: ${data.gateway}`, 'success');
      } else {
        this.setStatus('Could not detect gateway — enter IP manually', 'error');
      }
    } catch {
      this.setStatus('Detect failed — enter IP manually', 'error');
    } finally {
      this.detectBtn.disabled = false;
      this.detectBtn.textContent = 'Detect';
    }
  }

  /** Single Scan: fires an unfiltered broadcast first (works on Go2 +
   *  G1 < 1.5.1), then a targeted query for every SN we know about
   *  (cloud-bound devices + the SN typed in the optional G1 SN field),
   *  since G1 firmware ≥ 1.5.1 silently ignores untargeted queries.
   *  Results from all branches are deduped by SN. */
  private async handleScan(): Promise<void> {
    this.scanBtn.disabled = true;
    this.scanBtn.textContent = '...';
    this.setStatus('Scanning network...', 'info');
    this.renderScanResults([]);  // clear stale list

    // Build the SN target set: bound-device SNs + the user's typed SN.
    const targetSns = new Set<string>();
    for (const d of this.devices) {
      if (d.sn) targetSns.add(d.sn);
    }
    const typedSn = this.scanSnInput.value.trim();
    if (typedSn) targetSns.add(typedSn);

    try {
      // Fire the broadcast and every per-SN scan in parallel; aggregate
      // and dedupe by SN. Each branch swallows its own errors so a
      // single network blip doesn't sink the whole run.
      const branches: Array<Promise<ScanResult[]>> = [
        scanForRobots(cloudApi.connectFamily, (msg) => this.setStatus(msg, 'info')),
        ...Array.from(targetSns).map((sn) =>
          scanForRobots(cloudApi.connectFamily, undefined, sn).catch(() => [] as ScanResult[]),
        ),
      ];
      const seen = new Map<string, ScanResult>();
      const all = await Promise.all(branches);
      for (const batch of all) {
        for (const r of batch) {
          if (r.sn && !seen.has(r.sn)) seen.set(r.sn, r);
        }
      }
      const results = Array.from(seen.values());
      if (results.length === 0) {
        this.setStatus('No robots found on network', 'error');
        return;
      }
      // Single hit: populate IP + SN, no list needed.
      if (results.length === 1) {
        const only = results[0];
        this.ipInput.value = only.ip;
        this.setSnInputAndPersist(only.sn || '');
        if (only.ip !== DEFAULT_AP_IP) {
          this.modeSelect.value = 'STA-L';
          this.updateVisibility();
        }
        this.setStatus(`Found robot at ${only.ip} (SN: ${only.sn || 'unknown'})`, 'success');
        return;
      }
      // Multiple hits: show the list and let the user click one.
      this.modeSelect.value = 'STA-L';
      this.updateVisibility();
      this.setStatus(`Found ${results.length} robots — pick one`, 'success');
      this.renderScanResults(results);
    } catch (err) {
      this.setStatus('Scan failed: ' + (err instanceof Error ? err.message : 'unknown'), 'error');
    } finally {
      this.scanBtn.disabled = false;
      this.scanBtn.textContent = 'Scan';
    }
  }

  /** Render the scan-results dropdown. Empty array hides it. The list
   *  caps at ~4 rows tall and scrolls beyond — taller lists keep the
   *  rest of the connection panel from getting pushed off-screen. */
  private renderScanResults(results: ScanResult[]): void {
    const slot = this.container.querySelector('#scan-results') as HTMLElement;
    if (!slot) return;
    slot.innerHTML = '';
    if (results.length === 0) {
      slot.style.display = 'none';
      return;
    }
    slot.style.display = '';
    for (const r of results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scan-result-row';
      row.innerHTML = `<span class="scan-result-ip">${r.ip}</span><span class="scan-result-sn">${r.sn || 'unknown'}</span>`;
      row.addEventListener('click', () => {
        this.ipInput.value = r.ip;
        this.setSnInputAndPersist(r.sn || '');
        this.setStatus(`Selected ${r.ip} (SN: ${r.sn || 'unknown'})`, 'success');
        this.renderScanResults([]);
      });
      slot.appendChild(row);
    }
  }

  setStatus(text: string, type: 'info' | 'success' | 'error' = 'info'): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `status status-${type}`;
  }

  /** Update the SN input + persist as the last-used SN for the current
   *  family — same effect as the user typing into the field by hand
   *  (which also persists via the input listener). */
  private setSnInputAndPersist(sn: string): void {
    this.scanSnInput.value = sn;
    if (!sn) return;
    try {
      localStorage.setItem(`unitree_last_sn_${cloudApi.connectFamily.toLowerCase()}`, sn);
    } catch { /* ignore */ }
  }

  setConnecting(connecting: boolean): void {
    this.connectBtn.disabled = connecting;
    this.connectBtn.textContent = connecting ? 'Connecting...' : 'Connect';
  }

  setConnected(connected: boolean): void {
    this.connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
    this.connectBtn.disabled = false;
  }
}
