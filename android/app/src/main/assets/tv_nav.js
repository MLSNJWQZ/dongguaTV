/* dongguaTV · TV 遥控器焦点导航运行时
 * 由原生层 MainActivity 在首次按下方向键时通过 evaluateJavascript 注入。
 * 之所以不用 onPageFinished 注入：APK 加载的是远程站点（capacitor server.url），
 * 无法改网页源码，懒注入对任何改版都免疫；页面整页刷新后第一次按键会自动重新注入。
 * 命名空间 __dgTv* 避免与站点自身的 TV 逻辑冲突。 */
(function () {
  if (window.__dgTvRuntime) return;

  var FOCUS_SEL = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    '[tabindex]:not([tabindex="-1"])',
    '[role="button"]',
    'video',
    '.vjs-big-play-button',
    '.dplayer-icon'
  ].join(',');

  /* 站点是 Vue 单页应用：海报卡片把 @click 绑在 div/li 上，既没有 href 也没有
   * tabindex / role，上面的语义选择器一个都选不中 —— 遥控器会直接跳过整片内容。
   * 补一层「cursor:pointer 的可视叶子节点」，并按包含关系剔除大容器。
   * 注意：不能给 html.dg-tv 设 cursor:none，否则这条检测会全部失效。 */
  var CLICKABLE_SEL = 'div[class],li[class],span[class],section[class],article[class],label[class]';
  var CACHE_MS = 260;                    // 连按 / 长按时复用候选，避免反复 getComputedStyle
  var cache = { t: 0, list: [] };

  /* ---- 焦点高亮样式（青色描边 + 外发光，十米外可辨） ---- */
  var style = document.createElement('style');
  style.id = 'dg-tv-style';
  style.textContent =
    '.dg-tv-focus{outline:4px solid #22d3ee !important;' +
    'outline-offset:2px !important;' +
    'box-shadow:0 0 0 8px rgba(34,211,238,.28) !important;' +
    'border-radius:6px;}' +
    '.dg-tv-focus:focus{outline:4px solid #22d3ee !important;}';
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.classList.add('dg-tv');

  /* ---- 工具 ---- */
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return {
      l: r.left, t: r.top, r: r.right, b: r.bottom,
      w: r.width, h: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2
    };
  }

  function visible(el) {
    var r = rectOf(el);
    if (r.w < 8 || r.h < 8 || r.w * r.h < 100) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    var st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) return false;
    if (st.pointerEvents === 'none') return false;
    /* 与视口有交集即可（允许部分露出） */
    return r.b > 0 && r.t < innerHeight && r.r > 0 && r.l < innerWidth;
  }

  function candidates() {
    var now = Date.now();
    if (cache.list.length && now - cache.t < CACHE_MS) return cache.list;

    var out = [], i, el;
    var all = document.querySelectorAll(FOCUS_SEL);
    for (i = 0; i < all.length; i++) if (visible(all[i])) out.push(all[i]);

    /* 补充 Vue 点击卡片：先用几何粗筛，只有露出视口的才读 computedStyle */
    var extra = document.querySelectorAll(CLICKABLE_SEL);
    for (i = 0; i < extra.length; i++) {
      el = extra[i];
      if (out.indexOf(el) !== -1) continue;
      var r = rectOf(el);
      if (r.w < 24 || r.h < 24) continue;
      if (r.w > innerWidth * 0.9 || r.h > innerHeight * 0.9) continue;
      if (r.b <= 0 || r.t >= innerHeight || r.r <= 0 || r.l >= innerWidth) continue;
      if (!visible(el)) continue;
      if (getComputedStyle(el).cursor !== 'pointer' && !el.hasAttribute('onclick')) continue;
      /* 内部已有语义控件（按钮 / 链接）时跳过外层容器，避免焦点砸在整块背景上 */
      var inner = el.querySelector(FOCUS_SEL);
      if (inner && visible(inner)) continue;
      out.push(el);
    }

    /* 去掉「大容器包着小卡片」的重复项，保留更内层的可点元素 */
    var rects = out.map(rectOf);
    out = out.filter(function (a, ai) {
      var aa = rects[ai].w * rects[ai].h;
      for (var j = 0; j < out.length; j++) {
        if (j === ai) continue;
        var rb = rects[j];
        if (rb.w * rb.h < aa * 0.8 && a.contains(out[j])) return false;
      }
      return true;
    });

    cache = { t: now, list: out };
    return out;
  }

  function current() {
    var el = document.querySelector('.dg-tv-focus');
    if (el && el.isConnected && visible(el)) return el;
    el = document.activeElement;
    return (el && el !== document.body && visible(el)) ? el : null;
  }

  function focus(el) {
    var old = document.querySelector('.dg-tv-focus');
    if (old) old.classList.remove('dg-tv-focus');
    el.classList.add('dg-tv-focus');
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  /* ---- 几何选点：同方向最近优先，交叉轴对齐的加分 ---- */
  function pick(cur, dir, list) {
    var cr = cur
      ? rectOf(cur)
      : { cx: innerWidth / 2, cy: innerHeight / 3, l: 0, t: 0, r: innerWidth, b: innerHeight, w: innerWidth, h: innerHeight };
    var dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    var dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    var best = null, bestScore = Infinity;

    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === cur) continue;
      var r = rectOf(el);
      var mx = r.cx - cr.cx, my = r.cy - cr.cy;
      var primary = dx ? mx * dx : my * dy;   /* 主轴有向距离，<=0 表示不在该方向 */
      if (primary <= 4) continue;
      var cross;
      if (dx) {
        /* 横向移动：目标与当前元素在纵向有重叠带才算“正对”，否则按偏移惩罚 */
        var vOver = Math.min(r.b, cr.b) - Math.max(r.t, cr.t);
        cross = vOver >= Math.min(r.h, cr.h) * 0.25 ? 0 : Math.abs(my);
      } else {
        var hOver = Math.min(r.r, cr.r) - Math.max(r.l, cr.l);
        cross = hOver >= Math.min(r.w, cr.w) * 0.25 ? 0 : Math.abs(mx);
      }
      var score = primary + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /* 站点里有多处 overflow-y:auto 的内部容器（横向卡片行 / 弹窗列表）。
   * 原来只 window.scrollBy，焦点在这种容器里按到底就完全滚不动。 */
  function scrollContainer(el) {
    var p = el && el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      var st = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 8) return p;
      p = p.parentElement;
    }
    return null;
  }

  function scrollByDir(el, dir) {
    var sign = dir === 'down' ? 1 : -1;
    var box = scrollContainer(el);
    if (box) {
      var canBox = sign > 0
        ? box.scrollTop < box.scrollHeight - box.clientHeight - 4
        : box.scrollTop > 4;
      if (canBox) {
        box.scrollBy({ top: sign * box.clientHeight * 0.7, behavior: 'smooth' });
        return true;
      }
    }
    var doc = document.scrollingElement || document.documentElement;
    var canDoc = sign > 0
      ? doc.scrollTop < doc.scrollHeight - doc.clientHeight - 4
      : doc.scrollTop > 4;
    if (canDoc) {
      window.scrollBy({ top: sign * innerHeight * 0.75, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  function move(dir) {
    var cur = current();
    var list = candidates();
    var target = pick(cur, dir, list);
    if (target) { focus(target); return true; }

    /* 方向上没有目标 → 优先滚焦点所在容器，其次滚整页 */
    if (dir === 'up' || dir === 'down') {
      if (scrollByDir(cur, dir)) return true;
    }
    /* 横向没有目标：回绕到列表首/尾，没有可用的才放弃 */
    if (list.length) {
      var wrap = dir === 'left' ? list[0] : list[list.length - 1];
      if (wrap && wrap !== cur) { focus(wrap); return true; }
    }
    return false;
  }

  function ok() {
    var el = current();
    if (!el) { move('down'); return; }
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
      /* focus() 已能让 WebView 弹出软键盘；不再补 click()，避免误触搜索建议 */
      try { el.focus(); } catch (e) {}
      return;
    }
    if (tag === 'VIDEO') {
      if (el.paused) { try { el.play(); } catch (e) {} } else { el.pause(); }
      return;
    }
    try { el.click(); } catch (e) {}
  }

  function playPause() {
    var vs = document.querySelectorAll('video');
    for (var i = 0; i < vs.length; i++) if (!vs[i].paused) { vs[i].pause(); return; }
    for (var j = 0; j < vs.length; j++) { try { vs[j].play(); return; } catch (e) {} }
  }

  window.__dgTvKey = function (k) {
    if (document.readyState === 'loading') return;
    if (k === 'ok') ok();
    else if (k === 'play') playPause();
    else move(k);
  };

  /* 页面整块换内容时可主动清候选缓存（原生层或调试用） */
  window.__dgTvRefresh = function () { cache.t = 0; };

  window.__dgTvRuntime = true;
})();
