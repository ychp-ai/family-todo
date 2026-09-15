import { describe, expect, it } from "vitest";
import { addDays, canRecordOccurrence, enumerateSlots, isoWeekday, isValidActualCompletedAt, localDateAt, occurrenceIdentityKey, parseLocalDate, previousSegmentDate, projectOccurrences, splitSchedule, toInstant, transitionLifecycle, validateSchedule } from "./scheduling";
import type { DailySchedule, ProjectionInput, ScheduleControl, ScheduleSegment } from "./scheduling";

const createdAt = "2026-09-10T10:30:00.000Z";
const now = "2026-09-11T10:30:00.000Z";
const daily: DailySchedule = { kind: "daily", startDate: "2026-09-10", endDate: null, times: ["20:00", "08:00"] };
const segment: ScheduleSegment = { id: "segment", taskId: "task", schedule: daily, subject: { kind: "member", membershipId: "father" }, subjectNameSnapshot: "爸爸", effectiveFrom: createdAt, effectiveUntil: null, allowCreationDay: true };
const input: ProjectionInput = { task: { id: "task", createdAt, lifecycle: "active" }, segments: [segment], controls: [], dateFrom: "2026-09-11", dateTo: "2026-09-11", now };
const control = (kind: ScheduleControl["kind"], effectiveAt: string, taskVersion: number): ScheduleControl => ({ taskId: "task", kind, effectiveAt, taskVersion });
const project = (patch: Partial<ProjectionInput> = {}) => [...projectOccurrences({ ...input, ...patch })];

describe("上海公历和有限日程枚举", () => {
  it("拒绝无效公历日期、范围和非毫秒UTC瞬时", () => {
    for (const date of ["2026-02-30", "2100-02-29", "1999-12-31", "2101-01-01", "2026-2-01"]) expect(() => parseLocalDate(date)).toThrow(RangeError);
    expect(parseLocalDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(() => toInstant("2026-09-11", "24:00")).toThrow();
    expect(() => localDateAt("2026-09-11T10:30:00Z")).toThrow();
    expect(() => project({ dateTo: "2026-10-12" })).toThrow();
  });
  it("跨月闰年跨年周日到周一与23:59的上海转换", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(isoWeekday("2026-09-13")).toBe(7);
    expect(isoWeekday("2026-09-14")).toBe(1);
    expect(toInstant("2026-09-11", "23:59")).toBe("2026-09-11T15:59:00.000Z");
    expect(localDateAt("2026-09-11T16:00:00.000Z")).toBe("2026-09-12");
    expect(() => addDays("2100-12-31", 1)).toThrow();
  });
  it("包含起止两端、日期上限安全终止、无后续不制造占位", () => {
    expect([...enumerateSlots({ ...daily, startDate: "2100-12-31", endDate: "2100-12-31", times: [] }, "2100-12-31", "2100-12-31")]).toEqual([{ localDate: "2100-12-31", slot: "date-only", time: null, scheduledAt: null, eligibilityBoundary: "2100-12-30T16:00:00.000Z" }]);
    expect([...enumerateSlots({ ...daily, endDate: "2026-09-10" }, "2026-09-11", "2026-09-11")]).toEqual([]);
    for (const schedule of [{ ...daily, times: ["08:00", "08:00"] }, { ...daily, times: ["24:00"] }, { ...daily, kind: "weekly" as const, weekdays: [0] }, { ...daily, kind: "weekly" as const, weekdays: [7, 7] }]) expect(() => validateSchedule(schedule)).toThrow();
  });
});

describe("片段投影与历史身份", () => {
  it("上海18:30新建不追08:00，新建时刻恰好到时也排除", () => {
    const slots = project({ task: { ...input.task, createdAt: now }, segments: [{ ...segment, effectiveFrom: now }] });
    expect(slots.map(x => x.slot)).toEqual(["20:00"]);
    const equal = toInstant("2026-09-11", "20:00");
    expect(project({ task: { ...input.task, createdAt: equal }, segments: [{ ...segment, effectiveFrom: equal }] })).toEqual([]);
  });
  it("同日编辑保留旧早晨及对象，旧未来失效，新片段严格晚于切分时刻", () => {
    const equalTime = toInstant("2026-09-11", "08:00");
    const equalTimeRef = project()[0]?.identityKey;
    const split = splitSchedule(segment, { id: "next", schedule: daily, subject: { kind: "member", membershipId: "mother" }, subjectNameSnapshot: "妈妈" }, equalTime);
    const occurrences = project({ segments: [split.next, split.previous] });
    const oldRefs = occurrences.filter(x => x.segmentId === segment.id).map(x => x.identityKey);
    const newRefs = occurrences.filter(x => x.segmentId === split.next.id).map(x => x.identityKey);
    expect(oldRefs).toContain(equalTimeRef);
    expect(newRefs).not.toContain(equalTimeRef);
    expect(occurrences.map(x => [x.slot, x.subjectName])).toEqual([["08:00", "爸爸"], ["20:00", "妈妈"]]);
    const changed = splitSchedule(segment, { id: "changed", schedule: { ...daily, times: ["19:00"] }, subject: split.next.subject, subjectNameSnapshot: "妈妈" }, now);
    expect(project({ segments: [changed.previous, changed.next] }).map(x => [x.slot, x.subjectName])).toEqual([["08:00", "爸爸"], ["19:00", "妈妈"]]);
    expect(segment.effectiveUntil).toBeNull();
  });
  it("星期日期跨界与连续编辑的窗口拆分和逐项读取保持一致", () => {
    for (let weekday = 1; weekday <= 7; weekday++) {
      const first = { ...segment, schedule: { ...daily, kind: "weekly" as const, weekdays: [weekday], startDate: "2026-12-20" }, effectiveFrom: "2026-12-19T10:30:00.000Z" };
      const split = splitSchedule(first, { id: "second", schedule: first.schedule, subject: first.subject, subjectNameSnapshot: first.subjectNameSnapshot }, "2026-12-30T10:30:00.000Z");
      const config = { segments: [split.next, split.previous], task: { ...input.task, createdAt: first.effectiveFrom }, dateFrom: "2026-12-24", dateTo: "2027-01-10" };
      const whole = project(config);
      const left = project({ ...config, dateTo: "2026-12-31" });
      const right = project({ ...config, dateFrom: "2027-01-01" });
      expect([...left, ...right]).toEqual(whole);
      expect(new Set(whole.map(x => x.identityKey)).size).toBe(whole.length);
      expect(project(config)).toEqual(whole);
      const iterator = projectOccurrences({ ...input, ...config });
      for (const occurrence of whole) expect(iterator.next().value).toEqual(occurrence);
      expect(iterator.next().done).toBe(true);
    }
  });
  it("date-only创建当天有一次，编辑当天保留旧人，次日才出现新人", () => {
    const initial = { ...segment, schedule: { ...daily, times: [] }, effectiveFrom: now };
    expect(project({ task: { ...input.task, createdAt: now }, segments: [initial] }).map(x => x.slot)).toEqual(["date-only"]);
    const split = splitSchedule(initial, { id: "next", schedule: initial.schedule, subject: { kind: "member", membershipId: "mother" }, subjectNameSnapshot: "妈妈" }, now);
    const result = project({ task: { ...input.task, createdAt: now }, segments: [split.previous, split.next], dateTo: "2026-09-12" });
    expect(result.map(x => [x.localDate, x.subjectName, x.scheduledAt])).toEqual([["2026-09-11", "爸爸", null], ["2026-09-12", "妈妈", null]]);
  });
  it("连续同日date-only编辑不产生重复当天次数，暂停中编辑恢复不补当天", () => {
    const initial = { ...segment, schedule: { ...daily, times: [] } };
    const first = splitSchedule(initial, { id: "second", schedule: initial.schedule, subject: initial.subject, subjectNameSnapshot: "第二版" }, "2026-09-11T01:00:00.000Z");
    const second = splitSchedule(first.next, { id: "third", schedule: initial.schedule, subject: initial.subject, subjectNameSnapshot: "第三版" }, now);
    const segments = [second.next, first.previous, second.previous];
    expect(project({ segments, dateTo: "2026-09-12" }).map(x => [x.localDate, x.subjectName])).toEqual([["2026-09-11", "爸爸"], ["2026-09-12", "第三版"]]);
    const controls = [control("pause", "2026-09-10T12:00:00.000Z", 2), control("resume", "2026-09-12T10:30:00.000Z", 5)];
    expect(project({ segments, controls, dateTo: "2026-09-13" }).map(x => [x.localDate, x.subjectName])).toEqual([["2026-09-13", "第三版"]]);
  });
  it("once只使用有效片段指针，旧引用失效且可提前完成", () => {
    const old: ScheduleSegment = { ...segment, schedule: { kind: "once", date: "2026-09-12", time: "08:00" } };
    const next: ScheduleSegment = { ...old, id: "next", schedule: { kind: "once", date: "2026-09-13", time: null } };
    const result = project({ segments: [old, next], task: { ...input.task, activeOnceSegmentId: "next" }, dateTo: "2026-09-13" });
    expect(result.map(x => [x.segmentId, x.localDate, x.canRecord])).toEqual([["next", "2026-09-13", true]]);
    const unscheduled = project({ segments: [{ ...next, schedule: { kind: "once", date: null, time: null } }], task: { ...input.task, activeOnceSegmentId: "next" } });
    expect(unscheduled[0]?.slot).toBe("unscheduled");
  });
  it("规范身份采用JSON元组并正规化UUID大小写，稀疏记录不改变其他次数", () => {
    expect(occurrenceIdentityKey(["ABC", "DEF", "2026-09-11", "08:00"])).toBe('["abc","def","2026-09-11","08:00"]');
    const original = project();
    const first = original[0];
    if (!first) throw new Error("Expected occurrence");
    const recorded = project({ states: [{ identityKey: first.identityKey, status: "completed", version: 1, actualCompletedAt: now, recordedAt: now, operatorName: "妈妈" }] });
    expect(recorded[0]).toMatchObject({ status: "completed", version: 1 });
    expect(recorded.slice(1)).toEqual(original.slice(1));
    expect(original[0]).toMatchObject({ status: "pending", version: 0 });
  });
});

describe("task级生命周期控制", () => {
  it("pause保留恰好已到时slot，resume恰好时刻不补，其他task控制隔离", () => {
    const morning = toInstant("2026-09-11", "08:00");
    const evening = toInstant("2026-09-11", "20:00");
    expect(project({ controls: [control("pause", morning, 2), control("resume", evening, 3)] }).map(x => x.slot)).toEqual(["08:00"]);
    expect(project({ controls: [{ ...control("stop", morning, 2), taskId: "other" }] })).toEqual(project());
  });
  it("date-only当天暂停保留，跨天恢复不补恢复当天", () => {
    const result = project({ segments: [{ ...segment, schedule: { ...daily, times: [] } }], controls: [control("pause", now, 2), control("resume", "2026-09-13T10:30:00.000Z", 3)], dateTo: "2026-09-14" });
    expect(result.map(x => x.localDate)).toEqual(["2026-09-11", "2026-09-14"]);
  });
  it("暂停期间编辑不绕过task控制，resume后才使用新片段", () => {
    const split = splitSchedule(segment, { id: "next", schedule: { ...daily, times: ["19:00"] }, subject: segment.subject, subjectNameSnapshot: "爸爸" }, now);
    const result = project({ segments: [split.previous, split.next], controls: [control("pause", "2026-09-11T01:00:00.000Z", 2), control("resume", "2026-09-12T10:30:00.000Z", 4)], dateTo: "2026-09-12" });
    expect(result.map(x => [x.localDate, x.slot])).toEqual([["2026-09-11", "08:00"], ["2026-09-12", "19:00"]]);
  });
  it("删除隐藏全部，恢复保持paused且不补删除期/恢复暂停期", () => {
    expect(project({ task: { ...input.task, lifecycle: "deleted" } })).toEqual([]);
    const controls = [control("delete", now, 2), control("restore", "2026-09-12T10:30:00.000Z", 3), control("resume", "2026-09-13T10:30:00.000Z", 4)];
    const result = project({ controls, dateTo: "2026-09-13" });
    expect(result.map(x => [x.localDate, x.slot])).toEqual([["2026-09-11", "08:00"], ["2026-09-13", "20:00"]]);
    expect(transitionLifecycle({ lifecycle: "deleted", stopped: false }, "restore", true)).toEqual({ ok: true, state: { lifecycle: "paused", stopped: false }, canResume: true });
    expect(transitionLifecycle({ lifecycle: "deleted", stopped: false }, "restore", false)).toMatchObject({ ok: true, state: { lifecycle: "active" } });
  });
  it("同毫秒控制按taskVersion排序，停止后删除恢复永不重启", () => {
    const pauseResume = [control("resume", now, 3), control("pause", now, 2)];
    expect(project({ controls: pauseResume }).map(x => x.slot)).toEqual(["08:00", "20:00"]);
    expect(project({ controls: [control("pause", now, 3), control("resume", now, 2)] }).map(x => x.slot)).toEqual(["08:00"]);
    const stopped = [control("restore", now, 4), control("delete", now, 3), control("stop", now, 2), control("resume", now, 5)];
    expect(project({ controls: stopped, dateTo: "2026-09-13" }).map(x => x.slot)).toEqual(["08:00"]);
    const deleted = transitionLifecycle({ lifecycle: "stopped", stopped: true }, "delete", true);
    expect(deleted).toMatchObject({ ok: true, state: { lifecycle: "deleted", stopped: true } });
    const restored = transitionLifecycle({ lifecycle: "deleted", stopped: true }, "restore", true);
    expect(restored).toEqual({ ok: true, state: { lifecycle: "paused", stopped: true }, canResume: false });
    expect(transitionLifecycle({ lifecycle: "paused", stopped: true }, "resume", true)).toEqual({ ok: false, reason: "INVALID_STATE" });
    expect(transitionLifecycle({ lifecycle: "active", stopped: false }, "pause", false).ok).toBe(false);
  });
});

describe("记录与实际完成时间", () => {
  it("未来周期不可record；已到时允许当日早于具体时刻但不得早于日期起点", () => {
    const [morning, evening] = project();
    if (!morning || !evening) throw new Error("Expected occurrences");
    expect(canRecordOccurrence(morning, now)).toBe(true);
    expect(canRecordOccurrence(evening, now)).toBe(false);
    expect(isValidActualCompletedAt(evening, toInstant("2026-09-11", "07:00"), now, createdAt)).toBe(false);
    expect(isValidActualCompletedAt(morning, toInstant("2026-09-11", "07:00"), now, createdAt)).toBe(true);
    expect(isValidActualCompletedAt(morning, toInstant("2026-09-10", "23:59"), now, createdAt)).toBe(false);
    expect(isValidActualCompletedAt(morning, toInstant("2026-09-11", "20:00"), now, createdAt)).toBe(false);
  });
  it("无时刻今天可记录，once提前完成不得早于创建瞬时", () => {
    const once = { recurring: false, eligibilityBoundary: toInstant("2026-09-20"), localDate: "2026-09-20" };
    expect(isValidActualCompletedAt(once, createdAt, now, createdAt)).toBe(true);
    expect(isValidActualCompletedAt(once, "2026-09-10T10:29:59.999Z", now, createdAt)).toBe(false);
    const [dateOnly] = project({ segments: [{ ...segment, schedule: { ...daily, times: [] } }] });
    expect(dateOnly?.canRecord).toBe(true);
    expect(isValidActualCompletedAt(once, "bad", now, createdAt)).toBe(false);
  });
});


describe("historical window bounds", () => {
  it("bounds every projected weekly/daily date across segment edges and date-only creation", () => {
    for (const times of [[], ["08:00", "20:00"]]) {
      for (const schedule of [{ kind: "daily" as const, startDate: "2026-09-10", endDate: "2026-09-20", times }, { kind: "weekly" as const, startDate: "2026-09-10", endDate: "2026-09-20", times, weekdays: [1, 7] }]) {
        for (const effectiveUntil of [null, "2026-09-13T00:00:00.000Z"]) {
          const candidate = { ...segment, schedule, effectiveUntil };
          for (const before of ["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-22"]) {
            const bound = previousSegmentDate(candidate, before);
            const slots = project({ segments: [candidate], dateFrom: "2026-09-01", dateTo: addDays(before, -1) });
            for (const occurrence of slots) { expect(bound).not.toBeNull(); expect(occurrence.localDate && bound && occurrence.localDate <= bound).toBe(true); }
          }
        }
      }
    }
  });
  it("retains backdated current once but ignores obsolete once and respects the date floor", () => {
    const once = { ...segment, schedule: { kind: "once" as const, date: "2000-01-01", time: null } };
    expect(previousSegmentDate(once, "2026-09-11", once.id)).toBe("2000-01-01");
    expect(previousSegmentDate(once, "2026-09-11", "other")).toBeNull();
    expect(previousSegmentDate(segment, "2000-01-01")).toBeNull();
  });
});
