"""多岗位指令仲裁.

互斥组内、不同岗位、不同取值、在冲突窗口内先后到达的指令构成冲突:
双方都不执行, 系统进入安全冻结, 等待值班长用 RESOLVE 选择执行哪一条。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# 指令类型
FREEZE = "FREEZE"                    # 临时冻结倒计时
RESUME = "RESUME"                    # 恢复倒计时
SET_RATE = "SET_RATE"                # 重新安排加注速率 params: rate_kg_s
SWITCH_PIPELINE = "SWITCH_PIPELINE"  # 切换管路 params: target in {main, backup}
ROLLBACK = "ROLLBACK"                # 回退环节 params: phase
RESOLVE = "RESOLVE"                  # 冲突裁决 params: accept_seq

CONFLICT_WINDOW_S = 10.0

PIPELINES = ("main", "backup")


@dataclass
class Command:
    seq: int
    kind: str
    station: str
    params: Dict = field(default_factory=dict)
    submitted_at: float = 0.0

    def describe(self) -> str:
        p = ", ".join(f"{k}={v}" for k, v in self.params.items())
        return f"#{self.seq} {self.kind}({p}) @{self.station}"


def _conflict_key(cmd: Command) -> Optional[Tuple[str, object]]:
    if cmd.kind in (FREEZE, RESUME):
        return ("countdown_state", cmd.kind)
    if cmd.kind == SET_RATE:
        return ("loading_rate", cmd.params.get("rate_kg_s"))
    if cmd.kind == SWITCH_PIPELINE:
        return ("pipeline", cmd.params.get("target"))
    return None


@dataclass
class Verdict:
    accepted: bool                      # True=可立即执行; False=挂起/拒绝
    reason: str = ""
    suspended: Tuple[int, ...] = ()     # 被挂起的指令序号


class CommandArbiter:
    def __init__(self, window: float = CONFLICT_WINDOW_S):
        self.window = window
        self._recent: List[Command] = []
        self.suspended: Dict[int, Command] = {}
        self._next_seq = 1

    def submit(self, kind: str, station: str, params: Dict, now: float) -> Tuple[Command, Verdict]:
        cmd = Command(self._next_seq, kind, station, dict(params), now)
        self._next_seq += 1
        key = _conflict_key(cmd)
        self._prune(now)
        if key is not None:
            for prev in self._recent:
                if prev.station == station:
                    continue
                prev_key = _conflict_key(prev)
                if prev_key and prev_key[0] == key[0] and prev_key[1] != key[1]:
                    self.suspended[prev.seq] = prev
                    self.suspended[cmd.seq] = cmd
                    return cmd, Verdict(
                        False,
                        f"与岗位 {prev.station} 的 {prev.describe()} 冲突, 双方挂起等待裁决",
                        suspended=(prev.seq, cmd.seq),
                    )
        self._recent.append(cmd)
        return cmd, Verdict(True)

    def resolve(self, accept_seq: int) -> Tuple[Optional[Command], Optional[Command]]:
        """裁决: 返回 (被采纳的指令, 被驳回的指令)."""
        accepted = self.suspended.pop(accept_seq, None)
        if accepted is None:
            return None, None
        rejected = self.suspended.pop(next(iter(self.suspended)), None) \
            if len(self.suspended) == 1 else None
        # 正常情况下挂起队列中只有冲突的双方
        if self.suspended:
            other_seq = next(iter(self.suspended))
            rejected = self.suspended.pop(other_seq)
        for c in list(self._recent):
            if c.seq in (accepted.seq, rejected.seq if rejected else -1):
                self._recent.remove(c)
        return accepted, rejected

    def drop_suspended(self, seq: int) -> None:
        self.suspended.pop(seq, None)

    def _prune(self, now: float) -> None:
        self._recent = [c for c in self._recent if now - c.submitted_at <= self.window]
