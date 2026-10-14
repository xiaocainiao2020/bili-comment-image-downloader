// ==UserScript==
// @name         B站评论区图片批量下载（含隐藏图 / 原图）
// @namespace    https://github.com/xiaocainiao2020/bili-comment-image-downloader
// @version      1.0.0
// @description  批量提取并下载 B 站视频评论区所有图片原图。自动识别被折叠隐藏的第9张（图片查看器里翻页才能看到的那张）
// @author       sonder
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/festival/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hdslb.com
// @connect      biliimg.com
// @connect      bilibili.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/* eslint-disable no-empty, no-unused-vars */
(function () {
  'use strict';

  //===================================================================
  // 1. 把「页面侧引擎」注入主世界 (main world)
  //    新版评论区大量使用 Shadow DOM / 自定义元素，必须运行在页面侧
  //    才能真正 hook fetch / XHR，并遍历 open shadow root。
  //===================================================================

  function pageEngineSource() {
    return String.raw`
/* =====================================================================
 * B 站评论区图片采集 · 页面侧引擎 (main world)
 * 目标：
 *   1) hook fetch / XMLHttpRequest，直接从评论接口 JSON 里读到
 *      完整的 content.pictures（B 站接口返回全部，UI 只渲染前 8 张）
 *   2) 递归遍历 Shadow DOM，按「评论容器」把 DOM 里的图归到对应评论
 *   3) 监听图片查看器（viewer），把翻页才能看到的隐藏图也抓出来
 *   4) 支持直接调 API 补全（含 wbi 签名 + 两个备用旧接口）
 *   5) 通过 window.__BILI_CDN__ 把下载任务交回油猴沙箱执行
 * ===================================================================== */

/* @self-test-begin:core */
  var PICTURE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function isHttpUrl(u) {
    return /^https?:\/\//i.test(str(u));
  }

  function isImageUrl(u) {
    if (!u) return false;
    var s = str(u);
    if (!/^https?:\/\//i.test(s) && !/^\/\//.test(s)) return false;
    if (!/\/(bfs|bfs2)\//i.test(s) && !/hdslb\.com|biliimg\.com/i.test(s)) {
      return false;
    }
    return /\.(jpe?g|png|gif|webp|avif|bmp)([?@!].*)?$/i.test(s) ||
      /@[^/]*\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(s);
  }

  /* 归一化图片地址：补全 https:、去掉缩略图后缀 */
  function normalizeUrl(u) {
    var s = str(u).trim();
    if (!s) return '';
    if (/^\/\//.test(s)) s = 'https:' + s;
    // 去 query / hash 里的鉴权与追踪参数
    s = s.replace(/[?#].*$/, '');
    // 去缩略图修饰：@xxxx 之后的所有内容（@ 只会出现在 URL 末尾）
    s = s.replace(/@.*$/, '');
    if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
    return s;
  }

  /* 去重键：路径部分（不同 CDN 主机视为同一张图）+ 最终格式 */
  function dedupeKey(u) {
    var s = normalizeUrl(u);
    if (!s) return '';
    var host = s.replace(/^https?:\/\//i, '').split('/')[0];
    var path = s.replace(/^https?:\/\/[^/]+/i, '');
    var fmt = '';
    var m = s.match(/@[^/?#]*\.([a-z0-9]+)$/i);
    if (m) fmt = m[1].toLowerCase();
    if (!fmt) {
      m = s.match(PICTURE_EXT_RE);
      fmt = m ? m[1].toLowerCase() : 'jpg';
    }
    return path.toLowerCase() + '|' + fmt;
  }

  function extFromUrl(u) {
    var s = normalizeUrl(u);
    var m = s.match(/\.([a-z0-9]{2,4})$/i);
    if (m) {
      var e = m[1].toLowerCase();
      if (e === 'jpeg') e = 'jpg';
      return e;
    }
    return '';
  }

  /* 从 URL 里取有意义的文件名（B 站 new_dyn 的 hash 名很有辨识度） */
  function nameFromUrl(u) {
    var s = normalizeUrl(u);
    var path = s.replace(/[?#].*$/, '');
    var base = path.split('/').pop() || '';
    if (base.indexOf('%') >= 0) {
      try { base = decodeURIComponent(base); } catch (e) {}
    }
    // 有些接口把第三方图床地址塞在文件名里，取最后一段更可读
    if (base.indexOf('http') >= 0) {
      var tail = base.split(/https?(_|%3A|:)/i).pop();
      if (tail) base = tail;
    }
    base = base.replace(/\.[a-z0-9]{2,4}$/i, '');
    base = sanitizeName(base, 'img');
    if (base.length > 60) base = base.slice(0, 60);
    return base;
  }

  function sanitizeName(name, fallback) {
    var s = str(name) || str(fallback) || 'unknown';
    s = s.replace(/[\u0000-\u001f\u007f]/g, '');
    s = s.replace(/[\\/:*?"<>|\r\n\t]+/g, '_');
    s = s.replace(/[\u200b-\u200f\ufeff]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[.\s]+/, '');
    s = s.replace(/[.\s]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
    if (s.length > 50) s = s.slice(0, 50);
    if (!s) s = str(fallback) || 'unknown';
    return s;
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }

  /* 命名模板：{author} {mid} {rpid} {i} {n} {name} {ext} */
  function buildFileName(tpl, ctx) {
    var t = str(tpl) || '{author}_{rpid}_{i}';
    var out = t
      .replace(/\{author\}/g, sanitizeName(ctx.author, 'unknown'))
      .replace(/\{mid\}/g, str(ctx.mid))
      .replace(/\{rpid\}/g, str(ctx.rpid))
      .replace(/\{i\}/g, pad(ctx.index || 1, ctx.total && ctx.total >= 10 ? 2 : 2))
      .replace(/\{n\}/g, str(ctx.total || 1))
      .replace(/\{name\}/g, sanitizeName(ctx.name, 'img'))
      .replace(/\{ext\}/g, str(ctx.ext || 'jpg'));
    // 用户模板里已经写了扩展名就不再补
    if (!/\{ext\}/.test(t)) out = out + '.' + str(ctx.ext || 'jpg');
    out = out.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/_{2,}/g, '_');
    out = out.replace(/^[^0-9A-Za-z\u4e00-\u9fa5\uff10-\uff19]+/, '');
    out = out.replace(/[_\s.]+$/, '');
    if (!out) out = 'img_' + str(ctx.index || 1);
    if (out.length > 120) out = out.slice(0, 120);
    return out;
  }

  /* 质量模式：
   *   raw      —— 接口原样（B 站给的压缩缩略图，体积小）
   *   original —— 按接口给出的真实宽高加 @{w}w_{h}h 标记，让 CDN 吐出原始尺寸
   *   max      —— 再叠加 100q + .png，最大程度避免二次压缩（体积最大）
   */
  function buildVariant(base, pic, mode) {
    var url = normalizeUrl(base);
    if (!url) return '';
    var m = str(mode);
    if (m === 'raw') return url;
    var w = pic && pic.img_width ? parseInt(pic.img_width, 10) : 0;
    var h = pic && pic.img_height ? parseInt(pic.img_height, 10) : 0;
    if (!w && !h) return m === 'max' ? url + '@100q.png' : url;
    var rule;
    if (m === 'max') {
      rule = (w ? w + 'w' : '') + (w && h ? '_' : '') + (h ? h + 'h' : '') + '_1e_100q.png';
    } else {
      rule = (w ? w + 'w' : '') + (w && h ? '_' : '') + (h ? h + 'h' : '') + '_1e_1c.jpg';
    }
    return url + '@' + rule;
  }

  /* ---- 从任意 JSON 节点里递归抠出评论与图片 ---- */
  function looksLikePictureArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    var p = arr[0];
    return !!p && typeof p === 'object' &&
      (p.img_src || p.img_url || p.url || p.src);
  }

  function isReplyNode(node) {
    return !!node && typeof node === 'object' &&
      (node.rpid !== undefined || node.rpid_str !== undefined) &&
      node.content !== undefined;
  }

  /* 在一段接口 JSON 里收集所有评论（含楼中楼）。
     接口结构是 {code, data:{replies:[...]}}，深度和字段名都不固定，
     所以必须真的往下钻；同时：递归时忽略返回值，统一用最外层 out 累积。 */
  function collectReplyNodes(root, out, depth, budget, isSub) {
    out = out || [];
    budget = budget || { n: 0 };
    depth = depth || 0;
    if (!root || depth > 8 || budget.n > 5000 || out.length > 4000) return out;
    if (++budget.n > 5000) return out;
    if (Array.isArray(root)) {
      // 裸图片数组（查看器 props、内容图片字段）→ 包成无归属的评论节点
      if (!isReplyNode(root[0]) && looksLikePictureArray(root)) {
        out.push({ rpid: '', rpid_str: '', content: { pictures: root } });
        return out;
      }
      for (var i = 0; i < root.length && i < 500; i++) {
        collectReplyNodes(root[i], out, depth + 1, budget, isSub);
      }
      return out;
    }
    if (typeof root !== 'object') return out;

    if (isReplyNode(root)) {
      if (isSub) {
        try { root.__isSubReply = true; } catch (e) {}
      }
      out.push(root);
      // 楼中楼：只有「评论内部的 replies」才是子评论，
      // 顶层包裹的 data.replies 依然是一级评论
      if (Array.isArray(root.replies)) {
        for (var j = 0; j < root.replies.length && j < 200; j++) {
          collectReplyNodes(root.replies[j], out, depth + 1, budget, true);
        }
      }
      return out;
    }

    // 普通容器对象：继续往下钻（这才是 data.replies 能被发现的原因）
    var keys;
    try { keys = Object.keys(root); } catch (e) { return out; }
    for (var k = 0; k < keys.length && k < 80; k++) {
      var key = keys[k];
      if (key === '__isSubReply') continue;
      var v = root[key];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v) && !isReplyNode(v[0]) && looksLikePictureArray(v)) {
        out.push({ rpid: '', rpid_str: '', content: { pictures: v } });
        continue;
      }
      // 容器对象里的 replies 列表是一级评论，不要标成楼中楼
      collectReplyNodes(v, out, depth + 1, budget, false);
    }
    return out;
  }

  /* 把接口 JSON 直接转成采集记录 */
  function extractFromPayload(payload) {
    var records = [];
    // 直接传图片数组（例如从查看器组件 props 里拿到的数组）
    if (looksLikePictureArray(payload)) payload = { content: { pictures: payload } };
    var nodes = collectReplyNodes(payload, [], 0, { n: 0 });
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var c = n.content || {};
      var pics = c.pictures || c.picture || c.pics;
      if (!looksLikePictureArray(pics)) continue;
      var member = n.member || n.user || {};
      var rpid = str(n.rpid_str || n.rpid);
      var author = str(member.uname || member.name || n.uname);
      var mid = str(member.mid || n.mid_str || n.mid);
      var rootId = str(n.root_str || n.root || '0');
      var isSub = n.__isSubReply === true ||
        (rootId !== '' && rootId !== '0' && rootId !== rpid);
      for (var k = 0; k < pics.length; k++) {
        var p = pics[k];
        if (!p || typeof p !== 'object') continue;
        var raw = p.img_src || p.img_url || p.url || p.src || '';
        var url = normalizeUrl(raw);
        if (!isImageUrl(url)) continue;
        // 只有 new_dyn / album 命名空间才算评论图：
        // 表情 / 贴纸 / 封面 / 角标等即使混进了图片数组也必须挡掉
        if (!isCommentPictureUrl(url)) continue;
        records.push({
          url: url,
          width: parseInt(p.img_width || p.width || 0, 10) || 0,
          height: parseInt(p.img_height || p.height || 0, 10) || 0,
          size: Number(p.img_size || p.size || 0) || 0,
          gif: !!(p.play_gif_thumbnail || /\.gif$/i.test(url)),
          emoteHint: str(p.top_right_icon),
          rpid: rpid,
          author: author,
          mid: mid,
          index: k + 1,
          total: pics.length,
          isSub: isSub,
          source: 'api'
        });
      }
    }
    return records;
  }
/* @self-test-end:core */

  //===================================================================
  // 2. 运行时状态
  //===================================================================

  var CFG = {};
  try {
    var raw = document.currentScript && document.currentScript.getAttribute('data-ccfg');
    if (raw) CFG = JSON.parse(raw) || {};
  } catch (e) { CFG = {}; }
  if (!CFG || typeof CFG !== 'object') CFG = {};

  var groups = {};      // groupKey -> group
  var order = [];       // groupKey 顺序
  var imageMap = {};    // dedupeKey -> image
  var uncheckedKeys = {}; // 用户手动取消勾选的图，重扫时不能被重置为勾选
  var defaultChecked = true; // 用户点过「全不选」后，新扫到的图默认也不勾选
  var totalSeen = 0;
  var hiddenSeen = 0;   // 只有查看器/接口才知道的隐藏图数量
  var broadcastTimer = 0;
  // 接口确认过的评论者 / 评论 ID。DOM、查看器、初始状态来的图
  // 必须能对上其中之一才收，否则极容易把视频封面、表情、推荐位收进来。
  var trustedMids = {};
  var trustedRpids = {};

  /* 单条评论的容器特征。
     注意：绝不能把 bili-comments（整个评论区外壳）算进来，
     否则整页所有图都会归到同一个"评论"里。 */
  var GROUP_TAGS = [
    'bili-comment-thread-renderer',
    'bili-comment-reply-renderer',
    'bili-comment-renderer',
    '.reply-item',
    '.sub-reply-item',
    '.root-reply',
    '.sub-reply-container'
  ];
  var GROUP_SEL = GROUP_TAGS.join(',');

  /* 明确不是「单条评论」的容器，命中即继续往上找 */
  var NON_GROUP_TAGS = [
    'bili-comments',
    'bili-comments-header-renderer',
    'bili-comment-box',
    'bili-comment-input'
  ];
  var NON_GROUP_SEL = NON_GROUP_TAGS.join(',');

  var VIEWER_TAGS = [
    'bili-image-viewer',
    'bili-image-viewer-dialog',
    'bili-comment-pictures-renderer',
    'bili-pictures-renderer',
    'bili-image-viewer-item'
  ];

  function idSeed(url, kind) {
    var s = str(url);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return (kind || 'g') + h.toString(36) + '_' + s.length;
  }

  function getGroup(key, meta) {
    var g = groups[key];
    if (!g) {
      g = groups[key] = {
        key: key,
        rpid: str(meta && meta.rpid),
        author: str(meta && meta.author),
        mid: str(meta && meta.mid),
        avatar: '',
        text: '',
        isSub: !!(meta && meta.isSub),
        declared: parseInt(meta && meta.declared, 10) || 0,
        site: str(meta && meta.site),
        images: [],
        keys: {},
        sources: {}
      };
      order.push(key);
    } else {
      if (!g.author && meta && meta.author) g.author = str(meta.author);
      if (!g.rpid && meta && meta.rpid) g.rpid = str(meta.rpid);
      if (!g.mid && meta && meta.mid) g.mid = str(meta.mid);
      if (!g.avatar && meta && meta.avatar) g.avatar = str(meta.avatar);
      if (!g.text && meta && meta.text) g.text = str(meta.text);
      if ((!g.declared || g.declared < (meta && meta.declared)) && meta && meta.declared) {
        g.declared = parseInt(meta.declared, 10) || g.declared;
      }
    }
    if (meta && meta.site) g.site = str(meta.site) || g.site;
    return g;
  }

  function markTrusted(rpid, mid) {
    if (rpid) trustedRpids[str(rpid)] = true;
    if (mid) trustedMids[str(mid)] = true;
  }

  /* 一条记录是否可信。
     接口来的（api）无条件可信：content.pictures 就是评论图本身。
     其它来源（DOM / 查看器 / 初始状态）必须能对上接口确认过的
     评论 ID 或评论者 UID —— 这条规则能一刀切掉视频封面、表情、
     相关推荐等一切"页面上存在但不属于这条评论"的图。 */
  var SOURCE_LABEL = {
    api: '接口', dom: '页面', viewer: '查看器',
    'viewer-lazy': '查看器', 'viewer-props': '查看器', initial: '页面缓存'
  };

  function isTrustedRecord(rec) {
    if (rec.source === 'api' || rec.source === 'pull-one') return true;
    var rpid = str(rec.rpid);
    var mid = str(rec.mid);
    if (rpid && trustedRpids[rpid]) return true;
    if (mid && trustedMids[mid]) return true;
    return false;
  }

  function dropEmptyGroups() {
    for (var i = order.length - 1; i >= 0; i--) {
      var g = groups[order[i]];
      if (g && (!g.images || !g.images.length)) {
        delete groups[order[i]];
        order.splice(i, 1);
      }
    }
  }

  var rejectedCount = 0;
  var emoteRejected = 0;
  var acceptedLog = [];   // 诊断用：最近被采纳的图（__BILI_CDN_DEBUG__ 里可看）
  function noteRejected(rec) {
    // 还没有任何可信评论时（接口还没抓到），无从判断，
    // 这种"空白期"的丢弃不算进统计，免得数字吓人。
    var noTrustYet = !Object.keys(trustedMids).length && !Object.keys(trustedRpids).length;
    if (noTrustYet) return;
    rejectedCount++;
    if (rejectedCount <= 3) {
      engine.log('已忽略可疑图片（来源 ' + (SOURCE_LABEL[rec.source] || rec.source) +
        '，未匹配到任何评论）：' + rec.url);
    }
  }

  /* 表情/贴纸的硬判据。
     真实依据（来自接口实测）：
       · 用户上传的图只有 content.pictures 这一条路，尺寸 1000+ px、体积上百 KB；
       · 小黄脸表情走独立的 content.emote（/bfs/emote/ 域名），不进 pictures；
       · 所以凡是出现在「评论容器里」却只有几十~两百像素、且同组尺寸高度一致的小图，
         基本就是表情——不管它的地址是 /bfs/emote/ 还是被 B站存成 /bfs/new_dyn/。
     注意：这里用文字来判"小黄脸"，属于兜底，不是判定的必要条件。 */
/* @self-test-begin:emote */
  var EMOTE_MAX_PX = 200;
  // 实测用户上传的评论图都在 1000px 量级；几十像素的只可能是表情/图标。
  var EMOTE_MIN_PX = 1;
  var EMOTE_HINT_RE = /emote|emoji|表情|贴纸|sticker/i;

  function isLikelyEmote(rec) {
    if (!rec) return false;
    if (rec.emoteHint && EMOTE_HINT_RE.test(str(rec.emoteHint))) return true;
    var w = parseInt(rec.width, 10) || 0;
    var h = parseInt(rec.height, 10) || 0;
    if (!w || !h) return false;
    return w <= EMOTE_MAX_PX && h <= EMOTE_MAX_PX;
  }
/* @self-test-end:emote */

  /* 整组都是同样尺寸的小图 → 表情包（表情常被拼成一张长图，但每格尺寸一致） */
  function dropEmoteClusters() {
    var dropped = 0;
    for (var i = order.length - 1; i >= 0; i--) {
      var g = groups[order[i]];
      if (!g || !g.images.length || g.images.length < 4) continue;
      var allSmall = true;
      var first = null;
      var sameSize = true;
      for (var k = 0; k < g.images.length; k++) {
        var im = g.images[k];
        var w = im.width || 0;
        var h = im.height || 0;
        if (!w || !h || w > EMOTE_MAX_PX || h > EMOTE_MAX_PX) { allSmall = false; break; }
        if (!first) first = w + 'x' + h;
        else if (first !== w + 'x' + h) sameSize = false;
      }
      if (allSmall && sameSize) {
        for (var m = 0; m < g.images.length; m++) {
          delete imageMap[g.images[m].key];
          dropped++;
        }
        g.images = [];
      }
      if (!g.images.length) {
        delete groups[g.key];
        order.splice(i, 1);
      }
    }
    return dropped;
  }

  /* 把一条图片记录并进分组；返回 image 或 null */
  function addRecord(rec, opts) {
    if (!rec || !rec.url) return null;
    var key = dedupeKey(rec.url);
    if (!key) return null;
    // 统一兜底：不是 new_dyn / album 命名空间的地址一律不收
    // （表情、贴纸、封面、头像、角标等任何通道进来的都在这层被挡掉）
    if (!isCommentPictureUrl(rec.url)) {
      noteRejected(rec);
      return null;
    }
    if (!isTrustedRecord(rec)) {
      noteRejected(rec);
      return null;
    }
    if (isLikelyEmote(rec)) {
      emoteRejected++;
      return null;
    }
    var gkey = rec.rpid ? ('r' + rec.rpid) : ('v' + idSeed(rec.url, 'v'));
    var g = getGroup(gkey, rec);
    if (rec.total > g.declared) g.declared = parseInt(rec.total, 10) || g.declared;

    var existing = imageMap[key];
    if (existing) {
      // 同一张图出现在别处：补全更大的尺寸信息即可
      if (!existing.width && rec.width) existing.width = rec.width;
      if (!existing.height && rec.height) existing.height = rec.height;
      if (rec.author && !existing.author) existing.author = rec.author;
      return existing;
    }

    var img = {
      id: 'i' + (++totalSeen) + '_' + idSeed(key, 'k'),
      key: key,
      url: rec.url,
      width: rec.width || 0,
      height: rec.height || 0,
      size: rec.size || 0,
      gif: !!rec.gif,
      rpid: str(rec.rpid),
      author: str(rec.author),
      mid: str(rec.mid || (g && g.mid)),
      index: rec.index || (g.images.length + 1),
      total: rec.total || g.declared || 0,
      groupKey: gkey,
      source: rec.source || 'unknown',
      checked: (defaultChecked && !uncheckedKeys[key]) && !(opts && opts.unchecked),
      state: 'idle'
    };
    imageMap[key] = img;
    g.images.push(img);
    g.keys[key] = true;
    g.sources[img.source] = (g.sources[img.source] || 0) + 1;
    acceptedLog.push({
      url: img.url, source: img.source, w: img.width, h: img.height,
      rpid: img.rpid, mid: img.mid, author: img.author
    });
    if (acceptedLog.length > 80) acceptedLog.splice(0, acceptedLog.length - 80);
    if (g.images.length > g.declared && !(opts && opts.keepDeclared)) {
      g.declared = g.images.length;
    }
    if (isViewerSource(img.source) || img.source === 'api') hiddenSeen++;
    scheduleBroadcast();
    return img;
  }

  function isViewerSource(s) {
    return s === 'viewer' || s === 'viewer-lazy' || s === 'viewer-props';
  }

  function finalizeGroup(g) {
    var maxTotal = g.images.length;
    for (var i = 0; i < g.images.length; i++) {
      if (g.images[i].total && g.images[i].total > maxTotal) maxTotal = g.images[i].total;
    }
    g.declared = Math.max(g.declared || 0, 0);
    g.total = Math.max(maxTotal, g.declared || 0);
    g.missing = Math.max(0, g.total - g.images.length);
    g.complete = g.missing === 0 && g.images.length > 0;
    g.author = g.author || (g.images[0] && g.images[0].author) || '';
    return g;
  }

  /* 统一入口：把一批记录并入，并先把它们的评论身份登记为"可信"。
     这样同一条评论后续从 DOM / 查看器补进来的图才能通过校验。 */
  function absorbRecords(recs, source) {
    var added = 0;
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (source) rec.source = source;
      markTrusted(rec.rpid, rec.mid);
    }
    for (var j = 0; j < recs.length; j++) {
      var before = totalSeen;
      addRecord(recs[j], null);
      if (totalSeen > before) added++;
    }
    return added;
  }

  function snapshot() {
    dropEmptyGroups();
    dropEmoteClusters();
    var list = [];    var total = 0;
    var hidden = 0;
    for (var i = 0; i < order.length; i++) {
      var g = finalizeGroup(groups[order[i]]);
      total += g.images.length;
      hidden += g.missing;
      list.push({
        key: g.key,
        rpid: g.rpid,
        author: g.author,
        mid: g.mid,
        text: g.text,
        isSub: g.isSub,
        site: g.site,
        declared: g.declared,
        total: g.total,
        missing: g.missing,
        complete: g.complete,
        images: g.images.map(function (im) {
          return {
            id: im.id, key: im.key, url: im.url, width: im.width, height: im.height,
            size: im.size, gif: im.gif, index: im.index, total: im.total,
            source: im.source, checked: im.checked, state: im.state
          };
        })
      });
    }
    return {
      groups: list, total: total, hidden: hidden, rejected: rejectedCount,
      emotes: emoteRejected,
      videoId: currentVideoId()
    };
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(function () {
      broadcastTimer = 0;
      __BILI_CDN__.push(snapshot());
    }, 400);
  }

  function currentVideoId() {
    var m = location.pathname.match(/\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    if (m) return m[1];
    m = location.href.match(/\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    return m ? m[1] : location.pathname;
  }

  //===================================================================
  // 3. 网络钩子：fetch / XHR
  //===================================================================

  var REPLY_API_RE = /\/x\/v2\/reply|\/x\/v2\/reply\/wbi\/main|\/x\/v2\/reply\/reply|\/x\/v2\/reply\/hot|reply\/main/i;

  var lastDigest = '';
  var parseTimer = 0;
  var parseQueue = [];

  function digest(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + text.length;
  }

  function feedPayload(text) {
    if (!text || text.length < 40) return;
    if (text.charAt(0) !== '{' && text.charAt(0) !== '[') return;
    var d = digest(text);
    if (d === lastDigest) return;
    lastDigest = d;
    parseQueue.push(text);
    if (parseTimer) return;
    parseTimer = setTimeout(function () {
      parseTimer = 0;
      var q = parseQueue;
      parseQueue = [];
      for (var i = 0; i < q.length; i++) {
        try {
          var data = JSON.parse(q[i]);
          absorbRecords(extractFromPayload(data), 'api');
        } catch (e) {}
      }
    }, 250);
  }

  function isReplyUrl(url) {
    return typeof url === 'string' && REPLY_API_RE.test(url);
  }

  (function hookFetch() {
    var orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function () {
      var args = arguments;
      var url = '';
      try {
        url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      } catch (e) {}
      var p = orig.apply(this, args);
      if (!isReplyUrl(url)) return p;
      try {
        p.then(function (res) {
          try {
            var clone = res.clone();
            clone.text().then(function (t) { feedPayload(t); }, function () {});
          } catch (e) {}
        }, function () {});
      } catch (e) {}
      return p;
    };
  })();

  (function hookXhr() {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__biliReplyUrl = isReplyUrl(url) ? String(url) : ''; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      if (self.__biliReplyUrl) {
        try {
          self.addEventListener('load', function () {
            try {
              var t = '';
              if (self.responseType === '' || self.responseType === 'text') {
                t = self.responseText;
              } else if (self.responseType === 'json' && self.response) {
                t = JSON.stringify(self.response);
              }
              feedPayload(t);
            } catch (e) {}
          });
        } catch (e) {}
      }
      return origSend.apply(this, arguments);
    };
  })();

  /* 页面内嵌的初始状态（首屏评论有时直接写在 HTML 里）。
     注意标记为 initial：它掺杂大量非评论数据，必须能对上接口确认过的
     评论 ID / UID 才会被采纳。 */
  function scanInitialState() {
    try {
      var st = window.__INITIAL_STATE__;
      if (st && typeof st === 'object') {
        absorbRecords(extractFromPayload(st), 'initial');
      }
    } catch (e) {}
  }

  //===================================================================
  // 4. Shadow DOM 深度遍历
  //===================================================================

  function eachRoot(cb) {
    var stack = [document];
    var guard = 0;
    while (stack.length && guard++ < 4000) {
      var root = stack.pop();
      cb(root);
      try {
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      } catch (e) {}
    }
  }

  function cleanText(el) {
    if (!el) return '';
    var t = str(el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 200 ? t.slice(0, 200) : t;
  }

  function findByClassFrag(root, frags, max) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length && out.length < (max || 8); i++) {
        var el = all[i];
        var cn = '';
        try { cn = str(el.className); } catch (e) { cn = ''; }
        var id = str(el.id);
        var tag = str(el.tagName).toLowerCase();
        var hay = (cn + ' ' + id + ' ' + tag).toLowerCase();
        for (var f = 0; f < frags.length; f++) {
          if (hay.indexOf(frags[f]) >= 0) { out.push(el); break; }
        }
      }
    } catch (e) {}
    return out;
  }

  function isNonGroupContainer(el) {
    if (!el || !el.matches) return false;
    try { return el.matches(NON_GROUP_SEL); } catch (e) { return false; }
  }

  function findGroupContainer(node) {
    var el = node;
    var hops = 0;
    while (el && hops++ < 30) {
      try {
        if (!isNonGroupContainer(el) && el.matches && el.matches(GROUP_SEL)) return el;
      } catch (e) {}
      el = el.parentNode || (el.host || null);
    }
    // 退化：往上找带 rpid 的容器（且不能是整区外壳）
    el = node;
    hops = 0;
    while (el && hops++ < 30) {
      try {
        if (!isNonGroupContainer(el)) {
          if (el.getAttribute && (el.getAttribute('data-rpid') || el.getAttribute('rpid'))) return el;
          if (el.__vue__ && el.__vue__.reply) return el;
        }
      } catch (e) {}
      el = el.parentNode || (el.host || null);
    }
    return null;
  }

  function metaFromContainer(container, imgEl) {
    var meta = { rpid: '', author: '', mid: '', declared: 0, text: '', avatar: '', site: '' };
    try {
      var host = container;
      if (host && host.getAttribute) {
        meta.rpid = str(host.getAttribute('data-rpid') || host.getAttribute('rpid') || host.getAttribute('data-id'));
        meta.author = str(host.getAttribute('data-uname') || host.getAttribute('data-author') || host.getAttribute('uname'));
      }
      if (!meta.rpid && host && host.__vue__ && host.__vue__.reply) {
        var r = host.__vue__.reply;
        meta.rpid = str(r.rpid || r.rpid_str);
        meta.author = str((r.member && r.member.uname) || r.uname);
      }
    } catch (e) {}
    if (!meta.author) {
      var names = findByClassFrag(container, ['user-name', 'username', 'nickname', 'user-name-renderer'], 4);
      for (var i = 0; i < names.length; i++) {
        var t = cleanText(names[i]);
        if (t) { meta.author = t; break; }
      }
    }
    if (!meta.text) {
      var texts = findByClassFrag(container, ['reply-content', 'content-renderer', 'comment-content'], 2);
      for (var j = 0; j < texts.length; j++) {
        var tt = cleanText(texts[j]);
        if (tt) { meta.text = tt; break; }
      }
    }
    if (!meta.avatar) {
      var faces = findByClassFrag(container, ['avatar'], 3);
      for (var k = 0; k < faces.length; k++) {
        var src = '';
        try {
          src = faces[k].getAttribute && (faces[k].getAttribute('src') || faces[k].getAttribute('data-src'));
        } catch (e) {}
        if (!src) {
          try {
            var inner = faces[k].querySelector && faces[k].querySelector('img');
            if (inner) src = inner.getAttribute('src') || inner.getAttribute('data-src') || '';
          } catch (e) {}
        }
        if (src && /\/bfs\/face\//.test(src)) { meta.avatar = src; break; }
      }
    }
    return meta;
  }

  function urlsFromAttrValue(v) {
    var out = [];
    var s = str(v).trim();
    if (!s) return out;
    var parts = s.indexOf(',') >= 0 ? s.split(',') : [s];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim().split(/\s+/)[0];
      if (p) out.push(p);
    }
    return out;
  }

  /* 判定一个地址是不是「评论区用户上传的图片」。
     这里必须用白名单，不能用黑名单：
     视频封面和评论图同在 /bfs/ 下，路径长得一模一样，
     只有 B站评论图专用的 new_dyn / album 命名空间才是可靠特征。 */
/* @self-test-begin:filter */
  function isCommentPictureUrl(u) {
    var s = str(u).trim();
    if (!s) return false;
    if (/^\/\//.test(s)) s = 'https:' + s;
    if (!/^https?:\/\//i.test(s)) return false;
    if (!/hdslb\.com|biliimg\.com/i.test(s)) return false;
    if (/\.(svg|ico|json|js|css)$/i.test(s)) return false;
    if (!/^https?:\/\/[^/]+\/bfs\/(new_dyn|album)\//i.test(s)) return false;
    // 头像 / 表情 / 挂件 / 活动 UI / 用户装扮
    if (/\/(face|emote|garb|vip|live|activity-plat|upower|ugc)\//i.test(s)) return false;
    if (/activity-plat|\/static\//i.test(s)) return false;
    // 文件名里带 emote / emoji / sticker 等标记的（即使被 B 站存进 new_dyn）也算表情
    var fname = s.split('/').pop() || '';
    if (/(emote|emoji|sticker|emoticon)/i.test(fname)) return false;
    return /\.(jpe?g|png|gif|webp|avif|bmp)([?@!]|$)/i.test(s);
  }

  /* 表情图在 DOM 里通常带 emote 相关 class/属性，命中就跳过 */
  function looksLikeEmoteNode(node, stops) {
    var el = node;
    var hops = 0;
    while (el && hops++ < 4) {
      if (el === stops) break;
      try {
        var cn = '';
        try { cn = str(el.className); } catch (e) { cn = ''; }
        var tag = str(el.tagName).toLowerCase();
        var attrs = '';
        if (el.getAttribute) {
          attrs = str(el.getAttribute('data-type')) + ' ' +
            str(el.getAttribute('data-emote')) + ' ' +
            str(el.getAttribute('alt'));
        }
        var hay = (cn + ' ' + str(el.id) + ' ' + tag + ' ' + attrs).toLowerCase();
        if (/emote|emoji|bili-emote|small-emoji|reply-emote|icon-emoji|emoticon|sticker|表情|贴纸/.test(hay)) return true;
        // 尺寸特别小的图基本是表情/图标（评论图缩略图都 > 40px）。
        // width 属性优先，其次用已加载出的真实像素尺寸（naturalWidth）。
        if (tag === 'img') {
          var w = parseInt(el.getAttribute && el.getAttribute('width'), 10) || 0;
          if (!w) {
            try { w = el.naturalWidth || 0; } catch (e2) {}
          }
          if (w && w <= 40) return true;
        }
      } catch (e) {}
      el = el.parentNode || (el.host || null);
    }
    return false;
  }
/* @self-test-end:filter */

  function collectImgUrls(el) {
    var out = [];
    var attrs = ['data-src', 'data-original', 'data-original', 'src'];
    for (var i = 0; i < attrs.length; i++) {
      var v = '';
      try { v = el.getAttribute && el.getAttribute(attrs[i]); } catch (e) {}
      if (!v) continue;
      var parts = urlsFromAttrValue(v);
      for (var j = 0; j < parts.length; j++) out.push(parts[j]);
    }
    try {
      if (el.currentSrc) out.push(el.currentSrc);
      if (el.src) out.push(el.src);
    } catch (e) {}
    return out;
  }

  /* 懒加载图等真正加载完成后再重扫一次，否则 naturalWidth=0，
     尺寸过滤（表情/图标 <200px）形同虚设。 */
  var domRescanTimer = 0;
  function requestDomRescan() {
    if (domRescanTimer) return;
    domRescanTimer = setTimeout(function () {
      domRescanTimer = 0;
      try { scanDom(); } catch (e) {}
      try { mergeOrphans(); } catch (e) {}
      scheduleBroadcast();
    }, 600);
  }

  /* 扫描 DOM：只认「评论容器内部」的图。
     整页遍历是必须的（评论可能是 Shadow DOM），但绝不能见到 /bfs/ 图就收，
     否则相关推荐、视频封面、UP 主头像都会被算进来。 */
  function scanDom() {
    var added = 0;
    var skippedNoContainer = 0;
    var skippedEmote = 0;
    var skippedLazy = 0;
    eachRoot(function (root) {
      var imgs;
      try { imgs = root.querySelectorAll('img'); } catch (e) { return; }
      for (var i = 0; i < imgs.length; i++) {
        var el = imgs[i];
        var container = findGroupContainer(el);
        if (!container) { skippedNoContainer++; continue; }
        var urls = collectImgUrls(el);
        var accepted = [];
        for (var j = 0; j < urls.length; j++) {
          if (isCommentPictureUrl(urls[j])) accepted.push(urls[j]);
        }
        if (!accepted.length) continue;
        if (looksLikeEmoteNode(el, container)) { skippedEmote++; continue; }
        var meta = metaFromContainer(container, el);
        // DOM 里能量到真实像素尺寸：小图（表情）直接挡掉
        var natW = 0;
        var natH = 0;
        try {
          natW = el.naturalWidth || parseInt(el.getAttribute('width'), 10) || 0;
          natH = el.naturalHeight || parseInt(el.getAttribute('height'), 10) || 0;
        } catch (e) {}
        if (!(natW > 0)) natW = 0;
        if (!(natH > 0)) natH = 0;
        // 懒加载还没出真实尺寸：被信任评论的图先不收，等加载完成后由
        // requestDomRescan 重扫，让尺寸过滤（表情/贴纸 <200px）真正生效；
        // 否则几十像素的表情会在尺寸未知时溜进来，之后再也过滤不掉。
        // 不被信任的（其它评论者 / 游离图）不推迟，直接走 addRecord 被拒绝并计数。
        if (!natW || !natH) {
          var probeUrl = normalizeUrl(accepted[0]);
          var deferrable = probeUrl && isTrustedRecord({
            url: probeUrl, rpid: meta.rpid, author: meta.author, mid: meta.mid, source: 'dom'
          });
          if (deferrable) {
            skippedLazy++;
            if (!el.__biliDeferScan__) {
              try {
                el.__biliDeferScan__ = true;
                el.addEventListener('load', requestDomRescan, { once: true });
              } catch (e) {}
            }
            continue;
          }
        }
        for (var k = 0; k < accepted.length; k++) {
          var url = normalizeUrl(accepted[k]);
          if (!url || !isImageUrl(url)) continue;
          var before = totalSeen;
          addRecord({
            url: url, rpid: meta.rpid, author: meta.author, mid: meta.mid,
            width: natW, height: natH, index: 0, total: 0,
            source: 'dom'
          }, null);
          if (totalSeen > before) added++;
        }
      }
    });
    if (skippedNoContainer || skippedEmote || skippedLazy) {
      engine.log('DOM 扫描过滤：非评论区图片 ' + skippedNoContainer + ' 个，表情 ' + skippedEmote + ' 个，懒加载待重扫 ' + skippedLazy + ' 个');
    }
    return added;
  }

  //===================================================================
  // 5. 图片查看器（隐藏的第 9 张就在这里面）
  //===================================================================

  /* 注意：不要用 offsetParent 判可见性 —— 对 position:fixed 的元素它恒为 null，
     而查看器基本都是 fixed 全屏层，用它会永远判定为"没打开"。 */
  function elementVisible(el) {
    if (!el) return false;
    try {
      if (el.getClientRects && el.getClientRects().length) return true;
    } catch (e) {}
    try {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && (r.width > 0 || r.height > 0)) return true;
    } catch (e) {}
    try {
      if (el.style && el.style.display === 'none') return false;
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      if (cs && cs.opacity === '0') return false;
    } catch (e) {}
    return false;
  }

  function viewerVisible() {
    for (var i = 0; i < VIEWER_TAGS.length; i++) {
      try {
        var els = document.querySelectorAll(VIEWER_TAGS[i]);
        for (var j = 0; j < els.length; j++) {
          if (elementVisible(els[j])) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  /* 查看器里的 img 常常用 lazy 属性承载真实地址。
     注意：只有在查看器真的打开时才扫，否则会把页面上任意一张 /bfs/ 图
     （视频封面、相关推荐等）当成评论图收进来。 */
  function scanViewerImgs() {
    var added = 0;
    if (!viewerVisible()) return 0;
    eachRoot(function (root) {
      var imgs;
      try { imgs = root.querySelectorAll('img'); } catch (e) { return; }
      for (var i = 0; i < imgs.length; i++) {
        var urls = collectImgUrls(imgs[i]);
        for (var j = 0; j < urls.length; j++) {
          if (!isCommentPictureUrl(urls[j])) continue;
          var url = normalizeUrl(urls[j]);
          if (!url || !isImageUrl(url)) continue;
          var before = totalSeen;
          addRecord({
            url: url, width: 0, height: 0, index: 0, total: 0,
            rpid: '', author: '', source: 'viewer'
          }, null);
          if (totalSeen > before) added++;
        }
      }
    });
    return added;
  }

  /* 从查看器组件的 props 里直接读出完整图片数组（最可靠） */
  var SEEN_ARRAYS = new WeakSet();
  function scanViewerProps() {
    if (!viewerVisible()) return 0;
    var added = 0;
    var props = [
      '__vue__', '__vueParentComponent', '__vue_app__',
      '__reactProps$', '__reactFiber$', '_reactProps', '__svelte_meta'
    ];
    eachRoot(function (root) {
      var els;
      try { els = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) added += probeElement(els[i], props, 0);
    });
    return added;
  }

  var PIC_KEYS = ['pictures', 'pics', 'imgList', 'images', 'list', 'allPictures', 'pictureList', 'picList'];

  function probeElement(el, props, depth) {
    if (!el || typeof el !== 'object' || depth > 2) return 0;
    var added = 0;
    for (var i = 0; i < props.length; i++) {
      var v;
      try { v = el[props[i]]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (el[props[i]] && Object.prototype.toString.call(v) === '[object Object]' && depth < 2) {
        // 只往下钻一层，避免大对象图遍历
        for (var k = 0; k < PIC_KEYS.length; k++) {
          var cand;
          try { cand = v[PIC_KEYS[k]]; } catch (e) { continue; }
          if (looksLikePictureArray(cand)) added += absorbPictureArray(cand);
        }
      }
    }
    // 直接挂在元素上的图片数组
    for (var j = 0; j < PIC_KEYS.length; j++) {
      var arr;
      try { arr = el[PIC_KEYS[j]]; } catch (e) { continue; }
      if (looksLikePictureArray(arr)) added += absorbPictureArray(arr);
    }
    return added;
  }

  function absorbPictureArray(arr) {
    if (!arr || SEEN_ARRAYS.has(arr)) return 0;
    try { SEEN_ARRAYS.add(arr); } catch (e) {}
    // 这里拿不到 rpid，交给 URL 匹配 / 后续补全；来源标记为查看器
    return absorbRecords(extractFromPayload(arr), 'viewer-props');
  }

  /* 监控查看器打开 / 翻页 */
  function startViewerWatch() {
    var mo = new MutationObserver(function () {
      if (!viewerVisible()) return;
      var a = scanViewerImgs();
      var b = scanViewerProps();
      if (a + b > 0) scheduleBroadcast();
    });
    try {
      mo.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['src', 'data-src', 'style', 'class', 'open']
      });
    } catch (e) {}
    // 点击也算，覆盖懒加载不触发 mutation 的情况
    document.addEventListener('click', function () {
      setTimeout(function () { if (viewerVisible()) { scanViewerImgs(); scanViewerProps(); } }, 400);
      setTimeout(function () { if (viewerVisible()) { scanViewerImgs(); scanViewerProps(); } }, 1200);
    }, true);
  }

  /* 监听真实图片请求：查看器翻页时必然去拿隐藏图，
     用 hash 前缀把它认领回原来的评论 */
  function startImageRequestWatch() {
    var origSend = XMLHttpRequest.prototype.send;
    var origFetch = window.fetch;
    // XHR 已在上面包过，这里只补图片 URL 嗅探
    var imgRe = /\/bfs\/(new_dyn|album)\/[^@?#]+/i;
    try {
      var obs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var n = entries[i].name;
          if (imgRe.test(n)) claimLooseImage(n, 'viewer-lazy');
        }
      });
      obs.observe({ entryTypes: ['resource'] });
    } catch (e) {}
  }

  function baseNameOf(u) {
    var s = normalizeUrl(u);
    return s.replace(/^https?:\/\/[^/]+/i, '').split('/').pop() || '';
  }

  /* 一张没有 rpid 的图 → 尽量认领到同前缀的评论分组 */
  function claimLooseImage(url, source) {
    var url2 = normalizeUrl(url);
    if (!url2 || imageMap[dedupeKey(url2)]) return null;
    var name = baseNameOf(url2);
    var prefix = name.slice(0, 12).toLowerCase();
    var best = null;
    if (prefix.length >= 8) {
      for (var i = 0; i < order.length; i++) {
        var g = groups[order[i]];
        if (!g || !g.images.length) continue;
        var bn = baseNameOf(g.images[0].url);
        if (bn.toLowerCase().indexOf(prefix) === 0 ||
            (bn.length > 12 && name.toLowerCase().indexOf(bn.slice(0, 12).toLowerCase()) === 0)) {
          best = g;
          break;
        }
      }
    }
    var rec = { url: url2, index: best ? (best.images.length + 1) : 0, source: source };
    if (best) {
      rec.rpid = best.rpid;
      rec.author = best.author;
      rec.mid = best.mid;
      rec.total = Math.max(best.declared || 0, best.images.length + 1);
    }
    return addRecord(rec, null);
  }

  /* 把查看器里抓到的孤儿图，按「同前缀哈希」归并到已有评论 */
  function mergeOrphans() {
    var orphans = [];
    for (var i = 0; i < order.length; i++) {
      var g = groups[order[i]];
      if (!g.rpid && !g.author) orphans.push(g);
    }
    if (!orphans.length) return 0;
    var moved = 0;
    for (var oi = 0; oi < orphans.length; oi++) {
      var og = orphans[oi];
      for (var ii = 0; ii < og.images.length; ii++) {
        var img = og.images[ii];
        var claimed = claimLooseImage(img.url, 'viewer');
        if (claimed && claimed.groupKey !== og.key) {
          // 从孤儿组移除
          var gi = og.images.indexOf(img);
          if (gi >= 0) og.images.splice(gi, 1);
          moved++;
        }
      }
      if (!og.images.length) {
        delete groups[og.key];
        var oi2 = order.indexOf(og.key);
        if (oi2 >= 0) order.splice(oi2, 1);
      }
    }
    if (moved) scheduleBroadcast();
    return moved;
  }

  /* 清掉一切不符合「评论区图片」特征的记录（兜底用） */
  function purgeJunk() {
    var removed = 0;
    for (var gi = order.length - 1; gi >= 0; gi--) {
      var g = groups[order[gi]];
      if (!g) continue;
      for (var ii = g.images.length - 1; ii >= 0; ii--) {
        var img = g.images[ii];
        if (!isCommentPictureUrl(img.url)) {
          delete imageMap[img.key];
          g.images.splice(ii, 1);
          removed++;
        }
      }
      if (!g.images.length) {
        delete groups[g.key];
        order.splice(gi, 1);
      }
    }
    if (removed) scheduleBroadcast();
    return removed;
  }

  //===================================================================
  // 6. 直接调 API 补全（含 wbi 签名 + 两个旧接口兜底）
  //===================================================================

  var WBI_CACHE = { key: '', ts: 0 };

  function md5(input) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { var l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function toBlocks(str) {
      var n = ((str.length + 8) >> 6) + 1;
      var blks = new Array(n * 16);
      for (var i = 0; i < n * 16; i++) blks[i] = 0;
      for (var j = 0; j < str.length; j++) blks[j >> 2] |= str.charCodeAt(j) << ((j % 4) * 8);
      blks[str.length >> 2] |= 0x80 << ((str.length % 4) * 8);
      blks[n * 16 - 2] = str.length * 8;
      return blks;
    }
    var s = unescape(encodeURIComponent(String(input)));
    var x = toBlocks(s);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
      c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    return [a, b, c, d];
  }

  function md5Hex(input) {
    var x = md5(input);
    var hex = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        var byte = (x[i] >> (j * 8)) & 0xff;
        out += hex.charAt((byte >> 4) & 0x0f) + hex.charAt(byte & 0x0f);
      }
    }
    return out;
  }

  function nowSec() { return Math.floor(Date.now() / 1000); }

  var MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  function mixinKey(orig) {
    var out = '';
    for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
      out += orig.charAt(MIXIN_KEY_ENC_TAB[i]);
    }
    return out.slice(0, 32);
  }

  function getWbiKeys() {
    if (WBI_CACHE.key && (nowSec() - WBI_CACHE.ts) < 1800) {
      return Promise.resolve(WBI_CACHE.key);
    }
    return fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var img = (j.data && j.data.wbi_img) || {};
        var imgUrl = img.img_url || '';
        var subUrl = img.sub_url || '';
        var imgKey = imgUrl.split('/').pop().split('.')[0];
        var subKey = subUrl.split('/').pop().split('.')[0];
        if (!imgKey || !subKey) throw new Error('no wbi keys');
        WBI_CACHE.key = mixinKey(imgKey + subKey);
        WBI_CACHE.ts = nowSec();
        return WBI_CACHE.key;
      });
  }

  function encWbi(params, mixin) {
    var wts = nowSec();
    var p = {};
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v === undefined || v === null) continue;
      p[k] = String(v).replace(/[!'()*]/g, '');
    }
    p.wts = String(wts);
    var keys = Object.keys(p).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(p[keys[i]]));
    }
    var query = parts.join('&');
    var wRid = md5Hex(query + mixin);
    return query + '&w_rid=' + wRid;
  }

  function apiGet(path, params, useWbi) {
    var qs = '';
    var go = function (mixin) {
      if (useWbi && mixin) {
        qs = encWbi(params, mixin);
      } else {
        var parts = [];
        for (var k in params) {
          if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
          if (params[k] === undefined || params[k] === null) continue;
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
        qs = parts.join('&');
      }
      return fetch(path + '?' + qs, {
        credentials: 'include',
        headers: { 'Accept': 'application/json, text/plain, */*' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    };
    var p;
    if (useWbi) {
      p = getWbiKeys().then(function (mixin) { return go(mixin); })
        .catch(function () { return go(''); });
    } else {
      p = go('');
    }
    return p.then(function (json) {
      if (!json || json.code !== 0) {
        var err = new Error('code ' + ((json && json.code) || '?') + ' ' + ((json && json.message) || ''));
        err.biliCode = json && json.code;
        err.body = json;
        throw err;
      }
      return json;
    });
  }

  function getAid() {
    var m = location.pathname.match(/\/(BV[0-9A-Za-z]{10})/i);
    if (window.__INITIAL_STATE__) {
      try {
        var st = window.__INITIAL_STATE__;
        var aid0 = (st.videoData && st.videoData.aid) ||
          (st.aid) ||
          (st.videoInfo && st.videoInfo.aid);
        if (aid0) return Promise.resolve(String(aid0));
      } catch (e) {}
    }
    if (m) {
      return apiGet('https://api.bilibili.com/x/web-interface/view', { bvid: m[1] }, false)
        .then(function (j) { return String(j.data.aid); });
    }
    return Promise.reject(new Error('没有识别到视频号（BV/av）'));
  }

  function rememberAid(aid) {
    try { if (aid) aid = String(aid); } catch (e) {}
    return aid;
  }

  /* 拉取评论区（顶层 + 楼中楼），返回新增图片数 */
  function pullComments(aid, opts) {
    opts = opts || {};
    var maxPages = opts.maxPages || 50;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var added = 0;
    var pagesDone = 0;

    function absorb(json) {
      var data = (json && json.data) || json;
      var n = absorbRecords(extractFromPayload(data), 'api');
      added += n;
      return data;
    }

    // 策略 A：wbi/main 游标式翻页（网页端同款接口）
    function viaMain(next, page) {
      if (page > maxPages) return Promise.resolve();
      return apiGet('https://api.bilibili.com/x/v2/reply/wbi/main', {
        oid: aid,
        type: 1,
        mode: 3,
        next: next,
        ps: 20,
        plat: 1,
        web_location: 1315875
      }, true).then(function (json) {
        var data = absorb(json);
        pagesDone++;
        onProgress({ page: pagesDone, added: added, phase: 'main' });
        var cursor = data && data.cursor;
        var nextNext = '';
        try {
          nextNext = (cursor && cursor.pagination_reply && cursor.pagination_reply.next_offset) || '';
        } catch (e) {}
        if (!nextNext && cursor && cursor.is_end === false && cursor.next !== undefined) {
          nextNext = String(cursor.next);
        }
        if (!nextNext || nextNext === next) return;
        return viaMain(nextNext, page + 1);
      });
    }

    // 策略 B：老接口 /x/v2/reply （简单翻页，带 cookie 时同样返回完整 pictures）
    function viaLegacy(pn) {
      if (pn > maxPages) return Promise.resolve();
      return apiGet('https://api.bilibili.com/x/v2/reply', {
        type: 1, oid: aid, sort: 2, ps: 20, pn: pn, nohot: 0
      }, false).then(function (json) {
        var data = absorb(json);
        var replies = (data && data.replies) || [];
        pagesDone++;
        onProgress({ page: pagesDone, added: added, phase: 'legacy' });
        var page = (data && data.page) || {};
        var count = page.count || 0;
        if (!replies.length) return;
        if (pn * 20 >= count) return;
        return delay(300).then(function () { return viaLegacy(pn + 1); });
      });
    }

    var mode = opts.mode || 'auto';
    var chain;
    if (mode === 'legacy') {
      chain = viaLegacy(1);
    } else if (mode === 'main') {
      chain = viaMain('', 1);
    } else {
      chain = viaMain('', 1).catch(function () { return null; }).then(function () {
        if (added > 0) return null;
        return viaLegacy(1).catch(function () { return null; });
      });
    }
    return chain.then(function () {
      return { added: added, pages: pagesDone };
    });
  }

  /* 只补一条评论的图（用它自己的 rpid 拉整楼） */
  function pullOneReply(rpid, aid) {
    var before = totalSeen;
    return apiGet('https://api.bilibili.com/x/v2/reply/reply', {
      type: 1, oid: aid, root: rpid, ps: 20, pn: 1
    }, false).catch(function () {
      return apiGet('https://api.bilibili.com/x/v2/reply', {
        type: 1, oid: aid, sort: 2, ps: 20, pn: 1, nohot: 0
      }, false);
    }).then(function (json) {
      absorbRecords(extractFromPayload((json && json.data) || json), 'pull-one');
      return { added: totalSeen - before };
    });
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  //===================================================================
  // 7. 对外的消息接口（油猴沙箱 ↔ 页面引擎）
  //===================================================================

  window.__BILI_CDN__ = window.__BILI_CDN__ || {};
  var engine = window.__BILI_CDN__;

  engine.push = function (payload) {
    try {
      window.dispatchEvent(new CustomEvent('bili-cdn-snapshot', { detail: payload }));
    } catch (e) {}
  };

  engine.log = function () {
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, ['[B站评论图]'].concat(args)); } catch (e) {}
  };

  engine.handle = function (method, payload) {
    var aid = rememberAid((payload && payload.aid) || '');
    switch (method) {
      case 'ping':
        return { ok: true, video: currentVideoId(), snapshot: snapshot() };
      case 'snapshot':
        return snapshot();
      case 'scan-dom': {
        var a = scanDom();
        // 查看器里的图单独用「抓查看器」按钮或自动监听获取，
        // 这里不再顺带扫查看器，避免把页面上任意 /bfs/ 图当成评论图。
        var c = scanViewerProps();
        mergeOrphans();
        return { ok: true, added: a + c, snapshot: snapshot() };
      }
      case 'scan-viewer': {
        var v1 = scanViewerImgs();
        var v2 = scanViewerProps();
        mergeOrphans();
        return { ok: true, added: v1 + v2, snapshot: snapshot() };
      }
      case 'scan-initial': {
        scanInitialState();
        return { ok: true, snapshot: snapshot() };
      }
      case 'purge-junk': {
        var purged = purgeJunk();
        return { ok: true, removed: purged, snapshot: snapshot() };
      }
      /* 供排查/测试：手动灌入一段接口形状的 JSON（等同于 hook 到一次评论接口响应） */
      case 'ingest-api': {
        var ingested = absorbRecords(extractFromPayload(payload.json), 'api');
        return { ok: true, added: ingested, snapshot: snapshot() };
      }
      case 'stats': {
        return {
          ok: true,
          trustedMids: Object.keys(trustedMids).length,
          trustedRpids: Object.keys(trustedRpids).length,
          rejected: rejectedCount,
          emotes: emoteRejected,
          total: totalSeen,
          accepted: acceptedLog.slice(-40),
          snapshot: snapshot()
        };
      }
      case 'clear':
        groups = {}; order = []; imageMap = {}; uncheckedKeys = {}; defaultChecked = true; totalSeen = 0; hiddenSeen = 0;
        trustedMids = {}; trustedRpids = {}; rejectedCount = 0; emoteRejected = 0; acceptedLog = [];
        lastDigest = ''; parseQueue = [];
        return { ok: true, snapshot: snapshot() };
      case 'set-check': {
        var n = 0;
        defaultChecked = !!payload.checked;
        for (var k in imageMap) {
          if (!Object.prototype.hasOwnProperty.call(imageMap, k)) continue;
          imageMap[k].checked = !!payload.checked;
          if (payload.checked) delete uncheckedKeys[k];
          else uncheckedKeys[k] = true;
          n++;
        }
        scheduleBroadcast();
        return { ok: true, changed: n };
      }
      case 'set-check-one': {
        var img = imageMap[payload.key];
        if (img) {
          img.checked = !!payload.checked;
          if (payload.checked) delete uncheckedKeys[payload.key];
          else uncheckedKeys[payload.key] = true;
        }
        return { ok: true };
      }
      case 'set-state': {
        var im = imageMap[payload.key];
        if (im) im.state = str(payload.state);
        return { ok: true };
      }
      case 'claim': {
        var claimed = claimLooseImage(payload.url, 'viewer');
        return { ok: true, claimed: !!claimed, snapshot: snapshot() };
      }
      case 'pull': {
        return getAid().then(function (realAid) {
          return pullComments(realAid, {
            mode: payload.mode || 'auto',
            maxPages: payload.maxPages || 50,
            onProgress: function (p) { engine.progress(p); }
          });
        }).then(function (res) {
          mergeOrphans();
          return { ok: true, added: res.added, pages: res.pages, snapshot: snapshot() };
        });
      }
      case 'pull-one': {
        return getAid().then(function (realAid) {
          return pullOneReply(payload.rpid, realAid);
        }).then(function (res) {
          return { ok: true, added: res.added, snapshot: snapshot() };
        });
      }
      case 'rename': {
        return { ok: true, snapshot: snapshot() };
      }
      default:
        return { ok: false, error: 'unknown method: ' + method };
    }
  };

  engine.progress = function (p) {
    try {
      window.dispatchEvent(new CustomEvent('bili-cdn-progress', { detail: p }));
    } catch (e) {}
  };

  engine.respond = function (id, result, error) {
    try {
      window.dispatchEvent(new CustomEvent('bili-cdn-response', {
        detail: { id: id, result: result || null, error: error ? String(error.message || error) : null }
      }));
    } catch (e) {}
  };

  // 油猴沙箱通过这个 CustomEvent 下发指令
  window.addEventListener('bili-cdn-request', function (ev) {
    var d = (ev && ev.detail) || {};
    var id = d.id;
    var out;
    try {
      out = engine.handle(d.method, d.payload || {});
    } catch (e) {
      engine.respond(id, null, e);
      return;
    }
    if (out && typeof out.then === 'function') {
      out.then(function (r) { engine.respond(id, r, null); },
        function (e) { engine.respond(id, null, e); });
    } else {
      engine.respond(id, out, null);
    }
  });

  //===================================================================
  // 8. 启动
  //===================================================================

  function boot() {
    scanInitialState();
    // 首屏评论是异步渲染的，分几次扫描兜底
    var tries = [0, 500, 1500, 3000, 6000, 10000];
    for (var i = 0; i < tries.length; i++) {
      (function (t) {
        setTimeout(function () {
          try { scanDom(); } catch (e) {}
          try { mergeOrphans(); } catch (e) {}
        }, t);
      })(tries[i]);
    }
    startViewerWatch();
    startImageRequestWatch();
    // 滚动/懒加载会不断插入新的评论图：节流补扫，不重扫整棵树太频繁
    var lastScan = 0;
    var scanTimer = 0;
    function throttledScan() {
      var now = Date.now();
      var wait = Math.max(0, 1200 - (now - lastScan));
      if (scanTimer) return;
      scanTimer = setTimeout(function () {
        scanTimer = 0;
        lastScan = Date.now();
        try { scanDom(); } catch (e) {}
        try { mergeOrphans(); } catch (e) {}
      }, wait);
    }
    var mo = new MutationObserver(function (records) {
      var interesting = false;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList' && r.addedNodes && r.addedNodes.length) { interesting = true; break; }
        if (r.type === 'attributes') { interesting = true; break; }
      }
      if (interesting) throttledScan();
      scheduleBroadcast();
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src'] }); } catch (e) {}
    scheduleBroadcast();
    engine.log('引擎已就绪', currentVideoId());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
`;
  }

  function injectPageEngine() {
    try {
      var src = pageEngineSource();
      var el = document.createElement('script');
      el.textContent = src;
      el.setAttribute('data-ccfg', JSON.stringify({ injectTime: Date.now() }));
      (document.head || document.documentElement || document).appendChild(el);
      el.remove();
    } catch (e) {
      console.error('[B站评论图] 注入页面引擎失败：', e);
    }
  }

  injectPageEngine();

  // 供排查使用：控制台执行 __BILI_CDN_DEBUG__() 打印面板/环境诊断
  try {
    window.__BILI_CDN_DEBUG__ = () => debugDump();
    window.__BILI_CDN_UI__ = () => els.wrap || null;
  } catch (e) {}

  //===================================================================
  // 2. 沙箱侧：消息桥 + 下载引擎 + UI
  //===================================================================

  const CFG_KEY = 'biliCommentImages:cfg';
  // 默认命名 = B站原文件名；按评论人名字命名没有意义，同名图还会互相覆盖
  const DEFAULT_TPL = '{name}.{ext}';
  const store = {
    read() {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(CFG_KEY, null);
          if (v) return typeof v === 'string' ? JSON.parse(v) : v;
        }
      } catch (e) {}
      try {
        const raw = localStorage.getItem(CFG_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return {};
    },
    write(v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, JSON.stringify(v));
      } catch (e) {}
      try { localStorage.setItem(CFG_KEY, JSON.stringify(v)); } catch (e) {}
    }
  };

  const cfg = Object.assign({
    quality: 'original',       // raw | original | max
    // 默认直接用 B站的原文件名（new_dyn 的 hash 名），
    // 按评论人名字命名没有意义，同名图还会互相覆盖。
    tpl: DEFAULT_TPL,
    subfolder: false,
    concurrency: 2,
    timeout: 30000,
    retries: 3,
    autoScan: true,
    minSize: 0
  }, store.read());

  function saveCfg() { store.write(cfg); }

  // ---------- 与页面引擎通信 ----------
  let reqSeq = 0;
  const pending = new Map();

  function callEngine(method, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = 'q' + (++reqSeq) + '_' + Date.now().toString(36);
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('页面引擎无响应：' + method));
        }
      }, timeoutMs || 60000);
      pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      window.dispatchEvent(new CustomEvent('bili-cdn-request', {
        detail: { id, method, payload: payload || {} }
      }));
    });
  }

  window.addEventListener('bili-cdn-response', (ev) => {
    const d = (ev && ev.detail) || {};
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.result);
  });

  let lastSnapshot = { groups: [], total: 0, hidden: 0 };
  window.addEventListener('bili-cdn-snapshot', (ev) => {
    lastSnapshot = (ev && ev.detail) || lastSnapshot;
    if (uiReady) renderAll();
  });

  let pullProgress = null;
  window.addEventListener('bili-cdn-progress', (ev) => {
    pullProgress = (ev && ev.detail) || null;
    if (uiReady) renderStatus();
  });

  // ---------- 下载引擎 ----------
  const dl = {
    done: 0,
    fail: 0,
    running: false,
    cancelled: false,
    queue: [],
    failures: [],
    active: 0,
    current: ''
  };

  function gmDownload(details) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== 'function') {
        reject(new Error('GM_download 不可用'));
        return;
      }
      let settled = false;
      try {
        GM_download({
          url: details.url,
          name: details.name,
          saveAs: false,
          headers: { Referer: location.origin + '/', Origin: location.origin },
          onload: () => { if (!settled) { settled = true; resolve(); } },
          onerror: (e) => { if (!settled) { settled = true; reject(new Error('GM_download: ' + ((e && (e.error || e.details)) || 'error'))); } },
          ontimeout: () => { if (!settled) { settled = true; reject(new Error('GM_download timeout')); } }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function blobDownload(url, name) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: cfg.timeout,
        headers: { Referer: location.origin + '/' },
        onload: (res) => {
          try {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error('HTTP ' + res.status));
              return;
            }
            if (!res.response) {
              reject(new Error('空响应'));
              return;
            }
            const objUrl = URL.createObjectURL(res.response);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = name;
            a.style.display = 'none';
            (document.body || document.documentElement).appendChild(a);
            a.click();
            setTimeout(() => {
              try { a.remove(); } catch (e) {}
              try { URL.revokeObjectURL(objUrl); } catch (e) {}
            }, 60000);
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  function extOf(url, pic) {
    const s = String(url || '');
    const m = s.match(/@[^/?#]*\.([a-z0-9]{2,4})$/i) || s.match(/\.([a-z0-9]{2,4})(?:[?#]|$)/i);
    if (m) {
      const e = m[1].toLowerCase();
      return e === 'jpeg' ? 'jpg' : e;
    }
    return pic && pic.gif ? 'gif' : 'jpg';
  }

  function baseNameOfUrl(url) {
    const s = String(url || '').replace(/@[^/?#]*$/, '').replace(/[?#].*$/, '');
    let base = s.split('/').pop() || '';
    try { base = decodeURIComponent(base); } catch (e) {}
    if (base.indexOf('http') >= 0) base = base.split(/https?(_|%3A|:)/i).pop() || base;
    base = base.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{2,4}$/i, '');
    return base.slice(0, 60);
  }

  function qualityUrl(pic) {
    const url = pic.url;
    const mode = cfg.quality;
    if (mode === 'raw') return url;
    const w = pic.width | 0;
    const h = pic.height | 0;
    if (!w && !h) return mode === 'max' ? url + '@100q.png' : url;
    const base = (w ? w + 'w' : '') + (w && h ? '_' : '') + (h ? h + 'h' : '');
    return mode === 'max' ? url + '@' + base + '_1e_100q.png' : url + '@' + base + '_1e_1c.jpg';
  }

  function safeName(name, fallback) {
    let s = String(name === undefined || name === null ? '' : name) || String(fallback || 'unknown');
    s = s.replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
    if (s.length > 50) s = s.slice(0, 50);
    return s || String(fallback || 'unknown');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // 取 URL 里的短 hash 片段，用于同名去重（B站 new_dyn 文件名是一长串 hash）
  function shortTag(pic) {
    const base = baseNameOfUrl(pic.url) || '';
    const tail = base.replace(/[^0-9a-zA-Z]/g, '').slice(-8);
    return tail || String(pic.index || 1);
  }

  // 取 URL 路径里的"原文件名"（含扩展名），B站是 new_dyn 的 hash 名
  function originalName(pic) {
    const url = qualityUrl(pic);
    const path = String(url).replace(/@[^/?#]*$/, '').replace(/[?#].*$/, '');
    let tail = path.split('/').pop() || '';
    try { tail = decodeURIComponent(tail); } catch (e) {}
    if (tail.indexOf('http') >= 0) tail = tail.split(/https?(_|%3A|:)/i).pop() || tail;
    return tail;
  }

  function renderTpl(tpl, pic, group, ext, tag) {
    // B站原文件名（含扩展名），例如 74d196ecebf20141180f5b8dbe08ad42345177276.jpg
    const full = originalName(pic) || 'img';
    const extRe = new RegExp('\\.' + ext + '$', 'i');
    const hadExt = extRe.test(full);
    let stem = hadExt ? full.slice(0, full.length - ext.length - 1) : full;
    if (tag) stem = stem + '_' + tag;
    const t = String(tpl || '{name}.{ext}');
    let out = t
      .replace(/\{name\}/g, safeName(stem, 'img'))
      .replace(/\{author\}/g, safeName(group && group.author, 'unknown'))
      .replace(/\{mid\}/g, String((group && group.mid) || ''))
      .replace(/\{rpid\}/g, String((group && group.rpid) || 'noid'))
      .replace(/\{i\}/g, pad2(pic.index || 1))
      .replace(/\{n\}/g, String(pic.total || (group && group.total) || 1))
      .replace(/\{ext\}/g, ext);
    out = out.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/_{2,}/g, '_');
    out = out.replace(/^[^0-9A-Za-z\u4e00-\u9fa5\uff10-\uff19]+/, '');
    out = out.replace(/[_\s.]+$/, '');
    // 补扩展名：模板里写了 {ext} 就不再补；
    // 其它占位符可能已经带扩展名，避免出现 a.jpg.jpg
    if (!/\{ext\}/.test(t) && !extRe.test(out)) {
      out = out + '.' + ext;
    }
    if (!out) out = 'img_' + pad2(pic.index || 1);
    if (out.length > 120) out = out.slice(0, 120);
    return out;
  }

  // 同名冲突时加短 hash，避免同名文件互相覆盖/被浏览器改名成 (1)(2)。
  // 每批下载开始时清空，这样重复下载不会一路加后缀。
  const usedNames = new Map();
  function resetUsedNames() { usedNames.clear(); }
  function buildName(pic, group) {
    const ext = extOf(qualityUrl(pic), pic);
    let out = renderTpl(cfg.tpl, pic, group, ext, false);
    const key = out.toLowerCase();
    const owner = usedNames.get(key);
    if (owner && owner !== pic.key) {
      out = renderTpl(cfg.tpl, pic, group, ext, true);
    }
    usedNames.set(out.toLowerCase(), pic.key);
    if (cfg.subfolder) {
      const folder = safeName((group && group.author) || 'unknown', 'unknown');
      out = folder + '/' + out;
    }
    return out;
  }

  async function downloadOne(pic, group) {
    const url = qualityUrl(pic);
    const name = buildName(pic, group);
    const errors = [];
    for (let attempt = 0; attempt < Math.max(1, cfg.retries); attempt++) {
      if (dl.cancelled) throw new Error('已取消');
      try {
        if (typeof GM_download === 'function') {
          await gmDownload({ url, name });
          return name;
        }
      } catch (e) {
        errors.push(String(e.message || e));
      }
      try {
        await blobDownload(url, name.indexOf('/') >= 0 ? name.split('/').pop() : name);
        return name;
      } catch (e) {
        errors.push(String(e.message || e));
      }
      callEngine('set-state', { key: pic.key, state: 'idle' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400 + attempt * 600));
    }
    throw new Error(errors[errors.length - 1] || '下载失败');
  }

  async function runQueue() {
    if (dl.running) return;
    dl.running = true;
    dl.cancelled = false;
    // 新一批下载：重算文件名，避免沿用上一批的同名判定
    resetUsedNames();
    dl.done = 0;
    dl.fail = 0;
    dl.failures = [];
    renderStatus();

    const conc = Math.max(1, Math.min(6, cfg.concurrency | 0 || 2));
    let cursor = 0;
    const totalQueued = dl.queue.length;

    const worker = async () => {
      while (!dl.cancelled) {
        const idx = cursor++;
        if (idx >= dl.queue.length) return;
        const job = dl.queue[idx];
        dl.current = job.pic.url;
        renderStatus();
        try {
          await downloadOne(job.pic, job.group);
          dl.done++;
          job.pic.state = 'done';
        } catch (e) {
          dl.fail++;
          job.pic.state = 'fail';
          dl.failures.push({ pic: job.pic, group: job.group, error: String(e.message || e) });
          callEngine('set-state', { key: job.pic.key, state: 'fail' }).catch(() => {});
        }
        renderStatus();
      }
    };

    const workers = [];
    for (let i = 0; i < conc; i++) workers.push(worker());
    await Promise.all(workers);

    dl.running = false;
    dl.current = '';
    renderStatus();
    if (!dl.cancelled) {
      notify(`下载完成：成功 ${dl.done} 张` + (dl.fail ? `，失败 ${dl.fail} 张` : '') +
        (totalQueued ? `（共 ${totalQueued} 张）` : ''));
    }
  }

  function notify(text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ text, title: 'B站评论图批量下载', timeout: 6000 });
        return;
      }
    } catch (e) {}
    console.log('[B站评论图]', text);
  }

  //===================================================================
  // 3. UI 面板
  //===================================================================

  const UI_STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; left: auto; top: auto;
  width: 440px; max-height: 86vh;
  display: flex; flex-direction: column; z-index: 2147483000;
  background: #1c1f24; color: #e9ecf1; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); border: 1px solid #33373f;
  font-size: 13px; line-height: 1.5; overflow: hidden;
}
/* 兼容模式：宿主用 light DOM 承载面板（老内核 / Shadow DOM 异常时） */
.wrap.no-shadow {
  all: initial;
  position: fixed !important; right: 16px !important; bottom: 16px !important;
  top: auto !important; left: auto !important;
  width: 440px !important; max-height: 86vh !important;
  z-index: 2147483000 !important;
  display: flex !important; flex-direction: column !important;
  background: #1c1f24 !important; color: #e9ecf1 !important;
  border: 1px solid #33373f !important; border-radius: 12px !important;
  box-shadow: 0 12px 40px rgba(0,0,0,.45) !important;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif !important;
  overflow: hidden !important; text-align: left !important;
}
.wrap.no-shadow * { box-sizing: border-box !important; font-family: inherit !important; }
.wrap.no-shadow .body { display: flex !important; flex-direction: column !important; }
.wrap.no-shadow .head { display: flex !important; }
.wrap.no-shadow .row { display: flex !important; flex-wrap: wrap !important; }
.wrap.no-shadow .thumbs { display: flex !important; flex-wrap: wrap !important; }
.wrap.no-shadow .stat { display: flex !important; flex-wrap: wrap !important; }
.wrap.no-shadow .foot { display: flex !important; flex-wrap: wrap !important; }
.wrap.no-shadow .grp > .gh { display: flex !important; }
.wrap.no-shadow.min .body { display: none !important; }
.wrap.no-shadow.hidden { display: none !important; }
.wrap.min { max-height: 44px; }
.head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: move;
  background: linear-gradient(90deg,#fb7299,#e0668b); color: #fff; user-select: none; flex: 0 0 auto; }
.head .t { font-weight: 600; flex: 1 1 auto; }
.head .dot { width: 8px; height: 8px; border-radius: 50%; background: #7ee787; }
.head button { all: unset; cursor: pointer; padding: 0 6px; border-radius: 6px; color: #fff; font-size: 14px; }
.head button:hover { background: rgba(255,255,255,.22); }
.body { display: flex; flex-direction: column; overflow: hidden; }
.wrap.min .body { display: none; }
.sec { padding: 10px 12px; border-bottom: 1px solid #2a2e35; }
.sec:last-child { border-bottom: 0; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.btn { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px; background: #2b3038;
  border: 1px solid #3a404a; color: #e9ecf1; font-size: 12px; text-align: center; }
.btn:hover { background: #353b45; border-color: #4a515d; }
.btn:active { transform: translateY(1px); }
.btn.pri { background: #fb7299; border-color: #fb7299; color: #fff; font-weight: 600; }
.btn.pri:hover { background: #ff85a8; }
.btn.ghost { background: transparent; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
.small { font-size: 11px; color: #9aa3b2; }
.stat { display: flex; gap: 10px; flex-wrap: wrap; padding: 8px 12px; background: #191c21; font-size: 12px; }
.stat b { color: #fb7299; }
.warn { color: #ffd166; }
.ok { color: #7ee787; }
.bad { color: #ff7b72; }
.list { overflow: auto; max-height: 46vh; padding: 6px 8px; }
.grp { border: 1px solid #2f343c; border-radius: 9px; margin: 6px 0; background: #20242a; overflow: hidden; }
.grp > .gh { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #242932; }
.grp > .gh .au { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #333a45; color: #cfd6e2; white-space: nowrap; }
.badge.hid { background: #4a3b12; color: #ffd166; }
.badge.full { background: #17351f; color: #7ee787; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 6px; padding: 8px; }
.th { position: relative; width: auto; height: 0; padding-bottom: 100%; border-radius: 7px;
  overflow: hidden; background: #2b3038; cursor: pointer; border: 2px solid transparent; }
.th img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.th.on { border-color: #fb7299; }
.th.off { opacity: .38; }
.th.fail { border-color: #ff7b72; }
.th .no { position: absolute; left: 4px; top: 3px; font-size: 11px; font-weight: 600;
  color: #fff; text-shadow: 0 1px 4px #000; }
.th .hd { position: absolute; right: 4px; top: 3px; font-size: 10px; color: #ffd166; text-shadow: 0 1px 4px #000; }
.th .gif { position: absolute; left: 4px; bottom: 3px; font-size: 10px; color: #9fe8ff; text-shadow: 0 1px 4px #000; }
.sel { display: flex; align-items: center; gap: 8px; }
select, input[type=text], input[type=number] { background: #262b33; color: #e9ecf1; border: 1px solid #3a404a;
  border-radius: 6px; padding: 3px 6px; font-size: 12px; }
input[type=text] { flex: 1 1 120px; min-width: 0; }
input[type=number] { width: 56px; }
label.ck { display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 12px; }
.foot { display: flex; gap: 8px; align-items: center; padding: 9px 12px; background: #191c21; flex: 0 0 auto; }
.prog { height: 5px; background: #2b3038; border-radius: 99px; overflow: hidden; margin-top: 6px; }
.prog > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#fb7299,#7ee787); transition: width .2s; }
.fails { max-height: 90px; overflow: auto; font-size: 11px; color: #ff9d95; }
.hidden { display: none !important; }
`;

  let uiReady = false;
  let host = null;
  let root = null;
  const els = {};

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k]);
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  function hostCss() {
    // 不用 inset 简写：老内核（Chrome < 87）不支持，会导致宿主定位异常
    return 'position:fixed;top:0;right:0;bottom:0;left:0;' +
      'width:0;height:0;pointer-events:none;z-index:2147483000;';
  }

  const Z_MAX = 2147483000;

  function applyHostZ(z) {
    const v = String(z);
    if (host) host.style.zIndex = v;
    if (els.wrap) els.wrap.style.zIndex = v;
  }

  function buildPanel(forceLight) {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bili-comment-images-host';
    host.style.cssText = hostCss();
    // 同时显式赋值：cssText 解析后的初始值不一定能被后续读取（也让测试可断言）
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.right = '0';
    host.style.bottom = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = String(Z_MAX);

    const useLight = !!forceLight ||
      (typeof host.attachShadow !== 'function') ||
      !!window.__BILI_CDN_NO_SHADOW__;

    root = host;
    if (!useLight) {
      try {
        root = host.attachShadow({ mode: 'open' });
      } catch (e) {
        root = host;
      }
    }
    const style = document.createElement('style');
    style.textContent = UI_STYLE;
    root.appendChild(style);

    const wrap = h('div', { class: 'wrap' });
    els.wrap = wrap;
    if (root === host) wrap.classList.add('no-shadow');
    // 让整块面板接收鼠标事件（宿主本身 pointer-events:none，避免挡住页面）
    wrap.style.pointerEvents = 'auto';

    // 标题栏
    const head = h('div', { class: 'head' },
      h('span', { class: 'dot' }),
      h('span', { class: 't', text: 'B站评论图批量下载' }),
      h('button', { title: '折叠 / 展开面板（Alt+B 也可切换）', text: '▾', onclick: toggleMin }),
      h('button', { title: '折叠面板（Alt+B 可切换）', text: '✕', onclick: toggleMin })
    );
    els.head = head;
    wrap.appendChild(head);

    const body = h('div', { class: 'body' });
    els.body = body;
    wrap.appendChild(body);

    // 数据来源
    const src = h('div', { class: 'sec' });
    src.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn pri', text: '① 抓取评论区（推荐）', onclick: onPull, title: '直接调 B 站接口拉全部评论图片，包括 UI 里不显示的第 9 张' }),
      h('button', { class: 'btn', text: '扫描当前页面', onclick: onScanDom }),
      h('button', { class: 'btn', text: '抓查看器', onclick: onScanViewer, title: '先点开图片查看器再点这里，可抓到隐藏图' })
    ));
    src.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
      h('button', { class: 'btn ghost', text: '补全缺图', onclick: onFillMissing, title: '对有缺图的评论单独再请求一次接口' }),
      h('button', { class: 'btn ghost', text: '清掉多余图', onclick: onPurge, title: '删除不像评论图的记录（表情、视频封面等）' }),
      h('button', { class: 'btn ghost', text: '清空', onclick: onClear })
    ));
    src.appendChild(h('div', { class: 'small', style: 'margin-top:6px' },
      '只采集评论里用户上传的图片：接口的 content.pictures 是唯一权威来源，DOM 扫描会限定在单条评论容器内。'
    ));
    body.appendChild(src);

    // 导出设置
    const opt = h('div', { class: 'sec' });
    const q = h('select', { onchange: (e) => { cfg.quality = e.target.value; saveCfg(); renderAll(); } },
      h('option', { value: 'original', text: '原图尺寸（@{宽}w_{高}h）' }),
      h('option', { value: 'max', text: '原图 + 无损优先（100q.png）' }),
      h('option', { value: 'raw', text: '接口原样（缩略图，体积小）' })
    );
    els.quality = q;
    opt.appendChild(h('div', { class: 'row' }, h('span', { class: 'small', text: '画质' }), q));
    const tpl = h('input', {
      type: 'text', value: cfg.tpl,
      title: '默认 {name}.{ext} 即 B站原文件名。可用占位符：{name} {ext} {i} {n} {author} {rpid} {mid}',
      oninput: (e) => { cfg.tpl = e.target.value; saveCfg(); }
    });
    els.tpl = tpl;
    opt.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
      h('span', { class: 'small', text: '命名' }), tpl,
      h('button', {
        class: 'btn ghost', text: '用原文件名',
        title: '把命名模板恢复为 {name}.{ext}（B站原文件名）',
        onclick: () => { cfg.tpl = DEFAULT_TPL; saveCfg(); els.tpl.value = DEFAULT_TPL; notify('命名已恢复为原文件名'); }
      })
    ));
    opt.appendChild(h('div', { class: 'small', style: 'margin-top:4px' },
      '默认用图片原文件名（{name}.{ext}）。同名冲突时自动加短 hash，不会互相覆盖。'
    ));
    const conc = h('input', { type: 'number', min: '1', max: '6', value: cfg.concurrency, onchange: (e) => { cfg.concurrency = Math.max(1, Math.min(6, +e.target.value || 2)); e.target.value = cfg.concurrency; saveCfg(); } });
    const sub = h('input', { type: 'checkbox', onchange: (e) => { cfg.subfolder = e.target.checked; saveCfg(); } });
    if (cfg.subfolder) sub.checked = true;
    opt.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
      h('label', { class: 'ck' }, h('span', { class: 'small', text: '并发' }), conc),
      h('label', { class: 'ck' }, sub, h('span', { class: 'small', text: '按作者建子文件夹' }))
    ));
    body.appendChild(opt);

    // 统计
    const stat = h('div', { class: 'stat' });
    els.stat = stat;
    body.appendChild(stat);

    // 列表
    const list = h('div', { class: 'list' });
    els.list = list;
    body.appendChild(list);

    // 底部
    const foot = h('div', { class: 'foot' });
    els.dlBtn = h('button', { class: 'btn pri', text: '⬇ 下载选中', onclick: startDownload });
    els.cancelBtn = h('button', { class: 'btn ghost hidden', text: '取消', onclick: cancelDownload });
    els.selAll = h('button', { class: 'btn ghost', text: '全选', onclick: () => setAllChecked(true) });
    els.selNone = h('button', { class: 'btn ghost', text: '全不选', onclick: () => setAllChecked(false) });
    els.copyBtn = h('button', { class: 'btn ghost', text: '复制链接', onclick: copyLinks });
    els.prog = h('div', { class: 'prog' }, h('i'));
    els.footText = h('div', { class: 'small', style: 'flex:1 1 100%;margin-top:4px' });
    foot.appendChild(els.selAll);
    foot.appendChild(els.selNone);
    foot.appendChild(els.copyBtn);
    foot.appendChild(els.dlBtn);
    foot.appendChild(els.cancelBtn);
    foot.appendChild(els.prog);
    foot.appendChild(els.footText);
    body.appendChild(foot);

    // 失败列表
    els.fails = h('div', { class: 'sec fails hidden' });
    body.appendChild(els.fails);

    root.appendChild(wrap);
    attachHost();
    els.quality.value = cfg.quality;
    makeDraggable(wrap, head);
    uiReady = true;
  }

  function attachHost() {
    if (!host || host.parentNode) return;
    (document.body || document.documentElement).appendChild(host);
  }

  /* 兼容性自检：面板建好后如果宿主不在 DOM 里、量不到尺寸、或跑到视口外
     （老内核 / Shadow DOM 异常 / 页面浮层遮挡 / 拖拽越界），
     就地升级为 light DOM 兼容模式 + 抬高 z-index + 复位到右下角。
     只跑一次，避免反复重建。 */
  let panelHealed = false;

  function measurePanel() {
    const w = els.wrap;
    if (!w) return { w: 0, h: 0, top: 0, left: 0, bottom: 0, inDom: false };
    let r = null;
    try { r = w.getBoundingClientRect(); } catch (e) {}
    return {
      w: r ? r.width : 0,
      h: r ? r.height : 0,
      top: r ? r.top : 0,
      left: r ? r.left : 0,
      bottom: r ? r.bottom : 0,
      inDom: !!document.getElementById('bili-comment-images-host')
    };
  }

  function resetToCorner() {
    const w = els.wrap;
    if (!w) return;
    w.style.left = 'auto';
    w.style.top = 'auto';
    w.style.right = '16px';
    w.style.bottom = '16px';
  }

  function bumpZIndex() {
    const cur = parseInt(host.style.zIndex, 10) || Z_MAX;
    applyHostZ(Math.min(cur + 1000000, 2147483600));
    return host.style.zIndex;
  }

  function ensurePanelVisible() {
    if (!host || !els.wrap) return;
    const m = measurePanel();
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const okSize = m.w > 80 && m.h > 20;
    // 完全落在视口外（例如拖拽越界）也算异常
    const offScreen = okSize && vh > 0 && (m.bottom < 10 || m.top > vh - 10 || m.left > vw - 10);
    if (m.inDom && okSize && !offScreen) return;

    if (offScreen) resetToCorner();

    if (panelHealed) {
      if (offScreen) renderAll();
      return;
    }
    panelHealed = true;

    console.warn('[B站评论图] 面板异常（inDom=' + m.inDom + ', ' + Math.round(m.w) + 'x' +
      Math.round(m.h) + ', offScreen=' + offScreen + '），切换为 light DOM 兼容模式；' +
      '若仍看不到可在控制台执行 __BILI_CDN_DEBUG__()');

    // 1) 就地切换成 light DOM 兼容模式（不重建，避免任何丢失）
    try {
      if (host.shadowRoot) {
        host.shadowRoot.appendChild(els.wrap); // 从 shadow 移出
        els.wrap.classList.add('no-shadow');
      }
    } catch (e) {
      try { host.appendChild(els.wrap); els.wrap.classList.add('no-shadow'); } catch (e2) {}
    }
    els.wrap.style.pointerEvents = 'auto';
    attachHost();

    // 2) 抬 z-index，防止被页面浮层盖住
    bumpZIndex();
    renderAll();
  }

  /* 诊断输出：排查「面板不显示」时让用户 F12 控制台执行
     __BILI_CDN_DEBUG__() */
  function debugDump() {
    const info = {};
    try { info.href = location.href; } catch (e) {}
    try { info.userAgent = navigator.userAgent; } catch (e) {}
    try {
      info.gm = {
        GM_download: typeof GM_download,
        GM_xmlhttpRequest: typeof GM_xmlhttpRequest,
        GM_notification: typeof GM_notification,
        GM_getValue: typeof GM_getValue,
        GM_setValue: typeof GM_setValue
      };
    } catch (e) { info.gm = 'error: ' + e.message; }
    try {
      info.engineInjected = !!document.querySelector('script[data-ccfg]');
    } catch (e) {}
    const el = document.getElementById('bili-comment-images-host');
    try {
      info.hostInDom = !!el;
      info.hostParent = el && el.parentNode ? el.parentNode.nodeName : null;
      info.hostStyle = el ? el.getAttribute('style') : null;
      info.shadowRoot = !!(el && el.shadowRoot);
      const w = els.wrap;
      info.wrapClass = w ? w.className : null;
      if (w) {
        const r = w.getBoundingClientRect();
        info.wrapRect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        info.wrapDisplay = w.style.display;
        info.wrapInline = w.getAttribute('style');
      }
      const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
      info.viewport = { w: vw, h: vh };
      info.visible = !!(el && els.wrap && els.wrap.getBoundingClientRect().width > 80 &&
        els.wrap.getBoundingClientRect().bottom > 0 && els.wrap.getBoundingClientRect().top < vh);
    } catch (e) { info.rectError = e.message; }
    try { info.snapshot = { groups: lastSnapshot.groups.length, total: lastSnapshot.total }; } catch (e) {}
    // 统计来自页面引擎（异步），用 then 补上，避免 debugDump 变成异步函数
    try {
      callEngine('stats', {}, 8000).then((st) => {
        info.trustedComments = st.trustedRpids;
        info.trustedMids = st.trustedMids;
        info.rejectedNotComment = st.rejected;
        info.rejectedEmote = st.emotes;
        info.acceptedSamples = st.accepted;
        try { console.log('[B站评论图] 诊断信息（含过滤统计）', info); } catch (e) {}
      }).catch(() => {});
    } catch (e) {}
    try { console.log('[B站评论图] 诊断信息', info); } catch (e) {}
    return info;
  }

  function toggleMin() {
    els.wrap.classList.toggle('min');
  }

  function setExpanded(expanded) {
    if (!els.wrap) return;
    els.wrap.classList.toggle('min', !expanded);
  }

  // 面板只在本次会话里折叠/展开，不做持久化。
  // （之前把 ✕ 做成"记住隐藏状态"导致刷新后彻底看不到面板，已移除。）
  let panelExpanded = true;

  function makeDraggable(wrap, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = wrap.getBoundingClientRect();
      ox = r.left; oy = r.top;
      sx = e.clientX; sy = e.clientY;
      wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
      wrap.style.left = ox + 'px'; wrap.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + (e.clientX - sx)));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + (e.clientY - sy)));
      wrap.style.left = nx + 'px';
      wrap.style.top = ny + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ---------- 渲染 ----------
  function fmtSize(n) {
    if (!n) return '';
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return Math.round(n / 1024) + 'KB';
  }

  function currentGroups() { return lastSnapshot.groups || []; }

  function selectedPics() {
    const out = [];
    for (const g of currentGroups()) {
      for (const p of g.images) {
        if (p.checked) out.push({ pic: p, group: g });
      }
    }
    return out;
  }

  function renderStatus() {
    if (!uiReady) return;
    const groups = currentGroups();
    const total = groups.reduce((a, g) => a + g.images.length, 0);
    const missing = groups.reduce((a, g) => a + (g.missing || 0), 0);
    const sel = selectedPics().length;
    const withPic = groups.length;
    const dlText = dl.running
      ? `下载中 ${dl.done + dl.fail}/${dl.queue.length}（成功 ${dl.done}，失败 ${dl.fail}）`
      : (dl.done + dl.fail > 0
        ? `上次：成功 ${dl.done} 张${dl.fail ? `，失败 ${dl.fail} 张` : ''}`
        : '');

    els.stat.innerHTML = '';
    els.stat.appendChild(h('span', { html: `有图评论 <b>${withPic}</b> 条` }));
    els.stat.appendChild(h('span', { html: `图片 <b>${total}</b> 张` }));
    els.stat.appendChild(h('span', { html: `已选 <b>${sel}</b> 张` }));
    if (missing > 0) {
      els.stat.appendChild(h('span', { class: 'warn', html: `⚠ 仍有 <b>${missing}</b> 张未抓到` }));
    } else if (total > 0) {
      els.stat.appendChild(h('span', { class: 'ok', text: '✓ 已全部识别' }));
    }
    const rejected = lastSnapshot.rejected || 0;
    const emotes = lastSnapshot.emotes || 0;
    if (rejected > 0 || emotes > 0) {
      els.stat.appendChild(h('span', {
        class: 'small',
        title: '页面扫描时发现、但不属于任何接口确认过的评论的图片（视频封面、其它视频的图等），' +
          '以及尺寸过小判定为表情/贴纸的图，均已自动丢弃',
        text: `已过滤：可疑图 ${rejected} + 表情 ${emotes}`
      }));
    }
    if (pullProgress && dl.running === false) {
      els.stat.appendChild(h('span', { class: 'small', text: `接口第 ${pullProgress.page} 页，新增 ${pullProgress.added} 张` }));
    }

    if (dl.running || dl.queue.length) {
      const totalQ = dl.queue.length || 1;
      const pct = Math.round(((dl.done + dl.fail) / totalQ) * 100);
      els.prog.classList.remove('hidden');
      els.prog.firstChild.style.width = pct + '%';
      els.cancelBtn.classList.toggle('hidden', !dl.running);
      els.dlBtn.toggleAttribute('disabled', !!dl.running);
    } else {
      els.prog.classList.add('hidden');
      els.cancelBtn.classList.add('hidden');
      els.dlBtn.removeAttribute('disabled');
    }
    els.footText.textContent = dlText || (sel ? `将下载 ${sel} 张（画质：${qualityLabel()}）` : '勾选要下载的图片');

    if (dl.failures.length) {
      els.fails.classList.remove('hidden');
      els.fails.innerHTML = '';
      els.fails.appendChild(h('div', { text: `失败 ${dl.failures.length} 张（可点「下载选中」重试）` }));
      const ul = h('div', {});
      for (const f of dl.failures.slice(0, 30)) {
        ul.appendChild(h('div', { text: `· ${f.group.author || ''} #${f.pic.index} ${f.error}` }));
      }
      els.fails.appendChild(ul);
    } else {
      els.fails.classList.add('hidden');
    }
  }

  function qualityLabel() {
    return cfg.quality === 'raw' ? '接口原样' : cfg.quality === 'max' ? '原图+无损优先' : '原图尺寸';
  }

  function renderList() {
    if (!uiReady) return;
    els.list.innerHTML = '';
    const groups = currentGroups();
    if (!groups.length) {
      els.list.appendChild(h('div', { class: 'small', style: 'padding:10px', text: '还没有数据。点「① 抓取评论区」或滚动页面加载评论后再点「扫描当前页面」。' }));
      return;
    }
    // 有图的排前面，缺图的更靠前
    const sorted = groups.slice().sort((a, b) => {
      const am = a.missing > 0 ? 1 : 0, bm = b.missing > 0 ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.images.length - a.images.length);
    });
    for (const g of sorted) els.list.appendChild(renderGroup(g));
  }

  function renderGroup(g) {
    const box = h('div', { class: 'grp' });
    const badge = g.missing > 0
      ? h('span', { class: 'badge hid', text: `已抓 ${g.images.length} / 应有 ${g.total}，差 ${g.missing} 张` })
      : h('span', { class: 'badge full', text: `${g.images.length} 张 完整` });
    const head = h('div', { class: 'gh' },
      h('span', { class: 'au', text: (g.author || '未知用户') + (g.rpid ? ` · rpid ${g.rpid}` : '') }),
      badge
    );
    if (g.missing > 0 && g.rpid) {
      head.appendChild(h('button', {
        class: 'btn ghost', text: '补全', title: '单独为这条评论再请求接口',
        onclick: async (e) => {
          e.stopPropagation();
          const b = e.target;
          b.textContent = '请求中…'; b.setAttribute('disabled', 'disabled');
          try {
            const r = await callEngine('pull-one', { rpid: g.rpid }, 60000);
            notify(`补全完成，新增 ${r.added} 张`);
          } catch (err) {
            notify('补全失败：' + err.message);
          }
          b.textContent = '补全'; b.removeAttribute('disabled');
        }
      }));
    }
    const dlg = h('button', {
      class: 'btn ghost', text: '下载本条',
      onclick: (e) => {
        e.stopPropagation();
        dl.queue = g.images.map((pic) => ({ pic, group: g }));
        if (!dl.queue.length) { notify('这条评论没有图片'); return; }
        runQueue();
      }
    });
    head.appendChild(dlg);
    box.appendChild(head);

    const thumbs = h('div', { class: 'thumbs' });
    for (const p of g.images) thumbs.appendChild(renderThumb(p, g));
    box.appendChild(thumbs);
    return box;
  }

  function renderThumb(p, g) {
    const cls = ['th'];
    if (!p.checked) cls.push('off');
    else cls.push('on');
    if (p.state === 'fail') cls.push('fail');
    // 真正的动图：接口给的地址就是 gif
    const isGif = /\.gif$/i.test(p.url);
    const fname = p.url.split('/').pop();
    const t = h('div', {
      class: cls.join(' '),
      title: `${p.index}/${p.total || '?'} · ${p.width || '?'}×${p.height || '?'}` +
        `\n${fname}\n来源：${p.source}\n点击切换勾选`,
      onclick: async () => {
        p.checked = !p.checked;
        t.classList.toggle('off', !p.checked);
        t.classList.toggle('on', p.checked);
        renderStatus();
        callEngine('set-check-one', { key: p.key, checked: p.checked }).catch(() => {});
      }
    });
    const im = h('img', { src: thumbUrl(p), loading: 'lazy', referrerpolicy: 'no-referrer', alt: fname });
    im.addEventListener('error', () => { im.style.opacity = '.15'; });
    t.appendChild(im);
    t.appendChild(h('span', { class: 'no', text: String(p.index || '?') }));
    if (g.missing > 0 && p.index > 8) t.appendChild(h('span', { class: 'hd', text: '隐藏' }));
    if (isGif) t.appendChild(h('span', { class: 'gif', text: 'GIF' }));
    return t;
  }

  function thumbUrl(p) {
    // 预览用中等尺寸：够看清楚内容，又不会因为预览就把原图整张拉一遍
    return p.url + '@280w_280h_1e_1c.webp';
  }

  function renderAll() {
    if (!uiReady) return;
    renderList();
    renderStatus();
  }

  // ---------- 交互动作 ----------
  async function onPull() {
    const btn = els.list; // noop
    setBusy(true);
    try {
      const r = await callEngine('pull', { mode: 'auto', maxPages: 50 }, 300000);
      notify(`抓取完成：新增 ${r.added} 张，共 ${r.pages} 页`);
    } catch (e) {
      notify('抓取失败：' + e.message);
      console.warn('[B站评论图] 抓取失败', e);
    }
    pullProgress = null;
    setBusy(false);
    renderAll();
  }

  async function onScanDom() {
    setBusy(true);
    try {
      const r = await callEngine('scan-dom', {}, 60000);
      if (!r.added) notify('页面里没发现新的评论图，试试「抓取评论区」');
    } catch (e) {
      notify('扫描失败：' + e.message);
    }
    setBusy(false);
    renderAll();
  }

  async function onScanViewer() {
    setBusy(true);
    try {
      const r = await callEngine('scan-viewer', {}, 60000);
      if (!r.added) notify('查看器里没发现新图（先把图片查看器打开并翻页）');
    } catch (e) {
      notify('扫描失败：' + e.message);
    }
    setBusy(false);
    renderAll();
  }

  async function onFillMissing() {
    const missing = currentGroups().filter((g) => g.missing > 0 && g.rpid);
    if (!missing.length) { notify('没有缺图的评论'); return; }
    setBusy(true);
    let added = 0;
    for (const g of missing) {
      try {
        const r = await callEngine('pull-one', { rpid: g.rpid }, 60000);
        added += r.added;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 350));
    }
    setBusy(false);
    notify(`补全完成，新增 ${added} 张`);
    renderAll();
  }

  async function onClear() {
    await callEngine('clear', {}, 20000).catch(() => {});
    dl.done = 0; dl.fail = 0; dl.failures = [];
    renderAll();
  }

  async function onPurge() {
    setBusy(true);
    try {
      const r = await callEngine('purge-junk', {}, 60000);
      notify(r.removed ? `已清掉 ${r.removed} 张不像评论图的记录` : '没有需要清理的记录');
    } catch (e) {
      notify('清理失败：' + e.message);
    }
    setBusy(false);
    renderAll();
  }

  function setBusy(b) {
    els.dlBtn.toggleAttribute('disabled', !!b);
  }

  function setAllChecked(v) {
    // 本地先即时反映，再让引擎统一改（覆盖引擎里已有但本地还没同步到的图）
    for (const g of currentGroups()) {
      for (const p of g.images) p.checked = v;
    }
    callEngine('set-check', { checked: v }, 15000).catch(() => {});
    renderAll();
  }

  function copyLinks() {
    const sel = selectedPics();
    if (!sel.length) { notify('没有勾选图片'); return; }
    const text = sel.map((s) => qualityUrl(s.pic) + '\t' + buildName(s.pic, s.group)).join('\n');
    const done = () => notify(`已复制 ${sel.length} 条（URL + 建议文件名）`);
    try {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } catch (e) {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) {
      console.log(text);
      notify('复制失败，已把内容打印到控制台');
    }
  }

  function startDownload() {
    if (dl.running) return;
    const sel = selectedPics();
    if (!sel.length) { notify('没有勾选图片'); return; }
    dl.queue = sel.slice();
    runQueue();
  }

  function cancelDownload() {
    dl.cancelled = true;
    notify('已请求取消，正在结束当前下载…');
  }

  //===================================================================
  // 4. 启动 & 路由监听
  //===================================================================

  function mount() {
    buildPanel();
    // Alt+B：折叠 / 展开面板（纯会话状态，不写存储）
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (String(e.key).toLowerCase() !== 'b') return;
      e.preventDefault();
      panelExpanded = !panelExpanded;
      setExpanded(panelExpanded);
    }, true);
    // 首次自动抓取：以接口为准（接口只会给出评论里的图，不会混进视频封面）
    const auto = async () => {
      let pulled = 0;
      if (cfg.autoScan) {
        try {
          const r = await callEngine('pull', { mode: 'auto', maxPages: 50 }, 300000);
          pulled = r.added || 0;
          if (pulled) notify(`自动抓取完成：识别到 ${pulled} 张评论图`);
        } catch (e) {
          console.warn('[B站评论图] 自动抓取失败，可手动点「抓取评论区」', e);
        }
      }
      // 页面缓存里的首屏评论数据：
      // 必须放在接口之后扫，因为它要能对上接口确认过的评论身份才会被采纳。
      try { await callEngine('scan-initial', {}, 20000); } catch (e) {}
      // 接口没抓到（风控/未登录）时，退化为扫描页面 DOM 兜底
      if (!pulled) {
        try { await callEngine('scan-dom', {}, 30000); } catch (e) {}
      }
      renderAll();
    };
    setTimeout(auto, cfg.autoScan ? 2500 : 1200);
    // 面板建好后做一次可见性自检（兼容老内核 / Shadow DOM 异常）
    setTimeout(ensurePanelVisible, 1200);
    setTimeout(ensurePanelVisible, 4000);
  }

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    // SPA 换视频：清空重来，同样以接口为主
    callEngine('clear', {}, 15000).then(() => {
      setTimeout(async () => {
        if (!cfg.autoScan) return;
        try {
          const r = await callEngine('pull', { mode: 'auto', maxPages: 50 }, 300000);
          if (!r.added) await callEngine('scan-dom', {}, 30000);
          renderAll();
        } catch (e) {
          callEngine('scan-dom', {}, 30000).catch(() => {});
        }
      }, 2500);
    }).catch(() => {});
  }, 1200);

  function bootUi() {
    if (!document.body) {
      setTimeout(bootUi, 200);
      return;
    }
    mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootUi);
  } else {
    bootUi();
  }
})();
