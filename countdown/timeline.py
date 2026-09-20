"""事件溯源时间线: 每次处置都是事件; 支持分叉与逐事件回放.

main 分支始终代表真实倒计时; 临时处置在子分支上进行, 切回 main
即恢复到真实阶段。每个改变状态的事件都内嵌状态快照, 因此任意分支、
任意序号处的状态都能确定性地重建(可回放)。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

MAIN = "main"


@dataclass
class Event:
    seq: int
    branch: str
    type: str
    clock: float                       # 任务时钟(距 T0 的秒数, 负值表示倒计时中)
    summary: str
    payload: Dict = field(default_factory=dict)


@dataclass
class Branch:
    name: str
    parent: Optional[str]
    fork_seq: int                      # 从父分支哪个事件序号分叉
    reason: str = ""


class Timeline:
    def __init__(self) -> None:
        self.events: List[Event] = []
        self.branches: Dict[str, Branch] = {MAIN: Branch(MAIN, None, 0)}
        self.current: str = MAIN
        self._next_seq = 1

    def append(self, type_: str, clock: float, summary: str, payload: Dict) -> Event:
        evt = Event(self._next_seq, self.current, type_, clock, summary, payload)
        self._next_seq += 1
        self.events.append(evt)
        return evt

    def branch(self, name: str, reason: str = "") -> Branch:
        if name in self.branches:
            raise ValueError(f"分支 {name} 已存在")
        fork_seq = self.events_for(self.current)[-1].seq if self.events_for(self.current) else 0
        br = Branch(name, self.current, fork_seq, reason)
        self.branches[name] = br
        self.current = name
        return br

    def checkout(self, name: str) -> Branch:
        if name not in self.branches:
            raise KeyError(f"分支 {name} 不存在")
        self.current = name
        return self.branches[name]

    def events_for(self, branch: str) -> List[Event]:
        """沿父链收集该分支可见的全部事件(按 seq 排序)."""
        br = self.branches[branch]
        result: List[Event] = []
        if br.parent is not None:
            result = [e for e in self.events_for(br.parent) if e.seq <= br.fork_seq]
        result += [e for e in self.events if e.branch == branch]
        return sorted(result, key=lambda e: e.seq)

    def snapshot_at(self, branch: str, seq: Optional[int] = None) -> Optional[Dict]:
        """重建某分支(可见事件中)截至 seq 的最近一次状态快照."""
        snap: Optional[Dict] = None
        for evt in self.events_for(branch):
            if seq is not None and evt.seq > seq:
                break
            if "snapshot" in evt.payload:
                snap = evt.payload["snapshot"]
        return snap

    def replay(self, branch: str) -> List[Event]:
        """返回该分支的完整事件流, 供逐拍回放展示."""
        return self.events_for(branch)

    def dump_jsonl(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            for evt in self.events:
                fh.write(json.dumps(asdict(evt), ensure_ascii=False) + "\n")
