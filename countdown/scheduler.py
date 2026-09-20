"""许可时间调度: 根据环节依赖、进度与加注速率重算 planned_start/end,
并产生下游影响传播记录."""
from __future__ import annotations

from typing import Dict, List, Optional

from .models import Impact, Phase, PhaseStatus


def effective_duration(phase: Phase, load_rate: float) -> float:
    """额定 10 kg/s 为基准速率; 不同速率线性改变加注剩余时长."""
    if phase.key == "load" and load_rate > 0:
        return phase.remaining * (10.0 / load_rate)
    return phase.remaining


def recompute_schedule(
    phases: Dict[str, Phase],
    order: List[str],
    start_clock: float,
    load_rate: float,
    cause: str,
) -> List[Impact]:
    """按拓扑顺序重算各环节许可时间。返回与旧排程相比的影响列表。

    已完成环节锚定在 actual_end; 其余环节最早开始时间 = 依赖的
    max(planned_end/actual_end)。尚未开工的环节最早不早于 start_clock。
    """
    impacts: List[Impact] = []
    for key in order:
        ph = phases[key]
        old_start, old_end = ph.planned_start, ph.planned_end

        if ph.status is PhaseStatus.COMPLETE and ph.actual_end is not None:
            ph.planned_start = ph.actual_start
            ph.planned_end = ph.actual_end
            continue

        deps_ready_at: List[float] = []
        for dep in ph.depends_on:
            dph = phases[dep]
            anchor = dph.actual_end if dph.status is PhaseStatus.COMPLETE else dph.planned_end
            if anchor is not None:
                deps_ready_at.append(anchor)
        earliest = max(deps_ready_at) if deps_ready_at else start_clock
        if not ph.depends_on:
            earliest = max(earliest, start_clock)
        elif earliest < start_clock:
            earliest = max(earliest, start_clock)

        ph.planned_start = earliest
        ph.planned_end = earliest + effective_duration(ph, load_rate)

        if old_start != ph.planned_start:
            impacts.append(Impact(key, ph.name, "planned_start", old_start,
                                  ph.planned_start, cause))
        if old_end != ph.planned_end:
            impacts.append(Impact(key, ph.name, "planned_end", old_end,
                                  ph.planned_end, cause))
    return impacts


def downstream_of(phases: Dict[str, Phase], order: List[str], root: str) -> List[str]:
    """返回直接或间接依赖 root 的全部环节(含 root 本身被回退场景由调用方处理)."""
    affected: List[str] = []
    reachable = {root}
    changed = True
    while changed:
        changed = False
        for key in order:
            if key in reachable:
                continue
            if any(dep in reachable for dep in phases[key].depends_on):
                reachable.add(key)
                affected.append(key)
                changed = True
    return affected
