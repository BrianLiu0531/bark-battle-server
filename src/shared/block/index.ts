// ⚠️ 此目錄與 blockbattle-noskin-game repo 各持一份對應內容,必須保持同步:
//    protocol.ts — 訊息協定(對應遊戲端 src/net/protocol.ts)
//
// Block Battle 沒有 physics.ts:盤面模擬全在客戶端,伺服器不跑遊戲規則,
// 只做種子 / 計時 / 垃圾行路由 / 勝負仲裁。
export * from './protocol'
