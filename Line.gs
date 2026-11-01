/**
 * Line.gs — LINE Messaging API（取得・送信・ボタンの処理）
 *
 * ボットは業者のグループでは一切発言しない。
 * 送るのは「設定」の「報告の送り先ID」と、ボットとの1対1のトークだけ。
 */

var LINE_API = 'https://api.line.me/v2/bot';
var LINE_DATA_API = 'https://api-data.line.me/v2/bot';

function lineToken_() {
  var t = prop_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  return t;
}

function lineFetch_(url, method, payload) {
  var opt = { method: method || 'get', headers: { Authorization: 'Bearer ' + lineToken_() }, muteHttpExceptions: true };
  if (payload) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(payload);
  }
  return UrlFetchApp.fetch(url, opt);
}

/** 報告の送り先へ送る（プッシュ。無料枠の通数に数える） */
function linePush_(to, messages) {
  if (!to) {
    log_({ kind: '報告', result: '未送信', reason: '「設定」の「報告の送り先ID」が空です' });
    return false;
  }
  var r = lineFetch_(LINE_API + '/message/push', 'post', { to: to, messages: messages });
  if (r.getResponseCode() !== 200) {
    log_({ kind: '報告', result: 'エラー', reason: 'LINE送信 ' + r.getResponseCode() + '：' + r.getContentText().slice(0, 300) });
    return false;
  }
  return true;
}

/** 応答（ボタンを押したときの返事。無料枠の通数に数えない） */
function lineReply_(replyToken, messages) {
  if (!replyToken) return false;
  var r = lineFetch_(LINE_API + '/message/reply', 'post', { replyToken: replyToken, messages: messages });
  if (r.getResponseCode() !== 200) {
    log_({ kind: '応答', result: 'エラー', reason: 'LINE応答 ' + r.getResponseCode() + '：' + r.getContentText().slice(0, 300) });
    return false;
  }
  return true;
}

/** 画像・ファイルの中身。期限切れなどで取れないときは null */
function lineGetContent_(messageId) {
  var r = lineFetch_(LINE_DATA_API + '/message/' + messageId + '/content');
  var code = r.getResponseCode();
  if (code === 200) return r.getBlob();
  if (code === 404 || code === 410) return null;
  throw new Error('LINEのコンテンツ取得 ' + code + '：' + r.getContentText().slice(0, 200));
}

function lineGroupName_(groupId) {
  if (!groupId || groupId.charAt(0) !== 'C') return '';
  return cached_('g:' + groupId, function () {
    var r = lineFetch_(LINE_API + '/group/' + groupId + '/summary');
    return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).groupName || '' : '';
  });
}

function lineMemberName_(groupId, userId) {
  if (!userId) return '';
  return cached_('m:' + groupId + ':' + userId, function () {
    var url = groupId && groupId.charAt(0) === 'C'
      ? LINE_API + '/group/' + groupId + '/member/' + userId
      : LINE_API + '/profile/' + userId;
    var r = lineFetch_(url);
    return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).displayName || '' : '';
  });
}

function lineBotUserId_() {
  var r = lineFetch_(LINE_API + '/info');
  if (r.getResponseCode() !== 200) throw new Error('ボット情報を取得できません ' + r.getResponseCode() + '：' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText()).userId;
}

function cached_(key, fn) {
  var cache = CacheService.getScriptCache();
  var v = cache.get(key);
  if (v !== null) return v;
  try { v = fn() || ''; } catch (e) { v = ''; }
  cache.put(key, v, 21600);
  return v;
}

function textMsg_(text) {
  return { type: 'text', text: String(text).slice(0, 4900) };
}

/* ---------- 報告メッセージ ---------- */

/**
 * lines: [{ text, color, bold }]
 */
function buildReportFlex_(title, lines, invoiceId, sheetUrl, needsCheck) {
  var body = [{ type: 'text', text: title, weight: 'bold', size: 'md', wrap: true, color: needsCheck ? '#C62828' : '#111111' }];
  lines.forEach(function (l) {
    if (!l || !l.text) return;
    body.push({ type: 'text', text: String(l.text).slice(0, 1000), size: 'sm', wrap: true, color: l.color || '#333333', weight: l.bold ? 'bold' : 'regular' });
  });
  var buttons = [];
  if (invoiceId) {
    buttons.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: 'OK', data: 'a=ok&id=' + invoiceId, displayText: 'OK' } });
    buttons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '要修正', data: 'a=fix&id=' + invoiceId, displayText: '要修正' } });
  }
  if (sheetUrl) buttons.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'シートを開く', uri: sheetUrl } });
  var bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body } };
  if (buttons.length) bubble.footer = { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons };
  return { type: 'flex', altText: (needsCheck ? '【要確認】' : '') + title, contents: bubble };
}

/* ---------- イベント（doPost から呼ばれる） ---------- */

function isReportTarget_(source, settings) {
  var to = settings.reportTo;
  if (!to || !source) return false;
  if (to.charAt(0) === 'U') return source.type === 'user' && source.userId === to;
  if (to.charAt(0) === 'C') return source.groupId === to;
  if (to.charAt(0) === 'R') return source.roomId === to;
  return false;
}

/** OK／要修正 ボタン */
function handlePostback_(ev) {
  var settings = getSettings_();
  var src = ev.source || {};
  if (!isReportTarget_(src, settings)) {
    log_({ kind: 'ボタン', userId: src.userId, groupId: src.groupId || src.roomId, result: '無視', reason: '報告の送り先以外からのボタン操作' });
    return;
  }
  var p = parseQuery_(ev.postback && ev.postback.data);
  var res;
  if (p.a === 'ok') res = confirmInvoice_(p.id, settings);
  else if (p.a === 'fix') res = markNeedsFix_(p.id);
  else return;
  lineReply_(ev.replyToken, [textMsg_(res.message)]);
  log_({ kind: 'ボタン', userId: src.userId, result: p.a === 'ok' ? 'OK' : '要修正', reason: res.message.split('\n')[0], invoiceId: p.id });
}

/** ボットとの1対1のトーク。「id」と送ると自分の userId を返す（初期設定用） */
function handleUserText_(ev) {
  var t = String(ev.message.text || '').trim().toLowerCase();
  t = t.normalize ? t.normalize('NFKC') : t;
  if (t === 'id' || t === 'userid') {
    lineReply_(ev.replyToken, [textMsg_('あなたの userId：\n' + ev.source.userId + '\n\n報告をこのトークで受け取るときは、これを「設定」シートの「報告の送り先ID」に入れてください。')]);
    log_({ kind: '1対1', userId: ev.source.userId, result: '応答', reason: 'userId を返信' });
  } else {
    log_({ kind: '1対1', userId: ev.source.userId, type: 'text', result: '対象外', reason: '「id」以外の文字' });
  }
}

function parseQuery_(s) {
  var out = {};
  String(s || '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}
