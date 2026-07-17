# bark-battle-server — 遊戲伺服器(Colyseus)

汪汪大作戰(及未來多款遊戲)的共用多人伺服器。獨立 repo,與遊戲前端分開部署。

```
src/
├─ index.ts              # 平台層:HTTP + Colyseus 掛載、房間註冊(每款遊戲一行)
├─ rooms/
│  └─ BarkBattleRoom.ts  # 汪汪大作戰:房號、就緒、20Hz 拔河、斷線寬限、rematch
└─ shared/               # ⚠️ 與遊戲端 repo 各持一份,必須保持同步
   ├─ physics.ts         #    拔河物理(前端單機模式跑同一份公式)
   └─ protocol.ts        #    房間名 / 階段 / 訊息協定
```

新遊戲上線:`src/shared/` 加該遊戲的協定與純邏輯 → `src/rooms/` 加一個 Room
類別 → `index.ts` 加一行 `gameServer.define(...)`。

## 本地開發

需求:Node.js ≥ 20。

```bash
npm install     # 或 pnpm install
npm run dev     # ws://localhost:2567,存檔自動重啟
```

驗活:開 `http://localhost:2567/health` 應回 `{"ok":true}`。

## 部署到 Railway

1. 把本 repo 推上 GitHub。
2. railway.app 以 GitHub 登入(Hobby 約 $5/月)→ **New Project → Deploy from
   GitHub repo** → 選本 repo。
3. Service → Settings:
   - Build Command:`npm install`
   - Start Command:`npm start`
   (Root Directory 留空;`PORT` 由 Railway 自動注入,程式已讀取)
4. Settings → Networking → **Generate Domain**,取得
   `https://xxx.up.railway.app`。
5. 驗證 `https://xxx.up.railway.app/health` 回 `{"ok":true}`,
   Deploy log 出現 `server listening`。

**WebSocket 端點 = 把 https 換成 wss:`wss://xxx.up.railway.app`。**
把這個值填進遊戲端部署的 `config/generalConfiguration.json` → `serverUrl`。

日常更新:git push 即自動重新部署。

## 運維備忘

- 對戰中意外斷線有 15 秒重連寬限(`allowReconnection`),逾時判對手獲勝。
- 空房自動回收;未滿的公開房會出現在客戶端大廳(`getAvailableRooms`)。
- 單一實例可撐數百同時房間;**不要**貿然開多實例——多台之間房間不互通,
  需要 Redis(如 Upstash)做跨機配對,玩家量上來再處理。
- 房間事件(join / ready / countdown start)都有 console log,
  在 Railway 的 Deployments → Logs 可直接觀察。
