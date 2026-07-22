// 萌獸排球 —— 伺服器房間模組(伺服器權威模擬)。
//
// 生命週期:waiting(等人+就緒)→ countdown(3-2-1)→ battle(30Hz 模擬,
// 先得 7 分獲勝)→ over(可 rematch 回 countdown)。
// 排球物理與遊戲端純邏輯模組共用同一份公式(src/shared/volley,與遊戲端
// repo 各持一份,需保持同步)。客戶端只上傳輸入、下行收快照 + 事件。

import { Room, type Client } from 'colyseus'
import { MapSchema, Schema, type } from '@colyseus/schema'
import {
  NetVolleyBall,
  NetVolleyPlayer,
  V_HOME_X,
  VMSG,
  VOLLEY_COUNTDOWN_SEC,
  VOLLEY_TARGET_POINTS,
  VOLLEY_TICK_HZ,
  VEV,
  type VolleyEvent,
  type VolleyInputMsg,
  type VolleyNetPhase,
  type VolleySide,
} from '../shared/volley'

const RECONNECT_GRACE_SEC = 15
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 去除易混淆字元
const CODE_LEN = 4

function genCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
  return s
}

interface Scheduled {
  t: number
  fn: () => void
}

interface HeldInput {
  d: number
  c: boolean
  jumpQueued: boolean
}

export class VolleyPlayerState extends Schema {
  @type('string') name = ''
  @type('number') slot = 0 // 0 = 左(房主),1 = 右(挑戰者)
  @type('boolean') ready = false
  @type('boolean') connected = true
  @type('boolean') rematch = false
  // 模擬快照(客戶端插值渲染用)
  @type('number') x = 0
  @type('number') y = 0
  @type('number') vx = 0
  @type('number') vy = 0
  @type('number') charge = 0
}

export class CritterVolleyState extends Schema {
  @type('string') phase: VolleyNetPhase = 'waiting'
  @type('string') code = ''
  @type('number') countdown = 0
  /** 有人斷線寬限中 → 模擬凍結 */
  @type('boolean') paused = false

  @type('number') score0 = 0
  @type('number') score1 = 0
  @type('number') serveSlot = 1
  @type('number') winnerSlot = -1

  /** 中央訊息:'' | 'serve' | 'score';msgSlot 指涉的 slot(客戶端轉成你/對手) */
  @type('string') msgKey = ''
  @type('number') msgSlot = -1

  @type('number') ballX = 0
  @type('number') ballY = 0
  @type('number') ballVX = 0
  @type('number') ballVY = 0
  @type('boolean') ballActive = false

  @type({ map: VolleyPlayerState }) players = new MapSchema<VolleyPlayerState>()
}

export class CritterVolleyRoom extends Room<CritterVolleyState> {
  maxClients = 2

  private ball!: NetVolleyBall
  private sims: [NetVolleyPlayer, NetVolleyPlayer] | null = null
  private inputs = new Map<string, HeldInput>() // sessionId → 最新持續輸入
  private roundActive = false
  private scheduled: Scheduled[] = []

  onCreate(options: { name?: string }) {
    const code = genCode()
    this.setState(new CritterVolleyState())
    this.state.code = code
    void this.setMetadata({ code, hostName: String(options?.name ?? '').slice(0, 16) })

    this.ball = new NetVolleyBall({
      onLanded: (side) => this.onBallLanded(side),
      onStruck: (at, by, power) => {
        const slot = by.side < 0 ? 0 : 1
        this.emit(
          power > 0.4
            ? { t: 'smash', x: at.x, y: at.y, slot, power }
            : { t: 'hit', x: at.x, y: at.y, slot, power },
        )
      },
    })

    this.onMessage(VMSG.input, (client, msg: VolleyInputMsg) => {
      const held = this.inputs.get(client.sessionId)
      if (!held) return
      const d = Number(msg?.d ?? 0)
      held.d = d < 0 ? -1 : d > 0 ? 1 : 0
      held.c = !!msg?.c
      if (msg?.j) held.jumpQueued = true
    })

    this.onMessage(VMSG.ready, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'waiting') return
      p.ready = true
      console.log(`[volley ${this.state.code}] ready: ${p.name}`)
      this.maybeStart()
    })

    this.onMessage(VMSG.rematch, (client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase !== 'over') return
      p.rematch = true
      let all = true
      this.state.players.forEach((q) => {
        if (!q.rematch || !q.connected) all = false
      })
      if (all && this.state.players.size === 2) this.startCountdown()
    })

    this.setPatchRate(1000 / VOLLEY_TICK_HZ)
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / VOLLEY_TICK_HZ)
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new VolleyPlayerState()
    p.name = String(options?.name ?? '').slice(0, 16) || `Critter-${client.sessionId.slice(0, 3)}`
    p.slot = this.takenSlots().has(0) ? 1 : 0
    p.x = V_HOME_X[p.slot as 0 | 1]
    p.y = 570 // GROUND_Y - COLLIDE_RADIUS,純顯示初值
    this.state.players.set(client.sessionId, p)
    this.inputs.set(client.sessionId, { d: 0, c: false, jumpQueued: false })
    console.log(`[volley ${this.state.code}] join: ${p.name} (slot ${p.slot}), players=${this.state.players.size}`)
    if (this.state.players.size >= 2) void this.lock()
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.state.players.get(client.sessionId)
    if (!p) return

    // 對局中意外斷線 → 給重連寬限,期間凍結模擬。
    if (!consented && (this.state.phase === 'battle' || this.state.phase === 'countdown')) {
      p.connected = false
      this.state.paused = true
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SEC)
        p.connected = true
        this.state.paused = this.anyDisconnected()
        return
      } catch {
        // 逾時未回 → 棄權,對手獲勝
        this.dropPlayer(client.sessionId)
        this.state.paused = this.anyDisconnected()
        if (this.state.phase === 'battle' || this.state.phase === 'countdown') {
          const other = this.firstPlayer()
          this.endMatch(other ? other.slot : -1)
        }
        return
      }
    }

    this.dropPlayer(client.sessionId)
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

  // ---------------------------------------------------------------- 模擬
  private tick(dt: number) {
    const s = this.state
    if (s.paused) return // 斷線寬限:凍結倒數 / 排程 / 物理

    this.runScheduled(dt)

    if (s.phase === 'countdown') {
      s.countdown = Math.max(0, s.countdown - dt)
      if (s.countdown <= 0) {
        s.phase = 'battle'
        this.startRound(s.serveSlot as 0 | 1)
      }
      return
    }
    if (s.phase !== 'battle' || !this.sims) return

    // 套用輸入(與單機一致:回合尚未開球時選手也能移動)。
    this.state.players.forEach((p, sessionId) => {
      const held = this.inputs.get(sessionId)
      const sim = this.sims![p.slot as 0 | 1]
      if (!held || !sim) return
      const jump = held.jumpQueued
      held.jumpQueued = false
      sim.step(dt, { dir: p.connected ? held.d : 0, jumpPressed: p.connected && jump, charge: p.connected && held.c })
    })

    this.ball.step(dt)
    this.syncSchema()
  }

  private syncSchema(): void {
    const s = this.state
    s.ballX = this.ball.pos.x
    s.ballY = this.ball.pos.y
    s.ballVX = this.ball.velocity.x
    s.ballVY = this.ball.velocity.y
    s.ballActive = this.ball.active
    s.players.forEach((p) => {
      const sim = this.sims?.[p.slot as 0 | 1]
      if (!sim) return
      p.x = sim.pos.x
      p.y = sim.pos.y
      p.vx = sim.velocity.x
      p.vy = sim.velocity.y
      p.charge = sim.charge
    })
  }

  // ---------------------------------------------------------------- 回合流程
  private maybeStart() {
    if (this.state.players.size !== 2) return
    let all = true
    this.state.players.forEach((p) => {
      if (!p.ready) all = false
    })
    if (all) this.startCountdown()
  }

  private startCountdown() {
    console.log(`[volley ${this.state.code}] countdown start`)
    const s = this.state
    this.scheduled = []
    this.roundActive = false

    // 每場都重建純物理實體,確保無殘留狀態。
    const mkEvents = (slot: 0 | 1) => ({
      onJump: () => this.emit({ t: 'jump', slot }),
      onChargeStart: () => this.emit({ t: 'charge', slot }),
    })
    this.sims = [new NetVolleyPlayer(0, mkEvents(0)), new NetVolleyPlayer(1, mkEvents(1))]
    this.ball.players = this.sims
    this.ball.resetAt(V_HOME_X[1], 150)

    s.score0 = 0
    s.score1 = 0
    s.winnerSlot = -1
    s.serveSlot = 1 // 與單機一致:首發由右側發球
    s.msgKey = ''
    s.msgSlot = -1
    s.countdown = VOLLEY_COUNTDOWN_SEC
    s.players.forEach((p) => {
      p.rematch = false
      p.ready = false
    })
    this.syncSchema()
    s.phase = 'countdown'
  }

  private startRound(serveSlot: 0 | 1): void {
    if (this.state.phase !== 'battle' || !this.sims) return
    this.roundActive = false
    this.sims[0].resetHome()
    this.sims[1].resetHome()
    this.ball.resetAt(V_HOME_X[serveSlot], 160)
    this.state.serveSlot = serveSlot
    this.state.msgKey = 'serve'
    this.state.msgSlot = serveSlot
    this.syncSchema()
    this.schedule(1, () => {
      if (this.state.phase !== 'battle') return
      this.state.msgKey = ''
      this.state.msgSlot = -1
      this.roundActive = true
      this.ball.serve()
    })
  }

  private onBallLanded(side: VolleySide): void {
    if (!this.roundActive || this.state.phase !== 'battle') return
    this.roundActive = false
    this.emit({ t: 'bounce' })

    // 落地的半邊輸掉該分,並由其發下一球。
    const scorerSlot = side < 0 ? 1 : 0
    if (scorerSlot === 0) this.state.score0 += 1
    else this.state.score1 += 1
    this.emit({ t: 'score', slot: scorerSlot })

    if (this.state.score0 >= VOLLEY_TARGET_POINTS || this.state.score1 >= VOLLEY_TARGET_POINTS) {
      this.endMatch(this.state.score0 > this.state.score1 ? 0 : 1)
      return
    }

    this.state.msgKey = 'score'
    this.state.msgSlot = scorerSlot
    this.schedule(1, () => this.startRound(side < 0 ? 0 : 1))
  }

  private endMatch(winnerSlot: number) {
    console.log(`[volley ${this.state.code}] match over, winner slot ${winnerSlot}`)
    const s = this.state
    this.roundActive = false
    this.scheduled = []
    s.phase = 'over'
    s.winnerSlot = winnerSlot
    s.msgKey = ''
    s.msgSlot = -1
    s.players.forEach((p) => {
      p.ready = false
    })
    this.emit({ t: 'over', winnerSlot })
  }

  // ---------------------------------------------------------------- 工具
  private emit(ev: VolleyEvent): void {
    this.broadcast(VEV, ev)
  }

  private schedule(seconds: number, fn: () => void): void {
    this.scheduled.push({ t: seconds, fn })
  }

  private runScheduled(dt: number): void {
    if (this.scheduled.length === 0) return
    const ready: Scheduled[] = []
    this.scheduled = this.scheduled.filter((s) => {
      s.t -= dt
      if (s.t <= 0) {
        ready.push(s)
        return false
      }
      return true
    })
    for (const s of ready) s.fn()
  }

  private dropPlayer(sessionId: string): void {
    this.state.players.delete(sessionId)
    this.inputs.delete(sessionId)
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

  private firstPlayer(): VolleyPlayerState | null {
    let found: VolleyPlayerState | null = null
    this.state.players.forEach((p) => {
      if (!found) found = p
    })
    return found
  }
}
