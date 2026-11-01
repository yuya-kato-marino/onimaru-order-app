/**
 * Queue.gs — キューの処理（1分ごとのトリガーから processQueue が呼ばれる）
 *
 * 1. 判定：登録済みのグループ／送信者（空欄なら誰でも）／形式
 * 2. LINE から中身を取ってドライブに保存
 * 3. Claude で読み取り → 整える → 検算 → 重複確認
 * 4. 「伝票」「明細」に記録して、報告の送り先へ OK／要修正 ボタン付きで送る
 */

var QUEUE_MAX_TRIES = 3;
var QUEUE_TIME_BUDGET_MS = 4.5 * 60 * 1000;   // 1回の実行は6分まで。余裕をみて4.5分で切り上げる
var QUEUE_STUCK_MS = 10 * 60 * 1000;          // 「処理中」のまま10分たったものはやり直す

function processQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前の回がまだ動いている
  try {
    var start = Date.now();
    var t = readTable_(SHEETS.QUEUE);
    var c = t.col;
    for (var i = 0; i < t.rows.length; i++) {
      if (Date.now() - start > QUEUE_TIME_BUDGET_MS) break;
      var st = t.rows[i][c['状態']];
      var updated = t.rows[i][c['更新日時']];
      var stuck = st === '処理中' && updated instanceof Date && Date.now() - updated.getTime() > QUEUE_STUCK_MS;
      if (st === '待ち' || st === '再試行' || stuck) processQueueRow_(t, i);
    }
    if (prop_('SUMMARY_DIRTY') === '1') {
      setProp_('SUMMARY_DIRTY', '');
      rebuildAll();
    }
  } finally {
    lock.releaseLock();
  }
}

function processQueueRow_(t, i) {
  var r = t.rows[i];
  var c = t.col;
  var rowNo = i + 2;
  var set = function (name, v) { t.sheet.getRange(rowNo, c[name] + 1).setValue(v); };
  var tries = Number(r[c['試行回数']] || 0) + 1;
  set('状態', '処理中');
  set('試行回数', tries);
  set('更新日時', new Date());
  SpreadsheetApp.flush();

  var ev = JSON.parse(r[c['イベント']]);
  try {
    var res = handleQueuedMessage_(ev, String(r[c['ファイルID']] || ''), function (fileId) { set('ファイルID', fileId); });
    set('状態', res.status);
    set('備考', res.reason || '');
  } catch (err) {
    var msg = errMsg_(err);
    console.error(err);
    if (tries >= QUEUE_MAX_TRIES) {
      set('状態', 'エラー');
      set('備考', msg);
      var s = ev.source || {};
      log_({ kind: 'メッセージ', groupId: s.groupId, userId: s.userId, type: ev.message.type, result: 'エラー', reason: msg, messageId: ev.message.id });
      var fileId = String(t.sheet.getRange(rowNo, c['ファイルID'] + 1).getValue() || '');
      linePush_(getSettings_().reportTo, [textMsg_('⚠ 請求書の処理に失敗しました（' + tries + '回）\n' + msg +
        (fileId ? '\n元ファイル：https://drive.google.com/file/d/' + fileId + '/view' : ''))]);
    } else {
      set('状態', '再試行');
      set('備考', msg);
    }
  }
  set('更新日時', new Date());
}

/** キューの1件。戻り値 { status, reason } */
function handleQueuedMessage_(ev, savedFileId, onSaved) {
  var settings = getSettings_();
  var src = ev.source || {};
  var m = ev.message || {};
  var groupId = src.groupId || src.roomId || '';
  var userId = src.userId || '';
  var base = {
    kind: 'メッセージ', groupId: groupId, groupName: lineGroupName_(groupId),
    userId: userId, userName: lineMemberName_(groupId, userId), type: m.type, messageId: m.id
  };
  var skip = function (reason) {
    log_(Object.assign(base, { result: 'スキップ', reason: reason }));
    return { status: 'スキップ', reason: reason };
  };

  // 判定1：登録済みのグループ
  var sup = findSupplierByGroup_(settings, groupId);
  if (!sup) return skip(groupId ? '未登録のグループ' : 'グループ以外からの投稿');
  // 判定2：送信者（空欄なら誰でも）
  if (sup.senders.length && sup.senders.indexOf(userId) < 0) return skip('登録外の送信者（' + sup.name + '）');
  // 判定3：形式
  var isPdfName = m.type === 'file' && /\.pdf$/i.test(m.fileName || '');
  var okFormat = sup.format === 'PDF' ? isPdfName
    : sup.format === '両方' ? (m.type === 'image' || isPdfName)
    : m.type === 'image';
  if (!okFormat) return skip('形式が対象外（' + sup.name + ' は ' + sup.format + ' のみ）');

  // 中身を取ってドライブに保存（再試行のときは保存済みのものを使う）
  var file, blob;
  if (savedFileId) {
    file = DriveApp.getFileById(savedFileId);
    blob = file.getBlob();
  } else {
    blob = lineGetContent_(m.id);
    if (!blob) return skip('LINEから中身を取得できない（保存期間切れの可能性）');
    var received = new Date(ev.timestamp || Date.now());
    file = saveToDrive_(blob, sup, received, m);
    onSaved(file.getId());
  }

  var res = processDocument_(sup, { blob: blob, fileId: file.getId() }, {
    receivedAt: new Date(ev.timestamp || Date.now()),
    sender: base.userName || userId,
    messageId: m.id,
    fileUrl: file.getUrl(),
    settings: settings
  });
  log_(Object.assign(base, { result: res.status, reason: res.reason, invoiceId: res.invoiceId }));
  return res;
}

function saveToDrive_(blob, sup, received, m) {
  var root = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID'));
  var folder = subFolder_(subFolder_(root, sup.id + '_' + sup.name), Utilities.formatDate(received, TZ, 'yyyy-MM'));
  var ext = m.type === 'image' ? '.jpg' : '';
  var name = Utilities.formatDate(received, TZ, 'yyyyMMdd-HHmmss') + '_' + m.id + (m.fileName ? '_' + m.fileName : ext);
  return folder.createFile(blob.copyBlob().setName(name));
}

function subFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * 書類1件を読み取って記録する（過去分の一括取り込みからも使う）。
 * file: { blob, fileId }
 * meta: { receivedAt, sender, messageId, fileUrl, settings, noDateRange }
 * 戻り値 { status, reason, invoiceId }
 */
function processDocument_(sup, file, meta) {
  var settings = meta.settings;
  var receivedYmd = Utilities.formatDate(meta.receivedAt, TZ, 'yyyy-MM-dd');
  var hash = sha256Hex_(file.blob.getBytes());
  var existing = existingInvoices_();

  var dupFile = findDuplicate_(existing, sup.id, { invoiceNo: '', date: '', total: null }, hash);
  if (dupFile) {
    reportDuplicate_(sup, null, dupFile, meta, settings);
    return { status: '重複', reason: dupFile.reason + '：' + dupFile.id };
  }

  var master = getMasterItems_(sup.id);
  var ai = claudeReadInvoice_(file, sup, master, receivedYmd);
  if (ai.document_type !== 'invoice') {
    return { status: 'スキップ', reason: '請求書ではない（' + (DOC_TYPE_LABEL[ai.document_type] || ai.document_type) + '）：' + (ai.document_type_reason || '') };
  }

  var inv = normalizeInvoice_(ai, master, { receivedYmd: receivedYmd, tolerance: settings.tolerance });
  validateInvoice_(inv, {
    tolerance: settings.tolerance, allowFix: true, defaultShipping: sup.defaultShipping,
    vatRate: sup.vatRate, receivedYmd: meta.noDateRange ? '' : receivedYmd, maxDays: settings.maxDays
  });

  var dup = findDuplicate_(existing, sup.id, inv, '');
  if (dup) {
    reportDuplicate_(sup, inv, dup, meta, settings);
    return { status: '重複', reason: dup.reason + '：' + dup.id };
  }

  var alerts = computePriceAlerts_(inv.items, priceHistory_(sup.id), inv.date, settings.avgN, settings.threshold);
  var w = writeInvoice_(sup, inv, meta, hash);
  setProp_('SUMMARY_DIRTY', '1');
  reportInvoice_(sup, inv, w, alerts, settings);
  return { status: '記録', reason: inv.status + (inv.issues.length ? '：' + inv.issues.join('／') : ''), invoiceId: w.id };
}

/* ---------- 報告 ---------- */

function mdOf_(ymd) {
  if (!ymd) return '日付不明';
  var p = ymd.split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}

function reportInvoice_(sup, inv, w, alerts, settings) {
  var needsCheck = inv.status !== STATUS.UNCHECKED;
  var title = (needsCheck ? '⚠ 要確認　' : '') + mdOf_(inv.date) + ' ' + sup.name;
  var lines = [];
  var parts = '明細' + inv.items.length + '件' + (inv.shipping ? '＋配送料' + fmtNum_(inv.shipping) : '') + (inv.vat ? '＋VAT' + fmtNum_(inv.vat) : '');
  lines.push({ text: '合計 ' + fmtNum_(inv.total) + 'バーツ（' + parts + '）' + (inv.checkOk ? '検算OK' : '検算NG'), bold: true, color: inv.checkOk ? '#2E7D32' : '#C62828' });
  inv.issues.forEach(function (s) { lines.push({ text: '✖ ' + s, color: '#C62828' }); });
  inv.warnings.forEach(function (s) { lines.push({ text: '⚠ ' + s, color: '#E65100' }); });

  var news = inv.items.filter(function (it) { return it.isNew; }).map(function (it) { return it.nameRaw; });
  if (!news.length && !alerts.length) {
    lines.push({ text: '新規品目なし／単価の大きな変動なし' });
  } else {
    lines.push({ text: news.length ? '🆕 新規品目：' + news.join('、') : '新規品目なし', color: news.length ? '#1565C0' : '' });
    if (alerts.length) alerts.forEach(function (a) { lines.push({ text: formatAlert_(a), color: '#E65100' }); });
    else lines.push({ text: '単価の大きな変動なし' });
  }
  inv.notes.forEach(function (s) { lines.push({ text: '・' + s, color: '#666666' }); });
  if (inv.aiNotes) lines.push({ text: '・読み取りメモ：' + inv.aiNotes, color: '#666666' });
  lines.push({ text: w.id, color: '#999999' });

  var url = sheetRowUrl_(SHEETS.INVOICE, w.row);
  linePush_(settings.reportTo, [buildReportFlex_(title, lines, w.id, url, needsCheck)]);
}

function reportDuplicate_(sup, inv, dup, meta, settings) {
  var text = '⚠ 重複の疑い（記録していません）\n' +
    (inv ? mdOf_(inv.date) + ' ' + sup.name + ' 合計 ' + fmtNum_(inv.total) + 'バーツ\n' : sup.name + '\n') +
    dup.reason + '\n既存：' + dup.id + '\n元ファイル：' + meta.fileUrl;
  linePush_(settings.reportTo, [textMsg_(text)]);
}

/* ---------- 過去分の一括取り込み（優先度低） ---------- */

/**
 * ドライブのフォルダにある画像・PDFをまとめて取り込む。
 * スクリプトプロパティ IMPORT_FOLDER_ID と IMPORT_SUPPLIER_ID（例 S01）を入れてから実行。
 * 6分で止まるので、残りがあればもう一度実行する（取り込み済みはファイルのハッシュで飛ばす）。
 */
function importPastFiles() {
  var settings = getSettings_();
  var sup = findSupplierById_(settings, prop_('IMPORT_SUPPLIER_ID'));
  if (!sup) throw new Error('IMPORT_SUPPLIER_ID の業者が「設定」にありません');
  var files = DriveApp.getFolderById(prop_('IMPORT_FOLDER_ID')).getFiles();
  var start = Date.now();
  var done = 0;
  while (files.hasNext() && Date.now() - start < QUEUE_TIME_BUDGET_MS) {
    var f = files.next();
    var ct = f.getMimeType();
    if (!/^image\//.test(ct) && ct !== 'application/pdf') continue;
    var res = processDocument_(sup, { blob: f.getBlob(), fileId: f.getId() }, {
      receivedAt: f.getDateCreated(), sender: '一括取り込み', messageId: '', fileUrl: f.getUrl(), settings: settings,
      noDateRange: true // 過去の伝票なので「受信日から離れている」の確認はしない
    });
    log_({ kind: '一括取り込み', type: ct, result: res.status, reason: f.getName() + '：' + res.reason, invoiceId: res.invoiceId });
    done++;
  }
  console.log(done + '件処理しました' + (files.hasNext() ? '（残りあり。もう一度実行してください）' : ''));
}
