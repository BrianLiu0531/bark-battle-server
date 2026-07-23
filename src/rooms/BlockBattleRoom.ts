// Block Battle —— 伺服器房間模組(中繼 + 仲裁,不做盤面模擬)。
//
// 生命週期:waiting(等人+就緒)→ countdown(3-2-1,同時發亂數種子)
// → battle(120 秒倒數,雙方各自模擬、上傳盤面快照)→ over(可 rematch)。
//
// 伺服器職責:
//   1. 發放 seed —— 兩邊用同一組 7-bag 序列,對戰才公平。
//   2. 中繼盤面 —— 客戶端上傳壓縮字串,寫進 Schema 由對手讀取顯示。
//   3. 垃圾行路由 —— 攻擊行數與洞位由伺服器決定後推給挨打的一方。
//   4. 計時與勝負 —— 時間到比累積攻擊,封頂 / 斷線直接判對手贏。

import { Room, type Client } from 'colyseus'
import { MapSchema, Schema, type } from '@colyseus/schema'
import {
  BEV_GARBAGE,
  BLOCK_COLS,
  BLOCK_COUNTDOWN_SEC,
  BLOCK_EMPTY_BOARD,
  BLOCK_MATCH_SECONDS,
  BLOCK_PATCH_HZ,
  BMSG,
  type BlockGarbageMsg,
  type BlockNetPhase,
  type BlockPieceMsg,
  type BlockStatMsg,
} from '../shared/block'

const RECONNECT_GRACE_SEC = 15
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 去除易混淆字元
const CODE_LEN = 4
/** 單次落塊最多能送出的垃圾行,擋掉異常客戶端 */
const MAX_ATTACK_PER_LOCK = 20

function genCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
  return s
}

export class BlockPlayerState extends Schema {
  @type('string') name = ''
  @type('number') slot = 0 // 0 = 房主,1 = 挑戰者
  @type('boolean') ready = false
  @type('boolean') connected = true
  @type('boolean') rematch = false
  @type('boolean') dead = false

  /** 盤面快照:ROWS*COLS 個 '0'..'8' 字元,由上而下、由左而右 */
  @type('string') board = BLOCK_EMPTY_BOARD
  @type('number') pieceType = -1
  @type('number') pieceRot = 0
  @type('number') pieceX = 0
  @type('number') pieceY = 0

  @type('number') level = 1
  @type('number') lines = 0
  @type('number') sent = 0
  @type('number') pending = 0
}

export class BlockBattleState extends Schema {
  @type('string') phase: BlockNetPhase = 'waiting'
  @type('string') code = ''
  @type('number') countdown = 0
  @type('number') timeLeft = BLOCK_MATCH_SECONDS
  /** 7-bag 亂數種子,雙方共用 */
  @type('number') seed = 0
  /** 有人斷線寬限中 → 計時凍結 */
  @type('boolean') paused = false
  /** 0 / 1 = 勝方 slot;-1 = 平手或未定 */
  @type('number') winnerSlot = -1

  @type({ map: BlockPlayerState }) players = new MapSchema<BlockPlayerState>()
}

export class BlockBattleRoom extends Room<BlockBattleState> {
  maxClients = 2

  private clients_ = new Map<string, Client>() // sessionId → Client(用於單點推送垃圾行)

  onCreate(options: { name?: string }) {
    const code = genCode()
    this.setState(new BlockBattleState())
    this.state.code = code
    void this.setMetadata({ code, hostName: String(options?.name ?? '').slice(0, 16) })

    // ── 盤面 / 方塊 / 統計:純中繼,寫進 Schema 讓對手讀 ──────────────
    this.onMessage(BMSG.board, (client, msg: { b?: string }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      const b = String(msg?.b ?? '')
      if (b.length !== BLOCK_EMPTY_BOARD.length) return
      p.board = b
    })

    this.onMessage(BMSG.piece, (client, msg: BlockPieceMsg) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      p.pieceType = Number(msg?.t ?? -1) | 0
      p.pieceRot = Number(msg?.r ?? 0) | 0
      p.pieceX = Number(msg?.x ?? 0) | 0
      p.pieceY = Number(msg?.y ?? 0) | 0
    })

    this.onMessage(BMSG.stat, (client, msg: BlockStatMsg) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      p.level = Math.max(1, Number(msg?.lv ?? 1) | 0)
      p.lines = Math.max(0, Number(msg?.ln ?? 0) | 0)
      p.sent = Math.max(0, Number(msg?.st ?? 0) | 0)
      p.pending = Math.max(0, Number(msg?.pd ?? 0) | 0)
    })

    // ── 攻擊:伺服器決定洞位後推給對手 ────────────────────────────
    this.onMessage(BMSG.attack, (client, msg: { n?: number }) => {
      if (this.state.phase !== 'battle') return
      const p = this.state.players.get(client.sessionId)
      if (!p || p.dead) return
      const n = Math.min(Math.max(Number(msg?.n ?? 0) | 0, 0), MAX_ATTACK_PER_LOCK)
      if (n <= 0) return

      const target = this.opponentOf(client.sessionId)
      if (!target) return
      const targetState = this.state.players.get(target.sessionId)
      if (!targetState || targetState.dead) return

      const holes: number[] = []
      for (let i = 0; i < n; i++) holes.push((Math.random() * BLOCK_COLS) | 0)
      const payload: BlockGarbageMsg = { n, holes }
      target.send(BEV_GARBAGE, payload)
    })

    // ── 封頂出局 ──────────────────────────────────────────────
    this.onMessage(BMSG.dead, (client) => {
      if (this.state.phase !== 'battle') return
      const p = this.state.players.get(client.sessionId)
      if (!p || p.dead) return
      p.dead = true
      const other = this.otherState(client.sessionId)
      console.log(`[block ${this.state.code}] topout: ${p.name}`)
      this.endMatch(other ? other.slot : -1)
    })

    this.onMessage(BMSG.ready, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'waiting') return
      p.ready = true
      console.log(`[block ${this.state.code}] ready: ${p.name}`)
      this.maybeStart()
    })

    this.onMessage(BMSG.rematch, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'over') return
      p.rematch = true
      let all = true
      this.state.players.forEach((q) => {
        if (!q.rematch || !q.connected) all = false
      })
      if (all && this.state.players.size === 2) this.startCountdown()
    })

    this.setPatchRate(1000 / BLOCK_PATCH_HZ)
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / BLOCK_PATCH_HZ)
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new BlockPlayerState()
    p.name = String(options?.name ?? '').slice(0, 16) || `Player-${client.sessionId.slice(0, 3)}`
    p.slot = this.takenSlots().has(0) ? 1 : 0
    this.state.players.set(client.sessionId, p)
    this.clients_.set(client.sessionId, client)
    console.log(
      `[block ${this.state.code}] join: ${p.name} (slot ${p.slot}), players=${this.state.players.size}`,
    )
    if (this.state.players.size >= 2) void this.lock()
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.state.players.get(client.sessionId)
    if (!p) return

    // 對局中意外斷線 → 給重連寬限,期間凍結計時。
    if (!consented && (this.state.phase === 'battle' || this.state.phase === 'countdown')) {
      p.connected = false
      this.state.paused = true
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SEC)
        p.connected = true
        this.clients_.set(client.sessionId, client)
        this.state.paused = this.anyDisconnected()
        return
      } catch {
        // 逾時未回 → 棄權,對手獲勝
        const other = this.otherState(client.sessionId)
        this.dropPlayer(client.sessionId)
        this.state.paused = this.anyDisconnected()
        if (this.state.phase === 'battle' || this.state.phase === 'countdown') {
          this.endMatch(other ? other.slot : -1)
        }
        return
      }
    }

    const other = this.otherState(client.sessionId)
    this.dropPlayer(client.sessionId)
    if (this.state.phase === 'battle' || this.state.phase === 'countdown') {
      this.endMatch(other ? other.slot : -1)
    } else if (this.state.phase === 'waiting' || this.state.phase === 'over') {
      // 剩下的人回到等待,重新開放給大廳
      this.state.phase = 'waiting'
      this.state.players.forEach((q) => {
        q.ready = false
        q.rematch = false
      })
      void this.unlock()
    }
  }

  // ---------------------------------------------------------------- 計時
  private tick(dt: number) {
    const s = this.state
    if (s.paused) return

    if (s.phase === 'countdown') {
      s.countdown = Math.max(0, s.countdown - dt)
      if (s.countdown <= 0) {
        s.phase = 'battle'
        s.timeLeft = BLOCK_MATCH_SECONDS
        console.log(`[block ${s.code}] battle start (seed ${s.seed})`)
      }
      return
    }
    if (s.phase !== 'battle') return

    s.timeLeft = Math.max(0, s.timeLeft - dt)
    if (s.timeLeft <= 0) {
      // 時間到:比累積攻擊行數,同分平手。
      const a = this.stateOfSlot(0)
      const b = this.stateOfSlot(1)
      const sa = a?.sent ?? 0
      const sb = b?.sent ?? 0
      this.endMatch(sa > sb ? 0 : sb > sa ? 1 : -1)
    }
  }

  // ---------------------------------------------------------------- 流程
  private maybeStart() {
    if (this.state.players.size !== 2) return
    let all = true
    this.state.players.forEach((p) => {
      if (!p.ready) all = false
    })
    if (all) this.startCountdown()
  }

  private startCountdown() {
    const s = this.state
    // 種子必須每場重發,否則 rematch 會拿到一模一樣的方塊序列。
    s.seed = (Math.random() * 0x7fffffff) >>> 0
    s.winnerSlot = -1
    s.countdown = BLOCK_COUNTDOWN_SEC
    s.timeLeft = BLOCK_MATCH_SECONDS
    s.players.forEach((p) => {
      p.ready = false
      p.rematch = false
      p.dead = false
      p.board = BLOCK_EMPTY_BOARD
      p.pieceType = -1
      p.pieceRot = 0
      p.pieceX = 0
      p.pieceY = 0
      p.level = 1
      p.lines = 0
      p.sent = 0
      p.pending = 0
    })
    s.phase = 'countdown'
    console.log(`[block ${s.code}] countdown start`)
  }

  private endMatch(winnerSlot: number) {
    const s = this.state
    if (s.phase === 'over') return
    console.log(`[block ${s.code}] match over, winner slot ${winnerSlot}`)
    s.phase = 'over'
    s.winnerSlot = winnerSlot
    s.players.forEach((p) => {
      p.ready = false
      p.rematch = false
    })
  }

  // ---------------------------------------------------------------- 工具
  private opponentOf(sessionId: string): Client | null {
    let found: Client | null = null
    this.clients_.forEach((c, id) => {
      if (id !== sessionId && this.state.players.has(id)) found = c
    })
    return found
  }

  private otherState(sessionId: string): BlockPlayerState | null {
    let found: BlockPlayerState | null = null
    this.state.players.forEach((p, id) => {
      if (id !== sessionId) found = p
    })
    return found
  }

  private stateOfSlot(slot: number): BlockPlayerState | null {
    let found: BlockPlayerState | null = null
    this.state.players.forEach((p) => {
      if (p.slot === slot) found = p
    })
    return found
  }

  private dropPlayer(sessionId: string): void {
    this.state.players.delete(sessionId)
    this.clients_.delete(sessionId)
  }

  private anyDisconnected(): boolean {
    let any = false
    this.state.players.forEach((p) => {
      if (!p.connected) any = true
    })
    return any
  }

  private takenSlots(): Set<number> {
    const set = new Set<number>()
    this.state.players.forEach((p) => set.add(p.slot))
    return set
  }
}
