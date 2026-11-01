/**
 * Main.gs — 入口
 *
 * doPost        … LINE の Webhook。画像・ファイルは「キュー」に書くだけにしてすぐ応答する。
 * processQueue  … 1分ごとのトリガー。キューを読み取り処理する（Queue.gs）。
 * onOpen        … スプレッドシートにメニューを出す。
 */

function doPost(e) {
  try {
    var key = prop_('WEBHOOK_KEY');
    if (key && (!e || !e.parameter || e.parameter.key !== key)) {
      log_({ kind: '受信', result: '拒否', reason: 'URLの key が一致しない（Webhook URL の末尾 ?key=… を確認）' });
      return ok_();
    }
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var botId = prop_('BOT_USER_ID');
    if (botId && body.destination && body.destination !== botId) {
      log_({ kind: '受信', result: '拒否', reason: '宛先が別のボット：' + body.destination });
      return ok_();
    }
    var events = body.events || [];
    if (!events.length) {
      log_({ kind: '検証', result: '応答', reason: 'イベントなし（LINE Developers の「検証」ボタンなど）' });
      return ok_();
    }
    events.forEach(function (ev) {
      try {
        routeEvent_(ev);
      } catch (err) {
        var s = ev.source || {};
        log_({ kind: '受信', groupId: s.groupId || s.roomId, userId: s.userId, result: 'エラー', reason: errMsg_(err) });
      }
    });
  } catch (err) {
    log_({ kind: '受信', result: 'エラー', reason: errMsg_(err) });
  }
  return ok_();
}

function ok_() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

function routeEvent_(ev) {
  var src = ev.source || {};
  var groupId = src.groupId || src.roomId || '';
  var base = { groupId: groupId, userId: src.userId || '' };

  if (ev.type === 'postback') return handlePostback_(ev);

  if (ev.type === 'join') {
    return log_(Object.assign(base, {
      kind: '参加', groupName: lineGroupName_(groupId), result: '記録',
      reason: 'ボットがグループに参加しました。このグループIDを「設定」シートに入れてください'
    }));
  }
  if (ev.type === 'follow') {
    return log_(Object.assign(base, { kind: '友だち追加', result: '記録', reason: 'ボットとの1対1のトークで「id」と送ると userId を返信します' }));
  }
  if (ev.type !== 'message') {
    return log_(Object.assign(base, { kind: ev.type, result: '対象外', reason: 'メッセージ以外のイベント' }));
  }

  var m = ev.message || {};
  if (src.type === 'user' && m.type === 'text') return handleUserText_(ev);
  if (m.type === 'image' || m.type === 'file') return enqueue_(ev);
  log_(Object.assign(base, { kind: 'メッセージ', type: m.type, result: '対象外', reason: '画像・ファイル以外', messageId: m.id }));
}

/** キューに1行足す（同じメッセージの再送は足さない） */
function enqueue_(ev) {
  var src = ev.source || {};
  var m = ev.message;
  var sh = sheet_(SHEETS.QUEUE);
  var last = sh.getLastRow();
  if (last >= 2) {
    var col = HEADERS[SHEETS.QUEUE].indexOf('メッセージID') + 1;
    var ids = sh.getRange(2, col, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0 && i >= ids.length - 200; i--) {
      if (String(ids[i][0]) === String(m.id)) return;
    }
  }
  sh.appendRow(rowFromObj_(HEADERS[SHEETS.QUEUE], {
    '受信日時': new Date(ev.timestamp || Date.now()),
    'イベントID': ev.webhookEventId || '',
    'グループID': src.groupId || src.roomId || '',
    '送信者ID': src.userId || '',
    '種類': m.type,
    'メッセージID': m.id,
    'ファイル名': m.fileName || '',
    '状態': '待ち',
    '試行回数': 0,
    '更新日時': new Date(),
    'イベント': JSON.stringify(ev)
  }));
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('請求書ボット')
    .addItem('キューを今すぐ処理', 'processQueue')
    .addItem('月次集計・単価履歴を作り直す', 'rebuildAll')
    .addSeparator()
    .addItem('初期設定（setup）', 'setup')
    .addItem('設定の確認', 'checkSetup')
    .addToUi();
}
