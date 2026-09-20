"""领域模型: 环节(Phase)、遥测(Telemetry)、影响传播(Impact)."""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Dict, List, Optional, Tuple


class PhaseStatus(Enum):
    PENDING = "pending"          # 等待上游完成
    READY = "ready"              # 上游已完成, 等待窗口/约束放行
    ACTIVE = "active"            # 正在执行
    HOLD = "hold"                # 被约束/互锁暂停
    COMPLETE = "complete"        # 已完成
    ROLLED_BACK = "rolled_back"  # 已回退, 需重新执行

    @property
    def is_done(self) -> bool:
        return self is PhaseStatus.COMPLETE

    @property
    def blocks_downstream(self) -> bool:
        """该状态是否阻止下游开工."""
        return self is not PhaseStatus.COMPLETE


@dataclass
class Phase:
    key: str
    name: str
    duration: float                         # 秒, 额定工作量
    depends_on: Tuple[str, ...] = ()
    status: PhaseStatus = PhaseStatus.PENDING
    progress: float = 0.0                   # 0..1
    planned_start: Optional[float] = None   # 许可开始时间(任务时钟秒)
    planned_end: Optional[float] = None     # 许可完成时间
    actual_start: Optional[float] = None
    actual_end: Optional[float] = None

    @property
    def remaining(self) -> float:
        return self.duration * (1.0 - self.progress)

    def snapshot(self) -> "Phase":
        return replace(self, depends_on=tuple(self.depends_on))


@dataclass
class Telemetry:
    """地面/箭上遥测, 由外部注入, 引擎每拍持续评估."""
    vehicle_temp_c: float = 20.0
    ambient_temp_c: float = 22.0
    tank_pressure_kpa: float = 300.0
    lightning_risk: float = 0.05            # 0..1
    leak_detected: bool = False
    comms_delay_s: float = 0.0              # 指令通信延迟
    ground_equipment_ok: bool = True
    personnel_cleared: bool = False

    @property
    def temp_diff_c(self) -> float:
        return abs(self.vehicle_temp_c - self.ambient_temp_c)


@dataclass
class Impact:
    """一次变更对下游环节许可时间/状态的影响传播记录."""
    phase: str
    phase_name: str
    field_name: str
    old_value: Optional[float]
    new_value: Optional[float]
    cause: str

    def describe(self) -> str:
        def fmt(v: Optional[float]) -> str:
            return "—" if v is None else f"{v:g}s"
        arrow = f"{fmt(self.old_value)} → {fmt(self.new_value)}"
        return f"{self.phase_name}.{self.field_name}: {arrow} ({self.cause})"


def default_phases() -> List[Phase]:
    """标准发射日流程 (关键路径: 加注→温控/地面→撤离→天气→点火)."""
    return [
        Phase("load",    "推进剂加注",   3600.0, ()),
        Phase("thermal", "箭体温度调节", 1800.0, ("load",)),
        Phase("ground",  "地面设备自检",  900.0, ("load",)),
        Phase("evac",    "人员撤离",     1200.0, ("thermal", "ground")),
        Phase("weather", "天气窗口确认",  600.0, ("evac",)),
        Phase("launch",  "点火许可",       60.0, ("weather",)),
    ]
