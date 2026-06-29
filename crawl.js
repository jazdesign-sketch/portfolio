// crawl.js — Зеркалирует сайт на Framer в статическую папку ./site для GitHub Pages.
//
// Установка и запуск:
//   npm install
//   npx playwright install chromium
//   node crawl.js
//
// Результат — папка ./site, готовая к деплою в GitHub Pages.
// ВНИМАНИЕ: скрипт — рабочая отправная точка. Минифицированные JS-бандлы Framer
// иногда собирают URL-ы ассетов во время выполнения, поэтому отдельные ресурсы
// (чаще всего внутри CSS url() и srcset) могут потребовать ручной правки.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE = 'https://alexsjazportfolio.framer.website';
const OUT = path.resolve(__dirname, 'site');

// Маршруты сайта. Добавьте сюда любые страницы, которые найдёте на сайте.
const ROUTES = [
  '/',
  '/orders',
  '/ar_spatially',
  '/tap_topia',
  '/sleo',
  '/sl_venture',
  '/nd',
  '/nxmedia',
];

// Хосты, ассеты с которых нужно скачивать локально.
const ASSET_HOSTS = ['framer.website', 'framerusercontent.com', 'framer.com'];

// Реальные страницы сайта (для нормализации внутренних ссылок).
const SECTIONS = new Set(
  ROUTES.filter((r) => r !== '/').map((r) => r.replace(/^\/|\/$/g, ''))
);

// Перехватчик кликов: для внутренних ссылок на реальные страницы форсирует
// полную перезагрузку (минуя SPA-роутер Framer), чтобы URL и подсветка активной
// вкладки всегда были корректны. Оверлеи (img_big и т.п.) остаются на Framer.
const NAV_SCRIPT =
  '<script id="force-full-nav">' +
  '(function(){window.addEventListener("click",function(e){' +
  'if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;' +
  'var t=e.target;var a=(t&&t.closest)?t.closest("a[data-fullnav]"):null;' +
  'if(!a||!a.href)return;' +
  'e.preventDefault();e.stopImmediatePropagation();window.location.assign(a.href);' +
  '},true);})();' +
  '</script>';

// Внутренняя ссылка -> 'home' | имя секции | null (не страница: оверлей/ассет/внешняя).
function normalizeInternal(href) {
  if (!href) return null;
  if (href.includes('://') || /^(#|mailto:|tel:|data:|javascript:)/.test(href)) return null;
  if (href.includes('?') || href.includes('#')) return null;
  let s = href;
  while (s.startsWith('../')) s = s.slice(3);
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '') return 'home';
  return SECTIONS.has(s) ? s : null;
}

function canonicalHref(target, depth) {
  const base = depth === 0 ? './' : '../'.repeat(depth);
  return target === 'home' ? base : base + target + '/';
}

// Карта: удалённый URL -> локальный относительный путь.
const assetMap = new Map();

function assetLocalPath(urlStr) {
  const u = new URL(urlStr);
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index';
  // Раскладываем по хостам, чтобы избежать коллизий имён.
  return path.posix.join('assets', u.host, p);
}

function saveBuffer(localRel, buffer) {
  const full = path.join(OUT, localRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Перехватываем каждый ответ и сохраняем тело локально.
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!url.startsWith('http')) return;
      const u = new URL(url);
      if (!ASSET_HOSTS.some((h) => u.host.endsWith(h))) return;
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('text/html')) return; // HTML страниц сохраняем отдельно
      if (assetMap.has(url)) return;
      const local = assetLocalPath(url);
      assetMap.set(url, local);
      saveBuffer(local, await resp.body());
    } catch (e) {
      /* пропускаем сбойные ответы */
    }
  });

  for (const route of ROUTES) {
    const target = BASE + route;
    console.log('Краулю:', target);
    try {
      await page.goto(target, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000); // даём догрузиться анимациям/ленивым блокам
    } catch (e) {
      console.warn('  не удалось загрузить:', e.message);
      continue;
    }

    let html = await page.content();

    // Глубина вложенности страницы -> префикс ../ для относительных путей.
    const depth = route.replace(/^\/|\/$/g, '').split('/').filter(Boolean).length;
    const prefix = depth === 0 ? './' : '../'.repeat(depth);

    // Переписываем ссылки на ассеты -> локальные относительные пути.
    for (const [remote, local] of assetMap) {
      const rel = prefix + local;
      const noQuery = remote.split('?')[0];
      html = html.split(remote).join(rel);
      html = html.split(noQuery).join(rel);
    }

    // Переписываем абсолютные внутренние ссылки на относительные.
    html = html.split(BASE + '/').join(prefix);
    html = html.split(BASE).join(prefix);

    // Нормализуем ВСЕ внутренние ссылки на реальные страницы к корректным путям
    // (с учётом глубины) и помечаем их data-fullnav для полной навигации.
    html = html.replace(/(\s)href="([^"]*)"/g, (m, sp, href) => {
      const target = normalizeInternal(href);
      if (target === null) return m;
      return `${sp}data-fullnav="1" href="${canonicalHref(target, depth)}"`;
    });

    // Вшиваем перехватчик полной навигации.
    if (!html.includes('id="force-full-nav"')) {
      html = html.replace('</head>', NAV_SCRIPT + '</head>');
    }

    // Сохраняем: '/' -> index.html, '/orders' -> orders/index.html и т. д.
    const outRel = route === '/' ? 'index.html'
      : path.join(route.replace(/^\//, ''), 'index.html');
    const full = path.join(OUT, outRel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html, 'utf8');
  }

  await browser.close();
  console.log('Готово. Папка:', OUT);
  console.log('Скачано ассетов:', assetMap.size);
})();
