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
- `api/`, `server/`, `shared/` — прод Agent API для Vercel (функции + Upstash REST-клиент + общие хелперы)

## Agent API

HTTP API для ИИ-агентов: live чтение/запись стейта, JSON-схема, warnings/analysis/journal, пресеты. Работает в двух режимах: dev — Vite-middleware на `npm run dev` (:5180, SSE); прод — функции Vercel `api/*.ts` + Upstash Redis (поллинг версий вместо SSE). Описание с curl-примерами — [API.md](./API.md).

## Промт для агента

Готовый мастер-промт подгонки blur-затухания (полный порядок действий: доки → сервер → материал → старт → warnings → цикл `analysis?target` по residuals/verdict → сдача Sass) — [PROMPT.md](./PROMPT.md). Скопировать агенту целиком, приложить материалы (Figma-нода или два кадра: base без эффекта + ref с эффектом). Живущей в агентской среде подсказкой служит и скилл `gradient-lab` (~/.claude/skills/gradient-lab) — он подхватывается по триггерам «fade / маска на blur / затухание» автоматически; алгоритм подгонки v2 агент получает из `GET /api/methodology`.

## Deploy

`npm run build` → статика в `dist/` + функции `api/` → деплой на Vercel (framework Vite, стор Upstash — чеклист в [API.md](./API.md#прод-vercel), раздел «Setup»). На любой другой static-хостинг собирается без API — приложение полностью работает локально.
