---
name: graal-game-rules
description: Inspect and test Graal Hunt rules when changing movement, map generation, classes, combat, items, turns or victory conditions.
---

# Graal Game Rules

1. Прочитать `AGENTS.md` и актуальный `server.js`. Найти `GameEngine`, `Hex`, `generateMap`, `CLASS_DEFS`, `ITEM_DEFS` через `rg`; не доверять именам функций из старого README.
2. Проследить входящее сообщение в `Room.handleMessage`, метод движка и `serialize()`. Проверить фазу, активную команду и ожидаемые изменения состояния.
3. Для движения изучить `moveSquad` и `getValidSquadMoves`: перемещается весь отряд; лодка/верёвка любой позиции команды разрешает воду/горы. Для ходов изучить `_advancePlayer`, `_advanceTeam`, `tick`.
4. Для боя изучить `_buildCombat`, `confirmArrange`, `combatAction`, `_grantXP` и соответствующие проверки фазы. Сверить точные имена в текущем коде.
5. Добавить регрессию в `tests/unit/game-engine.test.mjs` или соседний `.test.mjs`. Импортировать CommonJS-экспорт `server.js` через `createRequire`. Использовать фиксированный seed; контролировать клетки/предметы в fixture, чтобы случайные события не влияли на ожидаемый результат.
6. Проверять результат и изменение состояния, включая отклонение недопустимого действия. Не переписывать механику и не копировать алгоритм в тест.
7. Запустить `npm test`; при затрагивании протокола или отображения также `npm run test:e2e`. Если поведение расходится с ожиданием, зафиксировать расхождение и согласовать изменение правила, не исправлять баланс по собственной инициативе.
