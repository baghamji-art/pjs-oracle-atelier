/* Administrator-only presentation. Authentication and persistence stay in their existing modules. */
(function () {
  'use strict';
  if (!document.body.classList.contains('pjo-admin-app')) return;
  document.body.classList.add('pjo-admin-workspace');

  var pane = 'members';
  var chatOpen = false;
  var search = '';
  var unreadOnly = false;
  var expanded = new Set();
  var drafts = new Map();
  var icons = {
    home: '<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
    exit: '<path d="M10 3H4v18h6m5-15 6 6-6 6M9 12h12"/>',
    back: '<path d="m12 4-8 8 8 8M4 12h17"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    send: '<path d="m3 10 18-7-7 18-3-8-8-3Zm8 3L21 3"/>',
    filter: '<path d="M3 4h18l-7 8v8l-4-2v-6z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>'; }
  function el(id) { return document.getElementById(id); }
  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function control(label, glyph, action) {
    var button = make('button', 'pjo-admin-icon');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    if (action) button.dataset.adminUi = action;
    button.innerHTML = icon(glyph);
    return button;
  }
  function initial(name) { return Array.from(String(name || '?'))[0].toUpperCase(); }
  function timeLabel(time, full) {
    if (!time) return '—';
    var date = new Date(time), today = new Date();
    if (Number.isNaN(date.getTime())) return '—';
    if (full) return date.toLocaleDateString('ko-KR', {year:'numeric', month:'long', day:'numeric'});
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('ko-KR', {hour:'numeric',minute:'2-digit'});
    return date.toLocaleDateString('ko-KR', {month:'long',day:'numeric'});
  }
  function unread(userId) {
    var read = typeof consultReadMapV114 === 'function' ? consultReadMapV114() : {};
    return userThreadsV100(userId).filter(function (thread) {
      return latestUserMessageTimeV114(thread) > (read[thread.id] || 0);
    }).length;
  }

  function installChrome() {
    var panel = el('adminPanel'), editor = el('adminEditBox');
    if (!panel || !editor) return;
    if (!el('pjoAdminBar')) {
      var bar = make('header', 'pjo-admin-bar'); bar.id = 'pjoAdminBar';
      var brand = make('div', 'pjo-admin-brand', 'PJ’s Oracle Atelier');
      brand.appendChild(make('span', 'pjo-admin-tag', 'ADMIN'));
      var actions = make('nav', 'pjo-admin-nav'); actions.setAttribute('aria-label','관리자 메뉴');
      var home = make('a', 'pjo-admin-icon'); home.href = 'index.html';
      home.title = '사용자 홈으로'; home.setAttribute('aria-label','사용자 홈으로'); home.innerHTML = icon('home');
      actions.appendChild(home);
      var logout = el('adminDoneBtn');
      if (logout) {
        logout.classList.add('pjo-admin-icon'); logout.innerHTML = icon('exit');
        logout.title = '관리자 로그아웃'; logout.setAttribute('aria-label','관리자 로그아웃');
        actions.appendChild(logout);
      }
      bar.append(brand, actions); panel.prepend(bar);
    }
    if (!el('pjoAdminOverview')) {
      var overview = make('div','pjo-admin-overview'); overview.id = 'pjoAdminOverview';
      overview.innerHTML = '<div class="pjo-admin-heading"><div><h1 id="pjoAdminPageTitle">회원 관리</h1><p id="pjoAdminPageIntro">회원 상태를 검색하고 관리하세요.</p></div><span id="pjoAdminConnection" role="status"></span></div><div id="pjoAdminNumbers" class="pjo-admin-numbers"></div>';
      editor.prepend(overview);
    }
    var tabs = editor.querySelector('.tabs');
    if (tabs) {
      var filters = el('pjoAdminMemberFilters');
      if (!filters) { filters = make('div','pjo-admin-member-filters'); filters.id = 'pjoAdminMemberFilters'; tabs.after(filters); }
      Array.from(tabs.querySelectorAll('.tab')).forEach(function (tab) {
        if (!['all','consult_requests','review_stats'].includes(tab.dataset.tab)) filters.appendChild(tab);
      });
      var all = tabs.querySelector('[data-tab="all"]'), consult = tabs.querySelector('[data-tab="consult_requests"]');
      if (all) all.textContent = '전체 회원';
      if (consult) consult.textContent = '사용자 상담';
      tabs.setAttribute('aria-label','관리자 화면');
    }
    var memberSearch = el('memberSearch');
    if (memberSearch) { memberSearch.placeholder = '아이디 또는 메모 검색'; memberSearch.setAttribute('aria-label','회원 검색'); }
    if (el('memberSearchBtn')) { el('memberSearchBtn').innerHTML = icon('search'); el('memberSearchBtn').setAttribute('aria-label','회원 검색'); }
    var login = el('adminLoginBox');
    if (login && !login.querySelector('h1')) {
      var intro = make('div','pjo-admin-login-intro');
      intro.innerHTML = '<span class="pjo-admin-eyebrow">PRIVATE WORKSPACE</span><h1>관리자 로그인</h1><p>관리자 코드를 입력해 주세요.</p>';
      login.prepend(intro);
      var label = login.querySelector('label'); if (label) label.htmlFor = 'adminCode';
    }
    if (el('adminError')) el('adminError').setAttribute('role','alert');
    if (el('adminSaved')) el('adminSaved').setAttribute('role','status');
    syncChrome();
  }

  function syncChrome() {
    var editor = el('adminEditBox'); if (!editor) return;
    document.body.dataset.adminPane = pane;
    document.body.classList.toggle('pjo-admin-chat-open', pane === 'consult' && chatOpen);
    if (el('pjoAdminPageTitle')) el('pjoAdminPageTitle').textContent = pane === 'consult' ? '사용자 상담' : pane === 'reviews' ? '리뷰 통계' : '회원 관리';
    if (el('pjoAdminPageIntro')) el('pjoAdminPageIntro').textContent = pane === 'consult' ? '회원이 남긴 이야기를 확인하고 답변하세요.' : pane === 'reviews' ? '질문별 평점과 회원의 피드백을 확인하세요.' : '회원 상태를 검색하고 관리하세요.';
    var connection = el('pjoAdminConnection');
    if (connection) {
      var online = typeof CLOUD_ENABLED !== 'undefined' && CLOUD_ENABLED;
      var failed = typeof cloudLastErrorV104 !== 'undefined' && cloudLastErrorV104;
      connection.textContent = failed ? '연결 확인 필요' : online ? '자동 업데이트' : '로컬 모드';
      connection.dataset.state = failed ? 'error' : online ? 'online' : 'local';
    }
    var numbers = el('pjoAdminNumbers');
    if (numbers && typeof getMembers === 'function') {
      var members = getMembers(), now = Date.now();
      var data = [['전체 회원',members.length],['승인 대기',members.filter(function(m){return m.status === 'pending' || m.status === 'renew_pending';}).length],['만료 예정',members.filter(function(m){return m.expiresAt > now && m.expiresAt - now <= 3*86400000;}).length]];
      numbers.replaceChildren();
      data.forEach(function (pair) { var box = make('div'); box.append(make('span','',pair[0]),make('strong','',pair[1].toLocaleString('ko-KR'))); numbers.appendChild(box); });
    }
  }

  function decorateMembers() {
    var box = el('memberList'); if (!box) return;
    var members = new Map(getMembers().map(function(m){return [m.id,m];}));
    Array.from(box.querySelectorAll('.member-item:not([data-admin-styled])')).forEach(function (item) {
      var action = item.querySelector('[data-id]');
      var id = action ? action.dataset.id : '';
      var member = members.get(id); if (!member) return;
      item.dataset.adminStyled = 'true';
      var details = make('details','pjo-member-details'); details.dataset.memberId = id; details.open = expanded.has(id);
      var summary = make('summary','pjo-member-row');
      var status = item.querySelector('.status-pill');
      summary.append(make('strong','pjo-member-id',id));
      if (status) summary.appendChild(status);
      var plan = plans[member.plan]?.label || member.plan || '—';
      var tier = tiers[member.tier || 'member']?.label || 'Member';
      summary.append(make('span','pjo-member-plan',plan + ' · ' + tier));
      summary.append(make('span','pjo-member-access',memberStatusAllowsLoginV27(member) ? '로그인 가능' : '로그인 불가'));
      var arrow = make('span','pjo-member-chevron'); arrow.innerHTML = icon('chevron'); summary.appendChild(arrow);
      var content = make('div','pjo-member-content');
      var meta = item.querySelector('.admin-member-meta'), buttons = item.querySelector('.admin-member-actions');
      if (meta) content.appendChild(meta);
      if (member.memo) content.appendChild(make('p','pjo-member-memo','메모: ' + member.memo));
      if (buttons) content.appendChild(buttons);
      details.append(summary, content); item.replaceChildren(details);
      details.addEventListener('toggle',function(){if(details.open)expanded.add(id);else expanded.delete(id);});
    });
    if (!el('pjoMemberColumns') && box.querySelector('.member-item')) {
      var columns = make('div','pjo-member-columns'); columns.id = 'pjoMemberColumns'; columns.setAttribute('aria-hidden','true');
      ['회원 ID','상태','기간 / 역할','로그인'].forEach(function(label){columns.appendChild(make('span','',label));});
      box.prepend(columns);
    }
    syncChrome();
  }

  function installConsultTools() {
    var workspace = el('adminConsultWorkspaceV100'); if (!workspace) return;
    if (!el('pjoConsultTools')) {
      var tools = make('div','pjo-consult-tools'); tools.id = 'pjoConsultTools';
      var field = make('label','pjo-consult-search'); field.innerHTML = icon('search');
      var input = make('input'); input.type='search'; input.placeholder='이름 또는 메시지 검색'; input.setAttribute('aria-label','이름 또는 메시지 검색');
      input.value=search; input.addEventListener('input',function(){search=input.value;filterConsults();}); field.appendChild(input);
      var filter=control('안 읽은 상담만 보기','filter','unread'); filter.className='pjo-unread-filter'; filter.setAttribute('aria-pressed',String(unreadOnly)); filter.appendChild(make('span','','안 읽음'));
      tools.append(field,filter); workspace.prepend(tools);
    }
    var currentInput=el('pjoConsultTools').querySelector('input');
    if(currentInput.value!==search)currentInput.value=search;
    el('pjoConsultTools').querySelector('[data-admin-ui="unread"]').setAttribute('aria-pressed',String(unreadOnly));
  }

  function decorateConsultList() {
    var box=el('adminConsultUsersV100'); if (!box) return;
    Array.from(box.querySelectorAll('[data-action="admin-consult-user-v100"]')).forEach(function (button) {
      var id=button.dataset.id;
      var messages=userThreadsV100(id).flatMap(function(thread){return thread.messages || [];}).sort(function(a,b){return (a.time||0)-(b.time||0);});
      var latest=messages[messages.length-1], count=unread(id);
      button.dataset.adminSearch=(id+' '+messages.map(function(m){return m.text||'';}).join(' ')).toLocaleLowerCase();
      button.dataset.adminUnread=String(count);
      button.setAttribute('aria-label',id+' 상담 열기'+(count?', 안 읽은 상담 '+count+'건':''));
      var body=make('span','pjo-consult-person');
      var line=make('span','pjo-consult-line'); line.append(make('b','',id),make('time','',timeLabel(latest?.time)));
      body.append(line,make('span','pjo-consult-preview',latest?.text || '아직 메시지가 없습니다.'));
      var end=make('span','pjo-consult-end');
      if(count)end.appendChild(make('span','pjo-consult-badge',String(count)));
      var arrow=make('span','pjo-consult-arrow'); arrow.innerHTML=icon('chevron'); end.appendChild(arrow);
      button.replaceChildren(make('span','pjo-admin-avatar',initial(id)),body,end);
    });
    filterConsults();
  }

  function filterConsults() {
    var box=el('adminConsultUsersV100'); if(!box)return;
    var shown=0, buttons=box.querySelectorAll('[data-action="admin-consult-user-v100"]');
    buttons.forEach(function(button){
      var match=(button.dataset.adminSearch||'').includes(search.trim().toLocaleLowerCase())&&(!unreadOnly||Number(button.dataset.adminUnread)>0);
      button.hidden=!match; if(match)shown++;
    });
    var empty=el('pjoConsultNoMatches');
    if(!empty){empty=make('p','pjo-admin-empty','검색 조건에 맞는 상담이 없습니다.');empty.id='pjoConsultNoMatches';box.appendChild(empty);}
    empty.hidden=shown>0||buttons.length===0;
  }

  function decorateChat() {
    var box=el('adminConsultChatV100'); if(!box)return;
    box.dataset.adminUser=selectedConsultUserV100 || '';
    if(!chatOpen){box.replaceChildren(make('div','pjo-chat-placeholder','목록에서 상담을 선택해 주세요.'));return;}
    var id=selectedConsultUserV100;
    var heading=box.querySelector('.admin-consult-selected-v100');
    if(heading){
      var name=make('div','pjo-chat-name');name.append(make('strong','',id),make('span','','상담 대화'));
      heading.replaceChildren(control('상담 목록으로','back','back'),make('span','pjo-admin-avatar',initial(id)),name);
    }
    var messages=box.querySelector('.admin-consult-messages-v100');
    if(messages){
      // Reformat only displayed messages; keep the original thread and message data.
      var all=userThreadsV100(id).flatMap(function(thread){return thread.messages||[];}).slice().sort(function(a,b){return (a.time||0)-(b.time||0);});
      var day='';messages.replaceChildren();
      all.forEach(function(message){
        var date=timeLabel(message.time,true);
        if(date!==day){messages.appendChild(make('div','pjo-chat-date',date));day=date;}
        var role=message.role==='admin'?'admin':'user';
        var row=make('div','pjo-message pjo-message-'+role);
        if(role==='user')row.appendChild(make('span','pjo-admin-avatar',initial(id)));
        var bubble=make('p','pjo-message-bubble',message.text||'');
        var clock=make('time','pjo-message-time',timeLabel(message.time));
        if(message.time)clock.dateTime=new Date(message.time).toISOString();
        row.append(bubble,clock);messages.appendChild(row);
      });
    }
    var input=el('adminConsultUserReplyV100');
    if(input){input.placeholder='메시지를 입력하세요';input.setAttribute('aria-label',id+' 회원에게 답변');input.rows=1;if(drafts.has(id))input.value=drafts.get(id);}
    var send=box.querySelector('[data-action="admin-consult-user-reply-v100"]');
    if(send){send.innerHTML=icon('send');send.setAttribute('aria-label','답변 보내기');send.title='답변 보내기';}
    if(messages)requestAnimationFrame(function(){messages.scrollTop=messages.scrollHeight;});
  }

  function decorateConsults() { installConsultTools();decorateConsultList();decorateChat();syncChrome(); }
  function wrap(name, after) {
    var original=window[name];if(typeof original!=='function')return;
    window[name]=function(){var value=original.apply(this,arguments);after();return value;};
  }
  // Preserve all existing mutations, event delegation, and session checks.
  wrap('renderMemberList',decorateMembers);
  wrap('renderStats',syncChrome);
  wrap('updateAdminConsultBadgeV114',decorateConsultList);
  if(typeof renderAdminConsultWorkspaceV100==='function'){
    var renderConsultBase=renderAdminConsultWorkspaceV100;
    renderAdminConsultWorkspaceV100=function(){
      var input=el('adminConsultUserReplyV100'), owner=el('adminConsultChatV100')?.dataset.adminUser;
      if(input&&owner)drafts.set(owner,input.value);
      var result=renderConsultBase.apply(this,arguments);decorateConsults();return result;
    };
  }
  // A collapsed conversation list is not a read conversation. Keep the existing
  // read-map writer, but only invoke it when the selected chat is actually open.
  if(typeof markUserConsultsReadV114==='function'){
    var markReadBase=markUserConsultsReadV114;
    markUserConsultsReadV114=function(id){
      if(pane==='consult'&&chatOpen&&document.body.classList.contains('pjo-admin-authorized'))return markReadBase(id);
    };
  }
  if(typeof replySelectedConsultUserV100==='function'){
    var replyBase=replySelectedConsultUserV100;
    replySelectedConsultUserV100=function(){
      var id=selectedConsultUserV100;
      var result=replyBase.apply(this,arguments);
      var input=el('adminConsultUserReplyV100');
      if(input&&input.value==='')drafts.delete(id);
      return result;
    };
  }
  // Capture view intent before the legacy delegated handlers stop propagation.
  window.addEventListener('click',function(event){
    var tab=event.target.closest?.('#adminEditBox .tab');
    if(tab){
      pane=tab.dataset.tab==='consult_requests'?'consult':tab.dataset.tab==='review_stats'?'reviews':'members';chatOpen=false;syncChrome();
      requestAnimationFrame(function(){if(el('adminPanel'))el('adminPanel').scrollTop=0;});
    }
    if(event.target.closest?.('[data-action="admin-consult-user-v100"]')){
      pane='consult';chatOpen=true;syncChrome();
      requestAnimationFrame(function(){if(el('adminPanel'))el('adminPanel').scrollTop=0;});
    }
    var button=event.target.closest?.('[data-admin-ui]');if(!button)return;
    if(button.dataset.adminUi==='back'){
      event.preventDefault();chatOpen=false;renderAdminConsultWorkspaceV100();
      requestAnimationFrame(function(){el('pjoConsultTools')?.querySelector('input')?.focus();});
    }
    if(button.dataset.adminUi==='unread'){
      event.preventDefault();unreadOnly=!unreadOnly;button.setAttribute('aria-pressed',String(unreadOnly));filterConsults();
    }
  },true);
  document.addEventListener('input',function(event){
    if(event.target.id==='adminConsultUserReplyV100'&&selectedConsultUserV100)drafts.set(selectedConsultUserV100,event.target.value);
  });
  var authorized=document.body.classList.contains('pjo-admin-authorized');
  new MutationObserver(function(){
    var next=document.body.classList.contains('pjo-admin-authorized');
    if(next===authorized)return;authorized=next;
    if(!next){drafts.clear();expanded.clear();search='';unreadOnly=false;chatOpen=false;pane='members';}
    installChrome();
  }).observe(document.body,{attributes:true,attributeFilter:['class']});
  document.addEventListener('DOMContentLoaded',function(){installChrome();decorateMembers();decorateConsults();});
  installChrome();
})();
