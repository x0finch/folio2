import { useCallback, useEffect, useRef, useState } from "react";
import { shouldLock } from "../idle-lock";

// 闲置锁的客户端机制(ADR 0029 / #291）。逻辑收进 hook，LockScreen 组件只管样子。
// 三件事：活动监听刷新「最后活跃时间戳」；主动定时器(前台到点当场锁)；重入比对
// (visibilitychange / pageshow / focus 兜底定时器被后台 throttle / 挂起 / 睡眠)。
// 时间戳存 localStorage → 刷新 / 重开 PWA 也扛得住(会话没销毁，只靠内存会被刷新绕过)。

const LAST_ACTIVE_KEY = "folio_lock_last_active";
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

export function useIdleLock(timeoutMs: number | null): { locked: boolean; unlock: () => void } {
  const [locked, setLocked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);
  // 用 ref 存超时，供事件闭包读最新值(S2 起 timeoutMs 会动态变)。
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;

  // baseTime = 本轮闲置的起算时刻。挂载时传持久化的 lastActiveAt(按「剩余时间」起，
  // 否则刷新会把计时重置成完整一轮、前台锁得偏晚)；活动 / 解锁时传 now(整轮)。
  const armTimer = useCallback((baseTime: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const t = timeoutRef.current;
    if (t === null) return; // 永不
    const remaining = t - (Date.now() - baseTime);
    if (remaining <= 0) {
      setLocked(true);
      return;
    }
    timer.current = setTimeout(() => setLocked(true), remaining);
  }, []);

  const checkExpiry = useCallback(() => {
    if (
      shouldLock({ lastActiveAt: readLastActive(), now: Date.now(), timeoutMs: timeoutRef.current })
    ) {
      setLocked(true);
    }
  }, []);

  const unlock = useCallback(() => {
    const now = Date.now();
    writeLastActive(now);
    lastWrite.current = now;
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
        setLocked(true);
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

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", checkExpiry);
    window.addEventListener("focus", checkExpiry);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", checkExpiry);
      window.removeEventListener("focus", checkExpiry);
    };
  }, [locked, armTimer, checkExpiry]);

  // 超时偏好变了要按新档重起主动定时器。主 effect 只在 locked 翻转时重挂 —— 拿不到新的
  // timeoutMs,旧定时器会带着旧档到点照锁。首屏(默认档 "5" → localStorage 读到 "never")和
  // 运行中改档(5 分钟 → 永不)都走这条:切「永不」清掉旧定时器,切具体值按新档重起。
  // 少了这条,选「永不」却仍在约 5 分钟后被锁,就是漏在这里。timeoutMs 亲自判一次「永不」
  // (而非只靠 armTimer 内的 ref):既是承重依赖、也防被 lint 当多余依赖删掉。
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
