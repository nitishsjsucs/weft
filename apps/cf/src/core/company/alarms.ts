// One Durable Object alarm, several purposes (design 3.3 and 7.1): run jobs, scheduler ticks while the clock runs, the
// outbox retry and the restore watchdog. The plan lives in memory (an eviction is a process restart: run jobs are
// gone and the boot rule applies, the scheduler re-arms at boot, the outbox is flushed at boot), and the storage
// alarm is set only when the earliest due time moves earlier, because every setAlarm is a row written.

export type AlarmPurpose = "runs" | "tick" | "outbox" | "watchdog";

export interface AlarmStorage {
  setAlarm(at: number): Promise<void> | void;
  getAlarm(): Promise<number | null> | number | null;
}

export class AlarmPlan {
  private readonly due = new Map<AlarmPurpose, number>();
  /** The alarm the storage holds, as far as this instance knows (null: none, or not known yet). */
  private armedAt: number | null = null;
  private known = false;
  setAlarms = 0;

  constructor(private readonly storage: AlarmStorage) {}

  /** Asks for an alarm at `at` (default now) for `purpose`; keeps the earlier time if one is already planned. */
  async arm(purpose: AlarmPurpose, at: number = Date.now()): Promise<void> {
    const cur = this.due.get(purpose);
    if (cur === undefined || at < cur) this.due.set(purpose, at);
    await this.sync();
  }

  cancel(purpose: AlarmPurpose): void {
    this.due.delete(purpose);
  }

  has(purpose: AlarmPurpose): boolean {
    return this.due.has(purpose);
  }

  /** Called at the start of an alarm invocation: the storage alarm is gone, and these purposes are due now. */
  begin(now: number = Date.now()): Set<AlarmPurpose> {
    this.armedAt = null;
    this.known = true;
    const out = new Set<AlarmPurpose>();
    for (const [p, at] of this.due) if (at <= now + 5) { out.add(p); this.due.delete(p); }
    return out;
  }

  /** The earliest planned time, if any. */
  next(): number | null {
    let min: number | null = null;
    for (const at of this.due.values()) if (min === null || at < min) min = at;
    return min;
  }

  async sync(): Promise<void> {
    const want = this.next();
    if (want === null) return;
    if (!this.known) {
      this.armedAt = (await this.storage.getAlarm()) ?? null;
      this.known = true;
    }
    if (this.armedAt !== null && this.armedAt <= want) return;
    this.armedAt = want;
    this.setAlarms += 1;
    await this.storage.setAlarm(want);
  }

  /** Forget everything (a reset or restore rebuilt the world; deleteAll also cleared the storage alarm). */
  clear(): void {
    this.due.clear();
    this.armedAt = null;
    this.known = false;
  }
}
