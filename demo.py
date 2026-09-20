"""端到端演示: 真实发射日中各类处置与影响传播, 以及时间分支回放.

运行: python3 demo.py
"""
from countdown import Session, Telemetry, MAIN
from countdown import arbiter


def line(title=""):
    print("\n" + "=" * 68)
    if title:
        print(title)
        print("-" * 68)


def show(s):
    st = s.status()
    mode = []
    if st["frozen"]:
        mode.append("临时冻结")
    if st["safety_frozen"]:
        mode.append("严重违例冻结")
    if st["conflict_frozen"]:
        mode.append("冲突冻结")
    print(f"时钟 {st['clock_s']:7.0f}s | 分支 {st['branch']} | "
          f"速率 {st['load_rate_kg_s']:g}kg/s | 管路 {st['pipeline']}"
          + (f" | {'/'.join(mode)}" if mode else ""))
    for p in st["phases"]:
        n = int(p["progress"] * 10)
        bar = "#" * n + "." * (10 - n)
        print(f"  {p['name']:<6} [{bar}] {p['status']:<11} "
              f"许可 {p['planned_start']:7.0f}~{p['planned_end']:7.0f}s")
    for v in st["violations"]:
        print(f"  ! [{v['severity']}] {v['monitor']}: {v['message']}")


def run(s, secs, **tm):
    t = Telemetry(personnel_cleared=True, **tm)
    step, elapsed = 60.0, 0.0
    while elapsed < secs - 1e-9:
        dt = min(step, secs - elapsed)
        s.tick(dt, t)
        elapsed += dt


def main():
    s = Session()

    line("1. 初始许可时间 (关键路径)")
    show(s)

    line("2. 加注 1800s 后, 加注指挥把速率 10 -> 20 kg/s")
    run(s, 1800)
    print(s.submit_command(arbiter.SET_RATE, "加注指挥",
                           {"rate_kg_s": 20.0})["summary"])
    show(s)

    line("3. 加注进行中, 两岗位同时要求切不同管路 -> 冲突冻结")
    run(s, 300)
    r1 = s.submit_command(arbiter.SWITCH_PIPELINE, "加注岗甲",
                          {"target": "backup"})
    r2 = s.submit_command(arbiter.SWITCH_PIPELINE, "加注岗乙",
                          {"target": "main"})
    print("甲:", r1["summary"])
    print("乙:", r2["reason"] if r2["blocked"] else r2["summary"])
    show(s)
    print("被阻止动作:")
    for note in s.blocked_actions():
        print("  -", note)

    line("4. 值班长裁决采纳岗甲(切备用管), 流程解冻继续")
    res = s.submit_command(arbiter.RESOLVE, "值班长",
                           {"accept_seq": min(r2["suspended"])})
    print("采纳:", res["accepted"], "| 驳回:", res["rejected"])
    show(s)

    line("5. 雷电风险升高 -> 天气/点火环节挂起, 许可时间顺延")
    run(s, 700, lightning_risk=0.62)
    show(s)
    print("挂起影响:")
    for i in s.recent_impacts(4):
        print(f"  - {i['phase_name']} {i['field_name']} "
              f"{i['old_value']:.0f} -> {i['new_value']:.0f} | {i['cause']}")

    line("6. 天气恢复, 剩余流程继续推进")
    run(s, 4000)
    show(s)

    line("7. 处置演练: 分叉时间分支做泄漏回退演练, 不影响真实倒计时")
    s.branch("leak-drill", "泄漏应急演练")
    s.update_telemetry(leak_detected=True)
    print(s.submit_command(arbiter.ROLLBACK, "安全官",
                           {"phase": "load"})["summary"])
    show(s)

    line("8. 演练结束, 切回 main -> 回到真实倒计时阶段")
    s.checkout(MAIN)
    show(s)

    line("9. 真实流程走到点火")
    run(s, max(0.0, 7780 - s.clock))
    show(s)
    print("\n起飞事件:",
          [e["summary"] for e in s.replay_events() if e["type"] == "LAUNCH"])

    line("10. 时间分支回放 (main 与演练分支各自事件流)")
    for name in (MAIN, "leak-drill"):
        evs = s.replay_events(name)
        print(f"分支 {name}: {len(evs)} 个事件, 末三条 ->")
        for e in evs[-3:]:
            print(f"  #{e['seq']:>3} t={e['clock']:7.0f}s "
                  f"{e['type']:<16} {e['summary']}")


if __name__ == "__main__":
    main()
