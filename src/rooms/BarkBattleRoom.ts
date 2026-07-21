// 汪汪大作戰 —— 伺服器房間模組。
//
// 平台層(index.ts)只負責註冊房間;所有遊戲規則都在這個檔案。未來新遊戲
// 就是在 rooms/ 底下再加一個這樣的類別。
//
// 生命週期:waiting(等人+就緒)→ countdown → battle(20Hz 模擬)→ over
// (可 rematch 回 countdown)。繩結物理與前端單機模式共用 src/shared(與遊戲端 repo 各持一份,需保持同步)。

import { Room, type Client } from 'colyseus'
import { MapSchema, Schema, type } from '@colyseus/schema'
import {
  COUNTDOWN_SEC,
  MSG,
  PLAYER_STR,
  TICK_HZ,
  TIME_LIMIT,
  clamp01,
  stepRope,
  type NetPhase,
  type RopeState,
} from '../shared'

const RECONNECT_GRACE_SEC = 15
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 去除易混淆字元
const CODE_LEN = 4

function genCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
  return s
}

export class PlayerState extends Schema {
  @type('string') name = ''
  @type('number') slot = 0 // 0 = 房主(繩結正向),1 = 挑戰者
  @type('boolean') ready = false
  @type('boolean') connected = true
  @type('boolean') rematch = false
  @type('number') level = 0 // 0..1 當下吠叫強度
}

export class BarkBattleState extends Schema {
  @type('string') phase: NetPhase = 'waiting'
  @type('string') code = ''
  @type('number') push = 0 // slot0 視角:+1 = slot0 贏
  @type('number') timeLeft = TIME_LIMIT
  @type('number') countdown = 0
  @type('number') winnerSlot = -1
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>()
}

export class BarkBattleRoom extends Room<BarkBattleState> {
  maxClients = 2

  private rope: RopeState = { push: 0, vel: 0 }

  onCreate(options: { name?: string }) {
    const code = genCode()
    this.setState(new BarkBattleState())
    this.state.code = code
    void this.setMetadata({ code, hostName: String(options?.name ?? '').slice(0, 16) })

    this.onMessage(MSG.level, (client, msg: { v?: number }) => {
      const p = this.state.players.get(client.sessionId)
      if (p && this.state.phase === 'battle') p.level = clamp01(msg?.v ?? 0)
    })

    this.onMessage(MSG.ready, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'waiting') return
      p.ready = true
      console.log(`[room ${this.state.code}] ready: ${p.name}`)
      this.maybeStart()
    })

    this.onMessage(MSG.rematch, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'over') return
      p.rematch = true
      let all = true
      this.state.players.forEach((q) => {
        if (!q.rematch || !q.connected) all = false
      })
      if (all && this.state.players.size === 2) this.startCountdown()
    })

    this.onMessage(MSG.rtc, (client, payload: unknown) => {
      // WebRTC 信令中繼:原封不動轉發給房內另一位玩家(語音走 P2P,不經伺服器)
      this.clients.forEach((c) => {
        if (c.sessionId !== client.sessionId) c.send(MSG.rtc, payload)
      })
    })

    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / TICK_HZ)
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new PlayerState()
    p.name = String(options?.name ?? '').slice(0, 16) || `Shiba-${client.sessionId.slice(0, 3)}`
    p.slot = this.takenSlots().has(0) ? 1 : 0
    this.state.players.set(client.sessionId, p)
    console.log(`[room ${this.state.code}] join: ${p.name} (slot ${p.slot}), players=${this.state.players.size}`)
    // 滿員即上鎖,從大廳列表消失(未滿的 open 房才看得到)
    if (this.state.players.size >= 2) void this.lock()
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.state.players.get(client.sessionId)
    if (!p) return

    // 對局中意外斷線 → 給重連寬限
    if (!consented && (this.state.phase === 'battle' || this.state.phase === 'countdown')) {
      p.connected = false
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SEC)
        p.connected = true
        return
      } catch {
        // 逾時未回 → 棄權,對手獲勝
        this.state.players.delete(client.sessionId)
        if (this.state.phase === 'battle' || this.state.phase === 'countdown') {
          const other = this.firstPlayer()
          this.endMatch(other ? other.slot : -1)
        }
        void this.unlock()
        return
      }
    }

    this.state.players.delete(client.sessionId)
    if (this.state.phase === 'battle' || this.state.phase === 'countdown') {
      const other = this.firstPlayer()
      this.endMatch(other ? other.slot : -1)
    } else if (this.state.phase === 'waiting') {
      // 等待中有人走 → 重新開放給大廳
      this.state.players.forEach((q) => {
        q.ready = false
      })
      void this.unlock()
    }
  }

  private tick(dt: number) {
    const s = this.state
    if (s.phase === 'countdown') {
      s.countdown = Math.max(0, s.countdown - dt)
      if (s.countdown <= 0) s.phase = 'battle'
      return
    }
    if (s.phase !== 'battle') return

    let l0 = 0
    let l1 = 0
    s.players.forEach((p) => {
      if (!p.connected) return // 斷線寬限期間視為 0 出力
      if (p.slot === 0) l0 = p.level
      else l1 = p.level
    })

    stepRope(this.rope, l0, l1, PLAYER_STR, PLAYER_STR, dt)
    s.push = this.rope.push
    s.timeLeft = Math.max(0, s.timeLeft - dt)

    if (this.rope.push >= 1) this.endMatch(0)
    else if (this.rope.push <= -1) this.endMatch(1)
    else if (s.timeLeft <= 0) this.endMatch(this.rope.push >= 0 ? 0 : 1)
  }

  private maybeStart() {
    if (this.state.players.size !== 2) return
    let all = true
    this.state.players.forEach((p) => {
      if (!p.ready) all = false
    })
    if (all) this.startCountdown()
  }

  private startCountdown() {
    console.log(`[room ${this.state.code}] countdown start`)
    this.rope = { push: 0, vel: 0 }
    const s = this.state
    s.push = 0
    s.timeLeft = TIME_LIMIT
    s.winnerSlot = -1
    s.countdown = COUNTDOWN_SEC
    s.players.forEach((p) => {
      p.level = 0
      p.rematch = false
    })
    s.phase = 'countdown'
  }

  private endMatch(winnerSlot: number) {
    const s = this.state
    s.phase = 'over'
    s.winnerSlot = winnerSlot
    s.players.forEach((p) => {
      p.ready = false
      p.level = 0
    })
  }

  private takenSlots(): Set<number> {
    const set = new Set<number>()
    this.state.players.forEach((p) => set.add(p.slot))
    return set
  }

  private firstPlayer(): PlayerState | null {
    let found: PlayerState | null = null
    this.state.players.forEach((p) => {
      if (!found) found = p
    })
    return found
  }
}
