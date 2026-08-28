/**
 * The advocate-facing web client.
 *
 * ## Why there is no framework and no build step
 *
 * The same three reasons the admin panel gives, which apply with more force
 * here because this is the page real users load:
 *
 *  1. It ships inside the existing web service. A React app means a build
 *     stage in the Dockerfile, a second thing that can fail on deploy, and a
 *     class of production-only breakage that does not exist today.
 *  2. No external script tags means no CDN in front of an interface that
 *     displays advocates' legal research, and nothing third-party on the page
 *     that holds their session.
 *  3. There is one screen with a list beside it. A framework would not make
 *     this shorter; it would make it someone else's abstraction.
 *
 * ## The rule that matters most in this file
 *
 * Everything that comes from the server or the model is escaped before it
 * reaches innerHTML. `esc()` below is the only sanctioned path, and the
 * markdown renderer escapes *first* and adds markup *second* - never the other
 * way round, which is how a "safe" renderer ends up executing a script tag that
 * arrived inside a case title.
 */
export const APP_JS = String.raw`
'use strict';

// ============================================================================
// State
// ============================================================================

const state = {
  config: null,       // what this deployment supports
  user: null,         // null until signed in
  credits: null,
  threads: [],
  threadId: null,
  messages: [],
  busy: false,        // an answer is in flight
  authMode: 'signin',
  sidebarOpen: false,
};

const $ = (sel, root) => (root || document).querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The only sanctioned way anything untrusted reaches innerHTML. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================================
// API
// ============================================================================

/**
 * Unwrap the server's response envelope.
 *
 * Every endpoint answers { success, data, meta } or { success, error, meta }.
 * Throwing on the error branch means callers write a try/catch instead of
 * checking a flag they can forget to check.
 */
async function api(path, options) {
  const response = await fetch(path, Object.assign({
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  }, options || {}));

  let body = null;
  try { body = await response.json(); } catch (_) { /* empty or non-JSON */ }

  if (!response.ok || (body && body.success === false)) {
    const error = new Error((body && body.error && body.error.message) || 'Something went wrong.');
    error.code = (body && body.error && body.error.code) || String(response.status);
    error.status = response.status;
    throw error;
  }

  return body ? body.data : null;
}

const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload || {}) });

// ============================================================================
// Boot
// ============================================================================

async function boot() {
  applyStoredTheme();

  try {
    state.config = await api('/api/auth/config');
  } catch (_) {
    state.config = { google: false, emailRecovery: false, passwordMinLength: 10, payments: false };
  }

  // Standalone token screens are reachable while signed out and must be handled
  // before the session check, or an advocate resetting a forgotten password is
  // bounced to the sign-in form they cannot get past.
  const path = location.pathname;
  if (path === '/app/reset-password') return renderResetPassword();
  if (path === '/app/verify-email')  return renderVerifyEmail();

  // The landing page needs a link that lands on the sign-up form rather than
  // the sign-in one, and a link cannot set state.authMode - so the path does.
  // The URL is normalised back to /app immediately: it exists to be linked to,
  // not to be somewhere the app lives, and leaving it in the bar means a
  // refresh after signing in reads as an invitation to sign up again.
  if (path === '/app/signup' || path === '/app/sign-up') {
    state.authMode = 'signup';
    history.replaceState({}, '', '/app');
  }

  try {
    await loadSession();
    await enterApp();
  } catch (_) {
    renderAuth();
  }
}

/**
 * Pull the whole signed-in profile from one endpoint.
 *
 * Shared by the page-load path and the sign-in form on purpose. They used to
 * differ: boot() fetched /api/auth/me, while the form handler set only
 * state.user from the login response and went straight in. Everything /me also
 * returns - the credit balance, the deployment's capabilities - was therefore
 * undefined for anyone who had just signed in, so the sidebar showed an empty
 * credit chip and opening the account screen threw on state.capabilities.
 * A reload fixed it, which is the worst kind of bug: invisible to whoever
 * tests by refreshing.
 */
async function loadSession() {
  const me = await api('/api/auth/me');
  state.user = me.user;
  state.credits = me.credits;
  state.capabilities = me.capabilities;
}

// ============================================================================
// Sign in / sign up
// ============================================================================

const GOOGLE_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>' +
  '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>' +
  '<path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"/>' +
  '<path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.47 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';

/** Failures that arrive as a query parameter after a Google round trip. */
const OAUTH_MESSAGES = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_not_configured: 'Google sign-in is not set up on this deployment.',
  state_mismatch: 'That sign-in link expired. Please try again.',
  state_expired: 'That sign-in took too long. Please try again.',
  no_email: 'Google did not share an email address for that account.',
  account_blocked: 'This account has been suspended. Please contact support.',
  network: 'Could not reach Google. Please try again.',
};

function renderAuth() {
  const signup = state.authMode === 'signup';
  const oauthError = new URLSearchParams(location.search).get('error');

  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' +
      brandMarkup() +
      '<h1>' + (signup ? 'Create your account' : 'Sign in') + '</h1>' +
      '<p class="sub">' + (signup
        ? 'Legal research, case law and court status for Indian advocates.'
        : 'Welcome back.') + '</p>' +
      '<div id="auth-error"></div>' +
      (state.config.google
        ? '<a class="oauth-btn" href="/auth/google">' + GOOGLE_MARK + 'Continue with Google</a>' +
          '<div class="divider">or</div>'
        : '') +
      '<form id="auth-form">' +
        (signup ? field('fullName', 'Full name', 'text', 'As it appears on your enrolment') : '') +
        field('email', 'Email', 'email', 'you@example.com') +
        (signup ? field('phoneNumber', 'WhatsApp number', 'tel',
                        'With country code, e.g. 919876543210. We send a code here.') : '') +
        field('password', 'Password', 'password',
              signup ? 'At least ' + state.config.passwordMinLength + ' characters' : '') +
        '<button class="btn block" type="submit">' +
          (signup ? 'Create account' : 'Sign in') +
        '</button>' +
      '</form>' +
      (!signup && (state.config.phoneRecovery || state.config.emailRecovery)
        ? '<div style="text-align:center;margin-top:14px">' +
            '<button class="forgot" id="forgot">Forgot your password?</button></div>'
        : '') +
      '<div class="auth-switch">' +
        (signup ? 'Already registered? ' : 'New here? ') +
        '<button id="switch">' + (signup ? 'Sign in' : 'Create an account') + '</button>' +
      '</div>' +
    '</div></div>';

  if (oauthError) {
    showAuthError(OAUTH_MESSAGES[oauthError] || 'Sign-in failed. Please try again.');
    history.replaceState({}, '', '/app');
  }

  $('#switch').onclick = () => { state.authMode = signup ? 'signin' : 'signup'; renderAuth(); };
  const forgot = $('#forgot');
  // WhatsApp first where it exists: every account here is verified by number,
  // so it is the one contact route guaranteed to be present and proven.
  if (forgot) {
    forgot.onclick = state.config.phoneRecovery ? renderForgotByPhone : renderForgotPassword;
  }

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#auth-form button');
    button.disabled = true;
    showAuthError('');

    try {
      const payload = {
        email: $('#f-email').value.trim(),
        password: $('#f-password').value,
      };
      if (signup) {
        payload.fullName = $('#f-fullName').value.trim();
        payload.phoneNumber = $('#f-phoneNumber').value.trim();
      }

      const result = await post(signup ? '/api/auth/signup' : '/api/auth/login', payload);

      // Signing up leaves the account behind the verification gate, so it goes
      // to the code screen rather than into the app. The session cookie is
      // already set - that is what lets the verify call authenticate.
      if (signup) return renderVerifyPhone(result && result.verification);

      // The session cookie is set by the response above; everything the app
      // needs comes from one place so the two entry paths cannot diverge again.
      await loadSession();
      await enterApp();
    } catch (err) {
      // An existing account that predates verification lands here on sign-in:
      // the credentials are right and the gate is still down.
      if (err.code === 'PHONE_UNVERIFIED') return renderVerifyPhone(null);
      showAuthError(err.message);
      button.disabled = false;
    }
  };
}

function field(name, label, type, hint) {
  return '<div class="field"><label for="f-' + name + '">' + esc(label) + '</label>' +
    '<input id="f-' + name + '" type="' + type + '" ' +
    'autocomplete="' + (type === 'password' ? 'current-password'
                        : type === 'email' ? 'email'
                        : type === 'tel' ? 'tel' : 'name') + '" ' +
    // A numeric keypad on a phone, without type=number - which would strip a
    // leading zero and offer spinner arrows on a value that is not a quantity.
    (type === 'tel' ? 'inputmode="numeric" ' : '') +
    'required>' +
    (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
}

function brandMarkup() {
  return '<div class="brand"><div class="brand-mark">VS</div>' +
    '<div class="brand-text"><b>Vakeel Saathi</b>' +
    '<span>Legal research for Indian advocates</span></div></div>';
}

function showAuthError(message) {
  const box = $('#auth-error');
  if (!box) return;
  box.innerHTML = message ? '<div class="alert error">' + esc(message) + '</div>' : '';
}

/**
 * The code screen.
 *
 * Reached two ways: straight after signing up, and after signing in to an
 * account created before verification existed. The info argument carries the
 * delivery result when there is one - on the sign-in path there is not,
 * because nothing was sent, which is why resend is offered rather than assumed.
 */
function renderVerifyPhone(info) {
  var sentTo = info && info.phoneNumber ? info.phoneNumber : '';
  var failed = info && info.sent === false;

  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' + brandMarkup() +
      '<h1>Verify your WhatsApp</h1>' +
      '<p class="sub">' +
        (sentTo
          ? 'We sent a six-digit code to ' + esc(sentTo) + '.'
          : 'Enter the six-digit code we sent to your WhatsApp.') +
      '</p>' +
      '<div id="auth-error"></div>' +
      '<form id="auth-form">' +
        '<div class="field"><label for="f-code">Code</label>' +
          '<input id="f-code" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
                 'maxlength="6" pattern="[0-9]{6}" required>' +
          '<div class="hint">It expires in ten minutes.</div></div>' +
        '<button class="btn block" type="submit">Verify</button>' +
      '</form>' +
      '<div style="text-align:center;margin-top:14px">' +
        '<button class="forgot" id="resend">Send another code</button></div>' +
      '<div class="auth-switch"><button id="switch">Back to sign in</button></div>' +
    '</div></div>';

  // A failed delivery is shown immediately rather than after a wasted wait for
  // a code that is not coming.
  if (failed) showAuthError(info.message || 'We could not send the code.');

  $('#switch').onclick = function () {
    // Sign out first: the session is live but gated, and leaving it in place
    // means the sign-in form would be rendered for somebody already holding a
    // cookie, which reads as the form silently doing nothing.
    post('/api/auth/logout', {}).catch(function () {}).then(function () {
      state.user = null;
      state.authMode = 'signin';
      renderAuth();
    });
  };

  $('#resend').onclick = function () {
    var button = $('#resend');
    button.disabled = true;
    showAuthError('');
    post('/api/auth/phone/resend', {}).then(function (r) {
      $('#auth-error').innerHTML =
        '<div class="alert info">Sent again' +
        (r && r.phoneNumber ? ' to ' + esc(r.phoneNumber) : '') + '.</div>';
      button.disabled = false;
    }).catch(function (err) {
      showAuthError(err.message);
      button.disabled = false;
    });
  };

  $('#auth-form').onsubmit = async function (event) {
    event.preventDefault();
    var button = $('#auth-form button');
    button.disabled = true;
    showAuthError('');

    try {
      await post('/api/auth/phone/verify-code', { code: $('#f-code').value.trim() });
      // The gate is lifted from this point, so the ordinary entry path works.
      await loadSession();
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
      button.disabled = false;
    }
  };
}

function renderForgotPassword() {
  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' + brandMarkup() +
      '<h1>Reset your password</h1>' +
      '<p class="sub">We will email you a link to choose a new one.</p>' +
      '<div id="auth-error"></div>' +
      '<form id="auth-form">' + field('email', 'Email', 'email', '') +
        '<button class="btn block" type="submit">Send reset link</button></form>' +
      '<div class="auth-switch"><button id="switch">Back to sign in</button></div>' +
    '</div></div>';

  $('#switch').onclick = () => { state.authMode = 'signin'; renderAuth(); };
  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#auth-form button');
    button.disabled = true;
    try {
      await post('/api/auth/password/forgot', { email: $('#f-email').value.trim() });
      // Deliberately the same whether or not the address is registered - see
      // the enumeration note in auth.service.ts.
      $('#auth-error').innerHTML =
        '<div class="alert info">If that address has an account, a reset link is on its way. ' +
        'The link is valid for one hour.</div>';
    } catch (err) {
      showAuthError(err.message);
      button.disabled = false;
    }
  };
}

/**
 * Reset by WhatsApp code.
 *
 * One screen for both halves - request the code, then set the password - rather
 * than two. The number is already typed in by the time the code arrives, and a
 * second screen would ask for it again or carry it in a URL, neither of which
 * is better than keeping it on screen.
 */
function renderForgotByPhone() {
  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' + brandMarkup() +
      '<h1>Reset your password</h1>' +
      '<p class="sub">We will send a code to your WhatsApp number.</p>' +
      '<div id="auth-error"></div>' +
      '<form id="request-form">' +
        field('phoneNumber', 'WhatsApp number', 'tel', 'With country code, e.g. 919876543210') +
        '<button class="btn block" type="submit">Send code</button>' +
      '</form>' +
      '<div id="stage-two" style="display:none">' +
        '<div class="divider">then</div>' +
        '<form id="auth-form">' +
          '<div class="field"><label for="f-code">Code</label>' +
            '<input id="f-code" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
                   'maxlength="6" pattern="[0-9]{6}" required></div>' +
          field('password', 'New password', 'password',
                'At least ' + state.config.passwordMinLength + ' characters') +
          '<button class="btn block" type="submit">Set password</button>' +
        '</form>' +
      '</div>' +
      '<div class="auth-switch"><button id="switch">Back to sign in</button></div>' +
    '</div></div>';

  $('#switch').onclick = function () { state.authMode = 'signin'; renderAuth(); };

  $('#request-form').onsubmit = async function (event) {
    event.preventDefault();
    var button = $('#request-form button');
    button.disabled = true;
    showAuthError('');
    try {
      await post('/api/auth/password/forgot-phone', {
        phoneNumber: $('#f-phoneNumber').value.trim(),
      });
      // Identical whether or not that number has an account - see the
      // enumeration note on the endpoint.
      $('#auth-error').innerHTML =
        '<div class="alert info">If that number has an account, a code is on its way. ' +
        'It expires in ten minutes.</div>';
      $('#stage-two').style.display = 'block';
    } catch (err) {
      showAuthError(err.message);
    }
    button.disabled = false;
  };

  $('#auth-form').onsubmit = async function (event) {
    event.preventDefault();
    var button = $('#auth-form button');
    button.disabled = true;
    showAuthError('');
    try {
      await post('/api/auth/password/reset-phone', {
        phoneNumber: $('#f-phoneNumber').value.trim(),
        code: $('#f-code').value.trim(),
        password: $('#f-password').value,
      });
      // Every session was revoked, including any the attacker held, so this
      // ends at the sign-in form rather than inside the app.
      state.authMode = 'signin';
      renderAuth();
      $('#auth-error').innerHTML =
        '<div class="alert info">Password updated. Sign in with your new password.</div>';
    } catch (err) {
      showAuthError(err.message);
      button.disabled = false;
    }
  };
}

function renderResetPassword() {
  const token = new URLSearchParams(location.search).get('token') || '';

  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' + brandMarkup() +
      '<h1>Choose a new password</h1>' +
      '<p class="sub">You will be signed out of every other device.</p>' +
      '<div id="auth-error"></div>' +
      '<form id="auth-form">' +
        field('password', 'New password', 'password',
              'At least ' + state.config.passwordMinLength + ' characters') +
        '<button class="btn block" type="submit">Set password</button></form>' +
    '</div></div>';

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#auth-form button');
    button.disabled = true;
    try {
      await post('/api/auth/password/reset', { token, password: $('#f-password').value });
      $('#auth-error').innerHTML =
        '<div class="alert info">Password changed. <a href="/app">Sign in</a>.</div>';
      $('#auth-form').style.display = 'none';
    } catch (err) {
      showAuthError(err.message);
      button.disabled = false;
    }
  };
}

async function renderVerifyEmail() {
  const token = new URLSearchParams(location.search).get('token') || '';
  document.body.innerHTML =
    '<div id="auth"><div class="auth-card">' + brandMarkup() +
      '<h1>Confirming your email</h1><div id="auth-error"></div></div></div>';

  try {
    await post('/api/auth/email/verify', { token });
    $('#auth-error').innerHTML =
      '<div class="alert info">Your email is confirmed. <a href="/app">Continue</a>.</div>';
  } catch (err) {
    showAuthError(err.message + ' You can request a new link from your account settings.');
  }
}

// ============================================================================
// App shell
// ============================================================================

async function enterApp() {
  document.body.innerHTML =
    '<div id="app" class="ready">' +
      '<aside class="sidebar" id="sidebar">' +
        '<div class="sidebar-head">' + brandMarkup() +
          '<button class="btn block" id="new-chat">New chat</button>' +
        '</div>' +
        '<div class="thread-list" id="thread-list"></div>' +
        '<div class="sidebar-foot">' +
          '<button class="credit-chip" id="credit-chip"></button>' +
          '<button class="account-btn" id="account-btn"></button>' +
        '</div>' +
      '</aside>' +
      '<main class="main">' +
        '<div class="topbar">' +
          '<button class="hamburger" id="hamburger" aria-label="Menu">' + ICON_MENU + '</button>' +
          '<div class="thread-title" id="thread-title">New chat</div>' +
          '<button class="btn ghost small" id="theme-toggle" aria-label="Theme">' + ICON_THEME + '</button>' +
        '</div>' +
        '<div class="messages" id="messages"><div class="messages-inner" id="messages-inner"></div></div>' +
        '<div class="composer-wrap"><div class="composer-inner">' +
          '<div class="composer">' +
            '<textarea id="composer" rows="1" placeholder="Ask about a section, a judgment, or paste a CNR…"></textarea>' +
            '<button class="send-btn" id="send" aria-label="Send">' + ICON_SEND + '</button>' +
          '</div>' +
          '<div class="composer-note">Vakeel Saathi assists with research. It is not legal advice, ' +
            'and every citation should be verified before it is relied on in court.</div>' +
        '</div></div>' +
      '</main>' +
    '</div>';

  $('#new-chat').onclick = startNewChat;
  $('#hamburger').onclick = toggleSidebar;
  $('#theme-toggle').onclick = toggleTheme;
  $('#account-btn').onclick = openAccount;
  $('#credit-chip').onclick = openCredits;
  $('#send').onclick = submitQuestion;

  const composer = $('#composer');
  composer.addEventListener('input', autoGrow);
  composer.addEventListener('keydown', (event) => {
    // Enter sends, Shift+Enter breaks the line. The convention every chat
    // client uses, and the one people's fingers already expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitQuestion();
    }
  });

  renderAccountButton();
  renderCredits();
  await loadThreads();
  renderMessages();
  composer.focus();
}

function autoGrow() {
  const node = $('#composer');
  node.style.height = 'auto';
  node.style.height = Math.min(node.scrollHeight, 190) + 'px';
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  $('#sidebar').classList.toggle('open', state.sidebarOpen);

  const existing = $('.scrim');
  if (existing) existing.remove();

  if (state.sidebarOpen) {
    const scrim = el('div', 'scrim');
    scrim.onclick = toggleSidebar;
    document.body.appendChild(scrim);
  }
}

// ============================================================================
// Threads
// ============================================================================

async function loadThreads() {
  try {
    state.threads = await api('/api/chat/threads');
  } catch (_) {
    state.threads = [];
  }
  renderThreadList();
}

function renderThreadList() {
  const list = $('#thread-list');
  list.innerHTML = '';

  if (!state.threads.length) {
    const empty = el('div', 'thread-group-label', 'No conversations yet');
    list.appendChild(empty);
    return;
  }

  // Grouped by recency, which is how someone actually looks for a conversation
  // they had - "it was yesterday" rather than "it was the ninth".
  const groups = { Today: [], Yesterday: [], 'Previous 30 days': [], Older: [] };
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  for (const thread of state.threads) {
    const when = new Date(thread.lastMessageAt).getTime();
    if (when >= startOfToday) groups.Today.push(thread);
    else if (when >= startOfToday - 86400000) groups.Yesterday.push(thread);
    else if (when >= startOfToday - 30 * 86400000) groups['Previous 30 days'].push(thread);
    else groups.Older.push(thread);
  }

  for (const label of Object.keys(groups)) {
    if (!groups[label].length) continue;
    list.appendChild(el('div', 'thread-group-label', label));

    for (const thread of groups[label]) {
      const button = el('button', 'thread' + (thread.id === state.threadId ? ' active' : ''));
      button.appendChild(el('span', 'title', thread.title));

      const menu = el('span', 'menu-btn', '⋯');
      menu.title = 'Rename or delete';
      menu.onclick = (event) => { event.stopPropagation(); openThreadMenu(thread); };
      button.appendChild(menu);

      button.onclick = () => openThread(thread.id);
      list.appendChild(button);
    }
  }
}

async function openThread(threadId) {
  if (state.busy) return;
  if (state.sidebarOpen) toggleSidebar();

  state.threadId = threadId;
  renderThreadList();

  try {
    const thread = await api('/api/chat/threads/' + encodeURIComponent(threadId));
    state.messages = thread.messages;
    $('#thread-title').textContent = thread.title;
  } catch (_) {
    state.messages = [];
  }

  renderMessages();
}

function startNewChat() {
  if (state.busy) return;
  if (state.sidebarOpen) toggleSidebar();

  // No request is made. The thread is created server-side by the first
  // question, so pressing New chat repeatedly cannot litter the sidebar with
  // empty conversations.
  state.threadId = null;
  state.messages = [];
  $('#thread-title').textContent = 'New chat';
  renderThreadList();
  renderMessages();
  $('#composer').focus();
}

function openThreadMenu(thread) {
  showModal('Conversation', (body, close) => {
    const rename = el('div', 'field');
    rename.innerHTML = '<label for="rename">Name</label>' +
      '<input id="rename" type="text" value="' + esc(thread.title) + '">';
    body.appendChild(rename);

    const save = el('button', 'btn', 'Save name');
    save.onclick = async () => {
      const title = $('#rename').value.trim();
      if (!title) return;
      await api('/api/chat/threads/' + encodeURIComponent(thread.id), {
        method: 'PATCH', body: JSON.stringify({ title }),
      });
      thread.title = title;
      if (state.threadId === thread.id) $('#thread-title').textContent = title;
      renderThreadList();
      close();
    };
    body.appendChild(save);

    const section = el('div', 'modal-section');
    section.style.marginTop = '26px';
    section.appendChild(el('h3', null, 'Remove'));

    const note = el('p', null,
      'Deleting removes this conversation from your sidebar. It is not shared with anyone else.');
    note.style.cssText = 'font-size:13px;color:var(--muted);margin:0 0 12px';
    section.appendChild(note);

    const remove = el('button', 'btn danger', 'Delete conversation');
    remove.onclick = async () => {
      await api('/api/chat/threads/' + encodeURIComponent(thread.id), { method: 'DELETE' });
      state.threads = state.threads.filter((t) => t.id !== thread.id);
      if (state.threadId === thread.id) startNewChat();
      else renderThreadList();
      close();
    };
    section.appendChild(remove);
    body.appendChild(section);
  });
}

// ============================================================================
// Asking, and reading the stream
// ============================================================================

const STAGE_LABELS = {
  classifying: 'Understanding the question',
  'looking-up': 'Looking up the court record',
  searching: 'Searching judgments',
  retrieving: 'Searching the corpus',
  generating: 'Writing the answer',
  verifying: 'Verifying every citation',
};

async function submitQuestion() {
  if (state.busy) return;

  const composer = $('#composer');
  const question = composer.value.trim();
  if (!question) return;

  composer.value = '';
  autoGrow();
  setBusy(true);

  // Shown immediately, before the server confirms, so the interface responds to
  // the keypress rather than to the network. Replaced by the persisted message
  // when it arrives.
  state.messages.push({
    id: 'pending', role: 'user', content: question, citations: [], structured: null,
  });
  renderMessages();

  const live = { stages: [], done: false };
  renderLiveStages(live);

  try {
    const response = await fetch('/api/chat/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ threadId: state.threadId, question }),
    });

    if (!response.ok || !response.body) {
      const failure = await response.json().catch(() => null);
      throw new Error((failure && failure.error && failure.error.message) || 'Could not send that.');
    }

    await readEventStream(response.body, (event) => handleChatEvent(event, live));
  } catch (err) {
    live.done = true;
    state.messages.push({
      id: 'error-' + Date.now(), role: 'assistant', content: err.message,
      citations: [], structured: null, error: 'client',
    });
    renderMessages();
  } finally {
    setBusy(false);
    removeLiveStages();
    renderMessages();
  }
}

/**
 * Read a text/event-stream response body from fetch.
 *
 * EventSource would do this natively and only issues GETs, which would put the
 * advocate's legal question into the URL - and from there into access logs,
 * browser history and every proxy on the path. This is the cost of keeping it
 * in a POST body, and it is a small one.
 */
async function readEventStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });

    // Frames are separated by a blank line. A chunk can split one anywhere, so
    // the tail is kept in the buffer until its terminator arrives - parsing per
    // chunk instead would drop or corrupt any event unlucky enough to straddle
    // a TCP boundary, which is exactly the kind of bug that only appears under
    // real network conditions.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (line) {
        try { onEvent(JSON.parse(line.slice(5).trim())); }
        catch (_) { /* a truncated frame is not worth failing the stream over */ }
      }

      split = buffer.indexOf('\n\n');
    }
  }
}

function handleChatEvent(event, live) {
  if (event.type === 'thread') {
    const isNew = state.threadId !== event.threadId;
    state.threadId = event.threadId;
    $('#thread-title').textContent = event.title;
    if (isNew) void loadThreads();
    return;
  }

  if (event.type === 'message') {
    const pending = state.messages.findIndex((m) => m.id === 'pending');
    if (pending !== -1 && event.message.role === 'user') state.messages[pending] = event.message;
    else state.messages.push(event.message);
    renderMessages();
    renderLiveStages(live);
    return;
  }

  if (event.type === 'stage') {
    live.stages.push(event.stage);
    renderLiveStages(live);
    return;
  }

  if (event.type === 'answer') {
    live.done = true;
    state.messages.push(event.message);
    state.credits = event.credits;
    renderCredits();
    return;
  }

  if (event.type === 'error') {
    live.done = true;
    if (event.credits) { state.credits = event.credits; renderCredits(); }
    state.messages.push({
      id: 'error-' + Date.now(), role: 'assistant', content: event.message,
      citations: [], structured: null, error: event.code,
    });
  }
}

function setBusy(busy) {
  state.busy = busy;
  $('#send').disabled = busy;
  $('#composer').disabled = busy;
}

function renderLiveStages(live) {
  removeLiveStages();
  if (live.done) return;

  const wrap = el('div', 'msg assistant');
  wrap.id = 'live-stages';
  wrap.appendChild(el('div', 'who-mark', 'VS'));

  const body = el('div', 'body');
  const stages = el('div', 'stages');

  live.stages.forEach((stage, index) => {
    const isLast = index === live.stages.length - 1;
    const line = el('div', 'stage-line' + (isLast ? '' : ' done'));
    line.appendChild(isLast ? el('div', 'spinner') : tickIcon());
    line.appendChild(el('span', null, STAGE_LABELS[stage] || stage));
    stages.appendChild(line);
  });

  if (!live.stages.length) {
    const line = el('div', 'stage-line');
    line.appendChild(el('div', 'spinner'));
    line.appendChild(el('span', null, 'Thinking'));
    stages.appendChild(line);
  }

  body.appendChild(stages);
  wrap.appendChild(body);
  $('#messages-inner').appendChild(wrap);
  scrollToBottom();
}

function removeLiveStages() {
  const existing = $('#live-stages');
  if (existing) existing.remove();
}

function tickIcon() {
  const span = el('span', 'tick');
  span.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M3 8.5 6.5 12 13 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}

// ============================================================================
// Rendering messages
// ============================================================================

function renderMessages() {
  const inner = $('#messages-inner');
  if (!inner) return;
  inner.innerHTML = '';

  if (!state.messages.length) {
    inner.appendChild(emptyState());
    return;
  }

  for (const message of state.messages) inner.appendChild(renderMessage(message));
  scrollToBottom();
}

function emptyState() {
  const wrap = el('div', 'empty');
  const name = state.user && state.user.fullName ? state.user.fullName.split(' ')[0] : null;

  wrap.appendChild(el('h2', null, name ? 'Namaste, ' + name : 'Namaste'));
  wrap.appendChild(el('p', null, 'Ask a legal question, look up a section, or check a case by its CNR.'));

  const suggestions = el('div', 'suggestions');

  /*
   * Each card shows a complete example and types back only its opening.
   *
   * Submitting the example outright, which is what these used to do, answers a
   * question nobody asked - and spends a credit doing it. The example is worth
   * showing because it teaches the shape of a good question; it is not worth
   * sending, because the advocate has their own matter in mind and the card
   * knows nothing about it.
   *
   * So the third field is where the sentence stops being generic. "What is
   * section " is true of every section lookup; "420 IPC" is the part only the
   * advocate can supply, and the cursor is left exactly there.
   */
  const examples = [
    ['Section lookup', 'What is section 420 IPC and is it bailable?', 'What is section '],
    ['Case law', 'Recent Supreme Court judgments on anticipatory bail', 'Judgments on '],
    ['Case status', 'Check the status of CNR DLCT010012342024', 'Check the status of CNR '],
    ['Drafting', 'Key points for a Section 138 NI Act legal notice', 'Key points for a '],
  ];

  for (const [label, text, starter] of examples) {
    const button = el('button', 'suggestion');
    button.appendChild(el('b', null, label));
    button.appendChild(document.createTextNode(text));
    button.onclick = () => {
      const box = $('#composer');
      box.value = starter;
      autoGrow();
      // Focus before moving the caret: a textarea that is not focused reports a
      // selection but does not show one, so the advocate would be typing into
      // a box with no visible cursor.
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
    suggestions.appendChild(button);
  }

  wrap.appendChild(suggestions);
  return wrap;
}

function renderMessage(message) {
  const wrap = el('div', 'msg ' + message.role);

  const mark = el('div', 'who-mark');
  mark.textContent = message.role === 'user' ? initials(state.user) : 'VS';
  wrap.appendChild(mark);

  const body = el('div', 'body');
  const structured = message.structured;

  if (structured && structured.kind === 'precedents') {
    body.appendChild(renderPrecedents(structured, message));
  } else if (structured && structured.kind === 'caseStatus') {
    body.appendChild(renderCaseStatus(structured));
  } else {
    body.innerHTML = renderRichText(message.content);
  }

  if (structured && structured.kind === 'answer') {
    if (structured.mocked) {
      const warning = el('div', 'alert warn');
      warning.style.marginTop = '13px';
      warning.textContent =
        'No AI provider is configured on this deployment, so this is placeholder text — ' +
        'not legal research. Set an API key to get real answers.';
      body.appendChild(warning);
    }
    if (structured.sources && structured.sources.length) {
      body.appendChild(renderSources(structured.sources));
    }
    body.appendChild(caveatNote());
  }

  if (message.role === 'assistant' && !message.error) {
    body.appendChild(messageMeta(message));
  }

  wrap.appendChild(body);
  return wrap;
}

function messageMeta(message) {
  const meta = el('div', 'msg-meta');

  const copy = el('button', 'copy-btn', 'Copy');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    } catch (_) {
      copy.textContent = 'Press Ctrl+C';
    }
  };
  meta.appendChild(copy);

  if (message.creditsCharged > 0) {
    meta.appendChild(el('span', 'cost',
      message.creditsCharged + ' credit' + (message.creditsCharged === 1 ? '' : 's')));
  }

  if (message.guardrailFlagged) {
    const flag = el('span', 'pill bad', 'Citation removed');
    flag.title =
      'One or more citations in this answer could not be found in the corpus and were removed.';
    meta.appendChild(flag);
  }

  return meta;
}

function caveatNote() {
  return el('div', 'caveat',
    'This is research assistance, not legal advice. Verify every citation against the ' +
    'official reporter before relying on it.');
}

function renderSources(sources) {
  const details = el('details', 'sources');
  details.appendChild(el('summary', null,
    'Sources consulted (' + sources.length + ')'));

  const list = el('ul');
  for (const source of sources) {
    const parts = [source.caseTitle];
    if (source.citation) parts.push(source.citation);
    if (source.court) parts.push(source.court);
    if (source.paragraph) parts.push('para ' + source.paragraph);
    list.appendChild(el('li', null, parts.filter(Boolean).join(' — ')));
  }

  details.appendChild(list);
  return details;
}

function renderPrecedents(data, message) {
  const wrap = el('div');

  // Nothing found. The server has already refunded the credits and worded the
  // message for the actual cause, so it is shown as-is rather than replaced
  // with a generic line that would contradict it.
  if (!data.items.length) {
    const note = el('div', 'alert ' + (data.emptyReason === 'no-corpus' ? 'warn' : 'info'));
    note.textContent = message.content;
    wrap.appendChild(note);

    if (data.emptyReason === 'no-corpus') {
      const how = el('div', 'caveat');
      how.textContent =
        'Case-law search needs either an ingested judgment corpus or an Indian Kanoon API key. ' +
        'Section lookups and case status work without either.';
      wrap.appendChild(how);
    }
    return wrap;
  }

  const heading = el('div');
  heading.style.cssText = 'margin-bottom:13px;font-size:13.5px;color:var(--muted)';
  heading.textContent =
    data.items.length + ' of ' + data.totalMatches + ' matching judgments for "' + data.query + '"';
  wrap.appendChild(heading);

  // Both of these change how much weight the results deserve, so they are shown
  // rather than kept in a log. A keyword-only search on a corpus with no
  // embeddings finds different cases than a semantic one, and an advocate
  // deciding whether the list is exhaustive needs to know which they got.
  if (data.lexicalOnly) {
    const note = el('div', 'alert warn');
    note.textContent =
      'Keyword search only — no embedding provider is configured, so semantically ' +
      'similar judgments phrased differently may be missing.';
    wrap.appendChild(note);
  }

  for (const item of data.items) wrap.appendChild(renderPrecedentCard(item));

  if (data.items.length) {
    const source = el('div', 'caveat');
    source.textContent = data.source === 'kanoon'
      ? 'Results from Indian Kanoon. Verify each citation against the official reporter.'
      : 'Results from the ingested judgment corpus. Verify each citation against the official reporter.';
    wrap.appendChild(source);
  }

  return wrap;
}

function renderPrecedentCard(item) {
  const card = el('div', 'precedent');
  card.appendChild(el('div', 'case-title', item.title));

  const meta = el('div', 'case-meta');
  if (item.citation) meta.appendChild(el('span', 'pill good', item.citation));
  if (item.court) meta.appendChild(el('span', 'pill', item.court));
  if (item.date) meta.appendChild(el('span', 'pill', formatDate(item.date)));
  if (item.benchStrength > 1) {
    meta.appendChild(el('span', 'pill', item.benchStrength + '-judge bench'));
  }
  if (item.disposition) meta.appendChild(el('span', 'pill', item.disposition));
  card.appendChild(meta);

  if (item.holding) {
    const holding = el('div', 'holding');
    holding.innerHTML = '<b>Holding:</b> ' + esc(item.holding);
    card.appendChild(holding);
  }

  if (item.excerpt && item.excerpt !== item.holding) {
    const excerpt = el('div', 'excerpt', item.excerpt);
    if (item.paragraph) excerpt.title = 'Paragraph ' + item.paragraph;
    card.appendChild(excerpt);
  }

  if (item.sections && item.sections.length) {
    const sections = el('div', 'sections');
    for (const section of item.sections.slice(0, 8)) {
      sections.appendChild(el('span', 'pill', section));
    }
    card.appendChild(sections);
  }

  return card;
}

function renderCaseStatus(data) {
  const card = el('div', 'case-card');

  const head = el('div', 'head');
  head.appendChild(el('div', 'cnr', data.cnr));
  head.appendChild(el('div', 'parties',
    [data.petitioner, data.respondent].filter(Boolean).join(' vs ') || 'Case record'));
  card.appendChild(head);

  const rows = el('dl', 'case-rows');
  const fields = [
    ['Status', data.status],
    ['Stage', data.stage],
    ['Court', data.court],
    ['Judge', data.judge],
    ['Case number', data.caseNumber],
    ['Filed', data.filingDate],
    ['Next hearing', data.nextHearingDate],
    ['Last hearing', data.lastHearingDate],
    ['Petitioner advocate', data.petitionerAdvocate],
    ['Respondent advocate', data.respondentAdvocate],
  ];

  for (const [label, value] of fields) {
    if (!value) continue;
    rows.appendChild(el('dt', null, label));
    rows.appendChild(el('dd', null, value));
  }
  card.appendChild(rows);

  const wrap = el('div');
  wrap.appendChild(card);

  // The mock adapter produces plausible-looking case records. An advocate must
  // never mistake one for a court record, so this is stated at full strength
  // rather than as a footnote.
  if (data.mocked) {
    const warning = el('div', 'alert warn');
    warning.style.marginTop = '13px';
    warning.textContent =
      'This is sample data, not a real court record. eCourts is running in mock mode ' +
      'on this deployment.';
    wrap.appendChild(warning);
  }

  return wrap;
}

/**
 * Render the model's lightly-marked-up text.
 *
 * Escapes first, then adds markup - never the reverse. Doing it the other way
 * round means the escaper runs over tags this function just inserted, or worse,
 * that a bold marker inside attacker-influenced text closes an attribute. The
 * input here has passed through an LLM, so it is untrusted by definition.
 */
function renderRichText(text) {
  const lines = esc(text || '').split('\n');
  const out = [];
  let inList = false;

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) { closeList(); continue; }

    // A whole line wrapped in asterisks is a heading in the format the prompts
    // ask the model for. WhatsApp renders it bold; here it earns a real
    // heading element, which is also what a screen reader needs.
    const heading = /^\*([^*]+)\*:?$/.exec(line);
    if (heading) {
      closeList();
      out.push('<h3>' + inline(heading[1]) + '</h3>');
      continue;
    }

    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(bullet[1]) + '</li>');
      continue;
    }

    closeList();
    out.push('<p>' + inline(line) + '</p>');
  }

  closeList();
  return out.join('');
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // \x60 is a backtick. Written as an escape because this whole file is a
    // String.raw template literal, and a literal backtick would end it.
    .replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
}

function scrollToBottom() {
  const box = $('#messages');
  if (box) box.scrollTop = box.scrollHeight;
}

// ============================================================================
// Credits
// ============================================================================

function renderCredits() {
  const chip = $('#credit-chip');
  if (!chip || !state.credits) return;

  chip.innerHTML = '';
  const left = el('div');

  if (state.credits.unlimited) {
    left.appendChild(el('div', 'amount', 'Unlimited'));
    left.appendChild(el('div', 'label', 'Verified advocate'));
  } else {
    left.appendChild(el('div', 'amount', String(state.credits.total)));
    left.appendChild(el('div', 'label',
      state.credits.paid > 0
        ? state.credits.free + ' free + ' + state.credits.paid + ' purchased'
        : 'credits left this month'));
  }

  chip.appendChild(left);
  chip.appendChild(el('span', 'pill', 'History'));
}

async function openCredits() {
  showModal('Credits', async (body) => {
    body.appendChild(el('div', null, 'Loading…'));

    const data = await api('/api/chat/credits');
    body.innerHTML = '';

    const summary = el('div', 'modal-section');
    if (data.balance.unlimited) {
      const box = el('div', 'alert info');
      box.textContent =
        'Your account is verified, so searches are unlimited and nothing is deducted.';
      summary.appendChild(box);
    } else {
      const grid = el('div');
      grid.style.cssText = 'display:flex;gap:12px;margin-bottom:6px';

      grid.appendChild(statBox(data.balance.free, 'free this month',
        data.balance.resetsInDays === 1
          ? 'Resets to ' + data.balance.monthlyAllowance + ' tomorrow'
          : 'Resets to ' + data.balance.monthlyAllowance + ' in ' + data.balance.resetsInDays + ' days'));
      grid.appendChild(statBox(data.balance.paid, 'purchased', 'Never expire'));
      summary.appendChild(grid);

      const note = el('p', null,
        'Every question costs 1 credit. Checking a case by CNR is always free. ' +
        'Free credits are used before purchased ones.');
      note.style.cssText = 'font-size:12.5px;color:var(--muted);margin:12px 0 0;line-height:1.6';
      summary.appendChild(note);
    }
    body.appendChild(summary);

    if (state.capabilities && state.capabilities.payments) {
      const buy = el('button', 'btn block', 'Buy more credits');
      buy.onclick = () => alert('Checkout opens here once Razorpay keys are set.');
      body.appendChild(buy);
    }

    const history = el('div', 'modal-section');
    history.appendChild(el('h3', null, 'History'));

    if (!data.history.length) {
      history.appendChild(el('p', null, 'Nothing yet.'));
    } else {
      const ledger = el('div', 'ledger');
      for (const entry of data.history) {
        const row = el('div', 'entry');
        row.appendChild(el('div', 'delta ' + (entry.delta > 0 ? 'plus' : 'minus'),
          (entry.delta > 0 ? '+' : '') + entry.delta));

        const what = el('div', 'what');
        what.appendChild(el('div', null, entry.reason || entry.kind));
        row.appendChild(what);
        row.appendChild(el('div', 'when', formatDateTime(entry.createdAt)));
        ledger.appendChild(row);
      }
      history.appendChild(ledger);
    }
    body.appendChild(history);
  });
}

function statBox(value, label, hint) {
  const box = el('div');
  box.style.cssText =
    'flex:1;border:1px solid var(--border);border-radius:var(--radius);padding:14px;background:var(--surface-2)';
  const amount = el('div', null, String(value));
  amount.style.cssText = 'font-size:26px;font-weight:700;line-height:1';
  box.appendChild(amount);
  box.appendChild(el('div', 'label', label));
  const hintNode = el('div', null, hint);
  hintNode.style.cssText = 'font-size:11.5px;color:var(--dim);margin-top:6px';
  box.appendChild(hintNode);
  return box;
}

// ============================================================================
// Account
// ============================================================================

function renderAccountButton() {
  const button = $('#account-btn');
  button.innerHTML = '';

  const avatar = el('div', 'avatar');
  if (state.user.avatarUrl) {
    const img = document.createElement('img');
    img.src = state.user.avatarUrl;
    img.className = 'avatar';
    img.alt = '';
    button.appendChild(img);
  } else {
    avatar.textContent = initials(state.user);
    button.appendChild(avatar);
  }

  const who = el('div', 'who');
  who.appendChild(el('b', null, state.user.fullName || 'Your account'));
  who.appendChild(el('span', null, state.user.email || state.user.phoneNumber || ''));
  button.appendChild(who);
}

function openAccount() {
  showModal('Account', async (body, close) => {
    const tabs = ['Profile', 'WhatsApp', 'Security'];
    let active = 'Profile';

    const bar = el('div', 'tabs');
    bar.style.cssText = 'padding:0;margin:-4px 0 18px';
    const panel = el('div');

    const draw = () => {
      bar.innerHTML = '';
      for (const name of tabs) {
        const tab = el('button', 'tab' + (name === active ? ' active' : ''), name);
        tab.onclick = () => { active = name; draw(); };
        bar.appendChild(tab);
      }

      panel.innerHTML = '';
      if (active === 'Profile') renderProfileTab(panel, close);
      if (active === 'WhatsApp') void renderWhatsAppTab(panel);
      if (active === 'Security') void renderSecurityTab(panel);
    };

    body.appendChild(bar);
    body.appendChild(panel);
    draw();
  });
}

function renderProfileTab(panel, close) {
  const user = state.user;

  const rows = el('div');
  rows.appendChild(infoRow('Name', user.fullName || 'Not set'));
  rows.appendChild(infoRow('Email', user.email || 'Not set',
    user.email ? (user.emailVerified ? 'Confirmed' : 'Unconfirmed') : null,
    user.email && !user.emailVerified));
  rows.appendChild(infoRow('WhatsApp', user.phoneNumber || 'Not linked',
    user.phoneVerified ? 'Verified' : null, false));
  rows.appendChild(infoRow('Practice', [user.city, user.state].filter(Boolean).join(', ') || 'Not set'));
  rows.appendChild(infoRow('Bar Council ID', user.barCouncilOnRecord ? 'On record' : 'Not submitted'));
  rows.appendChild(infoRow('Account status',
    user.verificationStatus === 'VERIFIED' ? 'Verified advocate' : 'Guest'));
  panel.appendChild(rows);

  if (user.email && !user.emailVerified && state.capabilities.emailRecovery) {
    const resend = el('button', 'btn secondary small', 'Resend confirmation email');
    resend.style.marginTop = '14px';
    resend.onclick = async () => {
      resend.disabled = true;
      const result = await post('/api/auth/email/resend');
      resend.textContent = result.sent ? 'Sent — check your inbox' : 'Email is not configured';
    };
    panel.appendChild(resend);
  }

  if (user.verificationStatus !== 'VERIFIED') {
    const note = el('div', 'alert info');
    note.style.marginTop = '18px';
    note.textContent =
      'Verified advocates get unlimited searches. Send "verify" to the bot on WhatsApp ' +
      'with your Bar Council enrolment number to start.';
    panel.appendChild(note);
  }

  const out = el('button', 'btn secondary block', 'Sign out');
  out.style.marginTop = '22px';
  out.onclick = async () => {
    await post('/api/auth/logout');
    location.href = '/app';
  };
  panel.appendChild(out);
}

function infoRow(label, value, badge, badgeBad) {
  const row = el('div', 'row');
  const grow = el('div', 'grow');
  grow.appendChild(el('b', null, label));
  grow.appendChild(el('span', null, value));
  row.appendChild(grow);
  if (badge) row.appendChild(el('span', 'pill ' + (badgeBad ? 'bad' : 'good'), badge));
  return row;
}

async function renderWhatsAppTab(panel) {
  const status = await api('/api/auth/phone/status');

  if (status.linked) {
    const done = el('div', 'alert info');
    done.textContent = 'This account is linked to ' + status.phoneNumber +
      '. Credits and history are shared between WhatsApp and the web.';
    panel.appendChild(done);
    return;
  }

  const intro = el('p', null,
    'Link your WhatsApp number so both channels share one balance and one history. ' +
    'You will send a code from your phone — that is what proves the number is yours.');
  intro.style.cssText = 'font-size:13.5px;color:var(--muted);margin:0 0 16px;line-height:1.6';
  panel.appendChild(intro);

  const form = el('div', 'field');
  form.innerHTML = '<label for="phone">WhatsApp number</label>' +
    '<input id="phone" type="tel" inputmode="numeric" placeholder="919876543210">' +
    '<div class="hint">International format, digits only — country code first.</div>';
  panel.appendChild(form);

  const start = el('button', 'btn', 'Get a code');
  const result = el('div');
  result.style.marginTop = '16px';

  start.onclick = async () => {
    start.disabled = true;
    result.innerHTML = '';

    try {
      const link = await post('/api/auth/phone/start', { phoneNumber: $('#phone').value });

      const code = el('div', 'code-display', link.code);
      result.appendChild(code);

      const steps = el('ol', 'steps');
      const target = link.botNumber
        ? 'the Vakeel Saathi bot on WhatsApp (' + link.botNumber + ')'
        : 'the Vakeel Saathi bot on WhatsApp';
      steps.appendChild(el('li', null, 'Open WhatsApp on ' + link.phoneNumber + '.'));
      steps.appendChild(el('li', null, 'Send this code to ' + target + '.'));
      steps.appendChild(el('li', null, 'Come back here — the link happens as soon as it arrives.'));
      result.appendChild(steps);

      if (link.botNumber) {
        const open = document.createElement('a');
        open.className = 'btn block';
        open.href = 'https://wa.me/' + encodeURIComponent(link.botNumber) +
          '?text=' + encodeURIComponent(link.code);
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = 'Open WhatsApp with the code';
        result.appendChild(open);
      } else if (!link.whatsappConfigured) {
        const warn = el('div', 'alert warn');
        warn.textContent =
          'WhatsApp is not configured on this deployment, so the bot cannot receive your code yet.';
        result.appendChild(warn);
      }

      const expiry = el('p', null, 'The code expires in 15 minutes.');
      expiry.style.cssText = 'font-size:12px;color:var(--dim);text-align:center;margin-top:12px';
      result.appendChild(expiry);

      pollPhoneLink(result);
    } catch (err) {
      const error = el('div', 'alert error', err.message);
      result.appendChild(error);
      start.disabled = false;
    }
  };

  panel.appendChild(start);
  panel.appendChild(result);
}

/**
 * Watch for the code arriving over WhatsApp.
 *
 * Polled rather than pushed: the linking happens in the queue worker when the
 * message is processed, and a websocket to carry one boolean for two minutes is
 * not worth the connection. Stops itself after five minutes so a forgotten tab
 * does not poll forever.
 */
function pollPhoneLink(container) {
  const started = Date.now();

  const timer = setInterval(async () => {
    if (Date.now() - started > 300000) return clearInterval(timer);

    try {
      const status = await api('/api/auth/phone/status');
      if (!status.linked) return;

      clearInterval(timer);
      container.innerHTML = '';

      const done = el('div', 'alert info');
      done.textContent = 'Linked. Your WhatsApp and web account now share one balance.';
      container.appendChild(done);

      // The merge may have moved this browser onto a different account row, so
      // the cached user is refreshed rather than patched.
      const me = await api('/api/auth/me');
      state.user = me.user;
      state.credits = me.credits;
      renderAccountButton();
      renderCredits();
      void loadThreads();
    } catch (_) { /* transient; the next tick retries */ }
  }, 3000);
}

async function renderSecurityTab(panel) {
  const change = el('div', 'modal-section');
  change.appendChild(el('h3', null, 'Password'));

  const form = el('div');
  form.innerHTML =
    '<div class="field"><label for="cur">Current password</label>' +
    '<input id="cur" type="password" autocomplete="current-password"></div>' +
    '<div class="field"><label for="next">New password</label>' +
    '<input id="next" type="password" autocomplete="new-password">' +
    '<div class="hint">At least ' + state.config.passwordMinLength + ' characters.</div></div>';
  change.appendChild(form);

  const save = el('button', 'btn', 'Change password');
  const feedback = el('div');
  feedback.style.marginTop = '10px';

  save.onclick = async () => {
    save.disabled = true;
    feedback.innerHTML = '';
    try {
      await post('/api/auth/password/change', {
        currentPassword: $('#cur').value,
        newPassword: $('#next').value,
      });
      feedback.innerHTML = '<div class="alert info">Password changed.</div>';
      $('#cur').value = '';
      $('#next').value = '';
    } catch (err) {
      feedback.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>';
    }
    save.disabled = false;
  };

  change.appendChild(save);
  change.appendChild(feedback);
  panel.appendChild(change);

  const devices = el('div', 'modal-section');
  devices.appendChild(el('h3', null, 'Signed-in devices'));

  const sessions = await api('/api/auth/sessions');
  for (const session of sessions) {
    const row = el('div', 'row');
    const grow = el('div', 'grow');
    grow.appendChild(el('b', null, describeDevice(session.userAgent)));
    grow.appendChild(el('span', null,
      'Last used ' + formatDateTime(session.lastUsedAt) +
      (session.ipAddress ? ' · ' + session.ipAddress : '')));
    row.appendChild(grow);

    if (session.current) {
      row.appendChild(el('span', 'pill good', 'This device'));
    } else {
      const revoke = el('button', 'btn ghost small', 'Sign out');
      revoke.onclick = async () => {
        await api('/api/auth/sessions/' + encodeURIComponent(session.id), { method: 'DELETE' });
        row.remove();
      };
      row.appendChild(revoke);
    }
    devices.appendChild(row);
  }

  if (sessions.length > 1) {
    const all = el('button', 'btn secondary block', 'Sign out everywhere else');
    all.style.marginTop = '14px';
    all.onclick = async () => {
      await post('/api/auth/sessions/revoke-all');
      panel.innerHTML = '';
      void renderSecurityTab(panel);
    };
    devices.appendChild(all);
  }

  panel.appendChild(devices);
}

/**
 * A readable name for a user-agent string.
 *
 * Deliberately coarse. The purpose is "is one of these not me", which needs
 * browser and platform and nothing more - a full parse would be a fingerprint
 * displayed back at the person it describes.
 */
function describeDevice(userAgent) {
  if (!userAgent) return 'Unknown device';

  const browser =
    /Edg\//.test(userAgent) ? 'Edge' :
    /OPR\//.test(userAgent) ? 'Opera' :
    /Chrome\//.test(userAgent) ? 'Chrome' :
    /Safari\//.test(userAgent) ? 'Safari' :
    /Firefox\//.test(userAgent) ? 'Firefox' : 'Browser';

  const platform =
    /Android/.test(userAgent) ? 'Android' :
    /iPhone|iPad/.test(userAgent) ? 'iOS' :
    /Windows/.test(userAgent) ? 'Windows' :
    /Mac OS X/.test(userAgent) ? 'macOS' :
    /Linux/.test(userAgent) ? 'Linux' : '';

  return platform ? browser + ' on ' + platform : browser;
}

// ============================================================================
// Modal, theme, formatting
// ============================================================================

function showModal(title, build) {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');

  const head = el('div', 'modal-head');
  head.appendChild(el('h2', null, title));

  const close = el('button', 'btn ghost small', '✕');
  const dismiss = () => backdrop.remove();
  close.onclick = dismiss;
  head.appendChild(close);
  modal.appendChild(head);

  const body = el('div', 'modal-body');
  modal.appendChild(body);
  backdrop.appendChild(modal);

  // Clicking the backdrop closes; clicking inside must not. Escape closes too,
  // because a modal that traps you is worse than no modal.
  backdrop.onclick = (event) => { if (event.target === backdrop) dismiss(); };
  document.addEventListener('keydown', function onKey(event) {
    if (event.key !== 'Escape') return;
    dismiss();
    document.removeEventListener('keydown', onKey);
  });

  document.body.appendChild(backdrop);

  const result = build(body, dismiss);
  if (result && typeof result.catch === 'function') {
    result.catch((err) => {
      body.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>';
    });
  }
}

function applyStoredTheme() {
  let theme = null;
  try { theme = localStorage.getItem('vs-theme'); } catch (_) { /* private mode */ }

  if (!theme) {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('vs-theme', next); } catch (_) { /* private mode */ }
}

function initials(user) {
  const name = (user && user.fullName) || (user && user.email) || '?';
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date) ? String(value)
    : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date)) return String(value);

  const minutes = (Date.now() - date.getTime()) / 60000;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return Math.floor(minutes) + 'm ago';
  if (minutes < 1440) return Math.floor(minutes / 60) + 'h ago';
  return formatDate(value);
}

const ICON_MENU = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
const ICON_THEME = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const ICON_SEND = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';

boot();
`;
