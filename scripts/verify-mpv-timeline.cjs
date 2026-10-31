const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async function verifyTimeline({
  debugPort,
  play,
  evaluate,
  cdp,
  sleep,
  output,
  results,
}) {
  const index = process.argv.indexOf("--playwright-module");
  assert.ok(
    index >= 0 && process.argv[index + 1],
    "Pass --playwright-module PATH for the optional visual QA",
  );
  const { chromium } = require(path.resolve(process.argv[index + 1]));
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${debugPort}`,
  );
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => /^https?:/.test(page.url()));
  assert.ok(page, "The isolated desktop page is missing");
  await play("h264-aac.mp4");
  await evaluate("Lampa.PlayerVideo.pause();Lampa.PlayerPanel.show()");
  // Move off the timeline before a direct API check; a real hover may have
  // already scheduled its own worker while the player panel was appearing.
  await page.mouse.move(10, 10);
  await evaluate("Lampa.PlayerVideo.video().cancelPreview()");
  await sleep(350);
  const decoded = await evaluate(`(async()=>{
    const v=Lampa.PlayerVideo.video();const before=v.currentTime;
    const frame=await v.requestPreview(4);
    let min=255,max=0;if(frame)for(const byte of new Uint8Array(frame.rgba)){min=Math.min(min,byte);max=Math.max(max,byte);}
    return {before,after:v.currentTime,frame:frame?{width:frame.width,height:frame.height,seconds:frame.seconds,
      bytes:frame.rgba.byteLength,range:max-min}:null};
  })()`);
  assert.ok(
    decoded.frame,
    "The real native preview worker did not produce a frame",
  );
  assert.ok(Math.abs(decoded.frame.seconds - 4) <= 2, JSON.stringify(decoded));
  assert.ok(
    Math.abs(decoded.after - decoded.before) < 0.2,
    "Preview changed visible playback position",
  );
  assert.ok(decoded.frame.range > 20, "Preview canvas is blank");
  results.push({ nativeFramePreview: decoded });
  const repeated = await evaluate(`(async()=>{
    const v=Lampa.PlayerVideo.video();const frames=[];
    for(const seconds of [9,2,4]){
      await new Promise(resolve=>setTimeout(resolve,300));
      const start=performance.now();const f=await v.requestPreview(seconds);
      let hash=2166136261;if(f)for(const b of new Uint8Array(f.rgba))hash=Math.imul(hash^b,16777619)>>>0;
      frames.push({target:seconds,seconds:f?.seconds,hash,ms:performance.now()-start});
    }
    return frames;
  })()`);
  for (const frame of repeated)
    assert.ok(
      Number.isFinite(frame.seconds) &&
        Math.abs(frame.seconds - frame.target) < 0.5,
      JSON.stringify(repeated),
    );
  assert.notEqual(
    repeated[0].hash,
    repeated[1].hash,
    "Reused decoder returned a stale frame after seek",
  );
  results.push({ repeatedPreviewSeeks: repeated });

  // Use a long playing fixture so EOF/pause cannot mask the native hide timer.
  await play("d3d11-continuous-h264-sdr.mp4");
  await page.bringToFront();
  await evaluate(`window.__hoverCalls=[];window.__hoverMove=Lampa.PlayerPanel.mousemove;
    Lampa.PlayerPanel.mousemove=function(){__hoverCalls.push(performance.now());return __hoverMove.apply(this,arguments)};
    window.__hoverVideo=Lampa.PlayerVideo.video();
    window.__hoverPreview=__hoverVideo.requestPreview.bind(__hoverVideo);
    __hoverVideo.requestPreview=async seconds=>{await new Promise(resolve=>setTimeout(resolve,4200));return __hoverPreview(seconds)};
    Lampa.PlayerVideo.play();Lampa.PlayerPanel.mousemove()`);
  const hoverBox = await page.locator(".player-panel__timeline").boundingBox();
  await page
    .locator(".player-panel__timeline")
    .hover({ position: { x: hoverBox.width * 0.3, y: hoverBox.height / 2 } });
  await sleep(3700);
  assert.equal(
    await evaluate("Lampa.PlayerPanel.visibleStatus()"),
    true,
    "Controls hid during a slow preview with a stationary pointer",
  );
  await page.screenshot({
    path: path.join(output, "timeline-hover-pending.png"),
  });
  await page.waitForFunction(
    () => !document.querySelector(".lampaua-preview canvas")?.hidden,
    null,
    { timeout: 3000 },
  );
  await sleep(3300);
  assert.equal(
    await evaluate("Lampa.PlayerPanel.visibleStatus()"),
    true,
    "Controls hid just after a preview appeared",
  );
  assert.equal(await page.locator(".lampaua-preview").isVisible(), true);
  await page.screenshot({
    path: path.join(output, "timeline-hover-ready.png"),
  });
  await page.mouse.move(10, 10);
  const leftAt = await evaluate("performance.now()");
  // A play/rewind condition adds a 1s grace before Lampa's 3s hide timeout.
  await sleep(4500);
  const afterLeave =
    await evaluate(`({visible:Lampa.PlayerPanel.visibleStatus(),paused:Lampa.PlayerVideo.video().paused,
    time:Lampa.PlayerVideo.video().currentTime,duration:Lampa.PlayerVideo.video().duration,
    bubbleHidden:document.querySelector('.lampaua-preview').hidden,controller:Lampa.Controller.enabled()?.name,
    panel:Lampa.PlayerPanel.render()?.[0]?.className,calls:__hoverCalls.filter(time=>time>${leftAt})})`);
  results.push({ hoverLeaveDiagnostic: afterLeave });
  assert.equal(
    afterLeave.paused,
    false,
    "EOF/pause invalidated the auto-hide test",
  );
  assert.equal(
    afterLeave.calls.length,
    0,
    "Hover keepalive survived pointer exit",
  );
  assert.equal(
    await evaluate("Lampa.PlayerPanel.visibleStatus()"),
    false,
    `Controls no longer auto-hide after leaving the timeline: ${JSON.stringify(afterLeave)}`,
  );
  assert.equal(await page.locator(".lampaua-preview").isVisible(), false);
  await evaluate(
    "__hoverVideo.requestPreview=__hoverPreview;Lampa.PlayerPanel.mousemove=__hoverMove;Lampa.PlayerVideo.pause();Lampa.PlayerPanel.mousemove()",
  );
  results.push({
    stationaryHoverPendingVisible: true,
    stationaryHoverReadyVisible: true,
    autoHideRestoredAfterLeave: true,
  });
  await play("h264-aac.mp4");
  await evaluate("Lampa.PlayerVideo.pause();Lampa.PlayerPanel.mousemove()");

  await evaluate(`window.__timelineSeeks=[];const s=document.querySelector('mpv-video');
    window.__originalTimelineSeek=s.seek.bind(s);s.seek=async t=>{__timelineSeeks.push(t);return __originalTimelineSeek(t)}`);
  for (const width of [1280, 800]) {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);
    await page.bringToFront();
    await evaluate("Lampa.PlayerPanel.show()");
    for (const fraction of [0.01, 0.5, 0.99]) {
      let box = await page.locator(".player-panel__timeline").boundingBox();
      assert.ok(box);
      await page
        .locator(".player-panel__timeline")
        .hover({ position: { x: box.width * fraction, y: box.height / 2 } });
      await page
        .locator(".lampaua-preview")
        .waitFor({ state: "visible", timeout: 5000 });
      await sleep(900);
      box = await page.locator(".player-panel__timeline").boundingBox();
      const position = await page.locator(".lampaua-preview").boundingBox();
      assert.match(
        await page.locator(".lampaua-preview__time").textContent(),
        /^\d+:\d{2}(?::\d{2})?$/,
      );
      assert.equal(await page.locator(".lampaua-seek-target").count(), 1);
      const layout =
        await evaluate(`(()=>{const t=document.querySelector('.player-panel__timeline'),b=document.querySelector('.lampaua-preview');
        return {focus:document.hasFocus(),visibility:document.visibilityState,panel:Lampa.PlayerPanel.render()?.[0]?.className,track:{position:getComputedStyle(t).position,rect:t.getBoundingClientRect().toJSON()},bubble:{hidden:b.hidden,position:getComputedStyle(b).position,bottom:getComputedStyle(b).bottom,left:getComputedStyle(b).left,offset:b.offsetParent?.className},
        caption:{text:b.lastElementChild.textContent,position:getComputedStyle(b.lastElementChild).position,height:getComputedStyle(b.lastElementChild).height,display:getComputedStyle(b.lastElementChild).display}}})()`);
      results.push({ timelineLayout: { width, fraction, layout } });
      await page.screenshot({
        path: path.join(output, `timeline-${width}-${fraction}.png`),
      });
      assert.ok(
        position &&
          position.x >= box.x - 1 &&
          position.x + position.width <= box.x + box.width + 1,
        JSON.stringify({ box, position }),
      );
      assert.ok(
        position.y + position.height <= box.y,
        "Preview overlaps the timeline",
      );
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  await sleep(600);
  await page.bringToFront();
  await evaluate("Lampa.PlayerPanel.show()");
  const box = await page.locator(".player-panel__timeline").boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 20 });
  assert.equal(
    await evaluate("__timelineSeeks.length"),
    0,
    "Drag repeatedly sought the video",
  );
  await page.mouse.up();
  await sleep(500);
  assert.equal(
    await evaluate("__timelineSeeks.length"),
    1,
    "Release must seek exactly once",
  );
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await evaluate("window.dispatchEvent(new Event('blur'))");
  await page.mouse.up();
  assert.equal(
    await evaluate("__timelineSeeks.length"),
    1,
    "Canceled drag committed a seek",
  );
  results.push({ mouseDragSingleCommit: true, canceledDragNoCommit: true });

  await page.mouse.move(box.x + box.width * 0.4, y);
  try {
    await page.waitForFunction(
      () => {
        const c = document.querySelector(".lampaua-preview canvas");
        return c && !c.hidden;
      },
      null,
      { timeout: 10000 },
    );
  } catch (error) {
    results.push({
      timelineDiagnostic: await evaluate(
        `(()=>{const b=document.querySelector('.lampaua-preview');return {html:b?.outerHTML,children:[...(b?.children||[])].map(c=>({tag:c.tagName,cls:c.className,text:c.textContent,display:getComputedStyle(c).display,visibility:getComputedStyle(c).visibility})),track:document.querySelector('.player-panel__timeline')?.getBoundingClientRect().toJSON(),video:{time:Lampa.PlayerVideo.video().currentTime,duration:Lampa.PlayerVideo.video().duration}}})()`,
      ),
    });
    await page.screenshot({ path: path.join(output, "timeline-failure.png") });
    throw error;
  }
  const pixels =
    await evaluate(`(()=>{const c=document.querySelector('.lampaua-preview canvas');
    const bytes=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let sum=0,min=255,max=0;
    for(let i=0;i<bytes.length;i+=4){sum+=bytes[i];min=Math.min(min,bytes[i]);max=Math.max(max,bytes[i]);}
    return {mean:sum/(bytes.length/4),range:max-min,width:c.width,height:c.height};})()`);
  assert.ok(pixels.range > 20 && pixels.mean > 5, JSON.stringify(pixels));
  await page.screenshot({ path: path.join(output, "timeline-frame.png") });
  results.push({ previewCanvasPixels: pixels });

  await evaluate(`Lampa.Player.playdata().torrent_hash='synthetic-ui-stat';Lampa.PlayerInfo.listener.send('stat',
    {cache:{Readers:[{Reader:2,End:6}],Pieces:{2:{Completed:true},3:{Completed:true},5:{Completed:true}}}})`);
  assert.equal(
    await page.locator(".lampaua-torrent-buffer").textContent(),
    "TorrServer: 50%",
  );
  await page.screenshot({
    path: path.join(output, "timeline-torrserver-buffer.png"),
  });
  await evaluate("Lampa.PlayerInfo.listener.send('stat',{})");
  assert.equal(
    await page
      .locator(".lampaua-torrent-buffer")
      .evaluate((element) => element.hidden),
    true,
  );
  results.push({ syntheticTorrServerStat: true, missingBufferHidden: true });

  await evaluate(
    `Lampa.PlayerPanel.listener.send('quality',{name:'QA',url:Lampa.PlayerVideo.video().src+'?quality=timeline-reset'})`,
  );
  assert.equal(
    await page
      .locator(".lampaua-preview")
      .evaluate((element) => element.hidden),
    true,
    "Quality change retained an old displayed thumbnail",
  );
  assert.equal(
    await page
      .locator(".lampaua-seek-target")
      .evaluate((element) => element.hidden),
    true,
  );
  results.push({ qualityChangeClearsPreview: true });
  await play("h264-aac.mp4");
  await evaluate(
    "Lampa.PlayerVideo.pause();Lampa.PlayerPanel.show();window.__escapedOldClicks=0;Lampa.PlayerPanel.listener.follow('mouse_rewind',e=>{if(e.method==='click')__escapedOldClicks++})",
  );
  await sleep(400);
  const replacementBox = await page
    .locator(".player-panel__timeline")
    .boundingBox();
  await page.mouse.move(
    replacementBox.x + replacementBox.width * 0.3,
    replacementBox.y + replacementBox.height / 2,
  );
  await page.mouse.down();
  await evaluate(
    "window.__timelineVideoAccessor=Lampa.PlayerVideo.video;Lampa.PlayerVideo.video=()=>document.createElement('video');Lampa.PlayerVideo.listener.send('destroy',{})",
  );
  await page.mouse.up();
  assert.equal(
    await evaluate("__escapedOldClicks"),
    0,
    "Canceled old pointer sequence escaped to the browser rewind handler",
  );
  await evaluate("Lampa.PlayerVideo.video=__timelineVideoAccessor");
  results.push({ canceledDragBrowserRouteClickIsolated: true });

  await play("sisi/video.mp4", null, {
    headers: {
      Referer: "https://provider.test/watch",
      "User-Agent": "LampaUa-SISI-Test",
      Authorization: "Bearer synthetic-test",
    },
  });
  assert.ok(
    await evaluate("Lampa.PlayerVideo.video().requestPreview(3).then(Boolean)"),
    "Protected preview lost source headers",
  );
  results.push({ protectedPreviewHeaders: true });
  await play("postload-stall.mp4");
  await evaluate(
    "window.__pendingPreview=Lampa.PlayerVideo.video().requestPreview(9)",
  );
  await sleep(350);
  const ping = Date.now();
  await evaluate("electronAPI.getAppVersion()");
  assert.ok(Date.now() - ping < 2000, "Preview blocked the main process");
  results.push({
    pendingPreviewCloseTest: true,
    mainPingMs: Date.now() - ping,
  });
};

module.exports.startStress = async function startStress(evaluate) {
  await evaluate(`(()=>{
    const video=Lampa.PlayerVideo.video();
    if(typeof video.requestPreview!=='function')throw new Error('Rebuild timeline package');
    window.__previewStress={ticks:0,requests:0,frames:0,unavailable:0,latencies:[],visibility:[]};
    const original=video.requestPreview.bind(video);
    video.requestPreview=async seconds=>{
      const start=performance.now();__previewStress.requests++;
      const frame=await original(seconds);
      __previewStress.latencies.push(performance.now()-start);
      if(frame)__previewStress.frames++;else __previewStress.unavailable++;
      return frame;
    };
    let counter=0;
    __previewStress.timer=setInterval(()=>{
      __previewStress.ticks++;
      __previewStress.visibility.push({at:performance.now(),focused:document.hasFocus(),visibility:document.visibilityState,sameVideo:video===Lampa.PlayerVideo.video()});
      Lampa.PlayerPanel.show();
      const track=document.querySelector('.player-panel__timeline');
      const box=track.getBoundingClientRect();
      const fraction=0.1+(++counter*0.137)%0.8;
      track.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',pointerId:1,
        clientX:box.left+box.width*fraction,clientY:box.top+box.height/2}));
    },2500);
  })()`);
};

module.exports.stopStress = async function stopStress(evaluate) {
  return evaluate(`(()=>{const stats=__previewStress;clearInterval(stats.timer);
    Lampa.PlayerVideo.video().cancelPreview();
    return {ticks:stats.ticks,requests:stats.requests,frames:stats.frames,unavailable:stats.unavailable,visibility:stats.visibility,
      maxMs:Math.max(0,...stats.latencies),meanMs:stats.latencies.reduce((a,b)=>a+b,0)/Math.max(1,stats.latencies.length)};
  })()`);
};
