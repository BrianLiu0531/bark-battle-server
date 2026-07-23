// 共用遊戲伺服器 —— 平台層。
//
// 這個檔案不含任何遊戲規則,只負責:HTTP 服務、Colyseus 掛載、房間註冊。
// 未來每款新遊戲 = rooms/ 加一個 Room 類別 + 這裡加一行 define()。

import http from 'node:http'
import express from 'express'
import { Server } from 'colyseus'
import { BARK_BATTLE_ROOM } from './shared'
import { BarkBattleRoom } from './rooms/BarkBattleRoom'
import { CRITTER_VOLLEY_ROOM } from './shared/volley'
import { CritterVolleyRoom } from './rooms/CritterVolleyRoom'
import { BLOCK_BATTLE_ROOM } from './shared/block'
import { BlockBattleRoom } from './rooms/BlockBattleRoom'

const port = Number(process.env.PORT ?? 2567)

const app = express()
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

const server = http.createServer(app)
const gameServer = new Server({ server })

// ── 遊戲房間註冊(每款遊戲一行) ────────────────────────────────
gameServer.define(BARK_BATTLE_ROOM, BarkBattleRoom).enableRealtimeListing()
gameServer.define(CRITTER_VOLLEY_ROOM, CritterVolleyRoom).enableRealtimeListing()
gameServer.define(BLOCK_BATTLE_ROOM, BlockBattleRoom).enableRealtimeListing()
// gameServer.define('next-game', NextGameRoom).enableRealtimeListing()

gameServer.listen(port).then(() => {
  console.log(`[bark-games] server listening on ws://localhost:${port}`)
})
