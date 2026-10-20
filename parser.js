// Bank statement line parser. Pure functions, no DOM. Works on "lines":
// [{ text, y, items:[{x, w, str}] }] produced from pdf.js text content.
// Exported for both the browser (ES module) and Node tests.

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };

// Date patterns at the start of a line. Each returns {y,m,d,len} or null.
const DATE_RES = [
  // 2024-01-31 / 2024/01/31
  { re: /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/, f: m => ({ y:+m[1], m:+m[2], d:+m[3] }) },
  // 01/31/2024, 1/31/24, 31.01.2024
  { re: /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/, f: (m, opts) => {
      let a=+m[1], b=+m[2], y=+m[3]; if (y < 100) y += 2000;
      let dayFirst = opts.dayFirst;
      if (a > 12) dayFirst = true; else if (b > 12) dayFirst = false;
      return dayFirst ? { y, m:b, d:a } : { y, m:a, d:b };
  } },
  // 01/31 or 1/31 (no year)
  { re: /^(\d{1,2})[\/.-](\d{1,2})\b(?![\/.-]\d)/, f: (m, opts) => {
      let a=+m[1], b=+m[2];
      let dayFirst = opts.dayFirst;
      if (a > 12) dayFirst = true; else if (b > 12) dayFirst = false;
      return dayFirst ? { y:null, m:b, d:a } : { y:null, m:a, d:b };
  } },
  // Jan 31, 2024 / Jan 31 / January 31 2024
  { re: /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/, f: m => {
      const mo = MONTHS[m[1].slice(0,4).toLowerCase()] ?? MONTHS[m[1].slice(0,3).toLowerCase()];
      if (!mo) return null; return { y: m[3] ? +m[3] : null, m: mo, d:+m[2] };
  } },
  // 31 Jan 2024 / 31 Jan / 31-Jan-24
  { re: /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?(?:[\s,-]+(\d{2,4}))?\b/, f: m => {
      const mo = MONTHS[m[1] && m[2].slice(0,4).toLowerCase()] ?? MONTHS[m[2].slice(0,3).toLowerCase()];
      if (!mo) return null; let y = m[3] ? +m[3] : null; if (y !== null && y < 100) y += 2000;
      return { y, m: mo, d:+m[1] };
  } },
];

export function parseDateAtStart(text, opts = {}) {
  for (const { re, f } of DATE_RES) {
    const m = text.match(re);
    if (!m) continue;
    const r = f(m, opts);
    if (!r) continue;
    if (r.m < 1 || r.m > 12 || r.d < 1 || r.d > 31) continue;
    return { ...r, len: m[0].length };
  }
  return null;
}

// Money token: optional sign/parens/currency, digits with optional thousands sep, optional decimals, optional trailing CR/DR or -.
const MONEY_RE = /(?:^|\s)(\(?[-−–+]?\s?(?:[$€£]|USD|EUR|GBP|CAD|AUD)?\s?-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})|\(?[-−–+]?\s?(?:[$€£])?\s?-?\d+\.\d{2})\)?(?:\s?(?:CR|DR|cr|dr))?(?:-)?(?=\s|$)/g;

export function parseMoney(tok) {
  let s = tok.trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bDR\b/i.test(s)) { neg = true; }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/\b(CR|DR)\b/ig, '').replace(/[$€£]|USD|EUR|GBP|CAD|AUD/g, '').replace(/\s/g, '');
  if (/^[-−–]/.test(s)) { neg = !neg; s = s.slice(1); }
  if (/^\+/.test(s)) s = s.slice(1);
  s = s.replace(/,/g, '');
  const v = parseFloat(s);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

export function findMoneyTokens(text) {
  const out = [];
  let m;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const full = m[0];
    const lead = full.length - full.trimStart().length;
    const start = m.index + lead;
    const tok = full.trim();
    const v = parseMoney(tok);
    if (v === null) continue;
    out.push({ tok, start, end: start + tok.length, value: v });
  }
  return out;
}

// Build lines from pdf.js text items of one page: group by y, sort by x, join with spacing.
export function itemsToLines(items, viewportHeight) {
  const rows = [];
  const TOL = 2.5;
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(TOL, h * 0.35));
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, w: it.width || 0, h, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // pdf y grows upward; top of page first
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    const segs = [];
    for (const it of r.items) {
      const charW = it.str.length ? Math.max(it.w / it.str.length, 2) : 4;
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > charW * 0.5) text += gap > charW * 2.5 ? '   ' : ' ';
      }
      segs.push({ start: text.length, x: it.x });
      text += it.str;
      prevEnd = it.x + it.w;
    }
    return { y: r.y, text: text.replace(/\s+$/, ''), items: r.items, segs };
  });
}

const HEADER_WORDS = /\b(date|description|details|particulars|transaction|withdrawals?|debits?|deposits?|credits?|balance|amount|memo|payee|reference|money (?:in|out))\b/i;

function detectYear(allText) {
  const m = allText.match(/\b(20\d{2})\b/g);
  if (!m) return null;
  const counts = {};
  for (const y of m) counts[y] = (counts[y] || 0) + 1;
  return +Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function detectDayFirst(lines) {
  // If any numeric date has first component > 12, it's day-first.
  let dayFirst = false, monthFirst = false;
  for (const l of lines) {
    const m = l.text.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-]\d{2,4})?\b/);
    if (!m) continue;
    if (+m[1] > 12) dayFirst = true;
    if (+m[2] > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return true;
  return false;
}

function detectColumns(lines) {
  // Look for a header line naming debit/credit/balance columns; return their x centers.
  for (const l of lines) {
    const t = l.text.toLowerCase();
    const hits = (t.match(HEADER_WORDS) || []).length;
    if (!/\bdate\b/.test(t) || hits < 2) continue;
    const cols = {};
    for (const it of l.items) {
      const s = it.str.toLowerCase();
      const cx = it.x + it.w / 2;
      if (/withdraw|debit|money out|payments?\b|charges?\b/.test(s)) cols.debit = cx;
      else if (/deposit|credit|money in|receipts?\b/.test(s)) cols.credit = cx;
      else if (/balance/.test(s)) cols.balance = cx;
      else if (/^amount$|\bamount\b/.test(s)) cols.amount = cx;
    }
    if (Object.keys(cols).length) return cols;
  }
  return null;
}

function nearest(cols, x) {
  let best = null, bd = Infinity;
  for (const [k, cx] of Object.entries(cols)) {
    const d = Math.abs(cx - x);
    if (d < bd) { bd = d; best = k; }
  }
  return bd < 60 ? best : null;
}

function tokenX(line, start) {
  // Map character offset to an x coordinate using segment starts.
  let seg = line.segs[0];
  for (const s of line.segs) if (s.start <= start) seg = s;
  if (!seg) return null;
  const it = line.items[line.segs.indexOf(seg)];
  const charW = it && it.str.length ? it.w / it.str.length : 5;
  return seg.x + (start - seg.start) * charW;
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return d.y ? `${d.y}-${p(d.m)}-${p(d.d)}` : `${p(d.m)}-${p(d.d)}`;
}

// Main entry. pages: [{ lines }] in order. Returns { rows, pageCounts, warnings }.
export function extractTransactions(pages, options = {}) {
  const allLines = pages.flatMap(p => p.lines);
  const allText = allLines.map(l => l.text).join('\n');
  const year = options.year ?? detectYear(allText);
  const dayFirst = options.dayFirst ?? detectDayFirst(allLines);
  const cols = detectColumns(allLines);
  const rows = [];
  const pageCounts = [];
  const warnings = [];
  let lastMonth = null, yearOffset = 0;

  pages.forEach((page, pi) => {
    let count = 0;
    let last = null; // last transaction row on this page, for continuation lines
    let lastDescX = null;
    for (const line of page.lines) {
      const text = line.text;
      const date = parseDateAtStart(text, { dayFirst });
      const money = findMoneyTokens(text);
      // Skip header-ish lines
      if (date && money.length) {
        // Exclude money tokens that are inside the date span
        const after = money.filter(t => t.start >= date.len);
        if (!after.length) { continue; }
        // Description = between date and first money token, trimming a possible second date (posting date)
        let desc = text.slice(date.len, after[0].start).trim();
        const d2 = parseDateAtStart(desc, { dayFirst });
        if (d2) desc = desc.slice(d2.len).trim();
        desc = desc.replace(/\s{2,}/g, ' ');
        // Money tokens: decide amount / balance.
        let amount = null, balance = null;
        const vals = after.map(t => ({ ...t, x: tokenX(line, t.start) }));
        if (cols && (cols.debit || cols.credit)) {
          for (const v of vals) {
            const c = nearest(cols, v.x);
            if (c === 'debit') amount = -Math.abs(v.value);
            else if (c === 'credit') amount = Math.abs(v.value);
            else if (c === 'balance') balance = v.value;
            else if (c === 'amount') amount = v.value;
          }
          if (amount === null && vals.length) {
            // Fall back: last is balance if >1, first is amount
            if (vals.length >= 2) { amount = vals[0].value; balance = vals[vals.length - 1].value; }
            else amount = vals[0].value;
          }
        } else if (vals.length >= 2) {
          amount = vals[vals.length - 2].value;
          balance = vals[vals.length - 1].value;
          if (vals.length >= 3 && cols && cols.balance == null) {
            // debit, credit, balance without header: pick the non-zero of first two
            const a = vals[vals.length - 3].value, b = vals[vals.length - 2].value;
            amount = a !== 0 ? -Math.abs(a) : b;
          }
        } else {
          amount = vals[0].value;
        }
        // Year handling
        let y = date.y;
        if (y === null && year) {
          if (lastMonth !== null && date.m < lastMonth - 6) yearOffset += 1; // Dec -> Jan wrap
          lastMonth = date.m;
          y = year + yearOffset;
        }
        const row = { date: fmtDate({ ...date, y }), description: desc, amount, balance, page: pi + 1 };
        rows.push(row);
        last = row; lastDescX = tokenX(line, date.len) ;
        count++;
      } else if (last && !date && !money.length && text.trim() && !HEADER_WORDS.test(text)) {
        // Continuation line: indented roughly at or beyond description column, short-ish.
        const firstX = line.items[0]?.x ?? 0;
        if (lastDescX !== null && firstX >= lastDescX - 40 && text.length < 120 && !/^(page \d|statement|total|closing|opening|beginning|ending)/i.test(text)) {
          last.description = (last.description + ' ' + text.trim()).replace(/\s{2,}/g, ' ').trim();
        } else {
          last = null;
        }
      } else if (date || money.length) {
        last = null;
      }
    }
    pageCounts.push(count);
  });

  // Balance sanity: if balances are present, check amount sign consistency and flip if needed.
  const withBal = rows.filter(r => r.balance !== null && r.amount !== null);
  if (withBal.length >= 3) {
    let agree = 0, disagree = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (a.balance === null || b.balance === null || b.amount === null) continue;
      const delta = +(b.balance - a.balance).toFixed(2);
      if (Math.abs(delta - b.amount) < 0.011) agree++;
      else if (Math.abs(delta + b.amount) < 0.011) disagree++;
    }
    if (disagree > agree) { for (const r of rows) if (r.amount !== null) r.amount = -r.amount; warnings.push('Amount signs were flipped to match the running balance.'); }
    else if (agree === 0 && disagree === 0) warnings.push('Running balance could not be used to verify amounts.');
  }
  if (!year && rows.some(r => r.date.length === 5)) warnings.push('No year found in the statement; dates are MM-DD only.');
  return { rows, pageCounts, warnings, meta: { year, dayFirst, cols } };
}

export function toCSV(rows, opts = {}) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fmt = n => n === null || n === undefined ? '' : n.toFixed(2);
  const header = opts.splitDebitCredit ? ['Date','Description','Debit','Credit','Balance'] : ['Date','Description','Amount','Balance'];
  const lines = [header.join(',')];
  for (const r of rows) {
    if (opts.splitDebitCredit) {
      const debit = r.amount !== null && r.amount < 0 ? fmt(-r.amount) : '';
      const credit = r.amount !== null && r.amount >= 0 ? fmt(r.amount) : '';
      lines.push([esc(r.date), esc(r.description), debit, credit, fmt(r.balance)].join(','));
    } else {
      lines.push([esc(r.date), esc(r.description), fmt(r.amount), fmt(r.balance)].join(','));
    }
  }
  return lines.join('\r\n') + '\r\n';
}
