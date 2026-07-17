// 汪汪大作戰 —— 拔河物理(前後端共用)。
// 單機模式由前端 SoloDriver 呼叫;線上模式由伺服器 BarkBattleRoom 以固定
// tick 呼叫,前端只做插值顯示。兩邊永遠是同一份公式。

export const TIME_LIMIT = 25 // 每場秒數
export const PLAYER_STR = 0.92 // 玩家滿力拉繩係數(線上模式雙方相同)
export const ROPE_SPEED = 0.62 // 拔河整體速度
export const KNOT_ACCEL = 4.0 // 繩結加速度(慣性手感)
export const COUNTDOWN_SEC = 3.5 // 3-2-1-GO 總長

export const TICK_HZ = 20 // 伺服器模擬頻率
export const SEND_HZ = 15 // 客戶端吠叫強度上傳頻率

export interface RopeState {
  /** 繩結位置 -1(你輸)..+1(你贏),以 slot0 視角為正向 */
  push: number
  /** 繩結速度 */
  vel: number
}

/** 推進一步拔河模擬。直接改寫傳入的 state。 */
export function stepRope(
  s: RopeState,
  youLevel: number,
  foeLevel: number,
  youStr: number,
  foeStr: number,
  dt: number,
): void {
  const net = youLevel * youStr - foeLevel * foeStr
  s.vel += net * dt * ROPE_SPEED * KNOT_ACCEL
  s.vel *= Math.pow(0.0001, dt)
  s.push = Math.max(-1, Math.min(1, s.push + s.vel * dt))
  if (s.push <= -1 || s.push >= 1) s.vel = 0
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number(v) || 0))
}
