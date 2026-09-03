(function () {
  'use strict';

  if (!document.body.classList.contains('pjo-admin-app')) return;

  var AUTH_URL = '/.netlify/functions/admin-auth';
  var SESSION_URL = '/.netlify/functions/admin-session';
  var LOGOUT_URL = '/.netlify/functions/admin-logout';
  var bindingAttempts = 0;
  var maxBindingAttempts = 160;
  var loginBusy = false;
  var sessionTimer = 0;

  function element(id) {
    return document.getElementById(id);
  }

  function setError(message) {
    var error = element('adminError');
  }

  function setBusy(busy) {
    loginBusy = busy;
    var input = element('adminCode');
    var button = element('adminEnterBtn');
    if (input) {
      input.disabled = busy;
      input.setAttribute('aria-busy', String(busy));
    }
    if (button) {
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      button.textContent = busy ? '확인 중…' : '확인';
    }
  }

  function showLogin(message) {
    document.body.classList.remove('pjo-admin-authorized');
    var panel = element('adminPanel');
    var login = element('adminLoginBox');
    var editor = element('adminEditBox');
    if (panel) panel.classList.remove('hidden');
    if (login) login.classList.remove('hidden');
    if (editor) editor.classList.add('hidden');
    setError(message || '');
  }

  function renderAuthorizedAdmin() {
    document.body.classList.add('pjo-admin-authorized');
    var panel = element('adminPanel');
    var login = element('adminLoginBox');
    var editor = element('adminEditBox');
    var codeInput = element('adminCode');
    if (panel) panel.classList.remove('hidden');
    if (login) login.classList.add('hidden');
    if (editor) editor.classList.remove('hidden');
    if (codeInput) codeInput.value = '';
    setError('');

    try {
      if (typeof getCodes === 'function') {
        getCodes().forEach(function (code, index) {
          var input = element('guestCode' + (index + 1));
          if (input) input.value = code;
        });
      }
      if (typeof renderStats === 'function') renderStats();
      if (typeof renderMemberList === 'function') renderMemberList();
      if (typeof renderLogs === 'function') renderLogs();
    } catch (error) {
      console.error('Admin workspace initialization failed', error);
      showLogin('관리자 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
    }
  }

  function scheduleSessionLock(seconds) {
    if (sessionTimer) window.clearTimeout(sessionTimer);
    var safeSeconds = Math.max(1, Number(seconds) || 1);
    sessionTimer = window.setTimeout(function () {
      showLogin('관리자 세션이 만료되었습니다. 다시 로그인해 주세요.');
    }, safeSeconds * 1000);
  }

  async function parseResponse(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }

  function connectionMessage() {
    if (location.protocol === 'file:') {
      return '보안 관리자 로그인은 Netlify 배포 주소에서 사용할 수 있습니다.';
    }
    return '관리자 인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';
  }

  async function secureLogin() {
    if (loginBusy) return;
    var input = element('adminCode');
    var code = input ? input.value : '';
    if (!code) {
      setError('관리자 코드를 입력해 주세요.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      var response = await fetch(AUTH_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      });
      var result = await parseResponse(response);
      if (response.ok && result.ok) {
        renderAuthorizedAdmin();
        scheduleSessionLock(result.expiresIn);
      } else if (response.status === 401) {
        setError('관리자 코드가 맞지 않습니다.');
      } else if (response.status === 503) {
        setError('관리자 보안 환경변수가 아직 설정되지 않았습니다.');
      } else {
        setError('관리자 인증을 완료하지 못했습니다. 다시 시도해 주세요.');
      }
    } catch (error) {
      setError(connectionMessage());
    } finally {
      if (input) input.value = '';
      setBusy(false);
    }
  }

  async function restoreSession() {
    try {
      var response = await fetch(SESSION_URL, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      });
      if (response.ok) {
        var result = await parseResponse(response);
        renderAuthorizedAdmin();
        scheduleSessionLock((Number(result.expiresAt) || 0) - Math.floor(Date.now() / 1000));
        return;
      }
      showLogin(response.status === 503 ? '관리자 보안 환경변수가 아직 설정되지 않았습니다.' : '');
    } catch (error) {
      showLogin(location.protocol === 'file:' ? connectionMessage() : '');
    }
  }

  async function secureLogout() {
    if (sessionTimer) window.clearTimeout(sessionTimer);
    sessionTimer = 0;
    try {
      await fetch(LOGOUT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      });
    } catch (error) {
      // The local UI still locks even if the server is temporarily unreachable.
    }
    showLogin('');
  }

  function replaceLegacyBindings() {
    bindingAttempts += 1;
    var launcher = element('adminModeBtn');
    var enter = element('adminEnterBtn');
    var close = element('adminCloseBtn');
    var done = element('adminDoneBtn');

    if (launcher && typeof launcher.onclick === 'function' && enter) {
      launcher.onclick = function () { showLogin(''); };
      enter.onclick = function () { secureLogin(); };
      if (close) close.onclick = function () { secureLogout(); };
      if (done) done.onclick = function () { secureLogout(); };
      restoreSession();
      return;
    }

    if (bindingAttempts < maxBindingAttempts) window.setTimeout(replaceLegacyBindings, 50);
  }

  document.addEventListener('click', function (event) {
    if (event.target.closest && event.target.closest('#adminEnterBtn')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      secureLogin();
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target === element('adminCode')) {
      event.preventDefault();
      secureLogin();
    }
  }, true);

  showLogin('');
  document.addEventListener('DOMContentLoaded', function () {
    showLogin('');
    replaceLegacyBindings();
  });
})();
