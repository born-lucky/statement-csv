import * as pdfjsLib from './vendor/pdf.min.mjs';
import { itemsToLines, extractTransactions, toCSV } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const FREE_PAGES = 1;
const PAY_URL = window.STATEMENT_CSV_PAY_URL || '#';
// SHA-256 of the unlock key handed out after checkout. The key itself is not in this file.
const UNLOCK_HASH = window.STATEMENT_CSV_UNLOCK_HASH || '';

const $ = s => document.querySelector(s);
const state = { rows: [], pageCounts: [], fileName: '', unlocked: false, split: false };

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function loadUnlock() {
  try { state.unlocked = localStorage.getItem('scsv_unlock') === UNLOCK_HASH && !!UNLOCK_HASH; } catch { state.unlocked = false; }
}
async function tryUnlock(key, silent) {
  const k = (key || '').trim();
  if (!k) return false;
  const h = await sha256(k);
  if (h === UNLOCK_HASH) {
    try { localStorage.setItem('scsv_unlock', h); } catch {}
    state.unlocked = true;
    render();
    if (!silent) toast('Unlocked. Thank you for your purchase.');
    return true;
  }
  if (!silent) toast('That key did not match. Check the confirmation page or email from Stripe.', true);
  return false;
}

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  setTimeout(() => t.className = 'toast', 4000);
}

async function handleFile(file) {
  if (!file) return;
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast('Please choose a PDF file.', true); return; }
  $('#status').textContent = 'Reading ' + file.name + '…';
  $('#results').hidden = true;
  state.fileName = file.name.replace(/\.pdf$/i, '');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    let textChars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const lines = itemsToLines(content.items);
      textChars += lines.reduce((n, l) => n + l.text.length, 0);
      pages.push({ lines });
      $('#status').textContent = `Reading page ${i} of ${pdf.numPages}…`;
    }
    if (textChars < 50) {
      $('#status').textContent = '';
      showEmpty('This PDF has no text layer (it is probably a scan). Scanned statements are not supported yet. Try a statement downloaded from your bank\'s website instead.');
      return;
    }
    const res = extractTransactions(pages);
    state.rows = res.rows; state.pageCounts = res.pageCounts; state.numPages = pdf.numPages; state.warnings = res.warnings;
    $('#status').textContent = '';
    if (!res.rows.length) { showEmpty('No transactions were recognised. This layout may not be supported yet. Email the address at the bottom of the page with the bank name and I will add it.'); return; }
    render();
  } catch (e) {
    console.error(e);
    $('#status').textContent = '';
    showEmpty('Could not read this PDF: ' + (e.message || e));
  }
}

function showEmpty(msg) {
  $('#results').hidden = false;
  $('#summary').textContent = msg;
  $('#tablewrap').innerHTML = '';
  $('#actions').hidden = true;
  $('#paywall').hidden = true;
}

function visibleRows() {
  if (state.unlocked) return state.rows;
  return state.rows.filter(r => r.page <= FREE_PAGES);
}

function render() {
  if (!state.rows.length) return;
  const rows = visibleRows();
  const hidden = state.rows.length - rows.length;
  $('#results').hidden = false;
  $('#actions').hidden = false;
  const credits = state.rows.filter(r => r.amount > 0).length, debits = state.rows.filter(r => r.amount < 0).length;
  $('#summary').textContent = `${state.rows.length} transactions found across ${state.numPages} page${state.numPages === 1 ? '' : 's'} (${credits} positive, ${debits} negative).` + (state.warnings?.length ? ' ' + state.warnings.join(' ') : '');
  const t = document.createElement('table');
  t.innerHTML = '<thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const r of rows.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(r.date)}</td><td>${esc(r.description)}</td><td class="num ${r.amount < 0 ? 'neg' : 'pos'}">${r.amount === null ? '' : r.amount.toFixed(2)}</td><td class="num">${r.balance === null ? '' : r.balance.toFixed(2)}</td>`;
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  $('#tablewrap').innerHTML = ''; $('#tablewrap').appendChild(t);
  if (hidden > 0) {
    $('#paywall').hidden = false;
    $('#paywall-text').textContent = `${hidden} more transaction${hidden === 1 ? '' : 's'} on pages ${FREE_PAGES + 1}–${state.numPages} are hidden. Unlock once for $9 to convert every page of every statement, forever.`;
  } else {
    $('#paywall').hidden = true;
  }
  $('#dl').textContent = hidden > 0 ? `Download CSV (page ${FREE_PAGES} only)` : 'Download CSV';
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function download() {
  const csv = toCSV(visibleRows(), { splitDebitCredit: state.split });
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = state.fileName + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function init() {
  loadUnlock();
  const params = new URLSearchParams(location.search);
  if (params.get('unlock')) { tryUnlock(params.get('unlock'), true).then(ok => { if (ok) toast('Payment received. All pages are unlocked on this browser.'); }); history.replaceState(null, '', location.pathname); }
  const drop = $('#drop'), input = $('#file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => handleFile(input.files[0]));
  $('#dl').addEventListener('click', download);
  $('#split').addEventListener('change', e => state.split = e.target.checked);
  $('#buy').href = PAY_URL; $('#buy2').href = PAY_URL;
  $('#keyform').addEventListener('submit', e => { e.preventDefault(); tryUnlock($('#key').value); });
  $('#havekey').addEventListener('click', e => { e.preventDefault(); $('#keyform').hidden = false; $('#key').focus(); });
  if (state.unlocked) document.body.classList.add('unlocked');
  window.__scsv = { handleFile, state }; // for tests
}
init();
