import { useCallback, useEffect, useRef, useState } from "react";
import { shouldLock } from "../idle-lock";

// 闲置锁的客户端机制(ADR 0029 / #291）。逻辑收进 hook，LockScreen 组件只管样子。
// 三件事：活动监听刷新「最后活跃时间戳」；主动定时器(前台到点当场锁)；重入比对
// (visibilitychange / pageshow / focus 兜底定时器被后台 throttle / 挂起 / 睡眠)。
// 时间戳存 localStorage → 刷新 / 重开 PWA 也扛得住(会话没销毁，只靠内存会被刷新绕过)。
//
// 跨标签**锁**同步(非解锁):任一标签锁定 → 写共享锁标志(localStorage)+ 广播,别的标签(含复制
// 网址新开的)读到即锁 —— 杜绝「一个标签锁了、复制网址开一个就没锁」的旁路。解锁**不**同步:
// 各标签自解自的(清掉自己 + 清标志,但不推给别的已锁标签),符合「只要锁同步」的诉求。

const LAST_ACTIVE_KEY = "folio_lock_last_active";
// 跨标签共享的锁标志:非空 = 有标签处于锁定。值用时间戳(每次变更都不同 → storage 事件必触发)。
const LOCK_FLAG_KEY = "folio_lock_locked";
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "pointerdown",
  "touchstart",
  "scroll",
  "wheel",
] as const;
// 活动写 localStorage 的节流：别每次 mousemove 都落盘。判定用的是「距上次活跃多久」，
// 5s 精度对分钟级超时绰绰有余。
const ACTIVITY_THROTTLE_MS = 5000;

function readLastActive(): number {
  try {
    const v = localStorage.getItem(LAST_ACTIVE_KEY);
    return v ? Number(v) : Date.now();
  } catch {
    return Date.now();
  }
}

function writeLastActive(t: number): void {
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, String(t));
  } catch {
    // 隐私模式 / storage 不可用：降级为纯内存定时器(刷新后不保锁)——可接受
  }
}

// 锁标志读写:非空即锁定。写用时间戳(值每次不同才会触发别的标签的 storage 事件)。
function readLockFlag(): boolean {
  try {
    return localStorage.getItem(LOCK_FLAG_KEY) != null;
  } catch {
    return false;
  }
}
function writeLockFlag(): void {
  try {
    localStorage.setItem(LOCK_FLAG_KEY, String(Date.now()));
  } catch {
    // storage 不可用:退化为本标签内存锁,跨标签不同步 —— 可接受
  }
}
function clearLockFlag(): void {
  try {
    localStorage.removeItem(LOCK_FLAG_KEY);
  } catch {}
}

export function useIdleLock(timeoutMs: number | null): { locked: boolean; unlock: () => void } {
  // 初始态读共享锁标志:复制网址新开的标签,若别处已锁 → 一挂载就是锁的(不闪内容)。
  const [locked, setLocked] = useState(readLockFlag);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);
  // 用 ref 存超时，供事件闭包读最新值(S2 起 timeoutMs 会动态变)。
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;
  // locked 的镜像 ref:供 lock() 判「已锁就别重复写标志/广播」,避免锁定期活动反复刷 storage。
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // 本标签发起锁定:写共享标志(广播给别的标签)+ 置本地态。已锁则跳过(不重复写)。
  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    writeLockFlag();
    setLocked(true);
  }, []);

  // baseTime = 本轮闲置的起算时刻。挂载时传持久化的 lastActiveAt(按「剩余时间」起，
  // 否则刷新会把计时重置成完整一轮、前台锁得偏晚)；活动 / 解锁时传 now(整轮)。
  // 到点直接锁;别的标签有活动时靠 storage 事件重排(见下方 onStorage),不在到点复核。
  const armTimer = useCallback(
    (baseTime: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const t = timeoutRef.current;
      if (t === null) return; // 永不
      const remaining = t - (Date.now() - baseTime);
      if (remaining <= 0) {
        lock();
        return;
      }
      timer.current = setTimeout(lock, remaining);
    },
    [lock],
  );

  const checkExpiry = useCallback(() => {
    if (
      shouldLock({ lastActiveAt: readLastActive(), now: Date.now(), timeoutMs: timeoutRef.current })
    ) {
      lock();
    }
  }, [lock]);

  const unlock = useCallback(() => {
    const now = Date.now();
    writeLastActive(now);
    lastWrite.current = now;
    clearLockFlag(); // 清共享标志:本标签解锁后,新开标签不再因旧标志而锁(用户已到场)。
    setLocked(false);
    armTimer(now);
  }, [armTimer]);

  useEffect(() => {
    checkExpiry(); // 挂载即比对：处理刷新 / 重开后已超时
    armTimer(readLastActive()); // 按剩余时间起，接续刷新前的闲置进度

    const onActivity = () => {
      const now = Date.now();
      // 已超时先锁、别刷新时间戳：刷新页面时浏览器恢复滚动位置会触发一次 scroll 事件，
      // 若此刻(locked 尚为 false)直接写 now，会把「早已过期」的时间戳抹掉、绕过锁。
      if (shouldLock({ lastActiveAt: readLastActive(), now, timeoutMs: timeoutRef.current })) {
        lock();
        return;
      }
      if (locked) return; // 锁定时活动不刷新(只有 unlock 才解)
      if (now - lastWrite.current >= ACTIVITY_THROTTLE_MS) {
        writeLastActive(now);
        lastWrite.current = now;
      }
      armTimer(now); // 每次活动重置定时器(整轮)
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkExpiry();
    };
    const onStorage = (e: StorageEvent) => {
      // 别的标签写了锁标志 → 本标签也锁(不回写,避免环)。清标志(别的标签解锁)**不**跟随 —— 解锁各自独立。
      if (e.key === LOCK_FLAG_KEY && e.newValue != null) {
        setLocked(true);
        return;
      }
      // 别的标签有活动 → 共享 lastActive 前移:按新值重排本标签定时器,别在用户于别处活动时误锁。
      if (e.key === LAST_ACTIVE_KEY && e.newValue != null && !lockedRef.current) {
        armTimer(Number(e.newValue));
      }
    };

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", checkExpiry);
    window.addEventListener("focus", checkExpiry);
    window.addEventListener("storage", onStorage);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", checkExpiry);
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener("storage", onStorage);
    };
  }, [locked, armTimer, checkExpiry, lock]);

  // 超时偏好变了要按新档重起主动定时器(切「永不」清掉旧定时器)。见 idle-lock.ts / lock-screen.tsx。
  useEffect(() => {
    if (locked) return;
    if (timeoutMs === null) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    armTimer(readLastActive());
  }, [timeoutMs, locked, armTimer]);

  return { locked, unlock };
}
