(function (global) {
'use strict';

var T_START = -3600;

var PLAN = [
  { id: 'evac', start: -2400, end: -1500, label: '人员撤离' },
  { id: 'load', start: -1500, end: -600, label: '推进剂加注' },
  { id: 'cond', start: -900, end: -300, label: '箭体温控' },
  { id: 'weather', start: -600, end: -120, label: '天气窗口' },
  { id: 'ground', start: -480, end: -60, label: '地面设备' },
  { id: 'terminal', start: -60, end: 0, label: '点火终端' }
];

var GATES = [
  { id: 'evac', label: '人员撤离完成', anchor: 'evac' },
  { id: 'loading', label: '加注量 ≥ 98%', anchor: 'load' },
  { id: 'pressure', label: '贮箱压力 2.0–4.5 bar', anchor: 'load' },
  { id: 'temp_diff', label: '温差 |ΔT| ≤ 20°C', anchor: 'cond' },
  { id: 'lightning', label: '雷电风险 < 黄色', anchor: 'weather' },
  { id: 'interlock', label: '设备互锁链路闭合', anchor: 'ground' },
  { id: 'comm', label: '通信链路正常', anchor: 'ground' }
];

var RATES = { low: 0.05, mid: 0.075, high: 0.11 };

var EDGES = [
  ['evac', 'load'], ['evac', 'ground'],
  ['load', 'cond'], ['load', 'ground'], ['load', 'terminal'],
  ['cond', 'terminal'],
  ['weather', 'load'], ['weather', 'terminal'],
  ['ground', 'terminal']
];

var POST_RANK = { commander: 3, safety: 2, load: 1, ground: 1 };
var POST_LABEL = { commander: '指挥员', safety: '安全岗', load: '加注岗', ground: '地面岗' };

function phaseLabel(id) {
  for (var i = 0; i < PLAN.length; i++) { if (PLAN[i].id === id) { return PLAN[i].label; } }
  return id;
}

function buildDownstream() {
  var map = {};
  PLAN.forEach(function (p) { map[p.id] = {}; });
  EDGES.forEach(function (e) { map[e[0]][e[1]] = true; });
  var changed = true;
  while (changed) {
    changed = false;
    Object.keys(map).forEach(function (src) {
      Object.keys(map[src]).forEach(function (mid) {
        Object.keys(map[mid]).forEach(function (dst) {
          if (!map[src][dst]) { map[src][dst] = true; changed = true; }
        });
      });
    });
  }
  return map;
}

var DOWNSTREAM = buildDownstream();

function impactsOf(anchors) {
  var hit = {};
  (anchors || []).forEach(function (a) {
    hit[a] = true;
    Object.keys(DOWNSTREAM[a] || {}).forEach(function (d) { hit[d] = true; });
  });
  return Object.keys(hit).map(function (id) { return { id: id, label: phaseLabel(id) }; });
}

function deepMerge(target, patch) {
  if (!patch) { return target; }
  Object.keys(patch).forEach(function (key) {
    var val = patch[key];
    if (val === undefined) { return; }
    if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
        target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  });
  return target;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function initialState() {
  return {
    t: T_START,
    t0: 0,
    slip: 0,
    frozen: false,
    status: 'counting',
    rngSeed: 20260921,
    branchId: 'main',
    incident: null,
    leak: { active: false, count: 0 },
    stormUntil: -9999,
    acceptedRisk: false,
    commOut: false,
    commRestoreAt: 0,
    commQueue: [],
    lastCmd: null,
    sensors: { pressure: 2.2, lightning: 8 },
    phases: {
      evac: { status: 'pending', startedAt: null, completedAt: null, progress: 0 },
      load: { status: 'pending', startedAt: null, completedAt: null, level: 0, valveOpen: false, rate: 'mid', line: 'primary', pauseUntil: -9999 },
      cond: { status: 'pending', startedAt: null, completedAt: null, diff: 55, conditioned: true, reconfirmAt: -9999 },
      weather: { status: 'pending', startedAt: null, completedAt: null, waitUntil: -9999 },
      ground: {
        status: 'pending', startedAt: null, completedAt: null, chainOpen: true, armed: false, disconnected: false, stepCursor: 0, stepStartedAt: null,
        steps: [
          { id: 'power', label: '供电转箭' },
          { id: 'pneumo', label: '气检复查' },
          { id: 'umbilical', label: '脱拔准备' }
        ]
      },
      terminal: { status: 'pending', startedAt: null, completedAt: null, hold: false }
    }
  };
}

function Engine() {
  this.state = initialState();
  this.eventLog = [];
  this.branches = {
    main: {
      id: 'main', parentId: null, label: '主线',
      rootState: initialState(), prefixLen: 0,
      eventIndices: [], createdAt: T_START, resolved: null,
      options: null, chosenOption: null
    }
  };
  this.seq = 1;
  this.globalEvents = [];
}

Engine.prototype.now = function () { return this.state.t; };

Engine.prototype.append = function (ev) {
  ev.seq = this.seq++;
  ev.t = this.state.t;
  ev.branchId = ev.branchIdOverride || this.state.branchId;
  delete ev.branchIdOverride;
  this.eventLog.push(ev);
  this.globalEvents.push(ev.seq);
  this.branches[ev.branchId].eventIndices.push(ev.seq);
  this.applyEvent(ev);
  return ev;
};

Engine.prototype.applyEvent = function (ev) {
  var s = this.state;
  if (ev.type === 'tick') {
    s.t = ev.to;
    this.dynamics(ev.dt);
    this.deriveStatus();
  } else if (ev.type === 'fork' && ev.finalState) {
    this.state = clone(ev.finalState);
  } else if (ev.patch) {
    deepMerge(s, ev.patch);
  } else if (ev.type === 'dispatch') {
    var fn = this['apply_' + ev.name];
    if (fn) { fn.call(this, ev, s); }
    this.deriveStatus();
  }
};

Engine.prototype.log = function (level, code, message, extra) {
  var ev = { type: 'log', level: level, code: code, message: message, extra: extra || null };
  return this.append(ev);
};

Engine.prototype.rand = function () {
  var s = this.state;
  s.rngSeed = (s.rngSeed * 1103515245 + 12345) % 2147483648;
  return s.rngSeed / 2147483648;
};

Engine.prototype.tick = function (dt) {
  var s = this.state;
  if (s.status === 'launched' || s.status === 'scrubbed') { return null; }
  var from = s.t;
  var to = from + dt;
  if (!s.frozen) {
    var tickEv = this.append({ type: 'tick', from: from, to: to, dt: dt });
    this.scrubIfUnresolved();
    if (s.commOut && to >= s.commRestoreAt) {
      this.append({
        type: 'dispatch', name: 'comm_restored',
        message: '通信链路恢复：延迟指令重新校验'
      });
      this.schedule();
    }
    return tickEv;
  }
  return this.append({ type: 'tick', from: from, to: from, dt: 0, frozenHold: dt });
};

Engine.prototype.deriveStatus = function () {
  var s = this.state;
  var phases = s.phases;
  ['evac', 'load', 'cond', 'weather', 'ground', 'terminal'].forEach(function (id) {
    var p = phases[id];
    if (p.completedAt !== null) { p.status = 'done'; }
    else if (p.startedAt !== null) { p.status = 'active'; }
  });
  if (s.status === 'scrubbed' || s.status === 'launched') { return; }
  if (s.leak.active || s.incident) { s.status = 'incident'; return; }
  s.status = s.frozen ? 'frozen' : 'counting';
};

Engine.prototype.dynamics = function (dt) {
  if (dt <= 0) { return; }
  var s = this.state;
  var sn = s.sensors;
  var ph = s.phases;

  if (sn.lightning > 0) {
    if (s.t >= s.stormUntil && !s.acceptedRisk) {
      sn.lightning = Math.max(0, sn.lightning - 0.06 * dt);
    } else if (s.acceptedRisk && s.t >= s.stormUntil) {
      sn.lightning = Math.max(0, sn.lightning - 0.05 * dt);
    }
  }

  if (ph.load.status === 'active' && ph.load.valveOpen) {
    if (s.leak.active) {
      var flow = RATES[ph.load.rate];
      ph.load.level = Math.max(0, ph.load.level - (flow * 0.8) * dt);
      sn.pressure += 0.012 * dt;
      if (s.t - (s.leak.startedAt || s.t) > 55 + s.leak.count * 20) {
        s.leak.active = false;
      }
    } else {
      var gates = this.evaluateGates();
      var stormBlock = gates.some(function (g) { return g.id === 'lightning' && g.level === 'red'; });
      if (stormBlock || s.t < ph.load.pauseUntil) {
        sn.pressure += (sn.pressure > 2.2 ? -0.004 : 0.002) * dt;
      } else {
        var rate = RATES[ph.load.rate];
        var add = rate * dt;
        ph.load.level = Math.min(100, ph.load.level + add);
        sn.pressure += 0.0020 * dt;
      }
    }
  } else if (ph.load.status === 'done' || ph.load.valveOpen) {
    if (sn.pressure < 2.2) { sn.pressure += 0.004 * dt; }
  }
  sn.pressure += (2.5 - sn.pressure) * 0.0012 * dt;
  if (sn.pressure > 5.0 && !s.leak.active) { sn.pressure = 5.0; }

  if (ph.cond.status === 'active') {
    var target = ph.cond.conditioned ? 8 : 28;
    var d = ph.cond.diff;
    var delta = (target - d);
    ph.cond.diff = d + delta * Math.min(1, 0.012 * dt);
    if (Math.abs(ph.cond.diff - target) <= 0.8) { ph.cond.diff = target; }
    if (ph.cond.status === 'active' && Math.abs(ph.cond.diff - (ph.cond.conditioned ? 8 : 28)) <= 1.0 && ph.cond.completedAt === null && ph.load.level >= 50 && s.t >= ph.cond.reconfirmAt) {
      ph.cond.completedAt = s.t;
    }
  }

  if (ph.evac.status === 'active') {
    ph.evac.progress = Math.min(100, ph.evac.progress + (100 / 900) * dt);
    if (ph.evac.progress >= 100 && ph.evac.completedAt === null) {
      ph.evac.completedAt = s.t;
      this.log('success', 'EVAC_DONE', '人员撤离完成，加注与地面设备许可前置条件满足');
    }
  }

  if (ph.load.status === 'active' && s.t >= -1500 && !ph.load.valveOpen) {
    ph.load.valveOpen = true;
  }
  if (ph.load.status === 'active' && ph.load.level >= 98 && ph.load.completedAt === null && !s.leak.active) {
    ph.load.completedAt = s.t;
    ph.load.valveOpen = false;
    this.log('success', 'LOAD_DONE', '推进剂加注完成（液位 98%），加注许可关闭');
  }

  if (ph.weather.status === 'active') {
    if (s.t < ph.weather.waitUntil) {
      // 等待雷电窗口解除
    } else if (this.evaluateGates().every(function (g) { return g.id !== 'lightning' || g.level !== 'red'; }) &&
               s.t >= -120 && ph.weather.completedAt === null) {
      ph.weather.completedAt = s.t;
    } else if (s.acceptedRisk && s.t >= -120 && ph.weather.completedAt === null) {
      ph.weather.completedAt = s.t;
    }
  }

  if (ph.ground.status === 'active') {
    if (ph.ground.armed && !ph.ground.disconnected && ph.ground.stepCursor >= ph.ground.steps.length && s.t >= -30) {
      ph.ground.disconnected = true;
    }
    var chainOk = !ph.ground.chainOpen && !s.commOut;
    if (chainOk && ph.ground.stepCursor < ph.ground.steps.length) {
      if (ph.ground.stepStartedAt === null) { ph.ground.stepStartedAt = s.t; }
      var stepNeed = 90;
      if (s.t - ph.ground.stepStartedAt >= stepNeed) {
        this.log('info', 'GROUND_STEP', '地面测试完成：' + ph.ground.steps[ph.ground.stepCursor].label);
        ph.ground.stepCursor += 1;
        ph.ground.stepStartedAt = s.t;
      }
    } else {
      ph.ground.stepStartedAt = null;
    }
    if (ph.ground.armed && ph.ground.stepCursor >= ph.ground.steps.length && ph.ground.disconnected) {
      ph.ground.completedAt = s.t;
    }
  }

  if (s.t >= 0) {
    var go = this.terminalGo();
    if (go.ok && s.status !== 'launched') {
      s.status = 'launched';
      ph.terminal.completedAt = s.t;
      this.log('success', 'LIFTOFF', '七路互锁全部 GO，点火起飞');
    } else {
      ph.terminal.hold = true;
    }
  }
};

Engine.prototype.autoStarts = function () {
  var s = this.state;
  var ph = s.phases;
  var t = s.t;
  if (ph.evac.status === 'pending' && t >= -2400) { ph.evac.startedAt = t; }
  if (ph.load.status === 'pending' && t >= -1500 && ph.evac.completedAt !== null) { ph.load.startedAt = t; }
  if (ph.cond.status === 'pending' && t >= -900 && ph.load.level > 0) { ph.cond.startedAt = t; }
  if (ph.weather.status === 'pending' && t >= -600) { ph.weather.startedAt = t; }
  if (ph.ground.status === 'pending' && t >= -480 && ph.evac.completedAt !== null) {
    ph.ground.startedAt = t;
    ph.ground.chainOpen = false;
  }
  if (ph.terminal.status === 'pending' && t >= -60) { ph.terminal.startedAt = t; }
};

Engine.prototype.schedule = function () {
  var s = this.state;
  var ph = s.phases;
  var now = s.t;

  var loadRemain = Math.max(0, 98 - ph.load.level) / (RATES[ph.load.rate] * 60);
  var loadFinish;
  if (ph.load.completedAt !== null) { loadFinish = ph.load.completedAt; }
  else if (ph.load.startedAt === null) { loadFinish = -1500 + loadRemain; }
  else { loadFinish = now + loadRemain; }
  if (!s.leak.active && ph.load.status === 'active' && ph.load.pauseUntil > now) {
    loadFinish = Math.max(loadFinish, ph.load.pauseUntil + loadRemain);
  }

  var condFinish;
  if (ph.cond.completedAt !== null) { condFinish = ph.cond.completedAt; }
  else {
    var target = ph.cond.conditioned ? 8 : 28;
    var gap = Math.abs(ph.cond.diff - target);
    var needSec = gap > 0.05 ? Math.log(gap / 0.8) / 0.012 : 0;
    condFinish = Math.max(-300, (ph.cond.startedAt === null ? -900 : now) + needSec);
  }

  var weatherFinish;
  if (ph.weather.completedAt !== null) { weatherFinish = ph.weather.completedAt; }
  else { weatherFinish = Math.max(-120, ph.weather.waitUntil); }

  var evacFinish;
  if (ph.evac.completedAt !== null) { evacFinish = ph.evac.completedAt; }
  else if (ph.evac.startedAt === null) { evacFinish = -1500; }
  else { evacFinish = now + (1 - ph.evac.progress / 100) * 900; }

  var groundFinish;
  if (ph.ground.completedAt !== null) { groundFinish = ph.ground.completedAt; }
  else {
    var chainReady = !ph.ground.chainOpen && !s.commOut;
    var stepsLeft = ph.ground.steps.length - ph.ground.stepCursor;
    var stepNeed = chainReady ? stepsLeft * 90 : ph.ground.steps.length * 90;
    var base = ph.ground.startedAt === null ? -480 : now;
    groundFinish = base + stepNeed;
    if (!ph.ground.disconnected) { groundFinish = Math.max(groundFinish, -30); }
    if (evacFinish > -480) { groundFinish = Math.max(groundFinish, evacFinish + stepNeed + 30); }
  }

  var est = Math.max(loadFinish + 60, condFinish + 30, weatherFinish, groundFinish, evacFinish + 60, 0);
  s.t0 = Math.max(0, est);
  s.slip = Math.max(0, Math.round(est));
  this.autoStarts();
  return {
    now: now, t0: s.t0, slip: s.slip,
    loadFinish: loadFinish, condFinish: condFinish, weatherFinish: weatherFinish,
    evacFinish: evacFinish, groundFinish: groundFinish
  };
};

Engine.prototype.terminalGo = function () {
  var gates = this.evaluateGates();
  var red = gates.filter(function (g) { return g.level === 'red'; });
  return { ok: red.length === 0, gates: gates, blockers: red };
};

Engine.prototype.evaluateGates = function () {
  var s = this.state;
  var ph = s.phases;
  var sn = s.sensors;
  var out = [];

  out.push({
    id: 'evac', label: GATES[0].label, anchor: 'evac',
    level: ph.evac.completedAt !== null ? 'green' : (ph.evac.progress >= 80 ? 'yellow' : 'red'),
    detail: '撤离进度 ' + Math.round(ph.evac.progress) + '%'
  });

  var lvl = ph.load.level;
  out.push({
    id: 'loading', label: GATES[1].label, anchor: 'load',
    level: lvl >= 98 ? 'green' : (lvl >= 85 ? 'yellow' : 'red'),
    detail: '当前加注量 ' + lvl.toFixed(1) + '%（' +
      ({ low: '低速', mid: '常速', high: '高速' })[ph.load.rate] + '，' +
      (ph.load.line === 'primary' ? '主用管路' : '备用管路') + '）'
  });

  var p = sn.pressure;
  out.push({
    id: 'pressure', label: GATES[2].label, anchor: 'load',
    level: (p >= 2.0 && p <= 4.5) ? 'green' : (p <= 4.8 ? 'yellow' : 'red'),
    detail: '贮箱压力 ' + p.toFixed(2) + ' bar' + (s.leak.active ? '（泄漏导致异常上升）' : '')
  });

  var diff = Math.abs(ph.cond.diff);
  out.push({
    id: 'temp_diff', label: GATES[3].label, anchor: 'cond',
    level: diff <= 20 ? 'green' : (diff <= 35 ? 'yellow' : 'red'),
    detail: '推进剂与箭体温差 |ΔT| = ' + diff.toFixed(1) + '°C'
  });

  var lk = sn.lightning;
  var lkLevel = lk < 20 ? 'green' : (lk < 50 ? 'yellow' : 'red');
  out.push({
    id: 'lightning', label: GATES[4].label, anchor: 'weather',
    level: lkLevel,
    detail: '雷电风险指数 ' + lk.toFixed(0) +
      (lkLevel === 'red' ? '（红色，禁止加注）' : lkLevel === 'yellow' ? '（黄色，需持续监视）' : '（绿色）')
  });

  var chainOk = !ph.ground.chainOpen && !s.commOut &&
    ph.ground.stepCursor >= ph.ground.steps.length &&
    ph.ground.armed && ph.ground.disconnected;
  var chainPartial = !ph.ground.chainOpen && !s.commOut;
  out.push({
    id: 'interlock', label: GATES[5].label, anchor: 'ground',
    level: chainOk ? 'green' : (chainPartial ? 'yellow' : 'red'),
    detail: chainOk ? '互锁链路闭合、脱拔完成' :
      ('互锁未闭合（链路' + (ph.ground.chainOpen ? '断开' : '闭合') +
       '，地面测试 ' + ph.ground.stepCursor + '/' + ph.ground.steps.length +
       '，脱拔' + (ph.ground.disconnected ? '完成' : '未完成') + ')')
  });

  out.push({
    id: 'comm', label: GATES[6].label, anchor: 'ground',
    level: s.commOut ? 'red' : (s.commQueue.length ? 'yellow' : 'green'),
    detail: s.commOut ? ('通信中断，预计 ' + fmtClock(s.commRestoreAt) + ' 恢复') :
      (s.commQueue.length ? '存在延迟到达指令待校验' : '通信链路正常')
  });

  return out;
};

function fmtClock(t) {
  var neg = t < 0;
  var v = Math.abs(Math.round(t));
  var mm = Math.floor(v / 60);
  var ss = v % 60;
  return (neg ? 'T-' : 'T+') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

var ACTION_META = {
  freeze: { label: '冻结倒计时', post: 'commander', anchors: [] },
  resume: { label: '恢复倒计时', post: 'commander', anchors: [] },
  setRate: { label: '调整加注速率', post: 'load', anchors: ['load', 'cond', 'terminal'] },
  switchLine: { label: '切换备用管路', post: 'load', anchors: ['load', 'cond', 'terminal'] },
  rollback: { label: '阶段回退', post: 'commander', anchors: [] },
  advance: { label: '阶段提前', post: 'commander', anchors: [] },
  armDisconnect: { label: '脱拔加电', post: 'ground', anchors: ['ground', 'terminal'] },
  triggerDisconnect: { label: '执行脱拔', post: 'ground', anchors: ['ground', 'terminal'] },
  isolateGround: { label: '设备互锁隔离/恢复', post: 'ground', anchors: ['ground', 'terminal'] },
  resolve: { label: '事件处置', post: 'safety', anchors: [] },
  inject: { label: '故障注入', post: 'safety', anchors: [] },
  acceptRisk: { label: '风险接受', post: 'commander', anchors: ['weather', 'load', 'terminal'] }
};

function sameResource(a, b) {
  if (a === b) { return true; }
  var groups = [
    ['setRate', 'switchLine'],
    ['isolateGround'],
    ['freeze', 'resume']
  ];
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].indexOf(a) >= 0 && groups[i].indexOf(b) >= 0) { return true; }
  }
  return false;
}

Engine.prototype.act = function (action, payload, post) {
  payload = payload || {};
  post = post || ACTION_META[action] && ACTION_META[action].post || 'commander';
  var s = this.state;

  if (action === 'inject') { return this.inject(payload.kind); }
  if (action === 'resolve') { return this.resolve(payload.optionId); }

  if (s.status === 'launched' || s.status === 'scrubbed') {
    return this.block('terminal', action, post, '流程已结束（' + (s.status === 'launched' ? '已点火' : '已中止') + '），拒绝任何控制指令', []);
  }

  if (s.commOut && action !== 'freeze') {
    s.commQueue.push({ action: action, payload: payload, post: post, queuedAt: s.t });
    return this.append({
      type: 'log', level: 'warn', code: 'COMM_DELAY',
      message: '通信中断：来自' + POST_LABEL[post] + '的「' + ACTION_META[action].label +
        '」未送达，已排队等待恢复后重新校验',
      extra: { action: action, post: post, queued: true }
    });
  }

  if (s.frozen && action !== 'resume') {
    return this.block('frozen', action, post, '倒计时处于冻结状态，仅允许恢复指令；该动作被拦截', []);
  }
  if (!s.frozen && action === 'resume') {
    return this.block('not_frozen', action, post, '倒计时未冻结，无需恢复', []);
  }

  if (s.lastCmd && s.t - s.lastCmd.at <= 10 && sameResource(s.lastCmd.action, action)) {
    var prev = s.lastCmd;
    var prevRank = POST_RANK[prev.post] || 0;
    var rank = POST_RANK[post] || 0;
    if (rank <= prevRank && !(action === 'freeze' || action === 'resume')) {
      return this.block('post_conflict', action, post,
        '多岗位指令冲突：' + POST_LABEL[prev.post] + ' 在 ' + fmtClock(prev.at) +
        ' 已下达同类指令，' + POST_LABEL[post] + ' 的指令需等待 10 秒或由更高权限覆盖',
        ACTION_META[action].anchors);
    }
  }

  var check = this.validate(action, payload, post);
  if (check && check.ok === false) {
    return this.block(check.code || 'rejected', action, post, check.message, check.anchors || ACTION_META[action].anchors);
  }

  var ev = {
    type: 'dispatch', name: action, payload: payload, post: post,
    message: POST_LABEL[post] + '执行「' + ACTION_META[action].label + '」'
  };
  if (action !== 'freeze' && action !== 'resume') { s.lastCmd = { action: action, post: post, at: s.t }; }
  this.append(ev);
  this.schedule();
  return ev;
};

Engine.prototype.block = function (code, action, post, message, anchors) {
  var ev = {
    type: 'dispatch', name: 'blocked', blocked: true,
    payload: { code: code, action: action, post: post },
    post: post,
    message: '已阻止错误动作：' + message,
    impacts: impactsOf(anchors)
  };
  this.append(ev);
  return ev;
};

Engine.prototype.validate = function (action, payload, post) {
  var s = this.state;
  var ph = s.phases;
  var gates = this.evaluateGates();
  var lk = gates.filter(function (g) { return g.id === 'lightning'; })[0];

  if (action === 'setRate') {
    if (ph.load.completedAt !== null) { return { ok: false, code: 'phase_done', message: '加注已完成，不能再调整速率', anchors: ['load'] }; }
    if (['low', 'mid', 'high'].indexOf(payload.rate) < 0) { return { ok: false, code: 'bad_rate', message: '未知加注速率', anchors: ['load'] }; }
    if (payload.rate === ph.load.rate) { return { ok: false, code: 'no_change', message: '加注速率已是该档位', anchors: ['load'] }; }
    if (payload.rate === 'high' && s.sensors.pressure > 3.8) {
      return { ok: false, code: 'pressure_high', message: '当前压力 ' + s.sensors.pressure.toFixed(2) + ' bar，禁止升到高速加注', anchors: ['load', 'cond', 'terminal'] };
    }
  }

  if (action === 'switchLine') {
    if (ph.load.completedAt !== null) { return { ok: false, code: 'phase_done', message: '加注已完成，无法切换管路', anchors: ['load'] }; }
    if (s.leak.active) { return { ok: false, code: 'leak_open', message: '泄漏尚未处置，禁止带压切换管路', anchors: ['load', 'cond', 'terminal'] }; }
  }

  if (action === 'rollback') {
    var rbId = payload.phase;
    if (!rbId || !ph[rbId]) { return { ok: false, code: 'bad_phase', message: '未指定要回退的阶段' }; }
    var rb = ph[rbId];
    if (rb.completedAt === null) { return { ok: false, code: 'not_done', message: phaseLabel(rbId) + '尚未完成，无需回退' }; }
    if (rbId === 'evac') {
      var downstreamDone = Object.keys(DOWNSTREAM.evac).some(function (d) { return ph[d].completedAt !== null; });
      if (downstreamDone) { return { ok: false, code: 'unsafe_rollback', message: '撤离后序环节已有完成项，人员返场存在严重安全风险，拒绝回退撤离', anchors: ['evac', 'load', 'ground', 'terminal'] }; }
    }
    if (rbId === 'ground' && s.t < -600) { return { ok: false, code: 'too_early', message: '地面阶段尚未开始，不能回退' }; }
  }

  if (action === 'advance') {
    var adId = payload.phase;
    if (!adId || !ph[adId]) { return { ok: false, code: 'bad_phase', message: '未指定要提前的阶段' }; }
    if (adId === 'load') {
      if (ph.evac.completedAt === null) { return { ok: false, code: 'evac_open', message: '人员未全部撤离，提前打开加注阀被安全互锁拦截', anchors: ['evac', 'load'] }; }
      if (lk.level === 'red') { return { ok: false, code: 'storm_red', message: '雷电红色预警中，提前加注被禁止', anchors: ['weather', 'load', 'terminal'] }; }
    }
    if (adId === 'ground' && ph.evac.completedAt === null) {
      return { ok: false, code: 'evac_open', message: '人员未撤离，提前启动地面设备会造成人员伤害', anchors: ['evac', 'ground'] };
    }
    if (adId === 'cond' && ph.load.level < 30) {
      return { ok: false, code: 'level_low', message: '加注量不足 30%，提前温控没有意义且会导致大面积结霜', anchors: ['load', 'cond', 'terminal'] };
    }
    if (ph[adId].status === 'done') { return { ok: false, code: 'already_done', message: phaseLabel(adId) + '已完成，无法提前' }; }
  }

  if (action === 'armDisconnect') {
    if (ph.ground.completedAt !== null) { return { ok: false, code: 'done', message: '地面流程已结束', anchors: ['ground'] }; }
    if (ph.ground.chainOpen) { return { ok: false, code: 'chain_open', message: '设备互锁链路处于断开/隔离状态，脱拔不能加电', anchors: ['ground', 'terminal'] }; }
    if (ph.ground.stepCursor < ph.ground.steps.length) { return { ok: false, code: 'tests_left', message: '地面测试项目未全部完成，不允许脱拔加电', anchors: ['ground', 'terminal'] }; }
  }

  if (action === 'triggerDisconnect') {
    if (!ph.ground.armed) { return { ok: false, code: 'not_armed', message: '脱拔未加电，禁止执行脱拔', anchors: ['ground', 'terminal'] }; }
    if (s.t < -30) { return { ok: false, code: 'too_early', message: '仅允许在 T-30s 之后执行脱拔，当前提前量过大', anchors: ['ground', 'terminal'] }; }
  }

  if (action === 'isolateGround') {
    if (!ph.ground.chainOpen && ph.ground.stepCursor > 0) {
      return { ok: false, code: 'tests_running', message: '地面测试已开始，运行中隔离互锁会中断已确认状态', anchors: ['ground', 'terminal'] };
    }
  }

  return { ok: true };
};

Engine.prototype.apply_freeze = function (ev, s) {
  s.frozen = true;
  ev.message = '指挥员冻结倒计时：真实时钟继续，许可时间保持不变';
};

Engine.prototype.apply_resume = function (ev, s) {
  s.frozen = false;
  ev.message = '冻结解除，恢复真实倒计时阶段（当前 ' + fmtClock(s.t) + '）';
};

Engine.prototype.apply_setRate = function (ev, s) {
  var old = s.phases.load.rate;
  s.phases.load.rate = ev.payload.rate;
  var labelMap = { low: '低速', mid: '常速', high: '高速' };
  ev.message = '加注速率 ' + labelMap[old] + ' → ' + labelMap[ev.payload.rate] + '，许可时刻已重新计算';
  ev.impacts = impactsOf(['load']);
};

Engine.prototype.apply_switchLine = function (ev, s) {
  var old = s.phases.load.line;
  var next = old === 'primary' ? 'spare' : 'primary';
  s.phases.load.line = next;
  s.phases.load.pauseUntil = s.t + 45;
  ev.message = '已从' + (old === 'primary' ? '主用管路' : '备用管路') + '切换到' +
    (next === 'primary' ? '主用管路' : '备用管路') + '，加注暂停 45 秒用于建压';
  ev.impacts = impactsOf(['load']);
};

Engine.prototype.apply_rollback = function (ev, s) {
  var id = ev.payload.phase;
  var ph = s.phases[id];
  if (id === 'load') {
    ph.level = Math.min(ph.level, 80);
    ph.completedAt = null;
    ph.valveOpen = true;
    s.phases.cond.completedAt = null;
    s.phases.cond.diff = 40;
    s.phases.cond.reconfirmAt = s.t + 120;
    ev.message = '加注回退：液位回落至 80% 重新补加，温控确认同步作废';
    ev.impacts = impactsOf(['load']);
  } else if (id === 'cond') {
    ph.completedAt = null;
    ph.diff = 30;
    ph.reconfirmAt = s.t + 120;
    ev.message = '温控回退：重新建立温度梯度，终端许可推迟';
    ev.impacts = impactsOf(['cond']);
  } else if (id === 'ground') {
    ph.completedAt = null;
    ph.stepCursor = 0;
    ph.stepStartedAt = null;
    ph.armed = false;
    ph.disconnected = false;
    ph.chainOpen = true;
    ev.message = '地面设备回退：互锁链路重新断开，测试项全部复检';
    ev.impacts = impactsOf(['ground']);
  } else if (id === 'weather') {
    ph.completedAt = null;
    ph.waitUntil = s.t + 180;
    ev.message = '天气窗口回退：重新确认 3 分钟窗口';
    ev.impacts = impactsOf(['weather']);
  } else if (id === 'evac') {
    ph.completedAt = null;
    ph.progress = Math.min(ph.progress, 60);
    ev.message = '撤离回退：重新清点人员';
    ev.impacts = impactsOf(['evac']);
  }
};

Engine.prototype.apply_advance = function (ev, s) {
  var id = ev.payload.phase;
  var ph = s.phases[id];
  if (ph.startedAt === null) { ph.startedAt = s.t; }
  if (id === 'load') { ph.valveOpen = true; ev.message = '加注提前开阀（撤离已确认、雷电允许）'; }
  if (id === 'cond') { ev.message = '温控提前启动'; }
  if (id === 'ground') { ev.message = '地面设备测试提前启动'; }
  if (id === 'weather') { ph.waitUntil = s.t; ev.message = '天气窗口提前确认放行'; }
  ev.impacts = impactsOf([id]);
};

Engine.prototype.apply_armDisconnect = function (ev, s) {
  s.phases.ground.armed = true;
  ev.message = '脱拔系统已加电待命';
  ev.impacts = impactsOf(['ground']);
};

Engine.prototype.apply_triggerDisconnect = function (ev, s) {
  s.phases.ground.disconnected = true;
  ev.message = '地面连接断开（脱拔完成）';
  ev.impacts = impactsOf(['ground']);
};

Engine.prototype.apply_isolateGround = function (ev, s) {
  var next = !s.phases.ground.chainOpen;
  s.phases.ground.chainOpen = next;
  ev.message = next ? '设备互锁链路已隔离（测试暂停，终端许可被扣留）' : '互锁链路恢复闭合，测试继续';
  ev.impacts = impactsOf(['ground']);
};

Engine.prototype.apply_comm_restored = function (ev, s) {
  s.commOut = false;
  var queued = s.commQueue.slice();
  s.commQueue = [];
  ev.message = '通信恢复，开始重新校验 ' + queued.length + ' 条排队指令';
  var self = this;
  queued.forEach(function (cmd) {
    var recheck = self.validate(cmd.action, cmd.payload, cmd.post);
    if (recheck && recheck.ok === false) {
      self.block('revalidated_reject', cmd.action, cmd.post,
        '延迟指令恢复后重新校验未通过：' + recheck.message,
        recheck.anchors || ACTION_META[cmd.action].anchors);
    } else {
      self.append({
        type: 'dispatch', name: cmd.action, payload: cmd.payload, post: cmd.post,
        delayed: true,
        message: POST_LABEL[cmd.post] + '的延迟指令「' + ACTION_META[cmd.action].label + '」恢复送达并执行'
      });
    }
  });
};

Engine.prototype.makeIncident = function (kind, title, options) {
  var s = this.state;
  s.incident = { kind: kind, title: title, startedAt: s.t, options: options };
  this.append({
    type: 'dispatch', name: 'incident_open',
    message: '事件触发：' + title + '，倒计时继续运行但相关许可被扣留',
    incident: clone(s.incident)
  });
};

Engine.prototype.inject = function (kind) {
  var s = this.state;
  if (s.incident || s.leak.active) {
    return this.block('incident_busy', 'inject', 'safety', '已有未处置事件，不能叠加注入', []);
  }
  if (kind === 'leak') {
    if (s.phases.load.completedAt !== null || s.phases.load.status === 'pending') {
      return this.block('bad_window', 'inject', 'safety', '泄漏注入仅在加注窗口内有效', ['load']);
    }
    s.leak.active = true;
    s.leak.count += 1;
    s.leak.startedAt = s.t;
    this.append({
      type: 'dispatch', name: 'leak_detected',
      message: '推进剂泄漏报警：液位异常下降、压力快速上升，加注许可立即扣留'
    });
    return this.makeIncident('leak', '推进剂管路泄漏', [
      { id: 'leak_emergency', label: '紧急停注并排空（安全优先）' },
      { id: 'leak_switch', label: '隔离泄漏段并切换备用管路' },
      { id: 'leak_wait', label: '持续监测，等待定位后处置' }
    ]);
  }
  if (kind === 'storm') {
    s.stormUntil = s.t + 240;
    s.sensors.lightning = 78;
    this.append({
      type: 'dispatch', name: 'storm_detected',
      message: '雷暴前锋到达：雷电风险指数升至 78（红色），加注阀门自动关闭'
    });
    return this.makeIncident('storm', '雷暴窗口冲击', [
      { id: 'storm_wait', label: '原地等待窗口（约 4 分钟）' },
      { id: 'storm_waiver', label: '风险接受：签字放行加注' }
    ]);
  }
  if (kind === 'comm') {
    s.commOut = true;
    s.commRestoreAt = s.t + 90;
    this.append({
      type: 'dispatch', name: 'comm_lost',
      message: '主通信链路中断：现场指令转为排队，90 秒后恢复并重新校验'
    });
    return this.makeIncident('comm', '通信延迟/中断', [
      { id: 'comm_standby', label: '保持自主倒计时，等待链路恢复' },
      { id: 'comm_freeze', label: '立即冻结全部地面动作' }
    ]);
  }
  return this.block('bad_kind', 'inject', 'safety', '未知故障类型', []);
};

Engine.prototype.resolve = function (optionId) {
  var s = this.state;
  if (!s.incident) { return this.block('no_incident', 'resolve', 'safety', '当前没有待处置事件', []); }
  var found = null;
  s.incident.options.forEach(function (o) { if (o.id === optionId) { found = o; } });
  if (!found) { return this.block('bad_option', 'resolve', 'safety', '处置选项不存在', []); }

  var branchId = 'b' + this.seq;
  var prefixLen = this.eventLog.length;
  this.branches[branchId] = {
    id: branchId,
    parentId: s.branchId,
    label: s.incident.title + ' / ' + found.label,
    rootState: clone(this.state),
    prefixLen: prefixLen,
    eventIndices: [],
    createdAt: s.t,
    resolved: null,
    options: clone(s.incident.options),
    chosenOption: found.label
  };

  var ev = this.append({
    type: 'fork',
    name: 'resolve',
    forkBranch: branchId,
    branchIdOverride: branchId,
    optionId: optionId,
    incidentTitle: s.incident.title,
    message: '处置决策：' + found.label + '（已生成可回放时间分支 ' + branchId + '）'
  });

  s.branchId = branchId;
  var kind = s.incident.kind;
  s.incident = null;

  if (kind === 'leak') {
    if (optionId === 'leak_emergency') {
      s.leak.active = false;
      s.phases.load.valveOpen = false;
      s.phases.load.level = Math.max(0, s.phases.load.level - 15);
      s.phases.load.pauseUntil = s.t + 300;
      s.sensors.pressure = 2.1;
      ev.message += '；已停注排空，预计损失 5 分钟许可时间';
    } else if (optionId === 'leak_switch') {
      s.leak.active = false;
      s.phases.load.line = 'spare';
      s.phases.load.pauseUntil = s.t + 120;
      s.sensors.pressure = 2.4;
      ev.message += '；泄漏段隔离，120 秒后经备用管路恢复加注';
    } else {
      s.phases.load.pauseUntil = s.t + 150;
      ev.message += '；持续监测中，若 T-60 前未恢复将强制中止';
    }
  } else if (kind === 'storm') {
    if (optionId === 'storm_wait') {
      s.phases.weather.waitUntil = Math.max(s.phases.weather.waitUntil, s.stormUntil);
      ev.message += '；加注保持暂停，许可时刻后移至窗口之后';
    } else {
      s.acceptedRisk = true;
      s.phases.weather.waitUntil = s.t;
      ev.message += '；已签字接受风险（雷电黄/红期间允许继续）';
    }
  } else if (kind === 'comm') {
    if (optionId === 'comm_freeze') {
      s.frozen = true;
      ev.message += '；全部地面动作冻结，通信恢复后需手动解冻';
    } else {
      ev.message += '；倒计时自主继续，恢复后统一重放校验';
    }
  }

  this.branches[branchId].resolved = clone(this.state);
  ev.finalState = clone(this.state);
  this.schedule();
  return ev;
};

Engine.prototype.replayBranch = function (branchId) {
  var meta = this.branches[branchId];
  if (!meta) { return null; }
  var sandbox = new Engine();
  sandbox.state = clone(meta.rootState);
  sandbox.eventLog = [];
  sandbox.seq = 200000;
  var self = this;
  this.eventLog.slice(meta.prefixLen).forEach(function (ev) {
    if (self.isOnPath(ev.branchId, branchId)) {
      var copy = clone(ev);
      sandbox.eventLog.push(copy);
      sandbox.applyEvent(copy);
    }
  });
  return { meta: meta, engine: sandbox, events: sandbox.eventLog };
};

Engine.prototype.isOnPath = function (descendantId, ancestorId) {
  var cur = descendantId;
  while (cur) {
    if (cur === ancestorId) { return true; }
    cur = this.branches[cur] && this.branches[cur].parentId;
  }
  return false;
};

Engine.prototype.branchTree = function () {
  return this.branches;
};

Engine.prototype.scrubIfUnresolved = function () {
  var s = this.state;
  if (s.t >= -60 && s.incident) {
    s.status = 'scrubbed';
    this.append({
      type: 'dispatch', name: 'scrub',
      message: '已过 T-60 决策点仍有未处置事件，发射自动中止（scrub）'
    });
    s.incident = null;
  }
};

Engine.prototype.permittedActions = function () {
  var s = this.state;
  var list = [];
  var self = this;
  Object.keys(ACTION_META).forEach(function (name) {
    if (name === 'inject' || name === 'resolve' || name === 'acceptRisk') { return; }
    var probes = probePayloads(name);
    probes.forEach(function (probe) {
      var check = self.validate(name, probe.payload, probe.post);
      if (!s.frozen || name === 'resume') {
        list.push({
          action: name,
          payload: probe.payload,
          post: probe.post,
          label: probe.label,
          allowed: check.ok !== false && !(s.commOut && name !== 'freeze'),
          reason: check.ok === false ? check.message : (s.commOut && name !== 'freeze' ? '通信中断，将排队等待恢复' : null)
        });
      }
    });
  });
  return list;
};

function probePayloads(name) {
  if (name === 'setRate') {
    return [
      { payload: { rate: 'low' }, post: 'load', label: '加注切低速' },
      { payload: { rate: 'mid' }, post: 'load', label: '加注切常速' },
      { payload: { rate: 'high' }, post: 'load', label: '加注切高速' }
    ];
  }
  if (name === 'rollback') {
    return ['evac', 'load', 'cond', 'weather', 'ground'].map(function (id) {
      return { payload: { phase: id }, post: 'commander', label: '回退：' + phaseLabel(id) };
    });
  }
  if (name === 'advance') {
    return ['load', 'cond', 'ground', 'weather'].map(function (id) {
      return { payload: { phase: id }, post: 'commander', label: '提前：' + phaseLabel(id) };
    });
  }
  var meta = ACTION_META[name];
  return [{ payload: {}, post: meta.post, label: meta.label }];
}

var api = {
  Engine: Engine,
  PLAN: PLAN,
  GATES: GATES,
  RATES: RATES,
  EDGES: EDGES,
  POST_LABEL: POST_LABEL,
  ACTION_META: ACTION_META,
  impactsOf: impactsOf,
  fmtClock: fmtClock,
  phaseLabel: phaseLabel,
  T_START: T_START
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  global.Countdown = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
