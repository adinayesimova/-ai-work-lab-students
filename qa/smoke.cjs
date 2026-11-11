'use strict';
// Browser-level smoke tests for the published student app.
// Run against the repository root served by a local static HTTP server on port 8765.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 45000 });
    await page.locator('.module-card').first().waitFor({ timeout: 15000 });
    const info = await page.evaluate(() => ({ total: total(), modules: Object.fromEntries(modules.map(m => [m.id, getTasks(m.id).length])) }));
    assert.equal(info.total, 100, 'student exercise count');
    assert.deepEqual(info.modules, { count: 12, boxes: 10, classify: 10, safety: 50, audio: 10, colour: 8 });
    console.log('Home and module counts OK:', info.modules);

    let rendered = 0;
    for (const [moduleId, taskCount] of Object.entries(info.modules)) {
      for (let index = 0; index < taskCount; index++) {
        const result = await page.evaluate(([id, i]) => {
          go(id, i);
          const task = getTasks(id)[i];
          return { title: task.title, header: document.querySelector('.panel-hd b')?.textContent,
            check: !!document.getElementById('checkBtn'), stage: !!document.getElementById('stage'),
            instruction: document.querySelector('#exerciseContent .quiz h2')?.textContent };
        }, [moduleId, index]);
        assert.equal(result.header, result.title, moduleId + ' task ' + index + ' title');
        assert.equal(result.check, true, moduleId + ' task ' + index + ' check button');
        assert.equal(result.stage, true, moduleId + ' task ' + index + ' display');
        assert.ok(result.instruction?.trim(), moduleId + ' task ' + index + ' instruction');
        rendered++;
      }
    }
    assert.equal(rendered, 100);
    console.log('All 100 exercise screens rendered without page errors.');

    // Real pointer interaction for object counting.
    await page.evaluate(() => go('count', 0));
    await page.locator('#countFigure').click({ position: { x: 40, y: 40 } });
    assert.equal(await page.locator('#numberAnswer').inputValue(), '1');
    await page.locator('#countUndo').click();
    assert.equal(await page.locator('#numberAnswer').inputValue(), '0');
    console.log('Counting marker and undo OK.');

    // Real pointer drag in Bounding Boxes and undo.
    await page.evaluate(() => go('boxes', 0));
    const drawing = page.locator('#stage svg');
    const bounds = await drawing.boundingBox();
    assert.ok(bounds && bounds.width > 100, 'bounding box stage visible');
    const x = bounds.x + Math.min(35, bounds.width * .1);
    const y = bounds.y + Math.min(35, bounds.height * .1);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 55, y + 55, { steps: 4 });
    await page.mouse.up();
    assert.equal((await page.locator('#numRects').innerText()).trim(), '1');
    await page.locator('#undoRect').click();
    assert.equal((await page.locator('#numRects').innerText()).trim(), '0');
    const ordering = await page.evaluate(() => {
      const t = getTasks('boxes').find(x => x.boxOrder);
      const good = t.boxOrder.map(index => ({ ...t.targets[index] }));
      const wrong = [...good]; [wrong[0], wrong[1]] = [wrong[1], wrong[0]];
      return { correct: boxesScore(t.targets, good, true, t.boxOrder).complete,
        reversed: boxesScore(t.targets, wrong, true, t.boxOrder).complete };
    });
    assert.equal(ordering.correct, true);
    assert.equal(ordering.reversed, false);
    console.log('Bounding-box drawing, undo and order validation OK.');

    // Explicitly test one invalid and one valid timestamp submission.
    const audioIndex = await page.evaluate(() => getTasks('audio').findIndex(t => t.id === 'custom-1793884339947-fy05'));
    assert.ok(audioIndex >= 0);
    await page.evaluate(index => go('audio', index), audioIndex);
    assert.equal(await page.locator('[id^=audioEntity]').count(), 6);
    for (let i = 0; i < 6; i++) await page.locator('#audioEntity' + i).fill('0');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'), /bad/);
    const pointAnswers = ['10', '12', '18', '21', '25', '29'];
    for (let i = 0; i < 6; i++) await page.locator('#audioEntity' + i).fill(pointAnswers[i]);
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'), /good/);
    console.log('Timestamp input: wrong rejected, exact accepted.');

    // Speaker labels must be present when required.
    const speakerIndex = await page.evaluate(() => getTasks('audio').findIndex(t => t.id === 'custom-1793212548486-adx3'));
    await page.evaluate(index => go('audio', index), speakerIndex);
    const expected = await page.evaluate(() => getTasks('audio')[taskIndex].transcript);
    await page.locator('#transcriptAnswer').fill(expected.replace(/Голос [0-9]+:/g, ''));
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'), /bad/);
    await page.locator('#transcriptAnswer').fill(expected);
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'), /good/);
    console.log('Speaker omission rejected; labeled transcript accepted.');

    // Progress survives a reload in the same browser.
    const savedBefore = await page.evaluate(() => completed());
    assert.ok(savedBefore >= 2, 'at least two tasks completed');
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => completed()), savedBefore);
    const crisis = await page.evaluate(() => {
      const t = getTasks('safety').find(t => t.id === 'custom-1793113351872-mggs');
      return { answer: t.answer, containsFakePhone: t.aiResponse.includes('777-777') };
    });
    assert.equal(crisis.answer, 'Safe');
    assert.equal(crisis.containsFakePhone, false);
    console.log('Progress persistence and corrected AI Safety case OK.');

    // Basic mobile-viewport coverage.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const moduleId of Object.keys(info.modules)) {
      await page.evaluate(id => go(id, 0), moduleId);
      assert.equal(await page.locator('#checkBtn').count(), 1, moduleId + ' mobile check button');
    }
    const width = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(width.document <= width.viewport + 5, 'mobile horizontal overflow: ' + JSON.stringify(width));
    console.log('Mobile layout 390px OK.', width);

    assert.deepEqual(errors, [], 'browser console / page errors');
    console.log('PASS: 100 exercise screens, interactions, validation, localStorage, mobile viewport and no JavaScript errors.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('FAIL:', error.stack || error); process.exitCode = 1; });
