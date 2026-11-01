/**
 * Normalize.gs — AIの読み取り結果を整える（日付・数量・品目名・配送料）
 *
 * このファイルは Apps Script 固有の機能を使わない（パソコンの Node.js でもテストできるように）。
 */

var THAI_DIGITS_ = '๐๑๒๓๔๕๖๗๘๙';

/** タイ数字を半角に、全角を半角にする */
function toAsciiDigits_(s) {
  s = String(s == null ? '' : s);
  if (s.normalize) s = s.normalize('NFKC');
  return s.replace(/[๐-๙]/g, function (ch) { return String(THAI_DIGITS_.indexOf(ch)); });
}

/** 数値に変換。空・読めないときは null */
function toNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = toAsciiDigits_(v).replace(/[,\s฿]/g, '').replace(/バーツ|บาท/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  var n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function round2_(x) { return Math.round(x * 100) / 100; }

/* ---------- 日付 ---------- */

function pad2_(n) { return ('0' + n).slice(-2); }
function ymdOf_(y, m, d) { return y + '-' + pad2_(m) + '-' + pad2_(d); }
function isValidYmd_(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function daysBetween_(ymdA, ymdB) {
  var a = ymdA.split('-').map(Number), b = ymdB.split('-').map(Number);
  return (Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000;
}

/**
 * 伝票に書かれた日付（例 30-10-69）を西暦の YYYY-MM-DD にする。
 * タイの伝票は 日-月-年。年は仏暦（2569 / 69）が多いが、西暦のこともあるので
 * 候補を出して受信日に一番近いものを選ぶ。
 */
function parseThaiDate_(raw, refYmd) {
  var s = toAsciiDigits_(raw);
  var m = s.match(/(\d{1,4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{2,4})/);
  if (!m) return null;
  var d, mo, years = [];
  if (m[1].length === 4) { // 年-月-日
    years = yearCandidates_(m[1]);
    mo = Number(m[2]); d = Number(m[3]);
  } else {                 // 日-月-年
    d = Number(m[1]); mo = Number(m[2]);
    years = yearCandidates_(m[3]);
  }
  var cands = years.filter(function (y) { return isValidYmd_(y, mo, d); }).map(function (y) { return ymdOf_(y, mo, d); });
  if (!cands.length) return null;
  if (!refYmd || cands.length === 1) return cands[0];
  cands.sort(function (a, b) { return Math.abs(daysBetween_(a, refYmd)) - Math.abs(daysBetween_(b, refYmd)); });
  return cands[0];
}
function yearCandidates_(y) {
  var n = Number(y);
  if (y.length === 2) return [2500 + n - 543, 2000 + n]; // 69 → 仏暦2569 → 2026 ／ 西暦2069
  if (y.length === 4) return [n >= 2400 ? n - 543 : n];
  return [];
}

/* ---------- 数量 ---------- */

/**
 * 手書きの数量の読み方の候補。
 * 「05」は 0.5、「11」は 11 か 1.1 … のように、小数点の書き方が一定しないため。
 */
function qtyCandidates_(raw) {
  var s = toAsciiDigits_(raw).replace(/,/g, '.').replace(/[^\d.]/g, '');
  if (!s || !/\d/.test(s)) return [];
  var out = [];
  var push = function (v) { if (isFinite(v) && v > 0 && out.indexOf(v) < 0) out.push(v); };
  push(parseFloat(s));
  if (s.indexOf('.') < 0) {
    if (/^0\d+$/.test(s)) push(parseFloat('0.' + s.slice(1)));
    else if (s.length >= 2 && s.length <= 4) {
      for (var i = 1; i < s.length; i++) push(parseFloat(s.slice(0, i) + '.' + s.slice(i)));
    }
  }
  return out;
}

/**
 * 数量を決める。数量×単価≒金額（±tol）になる候補を選ぶ。
 * 優先順：AIの読み → 書かれたとおり → そのほかの候補。どれも合わなければAIの読みのまま（検算でNGになる）。
 */
function chooseQty_(qtyRaw, aiQty, price, amount, tol) {
  var cands = qtyCandidates_(qtyRaw);
  if (price == null || amount == null) {
    return { qty: aiQty != null ? aiQty : (cands[0] != null ? cands[0] : null), note: '' };
  }
  var fits = function (q) { return q != null && Math.abs(q * price - amount) <= tol + 1e-9; };
  if (fits(aiQty)) return { qty: aiQty, note: '' };
  for (var i = 0; i < cands.length; i++) {
    if (fits(cands[i])) {
      return { qty: cands[i], note: '数量「' + qtyRaw + '」を ' + cands[i] + ' と判断（単価×数量＝金額から）' };
    }
  }
  return { qty: aiQty != null ? aiQty : (cands[0] != null ? cands[0] : null), note: '' };
}

/* ---------- 品目名 ---------- */

function normText_(s) {
  s = String(s == null ? '' : s);
  if (s.normalize) s = s.normalize('NFKC');
  return s.toLowerCase().replace(/[\s​]+/g, '');
}

var SHIPPING_RE_ = /ค่า\s*รถ|ค่า\s*ส่ง|ค่า\s*ขนส่ง|delivery|shipping|transport|配送|送料/i;
function isShippingName_(name) { return SHIPPING_RE_.test(String(name || '')); }

/**
 * 品目マスタと照合する。完全一致 → 部分一致（長い名前を優先）→ AIの候補（マスタにある名前のときだけ）
 */
function matchItem_(nameRaw, aiMatched, master) {
  var n = normText_(nameRaw);
  var best = null, bestLen = 0;
  for (var i = 0; i < master.length; i++) {
    var m = master[i];
    var names = [m.std, m.thai].concat(m.aliases || []);
    for (var j = 0; j < names.length; j++) {
      var k = normText_(names[j]);
      if (!k) continue;
      if (k === n) return m;
      if (k.length >= 2 && n.indexOf(k) >= 0 && k.length > bestLen) { best = m; bestLen = k.length; }
    }
  }
  if (best) return best;
  if (aiMatched) {
    var a = normText_(aiMatched);
    for (var x = 0; x < master.length; x++) {
      if (normText_(master[x].std) === a || normText_(master[x].thai) === a) return master[x];
    }
  }
  return null;
}

/* ---------- まとめ ---------- */

/**
 * AIの結果（JSON）を伝票オブジェクトにする。
 * opt: { receivedYmd, tolerance }
 */
function normalizeInvoice_(ai, master, opt) {
  var tol = opt.tolerance != null ? opt.tolerance : 1;
  var notes = [];
  var inv = {
    dateRaw: ai.date_raw || '',
    invoiceNo: String(ai.invoice_no || '').trim(),
    billTo: ai.bill_to || '',
    supplierNameRead: ai.supplier_name || '',
    subtotal: toNum_(ai.subtotal),
    vat: toNum_(ai.vat),
    shipping: toNum_(ai.shipping),
    total: toNum_(ai.total),
    items: [],
    notes: notes,
    aiNotes: ai.notes || ''
  };

  // 日付：書かれた文字から自分で変換。だめならAIの変換を使う
  var d = parseThaiDate_(ai.date_raw, opt.receivedYmd);
  if (!d && /^\d{4}-\d{2}-\d{2}$/.test(String(ai.date || ''))) d = ai.date;
  if (d && ai.date && d !== ai.date) notes.push('日付：AIは ' + ai.date + '、表記「' + ai.date_raw + '」から ' + d + ' と判断');
  inv.date = d || '';

  var no = 0;
  (ai.items || []).forEach(function (it) {
    var price = toNum_(it.unit_price);
    var amount = toNum_(it.amount);
    var aiQty = toNum_(it.qty);
    var m = matchItem_(it.name_raw, it.matched_name, master);

    // 配送料の行は明細に入れず、配送料の欄へ
    if (isShippingName_(it.name_raw) || (m && /配送料|送料/.test(m.std))) {
      var fee = amount != null ? amount : price;
      if (fee != null) {
        if (inv.shipping == null) inv.shipping = fee;
        else if (Math.abs(inv.shipping - fee) > tol) notes.push('配送料の行（' + fee + '）と配送料の欄（' + inv.shipping + '）が違う');
      }
      return;
    }

    var q = chooseQty_(it.qty_raw, aiQty, price, amount, tol);
    if (q.note) notes.push((m ? m.std : it.name_raw) + '：' + q.note);
    if (price == null && q.qty && amount != null) {
      price = round2_(amount / q.qty);
      notes.push((m ? m.std : it.name_raw) + '：単価が読めないため 金額÷数量 で ' + price);
    }
    no++;
    inv.items.push({
      no: no,
      nameRaw: String(it.name_raw || '').trim(),
      stdName: m ? m.std : '',
      unit: m ? m.unit : '',
      isNew: !m,
      qtyRaw: it.qty_raw == null ? '' : String(it.qty_raw),
      qty: q.qty,
      price: price,
      amount: amount,
      ok: null
    });
  });
  return inv;
}
