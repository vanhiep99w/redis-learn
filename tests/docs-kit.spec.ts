import { test, expect, type Locator } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function generatedDocs(dir = 'content/docs'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? generatedDocs(path) : path.endsWith('.md') ? [path] : [];
  });
}

async function renderedFontSize(label: Locator): Promise<number> {
  return label.evaluate((element) => {
    const matrix = (element as SVGGraphicsElement).getScreenCTM();
    return matrix ? parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.a, matrix.b) : 0;
  });
}

test('mọi fence được render sẵn trong static export', () => {
  let diagrams = 0;
  const components = { d2: 'd2-diagram', 'terminal-session': 'terminal-session', 'code-diff': 'code-diff', 'code-walkthrough': 'code-walkthrough', 'span-waterfall': 'span-waterfall' };
  for (const path of generatedDocs()) {
    const markdown = readFileSync(path, 'utf8');
    const html = readFileSync(path.replace('content/docs/', 'dist/').replace(/\.md$/, '/index.html'), 'utf8');
    expect(markdown, path).not.toMatch(/^\s*(?:```|~~~)(?:mermaid|diagram)\b/m);
    expect(markdown, path).not.toContain('## Mục lục');
    for (const [fence, component] of Object.entries(components)) {
      const count = [...markdown.matchAll(new RegExp('^```' + fence + '(?: |\\n)', 'gm'))].length;
      const rendered = [...html.matchAll(new RegExp('<figure class="' + component + '[ "]', 'g'))].length;
      expect(rendered, `${path}: ${fence}`).toBeGreaterThanOrEqual(count);
      if (fence === 'd2') diagrams += count;
    }
    // Icons are embedded from the allowlisted local assets, not fetched by readers.
    expect(html, path).not.toMatch(/<image[^>]+(?:href|xlink:href)="https?:/);
  }
  expect(diagrams).toBeGreaterThanOrEqual(267);
});

test.beforeEach(async ({ page }) => {
  // Fail the test on hydration/render errors, not unrelated font-host requests.
  page.on('pageerror', (error) => { throw error; });
});

test('D2: zoom, SVG download, expand và chuyển theme', async ({ page }) => {
  await page.goto('/fundamentals/redis-overview/');
  const diagram = page.locator('.d2-interactive').first();
  await expect(diagram.locator('.d2-diagram-light')).toBeVisible();
  const labels = (await diagram.locator('.d2-diagram-light text').allTextContents()).join(' ');
  expect(labels).toContain('Redis Server');
  expect(labels).not.toContain('\\n');
  expect(labels).not.toContain('"Redis Server');
  await expect(diagram.locator('.d2-viewer')).toBeVisible();
  await expect(diagram.getByRole('button', { name: 'Fit', exact: true })).toBeVisible();
  const before = await diagram.locator('.d2-zoom-content').getAttribute('style');
  await diagram.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(diagram.locator('.d2-zoom-content')).not.toHaveAttribute('style', before!);
  const download = page.waitForEvent('download');
  await diagram.locator('.d2-source-menu > summary').click();
  await diagram.getByRole('button', { name: 'Download SVG', exact: true }).click();
  await diagram.locator('.d2-source-menu > summary').click();
  expect((await download).suggestedFilename()).toMatch(/\.svg$/);
  await diagram.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(diagram.locator('.d2-diagram-dark')).toBeVisible();
  await expect(diagram.locator('.d2-diagram-light')).toBeHidden();
});

test('RDB: cấu trúc dump.rdb là SVG và các trường theo thứ tự file', async ({ page }) => {
  await page.goto('/persistence/rdb/');
  const diagram = page.locator('.d2-interactive').filter({ hasText: 'Cấu trúc logic của file dump.rdb' });
  const light = diagram.locator('.d2-diagram-light');
  await expect(light.locator('svg').first()).toBeVisible();
  const fields = ['Magic string', 'RDB version', 'AUX fields', 'SELECTDB 0', 'RESIZEDB', 'Lặp các key/value', 'SELECTDB tiếp theo', 'EOF', 'CRC64'];
  const positions = await light.evaluate((element, labels) => labels.map((label) => {
    const text = [...element.querySelectorAll('text')].find((node) => node.textContent?.includes(label));
    return text ? text.getBoundingClientRect().top : -1;
  }), fields);
  expect(positions.every((top) => top >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const text = (await light.locator('text').allTextContents()).join(' ');
  expect(text).toContain('TTL tuyệt đối');
  expect(text).not.toMatch(/[┌┐└┘│]/);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(diagram.locator('.d2-diagram-dark')).toBeVisible();
});

test('Request coalescing: luồng Dagre giữ đủ nhánh và đi từ trên xuống', async ({ page }) => {
  await page.goto('/patterns/request-coalescing/');
  const diagram = page.locator('.d2-interactive').filter({ hasText: 'Kết hợp cache, local singleflight và fleet lease' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    const svg = diagram.locator(`.d2-diagram-${theme} svg`).first();
    await expect(svg).toBeVisible();
    expect(await svg.locator('text').allTextContents()).toEqual(expect.arrayContaining([
      'GET cache', 'Hit?', 'Trả kết quả', 'Tham gia local singleflight',
      'GET cache lần nữa', 'Vẫn miss?', 'Thử acquire Redis lease', 'Thắng lease?',
      'GET cache lại', 'Fetch origin', 'Publish khi còn ownership',
      'Chờ ngắn có jitter rồi GET cache', 'Có dữ liệu?', 'Còn deadline?',
      'Stale hợp lệ hoặc lỗi có kiểm soát', 'Có', 'Không', 'Chưa', 'Hết deadline',
    ]));
    // The main path must progress downward, not double back as it did in TALA.
    const positions = await svg.evaluate((element, labels) => labels.map((label) => {
      const text = [...element.querySelectorAll('text')].find((node) => node.textContent === label);
      return text ? text.getBoundingClientRect().top : -1;
    }), ['GET cache', 'Hit?', 'Tham gia local singleflight', 'GET cache lần nữa',
      'Thử acquire Redis lease', 'Thắng lease?', 'GET cache lại', 'Fetch origin',
      'Publish khi còn ownership', 'Trả kết quả']);
    expect(positions.every((top) => top >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }
});

test('Request coalescing: chữ dễ đọc ở desktop/mobile kể cả sau Fit', async ({ page }) => {
  for (const width of [1669, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/patterns/request-coalescing/');
    const flow = page.locator('.d2-readable-flow');
    await expect(flow.locator('.d2-interactive')).toHaveCount(1);
    await expect(flow.locator('.d2-viewer')).toBeVisible();
    const label = flow.locator('.d2-diagram-light text').filter({ hasText: /^GET cache$/ });
    await expect.poll(() => renderedFontSize(label)).toBeGreaterThanOrEqual(15);
    // The entry must be on screen initially, not hidden in the wide SVG's middle.
    await expect.poll(() => label.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    })).toBe(true);
    await flow.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect.poll(() => renderedFontSize(label)).toBeGreaterThanOrEqual(15);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    if (width === 390) {
      expect(await flow.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    }
  }
});

test('D2 steps: resharding chuyển qua từng trạng thái', async ({ page }) => {
  await page.goto('/replication-ha/cluster/');
  const diagram = page.locator('.d2-interactive').filter({ hasText: 'Chuyển slot 9842 từ A sang D' });
  await expect(diagram.locator('.d2-viewer')).toBeVisible();
  await expect(diagram.locator('.d2-step-count')).toHaveText('1 / 3');
  await diagram.getByRole('button', { name: /Next/ }).click();
  await expect(diagram.locator('.d2-step-count')).toHaveText('2 / 3');
  await diagram.getByRole('button', { name: /Next/ }).click();
  await expect(diagram.locator('.d2-step-count')).toHaveText('3 / 3');
  await expect(diagram.getByRole('button', { name: /Next/ })).toBeDisabled();
});

test('Terminal Session copy đúng command, không kèm prompt/output', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/fundamentals/redis-overview/');
  const terminal = page.locator('.terminal-session');
  await expect(terminal).toContainText('Ghi và đọc một String');
  await terminal.getByRole('button', { name: 'Sao chép lệnh bước 1', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('SET user:1:name "Hiep"');
});

test('Code Diff và Code Walkthrough có tương tác', async ({ page }) => {
  await page.goto('/patterns/distributed-lock/');
  const diff = page.locator('.code-diff');
  await expect(diff).toHaveAttribute('data-view', 'split');
  await diff.getByRole('button', { name: 'Inline', exact: true }).click();
  await expect(diff).toHaveAttribute('data-view', 'inline');
  await page.goto('/advanced/lua-scripting/');
  const walkthrough = page.locator('.code-walkthrough');
  await walkthrough.getByRole('button', { name: 'Bước sau', exact: true }).click();
  await expect(walkthrough.getByLabel('Chọn bước')).toHaveValue('1');
  await expect(walkthrough.locator('.code-walkthrough-line[data-highlighted]')).toHaveCount(5);
});

test('Span Waterfall phân biệt thời gian call và execute', async ({ page }) => {
  await page.goto('/performance/slow-log-latency/');
  const waterfall = page.locator('.span-waterfall');
  await expect(waterfall).toContainText('Trace minh họa');
  await waterfall.locator('[data-span="execute"] a').click();
  await expect(waterfall.locator('[data-detail="execute"]')).toHaveAttribute('open', '');
  await expect(waterfall.locator('[data-detail="execute"]')).toContainText('2000');
});

test('mobile: diagram cuộn trong khung, không làm tràn trang', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/fundamentals/redis-overview/', '/replication-ha/cluster/', '/patterns/caching-patterns/', '/patterns/request-coalescing/', '/advanced/lua-scripting/', '/persistence/rdb/', '/persistence/aof/', '/data-structures/strings/', '/data-structures/lists/', '/data-structures/sorted-sets/', '/data-structures/streams/']) {
    await page.goto(path);
    await expect(page.locator('.d2-diagram').first()).toBeVisible();
    // The auto-loaded viewer fits after hydration/ResizeObserver has settled.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { message: path }).toBeLessThanOrEqual(391);
  }
});

test('không JavaScript vẫn đọc SVG, source, các bước và transcript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/replication-ha/cluster/');
  const diagram = page.locator('.d2-interactive').filter({ hasText: 'Chuyển slot 9842 từ A sang D' });
  await expect(diagram.locator('.d2-diagram-light').first()).toBeVisible();
  await diagram.locator('.d2-board-fallback > summary').click();
  await expect(diagram.locator('.d2-board-fallback .d2-diagram')).toHaveCount(2);
  await diagram.locator('.d2-source-menu > summary').click();
  await expect(diagram.locator('.d2-source-menu pre')).toContainText('MIGRATING');
  await page.goto('/fundamentals/redis-overview/');
  await expect(page.locator('.terminal-session')).toContainText('SET user:1:name "Hiep"');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/patterns/request-coalescing/');
  const flow = page.locator('.d2-readable-flow');
  const label = flow.locator('.d2-diagram-light text').filter({ hasText: /^GET cache$/ });
  expect(await renderedFontSize(label)).toBeGreaterThanOrEqual(15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await flow.locator('.d2-source-menu > summary').click();
  await expect(flow.locator('.d2-source-menu pre')).toContainText('deadline -> fallback: Hết deadline');
  await context.close();
});
