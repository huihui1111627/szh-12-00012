var assert = require('assert');
var C = require('../js/engine.js');

function run(eng, until) {
  while (eng.state.t < until && eng.state.status !== 'scrubbed' && eng.state.status !== 'launched') {
    eng.tick(1);
    eng.schedule();
  }
}

var passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok - ' + name);
}

console.log('countdown engine tests:');

test('额定流程 T-0 滑移为 0', function () {
  var e = new C.Engine();
  run(e, 0);
  assert.strictEqual(e.state.slip, 0);
  assert.strictEqual(e.state.phases.load.level >= 98, true);
  assert.strictEqual(e.state.phases.evac.completedAt !== null, true);
});

test('七路全绿 + 脱拔加电后准时点火', function () {
  var e = new C.Engine();
  run(e, -61);
  e.act('armDisconnect', {}, 'ground');
  run(e, 0);
  assert.strictEqual(e.state.status, 'launched');
  assert.ok(e.terminalGo().ok);
});

test('低速加注导致窗口滑移', function () {
  var e = new C.Engine();
  run(e, -1490);
  e.act('setRate', { rate: 'low' }, 'load');
  run(e, 0);
  assert.ok(e.state.slip > 0, '滑移应当大于 0');
});

test('冻结期间许可时刻不变，恢复后按真实时间重算', function () {
  var e = new C.Engine();
  run(e, -1000);
  var slipBefore = e.state.slip;
  e.act('freeze', {}, 'commander');
  for (var i = 0; i < 120; i++) { e.tick(1); }
  assert.strictEqual(e.state.t, -1000);
  assert.strictEqual(e.state.slip, slipBefore);
  e.act('resume', {}, 'commander');
  run(e, -880);
  assert.strictEqual(e.state.t, -880);
});

test('冻结时除恢复外所有动作被拦截', function () {
  var e = new C.Engine();
  run(e, -1200);
  e.act('freeze', {}, 'commander');
  var ev = e.act('setRate', { rate: 'low' }, 'load');
  assert.strictEqual(ev.blocked, true);
  assert.strictEqual(ev.payload.code, 'frozen');
});

test('泄漏时切换管路被阻止并标注传播环节', function () {
  var e = new C.Engine();
  run(e, -1200);
  e.act('inject', { kind: 'leak' }, 'safety');
  var ev = e.act('switchLine', {}, 'load');
  assert.strictEqual(ev.blocked, true);
  var ids = ev.impacts.map(function (i) { return i.id; });
  ['load', 'cond', 'ground', 'terminal'].forEach(function (id) {
    assert.notStrictEqual(ids.indexOf(id), -1);
  });
});

test('处置生成可回放分支，回放状态与处置结果一致', function () {
  var e = new C.Engine();
  run(e, -1200);
  e.act('inject', { kind: 'leak' }, 'safety');
  var fork = e.resolve('leak_switch');
  assert.ok(e.branches[fork.forkBranch]);
  var rep = e.replayBranch(fork.forkBranch);
  assert.strictEqual(rep.engine.state.phases.load.line, 'spare');
  assert.strictEqual(rep.engine.state.incident, null);
});

test('雷暴红色时提前加注被天气互锁拦截', function () {
  var e = new C.Engine();
  run(e, -1000);
  e.act('inject', { kind: 'storm' }, 'safety');
  var ev = e.act('advance', { phase: 'load' }, 'commander');
  assert.strictEqual(ev.blocked, true);
  assert.strictEqual(ev.payload.code, 'storm_red');
});

test('通信中断时指令排队，恢复后重新校验并延迟执行', function () {
  var e = new C.Engine();
  run(e, -900);
  e.act('inject', { kind: 'comm' }, 'safety');
  var queued = e.act('setRate', { rate: 'low' }, 'load');
  assert.strictEqual(queued.code, 'COMM_DELAY');
  run(e, -805);
  assert.strictEqual(e.state.commOut, false);
  assert.strictEqual(e.state.phases.load.rate, 'low');
});

test('通信中断期间冻结指令仍可立即送达', function () {
  var e = new C.Engine();
  run(e, -900);
  e.act('inject', { kind: 'comm' }, 'safety');
  var ev = e.act('freeze', {}, 'commander');
  assert.ok(!ev.blocked);
  assert.strictEqual(e.state.frozen, true);
});

test('同资源 10 秒内低权限岗位冲突指令被拦截', function () {
  var e = new C.Engine();
  run(e, -1200);
  e.act('setRate', { rate: 'low' }, 'load');
  var ev = e.act('setRate', { rate: 'high' }, 'ground');
  assert.strictEqual(ev.blocked, true);
  assert.strictEqual(ev.payload.code, 'post_conflict');
});

test('指挥员可立即覆盖低权限同资源指令', function () {
  var e = new C.Engine();
  run(e, -1200);
  e.act('setRate', { rate: 'low' }, 'load');
  var ev = e.act('setRate', { rate: 'high' }, 'commander');
  assert.strictEqual(ev.blocked, undefined);
  assert.strictEqual(e.state.phases.load.rate, 'high');
});

test('人员未撤离时提前加注被安全互锁拦截', function () {
  var e = new C.Engine();
  run(e, -1520);
  var ev = e.act('advance', { phase: 'load' }, 'commander');
  assert.strictEqual(ev.blocked, true);
  assert.strictEqual(ev.payload.code, 'evac_open');
});

test('后序已完成后回退撤离被安全规则拒绝', function () {
  var e = new C.Engine();
  run(e, -400);
  var ev = e.act('rollback', { phase: 'evac' }, 'commander');
  assert.strictEqual(ev.blocked, true);
  assert.strictEqual(ev.payload.code, 'unsafe_rollback');
});

test('回退加注会把温控确认一并作废并重算许可', function () {
  var e = new C.Engine();
  run(e, -150);
  e.act('rollback', { phase: 'load' }, 'commander');
  assert.strictEqual(e.state.phases.load.completedAt, null);
  assert.strictEqual(e.state.phases.cond.completedAt, null);
  assert.ok(e.state.slip > 0);
});

test('脱拔必须先加电且不早于 T-30', function () {
  var e = new C.Engine();
  run(e, -120);
  var ev1 = e.act('triggerDisconnect', {}, 'ground');
  assert.strictEqual(ev1.blocked, true);
  e.act('armDisconnect', {}, 'ground');
  var ev2 = e.act('triggerDisconnect', {}, 'ground');
  assert.strictEqual(ev2.blocked, true);
  assert.strictEqual(ev2.payload.code, 'too_early');
  run(e, -30);
  var ev3 = e.act('triggerDisconnect', {}, 'ground');
  assert.strictEqual(ev3.blocked, undefined);
});

test('T-60 仍有未处置事件则自动中止', function () {
  var e = new C.Engine();
  run(e, -500);
  e.act('inject', { kind: 'leak' }, 'safety');
  run(e, -59);
  assert.strictEqual(e.state.status, 'scrubbed');
});

console.log('\n' + passed + ' tests passed');
