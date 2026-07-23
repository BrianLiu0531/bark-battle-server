// Block Battle —— 網路協定(前後端共用)。
// ⚠️ 與遊戲端 repo 的 src/net/protocol.ts 各持一份,必須保持同步。
//
// 設計note:俄羅斯方塊不做伺服器權威模擬。DAS/ARR/lock delay 這種
// 逐幀手感禁不起 rollback,所以「自己的盤面由自己算」,伺服器只負責
// 種子、計時、垃圾行路由與勝負仲裁,對手盤面以壓縮字串同步過來顯示。

/** Colyseus 房間註冊名稱 */
export const BLOCK_BATTLE_ROOM = 'block-battle'

/** 伺服器房間階段 */
export type BlockNetPhase = 'waiting' | 'countdown' | 'battle' | 'over'

/** client → server 訊息名 */
export const BMSG = {
  /** 無 payload,玩家按下就緒 */
  ready: 'ready',
  /** 無 payload,結束後請求再來一場 */
  rematch: 'rematch',
  /** { b: string } 盤面快照,ROWS*COLS 個 '0'..'8' 字元(含隱藏列) */
  board: 'board',
  /** { t, r, x, y } 活動方塊型別 / 旋轉 / 原點 */
  piece: 'piece',
  /** { n: number } 本次落塊送出的攻擊行數 */
  attack: 'attack',
  /** { lv, ln, st, pd } 等級 / 消行 / 累積攻擊 / 待落垃圾 */
  stat: 'stat',
  /** 無 payload,自己封頂出局 */
  dead: 'dead',
} as const

/** client ← server:收到垃圾行(只送給挨打的那一方) */
export const BEV_GARBAGE = 'gb'

export interface BlockPieceMsg {
  t: number
  r: number
  x: number
  y: number
}

export interface BlockStatMsg {
  lv: number
  ln: number
  st: number
  pd: number
}

/** 每一行的洞位由伺服器決定,兩邊才不會對不上、也不能被客戶端動手腳 */
export interface BlockGarbageMsg {
  n: number
  holes: number[]
}

/** 房間 metadata(大廳列表會看到) */
export interface BlockRoomMeta {
  code: string
  hostName: string
}

/** 盤面尺寸(需與遊戲端 constants.ts 的 COLS / ROWS 一致) */
export const BLOCK_COLS = 10
export const BLOCK_ROWS = 22

/** 狀態同步頻率 */
export const BLOCK_PATCH_HZ = 15
/** 就緒後的開場倒數秒數 */
export const BLOCK_COUNTDOWN_SEC = 3
/** 單場時間(與單機 MATCH_SECONDS 一致) */
export const BLOCK_MATCH_SECONDS = 120
/** 空盤面字串(state 初值 / 重置用) */
export const BLOCK_EMPTY_BOARD = '0'.repeat(BLOCK_COLS * BLOCK_ROWS)
