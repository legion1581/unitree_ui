/**
 * Account Manager page — 4 tabs: Devices, Info, Account, Debug
 */

import { cloudApi, getLastResponseMeta, ACCOUNT_FAMILY_LABEL, type RobotDevice, type UserInfo, type FirmwareInfo, type TutorialGroup, type ChangelogEntry, type AppVersionInfo } from '../../api/unitree-cloud';
import { setCachedAesKey, clearCachedAesKey, rsaEncryptSn } from '../../api/aes-key-derive';
import { buildCloudPrefsRow } from './cloud-prefs';
import { makeCopyButton } from './copy-button';
import { OtaController, type Family as OtaFamily, type OtaState } from '../../api/ota-controller';

type Tab = 'devices' | 'info' | 'account' | 'debug';

export class AccountPage {
  private container: HTMLElement;
  private content: HTMLElement;
  private header!: HTMLElement;
  private tabBar!: HTMLElement;
  private currentTab: Tab = 'devices';
  private tabButtons: Map<Tab, HTMLElement> = new Map();
  /** Live-ticking "Refreshed Xs ago" label next to the access token.
   *  Updated by a 1-second interval while this page is mounted. */
  private refreshAgeEl: HTMLElement | null = null;
  private refreshAgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(parent: HTMLElement, private onBack: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'status-page acct-page';

    // Header — hidden on the logged-out screen (the modal there has its own
    // inline back button so the layout matches the Connect screen).
    this.header = document.createElement('div');
    this.header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', onBack);
    this.header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = 'Account Manager';
    this.header.appendChild(title);
    this.container.appendChild(this.header);

    // Tab bar — hidden when logged out (the login screen is the only thing
    // that makes sense before auth, and the tabs would just bounce back to
    // it via switchTab).
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'acct-tab-bar';
    const tabLabels: Record<Tab, string> = { devices: 'Devices', info: 'Info', account: 'Account', debug: 'Debug' };
    for (const [tab, label] of Object.entries(tabLabels) as [Tab, string][]) {
      const btn = document.createElement('button');
      btn.className = 'acct-tab-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => this.switchTab(tab));
      this.tabBar.appendChild(btn);
      this.tabButtons.set(tab, btn);
    }
    this.container.appendChild(this.tabBar);

    this.content = document.createElement('div');
    this.content.className = 'page-content';
    this.container.appendChild(this.content);
    parent.appendChild(this.container);

    if (!cloudApi.isLoggedIn) cloudApi.loadSession();
    if (cloudApi.isLoggedIn) this.switchTab('devices');
    else this.renderLoggedOutScreen();
  }

  private switchTab(tab: Tab): void {
    if (!cloudApi.isLoggedIn) { this.renderLoggedOutScreen(); return; }
    this.header.style.display = '';
    this.tabBar.style.display = '';
    this.currentTab = tab;
    this.tabButtons.forEach((btn, t) => btn.classList.toggle('active', t === tab));
    this.content.innerHTML = '';
    this.content.classList.remove('acct-loggedout-content');
    this.content.scrollTop = 0;

    if (tab === 'account') { this.renderAccountTab(); return; }
    if (tab === 'devices') this.renderDevicesTab();
    else if (tab === 'info') this.renderInfoTab();
    else if (tab === 'debug') this.renderDebugTab();
  }

  /** Logged-out view: render a modal that visually mirrors the Connect
   *  screen — same `.connection-modal` shell, same inline `.conn-header`
   *  back-button + title, same `.form-group` / `.btn-connect` elements.
   *  The page-level header and tab bar are hidden so the back button only
   *  appears in one place. */
  private renderLoggedOutScreen(): void {
    this.header.style.display = 'none';
    this.tabBar.style.display = 'none';
    this.tabButtons.forEach((btn) => btn.classList.remove('active'));
    this.content.innerHTML = '';
    this.content.scrollTop = 0;
    this.content.classList.add('acct-loggedout-content');

    const modal = document.createElement('div');
    modal.className = 'connection-modal';

    const panel = document.createElement('div');
    panel.className = 'connection-panel';

    panel.innerHTML = `
      <div class="conn-back-row">
        <button id="acct-login-back" class="conn-back-link" type="button">
          <svg class="conn-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Main page</span>
        </button>
      </div>
      <h2 class="conn-title">Login</h2>
      <div id="acct-login-prefs"></div>
      <div class="form-group">
        <div class="auth-toggle-row">
          <button class="auth-tab active" type="button" data-auth="credentials">Email / Password</button>
          <button class="auth-tab" type="button" data-auth="token">Token</button>
        </div>
      </div>
      <div id="acct-credentials-pane">
        <div class="form-group">
          <label for="acct-login-email">Email</label>
          <input type="email" id="acct-login-email" placeholder="Unitree account email" autocomplete="username" />
        </div>
        <div class="form-group">
          <label for="acct-login-pwd">Password</label>
          <input type="password" id="acct-login-pwd" placeholder="Account password" autocomplete="current-password" />
        </div>
      </div>
      <div id="acct-token-pane" style="display:none;">
        <div class="form-group">
          <label for="acct-login-token">Access Token</label>
          <input type="text" id="acct-login-token" placeholder="Paste access token" />
        </div>
      </div>
      <button id="acct-login-btn" class="btn-connect" type="button">Login</button>
      <div id="acct-login-status" class="status"></div>
      <div class="acct-create-row">
        Don't have an account?
        <button id="acct-create-link" class="acct-link-btn" type="button">Create Account</button>
      </div>
    `;

    // Family + Region pills. Family drives the AppName the cloud API signs
    // its requests with (Go2 vs G1 use different app identities); Region
    // (Global / CN) picks which Unitree endpoint to hit. Both must be set
    // before login so the request fires against the right backend.
    const prefsSlot = panel.querySelector('#acct-login-prefs') as HTMLElement;
    prefsSlot.replaceWith(buildCloudPrefsRow({ showFamily: true, showRegion: true, familyLabel: (f) => ACCOUNT_FAMILY_LABEL[f] }));

    const back = panel.querySelector('#acct-login-back') as HTMLButtonElement;
    back.addEventListener('click', () => this.onBack());

    const emailEl = panel.querySelector('#acct-login-email') as HTMLInputElement;
    const pwdEl = panel.querySelector('#acct-login-pwd') as HTMLInputElement;
    const tokEl = panel.querySelector('#acct-login-token') as HTMLInputElement;
    const loginBtn = panel.querySelector('#acct-login-btn') as HTMLButtonElement;
    const credentialsPane = panel.querySelector('#acct-credentials-pane') as HTMLElement;
    const tokenPane = panel.querySelector('#acct-token-pane') as HTMLElement;
    const tabs = panel.querySelectorAll('.auth-tab');
    const statusEl = panel.querySelector('#acct-login-status') as HTMLElement;
    const setStatus = (text: string, type: 'info' | 'success' | 'error' = 'info'): void => {
      statusEl.textContent = text;
      statusEl.className = `status status-${type}`;
    };

    let useToken = false;
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        useToken = (tab as HTMLElement).dataset.auth === 'token';
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        credentialsPane.style.display = useToken ? 'none' : '';
        tokenPane.style.display = useToken ? '' : 'none';
        setStatus('', 'info');
      });
    });

    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled = true;
      const orig = loginBtn.textContent;
      loginBtn.textContent = 'Logging in...';
      setStatus('', 'info');
      try {
        if (useToken) {
          const t = tokEl.value.trim();
          if (!t) throw new Error('Paste an access token');
          cloudApi.setAccessToken(t);
          cloudApi.saveSession();
        } else {
          const email = emailEl.value.trim();
          const pwd = pwdEl.value;
          if (!email || !pwd) throw new Error('Enter email and password');
          await cloudApi.loginEmail(email, pwd);
        }
        this.switchTab('devices');
      } catch (e) {
        setStatus(`Login failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = orig || 'Login';
      }
    });

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loginBtn.click(); }
    });

    const createLink = panel.querySelector('#acct-create-link') as HTMLButtonElement;
    createLink.addEventListener('click', () => this.renderRegisterScreen());

    modal.appendChild(panel);
    this.content.appendChild(modal);
  }

  /** Email-registration screen — same modal shell as the login view, with
   *  an SVG image-captcha. Mirrors the official APK flow:
   *    1. GET /captcha → ImageCodeBean { code, svg } (issued on mount, and
   *       re-fetched whenever the user clicks the puzzle to refresh).
   *    2. POST /register/email with email+password+code+captcha+blank
   *       company fields. Server returns access+refresh token, so the
   *       user is logged in immediately on success. */
  private renderRegisterScreen(): void {
    this.header.style.display = 'none';
    this.tabBar.style.display = 'none';
    this.tabButtons.forEach((btn) => btn.classList.remove('active'));
    this.content.innerHTML = '';
    this.content.scrollTop = 0;
    this.content.classList.add('acct-loggedout-content');

    const modal = document.createElement('div');
    modal.className = 'connection-modal';
    const panel = document.createElement('div');
    panel.className = 'connection-panel';

    panel.innerHTML = `
      <div class="conn-back-row">
        <button id="acct-reg-back" class="conn-back-link" type="button">
          <svg class="conn-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Back to Login</span>
        </button>
      </div>
      <h2 class="conn-title">Create Account</h2>
      <div id="acct-reg-prefs"></div>
      <div class="form-group">
        <label for="acct-reg-email">Email</label>
        <input type="email" id="acct-reg-email" placeholder="you@example.com" autocomplete="username" />
      </div>
      <div class="form-group">
        <label for="acct-reg-pwd">Password</label>
        <input type="password" id="acct-reg-pwd" placeholder="At least 8 characters" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label for="acct-reg-captcha">Captcha</label>
        <div class="acct-captcha-row">
          <div id="acct-reg-captcha-img" class="acct-captcha-img" title="Click to refresh"></div>
          <input type="text" id="acct-reg-captcha" placeholder="4 chars" maxlength="4" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <button id="acct-reg-btn" class="btn-connect" type="button">Create Account</button>
      <div id="acct-reg-status" class="status"></div>
    `;

    // Region matters for which Unitree backend the registration hits;
    // family controls the AppName the request signs as. Same picker as
    // the login screen.
    const prefsSlot = panel.querySelector('#acct-reg-prefs') as HTMLElement;
    prefsSlot.replaceWith(buildCloudPrefsRow({ showFamily: true, showRegion: true, familyLabel: (f) => ACCOUNT_FAMILY_LABEL[f] }));

    const back = panel.querySelector('#acct-reg-back') as HTMLButtonElement;
    back.addEventListener('click', () => this.renderLoggedOutScreen());

    const emailEl = panel.querySelector('#acct-reg-email') as HTMLInputElement;
    const pwdEl = panel.querySelector('#acct-reg-pwd') as HTMLInputElement;
    const captchaEl = panel.querySelector('#acct-reg-captcha') as HTMLInputElement;
    const captchaImg = panel.querySelector('#acct-reg-captcha-img') as HTMLElement;
    const regBtn = panel.querySelector('#acct-reg-btn') as HTMLButtonElement;
    const statusEl = panel.querySelector('#acct-reg-status') as HTMLElement;
    const setStatus = (text: string, type: 'info' | 'success' | 'error' = 'info'): void => {
      statusEl.textContent = text;
      statusEl.className = `status status-${type}`;
    };

    // Captcha session id from the most recent /captcha call. Sent as
    // `code` on register; cleared after a successful register so it
    // can't be reused.
    let captchaCode = '';
    const refreshCaptcha = async (): Promise<void> => {
      captchaImg.innerHTML = '<span style="font-size:11px;color:#888;">Loading…</span>';
      try {
        const { code, svg } = await cloudApi.getImageCaptcha();
        captchaCode = code;
        // The SVG is raw markup; injecting via innerHTML lets it inherit
        // the container's sizing. Same approach the APK uses (loads the
        // SVG into a WebView).
        captchaImg.innerHTML = svg;
      } catch (e) {
        captchaCode = '';
        captchaImg.innerHTML = '<span style="font-size:11px;color:#e57373;">Failed</span>';
        setStatus(`Captcha failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    };
    captchaImg.addEventListener('click', () => { void refreshCaptcha(); });
    void refreshCaptcha();

    regBtn.addEventListener('click', async () => {
      const email = emailEl.value.trim();
      const pwd = pwdEl.value;
      const solution = captchaEl.value.trim();
      // Same pre-submit checks the APK fragment runs (length-based, no
      // regex on the email format — the server is the source of truth).
      if (email.length < 3) { setStatus('Enter a valid email', 'error'); return; }
      if (pwd.length < 8) { setStatus('Password must be at least 8 characters', 'error'); return; }
      if (solution.length !== 4) { setStatus('Captcha must be 4 characters', 'error'); return; }
      if (!captchaCode) { setStatus('Refresh the captcha and try again', 'error'); return; }

      regBtn.disabled = true;
      const orig = regBtn.textContent;
      regBtn.textContent = 'Creating account…';
      setStatus('', 'info');
      try {
        await cloudApi.registerEmail(email, pwd, captchaCode, solution);
        // registerEmail saves the session + emits onAuthChange; switch
        // straight to the devices tab (the user is now logged in).
        this.switchTab('devices');
      } catch (e) {
        setStatus(`Registration failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        // Server consumed the captcha session on failure (the APK does
        // the same — it auto-refreshes after every failed register).
        captchaEl.value = '';
        void refreshCaptcha();
      } finally {
        regBtn.disabled = false;
        regBtn.textContent = orig || 'Create Account';
      }
    });

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); regBtn.click(); }
    });

    modal.appendChild(panel);
    this.content.appendChild(modal);
  }

  // ════════════════════════════════════════════════════════════════════
  // ACCOUNT TAB (rich)
  // ════════════════════════════════════════════════════════════════════

  private renderAccountTab(): void {
    if (!cloudApi.isLoggedIn) { this.renderLoginForm(); return; }

    // User profile card
    const profile = this.section('Profile');
    if (cloudApi.user) {
      const u = cloudApi.user;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:12px;';
      row.appendChild(this.createAvatarImg(u.avatar, 56, u.nickname || u.email || '?', true));
      const info = document.createElement('div');
      info.innerHTML = `<div style="font-size:16px;font-weight:600;">${this.esc(u.nickname)}</div>
        <div style="font-size:12px;color:#666;">${this.esc(u.email)}</div>
        <div style="font-size:11px;color:#555;">UID: ${this.esc(u.uid)}</div>`;
      row.appendChild(info);
      profile.appendChild(row);
      if (u.mobile) this.infoRow(profile, 'Mobile', u.mobile);
      if (u.roles?.length) this.infoRow(profile, 'Roles', u.roles.join(', '));
    }
    this.content.appendChild(profile);

    // Edit profile
    const edit = this.section('Edit Profile');
    const nickInput = this.input('Nickname', 'text');
    if (cloudApi.user?.nickname) nickInput.input.value = cloudApi.user.nickname;
    edit.appendChild(nickInput.wrapper);
    edit.appendChild(this.button('Save Nickname', async () => {
      try {
        await cloudApi.updateUserInfo({ nickname: nickInput.input.value.trim() });
        await cloudApi.getUserInfo();
        this.switchTab('account');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(edit);

    // Avatar
    const avatarSec = this.section('Update Avatar');
    if (cloudApi.user?.avatar) {
      const preview = document.createElement('div');
      preview.style.cssText = 'margin-bottom:10px;';
      preview.appendChild(this.createAvatarImg(cloudApi.user.avatar, 64, cloudApi.user.nickname || cloudApi.user.email || '?', false));
      const urlText = document.createElement('div');
      urlText.style.cssText = 'font-size:10px;color:#444;margin-top:4px;word-break:break-all;max-width:250px;';
      urlText.textContent = cloudApi.user.avatar;
      preview.appendChild(urlText);
      avatarSec.appendChild(preview);
    }
    const avatarUrlInput = this.input('Avatar URL', 'url');
    avatarUrlInput.input.placeholder = 'https://...';
    avatarSec.appendChild(avatarUrlInput.wrapper);

    // File upload
    const fileLabel = document.createElement('label');
    fileLabel.style.cssText = 'display:block;font-size:11px;color:#666;margin-bottom:3px;';
    fileLabel.textContent = 'Or upload image';
    avatarSec.appendChild(fileLabel);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'acct-input acct-file-input';
    fileInput.style.cssText = 'padding:6px;font-size:12px;margin-bottom:8px;';
    avatarSec.appendChild(fileInput);

    avatarSec.appendChild(this.button('Update Avatar', async () => {
      let url = avatarUrlInput.input.value.trim();

      // If file selected, upload first
      if (!url && fileInput.files?.length) {
        try {
          const file = fileInput.files[0];
          const formData = new FormData();
          formData.append('file', file);

          const headers = Object.fromEntries(
            Object.entries(cloudApi['request'] ? {} : {}).filter(([k]) => k !== 'Content-Type')
          );
          // Use raw fetch with token
          const resp = await fetch('/unitree-api/attachment/upload', {
            method: 'POST',
            headers: { 'Token': cloudApi.accessToken },
            body: formData,
          });
          const json = await resp.json();
          if (json.code === 100 && json.data) {
            url = json.data.url || json.data.path || '';
          } else {
            throw new Error(json.errorMsg || 'Upload failed');
          }
        } catch (e) {
          alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }

      if (!url) { alert('Provide an avatar URL or select a file'); return; }
      try {
        await cloudApi.updateUserInfo({ avatar: url });
        await cloudApi.getUserInfo();
        this.switchTab('account');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(avatarSec);

    // Change password (wrap password inputs in a <form> so Chrome doesn't
    // warn about unassociated password fields; include a hidden username
    // input so a11y + autofill can associate the credential with the user)
    const pw = this.section('Change Password');
    const oldPw = this.input('Current Password', 'password', 'password');
    oldPw.input.autocomplete = 'current-password';
    const newPw = this.input('New Password', 'password', 'password');
    newPw.input.autocomplete = 'new-password';
    const pwForm = document.createElement('form');
    pwForm.autocomplete = 'on';
    pwForm.addEventListener('submit', (e) => e.preventDefault());
    // Hidden username field — satisfies Chrome a11y hint ("Password forms
    // should have (optionally hidden) username fields")
    const hiddenUser = document.createElement('input');
    hiddenUser.type = 'text';
    hiddenUser.autocomplete = 'username';
    hiddenUser.value = cloudApi.user?.email || cloudApi.user?.mobile || '';
    hiddenUser.style.cssText = 'display:none;';
    hiddenUser.setAttribute('aria-hidden', 'true');
    hiddenUser.setAttribute('tabindex', '-1');
    pwForm.appendChild(hiddenUser);
    pwForm.appendChild(oldPw.wrapper);
    pwForm.appendChild(newPw.wrapper);
    pw.appendChild(pwForm);
    pw.appendChild(this.button('Change Password', async () => {
      try {
        await cloudApi.changePassword(oldPw.input.value, newPw.input.value);
        alert('Password changed');
        oldPw.input.value = '';
        newPw.input.value = '';
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(pw);

    // Region
    const region = this.section('Region');
    const regionInput = this.input('Region Code', 'text');
    regionInput.input.placeholder = 'US';
    region.appendChild(regionInput.wrapper);
    region.appendChild(this.button('Set Region', async () => {
      try {
        await cloudApi.post('user/setRegion', { region: regionInput.input.value.trim() });
        alert('Region updated');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(region);

    // Refresh / Logout
    const session = this.section('Session');

    // Access-token row with hover-to-parse info popover. Auto-login keeps the
    // token alive across reloads, so surfacing the parsed claims (exp/iat) is
    // useful for spotting refresh issues without poking around in DevTools.
    if (cloudApi.accessToken) {
      session.appendChild(this.buildTokenRow('Access Token', cloudApi.accessToken));
    }

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'acct-btn acct-btn-danger';
    logoutBtn.style.width = '100%';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', () => { cloudApi.logout(); this.switchTab('account'); });
    session.appendChild(logoutBtn);
    this.content.appendChild(session);

    // ── Danger Zone: permanent account deletion ──
    // POST user/destroy is irreversible and the server offers no
    // confirmation step (see APK LoginApi.deleteUser → no body, no
    // captcha). Gate it behind an inline typed-confirmation panel.
    // Browser confirm()/prompt() are avoided here because some embedded
    // contexts (kiosk shells, certain WebViews) silently block them.
    const danger = this.section('Danger Zone');
    danger.style.borderColor = '#c62828';

    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:12px;color:#e57373;margin-bottom:10px;line-height:1.4;';
    warn.textContent = 'Permanently delete this Unitree account. This cannot be undone — bound robots, devices, and account data are removed server-side.';
    danger.appendChild(warn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'acct-btn acct-btn-danger';
    deleteBtn.style.width = '100%';
    deleteBtn.textContent = 'Delete Account';
    danger.appendChild(deleteBtn);

    // Inline confirm panel — hidden until the user clicks Delete Account.
    // Replaces the previous confirm()/prompt() pair so it works in
    // contexts where browser dialogs are blocked.
    const confirmPanel = document.createElement('div');
    confirmPanel.style.cssText = 'display:none;margin-top:12px;padding:12px;border:1px solid #c62828;border-radius:8px;background:rgba(198,40,40,0.06);';
    danger.appendChild(confirmPanel);

    const deleteStatus = document.createElement('div');
    deleteStatus.style.cssText = 'margin-top:8px;font-size:12px;';
    danger.appendChild(deleteStatus);

    const setStatus = (text: string, color: string): void => {
      deleteStatus.style.color = color;
      deleteStatus.textContent = text;
    };

    const closeConfirm = (): void => {
      confirmPanel.style.display = 'none';
      confirmPanel.innerHTML = '';
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete Account';
    };

    deleteBtn.addEventListener('click', () => {
      const u = cloudApi.user;
      const label = u?.email?.trim() || u?.nickname?.trim() || 'this account';
      // Two-step confirm in DOM: a warning + a typed-match input + Cancel
      // / Confirm Delete buttons. The Confirm button stays disabled until
      // the user types "DELETE" exactly.
      confirmPanel.innerHTML = `
        <div style="font-size:13px;color:#fff;font-weight:600;margin-bottom:6px;">Permanently delete ${this.esc(label)}?</div>
        <div style="font-size:12px;color:#e0e0e0;line-height:1.5;margin-bottom:10px;">
          The account, all bound robots, and any cloud-stored data will be removed and
          <strong>cannot be recovered</strong>.
        </div>
        <label for="acct-del-confirm" style="display:block;font-size:11px;color:#bbb;margin-bottom:4px;">Type <strong>DELETE</strong> (uppercase) to confirm:</label>
        <input type="text" id="acct-del-confirm" class="acct-input" autocomplete="off" spellcheck="false" placeholder="DELETE" style="font-family:monospace;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;" />
        <div style="display:flex;gap:8px;">
          <button id="acct-del-cancel" class="acct-btn" type="button" style="flex:1;background:#2a2d35;color:#ccc;">Cancel</button>
          <button id="acct-del-confirm-btn" class="acct-btn acct-btn-danger" type="button" style="flex:1;" disabled>Confirm Delete</button>
        </div>
      `;
      confirmPanel.style.display = '';
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Confirm below…';
      setStatus('', '');

      const input = confirmPanel.querySelector('#acct-del-confirm') as HTMLInputElement;
      const cancelBtn = confirmPanel.querySelector('#acct-del-cancel') as HTMLButtonElement;
      const confirmBtn = confirmPanel.querySelector('#acct-del-confirm-btn') as HTMLButtonElement;
      input.focus();

      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim() !== 'DELETE';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) { e.preventDefault(); confirmBtn.click(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
      });

      cancelBtn.addEventListener('click', () => {
        closeConfirm();
        setStatus('Cancelled — account not deleted.', '#888');
      });

      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        input.disabled = true;
        confirmBtn.textContent = 'Deleting…';
        setStatus('Deleting account…', '#888');
        try {
          await cloudApi.deleteAccount();
          // Cached devices belong to the now-destroyed account — wipe them too.
          try { localStorage.removeItem('unitree_devices_cache'); } catch { /* ignore */ }
          confirmPanel.style.display = 'none';
          setStatus('Account deleted. Returning to login…', '#66bb6a');
          // switchTab routes to the logged-out screen since cloudApi.isLoggedIn
          // is now false (clearSession already fired onAuthChange).
          setTimeout(() => this.switchTab('account'), 600);
        } catch (e) {
          setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`, '#e57373');
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          input.disabled = false;
          confirmBtn.textContent = 'Confirm Delete';
        }
      });
    });

    this.content.appendChild(danger);
  }

  private renderLoginForm(): void {
    const s = this.section('Login');
    const form = document.createElement('form');
    form.className = 'acct-form';
    form.autocomplete = 'on';
    form.addEventListener('submit', (e) => e.preventDefault());

    const emailInput = this.input('Email', 'email');
    emailInput.input.autocomplete = 'username';
    const pwdInput = this.input('Password', 'password', 'password');
    pwdInput.input.autocomplete = 'current-password';
    form.appendChild(emailInput.wrapper);
    form.appendChild(pwdInput.wrapper);

    const loginBtn = document.createElement('button');
    loginBtn.className = 'acct-btn acct-btn-primary';
    loginBtn.textContent = 'Login';
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Logging in...';
      try {
        await cloudApi.loginEmail(emailInput.input.value, pwdInput.input.value);
        this.switchTab('devices');
      } catch (e) { alert(`Login failed: ${e instanceof Error ? e.message : String(e)}`); }
      finally { loginBtn.disabled = false; loginBtn.textContent = 'Login'; }
    });
    form.appendChild(loginBtn);

    const sep = document.createElement('div');
    sep.style.cssText = 'font-size:11px;color:#555;margin:16px 0 8px;text-align:center;';
    sep.textContent = '— or paste access token —';
    form.appendChild(sep);

    const tokenInput = this.input('Access Token', 'text');
    form.appendChild(tokenInput.wrapper);
    const tokenBtn = document.createElement('button');
    tokenBtn.className = 'acct-btn';
    tokenBtn.style.cssText = 'background:transparent;border:1px solid #2a2d35;color:#888;';
    tokenBtn.textContent = 'Login with Token';
    tokenBtn.addEventListener('click', () => {
      const t = tokenInput.input.value.trim();
      if (!t) return;
      cloudApi.setAccessToken(t);
      cloudApi.saveSession();
      this.switchTab('devices');
    });
    form.appendChild(tokenBtn);

    s.appendChild(form);
    this.content.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════
  // DEVICES TAB (tiles with detail + share)
  // ════════════════════════════════════════════════════════════════════

  private async renderDevicesTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading devices...</div>';
    try {
      const devices = await cloudApi.listDevices();
      // Seed the local AES-key cache from any cloud-stored keys so the
      // data2=3 connect path doesn't have to prompt for SNs that have
      // already been bound (e.g. via the official Unitree app).
      for (const d of devices) {
        if (d.key && d.key.trim()) setCachedAesKey(d.sn, d.key.trim());
      }
      this.content.innerHTML = '';

      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
      const h = document.createElement('div');
      h.style.cssText = 'font-size:15px;font-weight:600;color:#fff;';
      h.textContent = `My Robots (${devices.length})`;
      hdr.appendChild(h);
      const addBtn = document.createElement('button');
      addBtn.className = 'acct-btn acct-btn-primary';
      addBtn.style.cssText = 'padding:4px 12px;font-size:12px;';
      addBtn.textContent = '+ Add';
      addBtn.addEventListener('click', () => this.showBindForm());
      hdr.appendChild(addBtn);
      this.content.appendChild(hdr);

      // Tile grid
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;';

      for (let i = 0; i < devices.length; i++) {
          const dev = devices[i];
          // `device/bind/list` already includes online state; this avoids too many individual calls to `device/status` which causes you to get rate-limited if you do too many at one time.
          const online =
              dev.online === true ? true : dev.online === false ? false : null;
          grid.appendChild(this.buildDeviceTile(dev, online));
      }
      this.content.appendChild(grid);

      if (!devices.length) {
        // Friendlier empty state — the account is fine, just nothing bound.
        // Account / Info / Debug tabs at the top still work; we want this to
        // feel like a starting point, not an error.
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#888;text-align:center;padding:30px 16px;border:1px dashed #2a2d35;border-radius:8px;margin-top:8px;';
        empty.innerHTML = `
          <div style="font-size:14px;color:#bbb;margin-bottom:6px;">No robots bound to this account yet.</div>
          <div style="font-size:11px;line-height:1.5;color:#777;max-width:340px;margin:0 auto 14px;">Click <strong>+ Add</strong> above to register one, or jump to another tab — your login is active.</div>
        `;
        const cta = document.createElement('button');
        cta.className = 'acct-btn acct-btn-primary';
        cta.style.cssText = 'padding:6px 16px;font-size:12px;';
        cta.textContent = '+ Add a robot';
        cta.addEventListener('click', () => this.showBindForm());
        empty.appendChild(cta);
        this.content.appendChild(empty);
      }
    } catch (e) {
      this.content.innerHTML = `<div style="color:#ef5350;padding:20px;">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  }

  private buildDeviceTile(dev: RobotDevice, online: boolean | null): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'status-section';
    tile.style.cssText += 'position:relative;cursor:default;';

    // Online badge
    const badge = document.createElement('span');
    const state = online === true ? 'online' : online === false ? 'offline' : 'unknown';
    badge.className = `acct-status-badge acct-status-${state}`;
    badge.textContent = online === true ? 'Online' : online === false ? 'Offline' : '—';
    tile.appendChild(badge);

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;padding-right:60px;';
    title.textContent = dev.alias || dev.sn;
    tile.appendChild(title);

    this.infoRow(tile, 'SN', dev.sn, true);
    this.infoRow(tile, 'Series', dev.series);
    if (dev.model) this.infoRow(tile, 'Model', dev.model);
    if (dev.connIp) this.infoRow(tile, 'IP', dev.connIp, true);
    if (dev.connMode) this.infoRow(tile, 'Mode', dev.connMode);
    if (dev.key) this.infoRow(tile, 'AES-128 Key', dev.key.length > 32 ? dev.key.slice(0, 32) + '...' : dev.key, true);

    // Buttons row
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const detailBtn = document.createElement('button');
    detailBtn.className = 'acct-btn acct-btn-secondary';
    detailBtn.style.cssText = 'flex:1;padding:6px;font-size:12px;';
    detailBtn.textContent = 'Details';
    detailBtn.addEventListener('click', () => this.showDeviceDetail(dev));
    btns.appendChild(detailBtn);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'acct-btn acct-btn-secondary';
    shareBtn.style.cssText = 'flex:1;padding:6px;font-size:12px;';
    shareBtn.textContent = 'Share';
    shareBtn.addEventListener('click', () => this.showShareView(dev));
    btns.appendChild(shareBtn);

    tile.appendChild(btns);
    return tile;
  }

  private copyBtn(text: string): HTMLButtonElement {
    return makeCopyButton(text);
  }

  private async showDeviceDetail(dev: RobotDevice): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading...</div>';

    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));

    try {
      this.content.innerHTML = '';
      this.content.appendChild(backLink);

      // Device info
      const s = this.section(dev.alias || dev.sn);
      this.infoRow(s, 'Serial Number', dev.sn, true);
      this.infoRow(s, 'Series', dev.series);
      if (dev.model) this.infoRow(s, 'Model', dev.model);
      if (dev.mac) this.infoRow(s, 'MAC', dev.mac, true);
      if (dev.connIp) this.infoRow(s, 'IP', dev.connIp, true);
      if (dev.connMode) this.infoRow(s, 'Mode', dev.connMode);
      if (dev.code) this.infoRow(s, 'Code', dev.code, true);
      this.infoRow(s, 'Owner', dev.own === 1 ? 'Yes' : 'Shared');
      if (dev.key) this.infoRow(s, 'AES-128 Key', dev.key, true);
      if (dev.remark) this.infoRow(s, 'Remark', dev.remark);
      this.content.appendChild(s);

      // Edit
      const edit = this.section('Edit');
      const aliasInput = this.input('Alias', 'text');
      aliasInput.input.value = dev.alias;
      const remarkInput = this.input('Remark', 'text');
      remarkInput.input.value = dev.remark;
      edit.appendChild(aliasInput.wrapper);
      edit.appendChild(remarkInput.wrapper);
      edit.appendChild(this.button('Save', async () => {
        try {
          await cloudApi.updateDevice(dev.sn, aliasInput.input.value.trim(), remarkInput.input.value.trim());
          alert('Updated');
        } catch (e) { alert(String(e)); }
      }));
      this.content.appendChild(edit);

      // Firmware Updates — manual download links + cloud-orchestrated OTA
      // (matches the official APK flow). Family is inferred from the device
      // series: Go2 uses single-shot upgrade, everything else (G1/H1/B2/R1)
      // uses the Explorer two-step download+install.
      try {
        const fw = await cloudApi.listFirmwareUpdates(dev.sn);
        if (fw.length) {
          const fws = this.section('Firmware Updates');
          for (const f of fw) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:8px 0;border-bottom:1px solid #1a1d23;';
            row.innerHTML = `<div><span style="color:#888;font-family:monospace;">${this.esc(f.ownVersion)}</span> <span style="color:#555;">→</span> <span style="color:#66bb6a;font-weight:700;font-family:monospace;">${this.esc(f.version)}</span></div>`;
            if (f.description) row.innerHTML += `<div style="font-size:12px;color:#888;margin-top:4px;white-space:pre-wrap;">${this.esc(f.description)}</div>`;
            if (f.md5) row.innerHTML += `<div style="font-size:11px;color:#555;font-family:monospace;margin-top:2px;">MD5: ${this.esc(f.md5)}</div>`;
            if (f.download) {
              const url = cloudApi.getFirmwareDownloadUrl(f.download);
              row.innerHTML += `<a href="${this.esc(url)}" target="_blank" referrerpolicy="no-referrer" style="font-size:12px;color:#4fc3f7;display:block;margin-top:4px;">Download .upk</a>`;
              row.innerHTML += `<div style="font-size:10px;color:#444;font-family:monospace;margin-top:2px;word-break:break-all;">${this.esc(url)}</div>`;
            }
            fws.appendChild(row);
          }
          this.content.appendChild(fws);

          // Cloud OTA — only the first (latest) entry is upgrade-eligible.
          // Skip if there's no firmwareId (defensive; shouldn't happen).
          if (fw[0].firmwareId) {
            const family: OtaFamily = dev.series.startsWith('Go2') ? 'Go2' : 'G1';
            this.content.appendChild(this.buildOtaSection(dev.sn, family, fw[0]));
          }
        }
      } catch { /* ignore */ }

      // Refresh AES Key — for already-bound devices on V3-capable firmware
      // (G1 ≥ 1.5.1 / Go2 ≥ 1.1.15). Mirrors the G1 Explore APK's
      // `bindExtData` flow: paste the 344-char base64 blob produced by the
      // BLE V3 F2 (GCM_KEY) reassembly, the cloud RSA-decrypts it and
      // returns the freshly-derived 16-byte AES-128 key. Result is cached
      // locally so the WebRTC `data2=3` path picks it up next connect.
      const aes = this.section('Refresh AES Key');
      const blurb = document.createElement('div');
      blurb.style.cssText = 'font-size:11px;color:#888;line-height:1.5;margin-bottom:8px;';
      blurb.innerHTML = 'Paste the 344-char base64 blob from <strong style="color:#bbb;">BT page → robot panel → "344B RSA"</strong>. The cloud derives the 16-byte AES-128 key and stores it as <code style="color:#b3c0ff;">dev.key</code>.';
      aes.appendChild(blurb);
      const extWrap = this.input('extData blob (344-char base64)', 'text');
      extWrap.input.spellcheck = false;
      extWrap.input.autocomplete = 'off';
      extWrap.input.placeholder = 'RvEUsChKiyIkiPP7DmPZ08q/QXIMQrTMU…';
      aes.appendChild(extWrap.wrapper);
      const aesStatus = document.createElement('div');
      aesStatus.style.cssText = 'font-size:11px;color:#888;margin:6px 0;min-height:14px;font-family:monospace;word-break:break-all;';
      aes.appendChild(aesStatus);
      const refreshBtn = this.button('Refresh AES Key', async () => {
        const extData = extWrap.input.value.trim();
        if (!extData) {
          aesStatus.style.color = '#e57373';
          aesStatus.textContent = 'Paste the 344-char extData blob first.';
          return;
        }
        refreshBtn.disabled = true;
        aesStatus.style.color = '#888';
        aesStatus.textContent = 'Encrypting SN…';
        try {
          const snEncrypted = await rsaEncryptSn(dev.sn);
          aesStatus.textContent = 'Calling device/bindExtData…';
          // Pin AppName to the device's series so the call works regardless
          // of the account-family pill (Go2 device on G1 account or vice
          // versa). Everything other than Go2 maps onto the Explorer-line.
          const devFamily = dev.series.startsWith('Go2') ? 'Go2' : 'G1';
          const newKey = (await cloudApi.bindExtData(snEncrypted, extData, devFamily)).trim();
          if (!/^[0-9a-fA-F]{32}$/.test(newKey)) {
            aesStatus.style.color = '#e57373';
            aesStatus.textContent = `Unexpected response (not 32 hex): ${newKey || '<empty>'}`;
            refreshBtn.disabled = false;
            return;
          }
          setCachedAesKey(dev.sn, newKey);
          aesStatus.style.color = '#66bb6a';
          aesStatus.textContent = `✓ AES-128 key: ${newKey}`;
        } catch (e) {
          aesStatus.style.color = '#e57373';
          aesStatus.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          refreshBtn.disabled = false;
        }
      });
      aes.appendChild(refreshBtn);
      this.content.appendChild(aes);

      // Danger zone — unbind goes through `device/unbind` with an RSA-
      // encrypted SN (same convention as device/bind / device/bindExtData).
      const danger = this.section('Danger Zone');
      danger.style.borderColor = '#c62828';
      const unbindBtn = document.createElement('button');
      unbindBtn.className = 'acct-btn acct-btn-danger';
      unbindBtn.textContent = 'Unbind Robot';
      const unbindStatus = document.createElement('span');
      unbindStatus.style.cssText = 'margin-left:10px;font-size:12px;';
      unbindBtn.addEventListener('click', async () => {
        if (!confirm(`Unbind ${dev.sn}?\n\nThis removes the cloud-side binding (alias, mac, AES-128 key). You'll need to re-bind to use the robot from this account again.`)) return;
        unbindBtn.disabled = true;
        unbindStatus.style.color = '#888';
        unbindStatus.textContent = 'Encrypting SN…';
        try {
          const snEncrypted = await rsaEncryptSn(dev.sn);
          unbindStatus.textContent = 'Calling device/unbind…';
          await cloudApi.unbindDevice(snEncrypted);
          clearCachedAesKey(dev.sn);
          this.switchTab('devices');
        } catch (e) {
          unbindStatus.style.color = '#e57373';
          unbindStatus.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
          unbindBtn.disabled = false;
        }
      });
      danger.appendChild(unbindBtn);
      danger.appendChild(unbindStatus);
      this.content.appendChild(danger);
    } catch (e) {
      this.content.innerHTML = '';
      this.content.appendChild(backLink);
      this.content.innerHTML += `<div style="color:#ef5350;padding:20px;">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  }

  private async showShareView(dev: RobotDevice): Promise<void> {
    this.content.innerHTML = '';

    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));
    this.content.appendChild(backLink);

    // Share form
    const s = this.section(`Share ${dev.alias || dev.sn}`);
    const accountInput = this.input('Account (email or phone)', 'text');
    s.appendChild(accountInput.wrapper);
    s.appendChild(this.button('Share', async () => {
      const acct = accountInput.input.value.trim();
      if (!acct) return;
      try {
        await cloudApi.shareDevice(dev.sn, acct);
        alert(`Shared with ${acct}`);
        this.showShareView(dev);
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(s);

    // Current shares
    try {
      const shares = await cloudApi.listShares(dev.sn);
      if (shares.length) {
        const list = this.section('Current Shares');
        for (const sh of shares) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a1d23;';
          row.innerHTML = `<span style="font-size:13px;">${this.esc(sh.nickname || sh.uid)}</span>`;
          const delBtn = document.createElement('button');
          delBtn.className = 'acct-btn acct-btn-danger';
          delBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
          delBtn.textContent = 'Remove';
          delBtn.addEventListener('click', async () => {
            try {
              await cloudApi.deleteShare(dev.sn, sh.shareUid || sh.uid);
              this.showShareView(dev);
            } catch (e) { alert(String(e)); }
          });
          row.appendChild(delBtn);
          list.appendChild(row);
        }
        this.content.appendChild(list);
      }
    } catch { /* ignore */ }
  }

  /**
   * Bind form — mirrors the apk's `device/bind` payload:
   *   sn        — RSA-wrapped serial number (we wrap on submit)
   *   mac       — robot AP MAC (on V3 firmware this needs the BLE V3 GCM
   *               command path; for now the user pastes it, e.g. from a
   *               previous device entry's `dev.mac` or the robot label)
   *   alias     — display name
   *   remark    — free-text notes
   *   extData   — 44-char base64 BLE GCM key (paste from BT popup)
   *
   * On success the cloud derives the 16-byte AES-128 key from `extData` and
   * surfaces it as `dev.key` on the next `device/bind/list` — that's the
   * value the WebRTC frontend then consumes as `appKeyBytes` for `data2=3`.
   */
  private showBindForm(): void {
    this.content.innerHTML = '';
    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));
    this.content.appendChild(backLink);

    const s = this.section('Bind New Robot');

    const blurb = document.createElement('div');
    blurb.style.cssText = 'font-size:11px;color:#888;line-height:1.5;margin-bottom:10px;';
    blurb.innerHTML = 'Pair the robot via BLE first. Copy the GCM key from the BT popup, then paste it below along with the SN and AP MAC. Submitting will register the robot to your account and have the cloud derive the AES-128 key — visible as <code style="color:#b3c0ff;">dev.key</code> on the next devices list refresh.';
    s.appendChild(blurb);

    const snInput = this.input('Serial Number', 'text');
    const aliasInput = this.input('Alias', 'text');
    const macInput = this.input('AP MAC (xx:xx:xx:xx:xx:xx)', 'text');
    const remarkInput = this.input('Remark (optional)', 'text');
    const extInput = this.input('extData blob (344-char base64 — from BT popup, requires MTU=104)', 'text');
    extInput.input.spellcheck = false;
    extInput.input.autocomplete = 'off';
    extInput.input.placeholder = 'RvEUsChKiyIkiPP7DmPZ08q/QXIMQrTMU…';

    s.appendChild(snInput.wrapper);
    s.appendChild(aliasInput.wrapper);
    s.appendChild(macInput.wrapper);
    s.appendChild(remarkInput.wrapper);
    s.appendChild(extInput.wrapper);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:#888;margin:6px 0;min-height:14px;';
    s.appendChild(status);

    const submit = this.button('Bind Robot', async () => {
      const sn = snInput.input.value.trim();
      const mac = macInput.input.value.trim();
      const alias = aliasInput.input.value.trim();
      const remark = remarkInput.input.value.trim();
      const extData = extInput.input.value.trim();
      if (!sn) { status.style.color = '#e57373'; status.textContent = 'Serial Number required.'; return; }
      if (!extData) { status.style.color = '#e57373'; status.textContent = 'BLE GCM Key required (paste from BT popup).'; return; }
      submit.disabled = true;
      status.style.color = '#888';
      status.textContent = 'Encrypting SN…';
      try {
        const snEncrypted = await rsaEncryptSn(sn);
        status.textContent = 'Calling device/bind…';
        await cloudApi.bindDevice(snEncrypted, mac, alias, remark, extData);
        status.style.color = '#66bb6a';
        status.textContent = 'Bound — refreshing devices list.';
        // Brief delay so the user sees the success state before jumping back.
        setTimeout(() => this.switchTab('devices'), 600);
      } catch (e) {
        status.style.color = '#e57373';
        status.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
        submit.disabled = false;
      }
    });
    s.appendChild(submit);
    this.content.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════
  // INFO TAB
  // ════════════════════════════════════════════════════════════════════

  private async renderInfoTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading...</div>';

    const [appVer, tutorials, manuals, changelog, notices] = await Promise.allSettled([
      cloudApi.getAppVersion(),
      cloudApi.getTutorials(),
      cloudApi.getManualLinks(),
      cloudApi.getChangelog(),
      cloudApi.getNotices(),
    ]);
    this.content.innerHTML = '';

    // App version
    const ver = appVer.status === 'fulfilled' ? appVer.value : null;
    if (ver) {
      const s = this.section('App Version');
      this.infoRow(s, 'Latest', ver.VersionName, false, '#66bb6a');
      this.infoRow(s, 'Code', String(ver.VersionCode), true);
      if (ver.DownloadUrl) {
        const dl = document.createElement('a');
        dl.href = ver.DownloadUrl;
        dl.target = '_blank';
        dl.referrerPolicy = 'no-referrer';
        dl.className = 'acct-btn acct-btn-primary';
        dl.style.cssText = 'display:inline-block;margin-top:8px;padding:4px 12px;font-size:12px;text-decoration:none;';
        dl.textContent = `Download ${ver.DownloadUrl.split('/').pop()}`;
        s.appendChild(dl);
      }
      this.content.appendChild(s);
    }

    // Notices
    const noticeData = notices.status === 'fulfilled' ? notices.value : [];
    if (Array.isArray(noticeData) && noticeData.length) {
      const s = this.section('Announcements');
      for (const n of noticeData) {
        if (!n || typeof n !== 'object') continue;
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 0;border-bottom:1px solid #1a1d23;';
        row.innerHTML = `<div style="font-weight:600;font-size:13px;">${this.esc(n.title || '')}</div>`;
        if (n.content) row.innerHTML += `<div style="font-size:12px;color:#888;margin-top:2px;">${this.esc(n.content)}</div>`;
        s.appendChild(row);
      }
      this.content.appendChild(s);
    }

    // User Manuals — static marketing.unitree.com pages for this device
    // (Robot, Remote Control, Battery Charger). Same docs the app's Manual
    // screen opens; each opens in a new tab.
    const manualData = manuals.status === 'fulfilled' ? manuals.value : [];
    if (manualData.length) {
      // Distinct, recognizable icon per manual so they read at a glance.
      const ICONS: Record<string, string> = {
        Robot: '<rect x="5" y="8" width="14" height="11" rx="2"/><circle cx="9.5" cy="13" r="1.3" fill="#4fc3f7" stroke="none"/><circle cx="14.5" cy="13" r="1.3" fill="#4fc3f7" stroke="none"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2"/><path d="M5 12H3M21 12h-2"/>',
        'Remote Control': '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="6" r="1.3" fill="#4fc3f7" stroke="none"/><path d="M10.5 10h3M12 13v4"/>',
        'Battery Charger': '<rect x="2" y="8" width="16" height="9" rx="2"/><path d="M22 11v3"/><path d="M10.5 10.5 8 13h3l-2.5 2.5"/>',
      };
      const fallback = '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>';
      const s = this.section('User Manuals');
      for (const m of manualData) {
        const a = document.createElement('a');
        a.href = m.url; a.target = '_blank'; a.referrerPolicy = 'no-referrer';
        a.style.cssText = 'display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #151820;text-decoration:none;color:inherit;cursor:pointer;';
        const glyph = ICONS[m.title] || fallback;
        a.innerHTML = `<span style="flex-shrink:0;width:34px;height:34px;border-radius:8px;background:rgba(79,195,247,0.12);display:flex;align-items:center;justify-content:center;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>
          <span style="flex:1;font-size:13px;font-weight:500;">${this.esc(m.title)}</span>
          <span style="font-size:11px;color:#4fc3f7;white-space:nowrap;">Open ↗</span>`;
        s.appendChild(a);
      }
      this.content.appendChild(s);
    }

    // Guides & Manuals — the cloud tutorial/list set (how-to videos + user
    // manual / web links) for this device, filtered by (series, model). Each
    // row opens its URL, matching the app's guide screen.
    const tutData = tutorials.status === 'fulfilled' ? tutorials.value : [];
    const guides = tutData.flatMap((g) => g.tutorials).filter((t) => t && typeof t === 'object');
    if (guides.length) {
      const s = this.section('Tutorial Videos');
      for (const t of guides) {
        const hasUrl = !!t.url;
        const row = document.createElement(hasUrl ? 'a' : 'div');
        row.style.cssText = 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #151820;align-items:center;text-decoration:none;color:inherit;' + (hasUrl ? 'cursor:pointer;' : '');
        if (hasUrl) {
          const a = row as HTMLAnchorElement;
          a.href = t.url; a.target = '_blank'; a.referrerPolicy = 'no-referrer';
        }
        if (t.cover) row.innerHTML = `<img src="${this.esc(t.cover)}" style="width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;">`;
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        info.innerHTML = `<div style="font-size:13px;font-weight:500;">${this.esc(t.title || '')}</div>`;
        if (t.description) info.innerHTML += `<div style="font-size:11px;color:#888;margin-top:2px;line-height:1.4;">${this.esc(t.description)}</div>`;
        if (t.duration) info.innerHTML += `<div style="font-size:11px;color:#666;margin-top:2px;">${(t.duration / 60).toFixed(1)} min</div>`;
        row.appendChild(info);
        if (hasUrl) {
          const open = document.createElement('span');
          open.style.cssText = 'font-size:11px;color:#4fc3f7;flex-shrink:0;white-space:nowrap;';
          open.textContent = 'Open ↗';
          row.appendChild(open);
        }
        s.appendChild(row);
      }
      this.content.appendChild(s);
    }

    // Changelog
    const clData = changelog.status === 'fulfilled' ? changelog.value : [];
    if (clData.length) {
      const s = this.section('Changelog');
      for (const v of clData) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid #1a1d23;';
        row.innerHTML = `<span style="color:#4fc3f7;font-weight:700;min-width:50px;">${this.esc(v.title)}</span>
          <span style="color:#555;font-size:12px;">${this.esc(v.publishTime)}</span>`;
        if (v.link) {
          const a = document.createElement('a');
          a.href = v.link; a.target = '_blank';
          a.style.cssText = 'font-size:12px;color:#4fc3f7;margin-left:auto;';
          a.textContent = 'Details';
          row.appendChild(a);
        }
        s.appendChild(row);
      }
      this.content.appendChild(s);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // DEBUG TAB
  // ════════════════════════════════════════════════════════════════════

  private renderDebugTab(): void {
    // Request form
    const s = this.section('Request');
    const form = document.createElement('div');
    form.className = 'acct-form';

    const methodWrap = document.createElement('div');
    methodWrap.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
    const methodSel = document.createElement('select');
    methodSel.className = 'acct-input';
    methodSel.style.cssText = 'width:80px;padding:8px;font-size:13px;';
    methodSel.innerHTML = '<option>GET</option><option>POST</option>';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = 'endpoint/path';
    pathInput.className = 'acct-input acct-input-mono';
    pathInput.style.cssText = 'flex:1;padding:8px;font-size:13px;';
    methodWrap.appendChild(methodSel);
    methodWrap.appendChild(pathInput);
    form.appendChild(methodWrap);

    const paramsInput = document.createElement('textarea');
    paramsInput.placeholder = 'key=value (one per line)';
    paramsInput.rows = 4;
    paramsInput.className = 'acct-input acct-input-mono';
    paramsInput.style.cssText = 'padding:8px;font-size:12px;resize:vertical;';
    form.appendChild(paramsInput);

    // Decryption status banner (hidden until first request)
    const decBanner = document.createElement('div');
    decBanner.style.cssText = 'font-size:11px;padding:6px 10px;margin-top:10px;border-radius:6px;display:none;font-family:monospace;';

    // Response area — right below Send button, with a copy button overlay
    const resultWrap = document.createElement('div');
    resultWrap.style.cssText = 'position:relative;margin-top:8px;display:none;';
    const resultEl = document.createElement('pre');
    resultEl.style.cssText = 'font-family:monospace;font-size:12px;color:#888;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow:auto;padding:10px 10px 10px 10px;background:#08090c;border:1px solid #1a1d23;border-radius:6px;margin:0;user-select:text;-webkit-user-select:text;';
    const copyBtn = makeCopyButton(() => resultEl.textContent || '');
    copyBtn.style.position = 'absolute';
    copyBtn.style.top = '6px';
    copyBtn.style.right = '6px';
    resultWrap.appendChild(resultEl);
    resultWrap.appendChild(copyBtn);

    const renderDecBanner = () => {
      const m = getLastResponseMeta();
      const parts: string[] = [];

      // Compression pill (shows what the wire bytes were before fetch decoded them)
      if (m.compression && m.compression !== 'none' && m.compression !== 'identity') {
        parts.push(`📦 ${m.compression} (server compressed, fetch auto-decoded)`);
      } else {
        parts.push(`📦 uncompressed`);
      }

      // Encryption pill
      if (m.decryption === 'body-cfb') {
        parts.push(`🔐 AES-CFB decrypted · first bytes: ${m.rawPreview}`);
      } else if (m.decryption === 'failed') {
        parts.push(`⚠ decrypt failed · ${m.rawPreview}`);
      } else {
        parts.push(`🔓 plain JSON`);
      }

      // Size + content-type
      parts.push(`${m.bodyBytes} B` + (m.contentType ? ` · ${m.contentType.split(';')[0]}` : ''));

      // Colour/border derived from the dominant condition
      let color = '#888', bg = 'rgba(100,100,100,0.08)', border = '1px solid #2a2d35';
      if (m.decryption === 'body-cfb') {
        color = '#4fc3f7'; bg = 'rgba(79,195,247,0.08)'; border = '1px solid rgba(79,195,247,0.35)';
      } else if (m.decryption === 'failed') {
        color = '#ef9a9a'; bg = 'rgba(239,83,80,0.08)'; border = '1px solid rgba(239,83,80,0.35)';
      } else if (m.compression !== 'none' && m.compression !== 'identity') {
        color = '#a5d6a7'; bg = 'rgba(165,214,167,0.08)'; border = '1px solid rgba(165,214,167,0.35)';
      }

      decBanner.style.display = '';
      decBanner.style.color = color;
      decBanner.style.background = bg;
      decBanner.style.border = border;
      decBanner.textContent = parts.join('  ·  ');
    };

    const sendBtn = this.button('Send Request', async () => {
      const params: Record<string, string> = {};
      for (const line of paramsInput.value.split('\n')) {
        const t = line.trim();
        if (t && t.includes('=')) { const [k, ...v] = t.split('='); params[k.trim()] = v.join('=').trim(); }
      }
      resultWrap.style.display = '';
      resultEl.textContent = 'Loading...';
      resultEl.style.color = '#888';
      decBanner.style.display = 'none';
      try {
        const resp = await cloudApi.rawRequest(methodSel.value, pathInput.value.trim(), Object.keys(params).length ? params : undefined);
        renderDecBanner();
        resultEl.textContent = JSON.stringify(resp, null, 2);
        resultEl.style.color = resp.code === 100 ? '#a5d6a7' : '#ef9a9a';
      } catch (e) { renderDecBanner(); resultEl.textContent = String(e); resultEl.style.color = '#ef5350'; }
    });
    form.appendChild(sendBtn);
    form.appendChild(decBanner);
    form.appendChild(resultWrap);
    s.appendChild(form);
    this.content.appendChild(s);

    // Grouped endpoint catalog
    const groups: [string, string[][]][] = [
      ['Auth', [
        ['POST', 'login/email', 'email=\npassword='],
        ['POST', 'oauth/token', 'grantType=sms\nmobile=\ncaptcha='],
        ['POST', 'captcha/mobile', 'mobile='],
        ['POST', 'captcha/email', 'email='],
        ['GET', 'captcha', ''],
        ['POST', 'captcha/mobile/check', 'mobile=\ncaptcha='],
        ['POST', 'user/captcha/email/check', 'email=\ncaptcha='],
        ['POST', 'captcha/check', 'code=\ncaptcha='],
        ['GET', 'register/account/check', 'account='],
        ['POST', 'register/email', 'email=\npassword=\ncaptcha=\nregion=US'],
        ['POST', 'oauth/email/password/reset', 'email=\ncaptcha=\npassword='],
        ['POST', 'user/password/update', 'oldPassword=\npassword='],
        ['POST', 'user/destroy', ''],
        ['POST', 'token/refresh', 'refreshToken='],
      ]],
      ['User', [
        ['GET', 'user/info', ''],
        ['POST', 'user/info/update', 'nickname=\navatar='],
        ['POST', 'user/setRegion', 'region=US'],
        ['POST', 'user/nickname/check', 'nickname='],
        ['GET', 'oauth/bind/accounts', ''],
        ['POST', 'oauth/unbind', 'grantType=wechat'],
        ['POST', 'user/email/update', 'email=\ntoken='],
        ['POST', 'user/mobile/update', 'mobile=\ntoken='],
        ['POST', 'user/search', 'nickname='],
        ['GET', 'exercise/data/summary', ''],
        ['GET', 'user/visitors', ''],
      ]],
      ['Devices', [
        ['GET', 'device/bind/list', ''],
        ['POST', 'device/bind', 'sn=\nmac=\nalias=\nremark=\nextData='],
        ['POST', 'device/unbind', 'sn='],
        ['POST', 'device/bind/check', 'sn='],
        ['POST', 'device/update', 'sn=\nalias=\nremark='],
        ['GET', 'device/online/status', 'sn='],
        ['GET', 'device/network', 'sn='],
        ['POST', 'device/network/update', 'sn=\nconnIp=\nconnMode='],
        ['POST', 'device/bindExtData', 'extData=\nsn='],
        ['POST', 'device/notifyUnBind', 'sn='],
        ['POST', 'device/wallet', 'sn='],
      ]],
      ['Location', [
        ['GET', 'device/location', 'sn='],
        ['POST', 'device/location/updateStatus', 'sn=\ngpsEnable=1'],
        ['POST', 'internal/device/location', 'sn='],
      ]],
      ['Sharing', [
        ['POST', 'device/share/add', 'sn=\naccount=\nremark='],
        ['POST', 'device/share/list', 'sn='],
        ['POST', 'device/share/del', 'sn=\nshareUid='],
      ]],
      ['Firmware', [
        ['POST', 'v1/firmware/package/upgrade/list', 'sn='],
        ['POST', 'firmware/package/version', 'sn='],
        ['POST', 'firmware/package/upgrade', 'sn=\nfirmwareId='],
        ['POST', 'firmware/package/download', 'sn=\nfirmwareId='],
        ['POST', 'firmware/package/install', 'sn=\nfirmwareId='],
        ['GET', 'firmware/upgrade/progress', 'updateId='],
        ['POST', 'firmware/upgrade/task/current', 'sn='],
        ['GET', 'app/version', 'platform=Android'],
        ['GET', 'app/version/notice/latest', ''],
        ['GET', 'app/version/intro/list', 'lastId=0'],
      ]],
      ['WebRTC', [
        ['POST', 'webrtc/account', 'sn=\nsk='],
        ['POST', 'webrtc/connect', 'sn=\nsk=\ndata=\ntimeout=5'],
      ]],
      ['Wallet', [
        ['GET', 'flow/card/info', 'sn='],
        ['GET', 'flow/card/packages', ''],
        ['GET', 'device/flow/usage', 'sn=\nyear=2026\nmonth=4'],
        ['GET', 'wallet/order/list', 'sn=\nlastId='],
        ['GET', 'wallet/package/list', ''],
      ]],
      ['IoT', [
        ['POST', 'internal/device/iot/changePlan', 'sn='],
      ]],
      ['Logs', [
        ['POST', 'device/log/upload/trigger', 'sn='],
        ['POST', 'app/log/upload', 'date=2026-04-12\ncontent=test'],
      ]],
      ['Content', [
        ['GET', 'tutorial/list', 'appName=Go2\ntype='],
        ['POST', 'tutorial/read', 'id='],
        ['GET', 'app/notice/list', ''],
        ['GET', 'advertisements', 'position=1'],
        ['GET', 'agreement/version/latest', ''],
        ['POST', 'feedback/add', 'content=\ncontact=\npics='],
      ]],
      ['System', [
        ['GET', 'system/pubKey', ''],
        ['POST', 'nls/token', ''],
        ['GET', 'api/storage/getOssSts', ''],
        ['POST', 'eae1537f', 'data=\nuuid='],
      ]],
      ['Creative', [
        ['GET', 'app/creativeProgramming/list', 'sortType=\npage=1'],
        ['GET', 'app/creativeProgramming/myself', 'page=1'],
        ['GET', 'app/creativeProgramming/download', 'id='],
        ['GET', 'app/creativeProgramming/whitelist', 'page=1'],
      ]],
    ];

    const total = groups.reduce((n, [, eps]) => n + eps.length, 0);

    for (const [groupName, endpoints] of groups) {
      const gs = this.section(`${groupName} (${endpoints.length})`);
      for (const [m, p, par] of endpoints) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0;cursor:pointer;border-bottom:1px solid #151820;';
        row.innerHTML = `<span style="font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;${m === 'GET' ? 'background:#1b5e20;color:#a5d6a7;' : 'background:#e65100;color:#ffcc80;'}">${m}</span><span style="font-size:12px;color:#4fc3f7;font-family:monospace;">${p}</span>`;
        row.addEventListener('click', () => {
          methodSel.value = m; pathInput.value = p; paramsInput.value = par;
          this.content.scrollTop = 0;
        });
        gs.appendChild(row);
      }
      this.content.appendChild(gs);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════

  private section(title: string): HTMLElement {
    const s = document.createElement('div');
    s.className = 'status-section';
    const t = document.createElement('div');
    t.className = 'status-section-title';
    t.textContent = title;
    s.appendChild(t);
    return s;
  }

  /** Cloud-OTA control panel for one firmware. Mirrors the official APK
   *  flow:
   *    Go2: single Upgrade button → server runs download+install,
   *         progress label flips at 50% from "Downloading" to "Installing".
   *    G1:  Download button → polls until 50% boundary (current==500),
   *         then surfaces an Install button → polls install to 100%.
   *  Polling cadence: 1 s tick, 20-tick offline budget — matches the APK.
   *  Resume support: on mount we check `getCurrentUpgradeTask(sn)` and
   *  re-attach to any in-flight job so back-out + return doesn't lose
   *  state. */
  private buildOtaSection(sn: string, family: OtaFamily, fw: FirmwareInfo): HTMLElement {
    const sec = this.section('Install via Cloud (OTA)');
    sec.appendChild(this.makeOtaContent(sn, family, fw));
    return sec;
  }

  private makeOtaContent(sn: string, family: OtaFamily, fw: FirmwareInfo): HTMLElement {
    const wrap = document.createElement('div');

    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:12px;color:#888;margin-bottom:8px;';
    subtitle.innerHTML = `Server-orchestrated upgrade — the Unitree cloud pushes V${this.esc(fw.version)} to the robot. <strong style="color:#aaa;">${family === 'G1' ? 'Two-step (download then install).' : 'Single-step.'}</strong>`;
    wrap.appendChild(subtitle);

    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:11px;color:#e57373;margin-bottom:10px;line-height:1.4;';
    warn.textContent = 'The robot must stay powered on and online with the cloud throughout. Do not power-cycle until the upgrade reports completion. The robot will reboot at the end.';
    wrap.appendChild(warn);

    const startBtn = document.createElement('button');
    startBtn.className = 'acct-btn acct-btn-primary';
    startBtn.textContent = family === 'G1' ? 'Start Download' : 'Start Upgrade';
    startBtn.style.marginRight = '8px';

    const installBtn = document.createElement('button');
    installBtn.className = 'acct-btn acct-btn-primary';
    installBtn.textContent = 'Install on Robot';
    installBtn.style.cssText = 'margin-right:8px;display:none;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'acct-btn';
    cancelBtn.style.cssText = 'background:#2a2d35;color:#ccc;display:none;';
    cancelBtn.textContent = 'Stop Watching';

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;';
    buttons.append(startBtn, installBtn, cancelBtn);
    wrap.appendChild(buttons);

    // Progress bar (hidden until first non-idle state).
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'display:none;margin-bottom:8px;';
    const barLabel = document.createElement('div');
    barLabel.style.cssText = 'font-size:12px;color:#aaa;margin-bottom:4px;display:flex;justify-content:space-between;';
    const barTrack = document.createElement('div');
    barTrack.style.cssText = 'height:10px;background:#1a1d23;border-radius:5px;overflow:hidden;border:1px solid #2a2d35;';
    const barFill = document.createElement('div');
    barFill.style.cssText = 'height:100%;width:0;background:linear-gradient(90deg,#4fc3f7,#6879e4);transition:width 0.3s ease;';
    barTrack.appendChild(barFill);
    barWrap.append(barLabel, barTrack);
    wrap.appendChild(barWrap);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;line-height:1.4;';
    wrap.appendChild(status);

    const setStatus = (text: string, color: string): void => {
      status.style.color = color;
      status.textContent = text;
    };

    // Single controller per UI mount. Cancelled when device-detail is
    // re-rendered (back / switchTab) — the cloud-side job keeps running.
    let ctrl: OtaController | null = null;

    const newController = (): OtaController => {
      const c = new OtaController(sn, family, fw);
      c.subscribe((s) => render(s));
      return c;
    };

    const render = (s: OtaState): void => {
      // Phase → button visibility map.
      switch (s.phase) {
        case 'idle':
          startBtn.disabled = false;
          startBtn.style.display = '';
          installBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          barWrap.style.display = 'none';
          break;
        case 'starting':
          startBtn.disabled = true;
          installBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          barWrap.style.display = 'none';
          setStatus('Starting…', '#888');
          break;
        case 'downloading':
          startBtn.style.display = 'none';
          installBtn.style.display = 'none';
          cancelBtn.style.display = '';
          barWrap.style.display = '';
          barLabel.innerHTML = `<span>${family === 'G1' ? 'Downloading to robot' : 'Cloud → Robot'}</span><span>${Math.round(s.progressPct)}%</span>`;
          barFill.style.width = `${s.progressPct}%`;
          setStatus(`current=${s.current} / total=${s.total}`, '#666');
          break;
        case 'awaiting-install':
          startBtn.style.display = 'none';
          installBtn.style.display = '';
          installBtn.disabled = false;
          cancelBtn.style.display = '';
          barWrap.style.display = 'none';
          setStatus('Download complete. Tap Install to apply on the robot.', '#66bb6a');
          break;
        case 'installing':
          startBtn.style.display = 'none';
          installBtn.style.display = 'none';
          cancelBtn.style.display = '';
          barWrap.style.display = '';
          barLabel.innerHTML = `<span>Installing on robot</span><span>${Math.round(s.progressPct)}%</span>`;
          barFill.style.width = `${s.progressPct}%`;
          setStatus(`current=${s.current} / total=${s.total}`, '#666');
          break;
        case 'completed':
          startBtn.disabled = true;
          startBtn.style.display = '';
          startBtn.textContent = 'Upgrade Complete';
          installBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          barWrap.style.display = '';
          barLabel.innerHTML = `<span>Done</span><span>100%</span>`;
          barFill.style.width = '100%';
          setStatus('Upgrade complete. The robot is rebooting and will reconnect shortly.', '#66bb6a');
          break;
        case 'failed':
          startBtn.disabled = false;
          startBtn.style.display = '';
          startBtn.textContent = family === 'G1' ? 'Retry Download' : 'Retry Upgrade';
          installBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          barWrap.style.display = 'none';
          setStatus(s.message || 'Upgrade failed.', '#e57373');
          break;
      }
    };

    startBtn.addEventListener('click', async () => {
      // Spin up a fresh controller — the previous one (if any) is fully
      // resolved by this point (completed / failed / cancelled).
      ctrl?.cancel();
      ctrl = newController();
      try {
        await ctrl.start();
      } catch (e) {
        setStatus(`Failed to start: ${e instanceof Error ? e.message : String(e)}`, '#e57373');
      }
    });

    installBtn.addEventListener('click', async () => {
      if (!ctrl) return;
      installBtn.disabled = true;
      try {
        await ctrl.startInstall();
      } catch (e) {
        setStatus(`Install failed: ${e instanceof Error ? e.message : String(e)}`, '#e57373');
        installBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', () => {
      ctrl?.cancel();
      ctrl = null;
      // Reset to idle so the user can start over (cloud job keeps running
      // server-side; "Stop Watching" just severs the local poll).
      render({ phase: 'idle', progressPct: 0, current: 0, total: 0 });
      startBtn.textContent = family === 'G1' ? 'Start Download' : 'Start Upgrade';
      setStatus('Stopped watching. The cloud job (if any) keeps running on the robot.', '#888');
    });

    // Resume check — if the cloud reports an active task for this SN, hook
    // the controller into it so back-out + return doesn't lose progress.
    void cloudApi.getCurrentUpgradeTask(sn).then((updateId) => {
      if (!updateId) return;
      ctrl = newController();
      ctrl.attach(updateId);
      setStatus(`Resumed in-flight upgrade (updateId=${updateId})`, '#888');
    });

    return wrap;
  }

  private infoRow(parent: HTMLElement, label: string, value: string, mono = false, color = ''): void {
    const row = document.createElement('div');
    row.className = 'acct-info-row';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'acct-info-label';
    labelSpan.textContent = label;
    row.appendChild(labelSpan);

    const valueSpan = document.createElement('span');
    valueSpan.className = `acct-info-value${mono ? ' acct-info-mono' : ''}`;
    if (color) valueSpan.style.color = color;
    valueSpan.textContent = value || '-';
    row.appendChild(valueSpan);

    // Copy button for mono values (SN, IP, keys, etc.)
    if (mono && value && value !== '-') {
      row.appendChild(makeCopyButton(value));
    }

    parent.appendChild(row);
  }

  private input(label: string, type: string, inputType?: string): { wrapper: HTMLElement; input: HTMLInputElement } {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '10px';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:11px;color:#666;margin-bottom:3px;';
    lbl.textContent = label;
    wrapper.appendChild(lbl);
    const input = document.createElement('input');
    input.type = inputType || type;
    input.className = 'acct-input';
    wrapper.appendChild(input);
    return { wrapper, input };
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'acct-btn acct-btn-primary';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  /**
   * Decode a JWT's payload (the middle base64url-encoded JSON segment).
   * Returns null when the input isn't a 3-part JWT or fails to parse —
   * Unitree currently mints standard HS256 JWTs, but defensive nulls
   * keep the UI honest if that ever changes. */
  private parseJwt(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      // base64url → base64 (replace -/_ with +/, pad with =)
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const json = atob(b64);
      const obj = JSON.parse(json);
      return (obj && typeof obj === 'object') ? obj as Record<string, unknown> : null;
    } catch { return null; }
  }

  /** Build a token row: one-line chip + always-visible parsed claims below.
   *  The chip itself is selectable so the user can grab the raw token. */
  private buildTokenRow(label: string, token: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:12px;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:#666;flex-shrink:0;';
    lbl.textContent = label;
    row.appendChild(lbl);

    const chip = document.createElement('span');
    chip.style.cssText = 'flex:1;min-width:0;font-family:monospace;font-size:11px;color:#aaa;background:#0a0c10;border:1px solid #1f2229;border-radius:4px;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text;-webkit-user-select:text;';
    chip.textContent = token;
    chip.title = token;
    row.appendChild(chip);

    row.appendChild(this.copyBtn(token));
    wrap.appendChild(row);

    // Refresh meta row: "Refreshed Xs ago" + manual refresh button.
    // Ticks live every second; the button hits the public
    // refreshAccessToken() helper which always renews (vs ensureFreshToken
    // which only renews near expiry).
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;font-size:11px;color:#888;';

    const ageEl = document.createElement('span');
    ageEl.textContent = this.formatRefreshAge(cloudApi.lastRefreshedAt);
    this.refreshAgeEl = ageEl;
    meta.appendChild(ageEl);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'acct-btn';
    refreshBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.addEventListener('click', async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      const originalText = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing…';
      try {
        const ok = await cloudApi.refreshAccessToken();
        if (ok) {
          // Token + lastRefreshedAt are new — re-render the current tab so
          // the chip text and the parsed JWT claims pick up the new token.
          this.switchTab(this.currentTab);
        } else {
          refreshBtn.textContent = 'Refresh failed';
          setTimeout(() => { refreshBtn.textContent = originalText; refreshBtn.disabled = false; }, 1500);
        }
      } catch {
        refreshBtn.textContent = 'Refresh failed';
        setTimeout(() => { refreshBtn.textContent = originalText; refreshBtn.disabled = false; }, 1500);
      }
    });
    meta.appendChild(refreshBtn);

    wrap.appendChild(meta);
    this.startRefreshAgeTicker();

    // Always-visible parsed claims block below the chip.
    const claims = document.createElement('div');
    claims.style.cssText = 'margin-top:8px;padding:8px 10px;background:#08090c;border:1px solid #1a1d23;border-radius:4px;font-family:monospace;font-size:11px;line-height:1.6;color:#ccc;';
    const payload = this.parseJwt(token);
    if (!payload) {
      claims.style.fontFamily = 'system-ui,-apple-system,sans-serif';
      claims.style.color = '#888';
      claims.textContent = 'Not a JWT — raw token shown above.';
    } else {
      const now = Math.floor(Date.now() / 1000);
      const lines: string[] = [];
      // Render known time fields as ISO + relative ("in 23h", "12m ago");
      // pass everything else through verbatim so new claims show up too.
      for (const [k, v] of Object.entries(payload)) {
        let display: string;
        if ((k === 'exp' || k === 'iat' || k === 'nbf') && typeof v === 'number') {
          const iso = new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19);
          const delta = v - now;
          const rel = delta >= 0
            ? `in ${this.formatDuration(delta)}`
            : `${this.formatDuration(-delta)} ago`;
          const isExpired = k === 'exp' && delta < 0;
          const color = isExpired ? '#ef5350' : (k === 'exp' ? '#66bb6a' : '#888');
          display = `<span style="color:${color}">${iso} UTC (${rel})</span>`;
        } else if (typeof v === 'object') {
          display = `<span style="color:#aaa">${this.esc(JSON.stringify(v))}</span>`;
        } else {
          display = `<span style="color:#aaa">${this.esc(String(v))}</span>`;
        }
        lines.push(`<div><span style="color:#6879e4;">${this.esc(k)}</span>: ${display}</div>`);
      }
      claims.innerHTML = lines.join('') || '<div style="color:#888;">Empty payload</div>';
    }
    wrap.appendChild(claims);

    return wrap;
  }

  /** Format the "Refreshed Xs ago" line. null → "Not refreshed yet" (a
   *  manually-pasted token has no lastRefreshedAt timestamp).            */
  private formatRefreshAge(lastRefreshedAt: number | null): string {
    if (lastRefreshedAt === null) return 'Not refreshed yet (paste-in token)';
    const now = Math.floor(Date.now() / 1000);
    const delta = Math.max(0, now - lastRefreshedAt);
    return `Refreshed ${this.formatDuration(delta)} ago`;
  }

  /** Re-uses the same per-second interval for every mount of the page —
   *  only fires while the page is mounted (started on first token row
   *  build, cleared in destroy). */
  private startRefreshAgeTicker(): void {
    if (this.refreshAgeTimer) return;
    this.refreshAgeTimer = setInterval(() => {
      if (!this.refreshAgeEl || !document.body.contains(this.refreshAgeEl)) return;
      this.refreshAgeEl.textContent = this.formatRefreshAge(cloudApi.lastRefreshedAt);
    }, 1000);
  }

  /** Format a positive number of seconds as "1d 3h", "23m", "45s". */
  private formatDuration(sec: number): string {
    sec = Math.floor(sec);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mr = m % 60;
    if (h < 24) return mr ? `${h}h ${mr}m` : `${h}h`;
    const d = Math.floor(h / 24);
    const hr = h % 24;
    return hr ? `${d}d ${hr}h` : `${d}d`;
  }

  /**
   * Render an avatar with a robust fallback. Some Unitree CDNs (notably
   * fitness-static.unitree.com, which hosts the default avatar set
   * /css/images/avatar/default/N.png) reject browser requests with 403 +
   * ORB outside the mobile-app referer allowlist. Swap in a generated
   * initial-circle so the UI doesn't render a broken image.
   */
  private createAvatarImg(url: string | undefined, size: number, displayName: string, rounded: boolean): HTMLImageElement {
    const img = document.createElement('img');
    const radius = rounded ? '50%' : '8px';
    const border = rounded ? 'border:2px solid var(--avatar-border,#2a2d35);' : '';
    img.style.cssText = `width:${size}px;height:${size}px;border-radius:${radius};object-fit:cover;${border}`;
    img.alt = displayName;
    // fitness-static.unitree.com's WAF returns 403 when the Referer header
    // names an origin outside the mobile-app allowlist. Direct address-bar
    // navigation works because no Referer is sent — replicate that here so
    // the actual avatar loads instead of the SVG fallback.
    img.referrerPolicy = 'no-referrer';
    const fallback = this.makeInitialAvatarDataUrl(size, displayName);
    img.addEventListener('error', () => {
      if (img.src !== fallback) img.src = fallback;
    }, { once: true });
    img.src = url || fallback;
    return img;
  }

  private makeInitialAvatarDataUrl(size: number, name: string): string {
    const trimmed = name.trim();
    const initial = (trimmed[0] || '?').toUpperCase();
    let hue = 0;
    for (const ch of trimmed) hue = (hue * 31 + ch.charCodeAt(0)) >>> 0;
    hue = hue % 360;
    const fontSize = Math.round(size * 0.45);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size / 2}" fill="hsl(${hue},45%,42%)"/><text x="50%" y="55%" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-size="${fontSize}" font-weight="600" fill="white">${this.esc(initial)}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  destroy(): void {
    if (this.refreshAgeTimer) { clearInterval(this.refreshAgeTimer); this.refreshAgeTimer = null; }
    this.container.remove();
  }
}
