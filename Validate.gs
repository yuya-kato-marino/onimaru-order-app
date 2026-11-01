/**
 * Validate.gs — 検算・単価変動・重複判定
 *
 * このファイルも Apps Script 固有の機能を使わない（Node.js でテストできるように）。
 */

function fmtNum_(x) {
  if (x == null || x === '') return '?';
  var n = round2_(Number(x));
  var parts = String(Math.abs(n)).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + parts.join('.');
}

/**
 * 伝票を検算する。結果を inv に書き込む（itemsSum, issues, warnings, checkOk, status）。
 * opt: {
 *   tolerance        許容差（既定1バーツ）
 *   allowFix         true なら、配送料を既定値に直すと合計が合う場合に直す（読み取り直後だけ）
 *   defaultShipping  業者の既定配送料
 *   vatRate          業者のVAT率（%）。0なら確認しない
 *   receivedYmd      受信日（日付のずれの確認用。空なら確認しない）
 *   maxDays          受信日から何日前までを正常とするか
 * }
 */
function validateInvoice_(inv, opt) {
  var tol = opt.tolerance != null ? opt.tolerance : 1;
  var issues = [];
  var warnings = [];
  inv.notes = inv.notes || [];

  // 1. 各行：数量×単価 と 金額
  var sum = 0;
  inv.items.forEach(function (it, i) {
    var label = (i + 1) + '行目 ' + (it.stdName || it.nameRaw);
    if (it.qty == null || it.price == null || it.amount == null) {
      it.ok = false;
      issues.push(label + '：数量・単価・金額のどれかが読めない');
    } else {
      var calc = it.qty * it.price;
      it.ok = Math.abs(calc - it.amount) <= tol + 1e-9;
      if (!it.ok) issues.push(label + '：' + fmtNum_(it.qty) + '×' + fmtNum_(it.price) + '＝' + fmtNum_(calc) + ' だが金額は ' + fmtNum_(it.amount));
    }
    if (it.amount != null) sum += Number(it.amount);
  });
  inv.itemsSum = round2_(sum);
  if (!inv.items.length) issues.push('明細がない');

  // 2. 伝票：明細の合計＋配送料（＋VAT）と 合計
  if (inv.total == null) {
    issues.push('合計が読めない');
  } else {
    var ship = inv.shipping || 0;
    var vat = inv.vat || 0;
    var diff = inv.total - (inv.itemsSum + ship + vat);
    if (Math.abs(diff) > tol + 1e-9 && opt.allowFix && opt.defaultShipping > 0 && inv.shipping !== opt.defaultShipping) {
      var alt = inv.total - (inv.itemsSum + opt.defaultShipping + vat);
      if (Math.abs(alt) <= tol + 1e-9) {
        inv.notes.push('配送料を「' + (inv.shipping == null ? 'なし' : fmtNum_(inv.shipping)) + '」と読んだが、合計から逆算して ' + fmtNum_(opt.defaultShipping) + ' にした');
        inv.shipping = opt.defaultShipping;
        ship = inv.shipping;
        diff = alt;
      }
    }
    if (Math.abs(diff) > tol + 1e-9) {
      issues.push('明細計 ' + fmtNum_(inv.itemsSum) + '＋配送料 ' + fmtNum_(ship) + (vat ? '＋VAT ' + fmtNum_(vat) : '') +
        '＝' + fmtNum_(inv.itemsSum + ship + vat) + ' だが合計は ' + fmtNum_(inv.total) + '（差 ' + fmtNum_(diff) + '）');
    }
  }

  // 3. VAT（率が設定されている業者だけ。丸め方が分からないので注意喚起だけ）
  if (opt.vatRate > 0) {
    if (inv.vat == null) {
      warnings.push('VATが読めない');
    } else {
      var expVat = (inv.itemsSum + (inv.shipping || 0)) * opt.vatRate / 100;
      if (Math.abs(expVat - inv.vat) > Math.max(tol, 1) + 1e-9) {
        warnings.push('VAT ' + fmtNum_(inv.vat) + ' が ' + opt.vatRate + '%（' + fmtNum_(expVat) + '）と合わない');
      }
    }
  }

  // 4. 日付
  if (!inv.date) {
    issues.push('日付が読めない');
  } else if (opt.receivedYmd) {
    var days = daysBetween_(opt.receivedYmd, inv.date); // 受信日 − 伝票日
    var maxDays = opt.maxDays || 45;
    if (days < -2 || days > maxDays) {
      issues.push('日付 ' + inv.date + ' が受信日 ' + opt.receivedYmd + ' から離れている（読み間違いの可能性）');
    }
  }

  inv.issues = issues;
  inv.warnings = warnings;
  inv.checkOk = issues.length === 0;
  inv.status = inv.checkOk && !warnings.length ? '未確認' : '要確認';
  return inv;
}

/**
 * 単価の大きな変動。
 * history: [{ name: 標準名, date: 'YYYY-MM-DD', price: 数値 }]（今回の伝票は含めない）
 * 戻り値: [{ name, avg, price, pct }]
 */
function computePriceAlerts_(items, history, invDate, n, thresholdPct) {
  var alerts = [];
  items.forEach(function (it) {
    if (!it.stdName || it.price == null) return;
    var past = history.filter(function (h) {
      return h.name === it.stdName && h.price != null && (!invDate || !h.date || h.date <= invDate);
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).slice(-n);
    if (!past.length) return;
    var avg = past.reduce(function (s, h) { return s + Number(h.price); }, 0) / past.length;
    if (!avg) return;
    var pct = (it.price - avg) / avg * 100;
    if (Math.abs(pct) >= thresholdPct) alerts.push({ name: it.stdName, avg: round2_(avg), price: it.price, pct: Math.round(pct) });
  });
  return alerts;
}

function formatAlert_(a) {
  return '⚠ ' + a.name + ' ' + fmtNum_(Math.round(a.avg * 10) / 10) + '→' + fmtNum_(a.price) + '（' + (a.pct > 0 ? '+' : '') + a.pct + '%）';
}

/**
 * 重複の疑い。existing: [{ id, supplierId, date, invoiceNo, total, hash, status }]
 * 伝票番号があればそれで、なければ 業者＋日付＋合計。ファイルのハッシュは常に確認。
 */
function findDuplicate_(existing, supplierId, inv, hash) {
  for (var i = 0; i < existing.length; i++) {
    var e = existing[i];
    if (hash && e.hash === hash) return { id: e.id, reason: '同じファイルが記録済み' };
    if (e.supplierId !== supplierId) continue;
    if (inv.invoiceNo) {
      if (e.invoiceNo && e.invoiceNo === inv.invoiceNo) return { id: e.id, reason: '同じ伝票番号（' + inv.invoiceNo + '）が記録済み' };
      continue;
    }
    if (inv.date && e.date === inv.date && inv.total != null && Number(e.total) === Number(inv.total)) {
      return { id: e.id, reason: '同じ業者・日付・合計（' + inv.date + '／' + fmtNum_(inv.total) + '）が記録済み' };
    }
  }
  return null;
}
