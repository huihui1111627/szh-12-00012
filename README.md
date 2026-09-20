# 火箭发射倒计时控制系统

把推进剂加注、箭体温度、地面设备、人员撤离、天气窗口纳入同一套倒计时
控制流程；任何提前、暂停或回退都会重算下游许可时间并展示影响传播；
多岗位指令冲突、泄漏、通信延迟等异常会阻断错误动作；每次处置形成可
回放的时间分支，切回 `main` 即恢复真实倒计时阶段。

## 运行

```bash
python3 demo.py                 # 端到端演示(速率调整/冲突裁决/泄漏演练/回放到起飞)
python3 -m pytest tests/ -q     # 17 项行为测试
```

## 快速上手

```python
from countdown import Session, Telemetry
from countdown import arbiter

s = Session()
s.tick(60.0, Telemetry(personnel_cleared=True))          # 推进时钟并注入遥测

s.submit_command(arbiter.SET_RATE, "加注指挥", {"rate_kg_s": 20})  # 改速率, 下游重算
s.submit_command(arbiter.SWITCH_PIPELINE, "加注岗", {"target": "backup"})
s.submit_command(arbiter.FREEZE, "总指挥")
s.submit_command(arbiter.RESUME, "总指挥")
s.submit_command(arbiter.ROLLBACK, "安全官", {"phase": "ground"})

s.branch("leak-drill", "泄漏处置演练")    # 分叉, 不影响 main
s.checkout("main")                        # 回到真实倒计时阶段
s.replay_events("leak-drill")             # 逐事件回放
s.state_at("main", seq=42)                # 查看任意历史节点状态
s.status(); s.recent_impacts(); s.blocked_actions()
```

## 设计要点

- **统一排程 (`scheduler.py`)**：按依赖拓扑重算每个环节的许可
  `planned_start/planned_end`；加注速率以 10 kg/s 为基准线性缩放剩余
  工作量；冻结、切管、约束挂起、回退都会沿关键路径向下游传播，产生
  `Impact` 记录（环节、字段、旧值→新值、原因）。
- **持续约束 (`constraints.py`)**：每拍评估温差、贮箱压力、雷电风险、
  地面设备互锁、人员撤离、通信延迟、推进剂泄漏。
  - `WARNING` 挂起相关环节（如温差挂温控、雷电挂天气/点火）；
  - `CRITICAL`（泄漏、通信延迟 > 2s）触发全局安全冻结并阻断动作指令，
    遥测恢复后自动解除并重算排程。
- **多岗位仲裁 (`arbiter.py`)**：互斥组（冻结/恢复、加注速率、管路
  选择）内，不同岗位在 10s 冲突窗口内发出的不同取值构成冲突：**双方
  都不执行**（先到指令按事件快照补偿撤回），系统进入冲突冻结，由
  值班长 `RESOLVE` 采纳其一、驳回另一个；同岗位连续指令不判冲突。
- **状态机 (`models.py`)**：`pending → active → complete`，异常时
  `hold`，回退时目标环节及其全部下游置 `rolled_back` 并清空实绩。
- **事件溯源与时间分支 (`timeline.py`, `engine.py`)**：每次处置都是
  事件并内嵌状态快照；`branch()` 分叉做“假设性处置”，`checkout("main")`
  用快照确定性重建，保证服务恢复后落在真实阶段；`replay_events()` 与
  `state_at(seq)` 支持任意节点回放审计；`dump_jsonl()` 导出事件流。

## 环节定义

| key | 环节 | 额定时长 | 依赖 |
|---|---|---|---|
| load | 推进剂加注 | 3600s | — |
| thermal | 箭体温度调节 | 1800s | load |
| ground | 地面设备自检 | 900s | load |
| evac | 人员撤离 | 1200s | thermal, ground |
| weather | 天气窗口确认 | 600s | evac |
| launch | 点火许可 | 60s | weather |

环节与约束阈值均可在 `models.default_phases()` 与 `constraints`
常量处按任务调整；`Session(phases=..., monitors=...)` 支持自定义注入。
