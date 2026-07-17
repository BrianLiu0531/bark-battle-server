// ⚠️ 此目錄與另一個 repo(伺服器 / 遊戲端)各持一份,兩邊必須保持一致:
//    physics.ts  — 拔河物理(改了任一邊,另一邊要同步,否則單機手感與線上不符)
//    protocol.ts — 訊息協定(改了不同步會直接壞連線)
export * from './physics'
export * from './protocol'
