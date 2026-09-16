/* K一把 · KARDS卡牌猜测游戏 · 纯静态单机版(无后端,双击 index.html 即玩)
 * ---------------------------------------------------------------
 * 基于 kayiba「卡一把」(Rainfall66/kayiba, AGPL-3.0)换皮改造,
 * kayiba 派生自 shnlfriberg/csgofriberg(AGPL-3.0)。
 *
 * 判定规则(KARDS卡牌数据库版,共 1590 张可猜卡):
 * - 国籍 / 类型 / 稀有度 / 卡包:与答案相同 = 绿
 * - 费用:相同 = 绿;相差 1 = 黄 + ▲▼箭头;否则灰
 * - 未知属性(空值)一律灰 "-"
 * - 8 次机会内猜中卡名即胜
 *
 * 输入联想:
 * - 支持 卡名 / 别名 模糊搜索,候选上限 60 条并做成可滚动列表(应对上千张卡的数据库);
 * - 单位卡的三位数字别名 = 费用+攻击力+防御力(如 3 费 2/4 → "324"),可直接输入;
 *   别名可能撞车(3 位数字覆盖不了 906 张单位),**撞车时不允许直接提交**,必须从候选里点选;
 * - 联想只填入输入框,提交由玩家手动确认。
 *
 * 卡图(可选):
 * - 卡图放在 images/,文件名取自每张卡的 image 字段(cards.js),统一 400×562;
 * - 结算弹窗显示答案卡图;鼠标悬停棋盘的「卡名」格或候选条里的卡名即可预览该卡卡图,
 *   键盘上下键切换候选时预览跟随;
 * - 悬停**不是立刻下载**:指针停稳 120ms 才发请求,免得鼠标扫过候选条时白发一堆请求;
 * - **卡图不是必需品**:images/ 不进版本控制,任何一次加载失败都会静默关掉预览与结算图,
 *   没有卡图时游戏完全照常玩。
 *
 * 数据库: window.KARDSYIBA_CARDS(见 cards.js,1590 张全卡表;由数据流水线 kardsyiba-pipeline 生成)
 */
(function () {
  'use strict';

  var KARDSYIBA = {};
  if (typeof window !== 'undefined') window.KARDSYIBA = KARDSYIBA;   // 也挂到 window,便于测试/调试

  // ---------- 纯逻辑(可被 node 测试) ----------
  var MAX_GUESSES = 8;
  var COST_CLOSE = 1;

  function exactAttr(guessValue, targetValue) {
    // 空值视为未知,无法对比,一律灰色
    if (!guessValue || !targetValue) return { value: guessValue, level: 'wrong' };
    return { value: guessValue, level: guessValue === targetValue ? 'correct' : 'wrong' };
  }

  function costAttr(guessValue, targetValue) {
    if (!Number.isInteger(guessValue) || !Number.isInteger(targetValue)) {
      return { value: guessValue, level: 'wrong' };
    }
    if (guessValue === targetValue) return { value: guessValue, level: 'correct' };
    var level = Math.abs(guessValue - targetValue) <= COST_CLOSE ? 'close' : 'wrong';
    return { value: guessValue, level: level, hint: targetValue > guessValue ? 'higher' : 'lower' };
  }

  /** 逐属性对比:返回 { nickname, correct, attrs } */
  function compare(guess, target) {
    return {
      nickname: guess.nickname,
      correct: guess.nickname === target.nickname,
      attrs: {
        nation: exactAttr(guess.nation, target.nation),
        cost: costAttr(guess.cost, target.cost),
        type: exactAttr(guess.type, target.type),
        rarity: exactAttr(guess.rarity, target.rarity),
        set: exactAttr(guess.set, target.set),
      },
    };
  }

  KARDSYIBA.MAX_GUESSES = MAX_GUESSES;
  KARDSYIBA.compare = compare;
  KARDSYIBA.costAttr = costAttr;

  var CARDS = (typeof window !== 'undefined' && window.KARDSYIBA_CARDS) || [];
  KARDSYIBA.cards = CARDS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KARDSYIBA;
  }

  // ---------- 浏览器 UI ----------
  if (typeof document === 'undefined') return;

  var RECENT_KEY = 'kards-yiba:recent';
  var STATS_KEY = 'kards-yiba:stats';
  var POOL_KEY = 'kards-yiba:pool';
  var TOKEN_KEY = 'kards-yiba:tokens';
  var RECENT_WINDOW_MS = 60 * 60 * 1000;
  // 候选上限:单位别名会撞车(如 334 对应 36 张),上限太小就没法从列表里挑,
  // 因此放宽到 60 条,配合可滚动的候选条使用
  var SUGGESTION_LIMIT = 60;

  // ---------- 卡池模式 ----------
  // 只决定「系统从哪个卡池抽答案」,不改判定规则。
  // - active  现役卡池(reserved !== true)
  // - reserve 预备卡池(reserved === true)
  // - all     全部(现役 + 预备 + 老兵形态),与旧版行为一致
  var POOLS = [
    {
      id: 'active',
      label: '仅现役',
      note: '只从现役卡池抽答案 · 当前天梯 / 休闲可用',
      filter: function (c) { return !c.reserved; },
    },
    {
      id: 'reserve',
      label: '仅预备',
      note: '只从预备卡池抽答案 · 已退役、仅在经典模式可用',
      filter: function (c) { return c.reserved === true; },
    },
    {
      id: 'all',
      label: '全部卡池',
      note: '现役 + 预备全卡表 · 卡名最全',
      filter: function () { return true; },
    },
  ];
  var DEFAULT_POOL = 'all';

  // ---------- 衍生卡开关(与卡池模式相互独立) ----------
  // 衍生牌 = 由卡牌效果生成 / 召唤、**不可收集**的牌,卡库里有 73 张。
  // build_cards.js 会给它们同时打上两个标记(set=衍生、rarity=衍生卡),
  // 这里两个都认,免得将来只改一处就静默失效。
  var TOKEN_SET = '衍生';
  var TOKEN_RARITY = '衍生卡';
  function isToken(c) { return c.set === TOKEN_SET || c.rarity === TOKEN_RARITY; }

  // 两个选项的 id 与 radio 的 data-token 一一对应
  var TOKEN_OPTIONS = [
    { id: 'with', withTokens: true, label: '包含衍生卡' },
    { id: 'without', withTokens: false, label: '排除衍生卡' },
  ];
  var DEFAULT_WITH_TOKENS = true;
  var TOKEN_TOTAL = CARDS.filter(isToken).length;

  function findPool(id) {
    for (var i = 0; i < POOLS.length; i++) {
      if (POOLS[i].id === id) return POOLS[i];
    }
    return null;
  }

  /**
   * 取某个卡池的卡。
   * 第二个参数省略时用当前设置;显式传值便于渲染时把含 / 不含两种张数都算出来。
   */
  function poolCards(id, withTokens) {
    var pool = findPool(id) || findPool(DEFAULT_POOL);
    var wantTokens = withTokens === undefined ? state.withTokens : !!withTokens;
    return CARDS.filter(function (c) {
      return pool.filter(c) && (wantTokens || !isToken(c));
    });
  }

  var state = { target: null, guesses: [], status: 'ready', poolId: DEFAULT_POOL, withTokens: DEFAULT_WITH_TOKENS };
  var $ = function (id) { return document.getElementById(id); };

  function storageGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 忽略 */ }
  }

  function loadRecent() {
    var list = storageGet(RECENT_KEY) || [];
    var cutoff = Date.now() - RECENT_WINDOW_MS;
    return list.filter(function (item) { return item && item.t >= cutoff; });
  }
  function rememberRecent(nickname) {
    var list = loadRecent().filter(function (item) { return item.n !== nickname; });
    list.push({ n: nickname, t: Date.now() });
    storageSet(RECENT_KEY, list.slice(-200));
  }
  function loadStats() {
    return storageGet(STATS_KEY) || { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
  }
  function saveStats(stats) { storageSet(STATS_KEY, stats); }

  function pickTarget(cards) {
    var pool = cards && cards.length ? cards : poolCards(state.poolId);
    var recent = new Set(loadRecent().map(function (item) { return item.n; }));
    var candidates = pool.filter(function (c) { return !recent.has(c.nickname); });
    if (!candidates.length) candidates = pool;
    var target = candidates[Math.floor(Math.random() * candidates.length)];
    rememberRecent(target.nickname);
    return target;
  }

  /**
   * 按输入解析卡牌,返回 { card, by } 或 null。
   * by: 'nickname' 卡名精确匹配 | 'alias' 别名命中(可能多张)
   * 卡名优先于别名;别名可能撞车,所以别名命中只用于联想,不用于直接提交。
   */
  function resolveInput(input, cards) {
    var q = String(input || '').trim().toLowerCase();
    if (!q) return null;
    var source = cards && cards.length ? cards : CARDS;
    var byName = null;
    var byAlias = [];
    for (var i = 0; i < source.length; i++) {
      var c = source[i];
      if (!byName && c.nickname.toLowerCase() === q) byName = c;
      if (c.alias && c.alias.toLowerCase() === q) byAlias.push(c);
    }
    if (byName) return { card: byName, by: 'nickname' };
    if (byAlias.length === 1) return { card: byAlias[0], by: 'alias' };
    if (byAlias.length > 1) return { card: null, by: 'alias-ambiguous', matches: byAlias };
    return null;
  }

  function findCard(input, cards) {
    var r = resolveInput(input, cards);
    return r ? r.card : null;
  }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  // ---------- 棋盘渲染 ----------
  var COLUMNS = [
    { key: 'nickname', label: '卡名' },
    { key: 'nation', label: '国籍' },
    { key: 'cost', label: '费用' },
    { key: 'type', label: '类型' },
    { key: 'rarity', label: '稀有度' },
    { key: 'set', label: '卡包' },
  ];

  function cellHtml(attr) {
    var arrow = attr.hint && attr.level !== 'correct'
      ? '<span class="dir">' + (attr.hint === 'higher' ? '&#9650;' : '&#9660;') + '</span>'
      : '';
    var raw = String(attr.value === undefined || attr.value === null ? '' : attr.value);
    // 费用 0 是有效值(KARDS 有 0 费指令),只有空值才显示 "-"
    var display = raw === '' ? '-' : raw;
    return '<td class="' + attr.level + '">' + escapeHtml(display) + arrow + '</td>';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function renderBoard() {
    var tbody = $('board-body');
    tbody.innerHTML = '';
    state.guesses.forEach(function (row, index) {
      var tr = document.createElement('tr');
      if (index === state.guesses.length - 1) tr.className = 'row-latest';
      if (row.correct) tr.className = (tr.className ? tr.className + ' ' : '') + 'row-correct';
      tr.innerHTML = '<td class="name' + (row.correct ? ' correct' : '') + '" data-image="'
        + escapeHtml(row.image || '') + '">' + escapeHtml(row.nickname) + '</td>'
        + cellHtml(row.attrs.nation)
        + cellHtml(row.attrs.cost)
        + cellHtml(row.attrs.type)
        + cellHtml(row.attrs.rarity)
        + cellHtml(row.attrs.set);
      tbody.appendChild(tr);
    });
    renderProgress();
  }

  function renderProgress() {
    var dots = '';
    for (var i = 0; i < MAX_GUESSES; i++) {
      dots += '<i' + (i < state.guesses.length ? ' class="used"' : '') + '></i>';
    }
    $('progress').innerHTML = dots;
  }

  // ---------- 卡图预览 ----------
  // 卡图是**可选资源**(images/ 不进版本控制,见 README)。所以这里的原则是
  // 「有图就显示,没图就安静地什么都不做」:任何一次加载失败都直接把预览整体关掉,
  // 免得在没下卡图的环境里每次悬停都白发一次 404 请求。
  var IMAGE_DIR = 'images/';
  var CARD_IMAGE_RATIO = 562 / 400;   // 卡图统一 400×562(见流水线 optimize_images.js),用于估算浮层高度
  var imagesAvailable = true;
  var previewState = { visible: false, file: '' };

  // 悬停意图延迟:鼠标扫过候选条会连续触发 mouseenter,若每次都立刻设 img.src,
  // 前几十次请求虽然会被浏览器中断(同一个 <img> 换 src 会 abort 上一个),
  // 但连接与首字节的代价已经付出去了。等指针停稳再发请求,能省掉绝大部分无效下载。
  // 键盘 ↑↓ 切换是明确操作,不走延迟、立即加载。
  var PREVIEW_HOVER_DELAY = 120;
  var previewTimer = null;

  function imageUrl(file) { return file ? IMAGE_DIR + file : ''; }

  function cancelPreviewTimer() {
    if (previewTimer !== null) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  /** 悬停触发:等指针停稳再加载 */
  function schedulePreview(file, anchor) {
    cancelPreviewTimer();
    if (!imagesAvailable || !file) { hidePreview(); return; }
    previewTimer = setTimeout(function () {
      previewTimer = null;
      showPreview(file, anchor);
    }, PREVIEW_HOVER_DELAY);
  }

  /**
   * 把浮层摆在锚点元素旁边:优先右侧,右边放不下翻到左侧,再不行就贴边。
   * 调用时浮层必须已经是 visible,否则 offsetWidth/Height 量不到真实尺寸。
   */
  function positionPreview(panel, anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
    var rect = anchor.getBoundingClientRect();
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;
    var w = panel.offsetWidth || 200;
    var h = panel.offsetHeight || Math.round(w * CARD_IMAGE_RATIO) + 10;
    var gap = 12;
    var left = rect.right + gap;
    if (left + w > vw - 8) left = rect.left - gap - w;
    if (left < 8) left = Math.max(8, vw - w - 8);
    var top = rect.top + rect.height / 2 - h / 2;
    top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function showPreview(file, anchor) {
    cancelPreviewTimer();   // 直接显示时,把还在排队的悬停延迟取消掉
    var panel = $('card-preview');
    var img = $('card-preview-img');
    if (!panel || !img) return;
    if (!imagesAvailable || !file) { hidePreview(); return; }
    if (img.getAttribute('data-file') !== file) {
      img.setAttribute('data-file', file);
      img.setAttribute('src', imageUrl(file));
    }
    panel.classList.add('show');
    previewState.visible = true;
    previewState.file = file;
    positionPreview(panel, anchor);
  }

  function hidePreview() {
    cancelPreviewTimer();
    var panel = $('card-preview');
    if (panel) panel.classList.remove('show');
    previewState.visible = false;
    previewState.file = '';
  }

  /**
   * 结算弹窗里的答案卡图。
   * 先保持隐藏、等 load 成功再显示 —— 这样在没下卡图(比如在线试玩版)的环境里,
   * 弹窗不会先撑出一个空图框再塌回去。
   */
  function showResultArt(card) {
    var art = $('result-art');
    var img = $('result-image');
    if (!art || !img) return;
    var file = card && card.image;
    if (!file || !imagesAvailable) { art.classList.add('hidden'); return; }
    img.setAttribute('data-file', file);
    img.setAttribute('alt', (card.nickname || '') + ' 的卡图');
    img.setAttribute('src', imageUrl(file));
    art.classList.add('hidden');
  }

  // ---------- 对局流程 ----------
  var activePool = [];   // 本局锁定的卡池(开局时快照,中途换模式不影响进行中的对局)

  function startGame() {
    var pool = findPool(state.poolId) || findPool(DEFAULT_POOL);
    activePool = poolCards(pool.id);
    if (!activePool.length) {
      toast('该卡池暂无卡牌,请换一个卡池模式');
      return;
    }
    state.target = pickTarget(activePool);
    state.guesses = [];
    state.status = 'playing';
    $('guess-input').value = '';
    closeSuggestions();
    renderBoard();
    $('status-text').textContent = pool.label + ' · ' + (state.withTokens ? '含衍生' : '不含衍生')
      + ' · ' + activePool.length + ' 张 · 共 ' + MAX_GUESSES + ' 次机会';
    $('guess-input').disabled = false;
    $('guess-submit').disabled = false;
    $('guess-input').focus();
  }

  function submitGuess(card) {
    if (!card || state.status !== 'playing') return;
    if (state.guesses.some(function (g) { return g.nickname === card.nickname; })) {
      toast('已经猜过这张卡了');
      return;
    }
    var row = compare(card, state.target);
    row.image = card.image || '';   // 仅供棋盘悬停预览卡图用,不参与判定
    row.guessedAt = Date.now();
    state.guesses.push(row);
    renderBoard();

    if (row.correct) {
      finish('won');
    } else if (state.guesses.length >= MAX_GUESSES) {
      finish('lost');
    } else {
      $('guess-input').value = '';
      closeSuggestions();
      $('guess-input').focus();
    }
  }

  function finish(result) {
    state.status = 'finished';
    $('guess-input').disabled = true;
    $('guess-submit').disabled = true;
    var stats = loadStats();
    if (result === 'won') {
      stats.wins += 1;
      stats.streak += 1;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
    } else {
      stats.losses += 1;
      stats.streak = 0;
    }
    saveStats(stats);
    showResult(result, stats);
  }

  function showResult(result, stats) {
    var t = state.target;
    hidePreview();   // 浮层别压在结算弹窗上
    $('result-title').textContent = result === 'won' ? '恭喜,猜对了!' : '很遗憾,未能猜中';
    $('result-tone').className = result === 'won' ? 'overlay-card win' : 'overlay-card lose';
    $('result-name').textContent = t.nickname;
    showResultArt(t);
    $('result-stats').textContent = '共 ' + state.guesses.length + ' 次 · 总场次 ' + (stats.wins + stats.losses)
      + ' · 胜 ' + stats.wins + ' · 负 ' + stats.losses
      + ' · 当前连胜 ' + stats.streak;
    $('result-info').innerHTML =
      '<tr><td class="label">国籍</td><td>' + escapeHtml(t.nation || '-') + '</td></tr>'
      + '<tr><td class="label">费用</td><td>' + (Number.isInteger(t.cost) ? t.cost : '-') + '</td></tr>'
      + '<tr><td class="label">类型</td><td>' + escapeHtml(t.type || '-') + '</td></tr>'
      + '<tr><td class="label">稀有度</td><td>' + escapeHtml(t.rarity || '-') + '</td></tr>'
      + '<tr><td class="label">卡包</td><td>' + escapeHtml(t.set || '-') + '</td></tr>';
    $('result-overlay').classList.add('show');
  }

  function hideResult() { $('result-overlay').classList.remove('show'); }

  // ---------- 输入补全 ----------
  var suggestions = [];

  function closeSuggestions() {
    suggestions = [];
    $('suggestions').innerHTML = '';
    $('suggestions').classList.remove('open');
    hidePreview();
  }

  /**
   * 组织候选行的显示文本:
   *   卡名 · 国籍 · 费用 · 类型 · 稀有度 [· 别名]
   * 别名会显示出来,方便用数字搜索时确认是不是想要的卡。
   */
  function suggestionText(c) {
    var parts = [c.nickname];
    if (c.nation) parts.push(c.nation);
    if (Number.isInteger(c.cost)) parts.push(c.cost + '费');
    if (c.type) parts.push(c.type);
    if (c.rarity) parts.push(c.rarity);
    var body = parts.join(' · ');
    if (c.alias) body += '  [' + c.alias + ']';
    return body;
  }

  // 搜索模块(search.js):支持「德国 334」「334 坦克」「334 德国 坦克」这类复合查询。
  // 若未加载该脚本,退回旧的单串子串匹配,保证功能不缺失。
  var SEARCH = (typeof window !== 'undefined' && window.KARDSYIBA_SEARCH) || null;

  function searchCards(source, query) {
    if (SEARCH) return SEARCH.search(source, query);
    var q = String(query || '').trim().toLowerCase();
    var hits = q ? source.filter(function (c) {
      return c.nickname.toLowerCase().indexOf(q) !== -1
        || (c.alias && c.alias.toLowerCase().indexOf(q) !== -1);
    }) : [];
    return { hits: hits, isCompound: false, query: { tokens: [] } };
  }

  function updateSuggestions() {
    var raw = $('guess-input').value;
    if (!raw.trim()) { closeSuggestions(); return; }
    // 对局中只在所选卡池内联想,避免给出无法提交的候选
    var source = activePool.length ? activePool : CARDS;
    var result = searchCards(source, raw);
    var hits = result.hits;
    suggestions = hits.slice(0, SUGGESTION_LIMIT);
    var list = $('suggestions');
    list.innerHTML = '';
    if (!suggestions.length) { list.classList.remove('open'); return; }

    // 计数徽标(吸附在候选条顶部;候选多时可滚动查看)
    var badge = document.createElement('li');
    badge.className = 'suggest-count';
    var label = '匹配 ' + hits.length + ' 张';
    if (hits.length > suggestions.length) {
      label += ',显示前 ' + suggestions.length + ' 张';
    }
    if (result.isCompound) {
      // 展示本次复合查询被识别出的字段词,便于玩家确认语义
      var fields = result.query.tokens
        .filter(function (t) { return t.kind !== 'free'; })
        .map(function (t) { return t.key; });
      if (fields.length) label = '[' + fields.join(' + ') + '] ' + label;
    }
    if (hits.length > 1) label += ' · 可滚动 / 上下键选择';
    badge.textContent = label;
    list.appendChild(badge);

    suggestions.forEach(function (c, index) {
      var li = document.createElement('li');
      li.textContent = suggestionText(c);
      li.className = 'suggest-item' + (index === 0 ? ' active' : '');
      // 悬停候选即可预览卡图(等指针停稳再下载,见 schedulePreview)
      li.addEventListener('mouseenter', function () { schedulePreview(c.image, li); });
      li.addEventListener('mouseleave', hidePreview);
      li.onmousedown = function (event) {
        // 只把候选填入输入框,提交由玩家手动点击"提交猜测"
        event.preventDefault();
        $('guess-input').value = c.nickname;
        closeSuggestions();
      };
      list.appendChild(li);
    });
    list.classList.add('open');
  }

  // ---------- 开始页两个选择器(卡池模式 / 衍生卡开关) ----------
  // 两者相互独立:卡池决定「现役还是预备」,衍生开关决定「要不要不可收集的牌」,
  // 组合起来 3 × 2 共 6 种,所以每个选择器的张数都要按另一个的当前值来算。
  var poolCounts = {};     // 当前衍生设置下,各卡池的张数
  var tokenCounts = {};    // 当前卡池下,含 / 不含衍生卡的张数

  function computePoolCounts() {
    poolCounts = {};
    POOLS.forEach(function (pool) {
      poolCounts[pool.id] = poolCards(pool.id, state.withTokens).length;
    });
    tokenCounts = {
      with: poolCards(state.poolId, true).length,
      without: poolCards(state.poolId, false).length,
    };
  }

  /** 衍生开关的说明文案:要如实反映「本卡池里到底有没有衍生牌」 */
  function tokenOptionNote() {
    var inPool = tokenCounts.with - tokenCounts.without;
    var label = (findPool(state.poolId) || {}).label || '';
    if (!inPool) {
      return '本卡池(' + label + ')没有衍生牌,这个开关对本局无影响';
    }
    if (state.withTokens) {
      return '卡池含 ' + inPool + ' 张衍生牌 · 不可收集,由卡牌效果生成 / 召唤';
    }
    return '已排除 ' + inPool + ' 张衍生牌 · 只保留可收集的正规卡';
  }

  function renderPoolPicker() {
    computePoolCounts();   // 两个选择器互相影响,统一在这里重算

    POOLS.forEach(function (pool) {
      // aria-checked / disabled 要设在按钮(带 data-pool 的 .pool-opt)上,
      // 不能设在按钮内部的张数 <i> 上
      var btn = document.querySelector('.pool-opt[data-pool="' + pool.id + '"]');
      var countEl = $('pool-count-' + pool.id);
      var count = poolCounts[pool.id] || 0;
      if (btn) {
        btn.setAttribute('aria-checked', pool.id === state.poolId ? 'true' : 'false');
        btn.disabled = !count;
      }
      if (countEl) countEl.textContent = count + ' 张';
    });

    TOKEN_OPTIONS.forEach(function (opt) {
      var btn = document.querySelector('.pool-opt[data-token="' + opt.id + '"]');
      var countEl = $('token-count-' + opt.id);
      var count = tokenCounts[opt.id] || 0;
      if (btn) {
        btn.setAttribute('aria-checked', opt.withTokens === state.withTokens ? 'true' : 'false');
        btn.disabled = !count;
      }
      if (countEl) countEl.textContent = count + ' 张';
    });

    var current = findPool(state.poolId) || findPool(DEFAULT_POOL);
    var noteEl = $('pool-note');
    if (noteEl) noteEl.textContent = current.note;
    var tokenNoteEl = $('token-note');
    if (tokenNoteEl) tokenNoteEl.textContent = tokenOptionNote();

    var startBtn = $('start-btn');
    if (startBtn) {
      var n = poolCounts[current.id] || 0;
      startBtn.disabled = !n;
      startBtn.textContent = n
        ? '开始游戏 · ' + current.label + ' ' + (state.withTokens ? '含衍生 ' : '不含衍生 ') + n + ' 张'
        : '该卡池暂无卡牌';
    }
    // 页脚(含 GitHub / BILIBILI 链接)是 index.html 静态内容,这里不再覆盖
  }

  function setPool(id) {
    if (!findPool(id)) return;
    state.poolId = id;
    storageSet(POOL_KEY, id);
    renderPoolPicker();
  }

  function setWithTokens(flag) {
    state.withTokens = !!flag;
    storageSet(TOKEN_KEY, state.withTokens);
    renderPoolPicker();
  }

  function loadPool() {
    var saved = storageGet(POOL_KEY);
    // 只接受已知卡池,且该池当前确实有卡(数据更新后卡池可能变空)
    if (typeof saved === 'string' && findPool(saved) && poolCounts[saved]) {
      state.poolId = saved;
    } else {
      state.poolId = DEFAULT_POOL;
    }
  }

  function loadTokenOption() {
    var saved = storageGet(TOKEN_KEY);
    // 存档里是布尔值就采信;旧存档没这一项 → 用默认值(包含衍生卡)
    state.withTokens = typeof saved === 'boolean' ? saved : DEFAULT_WITH_TOKENS;
  }

  // ---------- 规则弹窗 ----------
  function toggleRules(show) {
    $('rules-overlay').classList.toggle('show', show);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    // 卡池模式:点击即生效(下一次开局使用)
    var seg = $('pool-seg');
    if (seg) {
      seg.addEventListener('click', function (event) {
        var btn = event.target.closest ? event.target.closest('.pool-opt') : null;
        if (!btn || btn.disabled) return;
        setPool(btn.getAttribute('data-pool'));
      });
      // role="radio" 的方向键导航:← → 切换并选中
      seg.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
          && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        var ids = POOLS.map(function (p) { return p.id; });
        var cur = ids.indexOf(state.poolId);
        if (cur < 0) cur = 0;
        var step = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1;
        var next = (cur + step + ids.length) % ids.length;
        setPool(ids[next]);
      });
    }
    // 衍生卡开关:同样是点击即生效,与卡池模式互不影响
    var tokenSeg = $('token-seg');
    if (tokenSeg) {
      tokenSeg.addEventListener('click', function (event) {
        var btn = event.target.closest ? event.target.closest('.pool-opt') : null;
        if (!btn || btn.disabled) return;
        setWithTokens(btn.getAttribute('data-token') === 'with');
      });
      tokenSeg.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
          && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        var ids = TOKEN_OPTIONS.map(function (o) { return o.id; });
        var cur = state.withTokens ? 0 : 1;
        var step = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1;
        var next = (cur + step + ids.length) % ids.length;
        setWithTokens(TOKEN_OPTIONS[next].withTokens);
      });
    }
    $('start-btn').addEventListener('click', function () {
      $('start-screen').classList.add('hidden');
      $('game-screen').classList.remove('hidden');
      startGame();
    });
    $('back-btn').addEventListener('click', function () {
      if (state.status === 'playing') {
        if (!confirm('返回首页将结束本局,确定吗?')) return;
      }
      $('game-screen').classList.add('hidden');
      $('start-screen').classList.remove('hidden');
    });
    $('restart-btn').addEventListener('click', function () {
      if (state.status === 'playing' && !confirm('重新开始将清除本局进度,确定吗?')) return;
      startGame();
    });
    $('again-btn').addEventListener('click', function () { hideResult(); startGame(); });
    $('view-btn').addEventListener('click', hideResult);
    $('giveup-btn').addEventListener('click', function () {
      if (state.status !== 'playing') return;
      if (!confirm('查看答案将按失败结束本局,确定吗?')) return;
      finish('lost');
    });
    $('rules-trigger').addEventListener('click', function () { toggleRules(true); });
    $('rules-close').addEventListener('click', function () { toggleRules(false); });
    $('rules-overlay').addEventListener('mousedown', function (event) {
      if (event.target === $('rules-overlay')) toggleRules(false);
    });
    $('result-overlay').addEventListener('mousedown', function (event) {
      if (event.target === $('result-overlay')) hideResult();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if ($('rules-overlay').classList.contains('show')) toggleRules(false);
        else if ($('result-overlay').classList.contains('show')) hideResult();
      }
    });

    // 棋盘:鼠标悬停在「卡名」格上预览该卡卡图
    // 用事件委托(棋盘会整块重建,逐格绑会丢),mouseover/mouseout 才能冒泡上来
    var boardBody = $('board-body');
    if (boardBody) {
      boardBody.addEventListener('mouseover', function (event) {
        var cell = event.target && event.target.closest ? event.target.closest('td.name') : null;
        if (cell) schedulePreview(cell.getAttribute('data-image'), cell);
      });
      boardBody.addEventListener('mouseout', function (event) {
        var cell = event.target && event.target.closest ? event.target.closest('td.name') : null;
        if (!cell) return;
        // 在格子内部移动也会触发 mouseout,目标还在格子里就别关
        var to = event.relatedTarget;
        if (to && typeof cell.contains === 'function' && cell.contains(to)) return;
        hidePreview();
      });
    }

    // 卡图加载失败 = 这台机器上没有卡图(images/ 不进版本控制)。
    // 关掉预览,并让结算弹窗不要尝试显示图片。
    var previewImg = $('card-preview-img');
    if (previewImg) {
      previewImg.addEventListener('error', function () {
        imagesAvailable = false;
        hidePreview();
      });
    }
    var resultImg = $('result-image');
    var resultArt = $('result-art');
    if (resultImg && resultArt) {
      resultImg.addEventListener('load', function () { resultArt.classList.remove('hidden'); });
      resultImg.addEventListener('error', function () {
        imagesAvailable = false;
        resultArt.classList.add('hidden');
      });
    }

    var input = $('guess-input');
    // 手动提交:卡名必须完全一致;别名只有唯一命中时才允许直接提交,
    // 撞车的别名(如 334 对应 36 张)必须从候选项里点选,避免误提交
    function submitFromInput() {
      if (state.status !== 'playing') return;
      var q = input.value.trim();
      if (!q) { toast('请输入卡名或单位别名'); return; }
      var source = activePool.length ? activePool : CARDS;
      var hit = resolveInput(q, source);
      if (!hit) {
        // 复合查询(如「334 德国 坦克」)不是卡名,只能用来缩小候选,不能直接提交
        var compound = searchCards(source, q);
        if (compound.query && compound.query.tokens && compound.query.tokens.length > 1 && compound.hits.length) {
          toast('这是复合搜索,命中 ' + compound.hits.length + ' 张,请从候选项中点选');
          updateSuggestions();
          return;
        }
        // 本局卡池内没匹配;若全库里存在,说明是卡池不符,给出更准确的提示
        var globalHit = resolveInput(q, CARDS);
        if (globalHit && (globalHit.card || globalHit.by === 'alias-ambiguous')) {
          toast('这张卡不属于本局卡池(' + (findPool(state.poolId) || {}).label + ')');
        } else {
          toast('没有完全匹配的卡牌,请从候选项中选择后提交');
        }
        return;
      }
      if (hit.by === 'alias-ambiguous') {
        toast('别名 ' + q + ' 对应 ' + hit.matches.length + ' 张卡,请从候选项中点选');
        updateSuggestions();
        return;
      }
      var card = hit.card;
      var inPool = !activePool.length || activePool.some(function (c) { return c.nickname === card.nickname; });
      if (!inPool) {
        toast('这张卡不属于本局卡池(' + (findPool(state.poolId) || {}).label + ')');
        return;
      }
      input.value = card.nickname;
      closeSuggestions();
      submitGuess(card);
    }
    $('guess-submit').addEventListener('click', submitFromInput);
    input.addEventListener('input', updateSuggestions);
    input.addEventListener('focus', updateSuggestions);
    input.addEventListener('blur', function () { setTimeout(closeSuggestions, 150); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitFromInput();
      } else if (event.key === 'ArrowDown' && suggestions.length) {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === 'ArrowUp' && suggestions.length) {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === 'Tab' && suggestions.length) {
        event.preventDefault();
        $('guess-input').value = suggestions[0].nickname;
        updateSuggestions();
      }
    });
  }

  function moveActive(direction) {
    // 候选条里除卡牌项外还有计数徽标,必须只取 .suggest-item,否则索引会错位
    var all = $('suggestions').children;
    var items = [];
    for (var k = 0; k < all.length; k++) {
      if (all[k].classList && all[k].classList.contains('suggest-item')) items.push(all[k]);
    }
    if (!items.length) return;
    var current = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('active')) { current = i; break; }
    }
    var next = (current + direction + items.length) % items.length;
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', j === next);
    // 候选条可滚动,键盘移动时把选中项带进可视区
    var active = items[next];
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
    $('guess-input').value = suggestions[next].nickname;
    // 键盘上下键切换候选时,预览跟着走(和鼠标悬停行为一致)
    showPreview(suggestions[next].image, items[next]);
  }

  // 初始化顺序:先读衍生开关 → 算各卡池张数 → 读卡池存档(要用张数判断卡池是否可用)
  // → 渲染 → 绑定事件
  loadTokenOption();
  computePoolCounts();
  loadPool();
  renderPoolPicker();
  bind();

  // 暴露只读状态供测试/调试使用(不改动游戏逻辑)
  KARDSYIBA.poolCards = poolCards;
  KARDSYIBA.getPoolState = function () {
    return {
      poolId: state.poolId,
      withTokens: state.withTokens,
      target: state.target,
      poolSize: activePool.length,
    };
  };
  KARDSYIBA.getPreviewState = function () {
    var img = $('card-preview-img');
    var panel = $('card-preview');
    return {
      visible: previewState.visible,
      file: previewState.file,
      imagesAvailable: imagesAvailable,
      showing: !!(panel && panel.classList.contains('show')),
      src: img ? (img.getAttribute('src') || '') : '',
      pending: previewTimer !== null,     // 悬停延迟已排队、还没加载
      hoverDelay: PREVIEW_HOVER_DELAY,
    };
  };

  // ---------- 手机端优化:输入框聚焦 = 键盘弹起 ----------
  var gameScreenEl = $('game-screen');
  var guessInputEl = $('guess-input');
  function syncKeyboardActive() {
    if (gameScreenEl) {
      gameScreenEl.classList.toggle('keyboard-active', document.activeElement === guessInputEl);
    }
  }
  if (guessInputEl) {
    guessInputEl.addEventListener('focus', syncKeyboardActive);
    guessInputEl.addEventListener('blur', syncKeyboardActive);
  }
  // 视觉视口高度(移动端键盘弹起时输入坞贴底)
  function syncViewportHeight() {
    var vh = window.visualViewport && window.visualViewport.height;
    if (vh) document.documentElement.style.setProperty('--visual-viewport-height', Math.round(vh) + 'px');
  }
  syncViewportHeight();
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);
})();
