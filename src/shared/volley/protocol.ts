// 萌獸排球(Critter Volley)—— 網路協定(前後端共用)。
// ⚠️ 與遊戲端 repo 的 src/net/protocol.ts 各持一份,必須保持同步。

/** Colyseus 房間註冊名稱 */
export const CRITTER_VOLLEY_ROOM = 'critter-volley'

/** 伺服器房間階段 */
export type VolleyNetPhase = 'waiting' | 'countdown' | 'battle' | 'over'

/** client → server 訊息名 */
export const VMSG = {
  /** { d: -1|0|1, c: boolean, j?: true } 移動方向 / 蓄力 / 跳躍(邊緣觸發) */
  input: 'input',
  /** 無 payload,玩家按下就緒 */
  ready: 'ready',
  /** 無 payload,結束後請求再來一場 */
  rematch: 'rematch',
} as const

/** client ← server 廣播事件(音效 / 特效用) */
export const VEV = 'ev'

export interface VolleyInputMsg {
  d: number // -1 / 0 / +1
  c: boolean // 蓄力中
  j?: boolean // 本次訊息帶跳躍(邊緣觸發)
}

/** 伺服器廣播的遊戲事件 */
export type VolleyEvent =
  | { t: 'hit'; x: number; y: number; slot: number; power: number }
  | { t: 'smash'; x: number; y: number; slot: number; power: number }
  | { t: 'bounce' }
  | { t: 'score'; slot: number }
  | { t: 'jump'; slot: number }
  | { t: 'charge'; slot: number }
  | { t: 'over'; winnerSlot: number }

/** 房間 metadata(大廳列表會看到) */
export interface VolleyRoomMeta {
  code: string
  hostName: string
}

/** 伺服器模擬 / 廣播頻率 */
export const VOLLEY_TICK_HZ = 30
/** 就緒後的開場倒數秒數 */
export const VOLLEY_COUNTDOWN_SEC = 3
/** 先得幾分獲勝(與單機 TARGET_POINTS 一致) */
export const VOLLEY_TARGET_POINTS = 7
