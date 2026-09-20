"""倒计时控制引擎: 统一调度五大赛事, 持续评估约束, 仲裁指令,
记录影响传播, 并以事件快照支持时间分支回放."""
from __future__ import annotations

from dataclasses import asdict
from typing import Callable, Dict, List, Optional, Tuple

from . import arbiter as arb
from .constraints import (
    CRITICAL,
    WARNING,
    Violation,
    blocked_phases,
    default_monitors,
    evaluate_all,
    has_critical,
)
from .models import Impact, Phase, PhaseStatus, Telemetry, default_phases
from .scheduler import downstream_of, recompute_schedule
from .timeline import MAIN, Timeline

# 切换管路所需的切换作业时间(秒), 期间加注暂停
PIPELINE_SWITCH_SECONDS = 300.0
MIN_RATE = 1.0
MAX_RATE = 50.0


class CommandRejected(Exception):
    pass


class Session:
    def __init__(self, phases: Optional[List[Phase]] = None,
                 monitors=None, conflict_window: float = arb.CONFLICT_WINDOW_S):
        self.timeline = Timeline()
        self.phases: Dict[str, Phase] = {p.key: p for p in (phases or default_phases())}
        self.order: List[str] = list(self.phases.keys())
        self.monitors = monitors if monitors is not None else default_monitors()
        self.arbiter = arb.CommandArbiter(conflict_window)

        self.clock = 0.0
        self.load_rate = 10.0          # kg/s
        self.pipeline = "main"
        self.pipeline_switch_remaining = 0.0
        self.frozen = False            # 临时冻结(可恢复)
        self.safety_frozen = False     # 严重违例触发的安全冻结(遥测恢复后自动解除)
        self.conflict_frozen = False   # 多岗位指令冲突触发的冻结(须 RESOLVE)
        self._held_keys: set = set()   # 当前因 WARNING 挂起的环节
        self.telemetry = Telemetry()
        self.violations: List[Violation] = []
        self.impacts: List[Impact] = []
        self.launched = False

        recompute_schedule(self.phases, self.order, self.clock,
                           self.load_rate, "初始排程")
        self._log("INIT", "初始化倒计时流程", {})

    # ---------------------------------------------------------------- 快照
    def _snapshot(self) -> Dict:
        return {
            "clock": self.clock,
            "load_rate": self.load_rate,
            "pipeline": self.pipeline,
            "pipeline_switch_remaining": self.pipeline_switch_remaining,
            "frozen": self.frozen,
            "safety_frozen": self.safety_frozen,
            "conflict_frozen": self.conflict_frozen,
            "launched": self.launched,
            "telemetry": asdict(self.telemetry),
            "phases": [
                {
                    "key": p.key, "name": p.name, "duration": p.duration,
                    "depends_on": list(p.depends_on), "status": p.status.value,
                    "progress": p.progress,
                    "planned_start": p.planned_start, "planned_end": p.planned_end,
                    "actual_start": p.actual_start, "actual_end": p.actual_end,
                }
                for p in (self.phases[k] for k in self.order)
            ],
        }

    def _restore(self, snap: Dict) -> None:
        self.clock = snap["clock"]
        self.load_rate = snap["load_rate"]
        self.pipeline = snap["pipeline"]
        self.pipeline_switch_remaining = snap["pipeline_switch_remaining"]
        self.frozen = snap["frozen"]
        self.safety_frozen = snap["safety_frozen"]
        self.conflict_frozen = snap.get("conflict_frozen", False)
        self.launched = snap["launched"]
        self._held_keys = set()
        self.telemetry = Telemetry(**snap["telemetry"])
        self.phases = {}
        for d in snap["phases"]:
            self.phases[d["key"]] = Phase(
                d["key"], d["name"], d["duration"], tuple(d["depends_on"]),
                PhaseStatus(d["status"]), d["progress"],
                d["planned_start"], d["planned_end"],
                d["actual_start"], d["actual_end"],
            )
        self.order = [d["key"] for d in snap["phases"]]
        self.violations = evaluate_all(self.monitors, self.telemetry)

    # ------------------------------------------------------------ 事件日志
    def _log(self, type_: str, summary: str, extra: Optional[Dict] = None) -> None:
        payload = dict(extra or {})
        payload["snapshot"] = self._snapshot()
        self.timeline.append(type_, self.clock, summary, payload)

    @property
    def current_branch(self) -> str:
        return self.timeline.current

    @property
    def held_globally(self) -> bool:
        return self.frozen or self.safety_frozen or self.conflict_frozen

    # ------------------------------------------------------------ 时间推进
    def update_telemetry(self, **values) -> List[Violation]:
        """注入最新遥测并立即评估一次约束(不推进时钟)."""
        for key, value in values.items():
            if not hasattr(self.telemetry, key):
                raise AttributeError(f"未知遥测量: {key}")
            setattr(self.telemetry, key, value)
        return self._evaluate(telemetry_event=True)

    def tick(self, dt: float, telemetry: Optional[Telemetry] = None) -> List[Violation]:
        """推进任务时钟 dt 秒, 持续评估约束并推进各环节."""
        if telemetry is not None:
            self.telemetry = telemetry
        self.clock += dt
        self._evaluate(telemetry_event=False)
        self._advance_phases(dt, self.clock - dt)
        self._log("TICK", f"推进 {dt:g}s", {"dt": dt})
        return list(self.violations)

    def _evaluate(self, telemetry_event: bool) -> List[Violation]:
        self.violations = evaluate_all(self.monitors, self.telemetry)
        critical = has_critical(self.violations)
        if critical and not self.safety_frozen:
            self.safety_frozen = True
            self._log(
                "CRITICAL",
                "严重违例, 倒计时安全冻结: "
                + "; ".join(v.message for v in self.violations if v.severity == CRITICAL),
                {"violations": [asdict(v) for v in self.violations]},
            )
        elif not critical and self.safety_frozen:
            self.safety_frozen = False
            impacts = recompute_schedule(
                self.phases, self.order, self.clock, self.load_rate,
                "严重违例解除, 冻结期间延误向下游传播")
            self.impacts.extend(impacts)
            self._log(
                "CRITICAL_CLEARED",
                "严重违例已排除, 安全冻结解除, 许可时间重算",
                {"impacts": [vars(i) for i in impacts]},
            )
        elif telemetry_event:
            self._log(
                "TELEMETRY",
                "遥测更新" + ("，违例 " + str(len(self.violations)) + " 项"
                          if self.violations else "，全部正常"),
                {"violations": [asdict(v) for v in self.violations]},
            )
        return list(self.violations)

    def _advance_phases(self, dt: float, clock_start: float) -> None:
        blocked = self.violations_blocked()
        if self.held_globally or self.launched:
            self._apply_holds(blocked)
            return

        switching = self.pipeline_switch_remaining > 0
        if switching:
            self.pipeline_switch_remaining = max(
                0.0, self.pipeline_switch_remaining - dt)

        # 本拍起始时刻已完成的环节; 本拍内才完成的依赖会让下游本拍零进度
        completed_at_start = {
            key for key in self.order
            if self.phases[key].status is PhaseStatus.COMPLETE
        }
        activated_this_tick: set = set()
        for key in self.order:
            ph = self.phases[key]
            if ph.status is PhaseStatus.COMPLETE:
                continue

            deps = set(ph.depends_on)
            if not deps.issubset(completed_at_start | {
                    k for k in self.order if self.phases[k].status is PhaseStatus.COMPLETE}):
                ph.status = PhaseStatus.PENDING
                continue
            deps_ready_before_tick = deps.issubset(completed_at_start)

            if key in blocked or not self._special_gate_ok(key):
                if ph.status is PhaseStatus.ACTIVE:
                    ph.status = PhaseStatus.HOLD
                    impacts = recompute_schedule(
                        self.phases, self.order, self.clock, self.load_rate,
                        "约束/互锁挂起, 许可时间顺延")
                    self.impacts.extend(impacts)
                elif ph.status not in (PhaseStatus.HOLD,):
                    ph.status = PhaseStatus.HOLD
                continue

            if ph.status in (PhaseStatus.READY, PhaseStatus.HOLD,
                             PhaseStatus.ROLLED_BACK, PhaseStatus.PENDING):
                ph.status = PhaseStatus.ACTIVE
                if ph.actual_start is None:
                    ph.actual_start = clock_start if deps_ready_before_tick else self.clock
                if not deps_ready_before_tick:
                    activated_this_tick.add(key)
                    continue

            if key == "load" and switching:
                continue
            ph.progress = min(1.0, ph.progress + dt / ph.duration)
            if ph.progress >= 1.0:
                self._complete(key)

        self._held_keys = blocked

    def violations_blocked(self) -> set:
        blocked = blocked_phases([v for v in self.violations
                                  if v.severity == WARNING])
        # 切管作业期间加注挂起
        if self.pipeline_switch_remaining > 0:
            blocked.add("load")
        return blocked

    def _apply_holds(self, blocked: set) -> None:
        for key in self.order:
            ph = self.phases[key]
            if ph.status in (PhaseStatus.COMPLETE, PhaseStatus.PENDING):
                continue
            deps_done = all(self.phases[d].status is PhaseStatus.COMPLETE
                            for d in ph.depends_on)
            if not deps_done:
                continue
            if key in blocked and ph.status is PhaseStatus.ACTIVE:
                ph.status = PhaseStatus.HOLD

    def _special_gate_ok(self, key: str) -> bool:
        # 点火前必须确认人员已撤离
        if key == "launch" and not self.telemetry.personnel_cleared:
            return False
        return True

    def _complete(self, key: str) -> None:
        ph = self.phases[key]
        ph.progress = 1.0
        ph.status = PhaseStatus.COMPLETE
        ph.actual_end = self.clock
        impacts = recompute_schedule(self.phases, self.order, self.clock,
                                     self.load_rate, f"{ph.name}完成")
        self.impacts.extend(impacts)
        if key == "launch":
            self.launched = True
            self._log("LAUNCH", "点火许可发布, 火箭起飞", {"impacts": [vars(i) for i in impacts]})
        else:
            self._log("PHASE_COMPLETE", f"{ph.name}完成",
                      {"impacts": [vars(i) for i in impacts]})

    # ------------------------------------------------------------ 指令接口
    def submit_command(self, kind: str, station: str,
                       params: Optional[Dict] = None) -> Dict:
        """岗位提交指令。返回执行结果字典; 冲突/拒绝时 blocked=True."""
        params = dict(params or {})

        if kind == arb.RESOLVE:
            return self._resolve(int(params.get("accept_seq")), station)

        cmd, verdict = self.arbiter.submit(kind, station, params, self.clock)
        if not verdict.accepted:
            # 首条互斥指令可能已执行, 按事件快照补偿回滚, 保证双方都不生效
            prior_seqs = [q for q in verdict.suspended if q != cmd.seq]
            compensated: List[str] = []
            for seq in prior_seqs:
                snap = self._snapshot_before_command(seq)
                if snap is not None:
                    self._restore(snap)
                    compensated.append(str(seq))
            self.conflict_frozen = True
            self._log(
                "COMMAND_CONFLICT",
                f"指令冲突: {verdict.reason}; 双方挂起, 系统安全冻结"
                + (f"; 已补偿撤回先到指令 #{','.join(compensated)}"
                   if compensated else ""),
                {"command": vars(cmd), "suspended": list(verdict.suspended),
                 "compensated": compensated},
            )
            return {"blocked": True, "reason": verdict.reason,
                    "suspended": list(verdict.suspended)}

        return self._execute(cmd, resolved=False)

    def _snapshot_before_command(self, seq: int) -> Optional[Dict]:
        """找到序号为 seq 的 COMMAND 事件之前最近的状态快照."""
        prev_snap: Optional[Dict] = None
        for evt in self.timeline.events_for(self.current_branch):
            if evt.type == "COMMAND" and evt.payload.get("command", {}).get("seq") == seq:
                return prev_snap
            if "snapshot" in evt.payload:
                prev_snap = evt.payload["snapshot"]
        return None

    def _guard(self, kind: str, cmd: arb.Command) -> None:
        """指令许可检查: 冲突冻结、严重违例、临时冻结逐层拦截."""
        # 冻结/恢复/裁决始终可提交; 冲突冻结下仅允许回退这一安全动作
        if kind in (arb.FREEZE, arb.RESUME, arb.RESOLVE):
            return
        if self.conflict_frozen and kind != arb.ROLLBACK:
            raise CommandRejected("指令冲突未裁决, 系统安全冻结中")
        if kind == arb.ROLLBACK:
            return
        critical = [v for v in self.violations if v.severity == CRITICAL]
        if critical:
            names = "; ".join(v.message for v in critical)
            raise CommandRejected(f"严重违例未排除, 禁止 {kind}: {names}")
        if self.frozen and kind != arb.RESUME:
            raise CommandRejected("倒计时已临时冻结, 请先恢复或回退")

    def _execute(self, cmd: arb.Command, resolved: bool) -> Dict:
        kind = cmd.kind
        try:
            self._guard(kind, cmd)
        except CommandRejected as exc:
            self.arbiter.drop_suspended(cmd.seq) if cmd.seq in self.arbiter.suspended else None
            self._log("COMMAND_BLOCKED", f"指令被阻止: {exc}",
                      {"command": vars(cmd), "reason": str(exc)})
            return {"blocked": True, "reason": str(exc)}

        handler: Dict[str, Callable[[arb.Command], str]] = {
            arb.FREEZE: self._do_freeze,
            arb.RESUME: self._do_resume,
            arb.SET_RATE: self._do_set_rate,
            arb.SWITCH_PIPELINE: self._do_switch_pipeline,
            arb.ROLLBACK: self._do_rollback,
        }
        try:
            summary = handler[kind](cmd)
        except CommandRejected as exc:
            self._log("COMMAND_BLOCKED", f"指令被阻止: {exc}",
                      {"command": vars(cmd), "reason": str(exc)})
            return {"blocked": True, "reason": str(exc)}
        self._log("COMMAND", summary,
                  {"command": vars(cmd), "resolved": resolved,
                   "impacts": [vars(i) for i in self.impacts[-32:]]})
        return {"blocked": False, "summary": summary}

    # ------------------------------------------------------------ 指令实现
    def _do_freeze(self, cmd: arb.Command) -> str:
        self.frozen = True
        return f"{cmd.station} 临时冻结倒计时"

    def _do_resume(self, cmd: arb.Command) -> str:
        if self.conflict_frozen:
            raise CommandRejected("指令冲突未裁决, 不能直接恢复")
        self.frozen = False
        impacts = recompute_schedule(self.phases, self.order, self.clock,
                                     self.load_rate, "冻结后恢复, 排程顺延")
        self.impacts.extend(impacts)
        return f"{cmd.station} 恢复倒计时, 许可时间已重算"

    def _do_set_rate(self, cmd: arb.Command) -> str:
        rate = float(cmd.params["rate_kg_s"])
        if not (MIN_RATE <= rate <= MAX_RATE):
            raise CommandRejected(
                f"加注速率 {rate:g} kg/s 超出允许范围 {MIN_RATE:g}~{MAX_RATE}")
        load = self.phases["load"]
        if load.status is PhaseStatus.COMPLETE:
            raise CommandRejected("加注已完成, 不能再调整速率")
        self.load_rate = rate
        impacts = recompute_schedule(self.phases, self.order, self.clock,
                                     self.load_rate, f"加注速率改为 {rate:g}kg/s")
        self.impacts.extend(impacts)
        return f"加注速率调整为 {rate:g} kg/s, 下游许可时间已传播更新"

    def _do_switch_pipeline(self, cmd: arb.Command) -> str:
        target = cmd.params.get("target")
        if target not in arb.PIPELINES:
            raise CommandRejected(f"未知管路: {target}")
        if target == self.pipeline:
            raise CommandRejected(f"当前已在 {target} 管路, 无需切换")
        load = self.phases["load"]
        if load.status is PhaseStatus.COMPLETE:
            raise CommandRejected("加注已完成, 无需切换管路")
        self.pipeline = target
        self.pipeline_switch_remaining = PIPELINE_SWITCH_SECONDS
        if load.status is PhaseStatus.ACTIVE:
            load.status = PhaseStatus.HOLD
        impacts = recompute_schedule(self.phases, self.order,
                                     self.clock + PIPELINE_SWITCH_SECONDS,
                                     self.load_rate, f"切换至{target}管路")
        self.impacts.extend(impacts)
        return (f"切换到{ '主' if target == 'main' else '备用'}管路, "
                f"{PIPELINE_SWITCH_SECONDS:g}s 切换窗口内加注暂停")

    def _do_rollback(self, cmd: arb.Command) -> str:
        key = cmd.params.get("phase")
        if key not in self.phases:
            raise CommandRejected(f"未知环节: {key}")
        targets = {key, *downstream_of(self.phases, self.order, key)}
        names = []
        for k in self.order:
            if k not in targets:
                continue
            ph = self.phases[k]
            ph.status = PhaseStatus.ROLLED_BACK
            ph.progress = 0.0
            ph.actual_start = ph.actual_end = None
            names.append(ph.name)
        self.frozen = True
        impacts = recompute_schedule(self.phases, self.order, self.clock,
                                     self.load_rate, f"回退至{self.phases[key].name}")
        self.impacts.extend(impacts)
        return ("回退环节: " + "、".join(names)
                + "; 相关下游许可时间作废, 倒计时冻结等待重新执行")

    def _resolve(self, accept_seq: int, station: str) -> Dict:
        accepted, rejected = self.arbiter.resolve(accept_seq)
        if accepted is None:
            return {"blocked": True, "reason": f"未找到挂起指令 #{accept_seq}"}
        result = {"blocked": False,
                  "accepted": accepted.describe(),
                  "rejected": rejected.describe() if rejected else None}
        # 冲突冻结在此解除; 被采纳指令自身若为 FREEZE 会重新置位
        self.conflict_frozen = False
        outcome = self._execute(accepted, resolved=True)
        result["outcome"] = outcome
        self._log(
            "RESOLVE",
            f"{station} 裁决采纳 {accepted.describe()}"
            + (f", 驳回 {rejected.describe()}" if rejected else ""),
            {"accepted_seq": accepted.seq,
             "rejected_seq": rejected.seq if rejected else None,
             "outcome": outcome},
        )
        return result

    # ------------------------------------------------------------ 分支回放
    def branch(self, name: str, reason: str = "") -> str:
        """从当前事件处分叉出处置分支(不影响 main 的真实性)."""
        self.timeline.branch(name, reason)
        self._log("BRANCH", f"进入处置分支 {name}: {reason}", {"reason": reason})
        return name

    def checkout(self, name: str) -> str:
        """切换分支: main 即真实倒计时; 切换后状态由事件快照确定性重建."""
        self.timeline.checkout(name)
        snap = self.timeline.snapshot_at(name)
        if snap is not None:
            self._restore(snap)
        if name == MAIN:
            self._log("RETURN_MAIN", "处置结束, 回到真实倒计时阶段", {})
        return name

    def replay_events(self, branch: Optional[str] = None) -> List[Dict]:
        """逐事件回放指定分支(默认当前分支), 供界面时间轴展示."""
        events = self.timeline.replay(branch or self.current_branch)
        return [
            {"seq": e.seq, "branch": e.branch, "type": e.type,
             "clock": e.clock, "summary": e.summary}
            for e in events
        ]

    def state_at(self, branch: str, seq: Optional[int] = None) -> Dict:
        """查看某分支在任意事件序号处的历史状态(不改变当前会话)."""
        return self.timeline.snapshot_at(branch, seq)

    # ------------------------------------------------------------ 状态查询
    def status(self) -> Dict:
        return {
            "clock_s": self.clock,
            "branch": self.current_branch,
            "frozen": self.frozen,
            "safety_frozen": self.safety_frozen,
            "conflict_frozen": self.conflict_frozen,
            "launched": self.launched,
            "load_rate_kg_s": self.load_rate,
            "pipeline": self.pipeline,
            "pipeline_switch_remaining_s": self.pipeline_switch_remaining,
            "violations": [
                {"monitor": v.monitor, "severity": v.severity,
                 "message": v.message, "phases": list(v.phases)}
                for v in self.violations
            ],
            "phases": [
                {"key": p.key, "name": p.name, "status": p.status.value,
                 "progress": round(p.progress, 4),
                 "planned_start": p.planned_start,
                 "planned_end": p.planned_end,
                 "actual_start": p.actual_start, "actual_end": p.actual_end}
                for p in (self.phases[k] for k in self.order)
            ],
        }

    def recent_impacts(self, limit: int = 20) -> List[Dict]:
        return [vars(i) for i in self.impacts[-limit:]]

    def blocked_actions(self) -> List[str]:
        """当前被阻止动作的人类可读说明, 供界面展示."""
        notes = []
        for v in self.violations:
            scope = "全局" if v.severity == CRITICAL else "环节 " + ",".join(v.phases)
            notes.append(f"{scope}: {v.describe()}")
        if self.frozen:
            notes.append("全局: 倒计时临时冻结中")
        if self.safety_frozen:
            notes.append("全局: 严重违例安全冻结, 等待遥测恢复")
        if self.conflict_frozen:
            notes.append("全局: 指令冲突安全冻结, 等待值班长 RESOLVE 裁决")
        if self.pipeline_switch_remaining > 0:
            notes.append(f"环节 load: 管路切换剩余 {self.pipeline_switch_remaining:g}s")
        return notes
