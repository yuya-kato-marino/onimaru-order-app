/**
 * Sheets.gs — 伝票・明細の記録、OK／要修正、月次集計・単価履歴・参考単価
 */

/* ---------- 読み出し ---------- */

function existingInvoices_() {
  var t = readTable_(SHEETS.INVOICE);
  var c = t.col;
  return t.rows.filter(function (r) { return r[c['伝票ID']]; }).map(function (r) {
    return {
      id: String(r[c['伝票ID']]),
      supplierId: String(r[c['業者ID']]),
      date: toYmd_(r[c['日付']]),
      invoiceNo: String(r[c['伝票番号']] || '').trim(),
      total: toNum_(r[c['合計']]),
      hash: String(r[c['ファイルハッシュ']] || ''),
      status: String(r[c['状態']] || '')
    };
  });
}

/** 伝票ID → { supplierId, status, store } */
function invoiceIndex_() {
  var map = {};
  existingInvoices_().forEach(function (e) { map[e.id] = e; });
  var t = readTable_(SHEETS.INVOICE);
  t.rows.forEach(function (r) {
    var id = String(r[t.col['伝票ID']] || '');
    if (map[id]) map[id].store = String(r[t.col['店舗']] || '');
  });
  return map;
}

/** 単価の履歴（全状態）。[{ name, date, price }] */
function priceHistory_(supplierId) {
  var idx = invoiceIndex_();
  var t = readTable_(SHEETS.LINES);
  var c = t.col;
  return t.rows.filter(function (r) {
    var inv = idx[String(r[c['伝票ID']])];
    return inv && inv.supplierId === supplierId && String(r[c['品目（標準名）']]).trim();
  }).map(function (r) {
    return { name: String(r[c['品目（標準名）']]).trim(), date: toYmd_(r[c['日付']]), price: toNum_(r[c['単価']]) };
  });
}

/* ---------- 記録 ---------- */

function nextInvoiceId_(supplierId, ymd) {
  var base = supplierId + '-' + (ymd ? ymd.replace(/-/g, '') : '日付不明');
  var n = existingInvoices_().filter(function (e) { return e.id.indexOf(base + '-') === 0; }).length;
  return base + '-' + (n + 1);
}

function writeInvoice_(sup, inv, meta, hash) {
  var id = nextInvoiceId_(sup.id, inv.date);
  var invSheet = sheet_(SHEETS.INVOICE);
  var row = appendRows_(invSheet, [rowFromObj_(HEADERS[SHEETS.INVOICE], {
    '伝票ID': id,
    '受信日時': meta.receivedAt,
    '業者ID': sup.id,
    '業者': sup.name,
    '店舗': sup.store,
    '日付': ymdToDate_(inv.date),
    '伝票番号': inv.invoiceNo,
    '明細件数': inv.items.length,
    '明細計': inv.itemsSum,
    '小計': inv.subtotal,
    'VAT': inv.vat,
    '配送料': inv.shipping,
    '合計': inv.total,
    '検算': inv.checkOk ? 'OK' : 'NG',
    '状態': inv.status,
    '指摘': inv.issues.concat(inv.warnings).join('\n'),
    '元ファイル': meta.fileUrl,
    'ファイルハッシュ': hash,
    '宛先（読取）': inv.billTo,
    '業者名（読取）': inv.supplierNameRead,
    '送信者': meta.sender,
    'メッセージID': meta.messageId
  })]);

  var lineRows = inv.items.map(function (it) {
    return rowFromObj_(HEADERS[SHEETS.LINES], {
      '伝票ID': id,
      '日付': ymdToDate_(inv.date),
      '業者': sup.name,
      '店舗': sup.store,
      'No': it.no,
      '品目（原文）': it.nameRaw,
      '品目（標準名）': it.stdName,
      '数量': it.qty,
      '単位': it.unit,
      '単価': it.price,
      '金額': it.amount,
      '検算': it.ok ? 'OK' : 'NG',
      '数量（原文）': it.qtyRaw ? "'" + it.qtyRaw : '', // 「05」を 5 にしないよう文字として入れる
      'メモ': it.isNew ? '新規品目' : ''
    });
  });
  var first = appendRows_(sheet_(SHEETS.LINES), lineRows);
  return { id: id, row: row, lineFirst: first, lineLast: first + lineRows.length - 1 };
}

/* ---------- OK／要修正 ---------- */

function findInvoiceRow_(t, id) {
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][t.col['伝票ID']]) === id) return i;
  }
  return -1;
}

function lineRowsOf_(lt, id) {
  var out = [];
  lt.rows.forEach(function (r, i) { if (String(r[lt.col['伝票ID']]) === id) out.push(i); });
  return out;
}

/** OK：シートの値で検算し直し、合えば「確認済み」。合わなければ「要確認」のまま理由を返す */
function confirmInvoice_(id, settings) {
  var t = readTable_(SHEETS.INVOICE);
  var i = findInvoiceRow_(t, id);
  if (i < 0) return { message: '伝票が見つかりません：' + id + '（シートで行を消した可能性があります）' };
  var c = t.col;
  var r = t.rows[i];
  var rowNo = i + 2;
  var label = mdOf_(toYmd_(r[c['日付']])) + ' ' + r[c['業者']];
  if (r[c['状態']] === STATUS.CONFIRMED) return { message: 'すでに確認済みです：' + label };

  var lt = readTable_(SHEETS.LINES);
  var lc = lt.col;
  var idxs = lineRowsOf_(lt, id);
  var inv = {
    date: toYmd_(r[c['日付']]),
    vat: toNum_(r[c['VAT']]),
    shipping: toNum_(r[c['配送料']]),
    total: toNum_(r[c['合計']]),
    items: idxs.map(function (k) {
      var lr = lt.rows[k];
      return {
        nameRaw: String(lr[lc['品目（原文）']]), stdName: String(lr[lc['品目（標準名）']] || ''),
        qty: toNum_(lr[lc['数量']]), price: toNum_(lr[lc['単価']]), amount: toNum_(lr[lc['金額']])
      };
    })
  };
  // 人が確認するときは、日付のずれと VAT率の確認はしない（数字の整合だけ見る）
  validateInvoice_(inv, { tolerance: settings.tolerance, allowFix: false });

  idxs.forEach(function (k, n) { lt.sheet.getRange(k + 2, lc['検算'] + 1).setValue(inv.items[n].ok ? 'OK' : 'NG'); });
  var set = function (name, v) { t.sheet.getRange(rowNo, c[name] + 1).setValue(v); };
  set('明細件数', inv.items.length);
  set('明細計', inv.itemsSum);
  set('検算', inv.checkOk ? 'OK' : 'NG');

  if (inv.checkOk) {
    set('状態', STATUS.CONFIRMED);
    set('指摘', '');
    set('確認日時', new Date());
    setProp_('SUMMARY_DIRTY', '1');
    return { message: '✅ 確認済みにしました\n' + label + ' 合計 ' + fmtNum_(inv.total) + 'バーツ' };
  }
  set('状態', STATUS.NEEDS_CHECK);
  set('指摘', inv.issues.join('\n'));
  return {
    message: '⚠ まだ検算が合わないため、確認済みにしていません\n' + label + '\n' +
      inv.issues.map(function (s) { return '✖ ' + s; }).join('\n') +
      '\n\nシートで直してから、もう一度 OK を押してください。\n伝票：' + sheetRowUrl_(SHEETS.INVOICE, rowNo) +
      (idxs.length ? '\n明細：' + sheetRowUrl_(SHEETS.LINES, idxs[0] + 2, idxs[idxs.length - 1] + 2, 'N') : '')
  };
}

/** 要修正：状態を「要確認」にして、シートの該当行へのリンクを返す */
function markNeedsFix_(id) {
  var t = readTable_(SHEETS.INVOICE);
  var i = findInvoiceRow_(t, id);
  if (i < 0) return { message: '伝票が見つかりません：' + id };
  var rowNo = i + 2;
  var c = t.col;
  t.sheet.getRange(rowNo, c['状態'] + 1).setValue(STATUS.NEEDS_CHECK);
  if (!String(t.rows[i][c['指摘']] || '')) t.sheet.getRange(rowNo, c['指摘'] + 1).setValue('要修正ボタンが押された');
  setProp_('SUMMARY_DIRTY', '1');
  var idxs = lineRowsOf_(readTable_(SHEETS.LINES), id);
  return {
    message: '✏ シートで直してから、報告メッセージの OK を押してください。\n' +
      '伝票（日付・配送料・VAT・合計）：\n' + sheetRowUrl_(SHEETS.INVOICE, rowNo) +
      (idxs.length ? '\n明細（品目・数量・単価・金額）：\n' + sheetRowUrl_(SHEETS.LINES, idxs[0] + 2, idxs[idxs.length - 1] + 2, 'N') : '') +
      '\n元ファイル：' + t.rows[i][c['元ファイル']]
  };
}

/* ---------- 月次集計・単価履歴・参考単価 ---------- */

function rebuildAll() {
  rebuildSummary_();
  rebuildPriceHistory_();
  updateMasterRefPrices_();
}

function ymOf_(ymd) { return ymd ? ymd.slice(0, 7) : ''; }
function prevYm_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1;
  if (m === 0) { y--; m = 12; }
  return y + '-' + pad2_(m);
}
function ratio_(cur, prev) { return prev ? (cur - prev) / prev : ''; }

function rebuildSummary_() {
  var t = readTable_(SHEETS.INVOICE);
  var c = t.col;
  var confirmed = t.rows.filter(function (r) { return r[c['状態']] === STATUS.CONFIRMED && toYmd_(r[c['日付']]); });
  var confirmedIds = {};

  // A. 業者別・店舗別の月合計
  var agg = {};
  var add = function (k, o, r) {
    var a = agg[k] || (agg[k] = { ym: o.ym, store: o.store, sup: o.sup, kind: o.kind, n: 0, items: 0, ship: 0, vat: 0, total: 0 });
    a.n++;
    a.items += toNum_(r[c['明細計']]) || 0;
    a.ship += toNum_(r[c['配送料']]) || 0;
    a.vat += toNum_(r[c['VAT']]) || 0;
    a.total += toNum_(r[c['合計']]) || 0;
  };
  confirmed.forEach(function (r) {
    confirmedIds[String(r[c['伝票ID']])] = true;
    var ym = ymOf_(toYmd_(r[c['日付']]));
    var store = String(r[c['店舗']]), sup = String(r[c['業者']]);
    add([ym, store, sup].join('|'), { ym: ym, store: store, sup: sup, kind: 0 }, r);
    add([ym, store, '（店舗計）'].join('|'), { ym: ym, store: store, sup: '（店舗計）', kind: 1 }, r);
    add([ym, '（全店舗）', '（総合計）'].join('|'), { ym: ym, store: '（全店舗）', sup: '（総合計）', kind: 2 }, r);
  });
  var listA = Object.keys(agg).map(function (k) { return agg[k]; });
  listA.sort(function (a, b) {
    if (a.ym !== b.ym) return a.ym < b.ym ? 1 : -1;
    if (a.kind === 2 || b.kind === 2) return a.kind - b.kind;
    if (a.store !== b.store) return a.store < b.store ? -1 : 1;
    if (a.kind !== b.kind) return a.kind - b.kind;
    return b.total - a.total;
  });
  var rowsA = listA.map(function (a) {
    var p = agg[[prevYm_(a.ym), a.store, a.sup].join('|')];
    var prev = p ? p.total : '';
    return [a.ym, a.store, a.sup, a.n, round2_(a.items), round2_(a.ship), round2_(a.vat), round2_(a.total), prev === '' ? '' : round2_(prev), ratio_(a.total, prev)];
  });

  // B. 品目別（業者ごと・全店舗）
  var lt = readTable_(SHEETS.LINES);
  var lc = lt.col;
  var itAgg = {};
  lt.rows.forEach(function (r) {
    if (!confirmedIds[String(r[lc['伝票ID']])]) return;
    var ym = ymOf_(toYmd_(r[lc['日付']]));
    var std = String(r[lc['品目（標準名）']] || '').trim();
    var name = std || String(r[lc['品目（原文）']]) + '（未登録）';
    var k = [ym, r[lc['業者']], name].join('|');
    var a = itAgg[k] || (itAgg[k] = { ym: ym, sup: String(r[lc['業者']]), name: name, unit: String(r[lc['単位']] || ''), qty: 0, amount: 0 });
    a.qty += toNum_(r[lc['数量']]) || 0;
    a.amount += toNum_(r[lc['金額']]) || 0;
  });
  var listB = Object.keys(itAgg).map(function (k) { return itAgg[k]; });
  listB.sort(function (a, b) { return a.ym !== b.ym ? (a.ym < b.ym ? 1 : -1) : b.amount - a.amount; });
  var rank = 0, lastYm = '';
  var rowsB = listB.map(function (a) {
    rank = a.ym === lastYm ? rank + 1 : 1;
    lastYm = a.ym;
    var p = itAgg[[prevYm_(a.ym), a.sup, a.name].join('|')];
    var prev = p ? p.amount : '';
    return [a.ym, rank, a.sup, a.name, a.unit, round2_(a.qty), round2_(a.amount), a.qty ? round2_(a.amount / a.qty) : '', prev === '' ? '' : round2_(prev), ratio_(a.amount, prev)];
  });

  var sh = sheet_(SHEETS.SUMMARY);
  sh.clear();
  var headA = ['月', '店舗', '業者', '伝票数', '明細計', '配送料', 'VAT', '合計', '前月の合計', '前月比'];
  var headB = ['月', '順位', '業者', '品目', '単位', '数量', '金額', '平均単価', '前月の金額', '前月比'];
  sh.getRange(1, 1).setValue('業者別・店舗別の月合計（確認済みの伝票のみ）').setFontWeight('bold');
  sh.getRange(1, 12).setValue('品目別の月合計（金額の大きい順・確認済みのみ）').setFontWeight('bold');
  sh.getRange(2, 1, 1, headA.length).setValues([headA]).setFontWeight('bold').setBackground('#EEEEEE');
  sh.getRange(2, 12, 1, headB.length).setValues([headB]).setFontWeight('bold').setBackground('#EEEEEE');
  if (rowsA.length) {
    sh.getRange(3, 1, rowsA.length, headA.length).setValues(rowsA);
    sh.getRange(3, 5, rowsA.length, 5).setNumberFormat('#,##0.##');
    sh.getRange(3, 10, rowsA.length, 1).setNumberFormat('+0%;-0%;0%');
    rowsA.forEach(function (r, i) {
      if (r[2] === '（店舗計）' || r[2] === '（総合計）') sh.getRange(3 + i, 1, 1, headA.length).setFontWeight('bold').setBackground(r[2] === '（総合計）' ? '#FFF3E0' : '#F5F5F5');
    });
  }
  if (rowsB.length) {
    sh.getRange(3, 12, rowsB.length, headB.length).setValues(rowsB);
    sh.getRange(3, 17, rowsB.length, 4).setNumberFormat('#,##0.##');
    sh.getRange(3, 21, rowsB.length, 1).setNumberFormat('+0%;-0%;0%');
  }
  sh.setFrozenRows(2);
}

function rebuildPriceHistory_() {
  var idx = invoiceIndex_();
  var settings = getSettings_();
  var lt = readTable_(SHEETS.LINES);
  var lc = lt.col;
  var list = [];
  lt.rows.forEach(function (r) {
    var inv = idx[String(r[lc['伝票ID']])];
    var price = toNum_(r[lc['単価']]);
    if (!inv || price == null) return;
    var std = String(r[lc['品目（標準名）']] || '').trim();
    list.push({
      sup: String(r[lc['業者']]), name: std || String(r[lc['品目（原文）']]) + '（未登録）', unit: String(r[lc['単位']] || ''),
      date: toYmd_(r[lc['日付']]), price: price, store: inv.store || '', status: inv.status, id: inv.id
    });
  });
  list.sort(function (a, b) {
    if (a.sup !== b.sup) return a.sup < b.sup ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  var rows = [];
  var hist = [];
  list.forEach(function (x, i) {
    if (i === 0 || list[i - 1].sup !== x.sup || list[i - 1].name !== x.name) hist = [];
    var past = hist.slice(-settings.avgN);
    var avg = past.length ? past.reduce(function (s, v) { return s + v; }, 0) / past.length : '';
    rows.push([x.sup, x.name, x.unit, ymdToDate_(x.date), x.price, avg === '' ? '' : round2_(avg), avg ? (x.price - avg) / avg : '', x.store, x.status, x.id]);
    hist.push(x.price);
  });
  var sh = sheet_(SHEETS.PRICE);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[SHEETS.PRICE].length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('+0%;-0%;0%');
  }
}

/** 品目マスタの参考単価を、確認済み伝票の直近の平均で更新する */
function updateMasterRefPrices_() {
  var idx = invoiceIndex_();
  var settings = getSettings_();
  var lt = readTable_(SHEETS.LINES);
  var lc = lt.col;
  var bucket = {};
  lt.rows.forEach(function (r) {
    var inv = idx[String(r[lc['伝票ID']])];
    var std = String(r[lc['品目（標準名）']] || '').trim();
    var price = toNum_(r[lc['単価']]);
    if (!inv || inv.status !== STATUS.CONFIRMED || !std || price == null) return;
    var k = inv.supplierId + '|' + std;
    (bucket[k] = bucket[k] || []).push({ date: toYmd_(r[lc['日付']]), price: price });
  });
  var mt = readTable_(SHEETS.MASTER);
  var mc = mt.col;
  mt.rows.forEach(function (r, i) {
    var b = bucket[String(r[mc['業者ID']]).trim() + '|' + String(r[mc['標準名（日本語）']]).trim()];
    if (!b) return;
    b.sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var last = b.slice(-settings.avgN);
    var avg = last.reduce(function (s, x) { return s + x.price; }, 0) / last.length;
    mt.sheet.getRange(i + 2, mc['参考単価'] + 1).setValue(round2_(avg));
  });
}
