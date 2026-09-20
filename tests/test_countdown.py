"""倒计时控制系统的行为测试."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from countdown import CommandRejected, MAIN, Session, Telemetry
from countdown import arbiter
from countdown.models import PhaseStatus

P = PhaseStatus


def good_telemetry(**over):
    t = Telemetry(personnel_cleared=True)
    for k, v in over.items():
        setattr(t, k, v)
    return t


def run_to(session, target_clock, telemetry, step=60.0):
    """以小步长推进时钟, 避免一拍跨越多个环节边界."""
    while session.clock < target_clock - 1e-9:
        dt = min(step, target_clock - session.clock)
        session.tick(dt, telemetry)


class ScheduleTests(unittest.TestCase):
    def test_initial_critical_path(self):
        s = Session()
        ph = s.phases
        self.assertEqual(ph["load"].planned_end, 3600.0)
        self.assertEqual(ph["thermal"].planned_start, 3600.0)
        self.assertEqual(ph["evac"].planned_start, 5400.0)
        self.assertEqual(ph["launch"].planned_end, 7260.0)

    def test_rate_change_propagates_downstream(self):
        s = Session()
        # 加注 1800s (完成一半 @10kg/s) 后把速率翻倍
        run_to(s, 1800.0, good_telemetry())
        old_launch_end = s.phases["launch"].planned_end
        out = s.submit_command(arbiter.SET_RATE, "加注指挥", {"rate_kg_s": 20.0})
        self.assertFalse(out["blocked"])
        # 剩余加注 1800s 工作量按 2x 速率 = 900s, 整体提前 900s
        self.assertAlmostEqual(s.phases["load"].planned_end, 2700.0, places=3)
        self.assertAlmostEqual(s.phases["launch"].planned_end,
                               old_launch_end - 900.0, places=3)
        fields = {(i.phase, i.field_name) for i in s.impacts}
        self.assertIn(("thermal", "planned_start"), fields)
        self.assertIn(("launch", "planned_end"), fields)

    def test_freeze_and_resume_shifts_schedule(self):
        s = Session()
        run_to(s, 100.0, good_telemetry())
        s.submit_command(arbiter.FREEZE, "总指挥")
        self.assertTrue(s.status()["frozen"])
        run_to(s, 600.0, good_telemetry())  # 冻结期间无进度
        self.assertAlmostEqual(s.phases["load"].progress, 100.0 / 3600.0)
        s.submit_command(arbiter.RESUME, "总指挥")
        # 恢复后排程整体顺延 500s
        self.assertAlmostEqual(s.phases["launch"].planned_end, 7260.0 + 500.0)

    def test_rollback_invalidates_downstream(self):
        s = Session()
        run_to(s, 3600.0, good_telemetry())
        self.assertIs(s.phases["load"].status, P.COMPLETE)
        run_to(s, 5460.0, good_telemetry())  # ground 完成(4500), thermal 完成(5460)
        out = s.submit_command(arbiter.ROLLBACK, "加注指挥", {"phase": "ground"})
        self.assertFalse(out["blocked"])
        for key in ("ground", "evac", "weather", "launch"):
            self.assertIs(s.phases[key].status, P.ROLLED_BACK, key)
        # thermal 不属于 ground 下游, 已在 4500s 时刻完成, 保持完成
        self.assertIs(s.phases["thermal"].status, P.COMPLETE)
        # 回退触发冻结
        self.assertTrue(s.status()["frozen"])


class ConstraintTests(unittest.TestCase):
    def test_temperature_warning_holds_thermal(self):
        s = Session()
        t = good_telemetry(vehicle_temp_c=-50, ambient_temp_c=20)
        run_to(s, 3600.0, t)
        self.assertTrue(any(v.monitor == "温差" for v in s.violations))
        # 下一拍温控被挂起
        s.tick(60.0, t)
        self.assertIs(s.phases["thermal"].status, P.HOLD)
        held_progress = s.phases["thermal"].progress
        s.tick(60.0, t)
        self.assertAlmostEqual(s.phases["thermal"].progress, held_progress)
        # 恢复温差后环节放行
        s.tick(60.0, good_telemetry())
        self.assertIs(s.phases["thermal"].status, P.ACTIVE)

    def test_pressure_holds_loading(self):
        s = Session()
        s.tick(60.0, good_telemetry())
        self.assertIs(s.phases["load"].status, P.ACTIVE)
        s.tick(60.0, good_telemetry(tank_pressure_kpa=450))
        self.assertIs(s.phases["load"].status, P.HOLD)

    def test_lightning_blocks_weather_and_launch(self):
        s = Session()
        t = good_telemetry(lightning_risk=0.8)
        run_to(s, 6600.0, t)
        s.tick(60.0, t)
        self.assertIs(s.phases["weather"].status, P.HOLD)

    def test_leak_is_critical_global_freeze_and_blocks_commands(self):
        s = Session()
        s.tick(60.0, good_telemetry())
        s.update_telemetry(leak_detected=True)
        self.assertTrue(s.status()["safety_frozen"])
        out = s.submit_command(arbiter.SET_RATE, "加注指挥", {"rate_kg_s": 20.0})
        self.assertTrue(out["blocked"])
        # 泄漏排除后仍处安全冻结? —— 严重违例消失自动解除, 但需重新恢复进度
        s.update_telemetry(leak_detected=False)
        self.assertFalse(s.status()["safety_frozen"])

    def test_comms_delay_blocks_action_commands(self):
        s = Session()
        s.tick(60.0, good_telemetry(comms_delay_s=5.0))
        self.assertTrue(s.status()["safety_frozen"])
        out = s.submit_command(arbiter.SWITCH_PIPELINE, "加注指挥",
                               {"target": "backup"})
        self.assertTrue(out["blocked"])

    def test_pipeline_switch_pauses_loading(self):
        s = Session()
        s.tick(60.0, good_telemetry())
        out = s.submit_command(arbiter.SWITCH_PIPELINE, "加注指挥",
                               {"target": "backup"})
        self.assertFalse(out["blocked"])
        self.assertEqual(s.status()["pipeline"], "backup")
        self.assertIs(s.phases["load"].status, P.HOLD)
        before = s.phases["load"].progress
        run_to(s, s.clock + 300.0, good_telemetry())  # 切换窗口内零进度
        self.assertAlmostEqual(s.phases["load"].progress, before)
        s.tick(60.0, good_telemetry())  # 切换完成, 恢复加注
        self.assertGreater(s.phases["load"].progress, before)


class ArbiterTests(unittest.TestCase):
    def test_conflicting_commands_freeze_and_resolve(self):
        s = Session()
        s.tick(60.0, good_telemetry())
        a = s.submit_command(arbiter.SET_RATE, "加注指挥A", {"rate_kg_s": 20.0})
        self.assertFalse(a["blocked"])
        b = s.submit_command(arbiter.SET_RATE, "加注指挥B", {"rate_kg_s": 5.0})
        self.assertTrue(b["blocked"])
        self.assertTrue(s.status()["conflict_frozen"])
        # 双方都不生效: 先到的 20kg/s 被补偿撤回
        self.assertAlmostEqual(s.load_rate, 10.0)
        # 冲突期间其他动作指令也被阻止
        c = s.submit_command(arbiter.SWITCH_PIPELINE, "岗哨", {"target": "backup"})
        self.assertTrue(c["blocked"])
        # 值班长裁决采纳 B
        suspended = b["suspended"]
        b_seq = max(suspended)  # B 的指令序号更大
        r = s.submit_command(arbiter.RESOLVE, "值班长", {"accept_seq": b_seq})
        self.assertFalse(r["blocked"])
        self.assertAlmostEqual(s.load_rate, 5.0)
        self.assertFalse(s.status()["safety_frozen"])

    def test_same_station_commands_do_not_conflict(self):
        s = Session()
        s.submit_command(arbiter.FREEZE, "总指挥")
        out = s.submit_command(arbiter.RESUME, "总指挥")
        self.assertFalse(out["blocked"])

    def test_old_command_outside_window_no_conflict(self):
        ar = arbiter.CommandArbiter(window=10.0)
        ar.submit(arbiter.SET_RATE, "A", {"rate_kg_s": 20.0}, 0.0)
        _, verdict = ar.submit(arbiter.SET_RATE, "B", {"rate_kg_s": 5.0}, 11.0)
        self.assertTrue(verdict.accepted)


class TimelineTests(unittest.TestCase):
    def test_whatif_branch_does_not_change_main(self):
        s = Session()
        run_to(s, 100.0, good_telemetry())
        main_progress = s.phases["load"].progress
        main_clock = s.clock

        s.branch("experiment-1", "试装备用管路方案")
        s.submit_command(arbiter.SWITCH_PIPELINE, "加注指挥", {"target": "backup"})
        run_to(s, 500.0, good_telemetry())
        self.assertEqual(s.current_branch, "experiment-1")
        self.assertEqual(s.status()["pipeline"], "backup")

        s.checkout(MAIN)
        self.assertEqual(s.current_branch, MAIN)
        self.assertEqual(s.status()["pipeline"], "main")
        self.assertAlmostEqual(s.clock, main_clock)
        self.assertAlmostEqual(s.phases["load"].progress, main_progress)

    def test_return_main_lands_on_real_phase(self):
        s = Session()
        run_to(s, 3600.0, good_telemetry())   # main: 加注完成
        s.branch("leak-drill", "泄漏处置演练")
        s.submit_command(arbiter.ROLLBACK, "安全官", {"phase": "load"})
        self.assertIs(s.phases["load"].status, P.ROLLED_BACK)
        s.checkout(MAIN)
        self.assertIs(s.phases["load"].status, P.COMPLETE)
        self.assertAlmostEqual(s.clock, 3600.0)

    def test_replay_events_ordered_and_snapshots(self):
        s = Session()
        s.tick(60.0, good_telemetry())
        s.branch("b1")
        s.tick(60.0, good_telemetry())
        events = s.replay_events("b1")
        seqs = [e["seq"] for e in events]
        self.assertEqual(seqs, sorted(seqs))
        # 历史任意点状态可查
        state = s.state_at(MAIN, seq=1)
        self.assertIsNotNone(state)
        self.assertAlmostEqual(state["clock"], 0.0)

    def test_full_launch_flow(self):
        s = Session()
        t = good_telemetry()
        run_to(s, 7380.0, t)
        self.assertTrue(s.status()["launched"])
        self.assertIs(s.phases["launch"].status, P.COMPLETE)
        # 起飞后时钟推进不再改变状态
        s.tick(60.0, t)
        self.assertIs(s.phases["launch"].status, P.COMPLETE)

    def test_invalid_command_params_are_blocked_not_raised(self):
        s = Session()
        for kind, params in (
            (arbiter.SET_RATE, {"rate_kg_s": 0.5}),
            (arbiter.SWITCH_PIPELINE, {"target": "space"}),
            (arbiter.ROLLBACK, {"phase": "nope"}),
        ):
            out = s.submit_command(kind, "测试岗", params)
            self.assertTrue(out["blocked"], kind)
        # 非法指令不得改变系统状态
        self.assertAlmostEqual(s.load_rate, 10.0)
        self.assertEqual(s.pipeline, "main")

    def test_action_blocked_under_freeze(self):
        s = Session()
        s.submit_command(arbiter.FREEZE, "总指挥")
        out = s.submit_command(arbiter.SET_RATE, "加注指挥", {"rate_kg_s": 20})
        self.assertTrue(out["blocked"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
