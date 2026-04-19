# Graal Hunt — WebSocket Server

Authoritative game server for Graal Hunt multiplayer.

## Deploy to Railway (free tier, permanent uptime)

### 1. Создай аккаунт на Railway
https://railway.app — войди через GitHub

### 2. Загрузи код

**Вариант A — через GitHub (рекомендуется):**
1. Создай новый репозиторий на https://github.com/new (можно приватный)
2. Загрузи файлы из этой папки (`server.js`, `package.json`, `railway.toml`, `.gitignore`)
3. На Railway: New Project → Deploy from GitHub repo → выбери репозиторий

**Вариант B — через Railway CLI:**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 3. Получи URL
После деплоя Railway выдаст URL вида:
```
graal-hunt-server.up.railway.app
```
Открой Settings → Networking → Generate Domain (если не появился автоматически).

### 4. Обнови клиент (game.js)
В файле `game.js` найди строку:
```js
const RAILWAY_URL = '__RAILWAY_URL__';
```
Замени на:
```js
const RAILWAY_URL = 'wss://graal-hunt-server.up.railway.app';
```
(используй свой реальный Railway URL, не этот пример)

### 5. Передеплой фронтенд
После изменения `game.js` — заново задеплой сайт через Perplexity Computer.

---

## Локальный запуск

```bash
npm install
npm start
# Server on ws://localhost:8765
```

## Health check
```
GET /health  →  "ok"
GET /rooms   →  список активных комнат (JSON)
```
