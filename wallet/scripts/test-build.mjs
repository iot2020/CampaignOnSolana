// 构建产物（dist/）的回归测试。
// 运行：npm test（需要先 npm run build；dist/ 不存在时整组跳过，不算失败）
//
// 为什么要有这个：public/popup.html 是 vite 原样复制过去的，它不会像真正的
// HTML 入口那样自动注入 <link rel="stylesheet">，而 dev server 又是靠 JS 注入
// 样式的 —— 于是「npm run dev 看着一切正常，装进扩展却完全没有样式」这种问题
// 能悄悄存在很久：CSS 明明打包出来了，只是没有任何东西去加载它。
// 这里把「产物之间必须对得上」的几条硬约束固定下来。
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const htmlPath = join(DIST, 'popup.html');
const assetsDir = join(DIST, 'assets');

if (!existsSync(htmlPath)) {
  console.log('  skip dist/ 还没构建，先跑 npm run build');
  console.log('\n0/0 passed（跳过）');
  process.exit(0);
}

const html = readFileSync(htmlPath, 'utf8');
const cssFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter(f => f.endsWith('.css'))
  : [];

test('vite 把 popup.css 打包出来了', () => {
  assert.ok(cssFiles.includes('popup.css'),
    `dist/assets/ 下没有 popup.css（只有 ${cssFiles.join(', ') || '空'}）。` +
    'popup.jsx 里的 import "./popup.css" 是不是被删了？');
});

test('dist/popup.html 用 <link> 加载了每一个 CSS 产物', () => {
  for (const css of cssFiles) {
    assert.ok(html.includes(`/assets/${css}`),
      `popup.html 里没有引用 /assets/${css}，界面会完全没有样式。` +
      'public/popup.html 需要手写 <link rel="stylesheet">，vite 不会替你注入。');
  }
});

test('<link> / <script> 指向的文件都真实存在于 dist/', () => {
  const refs = [...html.matchAll(/(?:href|src)="\.?\/?(assets\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 2,
    `popup.html 里只找到 ${refs.length} 个资源引用，至少应该有 popup.js 和 popup.css`);
  for (const ref of refs) {
    assert.ok(existsSync(join(DIST, ref)), `popup.html 引用的 ${ref} 在 dist/ 里不存在`);
  }
});

test('manifest 指向侧边栏，而不是会被销毁的 toolbar popup', () => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  const panelPath = manifest.side_panel?.default_path;
  assert.ok(panelPath, 'manifest 缺少 side_panel.default_path');
  assert.ok(existsSync(join(DIST, panelPath)), `side_panel.default_path=${panelPath} 在 dist/ 里不存在`);
  assert.equal(manifest.action?.default_popup, undefined,
    'action.default_popup 必须删掉：只要它还在，点图标就仍然弹旧 popup，不会开侧边栏');
  assert.ok(manifest.permissions?.includes('sidePanel'), 'permissions 里缺少 sidePanel');
});

// ------------------------------------------------------------------------ 输出

let failed = 0;
for (const { name, ok, error } of results) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message || error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
