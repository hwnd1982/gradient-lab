# Gradient Lab

Песочница градиентов и масок: блок на стейдже, редактор градиентов (linear/radial, стопы вне 0..100, blend-режимы), маски, backdrop-blur с подложкой и своей маской, текст с градиентом, анимация маски (from → to), сравнение с макетом (opacity / difference / split, пипетка, автоподбор стопов по референсу), пресеты из реальных приёмов onsport, свои пресеты и share-ссылки. База блока — цвет, градиент (например, fade в цвет страницы) или картинка.

## Стек

Vite 8 · React 19 · TypeScript (strict) · Tailwind CSS v4 · zustand · zod v4 · react-colorful

## Запуск

```bash
npm install
npm run dev    # http://localhost:5180 (+ dev Agent API, см. API.md)
npm run build  # dist/ — статика
npm run lint
```

## Структура

- `src/schema.ts` — zod-схемы состояний, из них выводятся все типы (`src/types.ts`)
- `src/store.ts` — zustand-стор: стейт блока, undo-история, UI-флаги (compare, anim, dev-API)
- `src/cssgen.ts` — генерация CSS/Sass для копирования и стилей превью
- `src/targets.ts` — адресация градиентов (слой / маска / blur-маска / clipText / anim)
- `src/components/` — Stage, Inspector, GradientEditor, CompareSection, AnimSection, PresetDrawer, CodePanel
- `src/presets/` — встроенные приёмы onsport и localStorage-хранилище пользовательских
- `src/lib/` — color, drag, autofit, imageCache, shareUrl (base64url в hash), agentTransport (клиент Agent API: dev-middleware / прод-поллинг)
- `vite-plugins/agent-api.ts` — dev Agent API (Vite-middleware + SSE)
- `server/`, `shared/` — прод Agent API для Vercel (функции + Upstash REST-клиент + общие хелперы); `api/` — генерируемые самодостаточные бандлы из `server/functions` (сборка `scripts/build-functions.mjs`); источников в `api/` нет

## Agent API

HTTP API для ИИ-агентов: live чтение/запись стейта, JSON-схема, warnings/analysis/journal, пресеты. Работает в двух режимах: dev — Vite-middleware на `npm run dev` (:5180, SSE); прод — функции Vercel `server/functions/*.ts` (бандлятся в `api/`) + Upstash Redis (поллинг версий вместо SSE; мульти-сессии: заголовок `X-Lab-Session`, список `GET /api/sessions`, join-ссылки `?join=<id>` — детали в API.md, раздел «Сессии»). Описание с curl-примерами — [API.md](./API.md).

## Промт для агента

Готовый мастер-промт подгонки blur-затухания (полный порядок действий: доки → сервер → материал → старт → warnings → цикл `analysis?target` по residuals/verdict → сдача Sass) — [PROMPT.md](./PROMPT.md). Скопировать агенту целиком, приложить материалы (Figma-нода или два кадра: base без эффекта + ref с эффектом). Живущей в агентской среде подсказкой служит и скилл `gradient-lab` (~/.claude/skills/gradient-lab) — он подхватывается по триггерам «fade / маска на blur / затухание» автоматически; алгоритм подгонки v2 агент получает из `GET /api/methodology`.

## Сессии и совместная работа

Каждая вкладка браузера живёт в своей **сессии** (слот стейта на сервере) — «мой агент — моё окно»: агенты и люди не перетирают доски друг друга. Селектор в хедере: **«+ Создать сессию»** (id генерируется автоматически), клик по живой сессии из списка — открыть чужую, **«Копировать ссылку (?join=)»** — ссылка вида `…/?join=<id>`, открыв её, коллега или агент попадает в эту сессию. Без заголовка `X-Lab-Session` (и для вкладки без своей сессии) работает общая доска `default`. Пресеты — общая библиотека; журнал и анализ — на сессию. Бриф для агента — кнопка **«Инструкция агенту»** в поповере (копирует адрес + сессию + цикл подгонки) или [PROMPT.md](./PROMPT.md).

## Deploy

`npm run build` → статика в `dist/` + самодостаточные бандлы функций в `api/` (генерируются из `server/functions`, Vercel сканирует `api/` после buildCommand) → деплой на Vercel (framework Vite, стор Upstash — чеклист в [API.md](./API.md#прод-vercel), раздел «Setup»). На любой другой static-хостинг собирается без API — приложение полностью работает локально.
