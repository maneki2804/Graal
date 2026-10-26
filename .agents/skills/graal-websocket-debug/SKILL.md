---
name: graal-websocket-debug
description: Reproduce Graal Hunt WebSocket, lobby, class picker or combat connection failures using a local server and browser tests without touching Railway.
---

# Graal WebSocket Debug

1. Прочитать `AGENTS.md`, `playwright.config.mjs` и `tests/e2e/local-game.spec.mjs`.
2. Проследить `connect`, `send`, `handleMessage` в `public/game.js` и `wss.on`, `Room.handleMessage` в `server.js`. Проверить `ws.readyState`, команду, комнату и текущую фазу.
3. Учитывать фиксированный `RAILWAY_URL`: обычный `npm start` раздаёт клиент локально, но клиентский WS указывает на Railway. Не запускать ручные сетевые сценарии без изоляции и не менять production URL ради теста.
4. Использовать `npm run test:e2e` для реального локального HTTP/WS сервера на 8877. `context.addInitScript` перенаправляет WS на loopback только в тестовом браузере; контекст блокирует внешние HTTP-запросы. Не удалять изоляцию и `reuseExistingServer: false`.
5. Для повторного открытия выбора классов проверить отсутствие дублирующихся слушателей. Для режима боя проверить `create_battle_test`, `room_created`, `game_started`, `state` и уведомления хода. Для лобби воспроизвести два клиента и последовательный выбор классов.
6. Проверять ошибки `pageerror`, сообщения в консоли и содержимое state; не скрывать ошибку обработчиком в тесте. Не записывать секреты или пользовательские данные в логи.
7. При ошибке открыть `playwright-report/` и `test-results/` (trace/screenshot). Зафиксировать воспроизведение и минимальную причину; после исправления повторить затронутый сценарий и `npm test`.
