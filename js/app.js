(function () {
'use strict';
var C = window.Countdown;
var engine = new C.Engine();

var view = {
  replay: null,
  replayCursor: 0,
  replayPlaying: false,
  paused: false,
  impactTimers: {},
  lastIncidentKey: null
};

function currentEngine() { return view.replay ? view.replay.engine : engine; }

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) { node.className = cls; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}

function tickLoop() {
  if (!view.paused && !view.replay) {
    var speed = parseInt($('speedSel').value, 10);
    for (var i = 0; i < speed; i++) {
      engine.tick(1);
      engine.schedule();
      if (engine.state.status === 'launched' || engine.state.status === 'scrubbed') { break; }
    }
  }
  render();
  setTimeout(tickLoop, 250);
}

function render() {
  var eng = currentEngine();
  renderHeader(eng);
  renderTimeline(eng);
  renderStages(eng);
  renderGates(eng);
  renderBranches();
  renderLog(eng);
  handleIncidentModal();
}

function statusInfo(s) {
  if (s.status === 'launched') { return { cls: 'launched', text: '已点火' }; }
  if (s.status === 'scrubbed') { return { cls: 'scrubbed', text: '已中止' }; }
  if (s.incident || s.leak.active) { return { cls: 'incident', text: '事件处置中' }; }
  if (s.frozen) { return { cls: 'frozen', text: '冻结' }; }
  return { cls: 'counting', text: '计时中' };
}

function renderHeader(eng) {
  var s = eng.state;
  $('clock').textContent = C.fmtClock(s.t);
  var info = statusInfo(s);
  var pill = $('statusPill');
  pill.className = 'pill ' + info.cls;
  pill.textContent = info.text + (s.commOut ? ' · 通信中断' : '');
  $('t0Plan').textContent = C.fmtClock(s.t0);
  var slip = s.slip;
  var slipNode = $('t0Slip');
  slipNode.textContent = (slip > 0 ? '+' + slip + 's' : '0s');
  slipNode.style.color = slip > 30 ? 'var(--orange)' : slip > 0 ? 'var(--yellow)' : 'var(--green)';
  $('branchName').textContent = s.branchId;
  document.body.classList.toggle('replay-mode', !!view.replay);
  $('btnPause').textContent = view.paused ? '继续仿真' : '暂停';
  $('logMode').textContent = view.replay ? '（回放视图：只读）' : '';
}

function renderTimeline(eng) {
  var box = $('timeline');
  box.innerHTML = '';
  var s = eng.state;
  var sch = eng.schedule();
  var fins = {
    evac: sch.evacFinish, load: sch.loadFinish, cond: sch.condFinish,
    weather: sch.weatherFinish, ground: sch.groundFinish, terminal: 0
  };
  C.PLAN.forEach(function (p) {
    var st = s.phases[p.id];
    var card = el('div', 'tl-stage ' + st.status);
    card.dataset.stage = p.id;
    var stateText = { pending: '待命', active: '进行', done: '完成' }[st.status] || st.status;
    card.appendChild(el('div', 'tl-state ' + st.status, stateText));
    card.appendChild(el('div', 'tl-name', p.label));
    var finishLabel = st.completedAt !== null ? '实际完成 ' + C.fmtClock(st.completedAt)
      : '许可完成 ' + C.fmtClock(Math.max(p.end, fins[p.id]));
    card.appendChild(el('div', 'tl-time', '窗口 ' + C.fmtClock(p.start) + ' → ' + C.fmtClock(p.end) + ' · ' + finishLabel));
    var bar = el('div', 'tl-bar');
    var fill = el('i');
    var pct;
    if (st.completedAt !== null) { pct = 100; }
    else if (p.id === 'load') { pct = st.level; }
    else if (p.id === 'evac') { pct = st.progress; }
    else if (p.id === 'cond') { pct = Math.max(0, 100 - Math.abs(st.diff - 8) * 1.4); }
    else if (p.id === 'ground') { pct = st.stepCursor / st.steps.length * 80 + (st.disconnected ? 20 : 0); }
    else if (p.id === 'terminal') { pct = Math.max(0, Math.min(100, (-s.t / 60) * 100)); }
    else { pct = s.t >= p.start ? Math.min(100, (s.t - p.start) / (p.end - p.start) * 100) : 0; }
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);
    box.appendChild(card);
  });
  var slip = sch.slip;
  $('timelineHint').textContent = slip > 0
    ? '当前最早许可点火 T+' + slip + 's（窗口已滑移 ' + slip + ' 秒）'
    : '许可点火时刻与 T-0 对齐';
  $('timelineHint').style.color = slip > 30 ? 'var(--orange)' : 'var(--green)';
}

function stageDetails(id, st, s) {
  if (id === 'evac') { return '撤离进度 ' + Math.round(st.progress) + '%'; }
  if (id === 'load') {
    return '液位 ' + st.level.toFixed(1) + '% · ' +
      ({ low: '低速', mid: '常速', high: '高速' })[st.rate] + ' · ' +
      (st.line === 'primary' ? '主用管路' : '备用管路') + (st.valveOpen ? ' · 阀开' : ' · 阀关') +
      (s.leak.active ? ' · 泄漏中' : '');
  }
  if (id === 'cond') { return '温差 |ΔT| = ' + Math.abs(st.diff).toFixed(1) + '°C（目标 ≤ 20°C）'; }
  if (id === 'weather') {
    return '雷电指数 ' + s.sensors.lightning.toFixed(0) +
      (st.waitUntil > s.t ? ' · 窗口等待至 ' + C.fmtClock(st.waitUntil) : '');
  }
  if (id === 'ground') {
    return '互锁链路 ' + (st.chainOpen ? '隔离' : '闭合') + ' · 测试 ' + st.stepCursor + '/' + st.steps.length +
      ' · 脱拔' + (st.armed ? '已加电' : '未加电') + (st.disconnected ? '已脱拔' : '');
  }
  if (id === 'terminal') {
    var go = currentEngine().terminalGo();
    return go.ok ? '七路互锁全部 GO' : ('HOLD：' + go.blockers.map(function (g) { return g.label; }).join('、'));
  }
  return '';
}

function renderStages(eng) {
  var box = $('stageList');
  box.innerHTML = '';
  var s = eng.state;
  C.PLAN.forEach(function (p) {
    var st = s.phases[p.id];
    var row = el('div', 'stage ' + st.status);
    var head = el('div', 'stage-head');
    head.appendChild(el('span', 'stage-name', p.label));
    head.appendChild(el('span', 'badge ' + st.status,
      { pending: '待命', active: '进行中', done: '已完成' }[st.status]));
    row.appendChild(head);
    row.appendChild(el('div', 'stage-detail', stageDetails(p.id, st, s)));
    var prog = el('div', 'stage-progress');
    var fill = el('i');
    var pct = p.id === 'load' ? st.level : p.id === 'evac' ? st.progress :
      p.id === 'ground' ? st.stepCursor / st.steps.length * 100 :
      st.status === 'done' ? 100 : st.status === 'active' ? 50 : 0;
    fill.style.width = pct + '%';
    prog.appendChild(fill);
    row.appendChild(prog);
    box.appendChild(row);
  });
}

function renderGates(eng) {
  var box = $('gateList');
  box.innerHTML = '';
  eng.evaluateGates().forEach(function (g) {
    var row = el('div', 'gate');
    row.dataset.gate = g.id;
    var lamp = el('span', 'gate-lamp ' + g.level);
    var body = el('div', 'gate-body');
    body.appendChild(el('div', 'gate-label', g.label));
    body.appendChild(el('div', 'gate-detail', g.detail));
    row.appendChild(lamp);
    row.appendChild(body);
    box.appendChild(row);
  });
}

function flashImpacts(impacts) {
  (impacts || []).forEach(function (item) {
    var stage = document.querySelector('.tl-stage[data-stage="' + item + '"]');
    if (stage) {
      stage.classList.remove('impact');
      void stage.offsetWidth;
      stage.classList.add('impact');
    }
    var gate = document.querySelector('.gate[data-gate="' + item + '"]');
    if (gate) {
      gate.classList.remove('impact');
      void gate.offsetWidth;
      gate.classList.add('impact');
    }
  });
}

function showImpactModal(ev) {
  $('impactBody').textContent = ev.message;
  var list = $('impactList');
  list.innerHTML = '';
  if (ev.impacts && ev.impacts.length) {
    ev.impacts.forEach(function (i) { list.appendChild(el('span', 'impact-chip', '↳ ' + i.label)); });
  } else {
    list.appendChild(el('span', 'impact-chip', '无下游传播'));
  }
  $('impactModal').classList.remove('hidden');
  flashImpacts((ev.impacts || []).map(function (i) { return i.id; }));
}

function doAction(action, payload) {
  if (view.replay) { return; }
  var post = $('postSel').value;
  var ev = engine.act(action, payload || {}, post);
  engine.schedule();
  render();
  if (ev && ev.blocked) { showImpactModal(ev); }
}

function doInject(kind) {
  if (view.replay) { return; }
  var ev = engine.inject(kind);
  render();
  if (ev && ev.blocked) { showImpactModal(ev); }
}

function handleIncidentModal() {
  var inc = engine.state.incident;
  var modal = $('incidentModal');
  if (view.replay) { modal.classList.add('hidden'); return; }
  if (inc) {
    var key = inc.kind + '@' + inc.startedAt;
    if (view.lastIncidentKey !== key) {
      view.lastIncidentKey = key;
      $('incidentTitle').textContent = '需要处置：' + inc.title;
      var opts = $('incidentOptions');
      opts.innerHTML = '';
      inc.options.forEach(function (o) {
        var btn = el('button', 'btn btn-warn', o.label);
        btn.onclick = function () {
          var fork = engine.resolve(o.id);
          view.lastIncidentKey = null;
          modal.classList.add('hidden');
          render();
          flashImpacts((fork.impacts || []).map(function (i) { return i.id; })
            .concat(['load', 'cond', 'terminal']));
        };
        opts.appendChild(btn);
      });
      modal.classList.remove('hidden');
    }
  } else {
    modal.classList.add('hidden');
    view.lastIncidentKey = null;
  }
}

function renderBranches() {
  var box = $('branchList');
  box.innerHTML = '';
  var branches = engine.branchTree();
  Object.keys(branches).forEach(function (id) {
    var b = branches[id];
    var row = el('div', 'branch' + (id === 'main' ? ' main' : ''));
    var info = el('div');
    info.appendChild(el('div', null, (id === 'main' ? '主线' : b.label)));
    info.appendChild(el('div', 'branch-meta',
      '分叉于 ' + C.fmtClock(b.createdAt) + (b.parentId ? ' · 父分支 ' + b.parentId : '') +
      ' · 事件 ' + b.eventIndices.length));
    row.appendChild(info);
    var acts = el('div', 'branch-actions');
    var replayBtn = el('button', 'btn btn-small', '回放');
    replayBtn.onclick = function () { startReplay(id); };
    acts.appendChild(replayBtn);
    row.appendChild(acts);
    box.appendChild(row);
  });
  $('replayBar').classList.toggle('hidden', !view.replay);
  if (view.replay) {
    $('replayTitle').textContent = '回放中：' + view.replay.meta.label +
      '（事件 ' + view.replayCursor + '/' + view.replay.events.length + '）';
  }
}

function startReplay(branchId) {
  var result = engine.replayBranch(branchId);
  if (!result) { return; }
  view.replay = result;
  view.replayCursor = 0;
  view.replayPlaying = false;
  render();
}

function replayStepForward() {
  if (!view.replay || view.replayCursor >= view.replay.events.length) { return; }
  var ev = view.replay.events[view.replayCursor++];
  view.replay.engine.applyEvent(JSON.parse(JSON.stringify(ev)));
  render();
}

function exitReplay() {
  view.replay = null;
  view.replayPlaying = false;
  render();
}

function levelClass(ev) {
  if (ev.blocked) { return 'error blocked-row'; }
  if (ev.type === 'fork') { return 'fork'; }
  if (ev.level) { return ev.level; }
  if (ev.name === 'scrub') { return 'error'; }
  if (ev.name && ev.name.indexOf('restored') >= 0) { return 'success'; }
  return 'info';
}

function renderLog(eng) {
  var box = $('eventLog');
  var logs = eng.eventLog.filter(function (ev) {
    return ev.type === 'log' || ev.type === 'dispatch' || ev.type === 'fork';
  }).slice(-80);
  box.innerHTML = '';
  logs.forEach(function (ev) {
    if (ev.type === 'tick') { return; }
    var line = el('div', 'log-line ' + levelClass(ev));
    var time = el('span', 'log-time', C.fmtClock(ev.t));
    line.appendChild(time);
    line.appendChild(document.createTextNode(ev.message || ''));
    if (ev.impacts && ev.impacts.length) {
      var chain = el('span', 'log-impact',
        '影响传播 → ' + ev.impacts.map(function (i) { return i.label; }).join(' → '));
      line.appendChild(chain);
    }
    if (ev.blocked) {
      line.title = '点击查看影响范围';
      line.onclick = function () { showImpactModal(ev); };
    }
    box.appendChild(line);
  });
  box.scrollTop = box.scrollHeight;
}

function bind() {
  document.querySelectorAll('[data-act]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var act = btn.dataset.act;
      var payload = {};
      if (act === 'setRate') { payload.rate = btn.dataset.payload; }
      if (act === 'rollback' || act === 'advance') { payload.phase = btn.dataset.payload; }
      doAction(act, payload);
    });
  });
  document.querySelectorAll('[data-inject-ev]').forEach(function (btn) {
    btn.addEventListener('click', function () { doInject(btn.dataset.injectEv); });
  });
  document.querySelector('[data-inject="freeze"]').addEventListener('click', function () {
    doAction('freeze', {});
  });
  document.querySelector('[data-inject="resume"]').addEventListener('click', function () {
    doAction('resume', {});
  });
  $('btnPause').addEventListener('click', function () {
    view.paused = !view.paused;
    render();
  });
  $('btnReset').addEventListener('click', function () {
    engine = new C.Engine();
    exitReplay();
    view.paused = false;
  });
  $('impactClose').addEventListener('click', function () {
    $('impactModal').classList.add('hidden');
  });
  $('replayStep').addEventListener('click', replayStepForward);
  $('replayExit').addEventListener('click', exitReplay);
  $('replayPlay').addEventListener('click', function () {
    view.replayPlaying = !view.replayPlaying;
    $('replayPlay').textContent = view.replayPlaying ? '暂停播放' : '播放';
  });
}

setInterval(function () {
  if (view.replay && view.replayPlaying) {
    if (view.replayCursor < view.replay.events.length) {
      replayStepForward();
    } else {
      view.replayPlaying = false;
      $('replayPlay').textContent = '播放';
    }
  }
}, 900);

bind();
tickLoop();

})();
