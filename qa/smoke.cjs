'use strict';
// Browser-level smoke tests for the published student app.
// Run against the repository root served by a local static HTTP server on port 8765.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 45000 });
    await page.locator('.module-card').first().waitFor({ timeout: 15000 });
    // Direct links to individual tasks must load the correct exercise.
    await page.goto('http://127.0.0.1:8765/?task=custom-1792594838730-7lvf', { waitUntil: 'load', timeout: 45000 });
    const linkedTask = await page.evaluate(() => ({
      id: getTasks(section)[taskIndex]?.id,
      section,
      title: document.querySelector('.panel-hd b')?.textContent
    }));
    assert.deepEqual(linkedTask, {
      id: 'custom-1792594838730-7lvf', section: 'boxes', title: 'Вещи на вешалке'
    });
    console.log('Direct link opens six-shoe task OK.');
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 45000 });
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

    // Every embedded audio must actually decode and begin playback in Chrome.
    for (let i = 0; i < info.modules.audio; i++) {
      await page.evaluate(index => go('audio', index), i);
      const outcome = await page.locator('#transcriptAudio').evaluate(async audio => {
        try {
          await Promise.race([
            audio.play(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Audio playback timeout')), 6000))
          ]);
          await new Promise(resolve => setTimeout(resolve, 120));
          const result = { duration: audio.duration, error: audio.error?.message || null, paused: audio.paused };
          audio.pause();
          return result;
        } catch (error) {
          return { duration: audio.duration, error: String(error) };
        }
      });
      assert.ok(!outcome.error && outcome.paused === false && Number.isFinite(outcome.duration) && outcome.duration > 0,
        'audio ' + (i + 1) + ' playback failed: ' + JSON.stringify(outcome));
    }
    console.log('All 10 embedded audio files decoded and started playback in Chrome.');

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
      const t = getTasks('boxes').find(x => x.targets?.length >= 2 && x.requireLabels);
      if (!t) return { correct: false, reversed: false };
      const good = t.targets.map(r => ({ ...r }));
      return {
        correct: boxesScore(t.targets, good, true, null, t.id).complete,
        reversed: boxesScore(t.targets, [...good].reverse(), true, null, t.id).complete
      };
    });
    assert.equal(ordering.correct, true, 'matching geometry and labels pass');
    assert.equal(ordering.reversed, true, 'box creation order must not matter');
    console.log('Bounding-box drawing, undo and order independence OK.');

    // Regression: the blue shoes are partially hidden behind a SINGLE pair of black boots.
    const shoesTest = await page.evaluate(() => {
      const task = getTasks('boxes').find(x => x.id === 'custom-1792594838730-7lvf');
      const reference = task.targets.map(t => ({ ...t, label: 'туфли' }));
      const user = reference.map(r => ({ ...r }));
      user[4] = { x: 427, y: 335, w: 12, h: 10, label: 'туфли' }; // tiny blue fragment
      user[5] = { x: 440, y: 335, w: 57, h: 57, label: 'туфли' }; // both black boots
      const grade = boxes => boxesScore(task.targets, boxes, true, null, task.id);
      const badName = user.map(r => ({ ...r })); badName[4].label = 'сумка';
      const duplicate = user.map(r => ({ ...r })); duplicate[4] = { ...duplicate[5] };
      const twoSeparateBlackBoots = [...user.slice(0, 4),
        { x: 439, y: 338, w: 33, h: 56, label: 'туфли' },
        { x: 468, y: 334, w: 35, h: 60, label: 'туфли' }];
      const hugeBlueBox = user.map(r => ({ ...r })); hugeBlueBox[4] = { x: 390, y: 320, w: 110, h: 75, label: 'туфли' };
      const displacedBlueBox = user.map(r => ({ ...r })); displacedBlueBox[4] = { x: 520, y: 340, w: 12, h: 10, label: 'туфли' };
      return {
        count: task.targets.length,
        exact: grade(reference).complete,
        tinyBlue: grade(user).complete,
        tinyBlueGood: grade(user).good,
        reversed: grade([...user].reverse()).complete,
        missing: grade(user.slice(0, 5)).complete,
        extra: grade([...user, { x: 620, y: 30, w: 20, h: 20, label: 'туфли' }]).complete,
        duplicated: grade(duplicate).complete,
        twoBlackBoots: grade(twoSeparateBlackBoots).complete,
        hugeBlueBox: grade(hugeBlueBox).complete,
        displacedBlueBox: grade(displacedBlueBox).complete,
        wrongLabel: grade(badName).complete
      };
    });
    assert.deepEqual(shoesTest,
      { count: 6, exact: true, tinyBlue: true, tinyBlueGood: 6, reversed: true,
        missing: false, extra: false, duplicated: false, twoBlackBoots: false,
        hugeBlueBox: false, displacedBlueBox: false, wrongLabel: false });
    console.log('Occluded blue pair and single black-boot pair regression OK.');

    // Real small pointer drag must be accepted in this task.
    const shoeIndex = await page.evaluate(() =>
      getTasks('boxes').findIndex(t => t.id === 'custom-1792594838730-7lvf'));
    await page.evaluate(index => go('boxes', index), shoeIndex);
    const shoeStage = await page.locator('#stage svg').boundingBox();
    assert.ok(shoeStage, 'six-shoe SVG is visible');
    const p1 = { x: shoeStage.x + shoeStage.width * 427 / 760,
                 y: shoeStage.y + shoeStage.height * 335 / 430 };
    const p2 = { x: shoeStage.x + shoeStage.width * 439 / 760,
                 y: shoeStage.y + shoeStage.height * 345 / 430 };
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p2.x, p2.y, { steps: 6 });
    await page.mouse.up();
    assert.equal((await page.locator('#numRects').innerText()).trim(), '1');
    console.log('Small visible-fragment pointer drawing OK.');

    // Engine diagram: 11 individually labeled parts, including rocker arm #11.
    // Source contains 'Выпускной клапан' at the left inlet; the student override corrects it.
    const engineTest = await page.evaluate(() => {
      const t = getTasks('boxes').find(x => x.id === 'custom-1794174299526-wa6s');
      const refs = t.targets.map(r => ({ ...r }));
      const tight = refs.map(r => ({
        x: r.x + r.w*.18, y: r.y + r.h*.23,
        w: r.w*.64, h: r.h*.54, label: r.label
      }));
      const score = boxes => boxesScore(t.targets, boxes, true, null, t.id);
      const wrongValve = tight.map(r => ({...r}));
      wrongValve[3].label='Выпускной клапан';
      const wrongPlace=tight.map(r=>({...r}));
      wrongPlace[3].x+=180;
      const tiny=tight.map(r=>({...r}));
      tiny[4].w=7; tiny[4].h=6;
      const duplicate=tight.map(r=>({...r}));
      duplicate[10]={...duplicate[9]};
      const aliases=tight.map(r=>({...r}));
      aliases[5].label='распредвал';
      const blank=tight.map(r=>({...r}));
      blank[0].label='';
      return {
        count:t.targets.length,
        labels:t.targets.map(r=>r.label),
        exact:score(refs).complete,
        tight:score(tight).complete,
        reversed:score([...tight].reverse()).complete,
        alias:score(aliases).complete,
        missed:score(tight.slice(1)).complete,
        extra:score([...tight,{x:700,y:400,w:22,h:15,label:'Поддон'}]).complete,
        swappedValve:score(wrongValve).complete,
        wrongPlace:score(wrongPlace).complete,
        tooSmall:score(tiny).complete,
        duplicated:score(duplicate).complete,
        blankLabel:score(blank).complete
      };
    });
    assert.equal(engineTest.count, 11);
    assert.deepEqual(engineTest.labels, [
      'Поддон','Шатун','Цилиндр','Впускной клапан','Свеча зажигания',
      'Распределительный вал','Выпускной клапан','Поршень',
      'Поршневые кольца','Коленчатый вал','Коромысло'
    ]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(engineTest).filter(([key])=>!['count','labels'].includes(key))),
      {exact:true,tight:true,reversed:true,alias:true,missed:false,extra:false,
       swappedValve:false,wrongPlace:false,tooSmall:false,duplicated:false,blankLabel:false}
    );
    // End-to-end submission with realistic tight boxes and arbitrary creation order.
    const engineIndex=await page.evaluate(()=>
      getTasks('boxes').findIndex(t=>t.id==='custom-1794174299526-wa6s'));
    await page.evaluate(index=>{
      go('boxes',index);
      const t=getTasks('boxes')[index];
      currentRects=[...t.targets].reverse().map(r=>({
        x:r.x+r.w*.18,y:r.y+r.h*.23,w:r.w*.64,h:r.h*.54,label:r.label
      }));
      drawRects();
    },engineIndex);
    assert.equal((await page.locator('#numRects').innerText()).trim(),'11');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    console.log('Engine 11 labels, tight rectangles, aliases and false-positive controls OK.');

    // Colour Detection #2: replacement red-table image and eight objects.
    const stillLife = await page.evaluate(() => {
      const t=getTasks('colour').find(t=>t.id==='colour-2');
      return {title:t.title,image:t.image,objects:t.facts.map(f=>f.object),groups:t.colourGroups.length,
        oldObjects:['яблоко','груша','чашка','бутылка'].some(s=>t.facts.some(f=>f.object===s))};
    });
    assert.equal(stillLife.title,'Предметы на столе');
    assert.ok(stillLife.image.includes('red-table-still-life-hq.webp'));
    assert.deepEqual(stillLife.objects,
      ['кактус','блокнот','карандаш','ластик','очки','телефон','пончик','лампа']);
    assert.equal(stillLife.groups,6);
    assert.equal(stillLife.oldObjects,false);
    await page.goto('http://127.0.0.1:8765/?task=colour-2', {waitUntil:'load',timeout:45000});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),'colour-2');
    const loadedImage=await page.locator('#customImage').evaluate(async img=>{
      if(!img.complete)await new Promise((resolve,reject)=>{
        img.addEventListener('load',resolve,{once:true});
        img.addEventListener('error',()=>reject(Error('image failed to load')),{once:true});
      });
      return {naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight};
    });
    assert.ok(loadedImage.naturalWidth>=1500&&loadedImage.naturalHeight>=1000,
      'colour-2 illustration failed to decode in Chrome: '+JSON.stringify(loadedImage));
    const rightAnswer='На красном столе стоят зелёный кактус и красная настольная лампа. Здесь лежат красный блокнот, жёлтый карандаш и белый ластик. Справа расположены коричневые очки, красный телефон и розовый пончик на белой тарелке.';
    const validColours=['красный','зелёный','жёлтый','розовый','белый','коричневый'];
    const paletteState=await page.evaluate(()=>{
      const t=getTasks('colour').find(t=>t.id==='colour-2');
      return {correct:t.correctColors,groups:t.colourGroups,palette:t.palette,
        expectedGlasses:t.facts.find(f=>f.object==='очки'),
        sample:t.example};
    });
    assert.deepEqual(paletteState.correct,validColours);
    assert.deepEqual(paletteState.groups,validColours.map(c=>[c]));
    assert.equal(paletteState.expectedGlasses.color,'коричневый');
    assert.ok(!paletteState.expectedGlasses.colorAliases?.includes('бежевый'));
    assert.ok(paletteState.sample.includes('коричневые очки'));
    assert.ok(!paletteState.sample.includes('бежевые очки'));
    const colourButtons=page.locator('[data-select-colour]');
    assert.equal(await colourButtons.count(),paletteState.palette.length);
    await page.locator('#colourDescription').fill(rightAnswer);
    // Real user clicks verify that all six choices are selectable.
    for (const colour of validColours) {
      const index=paletteState.palette.indexOf(colour);
      assert.ok(index>=0,'missing selectable colour '+colour);
      await page.locator('[data-select-colour="'+index+'"]').click();
      assert.equal(await page.locator('[data-select-colour="'+index+'"]').getAttribute('aria-pressed'),'true');
    }
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    assert.match(await page.locator('#feedback').innerText(),/8 из 8/);
    for(const colour of validColours) {
      const index=paletteState.palette.indexOf(colour);
      await page.locator('[data-select-colour="'+index+'"]').click();
      await page.locator('#checkBtn').click();
      assert.match(await page.locator('#feedback').getAttribute('class'),/bad/,
        'missing '+colour+' must fail');
      await page.locator('[data-select-colour="'+index+'"]').click();
    }
    // Every offered distractor must invalidate the result.
    for(const colour of paletteState.palette.filter(c=>!validColours.includes(c))) {
      const index=paletteState.palette.indexOf(colour);
      await page.locator('[data-select-colour="'+index+'"]').click();
      await page.locator('#checkBtn').click();
      assert.match(await page.locator('#feedback').getAttribute('class'),/bad/,
        'extra '+colour+' must fail');
      await page.locator('[data-select-colour="'+index+'"]').click();
    }
    const brownIndex=paletteState.palette.indexOf('коричневый');
    const beigeIndex=paletteState.palette.indexOf('бежевый');
    await page.locator('[data-select-colour="'+brownIndex+'"]').click();
    await page.locator('[data-select-colour="'+beigeIndex+'"]').click();
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/,
      'beige cannot replace brown');
    await page.locator('[data-select-colour="'+beigeIndex+'"]').click();
    await page.locator('[data-select-colour="'+brownIndex+'"]').click();
    // Beige in the written answer must not be treated as brown.
    await page.locator('#colourDescription').fill(rightAnswer.replace('коричневые очки','бежевые очки'));
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    await page.locator('#colourDescription').fill(rightAnswer.replace('коричневые очки, ',''));
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    await page.locator('#colourDescription').fill(rightAnswer);
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    console.log('Colour Detection #2 strict six-colour selection and brown-glasses reference OK.');


    // Moon scene: sky and water must be separate blue objects in the text.
    // Preserve exactly two selectable colours (blue and yellow), despite three object-colour facts.
    const moonTask = await page.evaluate(()=>{
      const t=getTasks('colour').find(x=>x.id==='custom-1792614286814-lug3');
      return {
        title:t.title,correctColors:t.correctColors,
        objects:t.facts.map(f=>f.object),colors:t.facts.map(f=>f.color),
        darkWater:t.facts.find(f=>f.object==='вода').colorAliases,
        example:t.example
      };
    });
    assert.equal(moonTask.title,'Луна');
    assert.deepEqual(moonTask.correctColors,['синий','жёлтый']);
    assert.deepEqual(moonTask.objects,['луна','небо','вода']);
    assert.deepEqual(moonTask.colors,['жёлтый','синий','синий']);
    assert.deepEqual(moonTask.darkWater,['тёмный']);
    assert.match(moonTask.example,/тёмно-синее ночное небо/);
    assert.match(moonTask.example,/тёмная вода/);
    assert.match(moonTask.example,/отражается свет луны/);
    await page.goto('http://127.0.0.1:8765/?task=custom-1792614286814-lug3',
      {waitUntil:'load',timeout:45000});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),
      'custom-1792614286814-lug3');
    for(const c of ['синий','жёлтый']) {
      const index=await page.evaluate(colour=>getTasks(section)[taskIndex].palette.indexOf(colour),c);
      assert.ok(index>=0);
      await page.locator('[data-select-colour="'+index+'"]').click();
    }
    const moonExample=moonTask.example;
    await page.locator('#colourDescription').fill(moonExample);
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    assert.match(await page.locator('#feedback').innerText(),/3 из 3/);
    // A blue sky alone must not satisfy the water requirement.
    await page.locator('#colourDescription').fill(
      'На картине огромная жёлтая луна, тёмно-синее ночное небо с яркими звёздами. Вдали стоят деревья и видны их силуэты.');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    // A dark body of water alone must not satisfy the separate sky requirement.
    await page.locator('#colourDescription').fill(
      'На картине большая жёлтая луна, рядом деревья, а внизу тёмная вода с красивыми отражениями лунного света.');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    // A concise blue sky with unspecified water colour must not count as two blue facts.
    await page.locator('#colourDescription').fill(
      'На картине видна большая жёлтая луна, синее небо и вода с отражениями деревьев в ночном пейзаже.');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    // Alternate natural description should work without exact example wording.
    await page.locator('#colourDescription').fill(
      'Большая жёлтая луна освещает пейзаж, над деревьями синее небо, а внизу синяя вода отражает свет.');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    console.log('Moon scene: yellow moon, independent blue sky and dark water checks OK.');

    // Frog scene: all four key objects have to be correctly related to their colours.
    // In particular all Russian case forms of «фон» must work, as must «лягушка».
    const frog = await page.evaluate(()=>{
      const t=getTasks('colour').find(t=>t.id==='custom-1792615787701-dpz3');
      return {title:t.title,colors:t.correctColors,objects:t.facts.map(x=>x.object),
        bg:t.facts.find(x=>x.object==='фон'),example:t.example};
    });
    assert.equal(frog.title,'Жаба');
    assert.deepEqual(frog.colors,['оранжевый','зелёный','чёрный','белый']);
    assert.deepEqual(frog.objects,['жаба / лягушка','фон','глаза','сигарета']);
    assert.equal(frog.bg.exactObjectForms,true);
    assert.ok(frog.example.includes('оранжевом фоне'));
    await page.goto('http://127.0.0.1:8765/?task=custom-1792615787701-dpz3',
      {waitUntil:'load',timeout:45000});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),
      'custom-1792615787701-dpz3');
    for(const colour of frog.colors){
      const index=await page.evaluate(c=>getTasks(section)[taskIndex].palette.indexOf(c),colour);
      assert.ok(index>=0,'frog palette must offer '+colour);
      await page.locator('[data-select-colour="'+index+'"]').click();
    }
    const passingFrogTexts=[
      'На картине зелёная жаба сидит на оранжевом фоне. У неё чёрные глаза и белая сигарета во рту.',
      'Мы видим зелёную лягушку на оранжевом фоне, у неё чёрные глаза, а в пасти белая сигарета.',
      'Зелёная жаба изображена на фоне оранжевого цвета. Её глаза чёрные, сигарета белая, дым поднимается вверх.',
      'Зелёная лягушка изображена с оранжевым фоном. Чёрные глаза смотрят вперёд, белая сигарета находится во рту.',
      'На изображении зелёная жаба, фон оранжевый, глаза чёрные, а сигарета белая. Картина нарисована яркими красками.',
      frog.example
    ];
    for(const value of passingFrogTexts){
      await page.locator('#colourDescription').fill(value);
      await page.locator('#checkBtn').click();
      assert.match(await page.locator('#feedback').getAttribute('class'),/good/,
        'Valid frog description rejected: '+value);
      assert.match(await page.locator('#feedback').innerText(),/4 из 4/);
    }
    // Omitting background, assigning the wrong background colour or selecting an extra colour fails.
    const failFrogTexts=[
      'На рисунке зелёная жаба с чёрными глазами и белой сигаретой сидит прямо перед зрителем. Она смотрит вперёд.',
      'На рисунке зелёная лягушка на синем фоне. У неё чёрные глаза, во рту белая сигарета с дымом.',
      'На изображении зелёная жаба и оранжевый фон, а глаза синие и сигарета белая. Сцена выглядит необычно.'
    ];
    for(const value of failFrogTexts){
      await page.locator('#colourDescription').fill(value);
      await page.locator('#checkBtn').click();
      assert.match(await page.locator('#feedback').getAttribute('class'),/bad/,
        'Invalid frog description accepted: '+value);
    }
    await page.locator('#colourDescription').fill(frog.example);
    const extraColourIndex=await page.evaluate(()=>getTasks(section)[taskIndex].palette.indexOf('синий'));
    await page.locator('[data-select-colour="'+extraColourIndex+'"]').click();
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    await page.locator('[data-select-colour="'+extraColourIndex+'"]').click();
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    console.log('Frog scene: frog/frog synonyms, orange background case forms and four-colour grading OK.');

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

    // Last Audio Annotation exercise: both accepted name spellings and exact job.
    const lastAudio=await page.evaluate(()=>{
      const tasks=getTasks('audio');
      const t=tasks[tasks.length-1];
      return {count:tasks.length,id:t.id,mode:t.audioMode,entities:t.entities,
        title:t.title};
    });
    assert.equal(lastAudio.count,10);
    assert.equal(lastAudio.id,'custom-1793894115765-gvg9');
    assert.equal(lastAudio.mode,'entities');
    assert.deepEqual(lastAudio.entities,[
      {label:'Имя',answers:['Джон Дилинджер','Джон Диллинджер']},
      {label:'Работа',answers:['грабит банки']}
    ]);
    await page.goto('http://127.0.0.1:8765/?task=custom-1793894115765-gvg9',
      {waitUntil:'load',timeout:45000});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),
      'custom-1793894115765-gvg9');
    assert.equal(await page.locator('[id^=audioEntity]').count(),2);
    // The correct answer must not be exposed in question, rules, hint or initial feedback.
    const preview=(await page.locator('.quiz').innerText());
    assert.ok(!preview.includes('Джон Дилинджер'));
    assert.ok(!preview.includes('Джон Диллинджер'));
    assert.ok(!preview.includes('грабит банки'));
    assert.equal(await page.locator('[data-revealed-answer]').count(),0);
    await page.locator('#hintBtn').click();
    const hintBefore=(await page.locator('#hintArea').innerText());
    assert.ok(!hintBefore.includes('Джон'));
    assert.ok(!hintBefore.includes('грабит банки'));
    await page.locator('#checkBtn').click();
    assert.equal(await page.locator('[data-revealed-answer]').count(),0,
      'empty fields must not reveal the reference');
    await page.locator('#audioEntity0').fill('Неизвестное имя');
    await page.locator('#checkBtn').click();
    assert.equal(await page.locator('[data-revealed-answer]').count(),0,
      'partially filled response must not reveal the reference');
    await page.locator('#audioEntity1').fill('неизвестно');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    const revealedAfterWrong=await page.locator('[data-revealed-answer]').innerText();
    assert.ok(revealedAfterWrong.includes('Джон Дилинджер'));
    assert.ok(revealedAfterWrong.includes('Джон Диллинджер'));
    assert.ok(revealedAfterWrong.includes('грабит банки'));
    // Reset to the same exercise; answers must be hidden until the next submission.
    await page.reload({waitUntil:'load'});
    assert.equal(await page.locator('[data-revealed-answer]').count(),0);
    assert.ok(!(await page.locator('.rule').innerText()).includes('Джон'));
    assert.ok(!(await page.locator('.rule').innerText()).includes('грабит банки'));

    for(const name of ['Джон Дилинджер','Джон Диллинджер']){
      await page.locator('#audioEntity0').fill(name);
      await page.locator('#audioEntity1').fill('грабит банки');
      await page.locator('#checkBtn').click();
      assert.match(await page.locator('#feedback').getAttribute('class'),/good/,
        'Correct name must be accepted: '+name);
      assert.ok((await page.locator('[data-revealed-answer]').innerText()).includes(name));
      assert.ok((await page.locator('[data-revealed-answer]').innerText()).includes('грабит банки'));
    }
    await page.locator('#audioEntity0').fill('Другой человек');
    await page.locator('#audioEntity1').fill('грабит банки');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    assert.match(await page.locator('#feedback').innerText(),/Имя/);
    await page.locator('#audioEntity0').fill('Джон Диллинджер');
    await page.locator('#audioEntity1').fill('банкир');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    assert.match(await page.locator('#feedback').innerText(),/Работа/);
    await page.locator('#audioEntity1').fill('грабитель');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/bad/);
    await page.locator('#audioEntity1').fill('ГРАБИТ БАНКИ');
    await page.locator('#checkBtn').click();
    assert.match(await page.locator('#feedback').getAttribute('class'),/good/);
    console.log('Last Audio Annotation: both John Dillinger spellings and bank-robbing job validated.');

    // Speaker sequence #8: user-corrected nine utterances, including final Voice 3.
    const speakerSequenceTask=await page.evaluate(()=>{
      const list=getTasks('audio'),t=list.find(x=>x.id==='custom-1793893188334-hy8s');
      return {index:list.indexOf(t),length:list.length,title:t.title,
        mode:t.audioMode,sequence:t.speakerSequence};
    });
    const nineVoices=['Голос 1','Голос 2','Голос 1','Голос 2','Голос 1',
      'Голос 2','Голос 3','Голос 2','Голос 3'];
    assert.equal(speakerSequenceTask.index,7,'screenshot shows task 8 / 10');
    assert.equal(speakerSequenceTask.length,10);
    assert.equal(speakerSequenceTask.mode,'speakers');
    assert.equal(speakerSequenceTask.title,'Последовательность говорящих');
    assert.deepEqual(speakerSequenceTask.sequence,nineVoices);
    await page.goto('http://127.0.0.1:8765/?task=custom-1793893188334-hy8s',
      {waitUntil:'load',timeout:45000});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),'custom-1793893188334-hy8s');
    const speakerText=page.locator('#audioSpeakerAnswer');
    const speakerFeedback=page.locator('#feedback');
    assert.equal(await speakerText.count(),1);
    assert.ok(!(await page.locator('.quiz').innerText()).includes('Голос 3 → Голос 2 → Голос 3'),
      'the answer cannot appear before check');
    await speakerText.fill(nineVoices.slice(0,8).join('\n'));
    await page.locator('#checkBtn').click();
    assert.match(await speakerFeedback.getAttribute('class'),/bad/,'old 8-line answer fails');
    await speakerText.fill([...nineVoices.slice(0,8),'Голос 1'].join('\n'));
    await page.locator('#checkBtn').click();
    assert.match(await speakerFeedback.getAttribute('class'),/bad/,'wrong ninth speaker fails');
    await speakerText.fill(nineVoices.join('\n'));
    await page.locator('#checkBtn').click();
    assert.match(await speakerFeedback.getAttribute('class'),/good/,'correct nine-line answer passes');
    assert.match(await speakerFeedback.innerText(),/Голос 3 → Голос 2 → Голос 3/);
    // Mixed-case spellings of speaker IDs should also be recognized.
    await speakerText.fill(nineVoices.map(x=>x.toLowerCase()).join('\n'));
    await page.locator('#checkBtn').click();
    assert.match(await speakerFeedback.getAttribute('class'),/good/);
    console.log('Speaker sequence #8 corrected to nine turns, old eight turns rejected.');

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

    // Resume session across visits and retain unfinished responses without an account.
    await page.goto('http://127.0.0.1:8765/?task=colour-2',
      {waitUntil:'load',timeout:45000});
    await page.locator('#colourDescription').fill(
      'На красном столе стоят зелёный кактус и красная лампа, рядом лежат другие предметы.');
    const colourResume=await page.evaluate(()=>
      getTasks(section)[taskIndex].palette.indexOf('зелёный'));
    const greenButton=page.locator('[data-select-colour="'+colourResume+'"]');
    if((await greenButton.getAttribute('aria-pressed'))==='true'){
      await greenButton.click(); // Existing saved work may already have green selected.
    }
    await greenButton.click();
    assert.equal(await greenButton.getAttribute('aria-pressed'),'true');
    const firstDraft=await page.locator('#colourDescription').inputValue();
    await page.reload({waitUntil:'load'});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),'colour-2');
    assert.equal(await page.locator('#colourDescription').inputValue(),firstDraft);
    assert.equal(await page.locator('[data-select-colour="'+colourResume+'"]').getAttribute('aria-pressed'),'true');
    // Use the main course link (without query). It should open the last active task.
    await page.goto('http://127.0.0.1:8765/',{waitUntil:'load'});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),'colour-2');
    assert.equal(await page.locator('#colourDescription').inputValue(),firstDraft);
    // Resume should track the next exercise, not stick to the originally linked task.
    await page.locator('#nextBtn').click();
    const followingId=await page.evaluate(()=>getTasks(section)[taskIndex].id);
    assert.notEqual(followingId,'colour-2');
    await page.goto('http://127.0.0.1:8765/',{waitUntil:'load'});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),followingId);
    await page.goto('http://127.0.0.1:8765/?task=colour-2',
      {waitUntil:'load'});
    assert.equal(await page.locator('#colourDescription').inputValue(),firstDraft);
    // An unfinished audio entity answer must also be restored without leaking the reference.
    await page.goto('http://127.0.0.1:8765/?task=custom-1793894115765-gvg9',
      {waitUntil:'load'});
    await page.locator('#audioEntity0').fill('Джон Ди...');
    await page.locator('#audioEntity1').fill('Пытаюсь вспомнить');
    await page.goto('http://127.0.0.1:8765/',{waitUntil:'load'});
    assert.equal(await page.evaluate(()=>getTasks(section)[taskIndex].id),
      'custom-1793894115765-gvg9');
    assert.equal(await page.locator('#audioEntity0').inputValue(),'Джон Ди...');
    assert.equal(await page.locator('#audioEntity1').inputValue(),'Пытаюсь вспомнить');
    assert.equal(await page.locator('[data-revealed-answer]').count(),0);
    // Existing saved completion flags and annotations survive the new resume logic.
    assert.ok(await page.evaluate(()=>completed())>=2);
    console.log('Browser resume: current task, colour choices, text and audio drafts survive reload/revisit.');

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
