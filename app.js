/* =========================================================
   GPS 实测面积仪 · 逻辑
   格林公式 / 鞋带公式 · iOS Safari 定位与持久化
   ========================================================= */
(function () {
  'use strict';

  var STORE_KEY = 'gps-area:v1';
  var MAX_ACCURACY = 35;
  var MAX_POINTS = 5000;
  var FIRST_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
  var WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 };
  var RAD = Math.PI / 180;
  var EARTH_RADIUS = 6371008.8;
  var ACCURACY_FACTOR = 0.6;
  var DEMO = false;

  try {
    DEMO = new URLSearchParams(window.location.search).has('demo');
  } catch (err) {
    DEMO = false;
  }

  function $(id) {
    return document.getElementById(id);
  }

  var el = {
    app: $('app'),
    statPoints: $('statPoints'),
    statPerimeter: $('statPerimeter'),
    statPerimeterUnit: $('statPerimeterUnit'),
    statArea: $('statArea'),
    statAreaUnit: $('statAreaUnit'),
    gpsText: $('gpsText'),
    accuracyText: $('accuracyText'),
    gpsAcc: $('gpsAcc'),
    mapPanel: $('mapPanel'),
    mapCanvas: $('mapCanvas'),
    areaChip: $('areaChip'),
    chipText: $('chipText'),
    demoBadge: $('demoBadge'),
    mapHint: $('mapHint'),
    hintTitle: $('hintTitle'),
    hintSub: $('hintSub'),
    manualPinBtn: $('manualPinBtn'),
    notice: $('notice'),
    noticeTitle: $('noticeTitle'),
    noticeBody: $('noticeBody'),
    noticePrimary: $('noticePrimary'),
    noticeSecondary: $('noticeSecondary'),
    modeAuto: $('modeAuto'),
    modeManual: $('modeManual'),
    mainBtn: $('mainBtn'),
    mainLabel: $('mainLabel'),
    mainPlay: $('mainPlay'),
    mainPause: $('mainPause'),
    mainSpinner: $('mainSpinner'),
    closeBtn: $('closeBtn'),
    resetBtn: $('resetBtn'),
    backdrop: $('backdrop'),
    resultSheet: $('resultSheet'),
    resultAreaNum: $('resultAreaNum'),
    resultAreaUnit: $('resultAreaUnit'),
    resultExactArea: $('resultExactArea'),
    resultMu: $('resultMu'),
    resultWarning: $('resultWarning'),
    resultPerimeter: $('resultPerimeter'),
    resultPoints: $('resultPoints'),
    resultAccuracy: $('resultAccuracy'),
    resultGap: $('resultGap'),
    resultTime: $('resultTime'),
    resultMode: $('resultMode'),
    sheetCloseBtn: $('sheetCloseBtn'),
    copyBtn: $('copyBtn'),
    exportBtn: $('exportBtn'),
    sheetResumeBtn: $('sheetResumeBtn'),
    confirmMask: $('confirmMask'),
    confirmText: $('confirmText'),
    confirmCancel: $('confirmCancel'),
    confirmOk: $('confirmOk'),
    toast: $('toast')
  };

  var state = {
    phase: 'idle',
    mode: 'auto',
    points: [],
    current: null,
    watchId: null,
    closed: false,
    startedAt: null,
    closedAt: null,
    snapshot: null,
    demo: false,
    lastFixAt: 0,
    lastRecordAt: 0,
    wakeLock: null
  };

  var ui = {
    noticeOpen: false,
    noticeAction: null,
    sheetOpen: false,
    confirmOpen: false,
    lastFocus: null,
    toastTimer: null,
    startTimer: null,
    requestSeq: 0,
    resizeTimer: null,
    drawQueued: false,
    pendingMetrics: null,
    lastGeoWarnAt: 0,
    lastAccWarnAt: 0,
    mapWidth: 0,
    mapHeight: 0,
    dpr: 1
  };

  /* ======================= 数学与格式化 ======================= */

  function round(value, digits) {
    var factor = Math.pow(10, digits || 0);
    return Math.round(value * factor) / factor;
  }

  function haversine(a, b) {
    var lat1 = a.lat * RAD;
    var lat2 = b.lat * RAD;
    var dLat = lat2 - lat1;
    var dLng = (b.lng - a.lng) * RAD;
    var sLat = Math.sin(dLat / 2);
    var sLng = Math.sin(dLng / 2);
    var h = sLat * sLat + Math.cos(lat1) * Math.cos(lat2) * sLng * sLng;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function computeMetrics(points) {
    var n = points.length;
    var result = { area: 0, walked: 0, gap: 0, perimeter: 0, avgAccuracy: 0, count: n };
    if (!n) {
      return result;
    }

    var i;
    var lat0 = 0;
    var lng0 = 0;
    for (i = 0; i < n; i++) {
      lat0 += points[i].lat;
      lng0 += points[i].lng;
    }
    lat0 /= n;
    lng0 /= n;

    var cosLat = Math.cos(lat0 * RAD);
    var xs = new Array(n);
    var ys = new Array(n);
    for (i = 0; i < n; i++) {
      xs[i] = (points[i].lng - lng0) * RAD * EARTH_RADIUS * cosLat;
      ys[i] = (points[i].lat - lat0) * RAD * EARTH_RADIUS;
    }

    var twice = 0;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      twice += xs[i] * ys[j] - xs[j] * ys[i];
    }
    result.area = Math.abs(twice) / 2;

    for (i = 1; i < n; i++) {
      result.walked += haversine(points[i - 1], points[i]);
    }
    if (n > 1) {
      result.gap = haversine(points[n - 1], points[0]);
    }
    result.perimeter = result.walked + result.gap;

    var accSum = 0;
    var accCount = 0;
    for (i = 0; i < n; i++) {
      if (isFinite(points[i].acc) && points[i].acc > 0) {
        accSum += points[i].acc;
        accCount++;
      }
    }
    result.avgAccuracy = accCount ? accSum / accCount : 0;
    return result;
  }

  function areaParts(area) {
    if (!isFinite(area) || area <= 0) {
      return { num: '0', unit: 'm²' };
    }
    var rounded = Math.round(area);
    if (rounded >= 10000) {
      return { num: (area / 10000).toFixed(2), unit: '万m²' };
    }
    if (rounded >= 1000) {
      return { num: rounded.toLocaleString('en-US'), unit: 'm²' };
    }
    if (rounded >= 10) {
      return { num: String(rounded), unit: 'm²' };
    }
    return { num: area.toFixed(1), unit: 'm²' };
  }

  function perimeterParts(meters) {
    if (!isFinite(meters) || meters <= 0) {
      return { num: '0', unit: 'm' };
    }
    var rounded = Math.round(meters);
    if (rounded >= 1000) {
      return { num: (meters / 1000).toFixed(2), unit: 'km' };
    }
    if (rounded >= 100) {
      return { num: String(rounded), unit: 'm' };
    }
    return { num: meters.toFixed(1), unit: 'm' };
  }

  function areaLabel(area) {
    var p = areaParts(area);
    return p.num + ' ' + p.unit;
  }

  function perimeterLabel(meters) {
    var p = perimeterParts(meters);
    return p.num + ' ' + p.unit;
  }

  function accuracyLabel(accuracy) {
    if (!isFinite(accuracy) || accuracy <= 0) {
      return '±— m';
    }
    return '±' + Math.max(1, Math.round(accuracy)) + ' m';
  }

  function gapLabel(gap) {
    if (!isFinite(gap) || gap < 0.05) {
      return '0 m';
    }
    if (gap < 10) {
      return gap.toFixed(1) + ' m';
    }
    return Math.round(gap) + ' m';
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatDateTime(timestamp) {
    if (!timestamp) {
      return '—';
    }
    var d = new Date(timestamp);
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatDateTimeFull(timestamp) {
    var d = new Date(timestamp);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatStamp(timestamp) {
    var d = new Date(timestamp);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function formatDuration(milliseconds) {
    var seconds = Math.max(0, Math.round(milliseconds / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rest = seconds % 60;
    if (hours > 0) {
      return hours + ' 小时 ' + pad2(minutes) + ' 分';
    }
    if (minutes > 0) {
      return minutes + ' 分 ' + pad2(rest) + ' 秒';
    }
    return rest + ' 秒';
  }

  function normalisePosition(position) {
    if (!position || !position.coords) {
      return null;
    }
    var lat = Number(position.coords.latitude);
    var lng = Number(position.coords.longitude);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return null;
    }
    var acc = Number(position.coords.accuracy);
    if (!isFinite(acc) || acc < 0) {
      acc = 0;
    }
    return {
      lat: lat,
      lng: lng,
      acc: acc,
      t: Number(position.timestamp) || Date.now()
    };
  }

  function isSecureContextNow() {
    return !!(window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  }

  /* ======================= 状态渲染 ======================= */

  function setPhase(phase) {
    state.phase = phase;
    el.app.setAttribute('data-phase', phase);
    if (phase !== 'running') {
      el.app.setAttribute('data-signal', 'normal');
    }
  }

  function updateUI() {
    var metrics = computeMetrics(state.points);
    var area = areaParts(metrics.area);
    var circumference = perimeterParts(metrics.walked);

    el.statPoints.textContent = String(state.points.length);
    el.statPerimeter.textContent = circumference.num;
    el.statPerimeterUnit.textContent = circumference.unit;
    el.statArea.textContent = area.num;
    el.statAreaUnit.textContent = area.unit;

    updateGpsBar(metrics);
    updateChip(metrics);
    updateMainButton();
    updateModes();
    updateHint();
    updateManualPin();
    updateCanvasLabel(metrics);
    el.demoBadge.hidden = !state.demo;
    queueDraw(metrics);
  }

  function updateGpsBar(metrics) {
    var labels = {
      idle: 'GPS 未开始',
      requesting: 'GPS 定位中…',
      running: 'GPS 测量中',
      paused: 'GPS 已暂停',
      closed: 'GPS 已暂停',
      error: 'GPS 不可用'
    };
    var stale = false;
    if (state.phase === 'running' && state.lastFixAt) {
      stale = Date.now() - state.lastFixAt > 25000;
    }
    el.gpsText.textContent = stale ? 'GPS 信号弱' : (labels[state.phase] || labels.idle);
    el.app.setAttribute('data-signal', stale ? 'weak' : 'normal');

    var accuracy = null;
    if (state.current && state.current.acc) {
      accuracy = state.current.acc;
    } else if (state.points.length) {
      accuracy = state.points[state.points.length - 1].acc;
    }
    el.accuracyText.textContent = accuracyLabel(accuracy);
    el.gpsAcc.classList.toggle('bad', !!(accuracy && accuracy > 20));
  }

  function updateChip(metrics) {
    var label;
    if (state.closed && state.points.length >= 3) {
      label = '已闭合 · 面积 ' + areaLabel(metrics.area);
    } else if (state.points.length >= 3) {
      if (state.phase === 'running') {
        label = '测量中 · 当前围成 ' + areaLabel(metrics.area);
      } else {
        label = '已暂停 · 当前围成 ' + areaLabel(metrics.area);
      }
    } else if (state.phase === 'requesting') {
      label = '正在定位 · 面积 —';
    } else if (state.phase === 'running' || state.phase === 'paused') {
      label = '等待定位 · 面积 —';
    } else if (state.phase === 'error') {
      label = '定位失败 · 面积 —';
    } else {
      label = '等待开始 · 面积 —';
    }
    el.chipText.textContent = label;
  }

  function updateMainButton() {
    var label = '开始测量';
    var icon = 'play';
    var disabled = false;

    if (state.phase === 'requesting') {
      label = '正在定位…';
      icon = 'spinner';
      disabled = true;
    } else if (state.phase === 'running') {
      label = '暂停测量';
      icon = 'pause';
    } else if (state.phase === 'paused') {
      label = '继续测量';
      icon = 'play';
    } else if (state.phase === 'closed') {
      label = '继续测量';
      icon = 'play';
    } else if (state.phase === 'error') {
      label = '重新定位';
      icon = 'play';
    }

    el.mainLabel.textContent = label;
    el.mainBtn.disabled = disabled;
    el.mainBtn.setAttribute('aria-label', label);
    el.mainPlay.hidden = icon !== 'play';
    el.mainPause.hidden = icon !== 'pause';
    el.mainSpinner.hidden = icon !== 'spinner';
  }

  function updateModes() {
    var auto = state.mode === 'auto';
    el.modeAuto.classList.toggle('is-active', auto);
    el.modeManual.classList.toggle('is-active', !auto);
    el.modeAuto.setAttribute('aria-pressed', auto ? 'true' : 'false');
    el.modeManual.setAttribute('aria-pressed', auto ? 'false' : 'true');
  }

  function updateHint() {
    var visible = state.points.length === 0 && !ui.noticeOpen && state.phase !== 'error';
    var title = '绕地块走一圈';
    var sub = '点下方“开始测量”，回到起点后闭合';

    if (state.phase === 'requesting') {
      title = '正在获取定位';
      sub = '首次定位约需 10–30 秒，请到室外开阔处稍候';
    } else if (state.phase === 'running') {
      if (state.mode === 'manual') {
        title = '手动打点模式';
        sub = '精度稳定后自动记录起点，之后点“打点”记录当前位置';
      } else {
        title = '正在等待稳定信号';
        sub = '精度达标后自动记录起点，继续沿边界行走';
      }
    } else if (state.phase === 'paused') {
      title = '测量已暂停';
      sub = '点下方“继续测量”接着记录';
    } else if (state.phase === 'closed') {
      visible = false;
    }

    el.hintTitle.textContent = title;
    el.hintSub.textContent = sub;
    el.mapHint.classList.toggle('is-hidden', !visible);
  }

  function updateManualPin() {
    el.manualPinBtn.hidden = !(state.phase === 'running' && state.mode === 'manual');
  }

  function updateCanvasLabel(metrics) {
    var label = '已记录 ' + state.points.length + ' 个点，围成面积 ' + areaLabel(metrics.area);
    el.mapCanvas.setAttribute('aria-label', '测量轨迹示意图：' + label);
  }

  /* ======================= 地图 ======================= */

  function queueDraw(metrics) {
    ui.pendingMetrics = metrics || null;
    if (ui.drawQueued) {
      return;
    }
    ui.drawQueued = true;
    window.requestAnimationFrame(function () {
      ui.drawQueued = false;
      drawMap(ui.pendingMetrics);
    });
  }

  function setupCanvas() {
    var rect = el.mapPanel.getBoundingClientRect();
    var width = Math.max(1, Math.round(rect.width));
    var height = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var canvas = el.mapCanvas;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ui.mapWidth = width;
    ui.mapHeight = height;
    ui.dpr = dpr;
    queueDraw(computeMetrics(state.points));
  }

  function projectPoints(points) {
    var n = points.length;
    var lat0 = 0;
    var lng0 = 0;
    var i;
    for (i = 0; i < n; i++) {
      lat0 += points[i].lat;
      lng0 += points[i].lng;
    }
    lat0 /= n;
    lng0 /= n;
    var cosLat = Math.cos(lat0 * RAD);
    var xs = new Array(n);
    var ys = new Array(n);
    for (i = 0; i < n; i++) {
      xs[i] = (points[i].lng - lng0) * RAD * EARTH_RADIUS * cosLat;
      ys[i] = (points[i].lat - lat0) * RAD * EARTH_RADIUS;
    }
    return { xs: xs, ys: ys, lat0: lat0, lng0: lng0, cosLat: cosLat };
  }

  function makeTransform(projection, width, height) {
    var xs = projection.xs;
    var ys = projection.ys;
    var minX = Infinity;
    var maxX = -Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    var i;
    for (i = 0; i < xs.length; i++) {
      if (xs[i] < minX) { minX = xs[i]; }
      if (xs[i] > maxX) { maxX = xs[i]; }
      if (ys[i] < minY) { minY = ys[i]; }
      if (ys[i] > maxY) { maxY = ys[i]; }
    }
    var spanX = Math.max(1, maxX - minX);
    var spanY = Math.max(1, maxY - minY);
    var topPad = height < 270 ? 50 : 76;
    var bottomPad = height < 270 ? 28 : 52;
    var sidePad = width < 360 ? 28 : 44;
    var availableW = Math.max(30, width - sidePad * 2);
    var availableH = Math.max(30, height - topPad - bottomPad);
    var scale = Math.min(availableW / spanX, availableH / spanY);
    scale = Math.max(0.02, Math.min(24, scale));
    var midX = (minX + maxX) / 2;
    var midY = (minY + maxY) / 2;
    var centerX = width / 2;
    var centerY = topPad + (height - topPad - bottomPad) / 2;
    return {
      scale: scale,
      x: function (meters) { return centerX + (meters - midX) * scale; },
      y: function (meters) { return centerY - (meters - midY) * scale; }
    };
  }

  function drawGrid(ctx, width, height) {
    var gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#fbfcfe');
    gradient.addColorStop(1, '#ffffff');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    var step = 46;
    ctx.beginPath();
    var x;
    var y;
    for (x = 0; x <= width; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (y = 0; y <= height; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.strokeStyle = '#eef2f7';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawMap(metrics) {
    var canvas = el.mapCanvas;
    if (!canvas || !ui.mapWidth || !ui.mapHeight) {
      setupCanvas();
      return;
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    var width = ui.mapWidth;
    var height = ui.mapHeight;
    var dpr = ui.dpr || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, width, height);

    var points = state.points;
    if (!points.length) {
      return;
    }

    var projection = projectPoints(points);
    var transform = makeTransform(projection, width, height);
    var screen = new Array(points.length);
    var i;
    for (i = 0; i < points.length; i++) {
      screen[i] = {
        x: transform.x(projection.xs[i]),
        y: transform.y(projection.ys[i])
      };
    }

    var closedShape = state.closed && points.length >= 3;

    if (points.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(screen[0].x, screen[0].y);
      for (i = 1; i < screen.length; i++) {
        ctx.lineTo(screen[i].x, screen[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = closedShape ? 'rgba(46, 138, 87, 0.09)' : 'rgba(46, 138, 87, 0.05)';
      ctx.fill();
    }

    if (state.current) {
      var currentX = (state.current.lng - projection.lng0) * RAD * EARTH_RADIUS * projection.cosLat;
      var currentY = (state.current.lat - projection.lat0) * RAD * EARTH_RADIUS;
      var currentPoint = {
        x: transform.x(currentX),
        y: transform.y(currentY)
      };
      if (state.current.acc > 0) {
        var accuracyRadius = Math.min(90, Math.max(5, state.current.acc * transform.scale));
        ctx.beginPath();
        ctx.arc(currentPoint.x, currentPoint.y, accuracyRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(47, 111, 179, 0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(47, 111, 179, 0.14)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    function tracePath() {
      ctx.beginPath();
      ctx.moveTo(screen[0].x, screen[0].y);
      for (i = 1; i < screen.length; i++) {
        ctx.lineTo(screen[i].x, screen[i].y);
      }
      if (closedShape) {
        ctx.closePath();
      }
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    tracePath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.lineWidth = 9;
    ctx.shadowColor = 'rgba(47, 111, 179, 0.10)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    tracePath();
    ctx.strokeStyle = '#2f6fb3';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.restore();

    if (state.current && !state.closed) {
      var cx = screen[0];
      if (state.current) {
        var currentX2 = (state.current.lng - projection.lng0) * RAD * EARTH_RADIUS * projection.cosLat;
        var currentY2 = (state.current.lat - projection.lat0) * RAD * EARTH_RADIUS;
        cx = {
          x: transform.x(currentX2),
          y: transform.y(currentY2)
        };
      }
      drawCurrentDot(ctx, cx.x, cx.y);
    } else if (state.demo && state.current) {
      var demoX = (state.current.lng - projection.lng0) * RAD * EARTH_RADIUS * projection.cosLat;
      var demoY = (state.current.lat - projection.lat0) * RAD * EARTH_RADIUS;
      drawCurrentDot(ctx, transform.x(demoX), transform.y(demoY));
    }

    drawStartDot(ctx, screen[0].x, screen[0].y);
  }

  function drawStartDot(ctx, x, y) {
    ctx.save();
    ctx.shadowColor = 'rgba(160, 37, 31, 0.28)';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, 5.8, 0, Math.PI * 2);
    ctx.fillStyle = '#cf4238';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 1.7, y - 1.9, 1.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
  }

  function drawCurrentDot(ctx, x, y) {
    ctx.save();
    ctx.shadowColor = 'rgba(35, 86, 147, 0.3)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(x, y, 9.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, 6.2, 0, Math.PI * 2);
    ctx.fillStyle = '#2f6fb3';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  /* ======================= 定位流程 ======================= */

  function startFlow() {
    if (state.phase === 'requesting') {
      return;
    }
    if (ui.noticeOpen) {
      hideNotice();
    }
    if (!isSecureContextNow()) {
      showNotice('insecure');
      return;
    }
    if (!('geolocation' in navigator)) {
      showNotice('unsupported');
      return;
    }
    if (state.demo) {
      exitDemo();
    }
    if (state.closed) {
      state.closed = false;
      state.closedAt = null;
      state.snapshot = null;
      closeResult();
    }

    setPhase('requesting');
    updateUI();

    var seq = ++ui.requestSeq;
    window.clearTimeout(ui.startTimer);
    ui.startTimer = window.setTimeout(function () {
      if (seq === ui.requestSeq && state.phase === 'requesting') {
        failStart({ code: 3 });
      }
    }, 28000);

    try {
      navigator.geolocation.getCurrentPosition(
        function (position) {
          if (seq !== ui.requestSeq) {
            return;
          }
          onFirstPosition(position);
        },
        function (error) {
          if (seq !== ui.requestSeq) {
            return;
          }
          failStart(error);
        },
        FIRST_OPTIONS
      );
    } catch (err) {
      failStart({ code: 2 });
    }
  }

  function onFirstPosition(position) {
    if (state.phase !== 'requesting') {
      return;
    }
    window.clearTimeout(ui.startTimer);
    var fix = normalisePosition(position);
    if (!fix) {
      failStart({ code: 2 });
      return;
    }

    state.current = fix;
    state.lastFixAt = Date.now();
    startWatch();
    setPhase('running');
    acquireWakeLock();

    if (fix.acc > 0 && fix.acc <= MAX_ACCURACY) {
      recordPoint(fix, true);
    } else {
      showToast('已连接 GPS，等待精度稳定…', 2800);
    }
    updateUI();
  }

  function failStart(error) {
    window.clearTimeout(ui.startTimer);
    if (state.phase !== 'requesting') {
      return;
    }
    stopWatch();
    releaseWakeLock();
    setPhase(state.points.length ? 'paused' : 'error');
    updateUI();
    saveState();
    var code = error && error.code;
    showNotice(code === 1 ? 'denied' : code === 3 ? 'timeout' : 'unavailable');
  }

  function startWatch() {
    stopWatch();
    if (!('geolocation' in navigator)) {
      return;
    }
    try {
      state.watchId = navigator.geolocation.watchPosition(onPosition, onWatchError, WATCH_OPTIONS);
    } catch (err) {
      onWatchError({ code: 2 });
    }
  }

  function stopWatch() {
    if (state.watchId !== null) {
      try {
        navigator.geolocation.clearWatch(state.watchId);
      } catch (err) {
        /* 忽略清理失败 */
      }
      state.watchId = null;
    }
  }

  function onPosition(position) {
    var fix = normalisePosition(position);
    if (!fix) {
      return;
    }
    state.current = fix;
    state.lastFixAt = Date.now();

    if (state.phase === 'running') {
      if (state.points.length === 0) {
        if (fix.acc <= MAX_ACCURACY) {
          recordPoint(fix, true);
        }
      } else if (state.mode === 'auto') {
        maybeAutoRecord(fix);
      }
    }
    updateUI();
  }

  function onWatchError(error) {
    if (state.phase !== 'running') {
      return;
    }
    var code = error && error.code;
    if (code === 1) {
      stopWatch();
      releaseWakeLock();
      setPhase(state.points.length ? 'paused' : 'error');
      updateUI();
      saveState();
      showNotice('denied');
      return;
    }

    var now = Date.now();
    if (now - ui.lastGeoWarnAt > 20000) {
      ui.lastGeoWarnAt = now;
      showToast('GPS 信号暂时较弱，正在自动重试…', 2400);
    }
  }

  function maybeAutoRecord(fix) {
    if (fix.acc > MAX_ACCURACY) {
      warnAccuracy(fix);
      return false;
    }
    var last = state.points[state.points.length - 1];
    if (!last) {
      return recordPoint(fix, true);
    }

    var distance = haversine(last, fix);
    if (distance < 0.9) {
      return false;
    }
    var elapsed = Math.max(1, (Date.now() - state.lastRecordAt) / 1000);
    if (distance > 120 && elapsed < 45) {
      return false;
    }
    if (distance / elapsed > 8) {
      return false;
    }
    var minDistance = Math.min(8, Math.max(2, fix.acc * ACCURACY_FACTOR));
    if (distance < minDistance) {
      return false;
    }
    return recordPoint(fix, false);
  }

  function warnAccuracy(fix) {
    var now = Date.now();
    if (now - ui.lastAccWarnAt < 30000) {
      return;
    }
    ui.lastAccWarnAt = now;
    showToast('当前精度 ' + accuracyLabel(fix.acc) + '，暂不记录轨迹', 2600);
  }

  function recordPoint(fix, isStart) {
    if (!fix) {
      return false;
    }
    if (state.points.length >= MAX_POINTS) {
      showToast('记录点已达上限，请先闭合或重置', 2800);
      return false;
    }
    var last = state.points[state.points.length - 1];
    if (last && haversine(last, fix) < 0.6) {
      return false;
    }
    var point = {
      lat: round(fix.lat, 7),
      lng: round(fix.lng, 7),
      acc: round(Math.min(999, Math.max(0, fix.acc || 0)), 1),
      t: Date.now()
    };
    state.points.push(point);
    state.lastRecordAt = Date.now();
    if (!state.startedAt) {
      state.startedAt = state.lastRecordAt;
    }
    saveState();
    updateUI();
    if (isStart) {
      showToast('起点已记录，沿地块边界走一圈', 2600);
    }
    return true;
  }

  function addManualPoint() {
    if (state.phase !== 'running') {
      showToast('请先继续测量', 1800);
      return;
    }
    if (!state.current) {
      showToast('还没取得定位，请稍候', 1800);
      return;
    }
    if (state.current.acc > MAX_ACCURACY) {
      showToast('当前精度 ' + accuracyLabel(state.current.acc) + '，等信号稳定再打点', 2400);
      return;
    }
    var last = state.points[state.points.length - 1];
    if (last && haversine(last, state.current) < 0.9) {
      showToast('离上一点太近，再走几步再打点', 1800);
      return;
    }
    var added = recordPoint(state.current, state.points.length === 0);
    if (added) {
      var count = state.points.length;
      showToast(count === 1 ? '起点已记录' : '已打点 · 共 ' + count + ' 点', 1500);
    }
  }

  function pauseMeasurement() {
    if (state.phase !== 'running') {
      return;
    }
    stopWatch();
    releaseWakeLock();
    setPhase('paused');
    saveState();
    updateUI();
    showToast('测量已暂停，记录已保存', 2000);
  }

  /* ======================= 闭合与结果 ======================= */

  function buildSnapshot() {
    var metrics = computeMetrics(state.points);
    return {
      area: metrics.area,
      walked: metrics.walked,
      gap: metrics.gap,
      perimeter: metrics.perimeter,
      avgAccuracy: metrics.avgAccuracy,
      count: state.points.length,
      mode: state.mode,
      startedAt: state.startedAt,
      closedAt: state.closedAt || Date.now()
    };
  }

  function closePolygon() {
    if (state.closed && state.points.length >= 3) {
      openResult();
      return;
    }
    if (state.points.length < 3) {
      showToast('至少记录 3 个点才能闭合', 2200);
      return;
    }
    var metrics = computeMetrics(state.points);
    if (metrics.area < 1) {
      showToast('围成面积过小，请继续测量', 2200);
      return;
    }

    window.clearTimeout(ui.startTimer);
    ui.requestSeq++;
    stopWatch();
    releaseWakeLock();
    state.closed = true;
    state.closedAt = Date.now();
    state.snapshot = buildSnapshot();
    setPhase('closed');
    saveState();
    updateUI();
    openResult();
  }

  function renderResult(snapshot) {
    var parts = areaParts(snapshot.area);
    el.resultAreaNum.textContent = parts.num;
    el.resultAreaUnit.textContent = parts.unit;
    el.resultExactArea.textContent = '≈ ' + Math.round(snapshot.area).toLocaleString('en-US') + ' m²';
    el.resultMu.textContent = '≈ ' + (snapshot.area / 666.6666667).toFixed(2) + ' 亩';
    el.resultPerimeter.textContent = perimeterLabel(snapshot.perimeter);
    el.resultPoints.textContent = String(snapshot.count);
    el.resultAccuracy.textContent = accuracyLabel(snapshot.avgAccuracy);
    el.resultGap.textContent = gapLabel(snapshot.gap);

    var warnings = [];
    if (snapshot.mode === 'auto' && snapshot.count < 10) {
      warnings.push('自动记录的点较少（' + snapshot.count + ' 个），面积误差可能偏大。');
    }
    if (snapshot.gap > Math.max(6, snapshot.perimeter * 0.08)) {
      warnings.push('闭合差 ' + gapLabel(snapshot.gap) + '，建议回到起点附近再闭合。');
    }
    if (snapshot.avgAccuracy > 10) {
      warnings.push('平均定位精度 ' + accuracyLabel(snapshot.avgAccuracy) + '，结果仅供参考。');
    }
    if (state.demo) {
      warnings.push('这是演示数据，不是真实 GPS 测量。');
    }
    el.resultWarning.hidden = warnings.length === 0;
    el.resultWarning.textContent = warnings.join(' ');

    var closedAt = snapshot.closedAt || Date.now();
    var elapsed = closedAt - (snapshot.startedAt || closedAt);
    el.resultTime.textContent = formatDateTime(closedAt) + ' · 用时 ' + formatDuration(elapsed);
    el.resultMode.textContent = (snapshot.mode === 'manual' ? '手动打点' : '自动记录') +
      (state.demo ? ' · 演示' : '');
  }

  function openResult() {
    if (state.points.length < 3) {
      showToast('至少需要 3 个点才能查看结果', 2000);
      return;
    }
    var snapshot = state.snapshot || buildSnapshot();
    renderResult(snapshot);
    ui.lastFocus = document.activeElement;
    ui.sheetOpen = true;
    el.backdrop.classList.add('is-open');
    el.backdrop.setAttribute('aria-hidden', 'false');
    el.resultSheet.classList.add('is-open');
    el.resultSheet.setAttribute('aria-hidden', 'false');
    window.setTimeout(function () {
      try {
        el.resultSheet.focus({ preventScroll: true });
      } catch (err) {
        el.resultSheet.focus();
      }
    }, 180);
  }

  function closeResult() {
    if (!ui.sheetOpen) {
      return;
    }
    ui.sheetOpen = false;
    el.backdrop.classList.remove('is-open');
    el.backdrop.setAttribute('aria-hidden', 'true');
    el.resultSheet.classList.remove('is-open');
    el.resultSheet.setAttribute('aria-hidden', 'true');
    if (ui.lastFocus && typeof ui.lastFocus.focus === 'function') {
      try {
        ui.lastFocus.focus({ preventScroll: true });
      } catch (err) {
        /* 忽略焦点恢复失败 */
      }
    }
  }

  function resumeFromResult() {
    closeResult();
    if (state.demo) {
      exitDemo();
      startFlow();
      return;
    }
    if (state.closed) {
      state.closed = false;
      state.closedAt = null;
      state.snapshot = null;
    }
    startFlow();
  }

  /* ======================= 重置 ======================= */

  function requestReset() {
    if (!state.points.length && state.phase === 'idle' && !state.demo) {
      showToast('当前没有可重置的数据', 1800);
      return;
    }
    el.confirmText.textContent = state.points.length
      ? '将清空已记录的 ' + state.points.length + ' 个点、面积结果和本机缓存，且无法恢复。'
      : '将结束当前测量并清空本机缓存。';
    ui.confirmOpen = true;
    el.confirmMask.classList.add('is-open');
    el.confirmMask.setAttribute('aria-hidden', 'false');
    try {
      el.confirmOk.focus({ preventScroll: true });
    } catch (err) {
      el.confirmOk.focus();
    }
  }

  function closeConfirm() {
    ui.confirmOpen = false;
    el.confirmMask.classList.remove('is-open');
    el.confirmMask.setAttribute('aria-hidden', 'true');
  }

  function hardReset() {
    closeConfirm();
    closeResult();
    hideNotice();
    window.clearTimeout(ui.startTimer);
    window.clearTimeout(ui.toastTimer);
    ui.requestSeq++;
    stopWatch();
    releaseWakeLock();
    var mode = state.mode;
    state.points = [];
    state.current = null;
    state.closed = false;
    state.startedAt = null;
    state.closedAt = null;
    state.snapshot = null;
    state.demo = false;
    state.lastFixAt = 0;
    state.lastRecordAt = 0;
    state.mode = mode;
    setPhase('idle');
    clearSaved();
    updateUI();
    showToast('已重置，可以开始新的测量', 2200);
  }

  function exitDemo() {
    state.demo = false;
    state.points = [];
    state.current = null;
    state.closed = false;
    state.startedAt = null;
    state.closedAt = null;
    state.snapshot = null;
    setPhase('idle');
    updateUI();
  }

  /* ======================= 提示与通知 ======================= */

  function showNotice(type) {
    var config;
    if (type === 'insecure') {
      config = {
        title: '需要 HTTPS 才能定位',
        body: '<p>iPhone Safari 只允许 <code>https://</code> 页面获取位置。当前页面无法调用 GPS。</p><p>请使用配套的本地 HTTPS 服务打开，或把 <code>app</code> 文件夹部署到任意 HTTPS 静态托管后再访问。</p>',
        primary: '我已知晓',
        secondary: null,
        action: hideNotice
      };
    } else if (type === 'denied') {
      config = {
        title: '定位权限被拒绝',
        body: '<p>系统或浏览器没有允许本页使用位置。请在 iPhone 上检查：</p><ol><li>设置 → 隐私与安全性 → 定位服务，确认已开启</li><li>定位服务 → Safari 网站 → 使用 App 期间</li><li>打开“精确位置”，然后重新载入本页</li></ol>',
        primary: '重新定位',
        secondary: '关闭',
        action: function () {
          hideNotice();
          startFlow();
        }
      };
    } else if (type === 'timeout') {
      config = {
        title: '定位超时',
        body: '<p>暂时没有收到卫星定位。请：</p><ol><li>走到室外开阔处，避开楼体和树荫</li><li>确认蜂窝网络与定位服务已开启</li><li>首次定位通常需要 10–30 秒</li></ol>',
        primary: '重新定位',
        secondary: '关闭',
        action: function () {
          hideNotice();
          startFlow();
        }
      };
    } else if (type === 'unsupported') {
      config = {
        title: '此设备不支持定位',
        body: '<p>请使用 iPhone 的 Safari 浏览器，并确保系统定位服务已开启。</p>',
        primary: '知道了',
        secondary: null,
        action: hideNotice
      };
    } else {
      config = {
        title: '无法获取定位',
        body: '<p>请走到室外开阔处，确认定位服务和蜂窝网络已开启，然后重试。</p>',
        primary: '重新定位',
        secondary: '关闭',
        action: function () {
          hideNotice();
          startFlow();
        }
      };
    }

    el.noticeTitle.textContent = config.title;
    el.noticeBody.innerHTML = config.body;
    el.noticePrimary.textContent = config.primary;
    el.noticePrimary.hidden = false;
    if (config.secondary) {
      el.noticeSecondary.textContent = config.secondary;
      el.noticeSecondary.hidden = false;
    } else {
      el.noticeSecondary.hidden = true;
    }
    ui.noticeAction = config.action;
    ui.noticeOpen = true;
    el.notice.classList.add('is-open');
    el.notice.setAttribute('aria-hidden', 'false');
    updateHint();
  }

  function hideNotice() {
    if (!ui.noticeOpen) {
      return;
    }
    ui.noticeOpen = false;
    el.notice.classList.remove('is-open');
    el.notice.setAttribute('aria-hidden', 'true');
    updateHint();
  }

  function showToast(message, duration) {
    el.toast.textContent = message;
    el.toast.classList.add('is-show');
    window.clearTimeout(ui.toastTimer);
    ui.toastTimer = window.setTimeout(function () {
      el.toast.classList.remove('is-show');
    }, duration || 2200);
  }

  /* ======================= 唤醒锁 ======================= */

  function acquireWakeLock() {
    if (!('wakeLock' in navigator) || !navigator.wakeLock || document.visibilityState !== 'visible') {
      return;
    }
    if (state.wakeLock) {
      return;
    }
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        state.wakeLock = lock;
        lock.addEventListener('release', function () {
          state.wakeLock = null;
        });
      }).catch(function () {
        state.wakeLock = null;
      });
    } catch (err) {
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      try {
        state.wakeLock.release();
      } catch (err) {
        /* 忽略释放失败 */
      }
      state.wakeLock = null;
    }
  }

  /* ======================= 数据持久化 ======================= */

  function saveState() {
    if (state.demo) {
      return;
    }
    try {
      var payload = {
        v: 1,
        points: state.points,
        mode: state.mode,
        closed: state.closed,
        startedAt: state.startedAt,
        closedAt: state.closedAt,
        savedAt: Date.now()
      };
      window.localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (err) {
      /* 隐私模式或配额不足时静默降级 */
    }
  }

  function clearSaved() {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }

  function restoreSaved() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (err) {
      return false;
    }
    if (!raw) {
      return false;
    }
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return false;
    }
    if (!data || !Array.isArray(data.points) || !data.points.length) {
      return false;
    }

    var points = [];
    var i;
    for (i = 0; i < data.points.length && i < MAX_POINTS; i++) {
      var item = data.points[i];
      if (!item) {
        continue;
      }
      var lat = Number(item.lat);
      var lng = Number(item.lng);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        continue;
      }
      points.push({
        lat: lat,
        lng: lng,
        acc: isFinite(Number(item.acc)) ? Math.max(0, Number(item.acc)) : 0,
        t: isFinite(Number(item.t)) ? Number(item.t) : Date.now()
      });
    }
    if (!points.length) {
      return false;
    }

    state.points = points;
    state.mode = data.mode === 'manual' ? 'manual' : 'auto';
    state.closed = !!data.closed && points.length >= 3;
    state.startedAt = isFinite(Number(data.startedAt)) ? Number(data.startedAt) : points[0].t;
    state.closedAt = isFinite(Number(data.closedAt)) ? Number(data.closedAt) : null;
    state.lastRecordAt = points[points.length - 1].t || Date.now();
    state.current = null;
    state.demo = false;
    setPhase(state.closed ? 'closed' : 'paused');
    state.snapshot = state.closed ? buildSnapshot() : null;
    return true;
  }

  /* ======================= 复制与导出 ======================= */

  function buildSummary() {
    var metrics = computeMetrics(state.points);
    var snapshot = state.snapshot || buildSnapshot();
    var lines = [];
    lines.push('GPS 实测面积');
    lines.push('面积：' + areaLabel(snapshot.area) + '（约 ' + Math.round(snapshot.area).toLocaleString('en-US') + ' m²，约 ' + (snapshot.area / 666.6666667).toFixed(2) + ' 亩）');
    lines.push('围成周长：' + perimeterLabel(snapshot.perimeter));
    lines.push('记录点：' + state.points.length + ' 个');
    lines.push('平均精度：' + accuracyLabel(metrics.avgAccuracy));
    lines.push('闭合差：' + gapLabel(metrics.gap));
    lines.push('时间：' + formatDateTime(snapshot.closedAt || Date.now()));
    lines.push('公式：A = ½ |Σ(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)|（格林公式离散形式）');
    return lines.join('\n');
  }

  function copyResult() {
    var text = buildSummary();
    function done() {
      showToast('结果已复制到剪贴板', 2000);
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '0';
      area.style.width = '1px';
      area.style.height = '1px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      showToast(ok ? '结果已复制到剪贴板' : '复制失败，请长按选择文本', 2500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function buildCsv() {
    var lines = ['序号,纬度,经度,精度(m),记录时间'];
    var i;
    for (i = 0; i < state.points.length; i++) {
      var p = state.points[i];
      lines.push([
        String(i + 1),
        Number(p.lat).toFixed(7),
        Number(p.lng).toFixed(7),
        Number(p.acc || 0).toFixed(1),
        formatDateTimeFull(p.t || Date.now())
      ].join(','));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  function downloadBlob(content, filename) {
    var blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function exportCSV() {
    if (!state.points.length) {
      showToast('没有可导出的点位', 1800);
      return;
    }
    var csv = buildCsv();
    var filename = (state.demo ? 'GPS_demo_' : 'GPS_area_') + formatStamp(Date.now()) + '.csv';
    var file = null;
    try {
      file = new File([csv], filename, { type: 'text/csv;charset=utf-8' });
    } catch (err) {
      file = null;
    }

    function shareOrDownload() {
      var canShare = false;
      if (file && navigator.canShare && navigator.share) {
        try {
          canShare = navigator.canShare({ files: [file] });
        } catch (err) {
          canShare = false;
        }
      }
      if (canShare) {
        navigator.share({ files: [file], title: 'GPS 实测轨迹' }).catch(function (error) {
          if (error && error.name === 'AbortError') {
            return;
          }
          downloadBlob(csv, filename);
          showToast('已生成 CSV 文件', 2000);
        });
      } else {
        downloadBlob(csv, filename);
        showToast('已生成 CSV 文件', 2000);
      }
    }

    shareOrDownload();
  }

  /* ======================= 演示数据 ======================= */

  function loadDemo() {
    var coords = window.__GPS_DEMO_POINTS;
    if (!coords || !coords.length) {
      return false;
    }
    var now = Date.now();
    var count = coords.length;
    var points = [];
    var i;
    for (i = 0; i < count; i++) {
      points.push({
        lat: coords[i][0],
        lng: coords[i][1],
        acc: 1,
        t: now - (count - 1 - i) * 3000
      });
    }
    state.points = points;
    state.mode = 'auto';
    state.closed = true;
    state.startedAt = points[0].t;
    state.closedAt = now;
    state.lastFixAt = now;
    state.lastRecordAt = points[points.length - 1].t;
    state.demo = true;
    state.current = {
      lat: points[80].lat,
      lng: points[80].lng,
      acc: 1,
      t: now
    };
    setPhase('closed');
    state.snapshot = buildSnapshot();
    updateUI();
    window.setTimeout(function () {
      showToast('演示预览：数据非真实测量，点“重置”退出', 3600);
    }, 500);
    return true;
  }

  /* ======================= 事件 ======================= */

  function onMainClick() {
    if (state.phase === 'requesting') {
      return;
    }
    if (state.phase === 'running') {
      pauseMeasurement();
      return;
    }
    if (ui.sheetOpen) {
      closeResult();
    }
    if (state.demo) {
      exitDemo();
      startFlow();
      return;
    }
    if (state.closed) {
      state.closed = false;
      state.closedAt = null;
      state.snapshot = null;
    }
    startFlow();
  }

  function setMode(mode) {
    if (state.mode === mode) {
      return;
    }
    state.mode = mode;
    saveState();
    updateUI();
    if (state.phase === 'running') {
      if (mode === 'manual') {
        showToast('已切换手动打点：走到拐点后点“打点”记录', 2600);
      } else {
        showToast('已切换自动记录', 1600);
        if (state.current) {
          maybeAutoRecord(state.current);
        }
      }
    }
  }

  function onEscape(event) {
    if (event.key !== 'Escape') {
      return;
    }
    if (ui.confirmOpen) {
      closeConfirm();
      return;
    }
    if (ui.sheetOpen) {
      closeResult();
      return;
    }
    if (ui.noticeOpen) {
      hideNotice();
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      saveState();
      return;
    }
    if (state.phase === 'running') {
      acquireWakeLock();
      if (!state.lastFixAt || Date.now() - state.lastFixAt > 20000) {
        startWatch();
      }
    }
    updateUI();
  }

  function bindEvents() {
    el.mainBtn.addEventListener('click', onMainClick);
    el.modeAuto.addEventListener('click', function () { setMode('auto'); });
    el.modeManual.addEventListener('click', function () { setMode('manual'); });
    el.closeBtn.addEventListener('click', closePolygon);
    el.resetBtn.addEventListener('click', requestReset);
    el.closeBtn.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    el.resetBtn.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    el.manualPinBtn.addEventListener('click', addManualPoint);
    el.mapCanvas.addEventListener('click', function () {
      if (state.phase === 'running' && state.mode === 'manual') {
        addManualPoint();
      }
    });

    el.noticePrimary.addEventListener('click', function () {
      var action = ui.noticeAction;
      if (typeof action === 'function') {
        action();
      } else {
        hideNotice();
      }
    });
    el.noticeSecondary.addEventListener('click', hideNotice);

    el.backdrop.addEventListener('click', closeResult);
    el.sheetCloseBtn.addEventListener('click', closeResult);
    el.sheetResumeBtn.addEventListener('click', resumeFromResult);
    el.copyBtn.addEventListener('click', copyResult);
    el.exportBtn.addEventListener('click', exportCSV);

    el.confirmCancel.addEventListener('click', closeConfirm);
    el.confirmOk.addEventListener('click', hardReset);
    el.confirmMask.addEventListener('click', function (event) {
      if (event.target === el.confirmMask) {
        closeConfirm();
      }
    });

    document.addEventListener('keydown', onEscape);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', function () {
      saveState();
      releaseWakeLock();
    });

    window.addEventListener('resize', function () {
      window.clearTimeout(ui.resizeTimer);
      ui.resizeTimer = window.setTimeout(setupCanvas, 120);
    });
    window.addEventListener('orientationchange', function () {
      window.setTimeout(setupCanvas, 260);
    });

    if ('ResizeObserver' in window) {
      try {
        var observer = new ResizeObserver(function () {
          setupCanvas();
        });
        observer.observe(el.mapPanel);
      } catch (err) {
        /* 忽略观察器失败 */
      }
    }

    window.setInterval(function () {
      if (state.phase === 'running') {
        updateGpsBar(computeMetrics(state.points));
      }
    }, 8000);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      return;
    }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {
        /* 离线缓存失败不影响测量 */
      });
    });
  }

  function init() {
    bindEvents();
    setupCanvas();
    registerServiceWorker();

    if (DEMO && loadDemo()) {
      return;
    }

    var restored = restoreSaved();
    updateUI();
    if (restored) {
      window.setTimeout(function () {
        showToast('已恢复上次测量：' + state.points.length + ' 个点', 2800);
      }, 500);
    }
    if (!isSecureContextNow()) {
      window.setTimeout(function () {
        showNotice('insecure');
      }, 420);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
