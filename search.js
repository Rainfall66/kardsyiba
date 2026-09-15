/* K一把 · 卡牌搜索(纯逻辑,可被 node 测试)
 * ---------------------------------------------------------------
 * 支持两种输入形态:
 *   1) 自由文本:按「子串包含」匹配卡名或别名(旧行为,如 "旋风" / "飓风" / "23")
 *   2) 复合查询:空格分隔多个词,每个词各自匹配卡片的某个字段,**全部满足**才命中
 *      例:334 德国 坦克 → 别名 334 且国籍德国 且类型坦克
 *
 * 词元识别(与顺序无关):
 *   - 国籍词:苏联/美国/日本/德国/英国/法国/意大利/波兰/芬兰/澳新军团
 *     以及常用简称:苏/美/日/德/英/法/意/波/芬/澳
 *   - 类型词:步兵/坦克/火炮/战斗机/轰炸机/指令/反制(简称:炮/飞机 等)
 *   - 其它词:依次尝试「卡名子串」「别名子串」;都不命中才算这个词失败
 *
 * 用法(浏览器):window.KARDSYIBA_SEARCH
 * 用法(node):  require('./search.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KARDSYIBA_SEARCH = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 国籍:规范名 → 可接受的写法(含简称)
  var NATIONS = [
    { key: '苏联', words: ['苏联', '苏', 'soviet', 'ussr'] },
    { key: '美国', words: ['美国', '美', 'usa', 'us'] },
    { key: '日本', words: ['日本', '日', 'japan'] },
    { key: '德国', words: ['德国', '德', 'germany'] },
    { key: '英国', words: ['英国', '英', 'britain', 'uk'] },
    { key: '法国', words: ['法国', '法', 'france'] },
    { key: '意大利', words: ['意大利', '意', 'italy'] },
    { key: '波兰', words: ['波兰', '波', 'poland'] },
    { key: '芬兰', words: ['芬兰', '芬', 'finland'] },
    { key: '澳新军团', words: ['澳新军团', '澳新', '澳', 'anzac'] },
  ];

  // 类型:规范名 → 可接受的写法
  var TYPES = [
    { key: '步兵', words: ['步兵', '步', 'infantry'] },
    { key: '坦克', words: ['坦克', 'tank'] },
    { key: '火炮', words: ['火炮', '炮', 'artillery'] },
    { key: '战斗机', words: ['战斗机', '战斗', 'fighter'] },
    { key: '轰炸机', words: ['轰炸机', '轰炸', 'bomber'] },
    { key: '指令', words: ['指令', 'order'] },
    { key: '反制', words: ['反制', 'counter', 'countermeasure'] },
  ];

  // 稀有度:规范名 → 可接受的写法
  var RARITIES = [
    { key: '标准', words: ['标准', 'standard'] },
    { key: '特殊', words: ['特殊', 'special'] },
    { key: '限定', words: ['限定', 'limited'] },
    { key: '精英', words: ['精英', 'elite'] },
    { key: '衍生卡', words: ['衍生卡', '衍生', 'token'] },
  ];

  function matchWord(table, token) {
    var t = token.toLowerCase();
    for (var i = 0; i < table.length; i++) {
      var words = table[i].words;
      for (var j = 0; j < words.length; j++) {
        if (words[j].toLowerCase() === t) return table[i].key;
      }
    }
    return null;
  }

  /**
   * 把查询串拆成词元并分类。
   * 返回 { raw, tokens:[{text, kind, key}], hasField, hasFree }
   * kind: 'nation' | 'type' | 'rarity' | 'free'
   *
   * 优先级(重要):若某个词与某张卡的**卡名完全相同**,一律先当卡名(自由词)处理。
   * 否则像「标准弹药」「特殊增援」「惩戒(0费)」这类卡名会被稀有度/字段词抢走语义。
   * @param {string} query
   * @param {Array} [cards] 用于判断"是否恰好是某张卡的名字",省略则退化为纯字段解析
   */
  function parseQuery(query, cards) {
    var raw = String(query == null ? '' : query).trim();
    var parts = raw.split(/\s+/).filter(Boolean);
    var exactNames = null;
    if (cards && cards.length) {
      exactNames = new Set();
      for (var i = 0; i < cards.length; i++) exactNames.add(String(cards[i].nickname).toLowerCase());
    }
    var tokens = parts.map(function (text) {
      var lower = text.toLowerCase();
      var isExactName = exactNames ? exactNames.has(lower) : false;
      if (!isExactName) {
        var nation = matchWord(NATIONS, text);
        if (nation) return { text: text, kind: 'nation', key: nation };
        var type = matchWord(TYPES, text);
        if (type) return { text: text, kind: 'type', key: type };
        var rarity = matchWord(RARITIES, text);
        if (rarity) return { text: text, kind: 'rarity', key: rarity };
      }
      return { text: text, kind: 'free', key: lower };
    });
    return {
      raw: raw,
      tokens: tokens,
      hasField: tokens.some(function (t) { return t.kind !== 'free'; }),
      hasFree: tokens.some(function (t) { return t.kind === 'free'; }),
    };
  }

  /** 单个词元是否命中某张卡 */
  function tokenHits(token, card) {
    if (token.kind === 'nation') return card.nation === token.key;
    if (token.kind === 'type') return card.type === token.key;
    if (token.kind === 'rarity') return card.rarity === token.key;
    var q = token.key;
    if (String(card.nickname).toLowerCase().indexOf(q) !== -1) return true;
    if (card.alias && String(card.alias).toLowerCase().indexOf(q) !== -1) return true;
    return false;
  }

  /**
   * 在 cards 中搜索。
   * - 单词语查询:保持旧行为(子串匹配卡名或别名)
   * - 多词查询:所有词元都要命中(AND),字段词与自由词可任意组合、顺序无关
   * 返回 { query, hits:[card], tokens, isCompound }
   */
  function search(cards, query) {
    var list = cards || [];
    var parsed = parseQuery(query, list);
    if (!parsed.tokens.length) return { query: parsed, hits: [], isCompound: false };
    var isCompound = parsed.tokens.length > 1;
    var hits = list.filter(function (card) {
      for (var i = 0; i < parsed.tokens.length; i++) {
        if (!tokenHits(parsed.tokens[i], card)) return false;
      }
      return true;
    });
    return { query: parsed, hits: hits, isCompound: isCompound };
  }

  return {
    NATIONS: NATIONS,
    TYPES: TYPES,
    RARITIES: RARITIES,
    parseQuery: parseQuery,
    tokenHits: tokenHits,
    search: search,
  };
});
