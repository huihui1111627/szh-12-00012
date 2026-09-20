"""火箭发射场倒计时控制系统.

将推进剂加注、箭体温度、地面设备、人员撤离、天气窗口纳入同一套
倒计时控制流程:
- 提前/暂停/回退后的许可时间自动重算并向下游传播;
- 温差、贮箱压力、雷电风险、设备互锁、泄漏、通信延迟持续评估;
- 多岗位指令在冲突窗口内仲裁, 冲突即安全冻结并挂起双方;
- 每个处置形成可回放的时间分支, 切回 main 即恢复真实倒计时阶段。
"""
from .engine import CommandRejected, Session
from .models import Phase, PhaseStatus, Telemetry, default_phases
from .timeline import MAIN

__all__ = ["Session", "CommandRejected", "Phase", "PhaseStatus",
           "Telemetry", "default_phases", "MAIN"]
