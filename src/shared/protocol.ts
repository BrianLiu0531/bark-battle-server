// 汪汪大作戰 —— 網路協定(前後端共用)。
// 未來每款新遊戲在 packages/shared/src/<game>/ 底下加自己的 protocol.ts,
// 平台層(房間、大廳、配對)不需要知道這些內容。

/** Colyseus 房間註冊名稱;客戶端 create / joinById / getAvailableRooms 都用它 */
export const BARK_BATTLE_ROOM = 'bark-battle'

/** 伺服器房間階段 */
export type NetPhase = 'waiting' | 'countdown' | 'battle' | 'over'

/** client → server 訊息名 */
export const MSG = {
  /** { v: number } 0..1 當下吠叫強度 */
  level: 'level',
  /** 無 payload,玩家按下就緒 */
  ready: 'ready',
  /** 無 payload,結束後請求再來一場 */
  rematch: 'rematch',
} as const

/** 房間 metadata(大廳列表會看到) */
export interface BarkRoomMeta {
  code: string
  hostName: string
}

/** 大廳列表項目(客戶端整理後的形狀) */
export interface OpenRoomInfo {
  roomId: string
  code: string
  hostName: string
  clients: number
  maxClients: number
}
