"""持续约束监控: 每拍对最新遥测求值, 产生 WARNING/CRITICAL 违例."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from .models import Telemetry

WARNING = "warning"    # 暂停相关环节
CRITICAL = "critical"  # 全局冻结并阻断一切动作指令

# 约束阈值 (可按任务文件调整)
TEMP_DIFF_LIMIT_C = 15.0
TANK_PRESSURE_MIN_KPA = 200.0
TANK_PRESSURE_MAX_KPA = 400.0
LIGHTNING_LIMIT = 0.30
COMMS_DELAY_LIMIT_S = 2.0


@dataclass
class Violation:
    monitor: str
    severity: str
    message: str
    phases: Tuple[str, ...]           # 直接受影响的环节 key

    def describe(self) -> str:
        return f"[{self.severity.upper()}] {self.monitor}: {self.message}"


@dataclass
class Monitor:
    name: str
    phases: Tuple[str, ...]
    severity: str
    check: Callable[[Telemetry], Optional[str]]

    def evaluate(self, telemetry: Telemetry) -> Optional[Violation]:
        msg = self.check(telemetry)
        if msg is None:
            return None
        return Violation(self.name, self.severity, msg, self.phases)


def default_monitors() -> List[Monitor]:
    return [
        Monitor(
            "温差", ("thermal",), WARNING,
            lambda t: None if t.temp_diff_c <= TEMP_DIFF_LIMIT_C
            else f"箭体/环境温差 {t.temp_diff_c:.1f}°C 超限(≤{TEMP_DIFF_LIMIT_C:g}°C)",
        ),
        Monitor(
            "贮箱压力", ("load",), WARNING,
            lambda t: None if TANK_PRESSURE_MIN_KPA <= t.tank_pressure_kpa <= TANK_PRESSURE_MAX_KPA
            else f"贮箱压力 {t.tank_pressure_kpa:.0f}kPa 超出 "
                 f"{TANK_PRESSURE_MIN_KPA:g}~{TANK_PRESSURE_MAX_KPA:g}kPa",
        ),
        Monitor(
            "雷电风险", ("weather", "launch"), WARNING,
            lambda t: None if t.lightning_risk < LIGHTNING_LIMIT
            else f"雷电风险 {t.lightning_risk:.0%} 超过 {LIGHTNING_LIMIT:.0%} 阈值",
        ),
        Monitor(
            "地面设备互锁", ("ground",), WARNING,
            lambda t: None if t.ground_equipment_ok else "地面设备互锁未解除",
        ),
        Monitor(
            "人员安全", ("evac", "launch"), WARNING,
            lambda t: None if t.personnel_cleared else "人员尚未全部撤离到安全区",
        ),
        Monitor(
            "通信链路", (), CRITICAL,
            lambda t: None if t.comms_delay_s <= COMMS_DELAY_LIMIT_S
            else f"指令通信延迟 {t.comms_delay_s:.1f}s 超过 {COMMS_DELAY_LIMIT_S:g}s, 指令不可采信",
        ),
        Monitor(
            "推进剂泄漏", ("load",), CRITICAL,
            lambda t: "检测到推进剂泄漏" if t.leak_detected else None,
        ),
    ]


def evaluate_all(monitors: List[Monitor], telemetry: Telemetry) -> List[Violation]:
    return [v for m in monitors if (v := m.evaluate(telemetry)) is not None]


def blocked_phases(violations: List[Violation]) -> set:
    """汇总 WARNING 直接挂起的环节集合."""
    blocked: set = set()
    for v in violations:
        if v.severity == WARNING:
            blocked.update(v.phases)
    return blocked


def has_critical(violations: List[Violation]) -> bool:
    return any(v.severity == CRITICAL for v in violations)
