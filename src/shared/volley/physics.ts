// 萌獸排球 —— 排球物理(伺服器權威模擬)。
// ⚠️ 移植自遊戲端 repo 的 src/game/volleyBall.ts / volleyPlayer.ts /
//    constants.ts(去除 AI 與音訊)。改了任一邊的公式,另一邊要同步,
//    否則單機手感與線上不符。
//
// 線上模式固定使用 1280×720 標準球場(不做 RWD);客戶端以置中定寬
// 方式渲染,保證雙方看到完全相同的場地。

// --- 場地 ---
export const V_VIEW_W = 1280
export const V_VIEW_H = 720
export const V_GROUND_Y = 620
export const V_LEFT_WALL = 30
export const V_RIGHT_WALL = 1250
export const V_NET_X = 640
export const V_NET_HALF_W = 9
export const V_NET_TOP = 360
export const V_CEILING_Y = 0

// --- 球物理 ---
export const V_BALL_GRAVITY = 1180
export const V_BALL_RADIUS = 28
export const V_HIT_SPEED = 580
export const V_WALL_BOUNCE = 0.82
export const V_NET_BOUNCE = 0.7
export const V_BALL_MAX_SPEED = 1100
export const V_HIT_COOLDOWN = 0.16

// --- 選手物理 ---
export const V_MOVE_SPEED = 430
export const V_JUMP_VELOCITY = -760
export const V_PLAYER_GRAVITY = 1600
export const V_COLLIDE_RADIUS = 50
export const V_HIT_RADIUS = 60
export const V_CHARGE_TIME = 0.65

// 兩側 home x(slot0 左 / slot1 右)
export const V_HOME_X: readonly [number, number] = [320, 960]

export type VolleySide = -1 | 1

export interface VVec2 {
  x: number
  y: number
}

export interface VolleyStepInput {
  dir: number // -1 / 0 / +1
  jumpPressed: boolean // 邊緣觸發
  charge: boolean
}

const clampNum = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)

function limitLength(v: VVec2, max: number): VVec2 {
  const len = Math.hypot(v.x, v.y)
  if (len > max && len > 0) {
    const s = max / len
    return { x: v.x * s, y: v.y * s }
  }
  return v
}

function normalize(v: VVec2): VVec2 {
  const len = Math.hypot(v.x, v.y)
  if (len < 1e-6) return { x: 0, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

function lerpVec(a: VVec2, b: VVec2, t: number): VVec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export interface NetPlayerEvents {
  onJump: () => void
  onChargeStart: () => void
}

/** 輸入驅動的選手(無 AI;左右兩人皆由客戶端輸入控制)。 */
export class NetVolleyPlayer {
  readonly side: VolleySide
  readonly hitRadius = V_HIT_RADIUS

  pos: VVec2
  velocity: VVec2 = { x: 0, y: 0 }
  grounded = false

  readonly minX: number
  readonly maxX: number
  readonly homeX: number

  charge = 0

  private chargeEvSent = false
  private ev: NetPlayerEvents

  constructor(slot: 0 | 1, ev: NetPlayerEvents) {
    this.side = slot === 0 ? -1 : 1
    this.homeX = V_HOME_X[slot]
    if (slot === 0) {
      this.minX = V_LEFT_WALL + V_COLLIDE_RADIUS
      this.maxX = V_NET_X - V_NET_HALF_W - V_HIT_RADIUS
    } else {
      this.minX = V_NET_X + V_NET_HALF_W + V_HIT_RADIUS
      this.maxX = V_RIGHT_WALL - V_COLLIDE_RADIUS
    }
    this.ev = ev
    this.pos = { x: this.homeX, y: V_GROUND_Y - V_COLLIDE_RADIUS }
  }

  resetHome(): void {
    this.pos = { x: this.homeX, y: V_GROUND_Y - V_COLLIDE_RADIUS }
    this.velocity = { x: 0, y: 0 }
    this.charge = 0
    this.chargeEvSent = false
  }

  consumeCharge(): number {
    const c = this.charge
    this.charge = 0
    this.chargeEvSent = false
    return c
  }

  /** dt 單位:秒。與客戶端 VolleyPlayer.step(人類分支)公式一致。 */
  step(dt: number, input: VolleyStepInput): void {
    this.velocity.y += V_PLAYER_GRAVITY * dt

    // 蓄力扣殺的建立 / 衰減。
    if (input.charge) {
      this.charge = Math.min(this.charge + dt / V_CHARGE_TIME, 1)
      if (!this.chargeEvSent && this.charge > 0.04) {
        this.chargeEvSent = true
        this.ev.onChargeStart()
      }
    } else {
      this.charge = Math.max(this.charge - dt * 2.5, 0)
      if (this.charge <= 0.04) this.chargeEvSent = false
    }

    this.velocity.x = input.dir * V_MOVE_SPEED

    if (input.jumpPressed && this.grounded) {
      this.velocity.y = V_JUMP_VELOCITY
      this.grounded = false
      this.ev.onJump()
    }

    this.pos.x += this.velocity.x * dt
    this.pos.y += this.velocity.y * dt
    const floorY = V_GROUND_Y - V_COLLIDE_RADIUS
    if (this.pos.y >= floorY) {
      this.pos.y = floorY
      if (this.velocity.y > 0) this.velocity.y = 0
      this.grounded = true
    } else {
      this.grounded = false
    }
    this.pos.x = clampNum(this.pos.x, this.minX, this.maxX)
  }
}

export interface NetBallEvents {
  /** 球落地。side = 落地的半邊(-1 左 / +1 右)。 */
  onLanded: (side: VolleySide) => void
  /** 球被擊中。 */
  onStruck: (at: VVec2, by: NetVolleyPlayer, power: number) => void
}

/** 球的街機物理 —— 與客戶端 VolleyBall 同一份公式(固定 1280 球場)。 */
export class NetVolleyBall {
  pos: VVec2 = { x: 0, y: 0 }
  velocity: VVec2 = { x: 0, y: 0 }
  active = false

  readonly radius = V_BALL_RADIUS
  players: NetVolleyPlayer[] = []

  private hitCd = new Map<NetVolleyPlayer, number>()
  private ev: NetBallEvents

  constructor(ev: NetBallEvents) {
    this.ev = ev
  }

  resetAt(x: number, y: number): void {
    this.pos = { x, y }
    this.velocity = { x: 0, y: 0 }
    this.active = false
    this.hitCd.clear()
  }

  serve(): void {
    this.active = true
  }

  step(dt: number): void {
    for (const [k, v] of this.hitCd) this.hitCd.set(k, v - dt)

    if (!this.active) return

    this.velocity.y += V_BALL_GRAVITY * dt
    this.velocity = limitLength(this.velocity, V_BALL_MAX_SPEED)
    this.pos.x += this.velocity.x * dt
    this.pos.y += this.velocity.y * dt

    this.collideWalls()
    this.collideNet()
    this.collidePlayers()
    this.collideFloor()
  }

  private collideWalls(): void {
    if (this.pos.x < V_LEFT_WALL + this.radius) {
      this.pos.x = V_LEFT_WALL + this.radius
      this.velocity.x = Math.abs(this.velocity.x) * V_WALL_BOUNCE
    } else if (this.pos.x > V_RIGHT_WALL - this.radius) {
      this.pos.x = V_RIGHT_WALL - this.radius
      this.velocity.x = -Math.abs(this.velocity.x) * V_WALL_BOUNCE
    }
    if (this.pos.y < V_CEILING_Y + this.radius) {
      this.pos.y = V_CEILING_Y + this.radius
      this.velocity.y = Math.abs(this.velocity.y) * V_WALL_BOUNCE
    }
  }

  private collideNet(): void {
    const rx0 = V_NET_X - V_NET_HALF_W
    const rx1 = V_NET_X + V_NET_HALF_W
    const cx = clampNum(this.pos.x, rx0, rx1)
    const cy = clampNum(this.pos.y, V_NET_TOP, V_GROUND_Y)
    const diff: VVec2 = { x: this.pos.x - cx, y: this.pos.y - cy }
    const dist = Math.hypot(diff.x, diff.y)
    if (dist < this.radius) {
      let n: VVec2
      if (dist > 0.5) {
        n = { x: diff.x / dist, y: diff.y / dist }
      } else {
        let nx = sign(this.pos.x - V_NET_X)
        if (nx === 0) nx = 1
        n = { x: nx, y: 0 }
      }
      // 打到網頂會把球往上彈。
      if (this.pos.y < V_NET_TOP + this.radius && Math.abs(this.pos.x - V_NET_X) < V_NET_HALF_W + 4) {
        n = { x: 0, y: -1 }
      }
      this.pos = { x: cx + n.x * this.radius, y: cy + n.y * this.radius }
      const vn = this.velocity.x * n.x + this.velocity.y * n.y
      if (vn < 0) {
        this.velocity.x -= n.x * vn * (1 + V_NET_BOUNCE)
        this.velocity.y -= n.y * vn * (1 + V_NET_BOUNCE)
      }
    }
  }

  private collidePlayers(): void {
    for (const p of this.players) {
      const cd = this.hitCd.get(p) ?? 0
      if (cd > 0) continue
      const d: VVec2 = { x: this.pos.x - p.pos.x, y: this.pos.y - p.pos.y }
      const reach = this.radius + p.hitRadius
      if (Math.hypot(d.x, d.y) <= reach) {
        let n = d
        if (Math.hypot(n.x, n.y) < 1) n = { x: 0, y: -1 }
        n = normalize(n)
        // 向上偏,讓對打弧線漂亮。
        n.y -= 0.65
        n = normalize(n)

        const power = p.consumeCharge()
        // 蓄力扣殺只有在高點(接近 / 高於球網)才會往下砸。
        const highEnough = this.pos.y < V_NET_TOP + 50

        if (power > 0.15 && highEnough) {
          const attack = normalize({ x: -p.side, y: 0.24 })
          n = normalize(lerpVec(n, attack, clampNum(0.78 * power, 0, 0.85)))
          this.velocity = {
            x: n.x * (V_HIT_SPEED * (1 + 0.95 * power)),
            y: n.y * (V_HIT_SPEED * (1 + 0.95 * power)),
          }
          this.velocity.x += p.velocity.x * 0.3
        } else if (power > 0.15) {
          const sp = V_HIT_SPEED * (1 + 0.55 * power)
          this.velocity = { x: n.x * sp, y: n.y * sp }
          this.velocity.x += p.velocity.x * 0.38
          if (this.velocity.y > -160) this.velocity.y = -160
        } else {
          this.velocity = { x: n.x * V_HIT_SPEED, y: n.y * V_HIT_SPEED }
          this.velocity.x += p.velocity.x * 0.38
          if (this.velocity.y > -160) this.velocity.y = -160
        }

        this.velocity = limitLength(this.velocity, V_BALL_MAX_SPEED)
        this.pos = { x: p.pos.x + n.x * (reach + 1), y: p.pos.y + n.y * (reach + 1) }
        this.hitCd.set(p, V_HIT_COOLDOWN)
        const emittedPower = highEnough ? power : power * 0.4
        this.ev.onStruck({ x: this.pos.x, y: this.pos.y }, p, emittedPower)
      }
    }
  }

  private collideFloor(): void {
    if (this.pos.y + this.radius >= V_GROUND_Y) {
      this.pos.y = V_GROUND_Y - this.radius
      this.active = false
      const side: VolleySide = this.pos.x < V_NET_X ? -1 : 1
      this.ev.onLanded(side)
    }
  }
}
