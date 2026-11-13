/* DeccApp — renderer: offline-first + Firebase sync */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const moneyFormatter = new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
const MZN = (n) => moneyFormatter.format(Number(n) || 0) + (billingMode() ? '' : ' MT');
const { saleDocumentHtml, buildSalePdf, printSaleDocument, printDocumentHtml, salePdfBlob, saleCopyName, saleCopyList } = createSaleDocumentTools({
  $, MZN, esc: value => esc(value), fmtDate: value => fmtDate(value),
  findClientByName: value => findClientByName(value), ivaLines, saleBalance: s => saleBalance(s), docNew, toast,
  getState: () => ({company, clients, tax, billingMode:billingMode()}),
  markIssued: s => recordSaleIssue(s, 'print'),
  saveSalePdf: (s, copy) => saveSalePdfCopy(s, copy)
});
const parseMoney = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s) return 0;
  // Aceita 350.00, 350,00, 1.234,56 e 1,234.56 (o último separador é o decimal).
  s = s.replace(/[^\d.,-]/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    s = (parts.length === 2 && parts[1].length <= 2) ? parts[0].replace(/\./g, '') + '.' + parts[1] : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};
const fmtMoney = (n) => moneyFormatter.format(Number(n) || 0);
const fmtDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(iso || ''); };
function parseBRDate(s) {
  const raw = String(s || '').trim();
  let d = 0, mo = 0, y = 0, m;
  /* Aceita 23-10-2026, 23/10/2026, 23.10.2026, 2026-10-23 e 23102026. */
  if ((m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = raw.replace(/\D/g, '').match(/^(\d{2})(\d{2})(\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return '';
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
/* Chave segura para o Firebase Realtime Database:
   as chaves não podem conter  . # $ / [ ]  (ex.: emails com pontos). */
function fbKey(s) {
  const t = String(s || '').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  const base = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return (base || 'k') + '-' + h.toString(36);
}
/* Data local (não UTC): em Moçambique (UTC+2) o dia só muda à meia-noite local. */
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
/* Tipos de venda antigos ('vd'/'ft') continuam a contar como vendas */
const saleKind = (s) => {
  const t = String((s && s.type) || '').toLowerCase();
  if (t === 'credito' || t === 'crédito' || t === 'ft') return 'credito';
  if (t === 'cotacao' || t === 'cotação' || t === 'fp' || t === 'proforma') return 'cotacao';
  if (t === 'venda' || t === 'vd') return 'venda';
  return '';
};
/* Data em ISO (aceita AAAA-MM-DD, DD-MM-AAAA e DD/MM/AAAA) */
const dayKey = (v) => {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const isOnline = () => navigator.onLine === true;

/* ---------- matriz rígida de documentos (sigla → finalidade) ---------- */
const DOCS = {
  VD: { sig: 'VD', nome: 'Venda a Pronto', fim: 'Comprovativo de venda direta / dinheiro no ato' },
  FT: { sig: 'FT', nome: 'Fatura', fim: 'Venda a crédito / fiado com lançamento em Conta Corrente' },
  FP: { sig: 'FP', nome: 'Fatura Proforma', fim: 'Cotação / Orçamento sem valor fiscal e sem abate de stock' },
  RC: { sig: 'RC', nome: 'Recibo', fim: 'Comprovativo de amortização/liquidação de dívida de cliente' },
  NC: { sig: 'NC', nome: 'Nota de Crédito', fim: 'Anulação/Retificação de venda com devolução de stock' },
  GR: { sig: 'GR', nome: 'Guia de Remessa', fim: 'Acompanhamento de transporte de mercadoria para o cliente' },
  GTI: { sig: 'GTI', nome: 'Guia de Transferência Interna', fim: 'Movimentação física de stock entre Loja e Armazém' },
  FC: { sig: 'FC', nome: 'Fatura de Compra', fim: 'Entrada de mercadoria e aumento de stock de fornecedor' },
  OC: { sig: 'OC', nome: 'Ordem de Compra', fim: 'Pedido/Encomenda formal enviado ao fornecedor' },
  PF: { sig: 'PF', nome: 'Pagamento a Fornecedor', fim: 'Comprovativo de saída de valor para liquidar dívida' },
  STK: { sig: 'EXCEL-STK', nome: 'Exportação Mestre de Produtos e Stock', fim: 'Edição em massa e devolução' },
  CX: { sig: 'PDF-CX', nome: 'Balanço Diário de Fecho de Caixa', fim: 'Fecho e auditoria de caixa' },
  SAFT: { sig: 'SAFT-MZ', nome: 'Ficheiro de Auditoria Fiscal', fim: 'Auditoria para a Autoridade Tributária' }
};
const docTitle = (sig) => (DOCS[sig] ? sig + ' — ' + DOCS[sig].nome : sig);

/* ---------- local store (offline DB) ---------- */
const LS = { sup: 'dec_suppliers', inv: 'dec_invoices', pin: 'dec_pin', ses: 'dec_session', queue: 'dec_queue', stock: 'dec_stock', pay: 'dec_paymethods', units: 'dec_units', sales: 'dec_sales', cli: 'dec_clients', suppay: 'dec_suppay', moves: 'dec_moves', cashdays: 'dec_cashdays', cashmoves: 'dec_cashmoves', receipts: 'dec_receipts', ncs: 'dec_ncs', porders: 'dec_porders', supret: 'dec_supret', company: 'dec_company', role: 'dec_role', transfers: 'dec_transfers', tax: 'dec_tax', drafts: 'dec_drafts', notifs: 'dec_notifs', notifSeen: 'dec_notif_seen' };
const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } };
const save = (k, v) => {
  try { const serialized=JSON.stringify(v); if(localStorage.getItem(k)!==serialized) localStorage.setItem(k, serialized); }
  catch (e) {
    if (k !== LS.queue) { compactQueue(); try { localStorage.setItem(k, JSON.stringify(v)); return; } catch (_) {} }
    console.warn('localStorage cheio em ' + k, e);
  }
};
function applySidebar() {
  const collapsed=load('dec_sidebar_collapsed',false)===true;
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  const button=$('sidebarToggle');
  if(button) {button.textContent=collapsed?'›':'‹';button.setAttribute('aria-expanded',String(!collapsed));button.title=collapsed?'Expandir menu':'Recolher menu';button.setAttribute('aria-label',button.title);}
  document.querySelectorAll('.sidebar .nav-btn').forEach(button=>{const label=button.querySelector('.nav-label')?.textContent||'';button.title=label;button.setAttribute('aria-label',label);});
}
if($('sidebarToggle')) $('sidebarToggle').onclick=()=>{save('dec_sidebar_collapsed',!load('dec_sidebar_collapsed',false));applySidebar();};
applySidebar();
// Compacta a fila: escritas repetidas do mesmo registo fundem-se (mantém a última);
// remoções mantêm-se todas. Evita filas gigantes que travam a app.
function compactQueue() {
  const keep = {}, out = [];
  queue.forEach(op => {
    const id = op.payload && (op.payload.id || op.payload.key || op.payload.email);
    if (!id || String(op.type || '').indexOf('delete-') === 0) { out.push(op); return; }
    const scope=op.type==='notif-state' ? '|'+fbKey(op.payload.user||'')+'|'+op.payload.field : '';
    const k = op.type + scope + '|' + id;
    if (keep[k] != null) out[keep[k]] = op;
    else { keep[k] = out.length; out.push(op); }
  });
  if (out.length !== queue.length) { queue = out; try { localStorage.setItem(LS.queue, JSON.stringify(queue)); } catch (_) {} }
  return queue.length;
}
let suppliers = load(LS.sup, []);
let invoices = load(LS.inv, []);
let queue = load(LS.queue, []);
let stock = load(LS.stock, []);
let sales = load(LS.sales, []);
let clients = load(LS.cli, []);
let supPayments = load(LS.suppay, []);
let supAdjustments = load('dec_supadj', []);   // acertos de saldo do fornecedor (ex.: crédito a regularizar)
let stockLosses = load('dec_losses', []);       // perdas por saída direta (quebra/avaria/consumo)
let movements = load(LS.moves, []);
let cashDays = load(LS.cashdays, []);
let cashMoves = load(LS.cashmoves, []);
let receipts = load(LS.receipts, []);
let ncs = load(LS.ncs, []);
let porders = load(LS.porders, []);
let supReturns = load(LS.supret, []);
let transfers = load(LS.transfers, []);
let drafts = load(LS.drafts, []);
let notifs = load(LS.notifs, []);
let notifSeen = load(LS.notifSeen, []);
let notifDeleted = load('dec_notif_del', []);   // ids apagados pelo administrador (não voltam da nuvem)
let chatMsgs = load('dec_chat', []);
let chatDeleted = load('dec_chat_del', []);
let chatSeen = load('dec_chat_seen', []);
let chatWatchRefs = [];
let chatWatchUID = null;
let chatCloudDenied = false;
let chatFallbackOk = false;
let chatWarned = false;
let currentUser = (load(LS.ses, {}) || {}).email || 'Operador';
let systemRestoreInProgress = false;
let company = load(LS.company, { name: '', nuit: '', address: '', city: '', phone: '', email: '', vat: 16, updatedAt: 0 });
let tax = load(LS.tax, { vat: 16, mode: 'incl', exempt: 'Isento nos termos do Artigo 9 do CIVA', updatedAt: 0 });
let payMethods = load(LS.pay, ['Numerário', 'Transferência Bancária', 'M-Pesa', 'POS/Cartão', 'Cheque']);
let units = load(LS.units, ['CX', 'EMB']);
const persist = () => { save(LS.sup, suppliers); save(LS.inv, invoices); save(LS.queue, queue); save(LS.stock, stock); save(LS.pay, payMethods); save(LS.units, units); save(LS.sales, sales); save(LS.cli, clients); save(LS.suppay, supPayments); save(LS.moves, movements); save(LS.cashdays, cashDays); save(LS.cashmoves, cashMoves); save(LS.receipts, receipts); save(LS.ncs, ncs); save(LS.porders, porders); save(LS.supret, supReturns); save(LS.company, company); save(LS.transfers, transfers); save(LS.tax, tax); save(LS.drafts, drafts); save(LS.notifs, notifs); save(LS.notifSeen, notifSeen); save('dec_notif_del', notifDeleted); save('dec_supadj', supAdjustments); save('dec_chat', chatMsgs); save('dec_chat_del', chatDeleted); save('dec_chat_seen', chatSeen); save('dec_losses', stockLosses); };
const fmtQty = (p) => p.qty + (p.unit ? ' ' + p.unit : '');
function renderPayUnits() {
  const pl = $('payList'), ul = $('unitList');
  if (pl) pl.innerHTML = payMethods.map(v => `<option value="${esc(v)}">`).join('');
  if (ul) ul.innerHTML = units.map(v => `<option value="${esc(v)}">`).join('');
}
/* Todos os utilizadores sincronizam no mesmo momento: stock, vendas, caixa,
   compras, notificações e configurações. O operador não vê a operação de
   sincronização (é silenciosa), mas as alterações dele chegam já a todos. */
const autoSyncOk = () => true;
const isChatOp = (op) => !!op && ['chat', 'chat-user', 'delete-chat', 'delete-chat-user'].indexOf(op.type) !== -1;
const pushQueue = (op) => {
  if(op.payload && ['sale','draft','cashmove','receipt','nc','move','transfer','loss'].includes(op.type) && !op.payload.operator) op.payload.operator=String(currentUser||'').toLowerCase();
  queue.push({ ...op, ts: Date.now() });
  persist(); renderQueue();
  if (!isOnline()) return;
  if (autoSyncOk()) syncNow(true);
  else if (isChatOp(op)) syncChatQueue();   // operadores também podem enviar chat
};
// Lote: 1 persist + 1 render + 1 sync (eliminações em massa sem travar)
const pushQueueBulk = (ops) => {
  if (!ops || !ops.length) return;
  const now = Date.now();
  ops.forEach(op => queue.push({ ...op, ts: now }));
  persist(); renderQueue(); if (isOnline() && autoSyncOk()) syncNow(true);
};

/* ---------- firebase (Auth + Realtime Database) ---------- */
let auth = null, rdb = null, fbInitError = '';
let accountAccess=null,authorizedProfile=null;
let operatorWatchRefs=[],profileWatchRef=null;
try {
  if (typeof firebase === 'undefined') throw new Error('SDK Firebase não carregado (vendor).');
  if (!window.FIREBASE_CONFIG) throw new Error('firebase-config.js em falta.');
  firebase.initializeApp(window.FIREBASE_CONFIG);
  auth = firebase.auth(); rdb = firebase.database();
  accountAccess=createFirebaseAccountAccess({firebase,auth,database:rdb,config:window.FIREBASE_CONFIG,workspaceId:window.FIREBASE_WORKSPACE,keyForEmail:fbKey});
  if (auth && auth.setPersistence && firebase.auth && firebase.auth.Auth && firebase.auth.Auth.Persistence) {
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
  }
} catch (e) { fbInitError = String((e && e.message) || e); console.warn('Firebase init falhou', e); }
function fbStatus() {
  if (fbInitError) return 'SDK: ' + fbInitError;
  if (!auth) return 'Auth indisponível.';
  if (!isOnline()) return 'Offline — sem internet.';
  return 'Pronto.';
}
// Dados na nuvem por utilizador: users/{uid}/suppliers/{id}, users/{uid}/invoices/{id}
const cloudUid = () => (auth && auth.currentUser && auth.currentUser.uid) || null;
const cloudDataUid = () => cloudUid() && (window.FIREBASE_WORKSPACE || cloudUid());
const cloudEmailKey = email => String(email || '').trim().toLowerCase().split('%').join('%25').split('.').join('%2E').split('#').join('%23').split('$').join('%24').split('[').join('%5B').split(']').join('%5D').split('/').join('%2F');
/* O chat usa sempre o nó global teamchat (legível por qualquer conta autenticada
   e já coberto pelas regras publicadas). users/{U}/chat fica como reserva. */
const cloudChatPath = id => 'teamchat/' + (id || '');
const cloudRef = (p) => rdb.ref('users/' + cloudDataUid() + '/' + p);
const rootRef = (p) => rdb.ref(p);
// Assim que a sessão Firebase estiver pronta (ex.: entrou por PIN e há internet),
// o administrador envia a fila pendente; o operador só recebe dados (stock real).
async function authorizeFirebaseSession(user) {
  const profile=await accountAccess.authorize(user);authorizedProfile=profile;
  save(LS.role,profile.role);const cache=load('dec_authorized_profiles',{});cache[profile.email.toLowerCase()]=profile;save('dec_authorized_profiles',cache);
  return profile;
}
async function rejectFirebaseSession(error) {
  const deniedEmail=auth?.currentUser?.email;const cache=load('dec_authorized_profiles',{});if(deniedEmail)delete cache[deniedEmail.toLowerCase()];save('dec_authorized_profiles',cache);
  authorizedProfile=null;stopDataWatch();stopChatWatch();localStorage.removeItem(LS.ses);save(LS.role,'op');
  $('app').style.display='none';$('loginScreen').style.display='';document.querySelector('.topbar').style.display='none';
  try {if(auth?.currentUser)await auth.signOut();}catch(_){}
  toast(error.message || 'Conta não autorizada.','error');
}
if(auth)auth.onAuthStateChanged(async user=>{
  if(!user){authorizedProfile=null;if(profileWatchRef){profileWatchRef.off();profileWatchRef=null;}stopDataWatch();stopChatWatch();return;}
  try {await authorizeFirebaseSession(user);
    if(profileWatchRef)profileWatchRef.off();profileWatchRef=rdb.ref('users_meta/'+user.uid);
    profileWatchRef.on('value',async()=>{try{const previous=authorizedProfile?.role,previousMode=authorizedProfile?.mode||'';await authorizeFirebaseSession(user);if(authorizedProfile.admin!==true && previousMode!==(authorizedProfile.mode||'')){await logoutAndReload();return;}if(previous!==authorizedProfile.role){stopDataWatch();applyRole();await pullFromCloud();}}catch(error){await rejectFirebaseSession(error);}},error=>rejectFirebaseSession(error));
    if(autoSyncOk())syncNow(true);await pullFromCloud();startDataWatch();startChatWatch();}
  catch(error){await rejectFirebaseSession(error);}
});

/* ---------- net badges ---------- */
function netUI() {
  const on = isOnline();
  const dot = $('netDot');
  if (dot) { dot.textContent = on ? '●' : '○'; dot.className = 'net-dot ' + (on ? 'on' : 'off'); dot.title = on ? 'Online — a sincronizar' : 'Offline — modo local'; }
  if (!on) showLoginTab('offline');
}
window.addEventListener('online', () => {
  netUI();
  if (autoSyncOk()) { if (currentRole() === 'admin') toast('Ligação restabelecida. A sincronizar…', 'success'); syncNow(); }
  try { if (!autoSyncOk()) syncChatQueue(); startDataWatch(); pullFromCloud(); maybeSyncReport(); startChatWatch(); } catch (_) {}
});
window.addEventListener('offline', netUI);

/* ---------- helpers ---------- */
function toast(msg, icon = 'info') {
  if (window.Swal) Swal.fire({ toast: true, position: 'top-end', timer: 7000, timerProgressBar:true, showConfirmButton: false, icon, title: msg });
  else alert(msg);
}
async function confirmDlg(title, text) {
  if (window.Swal) {
    const r = await Swal.fire({ title, text, icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'Sim, remover', cancelButtonText: 'Cancelar' });
    return r && r.isConfirmed;
  }
  return confirm(title + '\n' + text);
}
/* Aviso sonoro curto (alerta de stock para o operador que está a vender) */
function beep(times) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const n = Math.max(1, Math.min(4, Number(times) || 1));
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.22;
      o.start(t0); o.stop(t0 + 0.13);
    }
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 400 + n * 250);
  } catch (_) {}
}
/* Mensagens distintas: o administrador recebe a instrução de reposição;
   o vendedor recebe apenas o aviso básico para pedir ajuda. */
function stockBlockAdminText(falta, locNow) {
  const locName = locNow === 'armazem' ? 'Armazém' : 'Loja';
  return 'É necessário requisitar mercadoria ao fornecedor (criar uma Ordem de Compra) ou registar entrada de stock antes de autorizar a venda. '
    + (falta || []).map(p => p.desc + ' — tem ' + stockQty(p.desc, locNow) + ' na ' + locName + ', pede ' + p.qty).join(' · ');
}
function stockBlockSellerText(falta, locNow) {
  const locName = locNow === 'armazem' ? 'Armazém' : 'Loja';
  return (falta || []).map(p => p.desc + ' (tem ' + stockQty(p.desc, locNow) + ' na ' + locName + ', pede ' + p.qty + ')').join(' · ')
    + ' → Melhor dar entrada no stock ou fazer requisição da mercadoria ao administrador.';
}
/* Venda/conversão bloqueada por falta de stock → notificação privada do operador (fica no histórico) */
function pushStockBlockNotif(falta, locNow, kind) {
  if (!falta || !falta.length || typeof notifs === 'undefined') return;
  const isAdm = currentRole() === 'admin';
  const sig = kind + '|' + falta.map(p => p.desc + ':' + p.qty + ':' + stockQty(p.desc, locNow)).join('|');
  const now = Date.now();
  // não repetir o mesmo aviso em menos de 10 minutos (o operador pode tentar várias vezes)
  if (notifs.slice(-10).some(n => n.blockSig === sig && (now - (n.ts || 0)) < 10 * 60 * 1000)) return;
  const first = falta[0];
  // cada item fica com a ficha do produto (loja/armazém/mínimo) para se ver tudo ao clicar
  const items = falta.map(p => {
    const s = findStock(p.desc);
    return { id: s ? s.id : '', name: (s && s.name) || p.desc, qty: p.qty, loc: locNow };
  });
  const n = {
    id: 'blk-' + uid(),
    kind: isAdm ? 'Reposição de stock' : 'Stock',
    title: (isAdm ? 'Reposição necessária — ' : 'Sem stock — ') + kind + ' bloqueada (' + falta.length + ' item(ns))',
    text: isAdm ? stockBlockAdminText(falta, locNow) : stockBlockSellerText(falta, locNow),
    items,
    reportKind: 'stock',
    to: currentUser, from: currentUser, readBy: [], ts: now, createdAt: now, updatedAt: now,
    blockSig: sig,
    link: { view: 'products', q: first.desc, sel: items[0].id }
  };
  notifs.push(n);
  pushQueue({ type: 'notif', payload: { ...n } });
  persist(); updateNotifBadge();
  if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
}
/* Aviso de stock em falta: versão abreviada com "Ver mais" e fechar (X) */
function stockBlockAlert(falta, locNow, kind) {
  const box = document.getElementById('saleAlert');
  if (!box) { return false; }
  const locName = locNow === 'armazem' ? 'Armazém' : 'Loja';
  const otherLoc = locNow === 'armazem' ? 'loja' : 'armazem';
  const otherName = otherLoc === 'armazem' ? 'Armazém' : 'Loja';
  const first = falta[0];
  /* Se o produto existe no outro local, oferecer troca imediata em vez de bloquear sem saída. */
  const otherOk = falta.every(p => stockQty(p.desc, otherLoc) >= p.qty);
  const canEntry = currentRole() !== 'op';
  const isAdm = currentRole() === 'admin';
  const lines = falta.map(p => `<li>${esc(p.desc)} — Loja <strong>${stockQty(p.desc, 'loja')}</strong> · Armazém <strong>${stockQty(p.desc, 'armazem')}</strong> · pede <strong>${p.qty}</strong></li>`).join('');
  box.classList.remove('open');
  box.innerHTML = `<div class="sa-body">`
    + `<div class="sa-title">Sem stock — ${esc(kind)} bloqueada (${falta.length} item(ns))</div>`
    + `<div class="sa-short">${esc(first.desc)} — Loja ${stockQty(first.desc, 'loja')} · Armazém ${stockQty(first.desc, 'armazem')} · pede ${first.qty}`
    + (falta.length > 1 ? ` · e mais ${falta.length - 1} item(ns)` : '') + `</div>`
    + `<ul class="sa-more">${lines}</ul>`
    + (isAdm ? '<div class="sa-help">Administrador: requisite mercadoria ao fornecedor (Ordem de Compra) ou dê entrada no stock aqui mesmo antes de vender.</div>'
      : (canEntry ? '<div class="sa-help">Pode dar entrada no stock aqui mesmo e voltar a guardar a venda.</div>'
        : '<div class="sa-help">Peça ao administrador para requisitar a mercadoria ao fornecedor ou dar entrada no stock.</div>'))
    + `</div>`
    + `<div class="sa-acts">`
    + (otherOk ? `<button type="button" class="btn small sa-loc">Vender da ${otherName}</button>` : '')
    + (canEntry ? `<button type="button" class="btn small primary sa-entry">Dar entrada</button>` : '')
    + (currentRole() !== 'admin' ? `<button type="button" class="btn small danger sa-rep">Reportar ao administrador</button>` : '')
    + `<button type="button" class="btn small sa-toggle">Ver mais</button><button type="button" class="btn small ghost sa-x" title="Fechar">✕</button></div>`;
  box.style.display = 'flex';
  if (currentRole() !== 'admin') {
    const rep = () => reportStockBlockToAdmin(falta, kind);
    const ttl = box.querySelector('.sa-title'), shr = box.querySelector('.sa-short');
    [ttl, shr].forEach(el => {
      if (!el) return;
      el.style.cursor = 'pointer';
      el.title = 'Toque para reportar esta situação ao administrador';
      el.onclick = rep;
    });
    const repBtn = box.querySelector('.sa-rep');
    if (repBtn) repBtn.onclick = rep;
  }
  box.querySelector('.sa-toggle').onclick = () => {
    const open = box.classList.toggle('open');
    box.querySelector('.sa-toggle').textContent = open ? 'Ver menos' : 'Ver mais';
  };
  box.querySelector('.sa-x').onclick = () => { box.style.display = 'none'; };
  const locBtn = box.querySelector('.sa-loc');
  if (locBtn) locBtn.onclick = () => {
    if ($('sLoc')) $('sLoc').value = otherLoc;
    box.style.display = 'none';
    toast('Local alterado para ' + otherName + '. Guarde a venda novamente.', 'success');
    try { $('btnSaveSale').focus(); } catch (_) {}
  };
  const entryBtn = box.querySelector('.sa-entry');
  if (entryBtn) entryBtn.onclick = () => {
    box.style.display = 'none';
    if ($('aProd')) $('aProd').value = first.desc;
    if ($('aType')) $('aType').value = 'entrada';
    if ($('aLoc')) $('aLoc').value = locNow;
    if ($('aQty')) $('aQty').value = '';
    if ($('aReason')) $('aReason').value = 'Ajuste Manual';
    if ($('aNotes')) $('aNotes').value = 'Entrada para repor stock antes da venda';
    if ($('adjModal')) $('adjModal').style.display = 'flex';
    setTimeout(() => { try { $('aQty').focus(); } catch (_) {} }, 40);
  };
  try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  try { beep(2); } catch (_) {}
  try { pushStockBlockNotif(falta, locNow, kind); } catch (_) {}
  return true;
}
/* ---------- captura global de erros (ecrã nunca fica mudo) ---------- */
function reportRuntimeError(ev, prefix) {
  try {
    const msg = String((ev && (ev.message || ev.reason && (ev.reason.message || ev.reason))) || 'erro desconhecido').slice(0, 300);
    const log = load('dec_errlog', []);
    log.push({ t: Date.now(), msg });
    save('dec_errlog', log.slice(-20));
    if (window.Swal) Swal.fire({ icon: 'error', title: 'Erro na app', text: msg + ' (ver Configurações → Diagnóstico)', confirmButtonColor: '#dc2626', confirmButtonText: 'Fechar' });
    const dg = document.getElementById('diagOut');
    if (dg) dg.textContent = 'Último erro: ' + msg;
    if (prefix) toast(prefix + ': ' + msg, 'error');
  } catch (_) {}
}
window.addEventListener('error', (ev) => reportRuntimeError(ev));
window.addEventListener('unhandledrejection', (ev) => reportRuntimeError(ev, 'Não foi possível concluir'));
function invoicesFor(supId) {
  return invoices.filter(i => i.supplierId === supId)
    .sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
}
function withBalances(supId) {
  const invs = invoicesFor(supId);
  // pagamentos "iniciais" (feitos no registo da fatura) já estão em inv.paid → não entram no extrato
  const extras = supPayments.filter(p => p.supplierId === supId && !p.initial).map(p => ({ date: p.date, amount: Number(p.amount) || 0, ts: p.ts || 0 }))
    .concat(supReturns.filter(r => r.supplierId === supId).map(r => ({ date: r.date, amount: Number(r.total) || 0, ts: r.ts || 0 })))
    .sort((a, b) => String(a.date + (a.ts || 0)).localeCompare(String(b.date + (b.ts || 0))));
  let ei = 0, prev = 0;
  return invs.map(inv => {
    let old = prev;
    while (ei < extras.length && extras[ei].date <= inv.date) { old -= Number(extras[ei].amount) || 0; ei++; }
    const totalBal = old + inv.total, nb = totalBal - inv.paid;
    prev = nb;
    return { ...inv, oldBalance: old, totalBalance: totalBal, newBalance: nb };
  });
}
const supBalance = (supId) => { const l = withBalances(supId); return l.length ? l[l.length - 1].newBalance : 0; };
const supName = (id) => (suppliers.find(s => s.id === id) || {}).name || '—';

/* ---------- stock (PMP + Kardex + multi-localização Loja/Armazém) ---------- */
/* ---------- stock: chave única normalizada (anti-duplicados) ---------- */
const normName = (n) => String(n || '').trim().toUpperCase();
function findStock(nm) {
  const k = String(nm || '').trim().toLowerCase();
  return stock.find(x => String(x.name || '').trim().toLowerCase() === k);
}
// Funde registos com o mesmo nome normalizado (soma quantidades, mantém o mais recente)
function dedupeStock(silent) {
  const seen = {};
  let merged = 0;
  stock.forEach(s => {
    s.name = normName(s.name);
    const k = s.name.toLowerCase();
    if (!seen[k]) { seen[k] = s; return; }
    const m = seen[k];
    const master = ((m.updatedAt || 0) >= (s.updatedAt || 0)) ? m : s;
    const other = master === m ? s : m;
    master.qLoja = (Number(master.qLoja) || 0) + (Number(other.qLoja) || 0);
    master.qArm = (Number(master.qArm) || 0) + (Number(other.qArm) || 0);
    master.updatedAt = Date.now();
    pushQueue({ type: 'delete-stock', payload: { id: other.id } });
    merged++;
    seen[k] = master;
  });
  if (merged) {
    stock = Object.values(seen);
    Object.values(seen).forEach(m => pushQueue({ type: 'stock', payload: { ...m } }));
    persist();
    if (!silent) toast(merged + ' duplicado(s) fundido(s).', 'warning');
  }
  return merged;
}
function stockTotal(s) { return (Number(s.qLoja) || 0) + (Number(s.qArm) || 0); }
// Reserva desativada por regra de negócio (conceito removido): disponível = físico total.
function stockReserved(s) { return 0; }
function stockAvail(s) { return stockTotal(s); }
function normalizeStock() {
  let changed = false;
  stock.forEach(s => {
    if (s.qLoja == null && s.qArm == null) { s.qLoja = Number(s.qty) || 0; s.qArm = 0; delete s.qty; changed = true; }
    if (s.qLoja == null) { s.qLoja = 0; changed = true; }
    if (s.qArm == null) { s.qArm = 0; changed = true; }
    if (s.reserved != null) { delete s.reserved; changed = true; }
    if (s.sku == null) { s.sku = ''; changed = true; }
    if (s.cat == null) { s.cat = ''; changed = true; }
    if (s.name) { const up = normName(s.name); if (s.name !== up) { s.name = up; changed = true; } }
  });
  if (changed) persist();
  dedupeStock(true);
}
function stockApply(items, mult, queueIt = true, ref = '', loc = 'loja') {
  loc = loc === 'armazem' ? 'armazem' : 'loja';
  (items || []).forEach(p => {
    const nm = normName(p.desc); if (!nm) return;
    const qty = Number(p.qty) || 0;
    let s = findStock(nm);
    if (!s) {
      if (mult < 0) return;
      s = { id: uid(), name: nm, unit: p.unit || '', qLoja: 0, qArm: 0, cost: 0, price: 0, margin: 0, min: 0, updatedAt: Date.now() };
      stock.push(s);
    }
    if (s.qLoja == null) s.qLoja = 0;
    if (s.qArm == null) s.qArm = 0;
    const oldQ = loc === 'armazem' ? s.qArm : s.qLoja, oldC = Number(s.cost) || 0;
    if (loc === 'armazem') s.qArm = Math.max(0, s.qArm + mult * qty);
    else s.qLoja = Math.max(0, s.qLoja + mult * qty);
    let changed = ((loc === 'armazem' ? s.qArm : s.qLoja) !== oldQ);
    if (mult > 0 && qty > 0) {
      const np = Number(p.price) || 0;
      s.cost = (oldQ > 0 && oldC > 0) ? Math.round(((oldQ * oldC + qty * np) / (oldQ + qty)) * 100) / 100 : np;
      if (p.unit) s.unit = p.unit;
      if (!Number(s.price)) s.price = Math.round(s.cost * (1 + (Number(s.margin) || 0) / 100) * 100) / 100;
      s.updatedAt = Date.now(); changed = true;
    }
    if (changed && queueIt) pushQueue({ type: 'stock', payload: { ...s } });
    if (ref && qty !== 0) {
      /* Guardar o preço/valor no momento do movimento: o histórico não muda se o preço do produto mudar depois. */
      const unitPrice = mult < 0 ? (Number(p.price) || Number(s.price) || 0) : (Number(p.price) || 0);
      const total = Math.round(Math.abs(mult * qty) * unitPrice * 100) / 100;
      const mv = { id: uid(), productId: s.id, name: nm, date: todayISO(), type: mult > 0 ? 'entrada' : 'saida', qty: mult * qty, after: loc === 'armazem' ? s.qArm : s.qLoja, loc, ref, reason: mult > 0 ? 'Compra' : 'Venda', price: unitPrice, total, value: total, unit: s.unit || p.unit || '', operator:currentUser, by:currentUser, ts: Date.now() };
      movements.push(mv);
      if (queueIt) pushQueue({ type: 'move', payload: { ...mv } });
    }
  });
  persist();
}
function rebuildStock() {
  const meta = {};
  stock.forEach(s => { meta[normName(s.name).toLowerCase()] = s; });
  stock = [];
  const ensure = (nm) => {
    nm = normName(nm);
    let s = stock.find(x => x.name === nm);
    if (!s) { const m = meta[nm.toLowerCase()] || {}; s = { id: uid(), name: nm, unit: m.unit || '', qLoja: 0, qArm: 0, cost: m.cost || 0, price: m.price || 0, margin: m.margin != null ? m.margin : 0, min: m.min || 0, updatedAt: Date.now() }; stock.push(s); }
    return s;
  };
  [...movements].sort((a, b) => String(a.date + (a.ts || 0)).localeCompare(String(b.date + (b.ts || 0)))).forEach(m => {
    const s = ensure(m.name);
    const q = Number(m.qty) || 0, loc = m.loc === 'armazem' ? 'qArm' : 'qLoja';
    s[loc] = Math.max(0, (Number(s[loc]) || 0) + q);
  });
  stock.forEach(s => pushQueue({ type: 'stock', payload: { ...s } }));
  persist(); renderAll();
  toast('Stock recalculado: ' + stock.length + ' produto(s).', 'success');
}

/* ---------- fornecedor: pagamentos + saldo efetivo ---------- */
function supAdjTotal(supId) { return supAdjustments.filter(a => a.supplierId === supId).reduce((s, a) => s + (Number(a.amount) || 0), 0); }
function supExtra(supId) { return supPayments.filter(p => p.supplierId === supId).reduce((s, p) => s + (Number(p.amount) || 0), 0); }
function supEffective(supId) {
  const l = withBalances(supId);
  const lastDate = l.length ? l[l.length - 1].date : '';
  const left = supPayments.filter(p => p.supplierId === supId && !p.initial && p.date > lastDate).reduce((s, p) => s + (Number(p.amount) || 0), 0)
    + supReturns.filter(r => r.supplierId === supId && r.date > lastDate).reduce((s, r) => s + (Number(r.total) || 0), 0);
  return (l.length ? l[l.length - 1].newBalance : 0) - left + supAdjTotal(supId);
}
function nextSupPayNumber() {
  const y = new Date().getFullYear();
  const n = supPayments.filter(p => String(p.number || '').indexOf('PAG ' + y) === 0).length + 1;
  return 'PAG ' + y + '/' + String(n).padStart(3, '0');
}

/* ---------- clientes ---------- */
function clientNameKey(name) { return String(name||'').trim().replace(/\s+/g,' ').toLowerCase(); }
function findClientByName(nm) { const key=clientNameKey(nm);return key ? clients.find(x => clientNameKey(x.name)===key) : undefined; }
function clientIssuedDocuments(id) {
  const client=clients.find(c=>c.id===id);if(!client) return [];
  return sales.filter(canSeeSale).filter(s=>s.clientId===id || ((!s.clientId || !clients.some(c=>c.id===s.clientId)) && clientNameKey(s.client)===clientNameKey(client.name)))
    .sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || (Number(b.createdAt)||0)-(Number(a.createdAt)||0));
}
function clientSales(id) {
  const c = clients.find(x => x.id === id); if (!c) return [];
  const nm = (c.name || '').toLowerCase();
  return sales.filter(canSeeSale).filter(s => s.type !== 'cotacao' && (s.clientId === id || ((s.client || '').toLowerCase() === nm && !s.clientId))).sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
}
function clientDocs(id) {
  const c = clients.find(x => x.id === id); if (!c) return [];
  const nm = (c.name || '').toLowerCase();
  const mine = (s) => canSeeSale(s) && s.type !== 'cotacao' && (s.clientId === id || ((s.client || '').toLowerCase() === nm && !s.clientId));
  const rows = [];
  sales.filter(mine).forEach(s => {
    rows.push({ saleId:s.id, date: s.date, ts: s.createdAt || 0, doc: s.number, kind: s.type === 'credito' ? 'Fatura (FT)' : 'Venda (VD)', plus: Number(s.total) || 0, minus: 0 });
    (s.payments || []).forEach(p => rows.push({ saleId:s.id, date: p.date, ts: s.createdAt || 0, doc: p.doc || s.number, kind: 'Recibo', plus: 0, minus: Number(p.amount) || 0 }));
  });
  ncs.filter(n => currentRole()==='admin' || String(n.operator||'').toLowerCase()===String(currentUser||'').toLowerCase()).filter(n => n.clientId === id || ((n.client || '').toLowerCase() === nm && !n.clientId)).forEach(n => rows.push({ date: n.date, ts: n.ts || 0, doc: n.number, kind: 'Nota de Crédito', plus: 0, minus: Number(n.total) || 0 }));
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.ts - b.ts));
}
function clientBalance(id) { return clientDocs(id).reduce((s, r) => s + r.plus - r.minus, 0); }

/* ---------- caixa ---------- */
function cashDayGet(dateISO, auto) {
  let d = cashDays.find(x => x.date === dateISO);
  if (!d && auto !== false) { d = { id: dateISO, date: dateISO, open: 0, closed: false, updatedAt: Date.now() }; cashDays.push(d); pushQueue({ type: 'cashday', payload: { ...d } }); }
  return d;
}
function cashAdd(day, type, category, amount, method, ref, notes, auto) {
  amount = Number(amount) || 0; if (amount <= 0) return false;
  const d = cashDayGet(day);
  if (!d) return false;
  if (d.closed) { d.closed = false; d.updatedAt = Date.now(); pushQueue({ type: 'cashday', payload: { ...d } }); toast('Caixa de ' + fmtDate(day) + ' reaberta automaticamente.', 'warning'); }
  const t = new Date();
  const mv = { id: uid(), day, time: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), type, category, amount, method: method || 'Numerário', ref: ref || '', notes: notes || '', auto: !!auto, ts: Date.now() };
  cashMoves.push(mv); pushQueue({ type: 'cashmove', payload: { ...mv } });
  persist(); renderCash();
  return true;
}
function cashTotals(day) {
  const ms = cashMoves.filter(m => m.day === day);
  const tin = ms.filter(m => m.type === 'entrada').reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const tout = ms.filter(m => m.type === 'saida').reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const d = cashDayGet(day, false);
  const open = d ? Number(d.open) || 0 : 0;
  return { open, tin, tout, bal: open + tin - tout, closed: d ? !!d.closed : false };
}
function nextReciboNumber() {
  const y = new Date().getFullYear();
  let n = 0;
  sales.forEach(s => (s.payments || []).forEach(p => { if (String(p.doc || '').indexOf('REC ' + y) === 0) n++; }));
  return 'REC ' + y + '/' + String(n + 1).padStart(3, '0');
}
function profitReport(list) {
  let revenue = 0, cogs = 0;
  (list || []).forEach(s => {
    if (s.type === 'cotacao') return;
    (s.items || []).forEach(p => { revenue += Number(p.total) || 0; cogs += (p.cost != null ? Number(p.cost) : 0) * (Number(p.qty) || 0); });
  });
  return { revenue, cogs, gross: revenue - cogs };
}
function stockCost(nm) { const s = stock.find(x => (x.name || '').toLowerCase() === String(nm || '').toLowerCase()); return s ? ((s.cost != null ? Number(s.cost) : Number(s.price)) || 0) : 0; }

/* ---------- auth ---------- */
let mode = 'online';
function showLoginTab(which) {
  mode = which;
  $('tabEmail').classList.toggle('active', which === 'online');
  $('tabPin').classList.toggle('active', which === 'offline');
  $('onlineLogin').style.display = which === 'online' ? 'block' : 'none';
  $('offlineLogin').style.display = which === 'offline' ? 'block' : 'none';
}
$('tabEmail').onclick = () => showLoginTab('online');
$('tabPin').onclick = () => showLoginTab('offline');
$('btnLogin').onclick = async () => {
  const email = $('loginEmail').value.trim(), pass = $('loginPass').value;
  if (!email || !pass) return toast('Indique email e palavra-passe.', 'warning');
  if (!auth) return toast('Login indisponível — ' + fbStatus() + ' Verifique internet e config Firebase.', 'error');
  if (!isOnline()) return toast('Sem internet. Use a entrada por PIN.', 'error');
  const t = setTimeout(() => toast('A contactar o Firebase… (pode demorar na 1ª vez)', 'info'), 3000);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    clearTimeout(t);
    const profile=await authorizeFirebaseSession(cred.user);
    save(LS.ses,{email:profile.email,uid:cred.user.uid,ts:Date.now()});
    currentUser=profile.email;
    ensureLocalUser(profile.email,profile.name||cred.user.displayName||'',profile.role);
    await pullFromCloud();
    enterApp(email);
    await syncNow(true); // primeiro envia o que estava pendente (inclui remoções)
    await pullFromCloud();
    /* Partilha a equipa com o espaço da empresa (companyMembers). Só passa
       depois de as regras novas estarem publicadas; até lá é descartado. */
    try { if (currentRole() === 'admin') pushUsersMap(); } catch (_) {}
    toast('Bem-vindo, ' + email, 'success');
  } catch (e) {
    clearTimeout(t);
    if(auth?.currentUser && !authorizedProfile) await rejectFirebaseSession(e);
    const code = (e && e.code) || '';
    let msg = (e && e.message) || 'erro desconhecido';
    if (code.indexOf('user-not-found') !== -1 || code.indexOf('invalid-credential') !== -1 || code.indexOf('wrong-password') !== -1) msg = 'Email ou palavra-passe incorretos. Peça ao administrador para criar a conta em Configurações → Utilizadores & Contas, ou entre por PIN.';
    else if (code.indexOf('operation-not-allowed') !== -1) msg = 'Login por Email/Password DESATIVADO no Firebase Console → Authentication → Sign-in method. Ative e tente de novo.';
    else if (code.indexOf('network-request-failed') !== -1 || code.indexOf('unavailable') !== -1) { msg = 'Sem ligação ao Firebase (rede/firewall). Use PIN offline.'; showLoginTab('offline'); }
    else if (code.indexOf('too-many-requests') !== -1) msg = 'Muitas tentativas. Aguarde e tente de novo.';
    else if (code.indexOf('api-key-not-valid') !== -1) msg = 'API key inválida ou restrita (HTTP referrers). Liberte para este projeto.';
    toast('Falha no login: ' + msg, 'error');
    const dg = $('diagOut'); if (dg) dg.textContent = 'Login: ' + code + ' — ' + msg;
  }
};
/* Criar conta: só dentro da app (Configurações → Utilizadores & Contas). */
$('btnPin').onclick = async () => {
  if(window.FIREBASE_CONFIG && isOnline() && !auth?.currentUser)return toast('Entre primeiro com email e palavra-passe para validar a autorização Firebase.','warning');
  const pin = $('loginPin').value.trim();
  if (!/^\d{4,6}$/.test(pin)) return toast('PIN deve ter 4–6 dígitos.', 'warning');
  if (typeof bcrypt === 'undefined') return toast('Biblioteca de segurança não carregada. Feche e reabra a app.', 'error');
  // Multi-utilizador: procura PIN nas contas criadas
  try {
    const users = appUsers();
    for (const u of users) {
      if(window.FIREBASE_CONFIG){const cached=load('dec_authorized_profiles',{})[String(u.email||'').toLowerCase()];if(!cached || cached.active!==true || typeof cached.admin!=='boolean' || !cached.uid || u.active===false)continue;if(isOnline()){if(auth.currentUser.email.toLowerCase()!==u.email.toLowerCase())continue;await authorizeFirebaseSession(auth.currentUser);}}
      let ok = false;
      try { ok = bcrypt.compareSync(pin, u.pinHash); } catch (_) { ok = (pin === u.pinHash); }
      if (ok) {
        save(LS.role, u.role || 'op');
        save(LS.ses, { email: u.email, name: u.name || '', ts: Date.now() });
        enterApp(u.email); applyRole();
        return toast('Acesso concedido — ' + (u.name || displayNameOf(u.email)) + '.', 'success');
      }
    }
  } catch (_) {}
  if(window.FIREBASE_CONFIG)return toast('PIN sem perfil autorizado neste computador. Entre com email e palavra-passe.','error');
  const hash = load(LS.pin, null);
  if (!hash) return toast('Nenhum PIN definido. Entre com email e crie o PIN em Configurações.', 'error');
  let ok = false;
  try { ok = bcrypt.compareSync(pin, hash); } catch (e) { return toast('Falha ao verificar o PIN. Tente de novo.', 'error'); }
  if (ok) { enterApp((load(LS.ses, {})).email || 'Utilizador Offline'); toast('Acesso concedido.', 'success'); }
  else toast('PIN incorreto.', 'error');
};
/* Primeiro arranque offline: sem PIN nem utilizadores neste computador,
   permite criar o acesso local (sem precisar do Firebase). */
function renderFirstRun() {
  if(window.FIREBASE_CONFIG){if($('firstRunBox'))$('firstRunBox').style.display='none';return;}
  const el = $('firstRunBox'); if (!el) return;
  let fresh = !load(LS.pin, null);
  try { if (fresh && appUsers().length) fresh = false; } catch (_) {}
  el.style.display = fresh ? 'block' : 'none';
  renderSystemBackupStatus();
}
if ($('btnFirstRun')) $('btnFirstRun').onclick = () => {
  if(window.FIREBASE_CONFIG)return toast('Peça ao administrador para criar a conta Firebase.','error');
  const name = (($('firstName') || {}).value || '').trim() || 'Utilizador Offline';
  const a = (($('firstPin') || {}).value || '').trim(), b = (($('firstPinConf') || {}).value || '').trim();
  if (typeof bcrypt === 'undefined') return toast('Biblioteca de segurança não carregada. Feche e reabra a app.', 'error');
  if (!/^\d{4,6}$/.test(a)) return toast('PIN: 4–6 dígitos numéricos.', 'warning');
  if (a !== b) return toast('Confirmação não coincide.', 'error');
  try {
    save(LS.pin, bcrypt.hashSync(a, 10));
    save(LS.ses, { email: name, ts: Date.now(), offline: true });
  } catch (e) { return toast('Falha ao criar o acesso. Tente de novo.', 'error'); }
  if ($('firstPin')) $('firstPin').value = ''; if ($('firstPinConf')) $('firstPinConf').value = '';
  renderFirstRun(); try { renderPinStatus(); } catch (_) {}
  enterApp(name);
  toast('Acesso offline criado. Bem-vindo, ' + name, 'success');
};
async function logoutAndReload() {
  try { stopDataWatch(); } catch (_) {}
  try { stopChatWatch(); } catch (_) {}
  authorizedProfile=null;if(profileWatchRef){profileWatchRef.off();profileWatchRef=null;}
  localStorage.removeItem(LS.ses);
  $('app').style.display='none';$('loginScreen').style.display='';
  document.querySelector('.topbar').style.display='none';
  document.querySelectorAll('.modal,.chat-pop').forEach(el=>el.style.display='none');
  try { if(auth) await auth.signOut(); } catch (_) {}
  location.reload();
}
$('btnLogout').onclick=logoutAndReload;
function enterApp(email) {
  currentUser = email || 'Operador';
  $('loginScreen').style.display = 'none'; $('app').style.display = 'flex';
  try { document.querySelector('.topbar').style.display = 'flex'; } catch (_) {}
  renderTopUser();
  $('fDate').value = fmtDate(todayISO());
  pushOwnProfile();
  resetProdRows(); renderAll();
  try { startDataWatch(); } catch (_) {}
  try { startChatWatch(); } catch (_) {}
  try { maybeSyncReport(); } catch (_) {}
}
// Trava RBAC: regista o perfil no nó users_meta/{uid} quando há sessão Firebase
function pushOwnProfile() { /* Perfis são criados exclusivamente pela gestão de contas. */ }

/* ---------- rascunhos de venda (F2/F3/F4 + troca de menu) ---------- */
function saleDirty() {
  if ($('saleFormPanel') && $('saleFormPanel').style.display === 'block') {
    const items = readItems('saleRows');
    if (items.length) return true;
    if (($('sClient') || {}).value) return true;
  }
  return false;
}
function saleSignature() {
  try {
    return JSON.stringify({ operator:currentUser, c: ($('sClient') || {}).value || '', clientId:$('sClient')?.dataset.clientId||'', date:$('sDate')?.value||'', number:$('sNumber')?.value||'', payMethod:$('sPay')?.value||'', kind:$('sType')?.value||'', l: ($('sLoc') || {}).value || '', n: ($('sNotes') || {}).value || '', billingPaymentStatus:$('sBillingPaid')?.value, p: ($('sPaid') || {}).value || '', items: readItems('saleRows') });
  } catch (_) { return ''; }
}
let lastDraftSig = '';
let draftFresh = false;
function draftForMe(d) {return String(d.operator||'').toLowerCase()===String(currentUser||'').toLowerCase();}
function saveSaleDraft(kind, {silent=false} = {}) {
  // Rascunho ÚNICO: substitui o anterior (sem lista)
  const old = drafts.find(draftForMe);
  const d = { id: uid(), kind: kind || (($('sType') || {}).value || 'venda'), date: ($('sDate') || {}).value || fmtDate(todayISO()), number: ($('sNumber') || {}).value || '', client: ($('sClient') || {}).value || '', clientId:$('sClient')?.dataset.clientId||null, loc: ($('sLoc') || {}).value || 'armazem', billingPaymentStatus:$('sBillingPaid')?.value, paid: ($('sPaid') || {}).value || '', payMethod: ($('sPay') || {}).value || '', notes: ($('sNotes') || {}).value || '', items: readItems('saleRows'), operator: currentUser, updatedAt: Date.now(), createdAt: Date.now() };
  drafts = [d,...drafts.filter(item=>!draftForMe(item))]; save(LS.drafts, drafts);
  if (old && old.id !== d.id) pushQueue({ type: 'delete-draft', payload: { id: old.id } });
  pushQueue({ type: 'draft', payload: { ...d } });
  lastDraftSig = saleSignature();
  draftFresh = true;
  persist(); renderDraftBadge(); if(!silent) toast('Rascunho guardado.', 'success');
  return d;
}
async function guardSaleDraft(next) {
  if (!saleDirty()) { next(); return; }
  // Guarda automaticamente e navega sem abrir uma confirmação.
  if (lastDraftSig && lastDraftSig === saleSignature()) { next(); return; }
  saveSaleDraft(undefined,{silent:true});
  next();
}
function renderDraftBadge() {
  const n = drafts.filter(draftForMe).length;
  const nav = document.querySelector('.nav-btn[data-view="sales"]');
  if (nav) { const lbl = nav.querySelector('.nav-label'); if (lbl) lbl.textContent = (billingMode()?'Faturação':'Vender')+(n>0?' ❶':''); }
  const feat = $('featSell');
  if (feat) { const st = feat.querySelector('strong'); if (st) st.textContent = (billingMode()?'Faturação':'Vender')+(n>0?' ❶':''); }
}
function resumeDraft(id, {silent=false} = {}) {
  const d = drafts.find(x => x.id === id && draftForMe(x)); if (!d) return;
  setSaleKind(d.kind || 'venda');
  $('sDate').value = d.date || fmtDate(todayISO());
  $('sNumber').value = d.number || nextSaleNumber(d.kind || 'venda');
  $('sClient').value = d.client || '';
  if(d.clientId) $('sClient').dataset.clientId=d.clientId;else delete $('sClient').dataset.clientId;
  if ($('sLoc')) $('sLoc').value = d.loc || 'armazem';
  $('sBillingPaid').value=d.billingPaymentStatus||'Não paga'; $('sPaid').value = d.paid || ''; $('sPay').value = d.payMethod || ''; $('sNotes').value = d.notes || '';
  $('saleRows').innerHTML = '';
  (d.items || []).forEach(p => $('saleRows').appendChild(prodRow(p.desc, p.qty, p.price, p.unit || '')));
  if (!d.items || !d.items.length) $('saleRows').appendChild(prodRow());
  recalcForm('saleRows');
  pushQueue({ type: 'delete-draft', payload: { id: d.id } });
  drafts = drafts.filter(x => x.id !== d.id);
  lastDraftSig = '';
  draftFresh = false;
  persist(); renderDraftBadge(); refreshCliHint();
  if(!silent) toast(billingMode()?'Faturação retomada.':'Rascunho retomado — stock atualizado.', 'success');
}
/* ---------- notificações ---------- */
const fmtDateTime = (ts) => { try { const d = new Date(Number(ts) || 0); return d.toLocaleString('pt-MZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
const fmtTime = (ts) => { try { const d = new Date(Number(ts) || 0); return d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
function notifForMe(n) {
  if(!n || notifGone(n.id)) return false;
  const to = n.to || 'all';
  const me = String(currentUser || '').toLowerCase();
  if (to === 'all') {
    /* O administrador vê tudo; uma conta normal só vê avisos do sistema
       ou avisos que ela própria originou (nunca informações alheias). */
    if (currentRole() === 'admin') return true;
    return !!n.from && String(n.from).toLowerCase() === me;
  }
  if (to === 'admin') return currentRole() === 'admin';
  return String(to).toLowerCase() === me;
}
function notifUnread(n) { return !(n.readBy || []).some(e => String(e).toLowerCase() === String(currentUser || '').toLowerCase()); }
function notifUserState() { return load('dec_notif_user_state',{}); }
function notifUserHas(field,id) { return !!(notifUserState()[fbKey(currentUser)]?.[field]?.[fbKey(id)]); }
function saveNotifUserState(field,id,sync=true) {
  const users=notifUserState(),user=fbKey(currentUser);
  users[user] ||= {}; users[user][field] ||= {};users[user][field][fbKey(id)]=id;
  save('dec_notif_user_state',users);
  if(sync) pushQueue({type:'notif-state',payload:{user:currentUser,id,field}});
}
function seenHas(id) { return currentRole()==='admin' ? notifSeen.includes(id) : notifUserHas('seen',id); }
/* marca como vista (com corte para o ficheiro não crescer sem fim) */
function seenAdd(id) {
  if (!id) return;
  if(currentRole()!=='admin') {saveNotifUserState('seen',id);return;}
  if (notifSeen.indexOf(id) === -1) notifSeen.push(id);
  if (notifSeen.length > 600) notifSeen = notifSeen.slice(-600);
  save(LS.notifSeen, notifSeen);
}
/* ---------- todo o movimento com valores gera notificação ---------- */
/* Nome completo do tipo de movimento (nada de abreviaturas) */
function movTypeName(it) {
  const t = (it && it.type) || '';
  if (t === 'VD') return 'Venda a pronto';
  if (t === 'FT') return 'Venda a crédito';
  if (t === 'REC') return 'Recebimento';
  if (t === 'PAG') return 'Pagamento';
  if (t === 'ENT') return 'Entrada de caixa';
  if (t === 'DESP') return 'Despesa';
  return t || 'Movimento';
}
function movNotifKind(it) { return movTypeName(it); }
function movNotifLink(it, isAdmin) {
  if (it.sale) return { view: 'sales', q: it.sale.number, sel: it.sale.id };
  if (it.rcp) {
    const al = (it.rcp.allocations || [])[0];
    const sv = al && sales.find(s => s.id === al.saleId);
    return { view: 'sales', q: sv ? sv.number : (it.rcp.client || ''), sel: sv ? sv.id : null };
  }
  if (isAdmin && it.pp) return { view: 'pays', q: supName(it.pp.supplierId), invId: it.pp.invoiceId || null };
  if (isAdmin && it.pinv) return { view: 'pays', q: supName(it.pinv.supplierId), invId: it.pinv.id };
  if (isAdmin && it.cm) return { view: 'pays' };
  return null;
}
/* Todos os movimentos com valores de hoje e de ontem entram na lista (teto de segurança: 150) */
function movAlerts() {
  const isAdmin = currentRole() === 'admin';
  const me = String(currentUser || '').toLowerCase();
  const out = [];
  const d = new Date(); d.setDate(d.getDate() - 1);
  const from = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const items = payMoveItems();
  for (let i = 0; i < items.length && out.length < 150; i++) {
    const it = items[i];
    if (it.date && it.date < from) break;          // lista ordenada do mais recente para o mais antigo
    const owner = String((it.sale && it.sale.operator) || (it.rcp && it.rcp.operator) || (it.pp && it.pp.operator) || (it.cm && it.cm.operator) || '').toLowerCase();
    if (!isAdmin) {
      if(it.sale && !canSeeSale(it.sale))continue;
      if (it.pp || it.pinv || it.cm) continue;    // valores de fornecedor e caixa: só o administrador
      if (owner !== me) continue;          // autor desconhecido nunca é público
    }
    const val = MZN(Math.abs(it.amount));
    const kind = movNotifKind(it);
    out.push({
      id: 'mov-' + it.key,
      kind,
      title: (it.doc || it.type) + ' — ' + val,
      text: [kind, it.detail, it.info, (it.amount < 0 ? 'Saída' : 'Entrada') + ' de ' + val, owner ? userNameOf(owner) : '']
        .filter(Boolean).join(' · '),
      ts: Number(it.ts) || new Date((it.date || todayISO()) + 'T12:00:00').getTime(),
      link: movNotifLink(it, isAdmin)
    });
  }
  return out;
}
/* ---------- situações de stock (badge do Painel Geral + painel do administrador) ---------- */
/* vermelho = stock mínimo/esgotado · branco(+) = stock novo entrado hoje */
function stockSituations() {
  const low = [];
  (stock || []).forEach(s => {
    const mn = Number(s.min) || 0, av = stockAvail(s);
    if ((mn > 0 && av <= mn) || av <= 0) low.push(s);
  });
  low.sort((a, b) => stockAvail(a) - stockAvail(b) || String(a.name).localeCompare(String(b.name)));
  const today = todayISO(), seen = {}, pos = [];
  (movements || []).filter(m => m.date === today && (Number(m.qty) || 0) > 0).forEach(m => {
    const k = m.productId || normName(m.name);
    if (seen[k]) { seen[k].qty += Number(m.qty) || 0; return; }
    seen[k] = { id: m.productId, name: m.name, qty: Number(m.qty) || 0, loc: m.loc, ref: m.ref };
    pos.push(seen[k]);
  });
  return { low, pos };
}
function sysAlerts() {
  const out = [], now = Date.now();
  const isAdmin = currentRole() === 'admin';
  if(billingMode()) {
    const since=new Date();since.setDate(since.getDate()-1);
    const cutoff=since.getFullYear()+'-'+String(since.getMonth()+1).padStart(2,'0')+'-'+String(since.getDate()).padStart(2,'0');
    return sales.filter(s=>s.billingOnly && dayKey(s.date)>=cutoff && (isAdmin || String(s.operator||'').toLowerCase()===String(currentUser||'').toLowerCase())).map(s=>({id:'billing-'+s.id,kind:'Faturação',owner:s.operator,title:s.number+' — '+fmtMoney(s.total),text:(String(s.operator||'').toLowerCase()===String(currentUser||'').toLowerCase()?'Emitido por mim':'Emitido por '+userNameOf(s.operator))+' · '+(s.client||'Consumidor final'),ts:s.createdAt||new Date(s.date+'T12:00:00').getTime(),link:{view:'sales',sel:s.id,q:s.number}}));
  }
  // Situações de stock: um único aviso, com a lista completa (informação consolidada do administrador)
  if (isAdmin) {
    const lowList = stockSituations().low;
    if (lowList.length) out.push({
      id: 'low-' + lowList.map(s => normName(s.name)).join('|').slice(0, 200),
      kind: 'Stock baixo',
      title: lowList.length + ' produto(s) em stock mínimo / esgotado',
      text: lowList.slice(0, 10).map(s => s.name + ' (' + stockAvail(s) + ')').join(' · ')
        + (lowList.length > 10 ? ' · e mais ' + (lowList.length - 10) + ' produto(s)' : ''),
      items: lowList.map(s => ({ id: s.id, name: s.name, qty: null, loc: '' })),
      ts: now, link: { view: 'products', q: lowList[0].name, sel: lowList[0].id }
    });
  }
  if (isAdmin) suppliers.map(s => ({ s, d: supEffective(s.id) })).filter(x => x.d > 0)
    .forEach(x => out.push({ id: 'supdebt-' + x.s.id, kind: 'Por pagar', title: x.s.name,
      text: `Em dívida: ${MZN(x.d)} — abra para ver as faturas em falta`,
      ts: now, link: { view: 'pays', q: x.s.name } }));
  if (isAdmin) clients.map(c => ({ c, d: clientBalance(c.id) })).filter(x => x.d > 0)
    .forEach(x => out.push({ id: 'clidebt-' + x.c.id, kind: 'A receber', title: x.c.name,
      text: `Em dívida: ${MZN(x.d)} — abra para ver a conta corrente`,
      ts: now, link: { view: 'clients', q: x.c.name } }));
  const today = todayISO();
  // Todo o movimento com valores (venda, recebimento, pagamento, despesa/entrada de caixa)
  out.push(...movAlerts());
  // Notas de crédito / devoluções (documento com valores)
  ncs.slice(-60).forEach(nc => {
    const own = String(nc.operator || '').toLowerCase();
    if (!isAdmin && own !== String(currentUser || '').toLowerCase()) return;
    const sv = nc.saleId && sales.find(s => s.id === nc.saleId);
    out.push({
      id: 'nc-' + nc.id,
      kind: 'Nota de crédito',
      title: nc.number + ' — ' + MZN(nc.total),
      text: ['Devolução de ' + (nc.client || 'balcão'), sv ? 'venda ' + sv.number : '', (nc.items || []).length + ' item(ns)', nc.motive || ''].filter(Boolean).join(' · '),
      ts: Number(nc.ts) || new Date((nc.date || today) + 'T12:00:00').getTime(),
      link: { view: 'sales', q: sv ? sv.number : (nc.client || ''), sel: sv ? sv.id : null }
    });
  });
  const mine = sales.filter(s => (s.operator || '') === currentUser && s.date === today);
  if (mine.length && !isAdmin) out.push({ id: 'sys-mine-'+fbKey(currentUser)+'-'+today, kind: 'Vendas', title: 'As suas vendas de hoje: ' + mine.length,
    text: mine.slice(0, 5).map(s => s.number + ' (' + MZN(s.total) + ')').join(' · '), ts: now, link: { view: 'sales', q: '' } });
  // Fila de sincronização: só o administrador vê a operação de sincronização
  if (isAdmin && queue.length) out.push({ id: 'sync-pending', kind: 'Sincronização', title: queue.length + ' registo(s) por sincronizar',
    text: 'Os dados estão guardados neste computador. Abra Configurações → Segurança & PIN e toque em «Sincronizar agora».',
    ts: now, link: { view: 'settings', tab: 'sec' } });
  if (isAdmin && lastSyncError) out.push({ id: 'sync-error', kind: 'Erro de sincronização', title: 'A nuvem recusou dados',
    text: String(lastSyncError).slice(0, 240), ts: now, link: { view: 'settings', tab: 'sec' } });
  return out;
}
function notifIsRead(n) {
  /* Quem emitiu o documento não recebe o próprio aviso como novidade. */
  if (n && String(n.id || '').indexOf('billing-') === 0 && String(n.owner || '').toLowerCase() === String(currentUser || '').toLowerCase()) return true;
  return n.stored ? !notifUnread(n) : seenHas(n.id);
}
function openNotifLink(link) {
  if (!link || !link.view) return;
  goView(link.view);
  try {
    if (link.view === 'products' && link.q != null) {
      $('searchProd').value = link.q; prodLimit = 200; renderProducts();
      if (link.sel) {
        const tr = document.querySelector('#prodTable tbody tr[data-pid="' + link.sel + '"]');
        if (tr) { tr.classList.add('active'); tr.scrollIntoView({ block: 'nearest' }); }
      }
    } else if (link.view === 'pays' && link.q != null) {
      $('searchPaySup').value = link.q; renderPays();
      /* Pagamento/fatura de compra: abrir diretamente a fatura que originou o movimento. */
      if (link.invId) { try { openInvView(link.invId); } catch (_) {} }
    } else if (link.view === 'clients' && link.q != null) {
      $('searchCli').value = link.q; renderCli();
    } else if (link.view === 'sales') {
      if (link.q != null) $('searchSale').value = link.q;
      renderSales();
      /* Documento de venda/recebimento: abrir diretamente o documento que originou o movimento. */
      if (link.sel) { try { openSaleDetail(link.sel); } catch (_) {} }
    } else if (link.view === 'settings' && link.tab) {
      const b = document.querySelector('.set-tabs [data-set="' + link.tab + '"]');
      if (b) b.click();
    }
  } catch (_) {}
}
function dismissNotif(n) {
  if (n && n.stored) {
    // n pode ser uma cópia (cartão) — marca a original para ficar gravada como lida
    const o = notifs.find(x => x.id === n.id);
    if (o && notifUnread(o)) { o.readBy = [...(o.readBy || []), currentUser]; n.readBy = o.readBy; persist(); }
  } else if (n && !seenHas(n.id)) {
    seenAdd(n.id);
  }
  updateNotifBadge();
}
/* ---------- apagar notificações (administrador) ---------- */
function notifGone(id) { return !!id && (notifDeleted.includes(id) || notifUserHas('deleted',id)); }
function notifTombstone(id) {
  if (!id || notifGone(id)) return;
  notifDeleted.push(id);
  save('dec_notif_del', notifDeleted);
}
/* Apaga na nuvem (ou deixa na fila, se estiver offline) */
function notifCloudDelete(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  const ops = list.map(id => ({ type: 'delete-notif', payload: { id } }));
  try {
    const U = cloudDataUid();
    if (U && rdb && isOnline()) {
      const patch = {}; list.forEach(id => { patch[id] = null; });
      rdb.ref('users/' + U + '/notifs').update(patch).catch(() => pushQueueBulk(ops));
    } else pushQueueBulk(ops);
  } catch (_) { try { pushQueueBulk(ops); } catch (__) {} }
}
function deleteNotif(n) {
  if (!n) return;
  if(!removeNotifForUser(n)) return;
  persist(); closeInfo(); updateNotifBadge();
  if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
  toast('Notificação apagada.', 'success');
}
function removeNotifForUser(n) {
  if(currentRole()!=='admin') {
    const allowed=n.stored ? notifs.some(item=>item.id===n.id && notifForMe(item)) : sysAlerts().some(item=>item.id===n.id);
    if(!allowed) return false;
    saveNotifUserState('deleted',n.id);
  } else {
    notifTombstone(n.id);
    if(n.stored) {notifs=notifs.filter(item=>item.id!==n.id);notifCloudDelete([n.id]);}
  }
  return true;
}
/* «Apagar lidas»: limpa o inbox de uma vez (armazenadas + avisos do sistema) */
function clearReadNotifs() {
  const me = String(currentUser || '').toLowerCase();
  const storedRead = notifs.filter(n => notifForMe(n) && (n.readBy || []).some(e => String(e).toLowerCase() === me));
  const systemRead = sysAlerts().filter(a => seenHas(a.id) && !notifGone(a.id));
  const list=[...storedRead.map(n=>({...n,stored:true})),...systemRead];
  if(!list.length) return toast('Não há notificações lidas para apagar.','info');
  list.forEach(removeNotifForUser);
  persist(); updateNotifBadge();
  if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
  toast(list.length + ' notificação(ões) apagada(s).', 'success');
}
function notifTotal() {
  const stored = notifs.filter(notifForMe).filter(notifUnread).length;
  const sys = sysAlerts().filter(a => !notifGone(a.id) && !notifIsRead(a)).length;
  return stored + sys;
}
function updateNotifBadge() {
  const b = $('notifBadge'); if (!b) return;
  const n = notifTotal();
  b.style.display = n > 0 ? '' : 'none';
  b.textContent = n > 9 ? '9+' : String(n);
  const nc = $('notifCount'); if (nc) nc.textContent = n ? '(' + n + ')' : '';
}
function renderNotifs() {
  if ($('notifAdminPanel')) $('notifAdminPanel').style.display = 'none';
  const box = $('notifList'); if (!box) return;
  box.innerHTML = '';
  const stored = notifs.filter(notifForMe).map(n => ({ ...n, stored: true }));
  const all = [...stored, ...sysAlerts()].filter(n => !notifGone(n.id)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const unreadCount=all.filter(n=>!notifIsRead(n)).length;
  if($('notifTotalCount')) $('notifTotalCount').textContent=all.length;
  if($('notifUnreadCount')) $('notifUnreadCount').textContent=unreadCount;
  if($('notifReadCount')) $('notifReadCount').textContent=all.length-unreadCount;
  const query=String($('notifSearch')?.value||'').trim().toLowerCase(),filter=$('notifFilter')?.value||'all';
  const visible=all.filter(n=>(!query || [n.title,n.text,n.kind,n.from].filter(Boolean).join(' ').toLowerCase().includes(query)) && (filter==='all'||(filter==='read'?notifIsRead(n):!notifIsRead(n))));
  if(!visible.length) box.innerHTML='<div class="panel notif-empty"><span aria-hidden="true">🔔</span><h3>'+(all.length?'Nenhum resultado':'Sem notificações')+'</h3><p class="hint">'+(all.length?'Altere a pesquisa ou o filtro para encontrar uma notificação.':'Tudo em dia. Os novos avisos aparecerão aqui.')+'</p></div>';
  const unread = visible.filter(n => !notifIsRead(n));
  const read = visible.filter(n => notifIsRead(n));
  const section = (label, arr, isUnread) => {
    if (!arr.length) return;
    const h = document.createElement('h4');
    h.className = 'notif-sec';
    h.textContent = label + ' (' + arr.length + ')';
    box.appendChild(h);
    arr.forEach(n => box.appendChild(notifCard(n, isUnread)));
  };
  section('Não lidas', unread, true);
  section('Lidas', read, false);
  updateNotifBadge();
}
if($('notifSearch')) $('notifSearch').oninput=renderNotifs;
if($('notifFilter')) $('notifFilter').onchange=renderNotifs;
/* Itens da notificação (a nuvem devolve listas como objeto) */
function notifItems(n) {
  const it = n && n.items;
  if (Array.isArray(it)) return it;
  if (it && typeof it === 'object') return Object.values(it);
  return [];
}
function notifLinkLabel(link) {
  if (!link || !link.view) return '';
  if (link.view === 'products') return 'Ver produto';
  if (link.view === 'sales') return billingMode() ? 'Ver faturação' : 'Ver venda';
  if (link.view === 'pays') return 'Ver pagamento';
  if (link.view === 'clients') return 'Ver conta';
  if (link.view === 'settings') return 'Ver configurações';
  return 'Ver registo';
}
/* Clique na notificação = abrir a mensagem (e fica marcada como lida). Sem botões no cartão. */
function notifCard(n, isUnread) {
  const d = document.createElement('div');
  d.className = 'panel notif-card notif-click' + (isUnread ? ' notif-unread' : ' notif-read');
  d.tabIndex=0;d.setAttribute('role','button');
  d.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();d.click();}};
  if (!isUnread) d.classList.add('notif-done');
  const items = notifItems(n);
  d.innerHTML = `<div class="panel-head"><h3><span class="notif-kind">${esc(n.kind || 'Aviso')}</span>`
    + `${isUnread ? ' <span class="notif-new">NOVA</span>' : ''}`
    + ` <span class="notif-title">${esc(n.title || '')}</span></h3>`
    + `<span class="hint notif-when">${esc(fmtDateTime(n.ts))}</span></div>`
    + `<p>${esc(n.text || '')}</p>`
    + (items.length > 1 ? `<p class="hint">${items.length} produto(s) — clique para ver a lista completa</p>` : '')
    + (n.from ? `<p class="hint">De: ${esc(userNameOf(n.from))}</p>` : '');
  d.title = 'Clique para abrir';
  d.onclick = () => {
    dismissNotif(n);
    if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
    openNotif(n);
  };
  return d;
}
/* Mensagem completa: dados, produtos com ficha e ações */
function openNotif(n) {
  if (!n) return;
  if(currentRole()!=='admin' && !(n.stored ? notifs.some(item=>item.id===n.id && notifForMe(item)) : sysAlerts().some(item=>item.id===n.id))) return;
  const isAdmin = currentRole() === 'admin';
  const items = notifItems(n);
  const L = [];
  const line = (k, v) => { if (v !== '' && v != null) L.push('<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>'); };
  line('Tipo', n.kind || 'Aviso');
  line('Assunto', n.title || '');
  line('Data', fmtDateTime(n.ts));
  if (n.from) line('De', userNameOf(n.from) + (String(n.from).indexOf('@') !== -1 ? '   ' + n.from : ''));
  if (n.to === 'admin') line('Para', 'Administrador');
  if (n.queueLen != null) line('Registos por carregar', String(n.queueLen));
  let html = '<div class="det-items"><table>' + L.join('') + '</table></div>';
  if (n.text) html += '<p style="margin:10px 0 0">' + esc(n.text) + '</p>';
  if (items.length) {
    html += '<h4 style="margin:14px 0 6px">Produtos (' + items.length + ')</h4>'
      + '<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Loja</th><th>Armazém</th><th>Mínimo</th><th>Pedido</th><th class="col-act">Ação</th></tr></thead><tbody>'
      + items.map(it => {
        const s = stock.find(x => x.id === it.id) || findStock(it.name) || null;
        return '<tr><td>' + esc(it.name) + '</td>'
          + '<td style="text-align:right">' + (s ? (Number(s.qLoja) || 0) : '—') + '</td>'
          + '<td style="text-align:right">' + (s ? (Number(s.qArm) || 0) : '—') + '</td>'
          + '<td style="text-align:right">' + (s ? (Number(s.min) || 0) : '—') + '</td>'
          + '<td style="text-align:right">' + (it.qty == null ? '—' : it.qty) + '</td>'
          + '<td class="col-act">' + (s ? '<button type="button" class="btn small vp" data-pid="' + s.id + '">Ver produto</button>' : '<span class="hint">sem ficha</span>') + '</td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }
  const acts = [];
  let noteRow = '';
  if (!isAdmin && (items.length || n.kind === 'Stock' || n.kind === 'Stock baixo')) {
    noteRow = '<div class="nf-note-row"><input id="nfNote" class="nf-note" placeholder="Nota para o administrador (opcional)…" /></div>';
    acts.push('<button type="button" class="btn small danger" id="nfRep">Reportar ao administrador</button>');
  }
  if (isAdmin && n.reportKind === 'sync' && n.from)
    acts.push('<button type="button" class="btn small" id="nfSync">Sincronizar por ele</button>');
  acts.push('<button type="button" class="btn small danger" id="nfDel">Apagar notificação</button>');
  // Produtos citados: abre a lista com TODOS (não só o primeiro)
  const citeIds = [];
  items.forEach(it => {
    const s = stock.find(x => x.id === it.id) || findStock(it.name) || null;
    if (s && citeIds.indexOf(s.id) === -1) citeIds.push(s.id);
  });
  // notificações antigas (sem lista guardada): os nomes vêm no próprio texto
  if (!citeIds.length && n.text && n.text.indexOf('(tem ') !== -1) {
    n.text.split('·').forEach(seg => {
      const nm = String(seg).split('(tem ')[0].trim();
      if (!nm) return;
      const s = findStock(nm);
      if (s && citeIds.indexOf(s.id) === -1) citeIds.push(s.id);
    });
  }
  if (citeIds.length) acts.push('<button type="button" class="btn small" id="nfAll">Ver ' + (citeIds.length === 1 ? 'produto' : 'os ' + citeIds.length + ' produtos') + '</button>');
  else if (n.link) acts.push('<button type="button" class="btn small ghost" id="nfGo">' + notifLinkLabel(n.link) + '</button>');
  if (acts.length) html += noteRow + '<div class="modal-actions" style="justify-content:flex-start;margin-top:12px">' + acts.join(' ') + '</div>';
  openInfo('Notificação — ' + (n.kind || 'Aviso'), html);
  $('infoModal').classList.add('notification-modal');
  const body = $('infoBody'); if (!body) return;
  body.querySelectorAll('.vp').forEach(b => { b.onclick = (e) => { e.stopPropagation(); closeInfo(); openProductDetail(b.dataset.pid); }; });
  const rep = body.querySelector('#nfRep');
  if (rep) rep.onclick = (e) => {
    e.stopPropagation();
    const noteEl = body.querySelector('#nfNote');
    const note = noteEl && noteEl.value ? String(noteEl.value).trim() : '';
    reportToAdmin('Reporte do operador', n.title || 'Situação de stock',
      (n.text || '') + (note ? ' · Nota: ' + note : ''), items, { reportKind: n.reportKind || 'stock' });
    rep.disabled = true; rep.textContent = 'Reportado ✓';
    if (noteEl) noteEl.disabled = true;
  };
  const syn = body.querySelector('#nfSync');
  if(syn) syn.onclick=async e=>{e.stopPropagation();syn.disabled=true;syn.textContent='A enviar…';try{await requestSyncFor(n.from);syn.textContent='A aguardar operador online';}catch(error){syn.disabled=false;syn.textContent='Tentar novamente';toast(error.message,'error');}};
  const del = body.querySelector('#nfDel');
  if (del) del.onclick = (e) => { e.stopPropagation(); deleteNotif(n); };
  const all = body.querySelector('#nfAll');
  if (all) all.onclick = (e) => { e.stopPropagation(); closeInfo(); openCitedProducts(citeIds); };
  const go = body.querySelector('#nfGo');
  if (go) go.onclick = (e) => { e.stopPropagation(); closeInfo(); openNotifLink(n.link); };
}
if ($('btnReadNotifs')) $('btnReadNotifs').onclick = () => {
  notifs.filter(notifForMe).forEach(n => { if (notifUnread(n)) n.readBy = [...(n.readBy || []), currentUser]; });
  sysAlerts().forEach(a => seenAdd(a.id));
  persist(); renderNotifs(); updateNotifBadge(); toast('Notificações marcadas como lidas.', 'success');
};
if ($('btnClearReadNotifs')) $('btnClearReadNotifs').onclick = () => clearReadNotifs();
/* ---------- operador → administrador (reportar) / administrador → operador (sincronizar por ele) ---------- */
/* O reporte sobe sozinho para as notificações do administrador; os dados pendentes do operador
   só sobem quando o administrador manda sincronizar (o operador não vê a sincronização). */
function reportToAdmin(kind, title, text, items, extra) {
  const n = {
    id: 'rep-' + uid(), kind: kind || 'Reporte', title: title || 'Reporte do operador',
    text: text || '', to: 'admin', from: currentUser, readBy: [], ts: Date.now(),
    createdAt: Date.now(), updatedAt: Date.now(),
    items: items || [], reportKind: (extra && extra.reportKind) || 'stock'
  };
  if(extra?.link)n.link=extra.link;if(extra?.document)n.document=extra.document;
  if (extra && extra.queueLen != null) n.queueLen = extra.queueLen;
  notifs.push(n); persist(); updateNotifBadge();
  if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
  // sobe apenas o reporte (não envia o resto dos dados locais)
  try {
    const U = cloudDataUid();
    if (U && rdb && isOnline()) rdb.ref('users/' + U + '/notifs/' + n.id).set({ ...n }).catch(() => { pushQueue({ type: 'notif', payload: { ...n } }); });
    else pushQueue({ type: 'notif', payload: { ...n } });
  } catch (_) { try { pushQueue({ type: 'notif', payload: { ...n } }); } catch (__) {} }
  if (!(extra && extra.silent)) toast('Reportado ao administrador.', 'success');
  return n;
}
/* Reporte rápido: tocar em «CRÍTICO» (stock/produtos) ou no aviso de venda
   bloqueada envia ao administrador a situação exata daquele produto. */
function productSituationText(s) {
  const tot = stockAvail(s), min = Number(s.min) || 0;
  return 'Loja: ' + (Number(s.qLoja) || 0)
    + ' · Armazém: ' + (Number(s.qArm) || 0)
    + ' · Disponível: ' + tot
    + ' · Mínimo: ' + min
    + (tot <= 0 ? ' · ESGOTADO' : (min > 0 && tot <= min ? ' · EM STOCK CRÍTICO' : ''));
}
function reportProductSituation(pid, note) {
  const s = stock.find(x => x.id === pid) || findStock(pid);
  if (!s) return toast('Produto não encontrado.', 'warning');
  if (currentRole() === 'admin') return openProductDetail(s.id);
  const text = productSituationText(s) + (note ? ' · Nota: ' + note : '');
  reportToAdmin('Situação de stock', 'Produto em situação crítica: ' + s.name, text,
    [{ id: s.id, name: s.name, qty: null, loc: '' }], { reportKind: 'stock' });
  toast('Situação de ' + shortName(s.name) + ' reportada ao administrador.', 'success');
}
function reportStockBlockToAdmin(falta, kind) {
  if (currentRole() === 'admin') return;
  const items = (falta || []).map(p => {
    const s = findStock(p.desc);
    return { id: s ? s.id : '', name: (s && s.name) || p.desc, qty: p.qty, loc: '' };
  });
  const text = 'É necessário requisitar/encomendar mercadoria ao fornecedor (Ordem de Compra) ou registar entrada de stock antes de autorizar a venda. '
    + (falta || []).map(p => {
      const s = findStock(p.desc);
      return p.desc + ' (pede ' + p.qty + (s ? ' · ' + productSituationText(s) : '') + ')';
    }).join(' · ');
  reportToAdmin('Reposição de stock', 'Reposição necessária — ' + kind + ' bloqueada', text, items, { reportKind: 'stock' });
  toast('Reposição reportada ao administrador.', 'success');
}
/* Administrador pede os dados deste operador (ele carrega sem ver nada) */
async function requestSyncFor(email) {
 if(currentRole()!=='admin') return;
 if(!isOnline() || !rdb || !cloudDataUid()) throw new Error('Sem ligação à nuvem');
 const e=String(email||'').trim().toLowerCase();if(!e) throw new Error('Operador inválido');
 const command={id:'sync-'+uid(),kind:'Sincronização',title:'Sincronização solicitada',text:'O administrador solicitou o envio dos dados pendentes.',to:e,from:currentUser,readBy:[],syncCommand:true,ts:Date.now(),createdAt:Date.now(),updatedAt:Date.now()};
 await cloudRef('notifs/'+command.id).set(command);
 toast('Pedido enviado. O operador precisa de estar online.','success');
}
/* Operador com dados por enviar avisa o administrador (no máximo 1 vez a cada 30 minutos) */
function maybeSyncReport() {
  try {
    if (currentRole() === 'admin') return;
    if (!queue.some(op=>!['notif','syncreq','delete-syncreq'].includes(op.type)) || !isOnline()) return;
    if(notifs.some(n=>n.from===currentUser && n.reportKind==='sync' && !notifDeleted.includes(n.id))) return;
    const last = Number(load('dec_syncrep', 0));
    if (Date.now() - last < 30 * 60 * 1000) return;
    save('dec_syncrep', Date.now());
    reportToAdmin('Sincronização', 'Preciso de carregar os meus dados',
      userNameOf(currentUser) + ' tem ' + queue.length + ' registo(s) por enviar para a nuvem.',
      [], { reportKind: 'sync', queueLen: queue.length, silent: true });
  } catch (_) {}
}
/* Verifica se o administrador pediu para sincronizar por este operador */
async function checkSyncRequest(cloud) {
  try {
    const command=Object.values(cloud?.notifs||{}).filter(n=>n.syncCommand && String(n.to).toLowerCase()===String(currentUser).toLowerCase()).sort((a,b)=>b.ts-a.ts)[0];
    const mine=command?{at:command.ts}:((cloud && cloud.syncreq)?cloud.syncreq[fbKey(currentUser)]:null);
    if (!mine || Number(mine.at) <= Number(load('dec_syncreq', 0))) return;
    await syncNow(true);
    if(queue.length || isSyncing) return;
    save('dec_syncreq',Number(mine.at));save('dec_syncrep',Date.now());
    if(command){reportToAdmin('Sincronização','Sincronização concluída','Os dados pendentes foram enviados para a nuvem.',[],{reportKind:'sync-done',silent:true});}
    else pushQueue({type:'delete-syncreq',payload:{email:currentUser}});            // carrega os dados do operador na nuvem, sem ele ver
  } catch (_) {}
}
$('btnSetPin').onclick = () => {
  const a = $('pinNew').value.trim(), b = $('pinConf').value.trim();
  if (typeof bcrypt === 'undefined') return toast('Biblioteca de segurança não carregada. Feche e reabra a app.', 'error');
  if (!/^\d{4,6}$/.test(a)) return toast('PIN: 4–6 dígitos numéricos.', 'warning');
  if (a !== b) return toast('Confirmação não coincide.', 'error');
  try { save(LS.pin, bcrypt.hashSync(a, 10)); }
  catch (e) { return toast('Falha ao guardar o PIN. Tente de novo.', 'error'); }
  $('pinNew').value = $('pinConf').value = '';
  renderPinStatus();
  toast('PIN guardado localmente (bcrypt).', 'success');
};

/* ---------- navigation ---------- */
function goView(v) {
  guardSaleDraft(() => goViewNow(v, true));
}
function goViewNow(v, direct) {
  const role = currentRole();
  if(v==='issued' && role!=='admin') {toast('Acesso restrito ao Administrador.','error');return;}
  // Bloqueio funcional (além do CSS): caixa não abre áreas administrativas
  if (role !== 'admin' && (v === 'suppliers' || (v === 'pays' && !billingMode()))) {
    toast('Acesso restrito ao Administrador.', 'error');
    return;
  }
  if (v !== 'sales' && calcOpen) calcHideOnly();
  document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  closeSugg();
  if ($('stockPop')) $('stockPop').style.display = 'none';
  ['dashboard', 'sales', 'clients', 'suppliers', 'pays', 'products', 'settings', 'notifs', 'issued'].forEach(x => $('view-' + x).style.display = x === v ? 'block' : 'none');
  if (v === 'sales') {
    // Rascunho único: clique no menu entra direto onde parou (sem lista);
    // F2/F3/F4 mantêm o fluxo de escolha de tipo
    if (calcOpen && !calcOpening) calcHideOnly();
    const ownDraft=drafts.find(draftForMe);
    if (direct && ownDraft && (draftFresh || !saleDirty())) {
      try { resumeDraft(ownDraft.id,{silent:true}); }
      catch (e) { console.warn('resume falhou', e); showSaleChoice(); }
    }
    else showSaleChoice();
  }
  if (v === 'suppliers') { currentSup = null; $('supplierDetail').style.display = 'none'; $('supList').style.display = 'block'; renderSup(); }
  if (v === 'clients') { currentCli = null; $('cliDetail').style.display = 'none'; $('cliList').style.display = 'block'; renderCli(); }
  if (v === 'cash') renderCash();
  if (v === 'pays') setPayTab(payTab);
  if (billingMode() || v==='issued') applyBillingMode();
  if (v === 'notifs') renderNotifs();
  if (v === 'settings') { const b = document.querySelector('[data-set].active') || document.querySelector('[data-set]'); if (b) b.click(); }
}
function showSaleChoice() {
  document.body.classList.remove('sale-form-open');
  if (calcOpen && !calcOpening) calcHideOnly();
  if ($('saleChoiceWrap')) $('saleChoiceWrap').style.display = 'block';
  if ($('saleFormPanel')) $('saleFormPanel').style.display = 'none';
  if ($('saleItemsPanel')) $('saleItemsPanel').style.display = 'none';
  if ($('saleBar')) $('saleBar').style.display = 'none';
  if ($('saleListPanel')) $('saleListPanel').style.display = 'block';
  if ($('saleNcPanel')) $('saleNcPanel').style.display = 'block';
  try { renderSales(); } catch (_) {}
  try { renderNc(); } catch (_) {}
  document.querySelectorAll('#saleTypeCards .type-card').forEach(c => c.classList.remove('active'));
}
document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => goView(b.dataset.view));

/* ---------- dashboard ---------- */
/* Painel do administrador: situações de stock, organizado e conciso */
let dashRecentRows = [];   // linhas visíveis de «Últimos movimentos» (Excel/PDF)
/* Balls no card «Stock» do Painel Geral: vermelha = stock esgotado/baixo · branca (+N) = entradas de hoje */
function renderStockBadges() {
  const st = stockSituations();
  const low = st.low;
  const red = $('stockBadgeLow'), white = $('stockBadgeAdd');
  if (red) {
    red.style.display = low.length ? '' : 'none';
    red.textContent = low.length > 99 ? '99+' : String(low.length);
    red.title = low.length + ' produto(s) em stock mínimo / esgotado';
  }
  if (white) {
    white.style.display = st.pos.length ? '' : 'none';
    white.textContent = '+' + (st.pos.length > 99 ? '99+' : st.pos.length);
    white.title = st.pos.length + ' produto(s) adicionados ao stock hoje';
  }
}
/* ---------- Painel «Ao vivo» do administrador ---------- */
let liveSig = '';
let livePrintAuto = '';
function liveSignature() {
  const last = (a) => a.length ? String(a[a.length - 1].id || a[a.length - 1].ts || a.length) : '';
  return [todayISO(), sales.length, last(sales), ncs.length, last(ncs), movements.length, last(movements),
    stockLosses.length, stock.map(s => (Number(s.qLoja) || 0) + '/' + (Number(s.qArm) || 0) + '/' + (Number(s.min) || 0)).join(',')].join('|');
}
/* Produto de um movimento (por id ou nome) e valor ao preço de venda. */
function moveProduct(m) {
  if (!m) return null;
  if (m.productId) { const byId = stock.find(x => x.id === m.productId); if (byId) return byId; }
  const nm = String(m.name || '').trim().toUpperCase();
  return nm ? stock.find(x => String(x.name || '').trim().toUpperCase() === nm) || null : null;
}
function moveUnitPrice(m) {
  if (m && m.price != null && Number(m.price) > 0) return Number(m.price);
  const s = moveProduct(m);
  return s ? (Number(s.price) || 0) : 0;
}
function moveValue(m) {
  if (!m) return 0;
  if (m.total != null) return Number(m.total) || 0;
  if (m.value != null) return Number(m.value) || 0;
  return Math.abs(Number(m.qty) || 0) * moveUnitPrice(m);
}
function liveAgo(ts) {
  const t = Number(ts) || 0; if (!t) return '';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'agora';
  if (mins < 60) return 'há ' + mins + ' min';
  const hs = Math.floor(mins / 60);
  if (hs < 24) return 'há ' + hs + ' h';
  const ds = Math.floor(hs / 24);
  if (ds === 1) return 'ontem';
  if (ds < 7) return 'há ' + ds + ' dias';
  const d = new Date(t);
  return fmtDate(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
}
function liveAlertRows() {
  const lastBy = {};
  movements.forEach(m => {
    const k = m.productId || String(m.name || '').trim().toUpperCase();
    if (!k) return;
    const ts = Number(m.ts) || 0;
    if (!lastBy[k] || ts > (Number(lastBy[k].ts) || 0)) lastBy[k] = m;
  });
  return stock.filter(s => { const t = stockTotal(s); return t <= 0 || (Number(s.min) > 0 && t <= Number(s.min)); })
    .map(s => {
      const t = stockTotal(s), min = Number(s.min) || 0;
      const last = lastBy[s.id] || lastBy[String(s.name || '').trim().toUpperCase()] || null;
      return { s, t, min, out: t <= 0, last, recentTs: Number(last && last.ts) || 0 };
    })
    .sort((a, b) => {
      /* 0 = alerta fresco (movimento nos últimos 7 dias), 1 = mínimo configurado, 2 = restantes.
         Assim a lista mostra primeiro o que acabou de ficar em falta. */
      const group = (x) => (x.recentTs && Date.now() - x.recentTs < 7 * 864e5) ? 0 : (x.min > 0 ? 1 : 2);
      const ga = group(a), gb = group(b);
      if (ga !== gb) return ga - gb;
      if (b.recentTs !== a.recentTs) return b.recentTs - a.recentTs;
      return a.t - b.t || String(a.s.name || '').localeCompare(String(b.s.name || ''));
    });
}
function renderLive(force) {
  if(billingMode() || document.hidden) return;
  const panel = $('livePanel'); if (!panel) return;
  const isAdmin = currentRole() === 'admin';
  panel.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;
  if ($('liveClock')) $('liveClock').textContent = 'Atualizado às ' + fmtTime(Date.now()) + ' · ' + fmtDate(todayISO());
  const printDay = $('livePrintDate');
  if (printDay && (!printDay.value || printDay.value === livePrintAuto)) { livePrintAuto = todayISO(); printDay.value = livePrintAuto; }
  const sig = liveSignature();
  if (!force && sig === liveSig) return;
  liveSig = sig;
  const day = todayISO();
  const rows = revenueRows(day).sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  const total = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const units = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const cost = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const cashIn = cashMoves.filter(m => m.type === 'entrada' && dayKey(m.day || m.date) === day)
    .reduce((a, m) => a + (Number(m.amount) || 0), 0);
  const dayMoves = movements.filter(m => dayKey(m.date) === day)
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const drop = dayMoves.filter(m => Number(m.qty) < 0 && !/transfer|gti/i.test(String(m.reason || '') + ' ' + String(m.ref || '')))
    .reduce((a, m) => a + Math.abs(Number(m.qty) || 0), 0);
  const directExits = dayMoves.filter(m => Number(m.qty) < 0 && m.reasonKey);
  const exitValue = directExits.reduce((a, m) => a + moveValue(m), 0);
  const alertRows = liveAlertRows();
  const low = alertRows.map(a => a.s);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('liveCashIn', MZN(cashIn));
  set('liveSales', MZN(total));
  set('liveProfit', MZN(total - cost));
  set('liveUnits', String(units) + ' un.');
  set('liveDrops', String(drop) + ' un.');
  set('liveDropsVal', directExits.length ? MZN(exitValue) + ' em ' + directExits.length + ' saída(s) direta(s)' : 'Sem saídas diretas hoje');
  set('liveAlertsN', String(low.length));
  // Faturação por produto (hoje)
  const pt = $('liveProdTable') ? $('liveProdTable').querySelector('tbody') : null;
  if (pt) {
    pt.innerHTML = '';
    if (!rows.length) pt.innerHTML = '<tr><td colspan="4" class="hint">Sem vendas registadas hoje.</td></tr>';
    rows.slice(0, 8).forEach(r => {
      const profit = (Number(r.total) || 0) - (Number(r.cost) || 0);
      const tr = document.createElement('tr');
      tr.innerHTML = '<td title="' + esc(r.name) + '"><strong>' + esc(r.name) + '</strong><br><small class="muted">' + esc(r.sku || '—') + '</small></td>'
        + '<td style="text-align:right">' + esc(String(r.qty)) + '</td>'
        + '<td style="text-align:right"><strong>' + MZN(r.total) + '</strong></td>'
        + '<td style="text-align:right">' + MZN(profit) + '</td>';
      tr.style.cursor = 'pointer'; tr.title = 'Abrir ficha do produto';
      tr.onclick = () => {
        const s = stock.find(x => rendKey(x.name) === rendKey(r.name));
        if (s) openProductDetail(s.id);
      };
      pt.appendChild(tr);
    });
  }
  // Movimentos de stock — sempre do dia (semanal/mensal virá depois)
  const mt = $('liveMoveTable') ? $('liveMoveTable').querySelector('tbody') : null;
  if (mt) {
    mt.innerHTML = '';
    const list = dayMoves.slice(0, 12);
    if (!list.length) mt.innerHTML = '<tr><td colspan="5" class="hint">Sem movimentos de stock hoje.</td></tr>';
    list.forEach(m => {
      const q = Number(m.qty) || 0;
      const isIn = m.type === 'entrada' || q > 0;
      const kind = isIn ? 'Entrada' : (m.reasonKey ? 'Saída direta' : 'Saída');
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(m.ts ? fmtTime(m.ts) : fmtDate(m.date)) + '</td>'
        + '<td title="' + esc(m.name || '') + '"><strong>' + esc(m.name || '—') + '</strong></td>'
        + '<td>' + esc(kind) + '</td>'
        + '<td style="text-align:right" class="' + (isIn ? 'pos' : 'neg') + '">' + (isIn ? '+' : '−') + Math.abs(q) + '</td>'
        + '<td style="text-align:right">' + esc(String(m.after != null ? m.after : '—')) + '</td>';
      tr.style.cursor = 'pointer'; tr.title = 'Abrir ficha do produto';
      tr.onclick = () => {
        const s = (m.productId && stock.find(x => x.id === m.productId))
          || stock.find(x => rendKey(x.name) === rendKey(m.name));
        if (s) openProductDetail(s.id);
      };
      mt.appendChild(tr);
    });
  }
  // Entradas de caixa (dinheiro que entrou hoje)
  const ct = $('liveCashTable') ? $('liveCashTable').querySelector('tbody') : null;
  if (ct) {
    ct.innerHTML = '';
    const cashToday = cashMoves.filter(m => m.type === 'entrada' && dayKey(m.day || m.date) === day)
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, 8);
    if (!cashToday.length) ct.innerHTML = '<tr><td colspan="3" class="hint">Sem entradas de caixa hoje.</td></tr>';
    cashToday.forEach(m => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(m.time || (m.ts ? fmtTime(m.ts) : '—')) + '</td>'
        + '<td><strong>' + esc(m.category || 'Entrada') + '</strong><br><small class="muted">'
        + esc([m.ref, m.method].filter(Boolean).join(' · ')) + '</small></td>'
        + '<td style="text-align:right"><strong>' + MZN(m.amount) + '</strong></td>';
      tr.style.cursor = 'pointer'; tr.title = 'Abrir os movimentos do dia';
      tr.onclick = () => openMovesPeriod('dia', day);
      ct.appendChild(tr);
    });
  }
  // Alertas de stock — sempre os mais recentes primeiro
  const al = $('liveAlerts');
  if (al) {
    al.innerHTML = '';
    if (!alertRows.length) al.innerHTML = '<span class="hint">Sem alertas — stock saudável.</span>';
    alertRows.slice(0, 8).forEach(a => {
      const s = a.s, t = a.t, out = a.out;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'live-chip ' + (out ? 'bad' : 'warn');
      const when = a.last ? liveAgo(a.last.ts || a.last.date) : '';
      chip.innerHTML = '<span>' + (out ? '⛔ ' : '⚠ ') + esc(shortName(s.name)) + ' — '
        + (out ? 'esgotado' : t + ' / mín. ' + a.min) + '</span>'
        + (when ? '<small>' + esc(when) + '</small>' : '');
      chip.title = s.name + ' · Loja: ' + (Number(s.qLoja) || 0) + ' · Armazém: ' + (Number(s.qArm) || 0)
        + (a.last ? ' · Último movimento: ' + fmtDate(a.last.date) + (a.last.ts ? ' ' + fmtTime(a.last.ts) : '') : '');
      chip.onclick = () => openProductDetail(s.id);
      al.appendChild(chip);
    });
    const note = $('liveAlertsNote');
    if (note) {
      note.textContent = !alertRows.length ? ''
        : alertRows.length > 8
          ? 'A mostrar os 8 alertas prioritários de ' + alertRows.length + ' — primeiro os que tiveram movimento recente e os que têm stock mínimo definido. A lista completa abre em «Ver os ' + alertRows.length + ' em alerta →».'
          : alertRows.length + ' produto(s) em alerta — todos visíveis acima.';
    }
    const allB = $('btnLiveAllAlerts');
    if (allB) {
      allB.style.display = '';
      allB.textContent = low.length ? 'Ver os ' + low.length + ' em alerta →' : 'Abrir stock →';
      allB.title = 'Abrir a lista completa de produtos em alerta';
      allB.onclick = () => {
        openStock();
        if ($('filterStock')) { $('filterStock').value = 'alerta'; renderStock(); }
      };
    }
  }
}
function openRendDay(day) {
  goViewNow('pays');
  setPayTab('rend');
  if ($('rendDate')) { $('rendDate').value = day || todayISO(); renderRend(); }
}
function openMovesPeriod(period, date) {
  goViewNow('pays');
  setPayTab('mov');
  payPeriod = period || 'dia';
  document.querySelectorAll('#payPeriodTabs button').forEach(b => b.classList.toggle('active', b.dataset.pp === payPeriod));
  if ($('payPeriodDate')) $('payPeriodDate').value = date || todayISO();
  if ($('searchPayMoves')) $('searchPayMoves').value = '';
  payMovesFilter = 'todos';
  document.querySelectorAll('#payMovesTabs button').forEach(b => b.classList.toggle('active', b.dataset.pf === 'todos'));
  document.querySelectorAll('#payKpis .kpi').forEach(c => c.classList.remove('active'));
  renderPayMoves();
}
function openKardexNow() {
  goViewNow('products');
  prodTab('tabProdMoves');
  if ($('kardexProd')) $('kardexProd').value = '';
  renderKardex();
}
function openStockAlerts() {
  openStock();
  if ($('filterStock')) { $('filterStock').value = 'alerta'; renderStock(); }
}
function liveGo(where) {
  if (where === 'cash' || where === 'moves') return openMovesPeriod('dia', todayISO());
  if (where === 'rend') return openRendDay(todayISO());
  if (where === 'kardex') return openKardexNow();
  if (where === 'alerts') return openStockAlerts();
}
if ($('livePanel')) {
  $('livePanel').addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-live-go]') : null;
    if (el && $('livePanel').contains(el)) liveGo(el.dataset.liveGo);
  });
  $('livePanel').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest ? e.target.closest('.live-kpi[data-live-go]') : null;
    if (!el) return;
    e.preventDefault();
    liveGo(el.dataset.liveGo);
  });
}
/* ---------- documento diário (impressão limpa, preto e branco) ---------- */
function dailySalesRows(day) {
  return revenueRows(day).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
function moveKind(m) {
  if (m.type === 'entrada') return 'Entrada';
  if (m.type === 'transferencia') return 'Transferência';
  if (m.reasonKey) return 'Saída direta';
  return 'Saída (venda)';
}
function dailyExitRows(day) {
  return movements.filter(m => dayKey(m.date) === dayKey(day) && Number(m.qty) < 0 && m.reasonKey)
    .map(m => {
      const qty = Math.abs(Number(m.qty) || 0);
      const price = moveUnitPrice(m);
      return {
        name: m.name || '—',
        qty,
        price,
        total: moveValue(m),
        loc: m.loc === 'armazem' ? 'Armazém' : 'Loja',
        reason: m.reason || 'Saída direta',
        ref: m.ref || '',
        notes: m.notes || '',
        unit: (moveProduct(m) || {}).unit || '',
        ts: Number(m.ts) || 0
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.ts - b.ts);
}
function dailyMoveRows(day) {
  return movements.filter(m => dayKey(m.date) === dayKey(day))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    .map(m => ({
      time: m.ts ? fmtTime(m.ts) : '—',
      name: m.name || '—',
      kind: moveKind(m),
      qty: Number(m.qty) || 0,
      after: m.after,
      loc: m.loc === 'armazem' ? 'Armazém' : m.loc === 'loja' ? 'Loja' : '—',
      ref: m.ref || '—',
      reason: m.reason || (moveKind(m) === 'Entrada' ? 'Entrada de stock' : '—'),
      value: moveValue(m)
    }));
}
function printDaily(day) {
  day = day || todayISO();
  const rows = dailySalesRows(day);
  const exits = dailyExitRows(day);
  const moves = dailyMoveRows(day);
  if (!rows.length && !exits.length && !moves.length) return toast('Sem movimentos para imprimir neste dia.', 'warning');
  const total = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const units = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const exitTotal = exits.reduce((a, m) => a + (Number(m.total) || 0), 0);
  const co = company || {};
  const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  setHtml('pdBrand', esc(co.name || 'Empresa'));
  setHtml('pdCompany', [
    co.nuit ? 'NUIT: ' + esc(co.nuit) : '',
    [co.address, co.city].filter(Boolean).map(esc).join(' · '),
    [co.phone, co.email].filter(Boolean).map(esc).join(' · ')
  ].filter(Boolean).join('<br>'));
  setHtml('pdMeta', '<span>Data do movimento: <strong>' + esc(fmtDate(day)) + '</strong></span>'
    + '<span>Emitido: ' + esc(fmtDate(todayISO()) + ' ' + fmtTime(Date.now())) + '</span>');
  const tb = $('pdRows');
  if (tb) {
    tb.innerHTML = rows.map(r => {
      const qty = Number(r.qty) || 0;
      const tot = Number(r.total) || 0;
      return '<tr><td>' + esc(r.name) + '</td><td class="num">' + esc(String(qty)) + '</td><td>' + esc(r.unit || '—') + '</td>'
        + '<td class="num">' + MZN(qty ? tot / qty : 0) + '</td><td class="num">' + MZN(tot) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="pd-empty">Sem vendas registadas neste dia.</td></tr>';
  }
  setHtml('pdTotal', MZN(total));
  setHtml('pdSummary', 'Total de unidades: <strong>' + esc(String(units)) + '</strong> · Total faturado: <strong>' + MZN(total) + '</strong>'
    + (exits.length ? ' · Saídas diretas: <strong>' + MZN(exitTotal) + '</strong> (' + exits.length + ')' : ''));
  const exBox = $('pdExitBox');
  const exBody = $('pdExits');
  if (exBox && exBody) {
    exBox.style.display = exits.length ? '' : 'none';
    exBody.innerHTML = exits.map(m => '<tr><td>' + esc(m.name) + '</td><td class="num">' + esc(String(m.qty)) + '</td>'
      + '<td class="num">' + MZN(m.price) + '</td><td class="num">' + MZN(m.total) + '</td>'
      + '<td>' + esc(m.loc) + '</td><td>' + esc(m.reason) + '</td></tr>').join('');
  }
  setHtml('pdExitTotal', MZN(exitTotal));
  const mvBox = $('pdMoveBox');
  const mvBody = $('pdMoves');
  if (mvBox && mvBody) {
    mvBox.style.display = moves.length ? '' : 'none';
    mvBody.innerHTML = moves.map(m => '<tr><td>' + esc(m.time) + '</td><td>' + esc(m.name) + '</td><td>' + esc(m.kind) + '</td>'
      + '<td class="num">' + (m.qty > 0 ? '+' : '') + esc(String(m.qty)) + '</td>'
      + '<td class="num">' + esc(String(m.after == null ? '—' : m.after)) + '</td>'
      + '<td>' + esc(m.ref) + '</td><td>' + esc(m.reason) + (m.kind === 'Saída direta' && m.value ? ' · ' + MZN(m.value) : '') + '</td></tr>').join('');
  }
  setHtml('pdIssued', 'Emitido por ' + esc(userNameOf(currentUser)) + ' · Documento interno · ' + esc(fmtDate(todayISO()) + ' ' + fmtTime(Date.now())));
  document.body.classList.add('print-daily');
  setTimeout(async () => {
    try {
      if (window.api && typeof window.api.printDocument === 'function') await window.api.printDocument();
      else window.print();
    } catch (_) { try { window.print(); } catch (_) {} }
    setTimeout(() => document.body.classList.remove('print-daily'), 600);
  }, 60);
}
function dailyPdf(day) {
  day = day || todayISO();
  const rows = dailySalesRows(day);
  const exits = dailyExitRows(day);
  const moves = dailyMoveRows(day);
  if (!rows.length && !exits.length && !moves.length) return toast('Sem movimentos para exportar neste dia.', 'warning');
  if (!window.jspdf || !window.jspdf.jsPDF) return toast('Gerador de PDF não disponível.', 'error');
  const total = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const units = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const exitTotal = exits.reduce((a, m) => a + (Number(m.total) || 0), 0);
  const co = company || {};
  const doc = docNew();
  if (typeof doc.autoTable !== 'function') return toast('Tabelas PDF não disponíveis.', 'error');
  const M = 14, W = 210 - M * 2;
  doc.setTextColor(0, 0, 0); doc.setDrawColor(0, 0, 0);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(String(co.name || 'Empresa').toUpperCase(), M, 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  const info = [co.nuit ? 'NUIT: ' + co.nuit : '', co.address || '', co.city || '', co.phone || '', co.email || ''].filter(Boolean).join(' · ');
  if (info) doc.text(info, M, 21);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text('MOVIMENTO DIÁRIO', M + W, 16, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text('Data: ' + fmtDate(day), M + W, 22, { align: 'right' });
  doc.setLineWidth(0.4); doc.line(M, 26, M + W, 26);
  const body = rows.map(r => {
    const qty = Number(r.qty) || 0, tot = Number(r.total) || 0;
    return [r.name, String(qty), r.unit || '—', MZN(qty ? tot / qty : 0), MZN(tot)];
  });
  if (!body.length) body.push(['Sem vendas registadas neste dia.', '', '', '', '']);
  doc.autoTable({
    startY: 32,
    head: [['Produto', 'Qtd', 'Unid.', 'Preço Médio', 'Total']],
    body,
    foot: [['Total Geral', '', '', '', MZN(total)]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, textColor: [0, 0, 0], lineColor: [0, 0, 0], lineWidth: 0.2, fillColor: [255, 255, 255], cellPadding: 2.4 },
    headStyles: { fontStyle: 'bold', textColor: [0, 0, 0], fillColor: [255, 255, 255], lineWidth: 0.3 },
    footStyles: { fontStyle: 'bold', textColor: [0, 0, 0], fillColor: [255, 255, 255], lineWidth: 0.3 },
    alternateRowStyles: { fillColor: [255, 255, 255] },
    columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } }
  });
  let y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 32) + 7;
  if (y > 270) { doc.addPage(); y = 20; }
  doc.setFontSize(9); doc.setFont('helvetica', 'bold');
  doc.text('Total de unidades: ' + units, M, y);
  doc.text('Total faturado: ' + MZN(total) + (exits.length ? ' · Saídas diretas: ' + MZN(exitTotal) : ''), M + W, y, { align: 'right' });
  if (exits.length) {
    y += 8;
    doc.setFontSize(9.5); doc.setFont('helvetica', 'bold');
    doc.text('SAÍDAS DE STOCK SEM VENDA', M, y);
    doc.autoTable({
      startY: y + 2,
      head: [['Produto', 'Qtd', 'Preço', 'Valor', 'Local', 'Motivo']],
      body: exits.map(m => [m.name, String(m.qty), MZN(m.price), MZN(m.total), m.loc, m.reason]),
      foot: [['Total das saídas', '', '', MZN(exitTotal), '', '']],
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8.5, textColor: [0, 0, 0], lineColor: [0, 0, 0], lineWidth: 0.2, fillColor: [255, 255, 255], cellPadding: 2.2 },
      headStyles: { fontStyle: 'bold', textColor: [0, 0, 0], fillColor: [255, 255, 255], lineWidth: 0.3 },
      footStyles: { fontStyle: 'bold', textColor: [0, 0, 0], fillColor: [255, 255, 255], lineWidth: 0.3 },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: { 1: { halign: 'right', cellWidth: 16 }, 2: { halign: 'right', cellWidth: 24 }, 3: { halign: 'right', cellWidth: 26 } }
    });
    y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : y) + 8;
    if (y > 270) { doc.addPage(); y = 20; }
  } else {
    y += 9;
  }
  if (moves.length) {
    if (y > 240) { doc.addPage(); y = 20; }
    doc.setFontSize(9.5); doc.setFont('helvetica', 'bold');
    doc.text('MOVIMENTOS DE STOCK DO DIA', M, y);
    doc.autoTable({
      startY: y + 2,
      head: [['Hora', 'Produto', 'Movimento', 'Qtd', 'Após', 'Ref.', 'Justificação']],
      body: moves.map(m => [m.time, m.name, m.kind, (m.qty > 0 ? '+' : '') + String(m.qty), String(m.after == null ? '—' : m.after), m.ref, m.reason]),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8, textColor: [0, 0, 0], lineColor: [0, 0, 0], lineWidth: 0.2, fillColor: [255, 255, 255], cellPadding: 2 },
      headStyles: { fontStyle: 'bold', textColor: [0, 0, 0], fillColor: [255, 255, 255], lineWidth: 0.3 },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: { 0: { cellWidth: 14 }, 3: { halign: 'right', cellWidth: 14 }, 4: { halign: 'right', cellWidth: 14 }, 5: { cellWidth: 24 } }
    });
    y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : y) + 8;
    if (y > 270) { doc.addPage(); y = 20; }
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text('Emitido por ' + userNameOf(currentUser) + ' · Documento interno · ' + fmtDate(todayISO()) + ' ' + fmtTime(Date.now()), M, y);
  doc.text('Assinatura: ______________________', M + W, y, { align: 'right' });
  pdfSave(doc, 'movimento_diario_' + day);
}
if ($('btnLiveRefresh')) $('btnLiveRefresh').onclick = () => { liveSig = ''; renderDash(); };
if ($('btnLiveExit')) $('btnLiveExit').onclick = () => openExitStock();
if ($('btnLiveRend')) $('btnLiveRend').onclick = () => openRendDay(todayISO());
if ($('btnPrintDaily')) $('btnPrintDaily').onclick = () => printDaily(($('livePrintDate') || {}).value || todayISO());
if ($('btnPdfDaily')) $('btnPdfDaily').onclick = () => dailyPdf(($('livePrintDate') || {}).value || todayISO());
if ($('livePrintDate') && !$('livePrintDate').value) $('livePrintDate').value = todayISO();
function renderDash() {
  if(billingMode()) return;
  renderStockBadges();
  renderLive();
  const role = currentRole();
  const tb = $('recentTable').querySelector('tbody'); tb.innerHTML = '';
  dashRecentRows = [];   // exatamente o que está na tabela (usado pelo Excel/PDF)
  const rq = (($('searchRecent').value || '').toLowerCase());
  if (role === 'admin') {
    // Últimas 10 transações globais: vendas, compras, transferências e ajustes
    const evs = [];
    sales.forEach(s => evs.push({ ts: s.createdAt || 0, date: s.date, doc: s.number, kind: s.type === 'credito' ? 'Fatura de Crédito (FT)' : s.type === 'cotacao' ? 'Proforma (FP)' : 'Venda a Pronto (VD)', detail: s.client || '—', total: s.total, sid: s.id }));
    invoices.forEach(i => evs.push({ ts: i.createdAt || 0, date: i.date, doc: i.number, kind: 'Fatura de Compra (FC)', detail: supName(i.supplierId), total: i.total, iid: i.id }));
    transfers.forEach(t => evs.push({ ts: t.createdAt || 0, date: t.date, doc: t.number, kind: 'Guia de Transferência Interna (GTI)', detail: t.name, totalTxt: t.qty + ' ' + (t.unit || 'UN'), tid: t.id }));
    movements.filter(m => (m.reason || '').toLowerCase().indexOf('ajuste') !== -1 || (m.ref || '') === '').slice(-10).forEach(m => evs.push({ ts: m.ts || 0, date: m.date, doc: m.ref || 'AJUSTE', kind: 'Ajuste de Inventário', detail: m.name, totalTxt: String(m.qty), pid: m.productId }));
    evs.sort((a, b) => b.ts - a.ts)
      .filter(e => !rq || (e.doc + ' ' + e.detail).toLowerCase().includes(rq))
      .slice(0, 10).forEach(e => {
      const tr = document.createElement('tr');
      const totCell = e.totalTxt != null ? esc(e.totalTxt) : MZN(e.total);
      dashRecentRows.push({ date: fmtDate(e.date), kind: e.kind, doc: e.doc, detail: e.detail, total: e.totalTxt != null ? String(e.totalTxt) : MZN(e.total) });
      tr.innerHTML = `<td>${fmtDate(e.date)}</td><td>${esc(e.kind)}</td><td>${esc(e.doc)}</td><td>${esc(e.detail)}</td><td style="text-align:right">${totCell}</td>`;
      tr.style.cursor = 'pointer'; tr.title = 'Clique para ver o detalhe';
      tr.onclick = () => {
        if (e.sid) openSaleDetail(e.sid);
        else if (e.iid) openInvView(e.iid);
        else if (e.tid) openTransDetail(e.tid);
        else if (e.pid) openProductDetail(e.pid);
      };
      tb.appendChild(tr);
    });
  } else {
    const evs = dashboardSales().map(s=>({ts:s.createdAt||0,date:s.date,doc:s.number,kind:'Faturação',detail:s.client||'Consumidor final',total:s.total,sid:s.id}));
    evs.sort((a, b) => b.ts - a.ts)
      .filter(e => !rq || (e.doc + ' ' + e.detail).toLowerCase().includes(rq))
      .slice(0, 10).forEach(e => {
      const tr = document.createElement('tr');
      dashRecentRows.push({ date: fmtDate(e.date), kind: e.kind, doc: e.doc, detail: e.detail, total: MZN(e.total) });
      tr.innerHTML = `<td>${fmtDate(e.date)}</td><td>${esc(e.kind)}</td><td>${esc(e.doc)}</td><td>${esc(e.detail)}</td><td style="text-align:right">${MZN(e.total)}</td>`;
      tr.style.cursor='pointer';tr.onclick=()=>openSaleDetail(e.sid);
      tb.appendChild(tr);
    });
  }
  const st = $('salesRecent').querySelector('tbody'); st.innerHTML = '';
  const salesPane = $('salesRecent').closest ? $('salesRecent').closest('.panel') : null;
  if (salesPane) salesPane.style.display = '';
  const recentDocuments=dashboardSales();
  if($('btnPreviewAllInvoices')) {$('btnPreviewAllInvoices').disabled=!recentDocuments.length;$('btnPreviewAllInvoices').textContent='Ver todas as faturas ('+recentDocuments.length+')';}
  if(!recentDocuments.length) st.innerHTML='<tr><td colspan="7" class="hint">Ainda não há documentos emitidos.</td></tr>';
  recentDocuments.slice(0, 8).forEach(s => {
    const tr = document.createElement('tr');    tr.innerHTML = `<td>${fmtDate(s.date)}</td><td>${esc(s.number)}</td><td>${esc(s.client || '—')}</td><td style="text-align:right">${MZN(s.total)}</td><td style="text-align:right">${MZN(s.paid)}</td><td style="text-align:right">${MZN(saleBalance(s))}</td><td>${esc(issuedByLabel(s.operator))}</td>`;
    tr.style.cursor = 'pointer';
    tr.title = 'Consultar detalhes da faturação';
    tr.onclick = () => openSaleDetail(s.id,false);
    st.appendChild(tr);
  });
  let summary=$('salesOperatorSummary');if(!summary){summary=document.createElement('div');summary.id='salesOperatorSummary';$('view-dashboard').appendChild(summary);}summary.innerHTML=adminOperatorSummary();

}
$('featSell').onclick = () => document.querySelector('.nav-btn[data-view="sales"]').click();
$('featSup').onclick = () => document.querySelector('.nav-btn[data-view="suppliers"]').click();
$('featCli').onclick = () => document.querySelector('.nav-btn[data-view="clients"]').click();
$('featStock').onclick = () => openStock();
$('btnTopStock').onclick = () => openStock();
$('btnTopSettings').onclick = () => document.querySelector('.nav-btn[data-view="settings"]').click();
function openTransDetail(tid) {
  const t = transfers.find(x => x.id === tid); if (!t) return;
  if(currentRole()!=='admin' && String(t.operator||'').toLowerCase()!==String(currentUser||'').toLowerCase()) return;
  $('transDetailModal').dataset.tid = tid;
  $('transDetailTitle').textContent = 'Transferência Interna ' + (t.number || '');
  const lbl = (v) => v === 'armazem' ? 'Armazém' : 'Loja';
  const line = (k, v) => (v === '' || v == null) ? '' : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const legs = movements.filter(m => String(m.ref || '') === String(t.number || '')).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let html = '<div class="det-items"><table>'
    + line('Documento', t.number || '—')
    + line('Data', fmtDate(t.date))
    + line('Produto', t.name || '—')
    + line('Quantidade', t.qty + ' ' + (t.unit || ''))
    + line('De → Para', lbl(t.from) + ' → ' + lbl(t.to))
    + line('Operador', t.operator ? userNameOf(t.operator) : '')
    + line('Notas', t.notes || '—')
    + line('Registado', fmtDateTime(t.createdAt || t.ts))
    + '</table></div>';
  html += '<h4 style="margin:12px 0 6px">Movimento de stock</h4>';
  html += '<div class="det-items"><table>'
    + (legs.length
      ? legs.map(m => line((m.qty > 0 ? 'Entrada — ' : 'Saída — ') + lbl(m.loc), Math.abs(m.qty) + ' ' + (t.unit || '') + '   ·   stock após: ' + m.after)).join('')
      : line('Kardex', 'sem movimentos associados'))
    + '</table></div>';
  $('transDetailBody').innerHTML = html;
  $('transDetailModal').style.display = 'flex';
}
function goToSupplier(id) {
  if (currentRole() !== 'admin') return toast('Acesso restrito ao Administrador.', 'error');
  document.querySelector('.nav-btn[data-view="suppliers"]').click();
  openSupplier(id);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICO_DEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';
const ICO_PDF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h6M9 17h4"/></svg>';
const ICO_PRINT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
const ICO_TRUCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="14" height="12" rx="1"/><path d="M15 9h4l4 4v3h-8z"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></svg>';
const ICO_CASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>';
const ICO_UNDO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
const ICO_SWAP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v3a4 4 0 0 1-4 4H3"/></svg>';
const ICO_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>';

/* ---------- suppliers ---------- */
let currentSup = null;
function renderSup() {
  const q = ($('searchSup').value || '').toLowerCase(), tb = $('supTable').querySelector('tbody');
  tb.innerHTML = '';
  suppliers.filter(s => !q || (s.name + s.phone + (s.nuit || '')).toLowerCase().includes(q)).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${esc(s.name)}</strong><br><small class="muted">${esc(s.address || '')}</small></td><td>${esc(s.phone || '')}</td><td>${esc(s.email || '')}</td><td>${esc(s.nuit || '')}</td><td style="text-align:right"><strong>${MZN(supEffective(s.id))}</strong></td><td><button class="btn small">Abrir ficha →</button></td>`;
    tr.querySelector('button').onclick = (e) => { e.stopPropagation(); openSupplier(s.id); };
    tr.onclick = () => openSupplier(s.id);
    tr.style.cursor = 'pointer';
    if (currentSup && s.id === currentSup.id) tr.classList.add('active');
    tb.appendChild(tr);
  });
}
$('searchSup').oninput = renderSup;
$('searchRecent').oninput = renderDash;
let editingSup = false; // modal de fornecedor em modo edição
  $('btnAddSup').onclick = () => {
  editingSup = false; $('supModalTitle').textContent = 'Novo Fornecedor';
  ['sName', 'sPhone', 'sEmail', 'sAddr', 'sNuit', 'sBank'].forEach(id => $(id).value = '');
  $('supModal').style.display = 'flex';
};
$('btnEditSup').onclick = () => {
  if (!currentSup) return;
  editingSup = true; $('supModalTitle').textContent = 'Editar Fornecedor';
  $('sName').value = currentSup.name || ''; $('sPhone').value = currentSup.phone || '';
  $('sEmail').value = currentSup.email || ''; $('sAddr').value = currentSup.address || '';
  $('sNuit').value = currentSup.nuit || ''; $('sBank').value = currentSup.bank || '';
  $('supModal').style.display = 'flex';
};
$('btnCancelSup').onclick = () => { $('supModal').style.display = 'none'; };
$('btnSaveSup').onclick = async () => {
  const name = $('sName').value.trim();
  if (!name) return toast('Nome da empresa é obrigatório.', 'warning');
  if (!warnNuit($('sNuit').value.trim(), 'fornecedor')) return;
  const data = { name, phone: $('sPhone').value.trim(), email: $('sEmail').value.trim(), address: $('sAddr').value.trim(), nuit: $('sNuit').value.trim(), bank: $('sBank').value.trim(), updatedAt: Date.now() };
  if (editingSup && currentSup) {
    Object.assign(currentSup, data);
    pushQueue({ type: 'supplier', payload: { ...currentSup } });
    toast('Fornecedor atualizado.', 'success');
  } else {
    const s = { id: uid(), ...data, createdAt: Date.now() };
    suppliers.push(s); pushQueue({ type: 'supplier', payload: s });
    toast('Fornecedor guardado.', 'success');
  }
  editingSup = false; $('supModalTitle').textContent = 'Novo Fornecedor';
  ['sName', 'sPhone', 'sEmail', 'sAddr', 'sNuit', 'sBank'].forEach(id => $(id).value = '');
  $('supModal').style.display = 'none'; renderAll();
  if (currentSup) openSupplier(currentSup.id);
};
$('btnBack').onclick = () => { currentSup = null; $('supplierDetail').style.display = 'none'; $('supList').style.display = 'block'; renderSup(); };
$('btnDelSup').onclick = async () => {
  if (!currentSup) return;
  const n = invoicesFor(currentSup.id).length;
  const ok = await confirmDlg('Remover fornecedor?', `"${currentSup.name}" e as suas ${n} fatura(s) serão apagadas deste dispositivo e da nuvem.`);
  if (!ok) return;
  const id = currentSup.id;
  invoices.filter(i => i.supplierId === id).forEach(i => pushQueue({ type: 'delete-invoice', payload: { id: i.id } }));
  pushQueue({ type: 'delete-supplier', payload: { id } });
  suppliers = suppliers.filter(s => s.id !== id);
  invoices = invoices.filter(i => i.supplierId !== id);
  persist(); currentSup = null; $('supplierDetail').style.display = 'none'; $('supList').style.display = 'block';
  renderAll(); toast('Fornecedor removido.', 'success');
};

/* ---------- clientes & conta corrente ---------- */
let currentCli = null, editingCli = false;
function renderCli() {
  const q = (($('searchCli').value || '').toLowerCase()), tb = $('cliTable').querySelector('tbody');
  tb.innerHTML = '';
  clients.filter(c => !q || ((c.name || '') + (c.phone || '') + (c.nuit || '')).toLowerCase().includes(q)).forEach(c => {
    const bal = clientBalance(c.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${esc(c.name)}</strong></td><td>${esc(c.nuit || '')}</td><td>${esc(c.phone || '')}</td><td style="text-align:right"><strong>${MZN(bal)}</strong></td><td><button class="btn small">Abrir ficha →</button></td>`;
    tr.querySelector('button').onclick = (e) => { e.stopPropagation(); openClient(c.id); };
    tr.onclick = () => openClient(c.id);
    tr.style.cursor = 'pointer';
    if (currentCli && c.id === currentCli.id) tr.classList.add('active');
    tb.appendChild(tr);
  });
}
$('searchCli').oninput = renderCli;
function openClient(id) {
  currentCli = clients.find(c => c.id === id); if (!currentCli) return;
  $('cliDetail').style.display = 'block';
  $('cliList').style.display = 'none';
  renderCliDetail(); renderCli();
}
$('btnBackCli').onclick = () => { currentCli = null; $('cliDetail').style.display = 'none'; $('cliList').style.display = 'block'; renderCli(); };
$('btnAddCli').onclick = () => { if(currentRole()!=='admin') return toast('Cadastro de clientes: acesso Administrador.','warning'); editingCli = false; $('cliModalTitle').textContent = 'Novo Cliente'; ['cFName', 'cFNuit', 'cFPhone', 'cFEmail', 'cFAddr'].forEach(i => $(i).value = ''); if ($('cFLimit')) $('cFLimit').value = 0; $('cFType').value = 'Particular'; $('cFTerm').value = 0; $('cliModal').style.display = 'flex'; };
$('btnCancelCli').onclick = () => { $('cliModal').style.display = 'none'; };
$('btnEditCli').onclick = () => {
  if(currentRole()!=='admin') return toast('Editar clientes: acesso Administrador.','warning');
  if (!currentCli) return;
  editingCli = true; $('cliModalTitle').textContent = 'Editar Cliente';
  $('cFName').value = currentCli.name || ''; $('cFNuit').value = currentCli.nuit || ''; $('cFPhone').value = currentCli.phone || '';
  $('cFEmail').value = currentCli.email || ''; $('cFAddr').value = currentCli.address || ''; if ($('cFLimit')) $('cFLimit').value = currentCli.creditLimit || 0;
  $('cFType').value = currentCli.ctype || 'Particular'; $('cFTerm').value = currentCli.payTerm || 0;
  $('cliModal').style.display = 'flex';
};
if ($('btnDelCli')) $('btnDelCli').onclick = async () => {
  if(currentRole()!=='admin') return toast('Remover clientes: acesso Administrador.','warning');
  if (!currentCli) return;
  const bal = clientBalance(currentCli.id), nDocs = clientDocs(currentCli.id).length;
  const extra = bal > 0 ? ` Ainda tem ${MZN(bal)} em dívida e ` : ' Tem ';
  const ok = await confirmDlg('Remover cliente?', `"${currentCli.name}"${extra}${nDocs} movimento(s) na conta corrente. O cadastro sai deste dispositivo e da nuvem; as vendas/faturas emitidas mantêm-se no histórico.`);
  if (!ok) return;
  const id = currentCli.id;
  pushQueue({ type: 'delete-client', payload: { id } });
  clients = clients.filter(c => c.id !== id);
  persist(); currentCli = null; $('cliDetail').style.display = 'none'; $('cliList').style.display = 'block';
  renderAll(); toast('Cliente removido.', 'success');
};
$('btnSaveCli').onclick = () => {
  if(currentRole()!=='admin') return toast('Cadastro de clientes: acesso Administrador.','warning');
  const name = $('cFName').value.trim();
  if (!name) return toast('Nome é obrigatório.', 'warning');
  if (!warnNuit($('cFNuit').value.trim(), 'cliente')) return;
  const data = { name, nuit: $('cFNuit').value.trim(), phone: $('cFPhone').value.trim(), email: $('cFEmail').value.trim(), address: $('cFAddr').value.trim(), creditLimit: 0, ctype: $('cFType').value, payTerm: Number($('cFTerm').value) || 0, updatedAt: Date.now() };
  if (editingCli && currentCli) { Object.assign(currentCli, data); pushQueue({ type: 'client', payload: { ...currentCli } }); toast('Cliente atualizado.', 'success'); }
  else { const c = { id: uid(), ...data, createdAt: Date.now() }; clients.push(c); pushQueue({ type: 'client', payload: { ...c } }); toast('Cliente guardado.', 'success'); }
  editingCli = false; $('cliModal').style.display = 'none';
  renderAll(); renderClients();
  if (currentCli) openClient(currentCli.id);
};
function cliDocItems(c, r) {
  try {
    if (r.kind === 'Recibo') return '';
    let items = null;
    if (r.kind === 'Nota de Crédito') { const n = ncs.find(x => x.number === r.doc); if (n) items = n.items; }
    else { const s = sales.find(x => canSeeSale(x) && (r.saleId ? x.id===r.saleId : x.number === r.doc && (x.clientId === c.id || (x.client || '').toLowerCase() === (c.name || '').toLowerCase()))); if (s) items = s.items; }
    if (!items || !items.length) return '';
    return items.map(p => `${fmtQty(p)} × ${esc(p.desc)} — ${MZN(p.total)}`).join('<br>');
  } catch (_) { return ''; }
}
function openClientInvoiceReport(client,sale) {
  if(!sale || !canSeeSale(sale))return;
  openInfo(billingMode()?'Reportar faturação à administração':'Reportar venda à administração',detMeta([['Cliente',esc(client.name)],['Documento',esc(sale.number)],['Data',fmtDate(sale.date)],['Total',MZN(sale.total)]])+'<label for="clientReportReason">Motivo do reporte</label><textarea id="clientReportReason" rows="4" maxlength="2000" placeholder="Explique a situação para a administração analisar…"></textarea><p id="clientReportError" class="hint" role="status"></p><button id="btnSendClientReport" type="button" class="btn primary">Enviar reporte</button>');
  $('btnPrintInfo').hidden=true;
  $('btnSendClientReport').onclick=()=>{
    const reason=$('clientReportReason').value.trim();if(reason.length<8){$('clientReportError').textContent='Escreva um motivo com pelo menos 8 caracteres.';$('clientReportReason').focus();return;}
    $('btnSendClientReport').disabled=true;
    reportToAdmin('Faturação de cliente','Faturação '+sale.number+' — '+client.name,reason,[],{reportKind:'client-invoice',link:{view:'sales',sel:sale.id},document:{id:sale.id,number:sale.number,date:sale.date,total:sale.total,clientId:client.id,client:client.name}});
    closeInfo();
  };
}
function renderCliDetail() {
  const c = currentCli; if (!c) return;
  $('cName').textContent = c.name;
  $('cContact').textContent = [c.phone, c.email].filter(Boolean).join('  •  ');
  $('cExtra').textContent = [c.address, c.nuit ? 'NUIT: ' + c.nuit : ''].filter(Boolean).join('  •  ');
  $('cExtra').textContent = [c.address, c.nuit ? 'NUIT: ' + c.nuit : '', c.ctype || '', c.payTerm ? 'Prazo: ' + c.payTerm + ' dias' : ''].filter(Boolean).join('  •  ');
  const bal = clientBalance(c.id);
  if ($('cLimit')) $('cLimit').textContent = MZN(0);
  $('cAvail').textContent = MZN(bal);
  const basic=$('cliBasicActivity'),isAdmin=currentRole()==='admin';
  if(basic) {
    basic.hidden=isAdmin;
    const issued=clientIssuedDocuments(c.id),purchases=issued.filter(s=>!s.billingOnly && saleKind(s)!=='cotacao' && !s.convertedId).sort((a,b)=>String(b.date).localeCompare(String(a.date))||(b.createdAt||0)-(a.createdAt||0));
    const last=purchases[0] || issued[0];
    basic.innerHTML=detMeta([['Data de cadastro',c.createdAt?fmtDate(new Date(c.createdAt).toISOString().slice(0,10)):'Não registada'],[billingMode()?'Última faturação do cliente':purchases.length?'Última compra do cliente':'Último documento de venda',last?fmtDate(last.date):'Sem documentos']])+(last?'<p>Documento: <strong>'+esc(last.number)+'</strong> · '+MZN(last.total)+'</p><button type="button" class="btn" data-report-client-invoice>Reportar documento</button>':'<p class="hint">Ainda não há faturações suas para este cliente.</p>');
    basic.querySelector('[data-report-client-invoice]')?.addEventListener('click',()=>openClientInvoiceReport(c,last));
  }
  $('btnEditCli').hidden=!isAdmin;$('btnDelCli').hidden=!isAdmin;
  
  $('cliPrintArea').hidden=!isAdmin;
  const issued=clientIssuedDocuments(c.id);
  const billingArea=$('cliBillingArea');
  if(billingArea) {
    billingArea.hidden=false;
    const heading=billingArea.querySelector('h3');heading.firstChild.textContent=billingMode()?'Faturação do cliente ':'Vendas do cliente ';
    let allButton=$('clientPreviewAll');if(!allButton){allButton=document.createElement('button');allButton.id='clientPreviewAll';allButton.type='button';allButton.className='btn small';billingArea.querySelector('.panel-head').appendChild(allButton);}
    allButton.textContent=billingMode()?'Ver todos os documentos':'Ver todas as vendas';allButton.disabled=!issued.length;allButton.onclick=()=>{markedPreview={ids:issued.map(s=>s.id),index:0,label:'Documento do cliente'};openSaleDetail(issued[0].id,true,true);};
    $('cliBillingCount').textContent='('+issued.length+' documento(s))';
    $('cliBillingTotal').textContent=MZN(issued.filter(s=>!s.convertedId).reduce((total,s)=>total+(Number(s.total)||0),0));
    const body=$('cliBillingTable').querySelector('tbody');body.innerHTML='';
    issued.forEach(s=>{
      const row=document.createElement('tr');row.dataset.document=s.id;row.tabIndex=0;
      row.innerHTML='<td>'+fmtDate(s.date)+'</td><td>'+esc(s.number)+'</td><td>'+esc(s.billingOnly || saleKind(s)==='cotacao'?'Proforma':saleKindName(s.type))+(s.convertedId?' (convertida)':'')+'</td><td class="dashboard-value">'+MZN(s.total)+'</td><td>'+esc(issuedByLabel(s.operator))+'</td><td><button type="button" class="btn small cli-billing-document">Pré-visualizar</button></td>';
      body.appendChild(row);
    });
    if(!issued.length) body.innerHTML='<tr><td colspan="6" class="hint">Ainda não há documentos emitidos para este cliente.</td></tr>';
    bindDashboardDocuments(billingArea);
  }
  const rows = clientDocs(c.id);
  $('cliCount').textContent = rows.length ? '(' + rows.length + ' mov(s))' : '(sem movimentos)';
  const tb = $('cliTableHist').querySelector('tbody'); tb.innerHTML = '';
  let run = 0;
  rows.forEach(r => {
    run += r.plus - r.minus;
    const sDoc = sales.find(s => canSeeSale(s) && (r.saleId?s.id===r.saleId:s.number === r.doc));
    const state = r.kind==='Recibo' ? 'Pago' : sDoc ? saleStatus(sDoc) : (r.kind === 'Nota de Crédito' ? 'Devolvido' : '—');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(r.date)}</td><td>${esc(r.doc)}</td><td>${esc(r.kind)}</td><td style="text-align:right">${r.plus ? MZN(r.plus) : '—'}</td><td style="text-align:right">${r.minus ? MZN(r.minus) : '—'}</td><td style="text-align:right"><strong>${MZN(run)}</strong></td><td>${esc(state)}</td><td>${sDoc && r.kind !== 'Recibo' ? '<button type="button" class="btn small cli-document">Pré-visualizar</button>' : ''}</td>`;
    const documentBtn = tr.querySelector('.cli-document');
    if (documentBtn) documentBtn.onclick = e => { e.stopPropagation(); openSaleDetail(sDoc.id); };
    if (sDoc) { tr.style.cursor = 'pointer'; tr.title = 'Clique para ver o detalhe da venda'; tr.onclick = () => openSaleDetail(sDoc.id,false); }
    tb.appendChild(tr);
    const det = cliDocItems(c, r);
    if (det) {
      const dr = document.createElement('tr');
      dr.className = 'inv-acc-detail';
      dr.innerHTML = `<td></td><td colspan="7" class="wrap">${det}</td>`;
      tb.appendChild(dr);
    }
  });
}
function renderClients() {
  const dl = $('clientList');
  if (dl) dl.innerHTML = clients.map(c => `<option value="${esc(c.name)}">`).join('');
}
$('btnPdfCli').onclick = () => {
  const c = currentCli; if (!c) return;
  const rows = clientDocs(c.id);
  const doc = docNew();
  const totF = rows.reduce((s, r) => s + r.plus, 0);
  const totP = rows.reduce((s, r) => s + r.minus, 0);
  const saldo = totF - totP;
  let y = docHeader(doc, 'CONTA CORRENTE', 'Saldo ' + MZN(saldo), pdfNow(), '');
  y = docMeta(doc, y, [
    { title: 'Cliente', lines: [
      String(c.name || '—'),
      c.nuit ? 'NUIT: ' + c.nuit : '',
      c.phone ? 'Contacto: ' + c.phone : '',
      c.address || ''
    ] },
    { title: 'Detalhes do extrato', lines: [
      'Emitido em: ' + pdfNow(),
      'Documentos: ' + rows.length,
      'Tipo/Prazo: ' + ([c.tipo, c.prazo].filter(Boolean).join(' · ') || '—'),
      'Saldo devedor: ' + MZN(saldo)
    ] }
  ]);
  let run = 0;
  y = docItems(doc, y, {
    columnStyles: {
      0: { cellWidth: 18, textColor: CMUT },
      1: { cellWidth: 24, fontStyle: 'bold' },
      2: { cellWidth: 30 },
      3: { halign: 'right', cellWidth: 27 },
      4: { halign: 'right', cellWidth: 27 },
      5: { halign: 'right', cellWidth: 27, fontStyle: 'bold' }
    },
    head: [['Data', 'Documento', 'Tipo', 'Débito (MT)', 'Crédito (MT)', 'Saldo (MT)']],
    body: rows.map(r => { run += r.plus - r.minus; return [fmtDate(r.date), r.doc, r.kind, r.plus ? MZN(r.plus) : '—', r.minus ? MZN(r.minus) : '—', MZN(run)]; }),
    didDrawPage: docFootSetup(doc, '', 'Extrato ' + c.name)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DÉBITO', value: MZN(totF) },
    { label: 'TOTAL CRÉDITO', value: MZN(totP), color: COK },
    { label: 'SALDO DEVEDOR', value: MZN(saldo), big: true, rule: true, color: saldo > 0 ? CBAD : COK }
  ]);
  y = docNotes(doc, y, 'Observações', [
    'Extrato emitido a pedido do cliente — inclui faturas, recibos e notas de crédito.',
    saldo > 0 ? 'Encontra-se em dívida o valor de ' + MZN(saldo) + '.' : 'Não existe saldo em dívida.'
  ]);
  docSignatures(doc, 'O Responsável', 'O Cliente');
  pdfSave(doc, safeName('conta_' + c.name));
};

function openSupplier(id) {
  currentSup = suppliers.find(s => s.id === id); if (!currentSup) return;
  $('supplierDetail').style.display = 'block';
  $('supList').style.display = 'none';
  $('dName').textContent = currentSup.name;
  $('dContact').textContent = [currentSup.phone, currentSup.email].filter(Boolean).join('  •  ');
  $('dExtra').textContent = [currentSup.address, currentSup.nuit ? 'NUIT: ' + currentSup.nuit : '', currentSup.bank ? 'Conta: ' + currentSup.bank : ''].filter(Boolean).join('  •  ');
  resetInvForm();
  if (!$('fNumber').value.trim()) $('fNumber').value = 'FT ' + new Date().getFullYear() + '/' + String(invoicesFor(id).length + 1).padStart(3, '0');
  if ($('spDate')) $('spDate').value = fmtDate(todayISO());
  $('invModal').style.display = 'none';
  $('viewSimple').checked = true;
  $('printArea').classList.add('simple');
  renderSup();
  renderDetail();
}
function openInvModal() { $('invModal').style.display = 'flex'; }
function closeInvModal() { $('invModal').style.display = 'none'; resetInvForm(); }
$('btnToggleForm').onclick = openInvModal;
$('btnCancelInv').onclick = closeInvModal;
$('invModal').addEventListener('click', (e) => { if (e.target === $('invModal')) closeInvModal(); });

/* ---------- invoice form ---------- */
function prodRow(desc = '', qty = 0, price = 0, unit = '') {
  const d = document.createElement('div'); d.className = 'prod-row';
  const qv = (qty === 0 || qty === '' || qty == null) ? '' : qty;
  const pv = (price === 0 || price === '' || price == null) ? '' : Number(price).toFixed(2);
  d.innerHTML = `<div class="pcol pcol-qty" data-label="Qtd"><div class="qty-wrap"><div class="inp-wrap" style="flex:1;display:flex"><input class="p-qty" type="number" min="0" step="any" value="${qv}" placeholder="0.00"><button type="button" class="inp-clear" data-cl="qty" title="Limpar">✕</button></div><span class="qty-div"></span><input class="p-unit" list="unitList" placeholder="CX" autocomplete="off" value="${esc(unit)}"></div></div><div class="pcol pcol-desc" data-label="Produto"><div class="desc-cell"><div class="inp-wrap"><input class="p-desc" placeholder="Produto" autocomplete="off" value="${esc(desc)}"><button type="button" class="inp-clear" data-cl="desc" title="Limpar">✕</button></div></div></div><div class="pcol pcol-price" data-label="Preço"><div class="inp-wrap"><input class="p-price money" type="number" min="0" step="0.01" value="${pv}" placeholder="0.00"><button type="button" class="inp-clear" data-cl="price" title="Limpar">✕</button></div></div><div class="pcol pcol-total" data-label="Total"><div class="prod-total">0,00 MT</div></div><div class="pcol pcol-act"><button type="button" class="btn small ghost rm" title="Remover produto">✕</button></div>`;
  d.querySelector('.rm').onclick = () => { const bx = boxOf(d); d.remove(); recalcForm(bx); };
  d.querySelectorAll('input').forEach(i => {
    i.oninput = () => { const bx = boxOf(i); paintClear(i); recalcForm(bx); };
    i.addEventListener('focus', () => { try { i.select(); } catch (_) {} });
  });
  d.querySelectorAll('.inp-clear').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    const kind = b.dataset.cl;
    if (kind === 'qty') d.querySelector('.p-qty').value = '';
    else if (kind === 'price') d.querySelector('.p-price').value = '0.00';
    else { const bx = boxOf(d); d.remove(); if (!$(bx).querySelector('.prod-row')) $(bx).appendChild(prodRow()); closeSugg(); recalcForm(bx); updateRemoveButtons(bx); return; }
    const bx = boxOf(d); paintClear(d.querySelector(kind === 'qty' ? '.p-qty' : kind === 'price' ? '.p-price' : '.p-desc')); recalcForm(bx);
  });
  setTimeout(() => { updateRemoveButtons(boxOf(d)); [...d.querySelectorAll('input')].forEach(paintClear); }, 0);
  return d;
}
function paintClear(inp) {
  try {
    const w = inp.closest ? inp.closest('.inp-wrap') : null; if (!w) return;
    w.classList.toggle('has-val', String(inp.value || '').trim() !== '');
  } catch (_) {}
}

function updateRemoveButtons(boxId) {
  const cont = $(boxId);
  if (!cont) return;
  const rows = [...cont.querySelectorAll('.prod-row')];
  rows.forEach(r => {
    const rm = r.querySelector('.rm');
    if (rm) rm.disabled = rows.length <= 1;
  });
}
const PROD_BOXES = ['prodRows', 'saleRows', 'ocRows', 'ncRows', 'srRows'];
const TOTAL_EL = { prodRows: 'fTotal', saleRows: 'sTotal', ocRows: 'ocTotal', ncRows: 'ncTotal', srRows: 'srTotal' };
function boxOf(el) { const b = el && el.closest && el.closest('#prodRows,#saleRows,#ocRows,#ncRows,#srRows'); return b ? b.id : 'prodRows'; }
function autoGrow(box) {
  // Não adiciona linhas automaticamente no input - só no Enter da última linha
  // Esta função é mantida para compatibilidade mas não faz nada
  return;
}
function resetSaleRows() { $('saleRows').innerHTML = ''; $('saleRows').appendChild(prodRow()); recalcForm('saleRows'); }
function resetProdRows() { $('prodRows').innerHTML = ''; $('prodRows').appendChild(prodRow()); recalcForm(); }
/* Normaliza a data enquanto se escreve, sem estragar quem escreve o ano primeiro. */
function dateInputValue(v) {
  const raw = String(v || '').trim();
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return m[3].padStart(2, '0') + '-' + m[2].padStart(2, '0') + '-' + m[1];
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') + '-' + m[3];
  if (/^\d{4}$/.test(raw) && +raw >= 2000 && +raw <= 2100) return raw; // ano a ser escrito
  if (/^(20\d{2})(\d{2})(\d{2})$/.test(raw)) return raw.slice(6, 8) + '-' + raw.slice(4, 6) + '-' + raw.slice(0, 4);
  if (/^\d{4}[-/.]\d{0,2}[-/.]?\d{0,2}$/.test(raw)) return raw;     // ISO a meio
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  return digits.length > 4 ? digits.slice(0, 2) + '-' + digits.slice(2, 4) + '-' + digits.slice(4)
    : digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
}
[$('fDate'), $('sDate'), $('spDate'), $('ncDate'), $('rcDate'), $('ocDate'), $('srDate'), $('piDate')].forEach(el => el && el.addEventListener('input', (e) => {
  const pos = e.target.selectionStart;
  e.target.value = dateInputValue(e.target.value);
  try { e.target.setSelectionRange(pos, pos); } catch (_) {}
}));
function readItems(box) {
  box = box || 'prodRows';
  return [...$(box).querySelectorAll('.prod-row')].map(r => {
    const desc = (r.querySelector('.p-desc').value || '').trim().toUpperCase(), qty = Number(r.querySelector('.p-qty').value) || 0, price = Number(r.querySelector('.p-price').value) || 0, unit = (r.querySelector('.p-unit').value || '').trim().toUpperCase();
    return { desc, qty, unit, price, total: qty * price };
  }).filter(p => p.desc || p.qty || p.price);
}
/* Enter passa à linha de baixo (cria se preciso); autocomplete de produtos do stock */
function closeSugg() { document.querySelectorAll('.sugg,#suggPortal').forEach(d => { if(d._anchor?.tagName === 'SELECT' || d._anchor?.id==='sClient') {d._anchor.setAttribute('aria-expanded','false');d._anchor.removeAttribute('aria-activedescendant');} d.remove(); }); }
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#suggPortal')) return; // escolher sugestão não deve esconder o balão "Tinha/Fica"
  if (!e.target.closest || !e.target.closest('.prod-row')) { closeSugg(); const sp = $('stockPop'); if (sp) sp.style.display = 'none'; }
});
document.addEventListener('click', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('modal')) {
    if (e.target.id === 'invModal') closeInvModal();
    else if (e.target.id === 'prodModal') closeProdEditor();
    else e.target.style.display = 'none';
  }
  const h = e.target && e.target.closest ? e.target.closest('.panel.fold > h3, .panel.fold .panel-head') : null;
  if (h && !e.target.closest('button, input, select, label, textarea')) h.closest('.panel').classList.toggle('closed');
});
function denySaleStockPick(row, s, loc) {
  closeSugg();
  /* O balão mostra exactamente o que existe no local escolhido (Tinha/Fica). */
  stockPopShow(s.name, Number(row.querySelector('.p-qty').value) || 0, loc, row);
  const other = loc === 'armazem' ? 'loja' : 'armazem';
  const otherQty = stockQty(s.name, other);
  const msg = 'Sem stock ' + (loc === 'armazem' ? 'no Armazém' : 'na Loja') + ' — ' + s.name + '. '
    + (otherQty > 0
      ? 'Existe ' + otherQty + ' no ' + (other === 'armazem' ? 'Armazém' : 'Loja') + '. Troque o local de saída e selecione novamente.'
      : 'Dê entrada de stock antes de vender.');
  saleIssue(msg);
  toast('Sem stock — ' + s.name + ' não pode ser vendido.', 'error');
}
function pickStock(row, s) {
  /* Numa venda/crédito nunca se aceita escolher produto sem stock no local
     de saída. A cotação/proforma pode orçamentar mercadoria inexistente. */
  if (boxOf(row) === 'saleRows') {
    const type = ($('sType') || {}).value || 'venda';
    if (!billingMode() && type !== 'cotacao') {
      const loc = ($('sLoc') || {}).value === 'armazem' ? 'armazem' : 'loja';
      if (stockQty(s.name, loc) <= 0) { denySaleStockPick(row, s, loc); return; }
    }
  }
  if (boxOf(row) === 'saleRows') saleIssue('');
  row.querySelector('.p-desc').value = s.name;
  row.querySelector('.p-price').value = Number(boxOf(row) === 'saleRows' ? s.price : (s.cost != null ? s.cost : s.price) || 0).toFixed(2);
  const u = row.querySelector('.p-unit'); if (u && s.unit) u.value = s.unit;
  closeSugg(); recalcForm(boxOf(row));
  [...row.querySelectorAll('input')].forEach(paintClear);
  if (boxOf(row) === 'saleRows') stockPopShow(s.name, Number(row.querySelector('.p-qty').value) || 0, ($('sLoc') || {}).value, row);
  // Cria automaticamente nova linha para o próximo produto (só a partir da designação)
  try {
    const cont = row.parentElement;
    if (cont && !cont.dataset.fixed) {
      const rows = [...cont.querySelectorAll('.prod-row')];
      if (rows.indexOf(row) === rows.length - 1) {
        const r = prodRow(); cont.appendChild(r); recalcForm(boxOf(cont)); updateRemoveButtons(boxOf(cont));
      }
    }
  } catch (_) {}
  const q = row.querySelector('.p-qty'); if (q) q.focus();
}
let stockPopTimer = null;
function stockPopPos(anchor, box) {
  if (!anchor || !box) return;
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth || 230, h = box.offsetHeight || 54;
  const left = Math.min(Math.max(8, r.left), Math.max(8, (window.innerWidth || 0) - w - 8));
  let top = r.bottom + 6;
  if (top + h > (window.innerHeight || 0) - 8) top = Math.max(8, r.top - h - 6);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
function stockPopShow(name, reserve, loc, row) {
  if (billingMode()) return;
  let box = $('stockPop');
  if (!box) {
    box = document.createElement('div');
    box.id = 'stockPop'; box.className = 'stock-pop'; box.style.display = 'none';
    document.body.appendChild(box);
  }
  const s = stock.find(x => (x.name || '').toLowerCase() === String(name || '').trim().toLowerCase());
  const anchor = row ? row.querySelector('.p-desc') : null;
  if (!s || !row || !anchor) { box.style.display = 'none'; return; }
  loc = loc === 'armazem' ? 'armazem' : 'loja';
  const QL = Number(s.qLoja) || 0, QA = Number(s.qArm) || 0;
  const cur = loc === 'armazem' ? QA : QL;
  const fica = Math.max(0, cur - (reserve || 0));
  box.innerHTML = `<strong title="${esc(s.name)}">${esc(shortName(s.name))}</strong><br><span>Tinha: ${cur} | Fica: ${fica}</span>`;
  /* Fica num overlay do body, acima de tudo (o antigo ficava preso dentro da linha). */
  if (box.parentElement !== document.body) document.body.appendChild(box);
  box._anchor = anchor;
  box.style.position = 'fixed';
  box.style.zIndex = '10070';
  box.style.pointerEvents = 'none';
  box.style.display = 'block';
  stockPopPos(anchor, box);
  clearTimeout(stockPopTimer);
  stockPopTimer = setTimeout(() => { box.style.display = 'none'; }, 10000);
}
$('saleRows').addEventListener('input', (e) => {
  if (!e.target.classList || (!e.target.classList.contains('p-qty') && !e.target.classList.contains('p-unit'))) return;
  const row = e.target.closest ? e.target.closest('.prod-row') : null; if (!row) return;
  if (e.target.classList.contains('p-qty') && Number(e.target.value) > 0 && ($('saleIssue').textContent || '').indexOf('Quantidade inválida') >= 0) saleIssue('');
  stockPopShow(row.querySelector('.p-desc').value, Number(row.querySelector('.p-qty').value) || 0, ($('sLoc') || {}).value, row);
});
function suggPos(anchor, box) {
  if (!anchor || !box) return;
  const cell = anchor.closest('.desc-cell') || anchor.parentElement || anchor;
  const cr = cell.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  box.style.position = 'fixed';
  box.style.left = cr.left + 'px';
  box.style.width = Math.max(cr.width, 220) + 'px';
  const below = window.innerHeight - ar.bottom;
  if (below < 240 && ar.top > 240) {
    box.style.top = 'auto';
    box.style.bottom = (window.innerHeight - ar.top + 4) + 'px';
  } else {
    box.style.bottom = 'auto';
    box.style.top = (ar.bottom + 4) + 'px';
  }
}
function repositionProdBubbles() {
  const b = $('suggPortal');
  if (b && b._anchor) suggPos(b._anchor, b);
  const sp = $('stockPop');
  if (sp && sp._anchor && sp.style.display !== 'none') stockPopPos(sp._anchor, sp);
}
document.addEventListener('scroll', repositionProdBubbles, true);
window.addEventListener('resize', repositionProdBubbles);
function openCombo(input, opts) {
  if (!input) return;
  closeSugg();
  const list = (opts || []).filter(Boolean);
  if (!list.length) return;
  const box = document.createElement('div'); box.id = 'suggPortal'; box.className = 'sugg combo-list';
  box._anchor = input;
  list.forEach((v, ix) => {
    const it = document.createElement('div'); it.className = 'sugg-item' + (ix === 0 ? ' hi' : '');
    it.innerHTML = `<span class="sg-name">${esc(v)}</span>`;
    it.onclick = () => { input.value = v; closeSugg(); try { input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); } catch (_) {} };
    box.appendChild(it);
  });
  document.body.appendChild(box); suggPos(input, box);
}
let choosingClient=false;
function showClientSuggestions(all=false) {
  const input=$('sClient');if(!input || choosingClient) return;
  closeSugg();
  const query=all?'':clientNameKey(input.value);
  const matches=clients.filter(c=>!query || clientNameKey([c.name,c.phone,c.nuit,c.address].filter(Boolean).join(' ')).includes(query)).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
  const box=document.createElement('div');box.id='suggPortal';box.className='sugg combo-list client-options';box._anchor=input;box.setAttribute('role','listbox');box.setAttribute('aria-label','Clientes');
  if(!matches.length) {const empty=document.createElement('div');empty.className='sugg-empty';empty.textContent=clients.length?'Nenhum cliente encontrado.':'Não há clientes cadastrados. Peça ao administrador para cadastrar o cliente.';box.appendChild(empty);}
  matches.forEach((client,i)=>{
    const item=document.createElement('div');item.className='sugg-item';item.id='client-option-'+i;item.setAttribute('role','option');item.setAttribute('aria-selected','false');
    item.innerHTML='<span class="sg-name">'+esc(client.name)+'</span><span class="sg-sub">'+esc([client.address,client.phone,client.nuit].filter(Boolean).join(' · '))+'</span>';
    item.onmousedown=e=>e.preventDefault();
    item.onclick=()=>{choosingClient=true;input.value=client.name;input.dataset.clientId=client.id;closeSugg();input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.focus();choosingClient=false;};
    box.appendChild(item);
  });
  document.body.appendChild(box);suggPos(input,box);input.setAttribute('aria-controls','suggPortal');input.setAttribute('aria-expanded','true');
}
if($('sClient')) {
  $('sClient').addEventListener('input',()=>{if(choosingClient) return;delete $('sClient').dataset.clientId;showClientSuggestions();});
  $('sClient').addEventListener('focus',()=>showClientSuggestions(true));
  document.addEventListener('click',event=>{if(event.target===$('sClient')) showClientSuggestions(true);});
  $('sClient').addEventListener('blur',()=>setTimeout(()=>{if($('suggPortal')?._anchor===$('sClient') && document.activeElement!==$('sClient')) closeSugg();},0));
  $('sClient').addEventListener('keydown',event=>{
    if(event.key==='Escape'||event.key==='Tab') {closeSugg();return;}
    if(!['ArrowDown','ArrowUp','Enter'].includes(event.key)) return;
    const box=$('suggPortal');if(!box || box._anchor!==$('sClient')) {if(event.key.startsWith('Arrow')){event.preventDefault();showClientSuggestions(true);}return;}
    const items=[...box.querySelectorAll('.sugg-item')];if(!items.length) return;
    event.preventDefault();event.stopPropagation();let index=items.findIndex(item=>item.classList.contains('hi'));
    if(event.key==='Enter') {if(index>=0) items[index].click();else closeSugg();return;}
    index=event.key==='ArrowDown'?(index+1)%items.length:(index<0?items.length-1:(index-1+items.length)%items.length);
    items.forEach((item,i)=>{item.classList.toggle('hi',i===index);item.setAttribute('aria-selected',String(i===index));});$('sClient').setAttribute('aria-activedescendant',items[index].id);items[index].scrollIntoView?.({block:'nearest'});
  });
}
/* Todas as listas usam o mesmo menu das formas de pagamento. Mantém os
   selects originais para preservar valores, validação e eventos existentes. */
function openSelectMenu(select) {
  if (select.disabled || select.multiple || select.size > 1) return;
  closeSugg();
  const box = document.createElement('div');
  box.id = 'suggPortal'; box.className = 'sugg combo-list'; box._anchor = select;
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', select.labels?.[0]?.textContent || select.title || 'Opções');
  [...select.options].filter(option => !option.hidden).forEach(option => {
    const item = document.createElement('div');
    const disabled = option.disabled || (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled);
    item.className = 'sugg-item' + (option.selected ? ' hi' : '');
    item.textContent = option.textContent;
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
    if (disabled) { item.setAttribute('aria-disabled', 'true'); }
    else item.onclick = () => {
      const changed = select.selectedIndex !== option.index;
      select.selectedIndex = option.index; closeSugg(); select.focus();
      if (changed) { select.dispatchEvent(new Event('input', {bubbles:true})); select.dispatchEvent(new Event('change', {bubbles:true})); }
    };
    box.appendChild(item);
  });
  document.body.appendChild(box); suggPos(select, box);
  box.style.width = Math.max(select.getBoundingClientRect().width, 220) + 'px';
  box.style.left = select.getBoundingClientRect().left + 'px';
  select.setAttribute('aria-expanded', 'true');
}
document.addEventListener('mousedown', e => {
  const select = e.target.closest?.('select');
  if (!select || select.disabled || select.multiple || select.size > 1 || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation(); select.focus();
  if ($('suggPortal')?._anchor === select) closeSugg(); else openSelectMenu(select);
}, true);
document.addEventListener('click', e => {
  if (e.target.closest?.('select') && $('suggPortal')?._anchor === e.target) e.stopImmediatePropagation();
}, true);
document.addEventListener('keydown', e => {
  const select = e.target.closest?.('select');
  if (!select || select.disabled || select.multiple || select.size > 1) return;
  const box = $('suggPortal');
  if (e.key === 'Escape' || e.key === 'Tab') { closeSugg(); return; }
  if (!['ArrowDown','ArrowUp','Enter',' ','Home','End'].includes(e.key)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!box || box._anchor !== select) { openSelectMenu(select); return; }
  const items = [...box.querySelectorAll('.sugg-item:not([aria-disabled="true"])')];
  if (!items.length) return;
  let index = items.findIndex(item => item.classList.contains('hi'));
  if (e.key === 'Enter' || e.key === ' ') { (items[index] || items[0]).click(); return; }
  index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length-1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  items.forEach((item,i) => item.classList.toggle('hi', i === index));
  items[index].scrollIntoView?.({block:'nearest'});
}, true);
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.combo-btn') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const inp = $(b.dataset.combo); if (!inp) return;
  if(inp.id==='sClient') {inp.focus();showClientSuggestions(true);return;}
  openCombo(inp, (typeof payMethods !== 'undefined' ? payMethods : []).slice(0, 40));
}, true);
function showStockSuggestions(input, allowAll, onPick, onlyStock) {
  if (!input) return;
  closeSugg();
  const sp = $('stockPop'); if (sp) sp.style.display = 'none';
  const q = String(input.value || '').trim().toLowerCase();
  if (!q && !allowAll) return;   // ao limpar a pesquisa, fecha (o clique/foco é que abre a lista completa)
  /* Ao clicar/focar sem pesquisa, mostra os produtos que realmente têm stock.
     Se houver muitos, limita a lista; ao digitar, filtra normalmente.
     onlyStock=true (Declarar Saída) nunca mostra produtos a zero. */
  const base = stock.filter(s => {
    const has = billingMode() || stockTotal(s) > 0;
    if (onlyStock) return has && (!q || (s.name || '').toLowerCase().includes(q));
    return !q || (s.name || '').toLowerCase().includes(q);
  });
  const hits = [...base].sort((a, b) => {
    const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase();
    const as = q && an.startsWith(q) ? 0 : 1, bs = q && bn.startsWith(q) ? 0 : 1;
    return as - bs || an.localeCompare(bn);
  }).slice(0, q ? 8 : 20);
  if (!hits.length) return;
  const box = document.createElement('div'); box.id = 'suggPortal'; box.className = 'sugg';
  box._anchor = input;
  if (!q) {
    const head = document.createElement('div');
    head.className = 'sugg-head';
    head.textContent = onlyStock ? 'Produtos com stock — clique para escolher' : 'Produtos — clique para escolher';
    box.appendChild(head);
  }
  hits.forEach((s, ix) => {
    const disp = stockAvail(s);
    const it = document.createElement('div');
    // Só a pesquisa digitada auto-seleciona o primeiro; a lista aberta por
    // clique/foco espera uma seta ou um clique para não alterar o Enter comum.
    it.className = 'sugg-item' + (ix === 0 && !allowAll ? ' hi' : '');
    it.innerHTML = `<span class="sg-name">${esc(s.name)}</span><span class="sg-sub">${MZN(s.price)} · Disp: ${disp} (Loja: ${Number(s.qLoja) || 0} · Arm: ${Number(s.qArm) || 0})</span>`;
    if (billingMode()) it.querySelector('.sg-sub').textContent = fmtMoney(s.price);
    it.onclick = () => {
      if (onPick) onPick(s);
      else {
        const row = input.closest('.prod-row');
        if (row) pickStock(row, s);
      }
    };
    box.appendChild(it);
  });
  document.body.appendChild(box);
  suggPos(input, box);
}
function showProdSuggestions(input, allowAll) {
  if (!input || !input.closest('.prod-row')) return;
  showStockSuggestions(input, allowAll, s => pickStock(input.closest('.prod-row'), s), false);
}
function onProdInput(e) {
  if (!e.target.classList || !e.target.classList.contains('p-desc')) return;
  showProdSuggestions(e.target);
}
function onProdFocus(e) {
  const t = e.target;
  if (!t || !t.classList || !t.classList.contains('p-desc')) return;
  const box = $('suggPortal');
  if (box) {
    if (box._anchor === t) return;   // já está aberta para esta input
    closeSugg();                     // passou para outra linha/input
  }
  showProdSuggestions(t, true);
}
document.addEventListener('focusin', onProdFocus);
document.addEventListener('click', onProdFocus);
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || !t.classList || t.classList.contains('p-desc')) return;
  if (t.closest && t.closest('.prod-row')) closeSugg();
});
function onProdKey(e) {
  const row = e.target.closest ? e.target.closest('.prod-row') : null; if (!row) return;
  if (e.key === 'Escape') { closeSugg(); return; }
  const openBox = $('suggPortal');
  if (openBox && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
    const items = [...openBox.querySelectorAll('.sugg-item')];
    if (!items.length) return;
    let hi = items.findIndex(x => x.classList.contains('hi'));
    // Lista aberta só por foco/clique e ainda sem seleção: Enter comum mantém
    // o comportamento antigo (fecha a lista e passa à quantidade).
    if (e.key === 'Enter' && hi < 0) { closeSugg(); }
    else {
      e.preventDefault();
      if (e.key === 'Enter') { (items[hi] || items[0]).click(); return; }
      hi = e.key === 'ArrowDown' ? hi + 1 : hi - 1;
      if (hi < 0 || hi >= items.length) hi = e.key === 'ArrowDown' ? 0 : items.length - 1;
      items.forEach(x => x.classList.remove('hi'));
      items[hi].classList.add('hi');
      if (items[hi].scrollIntoView) { try { items[hi].scrollIntoView({ block: 'nearest' }); } catch (_) {} }
      return;
    }
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  formatMoneyInput(e.target);
  const cont = row.parentElement;
  if (cont.dataset.fixed) return;
  const order = ['p-desc', 'p-qty', 'p-unit', 'p-price'];
  const cur = order.findIndex(c => e.target.classList.contains(c));
  const rows = [...cont.querySelectorAll('.prod-row')];
  const i = rows.indexOf(row);
  const isLast = i === rows.length - 1;
  const focusIn = (r, c) => { const f = r.querySelector('.' + c); if (f) f.focus(); };
  // Enter na DESIGNAÇÃO: abre o próximo produto (cria nova linha se for a última),
  // mesmo sem quantidade. Tab continua a navegar entre os campos.
  if (cur === 0) {
    const d = row.querySelector('.p-desc').value.trim();
    if (d) {
      if (isLast) {
        const r = prodRow(); cont.appendChild(r); recalcForm(boxOf(cont)); updateRemoveButtons(boxOf(cont));
        const nd = r.querySelector('.p-desc'); if (nd) nd.focus(); return;
      }
      const nx = rows[i + 1].querySelector('.p-desc'); if (nx) { nx.focus(); return; }
    }
    focusIn(row, 'p-qty');
    return;
  }
  
  // Enter na QTD: move para QTD da linha de baixo, ou permanece se for a última
  if (cur === 1) {
    if (i !== -1 && i < rows.length - 1) focusIn(rows[i + 1], 'p-qty');
    return;
  }
  
  // Enter na UNIDADE: move para PREÇO da mesma linha
  if (cur === 2) { focusIn(row, 'p-price'); return; }
  
  // Enter no PREÇO: move p/ PREÇO de baixo; se última, PERMANECE (NUNCA cria nova linha)
  if (cur === 3) {
    if (i !== -1 && i < rows.length - 1) focusIn(rows[i + 1], 'p-price');
    return;
  }

  if (i !== -1 && i < rows.length - 1) { const d = rows[i + 1].querySelector('.p-desc'); if (d) d.focus(); }
}
/* Enter do teclado numérico: descrição → quantidade → Valor Recebido → Guardar.
   O Enter comum mantém exatamente o comportamento anterior. */
function isNumpadEnter(e) {
  return !!e && (e.code === 'NumpadEnter' || (e.key === 'Enter' && e.location === 3));
}
function numpadSaleFlow(e) {
  if (!isNumpadEnter(e)) return;
  const t = e.target;
  if (!t || !t.closest) return;
  const form = $('saleFormPanel');
  if (!form || form.style.display === 'none') return;
  if (t.id === 'sPaid') {
    e.preventDefault(); e.stopPropagation();
    const save = $('btnSaveSale');
    if (save) save.click();
    return;
  }
  const row = t.closest('#saleRows .prod-row');
  if (!row || !t.matches || !t.matches('input')) return;
  e.preventDefault(); e.stopPropagation();
  if (t.classList.contains('p-desc')) {
    const q = row.querySelector('.p-qty');
    if (q) { q.focus(); try { q.select(); } catch (_) {} }
    return;
  }
  const paid = $('sPaid');
  if (paid) { paid.focus(); try { paid.select(); } catch (_) {} }
}
document.addEventListener('keydown', numpadSaleFlow, true);
function formatMoneyInput(el) {
  try {
    if (!el || !el.classList) return;
    if (el.classList.contains('p-price') || el.classList.contains('money')) {
      const v = el.value;
      if (v === '' || v == null) return;
      const n = parseMoney(v);
      // Inputs texto (modal) exibem milhares; inputs number mantêm formato simples
      el.value = el.type === 'number' ? (Math.round(n * 100) / 100).toFixed(2) : fmtMoney(n);
      const bx = boxOf(el); if (bx && $(bx)) recalcForm(bx);
    }
  } catch (_) {}
}
$('prodRows').addEventListener('input', onProdInput);
$('prodRows').addEventListener('keydown', onProdKey);
$('saleRows').addEventListener('input', onProdInput);
$('saleRows').addEventListener('keydown', onProdKey);
document.addEventListener('focusout', (e) => { if (e.target && e.target.classList && (e.target.classList.contains('p-price') || e.target.classList.contains('money'))) formatMoneyInput(e.target); });
$('ocRows').addEventListener('input', onProdInput);
$('ocRows').addEventListener('keydown', onProdKey);
$('ncRows').addEventListener('input', onProdInput);
$('ncRows').addEventListener('keydown', onProdKey);
$('srRows').addEventListener('input', onProdInput);
$('srRows').addEventListener('keydown', onProdKey);
let saleGrand = 0;
function updateSaleChange() {
  const paidEl = $('sPaid'), info = $('saleChangeInfo');
  if (!paidEl || !info) return { total: 0, received: 0, change: 0 };
  const total = Number(saleGrand) || 0;
  const type = ($('sType') || {}).value || 'venda';
  const raw = String(paidEl.value || '').trim();
  const received = raw === '' ? (type === 'venda' ? total : 0) : parseMoney(raw);
  const change = type === 'venda' ? Math.max(0, Math.round((received - total) * 100) / 100) : 0;
  const show = type === 'venda' && total > 0 && received > total;
  info.style.display = show ? 'flex' : 'none';
  if ($('sReceived')) $('sReceived').textContent = MZN(received);
  if ($('sChange')) $('sChange').textContent = MZN(change);
  return { total, received, change };
}
let saleIssueTimer,saleIssueHideTimer;
function saleIssue(msg) {
 clearTimeout(saleIssueTimer);clearTimeout(saleIssueHideTimer);
  const el = $('saleIssue');
  if (el) {
    el.classList.remove('sale-issue-exit');
    if(msg) saleIssueTimer=setTimeout(()=>{el.classList.add('sale-issue-exit');saleIssueHideTimer=setTimeout(()=>{el.style.display='none';el.innerHTML='';},300);},7000);
    el.innerHTML = msg ? '<strong>'+ (billingMode()?'Fatura não emitida':'Venda não registada') +'</strong>' + esc(msg) : '';
    el.style.display = msg ? 'block' : 'none';
    if (msg) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
  }
}
/* ---------- calculadora da venda (substitui a card, não mexe nos totais) ---------- */
let calcOpen = false;
let calcExpr = '';
let calcShown = '0';
let calcHist = '';
let calcDone = false;
let calcPrevForm = false;
let calcPrevItems = false;
let calcPrevBar = false;
let calcReturnView = null;
let calcOpening = false;
function calcPretty(s) { return String(s == null ? '' : s).replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−'); }
function calcFmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 'Erro';
  const r = Math.round(n * 1e10) / 1e10;
  return String(r);
}
function calcRender() {
  const d = $('calcDisplay'); if (d) d.textContent = calcShown || '0';
  const h = $('calcHistory'); if (h) h.textContent = calcHist || '';
}
function calcReset() { calcExpr = ''; calcShown = '0'; calcHist = ''; calcDone = false; calcRender(); }
function calcEval(expr) {
  let clean = String(expr || '').replace(/[^0-9+\-*/.()]/g, '');
  clean = clean.replace(/[+\-*/.]+$/, '');
  if (!clean) return NaN;
  try {
    const v = Function('"use strict";return (' + clean + ')')();
    return typeof v === 'number' ? v : NaN;
  } catch (_) { return NaN; }
}
function calcCurrentValue() {
  if (calcDone) return Number(calcExpr) || 0;
  const v = calcEval(calcExpr);
  return isFinite(v) ? v : 0;
}
function calcEvaluate() {
  if (!calcExpr) return;
  const raw = calcExpr;
  const n = calcEval(raw);
  if (!isFinite(n)) {
    calcShown = 'Erro'; calcHist = calcPretty(raw); calcExpr = ''; calcDone = false; calcRender(); return;
  }
  const res = Math.round(n * 1e10) / 1e10;
  calcHist = calcPretty(raw) + ' =';
  calcExpr = String(res);
  calcShown = calcFmt(res);
  calcDone = true;
  calcRender();
}
function calcInput(k) {
  k = String(k == null ? '' : k);
  if (k === 'C') return calcReset();
  if (k === 'back') {
    if (calcDone) calcDone = false;
    calcExpr = calcExpr.slice(0, -1);
    calcShown = calcPretty(calcExpr) || '0';
    calcHist = '';
    calcRender();
    return;
  }
  if (k === '=') return calcEvaluate();
  if (k === '%') {
    const n = calcCurrentValue() / 100;
    calcHist = calcPretty(calcExpr || '0') + ' %';
    calcExpr = String(Math.round(n * 1e10) / 1e10);
    calcShown = calcFmt(n);
    calcDone = true;
    calcRender();
    return;
  }
  if (k === '+' || k === '-' || k === '*' || k === '/') {
    if (calcDone) { calcDone = false; calcHist = ''; }
    if (!calcExpr) calcExpr = '0';
    if (/[+\-*/]$/.test(calcExpr)) calcExpr = calcExpr.slice(0, -1);
    calcExpr += k;
    calcShown = calcPretty(calcExpr);
    calcRender();
    return;
  }
  if (k === '.' || k === ',') {
    if (calcDone) { calcExpr = '0'; calcDone = false; calcHist = ''; }
    const last = calcExpr.split(/[+\-*/]/).pop() || '';
    if (last.indexOf('.') >= 0) return;
    calcExpr += (last === '' ? '0.' : '.');
    calcShown = calcPretty(calcExpr);
    calcRender();
    return;
  }
  if (/^\d$/.test(k)) {
    if (calcDone) { calcExpr = ''; calcDone = false; calcHist = ''; }
    calcExpr += k;
    calcShown = calcPretty(calcExpr);
    calcRender();
  }
}
function calcHideOnly() {
  calcOpen = false;
  calcReturnView = null;
  if ($('calcPanel')) $('calcPanel').style.display = 'none';
  const sv = $('view-sales'); if (sv) sv.classList.remove('calc-mode');
}
function openCalc(seed) {
  if (calcOpen || !$('calcPanel')) return;
  const views = ['dashboard', 'sales', 'clients', 'suppliers', 'pays', 'products', 'settings', 'notifs', 'issued', 'cash'];
  const active = views.find(v => $('view-' + v) && $('view-' + v).style.display !== 'none');
  if (active && active !== 'sales') {
    calcReturnView = active;
    calcOpening = true;
    try { goViewNow('sales', false); } catch (_) {}
    calcOpening = false;
  } else {
    calcReturnView = null;
  }
  calcPrevForm = !!($('saleFormPanel') && $('saleFormPanel').style.display !== 'none');
  calcPrevItems = !!($('saleItemsPanel') && $('saleItemsPanel').style.display !== 'none');
  calcPrevBar = !!($('saleBar') && $('saleBar').style.display !== 'none');
  calcOpen = true;
  const sv = $('view-sales'); if (sv) sv.classList.add('calc-mode');
  if ($('saleChoiceWrap')) $('saleChoiceWrap').style.display = 'none';
  $('saleFormPanel').style.display = 'none';
  $('calcPanel').style.display = 'block';
  calcReset();
  if (seed) calcInput(seed);
  try { $('calcPanel').focus(); } catch (_) {}
}
function closeCalc() {
  if (!calcOpen) return;
  const ret = calcReturnView;
  calcOpen = false;
  if ($('calcPanel')) $('calcPanel').style.display = 'none';
  const sv = $('view-sales'); if (sv) sv.classList.remove('calc-mode');
  if (ret) { calcReturnView = null; try { goViewNow(ret); } catch (_) {} return; }
  if (calcPrevForm) {
    $('saleFormPanel').style.display = 'block';
    if ($('saleItemsPanel')) $('saleItemsPanel').style.display = calcPrevItems ? 'flex' : 'none';
    if ($('saleBar')) $('saleBar').style.display = calcPrevBar ? 'flex' : 'none';
  } else {
    try { showSaleChoice(); } catch (_) {}
  }
}
function toggleCalc() { if (calcOpen) closeCalc(); else openCalc(); }
function calcModalOpen() {
  return [...document.querySelectorAll('.modal')].some(m => m && (m.style.display === 'flex' || m.style.display === 'block'));
}
function calcKeydown(e) {
  const app = $('app'); if (!app || app.style.display === 'none') return;
  if (calcOpen) {
    if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); closeCalc(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCalc(); return; }
    const t = e.target;
    if (t && t.closest && t.closest('#calcPanel button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'Tab') return;
    if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); calcInput('back'); return; }
    if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); calcInput('C'); return; }
    if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); e.stopPropagation(); calcInput('='); return; }
    if (e.key === '.' || e.key === ',') { e.preventDefault(); e.stopPropagation(); calcInput('.'); return; }
    if (/^\d$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); calcInput(e.key); return; }
    if (e.key === '+' || e.key === '-' || e.key === '*' || e.key === '/' || e.key === '%') { e.preventDefault(); e.stopPropagation(); calcInput(e.key); return; }
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault(); e.stopPropagation();
    if (!calcModalOpen()) toggleCalc();
    return;
  }
  if (e.key !== '+' && e.key !== '-' && e.key !== '*' && e.key !== '/') return;
  const t = e.target;
  if (!t || !t.closest) return;
  const inCard = !!t.closest('#saleFormPanel');
  if (!inCard) {
    if (t !== document.body && t !== document.documentElement) return;
    if (!$('saleFormPanel') || $('saleFormPanel').style.display === 'none') return;
  }
  if (calcModalOpen()) return;
  const tag = (t.tagName || '').toUpperCase();
  if (inCard && (tag === 'SELECT' || tag === 'TEXTAREA')) return;
  if (inCard && tag === 'INPUT' && t.id !== 'sPaid') return;
  e.preventDefault(); e.stopPropagation();
  openCalc(e.key);
}
document.addEventListener('keydown', calcKeydown, true);
if ($('btnCalcOpen')) $('btnCalcOpen').onclick = () => openCalc();
if ($('btnCalcClose')) $('btnCalcClose').onclick = () => closeCalc();
if ($('calcPanel')) $('calcPanel').addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-calc]') : null;
  if (b) calcInput(b.dataset.calc);
});
function recalcForm(box) {
  box = box || 'prodRows';
  // Totais calculados linha a linha (evita desalinhamento quando há linhas vazias)
  let grand = 0;
  const rows = [...document.querySelectorAll('#' + box + ' .prod-row')];
  rows.forEach(r => {
    const qty = Number(r.querySelector('.p-qty').value) || 0;
    const price = Number(r.querySelector('.p-price').value) || 0;
    const t = qty * price; grand += t;
    r.querySelector('.prod-total').textContent = MZN(t);
  });
  updateRemoveButtons(box);
  $(TOTAL_EL[box] || 'fTotal').textContent = MZN(grand);
  if (box === 'saleRows') {
    saleGrand = grand;
    updateSaleChange();
  }
  if (box === 'saleRows' && $('saleItemsCount')) {
    const n = rows.filter(r => (r.querySelector('.p-desc').value || '').trim()).length;
    $('saleItemsCount').textContent = n ? n + ' produto(s)' : '';
  }
  return readItems(box);
}
$('btnSaveInv').onclick = () => {
  if (!currentSup) return;
  const items = recalcForm();
  if (!items.length) return toast('Adicione pelo menos 1 produto.', 'warning');
  const number = $('fNumber').value.trim() || ('FT ' + new Date().getFullYear() + '/' + String(invoices.length + 1).padStart(3, '0'));
  const date = parseBRDate($('fDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const total = items.reduce((s, p) => s + p.total, 0);
  const data = { date, number, items, total, paid: parseMoney($('fPaid').value), payMethod: $('fPay').value.trim() || 'Numerário', notes: $('fNotes').value.trim(), loc: 'armazem', updatedAt: Date.now() };
  if (!payMethods.includes(data.payMethod)) { payMethods.push(data.payMethod); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); }
  let unitsChanged = false;
  items.forEach(p => { if (p.unit && !units.includes(p.unit)) { units.push(p.unit); unitsChanged = true; } });
  if (unitsChanged) pushQueue({ type: 'settings', payload: { key: 'units', list: units } });
  renderPayUnits();
  if (editingInvId) {
    const inv = invoices.find(i => i.id === editingInvId);
    if (inv) { const oldLoc = inv.loc || 'loja'; stockApply(inv.items, -1, true, inv.number, oldLoc); Object.assign(inv, data); stockApply(inv.items, +1, true, inv.number, inv.loc || 'loja'); pushQueue({ type: 'invoice', payload: { ...inv } }); }
    toast('Fatura atualizada.', 'success');
  } else {
    const inv = { id: uid(), supplierId: currentSup.id, createdAt: Date.now(), ...data };
    invoices.push(inv); pushQueue({ type: 'invoice', payload: inv });
    stockApply(inv.items, +1, true, inv.number, inv.loc || 'loja');
    if (inv.paid > 0) {
      // o valor pago no registo da fatura fica registado como pagamento (PAG) e aparece em Pagamentos
      supPayments.push({ id: uid(), supplierId: currentSup.id, invoiceId: inv.id, number: nextSupPayNumber(), date: inv.date, amount: inv.paid, method: inv.payMethod, notes: 'Pago no registo da fatura ' + inv.number, initial: true, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
      pushQueue({ type: 'suppay', payload: { ...supPayments[supPayments.length - 1] } });
      cashAdd(inv.date, 'saida', 'Pagamento a fornecedor', inv.paid, inv.payMethod, inv.number, currentSup.name, true);
    }
    toast('Fatura registada.', 'success');
  }
  resetInvForm();
  $('invModal').style.display = 'none';
  renderAll(); renderDetail();
};
let editingInvId = null;
let dragId = null;
function dropInvoice(fromId, toId) {
  dragId = null;
  const a = invoices.find(i => i.id === fromId), b = invoices.find(i => i.id === toId);
  if (!a || !b || a.id === b.id || a.supplierId !== b.supplierId || a.date === b.date) return;
  const d = a.date; a.date = b.date; b.date = d;
  a.updatedAt = b.updatedAt = Date.now();
  pushQueue({ type: 'invoice', payload: { ...a } });
  pushQueue({ type: 'invoice', payload: { ...b } });
  persist(); renderAll(); renderDetail();
  toast('Posição ajustada: datas ' + fmtDate(a.date) + ' ↔ ' + fmtDate(b.date) + '.', 'success');
}
function editInvoice(id) {
  const inv = invoices.find(i => i.id === id); if (!inv) return;
  editingInvId = id;
  $('invModal').style.display = 'flex';
  $('invFormTitle').textContent = 'Editar Fatura';
  $('fDate').value = fmtDate(inv.date); $('fNumber').value = inv.number;
  $('fPaid').value = fmtMoney(inv.paid); $('fPay').value = inv.payMethod; $('fNotes').value = inv.notes || '';
  $('prodRows').innerHTML = '';
  inv.items.forEach(p => $('prodRows').appendChild(prodRow(p.desc, p.qty, p.price, p.unit || '')));
  recalcForm();
  $('btnSaveInv').textContent = 'Atualizar';
}
function resetInvForm() {
  editingInvId = null;
  $('btnSaveInv').textContent = 'Salvar';
  $('invFormTitle').textContent = 'Nova Fatura';
  $('fDate').value = fmtDate(todayISO()); $('fNumber').value = ''; $('fPaid').value = '0.00'; $('fNotes').value = '';
  resetProdRows();
}

/* ---------- acerto de saldo do fornecedor (ex.: saldo negativo) ---------- */
function renderSupAdj() {
  const panel = $('supBalPanel'); if (!panel) return;
  if (!currentSup) { panel.style.display = 'none'; return; }
  const bal = supEffective(currentSup.id);
  panel.hidden = true;
  panel.style.display = 'none';
  if ($('supBalVal')) $('supBalVal').textContent = 'Saldo atual: ' + MZN(bal);
  if ($('supAdjNote')) $('supAdjNote').textContent = bal < 0
    ? 'Saldo negativo (o fornecedor está a crédito): pode deixar em 0 ou no valor correto.'
    : 'Corrige contas antigas (ex.: saldo negativo) sem alterar as faturas.';
  if ($('btnSupAdj')) $('btnSupAdj').style.display = currentRole() === 'admin' ? '' : 'none';
  const list = supAdjustments.filter(a => a.supplierId === currentSup.id).sort((a, b) => String(b.date + (b.ts || 0)).localeCompare(String(a.date + (a.ts || 0))));
  const wrap = $('supAdjWrap');
  if (wrap) {
    wrap.style.display = list.length ? '' : 'none';
    const tb = $('supAdjTable') ? $('supAdjTable').querySelector('tbody') : null;
    if (tb) {
      tb.innerHTML = '';
      list.forEach(a => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + fmtDate(a.date) + '</td><td style="text-align:right"><strong>' + (Number(a.amount) >= 0 ? '+' : '−') + MZN(Math.abs(Number(a.amount) || 0)) + '</strong></td><td>' + esc(a.reason || '—') + '</td>'
          + '<td class="col-act"><button type="button" class="row-del" title="Remover ajuste">' + ICO_DEL + '</button></td>';
        tr.querySelector('.row-del').onclick = async () => {
          if (currentRole() !== 'admin') return toast('Só o administrador pode remover ajustes.', 'warning');
          if (!await confirmDlg('Remover ajuste?', fmtDate(a.date) + ' — ' + MZN(Number(a.amount) || 0) + ' (' + (a.reason || 'sem motivo') + ')')) return;
          supAdjustments = supAdjustments.filter(x => x.id !== a.id);
          pushQueue({ type: 'delete-supadj', payload: { id: a.id } });
          persist(); renderAll(); renderDetail(); toast('Ajuste removido.', 'success');
        };
        tb.appendChild(tr);
      });
    }
  }
}
if ($('btnSupAdj')) $('btnSupAdj').onclick = () => {
  if (!currentSup) return;
  if (currentRole() !== 'admin') return toast('Só o administrador pode ajustar saldos.', 'warning');
  const bal = supEffective(currentSup.id);
  $('supAdjInfo').textContent = currentSup.name + ' — saldo atual ' + MZN(bal) + '. Indique o saldo que deve ficar (0 para zerar).';
  $('supAdjTarget').value = '0.00';
  $('supAdjReason').value = '';
  $('supAdjModal').style.display = 'flex';
  setTimeout(() => { try { $('supAdjTarget').focus(); $('supAdjTarget').select(); } catch (_) {} }, 30);
};
if ($('btnCancelSupAdj')) $('btnCancelSupAdj').onclick = () => { $('supAdjModal').style.display = 'none'; };
if ($('supAdjModal')) $('supAdjModal').addEventListener('click', (e) => { if (e.target === $('supAdjModal')) $('supAdjModal').style.display = 'none'; });
if ($('btnSaveSupAdj')) $('btnSaveSupAdj').onclick = () => {
  if (!currentSup) return;
  if (currentRole() !== 'admin') return toast('Só o administrador pode ajustar saldos.', 'warning');
  const bal = Math.round(supEffective(currentSup.id) * 100) / 100;
  const target = $('supAdjTarget').value === '' ? 0 : parseMoney($('supAdjTarget').value);
  const delta = Math.round((target - bal) * 100) / 100;
  if (!delta) { $('supAdjModal').style.display = 'none'; return toast('O saldo já está nesse valor.', 'info'); }
  const a = {
    id: uid(), supplierId: currentSup.id, date: todayISO(), amount: delta,
    reason: $('supAdjReason').value.trim() || (bal < 0 ? 'Acerto de saldo negativo (crédito)' : 'Acerto de saldo'),
    by: currentUser, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now()
  };
  supAdjustments.push(a);
  pushQueue({ type: 'supadj', payload: { ...a } });
  persist(); renderAll(); renderDetail();
  $('supAdjModal').style.display = 'none';
  toast('Saldo ajustado: ' + MZN(bal) + ' → ' + MZN(target) + '.', 'success');
};
function renderDetail() {
  if (!currentSup) return;
  renderSupAdj(); renderSupPay(); renderOc(); renderSupRet();
  const tb = $('invTable').querySelector('tbody'); tb.innerHTML = '';
  const list = withBalances(currentSup.id);
  $('invCount').textContent = list.length ? '(' + list.length + ' fatura(s))' : '(sem faturas)';
  list.forEach(r => {
    const tr = document.createElement('tr');
    tr.className = 'acc-sum';
    const paidShown = (Number(r.paid) || 0) + supInvExtra(r.id);
    const isPaid = Number(r.total) > 0 && supInvRemaining(r) <= 0;
    tr.innerHTML = `<td><span class="inv-acc-toggle">▶</span> ${fmtDate(r.date)}</td><td><strong>${esc(r.number)}</strong>${isPaid ? ' <span class="ok-badge">PAGA</span>' : ''}</td><td style="text-align:right">${MZN(r.oldBalance)}</td><td style="text-align:right"><strong>${MZN(r.total)}</strong></td><td style="text-align:right">${MZN(paidShown)}</td><td style="text-align:right"><strong>${MZN(r.newBalance)}</strong></td>`;
    const det = document.createElement('tr');
    det.className = 'inv-acc-detail'; det.style.display = 'none';
    const des = r.items.map(p => p.desc).join('\n'), q = r.items.map(p => fmtQty(p)).join('\n'),
      pu = r.items.map(p => MZN(p.price)).join('\n'), tp = r.items.map(p => MZN(p.total)).join('\n');
    det.innerHTML = `<td colspan="6"><div class="table-wrap"><table><thead><tr><th>Qtd</th><th>Designação</th><th>Preço Unit.</th><th>Total Prod.</th><th>Forma Pag.</th><th>Notas</th><th class="col-act">Ações</th></tr></thead><tbody><tr><td class="wrap">${q}</td><td class="wrap">${esc(des)}</td><td class="wrap" style="text-align:right">${pu}</td><td class="wrap" style="text-align:right">${tp}</td><td>${esc(r.payMethod)}</td><td>${esc(r.notes)}</td><td class="col-act"><button type="button" class="row-edit" title="Editar fatura">${ICO_EDIT}</button> <button type="button" class="row-del" title="Remover fatura">${ICO_DEL}</button></td></tr></tbody></table></div></td>`;
    const toggle = () => { const open = det.style.display !== 'none'; det.style.display = open ? 'none' : 'table-row'; tr.classList.toggle('acc-open', !open); };
    tr.onclick = (e) => { if (e.target.closest('button')) return; toggle(); };
    tr.querySelector('.inv-acc-toggle').onclick = toggle;
    det.querySelector('.row-del').onclick = () => deleteInvoice(r.id, r.number);
    det.querySelector('.row-edit').onclick = () => editInvoice(r.id);
    tr.draggable = true;
    tr.title = 'Clicar para expandir · Arrastar para reordenar';
    tr.ondragstart = (ev) => { dragId = r.id; ev.dataTransfer.effectAllowed = 'move'; tr.classList.add('dragging'); };
    tr.ondragend = () => { dragId = null; tr.classList.remove('dragging'); document.querySelectorAll('#invTable tr.drop-above').forEach(x => x.classList.remove('drop-above')); };
    tr.ondragover = (ev) => { if (!dragId || dragId === r.id) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; tr.classList.add('drop-above'); };
    tr.ondragleave = () => tr.classList.remove('drop-above');
    tr.ondrop = (ev) => { ev.preventDefault(); tr.classList.remove('drop-above'); dropInvoice(dragId, r.id); };
    tb.appendChild(tr); tb.appendChild(det);
  });
}
async function deleteInvoice(id, number) {
  const ok = await confirmDlg('Remover fatura?', `A fatura "${number}" será apagada deste dispositivo e da nuvem. Os saldos seguintes serão recalculados.`);
  if (!ok) return;
  pushQueue({ type: 'delete-invoice', payload: { id } });
  const gone = invoices.find(i => i.id === id);
  if (gone) stockApply(gone.items, -1, true, gone.number, gone.loc || 'loja');
  invoices = invoices.filter(i => i.id !== id);
  persist(); renderAll(); renderDetail(); toast('Fatura removida.', 'success');
}
$('viewSimple').onchange = (e) => { $('printArea').classList.toggle('simple', e.target.checked); };

/* ---------- pagamentos ao fornecedor ---------- */
function renderSupPay() {
  if (!currentSup || !$('supPayTable')) return;
  const tb = $('supPayTable').querySelector('tbody'); tb.innerHTML = '';
  const list = supPayments.filter(p => p.supplierId === currentSup.id).sort((a, b) => String(a.date + (a.ts || 0)).localeCompare(String(b.date + (b.ts || 0))));
  const lastDate = (() => { const l = withBalances(currentSup.id); return l.length ? l[l.length - 1].date : ''; })();
  const sd = $('supDebt'); if (sd) sd.textContent = '';
  list.forEach(p => {
    const applied = p.date <= lastDate;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(p.date)}</td><td>${esc(p.number)}</td><td style="text-align:right"><strong>${MZN(p.amount)}</strong></td><td>${esc(p.method)}</td><td>${esc(p.notes || '')}</td><td>${applied ? 'Aplicado' : 'Pendente'}</td><td class="col-act"><button type="button" class="row-del" title="Remover pagamento">${ICO_DEL}</button></td>`;
    tr.querySelector('.row-del').onclick = async () => {
      if (!await confirmDlg('Remover pagamento?', `Apagar "${p.number}" de ${MZN(p.amount)}? Os saldos serão recalculados.`)) return;
      pushQueue({ type: 'delete-suppay', payload: { id: p.id } });
      supPayments = supPayments.filter(x => x.id !== p.id);
      persist(); renderAll(); renderSupPay();
    };
    tb.appendChild(tr);
  });
}
if ($('btnSaveSupPay')) $('btnSaveSupPay').onclick = () => {
  if (!currentSup) return;
  const date = parseBRDate($('spDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const amount = parseMoney($('spAmount').value);
  if (amount <= 0) return toast('Indique o valor pago.', 'warning');
  const pm = $('spMethod').value.trim() || 'Numerário';
  if (!payMethods.includes(pm)) { payMethods.push(pm); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); renderPayUnits(); }
  const p = { id: uid(), supplierId: currentSup.id, number: nextSupPayNumber(), date, amount, method: pm, notes: $('spNotes').value.trim(), ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  supPayments.push(p); pushQueue({ type: 'suppay', payload: { ...p } });
  cashAdd(date, 'saida', 'Pagamento a fornecedor', amount, pm, p.number, currentSup.name, true);
  $('spAmount').value = ''; $('spNotes').value = '';
  persist(); renderAll(); renderSupPay();
  toast('Pagamento registado e lançado na caixa.', 'success');
};

/* ---------- ordens de compra (OC) ---------- */
let ocSupId = null;
function nextOcNumber() {
  const y = new Date().getFullYear();
  const n = porders.filter(o => String(o.number || '').indexOf('OC ' + y) === 0).length + 1;
  return 'OC ' + y + '/' + String(n).padStart(3, '0');
}
function openOc(supId) {
  const s = suppliers.find(x => x.id === supId); if (!s) return;
  ocSupId = supId;
  $('ocSupInfo').textContent = s.name;
  $('ocDate').value = fmtDate(todayISO()); $('ocNumber').value = nextOcNumber(); $('ocNotes').value = '';
  $('ocRows').innerHTML = ''; $('ocRows').appendChild(prodRow()); recalcForm('ocRows');
  $('ocModal').style.display = 'flex';
}
$('btnCancelOc').onclick = () => { $('ocModal').style.display = 'none'; };
$('btnSaveOc').onclick = () => {
  const sup = suppliers.find(x => x.id === ocSupId); if (!sup) return;
  const items = readItems('ocRows');
  if (!items.length) return toast('Adicione produtos.', 'warning');
  const date = parseBRDate($('ocDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const o = { id: uid(), supplierId: sup.id, number: $('ocNumber').value.trim() || nextOcNumber(), date, items, total: items.reduce((a, p) => a + p.total, 0), status: 'Pendente', notes: $('ocNotes').value.trim(), createdAt: Date.now(), updatedAt: Date.now() };
  porders.push(o); pushQueue({ type: 'porder', payload: { ...o } });
  $('ocModal').style.display = 'none';
  persist(); renderAll(); renderSupPay();
  toast('Ordem ' + o.number + ' guardada.', 'success');
};
async function receiveOc(id) {
  const o = porders.find(x => x.id === id); if (!o || o.status !== 'Pendente') return;
  const sup = suppliers.find(x => x.id === o.supplierId); if (!sup) return;
  let num = '';
  if (window.Swal) {
    const r = await Swal.fire({ title: 'Receber ' + o.number, text: 'Número da fatura do fornecedor:', input: 'text', inputValue: o.number.replace('OC', 'FT'), showCancelButton: true, confirmButtonText: 'Receber', cancelButtonText: 'Cancelar' });
    if (!r || !r.isConfirmed) return;
    num = String(r.value || '').trim() || o.number.replace('OC', 'FT');
  } else num = o.number.replace('OC', 'FT');
  const inv = { id: uid(), supplierId: sup.id, date: todayISO(), number: num, loc: 'armazem', items: o.items.map(p => ({ ...p })), total: o.total, paid: 0, payMethod: 'Numerário', notes: 'Recebida da ' + o.number, createdAt: Date.now(), updatedAt: Date.now() };
  invoices.push(inv); pushQueue({ type: 'invoice', payload: { ...inv } });
  stockApply(inv.items, +1, true, inv.number, 'armazem');
  o.status = 'Recebida'; o.receivedId = inv.id; o.updatedAt = Date.now();
  pushQueue({ type: 'porder', payload: { ...o } });
  persist(); renderAll(); renderSupPay();
  toast('Mercadoria recebida como ' + num + '. Stock atualizado.', 'success');
}
/* ---------- devoluções ao fornecedor (ND) ---------- */
function nextNdNumber() {
  const y = new Date().getFullYear();
  const n = supReturns.filter(r => String(r.number || '').indexOf('ND ' + y) === 0).length + 1;
  return 'ND ' + y + '/' + String(n).padStart(3, '0');
}
function openSr() {
  if (!currentSup) return;
  $('srSupInfo').textContent = currentSup.name;
  $('srDate').value = fmtDate(todayISO());
  $('srRows').innerHTML = ''; $('srRows').appendChild(prodRow()); recalcForm('srRows');
  $('supRetModal').style.display = 'flex';
}
$('btnCancelSr').onclick = () => { $('supRetModal').style.display = 'none'; };
$('btnSaveSr').onclick = () => {
  if (!currentSup) return;
  const date = parseBRDate($('srDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const items = readItems('srRows').filter(p => p.qty > 0);
  if (!items.length) return toast('Indique produtos e quantidades.', 'warning');
  const r = { id: uid(), supplierId: currentSup.id, number: nextNdNumber(), date, items, total: items.reduce((a, p) => a + p.total, 0), motive: $('srMotive').value, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  supReturns.push(r); pushQueue({ type: 'supreturn', payload: { ...r } });
  stockApply(items, -1, true, r.number, 'armazem');
  $('supRetModal').style.display = 'none';
  persist(); renderAll(); renderSupPay();
  toast('Devolução ' + r.number + ' registada. Dívida abatida e stock reduzido.', 'success');
};
function renderOc() {
  if (!currentSup) return;
  const tb = $('ocTable').querySelector('tbody'); tb.innerHTML = '';
  porders.filter(o => o.supplierId === currentSup.id).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(o => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(o.date)}</td><td>${esc(o.number)}</td><td style="text-align:right"><strong>${MZN(o.total)}</strong></td><td>${esc(o.status)}</td><td class="col-act"><button type="button" class="row-edit pdf" title="PDF da encomenda">PDF</button> ${o.status === 'Pendente' ? '<button type="button" class="btn small rcv" title="Receber mercadoria">Receber</button> <button type="button" class="row-del cnc" title="Cancelar">✕</button>' : ''} <button type="button" class="row-del del" title="Apagar">${ICO_DEL}</button></td>`;
    tr.querySelector('.pdf').onclick = () => { if (window.jspdf) ocPdf(o); else toast('PDF indisponível.', 'error'); };
    const rcv = tr.querySelector('.rcv');
    if (rcv) rcv.onclick = () => receiveOc(o.id);
    const cnc = tr.querySelector('.cnc');
    if (cnc) cnc.onclick = async () => {
      if (!await confirmDlg('Cancelar ordem?', `Cancelar "${o.number}"?`)) return;
      o.status = 'Cancelada'; o.updatedAt = Date.now();
      pushQueue({ type: 'porder', payload: { ...o } });
      persist(); renderAll();
    };
    tr.querySelector('.del').onclick = async () => {
      if (!await confirmDlg('Apagar ordem?', `Apagar "${o.number}" do histórico?`)) return;
      pushQueue({ type: 'delete-porder', payload: { id: o.id } });
      porders = porders.filter(x => x.id !== o.id);
      persist(); renderAll();
    };
    tb.appendChild(tr);
  });
}
$('btnNewOc').onclick = () => { if (currentSup) openOc(currentSup.id); };
$('btnNewSr').onclick = () => openSr();
function renderSupRet() {
  if (!currentSup) return;
  const list = supReturns.filter(r => r.supplierId === currentSup.id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const tb = $('supRetTable') ? $('supRetTable').querySelector('tbody') : null;
  if (tb) {
    tb.innerHTML = '';
    list.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtDate(r.date)}</td><td>${esc(r.number)}</td><td style="text-align:right"><strong>${MZN(r.total)}</strong></td><td>${esc(r.motive || '')}</td><td class="col-act"><button type="button" class="row-edit pdf" title="PDF da devolução">PDF</button> <button type="button" class="row-del" title="Anular devolução">${ICO_DEL}</button></td>`;
      tr.querySelector('.pdf').onclick = () => { if (window.jspdf) ndPdf(r); else toast('PDF indisponível.', 'error'); };
      tr.querySelector('.row-del').onclick = async () => {
        if (!await confirmDlg('Anular devolução?', `Anular "${r.number}"? O stock volta a subir e a dívida é reposta.`)) return;
        stockApply(r.items, +1, true, r.number + '-ANUL', 'armazem');
        pushQueue({ type: 'delete-supreturn', payload: { id: r.id } });
        supReturns = supReturns.filter(x => x.id !== r.id);
        persist(); renderAll(); renderSupPay(); renderSupRet();
      };
      tb.appendChild(tr);
    });
  }
  return list;
}

/* Nome curto: primeira + última palavra, sempre em maiúsculas */
function shortName(nm) {
  const w = String(nm || '').trim().split(/\s+/).filter(Boolean);
  if (w.length <= 2) return w.join(' ').toUpperCase();
  return (w[0] + ' … ' + w[w.length - 1]).toUpperCase();
}
/* Abre o formulário de edição do produto (reutilizado pela lista e pela ficha). */
function openProdEditor(s) {
  if (!s) return;
  editingProdId = s.id;
  if ($('prodModalTitle')) $('prodModalTitle').textContent = 'Editar Produto';
  $('pFName').value = s.name; $('pFUnit').value = s.unit || ''; $('pFPrice').value = s.price;
  if ($('pFCost')) $('pFCost').value = s.cost || 0;
  if ($('pFMargin')) $('pFMargin').value = s.margin != null ? s.margin : 0;
  $('pFMin').value = s.min || 0;
  $('pFLoja').value = Number(s.qLoja) || 0;
  $('pFArm').value = Number(s.qArm) || 0;
  if ($('pFSku')) $('pFSku').value = s.sku || '';
  if ($('pFCat')) $('pFCat').value = s.cat || '';
  if ($('pFRes')) $('pFRes').value = stockReserved(s);
  if ($('pFReason')) $('pFReason').value = '';
  $('prodModal').style.display = 'flex';
}
let reopenStockAfterProd = false;
function closeProdEditor() {
  $('prodModal').style.display = 'none';
  editingProdId = null;
  if (reopenStockAfterProd) {
    reopenStockAfterProd = false;
    const sm = $('stockModal');
    if (sm) { sm.style.display = 'flex'; try { renderStock(); } catch (_) {} }
  }
}
function openProductDetail(id) {
  const s = stock.find(x => x.id === id); if (!s) return;
  if(billingMode()) {
    const docs=sales.filter(doc=>doc.billingOnly && (currentRole()==='admin' || doc.operator===currentUser) && (doc.items||[]).some(item=>normName(item.desc)===normName(s.name))).sort((a,b)=>b.createdAt-a.createdAt);
    openInfo('Produto — '+s.name,'<h3>'+esc(s.name)+'</h3><p>Unidade: '+esc(s.unit||'—')+' · Preço unit.: '+fmtMoney(s.price)+'</p><h4>Faturação emitida</h4><table><thead><tr><th>Data</th><th>Documento</th><th>Emitido por</th></tr></thead><tbody>'+docs.map(doc=>'<tr><td>'+fmtDate(doc.date)+'</td><td>'+esc(doc.number)+'</td><td>'+esc(userNameOf(doc.operator))+'</td></tr>').join('')+'</tbody></table>');
    [...$('infoBody').querySelectorAll('tbody tr')].forEach((row,index)=>{row.style.cursor='pointer';row.onclick=()=>openSaleDetail(docs[index].id);});
    return;
  }
  const role = currentRole();
  const mvs = movements
    .filter(canSeeMovement)
    .filter(m => m.productId === id || (m.name || '').toLowerCase() === (s.name || '').toLowerCase())
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const tot = stockTotal(s), min = Number(s.min) || 0, price = Number(s.price) || 0;
  const ent = mvs.filter(m => m.type === 'entrada').reduce((a, m) => a + Math.abs(Number(m.qty) || 0), 0);
  const sai = mvs.filter(m => m.type !== 'entrada').reduce((a, m) => a + Math.abs(Number(m.qty) || 0), 0);
  const last = mvs[0];
  const todayRow = revenueRows(todayISO()).find(r => rendKey(r.name) === rendKey(s.name));
  const rows = mvs.slice(0, 200).map(m => {
    const q = Math.abs(Number(m.qty) || 0);
    const isIn = m.type === 'entrada';
    const locTxt = m.loc === 'armazem' ? 'Armazém' : m.loc === 'loja' ? 'Loja' : '—';
    return `<tr data-mid="${esc(m.id)}" title="Abrir movimento / documento">`
      + `<td>${fmtDate(m.date)}</td><td>${m.ts ? fmtTime(m.ts) : '—'}</td>`
      + `<td><span class="det-badge${isIn ? '' : ' gray'}">${isIn ? 'Entrada' : (m.reasonKey ? 'Saída Direta' : 'Saída')}</span>`
      + `${!isIn && m.type !== 'transferencia' ? '<br><small class="muted">' + MZN(moveValue(m)) + '</small>' : ''}</td>`
      + `<td class="n"><strong>${isIn ? '+' : '−'}${q}</strong></td>`
      + `<td class="n">${esc(String(m.after == null ? '—' : m.after))}</td>`
      + `<td>${esc(locTxt)}</td><td>${esc(m.ref || '—')}</td><td>${esc(m.reason || '—')}`
      + `${m.by ? ' <span class="hint">· ' + esc(userNameOf(m.by)) + '</span>' : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="hint">Sem movimentos registados.</td></tr>';
  const meta = [
    ['SKU', s.sku ? esc(s.sku) : '—'],
    ['Categoria', esc(s.cat || 'Sem categoria')],
    ['Unidade', esc(s.unit || '—')],
    ['Preço', MZN(price)]
  ];
  if (role === 'admin') {
    meta.push(['Custo', MZN(Number(s.cost) || 0)]);
    meta.push(['Margem', (Number(s.margin) || 0) + '%']);
  }
  meta.push(['Último movimento', last ? fmtDate(last.date) + ' · ' + (last.type === 'entrada' ? 'Entrada' : 'Saída') : '—']);
  openInfo('Produto — ' + s.name,
    `<div class="det-top"><div class="det-id"><strong>${esc(s.name)}</strong>`
    + detBadge(esc(s.cat || 'Sem categoria')) + detBadge(esc(s.unit || 'Unidade —'), 'gray')
    + (min > 0 ? detBadge(tot <= min ? 'Stock crítico' : 'Mínimo ' + min, tot <= min ? 'warn' : 'gray') : '')
    + `</div><div class="det-date">${last ? fmtDate(last.date) + ' ' + (last.ts ? fmtTime(last.ts) : '') : ''}</div></div>`
    + detKpis([
      { label: 'Loja', value: String(Number(s.qLoja) || 0) },
      { label: 'Armazém', value: String(Number(s.qArm) || 0) },
      { label: 'Disponível', value: String(tot) },
      { label: 'Estoque mínimo', value: String(min) },
      { label: 'Valor em stock', value: MZN(tot * price) },
      { label: 'Faturação hoje', value: MZN(todayRow ? todayRow.total : 0) + ' · ' + (todayRow ? todayRow.qty : 0) + ' un', cls: 'ok' }
    ])
    + detMeta(meta)
    + `<h4 class="det-h">Movimentos <span class="hint">(${mvs.length})</span></h4>`
    + `<p class="hint">Entradas: <strong>${ent}</strong> un · Saídas: <strong>${sai}</strong> un · Saldo atual: <strong>${tot}</strong> ${esc(s.unit || '')}</p>`
    + `<div class="det-items"><table><thead><tr><th>Data</th><th>Hora</th><th>Tipo</th><th>Qtd</th><th>Após</th><th>Local</th><th>Documento</th><th>Motivo</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div class="no-print" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">`
    + (role === 'admin' ? '<button type="button" class="btn small primary" id="btnProdEdit">Editar produto</button>' : '')
    + `<button type="button" class="btn small" id="btnProdKardex">Ver Kardex completo →</button><button type="button" class="btn small" id="btnProdExit">Declarar saída de stock</button></div>`
    + (role !== 'admin' && min > 0 && tot <= min
      ? `<div class="no-print" style="margin-top:10px"><button type="button" class="btn small danger" id="btnProdReport">Reportar situação ao administrador</button></div>`
      : ''));
  const bk = $('btnProdKardex');
  const brp = $('btnProdReport');
  const bed = $('btnProdEdit');
  if (bed) bed.onclick = () => {
    reopenStockAfterProd = reopenStockAfterInfo;
    reopenStockAfterInfo = false;
    closeInfo();
    openProdEditor(s);
  };
  if (brp) brp.onclick = () => reportProductSituation(s.id);
  if (bk) bk.onclick = () => {
    reopenStockAfterInfo = false;
    closeInfo();
    goView('products');
    prodTab('tabProdMoves');
    const sel = $('kardexProd');
    if (sel) sel.value = s.id;
    renderKardex();
  };
  $('infoBody').querySelectorAll('tr[data-mid]').forEach(tr => {
    tr.style.cursor = 'pointer';
    tr.onclick = () => { const m = movements.find(x => x.id === tr.dataset.mid); if (m) openMoveDoc(m); };
  });
  const be = $('btnProdExit');
  if (be) be.onclick = () => openExitStock(s.id);
}
/* Balão de produto na grelha (nome abreviado + resumo de stock) */
let hoverPopTimer = null;
function hoverPopHide() { const h = $('hoverPop'); if (h) h.style.display = 'none'; clearTimeout(hoverPopTimer); }
document.addEventListener('mouseover', (e) => {
  const td = e.target && e.target.closest ? e.target.closest('td[data-pid]') : null;
  if (!td) return;
  const s = stock.find(x => x.id === td.dataset.pid); if (!s) return;
  let h = $('hoverPop');
  if (!h) { h = document.createElement('div'); h.id = 'hoverPop'; h.className = 'stock-pop hover-pop'; document.body.appendChild(h); }
  const last = movements.filter(m => m.productId === s.id).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  h.innerHTML = `<strong title="${esc(s.name)}">${esc(shortName(s.name))}</strong><br>`
    + `<span>Loja: ${Number(s.qLoja) || 0} · Armazém: ${Number(s.qArm) || 0} · Total: ${stockTotal(s)}</span><br>`
    + `<span class="${stockAvail(s) <= (Number(s.min) || 0) && Number(s.min) > 0 ? 'neg' : 'pos'}">Mín: ${Number(s.min) || 0} · ${MZN(s.price)}</span>`
    + (last ? `<br><span>Último: ${esc(last.type === 'entrada' ? 'Entrada' : 'Saída')} ${esc(String(last.qty))} (${fmtDate(last.date)})</span>` : '');
  const r = td.getBoundingClientRect();
  h.style.display = 'block';
  h.style.left = Math.min(window.innerWidth - 260, r.left + window.scrollX) + 'px';
  h.style.top = (r.bottom + window.scrollY + 6) + 'px';
  clearTimeout(hoverPopTimer);
  hoverPopTimer = setTimeout(hoverPopHide, 6000);
});
document.addEventListener('mouseout', (e) => {
  const td = e.target && e.target.closest ? e.target.closest('td[data-pid]') : null;
  if (td) hoverPopHide();
});
/* Setas ↑↓ navegam nas grelhas de produtos/stock (só fora de inputs) */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const t = e.target;
  if (t && t.closest && t.closest('input,select,textarea,[contenteditable]')) return;
  let tb = t && t.closest ? t.closest('#prodTable tbody, #stockTable tbody') : null;
  if (!tb && t && (t === document.body || t.closest('#view-products'))) {
    if ($('stockModal') && $('stockModal').style.display === 'flex') tb = $('stockTable').querySelector('tbody');
    else if ($('view-products') && $('view-products').style.display !== 'none') tb = $('prodTable').querySelector('tbody');
  }
  if (!tb) return;
  const rows = [...tb.querySelectorAll('tr')].filter(r => r.querySelector('td[data-pid]'));
  if (!rows.length) return;
  e.preventDefault();
  let ix = rows.findIndex(r => r.classList.contains('kbd-cur'));
  if (e.key === 'Enter') { (rows[ix] || rows[0]).click(); return; }
  ix = e.key === 'ArrowDown' ? ix + 1 : ix - 1;
  if (ix < 0) ix = 0;
  if (ix >= rows.length) ix = rows.length - 1;
  rows.forEach(r => r.classList.remove('kbd-cur'));
  rows[ix].classList.add('kbd-cur');
  if (rows[ix].scrollIntoView) { try { rows[ix].scrollIntoView({ block: 'nearest' }); } catch (_) {} }
});
/* ---------- página de stock ---------- */
function stockRowValue(s) { return (Number(s.qLoja) || 0) * (Number(s.price) || 0) + (Number(s.qArm) || 0) * (Number(s.price) || 0); }
function productFilter(s, mode) {
  const tot = stockTotal(s), min = Number(s.min) || 0;
  switch (mode) {
    case 'baixo': return min > 0 && tot <= min;
    case 'esgotado': return tot <= 0;
    case 'alerta': return tot <= 0 || (min > 0 && tot <= min);
    case 'comstock': return tot > 0;
    default: return true;
  }
}
function productSort(mode) {
  switch (mode) {
    case 'maior': return (a, b) => stockTotal(b) - stockTotal(a) || (a.name || '').localeCompare(b.name || '');
    case 'menor': return (a, b) => stockTotal(a) - stockTotal(b) || (a.name || '').localeCompare(b.name || '');
    case 'valor': return (a, b) => stockRowValue(b) - stockRowValue(a) || (a.name || '').localeCompare(b.name || '');
    default: return null;
  }
}
function renderStock() {
  const q = (($('searchStock').value || '').toLowerCase());
  const fmode = ($('filterStock') || {}).value || 'todos';
  const tb = $('stockTable').querySelector('tbody'); tb.innerHTML = '';
  const sortFn = productSort(fmode);
  // O cartão de stock só mostra o que existe em stock (quantidade > 0).
  // «Esgotados» é a exceção explícita: serve para ver o que está a zero.
  const hideZero = fmode !== 'esgotado' && fmode !== 'alerta';
  const list = stock
    .filter(s => !q || (s.name || '').toLowerCase().includes(q) || (s.sku || '').toLowerCase().includes(q) || (s.cat || '').toLowerCase().includes(q))
    .filter(s => productFilter(s, fmode))
    .filter(s => !hideZero || stockTotal(s) > 0)
    .sort(sortFn || ((a, b) => (a.name || '').localeCompare(b.name || '')));
  let alerts = stock.filter(s => (Number(s.min) || 0) > 0 && stockAvail(s) <= (Number(s.min) || 0)).length;
  list.forEach(s => {
    const min = Number(s.min) || 0;
    const low = min > 0 && stockAvail(s) <= min;
    const tr = document.createElement('tr');
    if (low) tr.className = 'low';
    const role = currentRole();
    tr.innerHTML = `<td data-pid="${s.id}" title="${esc(s.name)}">${esc(s.name)}${low ? (role === 'admin' ? '<span class="low-badge">CRÍTICO</span>' : '<button type="button" class="low-badge low-report" title="Reportar esta situação ao administrador">CRÍTICO</button>') : ''}</td><td>${esc(s.unit || '')}</td><td style="text-align:right"><strong>${Number(s.qLoja) || 0}</strong></td><td style="text-align:right"><strong>${Number(s.qArm) || 0}</strong></td><td style="text-align:right"><strong>${role === 'admin' ? stockTotal(s) : stockAvail(s)}</strong></td><td style="text-align:right">${MZN(s.price)}</td>`;
    tr.style.cursor = 'pointer'; tr.title = 'Ver detalhe do produto';
    const crit = tr.querySelector('.low-report');
    if (crit) crit.onclick = (e) => { e.stopPropagation(); reportProductSituation(s.id); };
    tr.onclick = () => {
      // fluxo: cartão de stock → fecha stock → abre informação do produto; ao fechar volta ao stock
      if ($('stockModal') && $('stockModal').style.display === 'flex') { reopenStockAfterInfo = true; $('stockModal').style.display = 'none'; }
      openProductDetail(s.id);
    };
    tb.appendChild(tr);
  });
  const zeros = stock.filter(s => stockTotal(s) <= 0).length;
  $('stockCount').textContent = '(' + list.length + '/' + stock.length + ' produto(s)' + (alerts ? ', ' + alerts + ' em alerta' : '') + (hideZero && zeros ? ', ' + zeros + ' sem stock oculto(s)' : '') + ')';
}
/* ---------- página de produtos (cadastro mestre) ---------- */
let editingProdId = null;
let prodSelected = new Set();
let prodLimit = 200;
let citedFilter = null;   // produtos citados numa notificação (vê todos de uma vez)
let lastProdList = [];
function dashboardSales() { return sales.filter(canSeeSale).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); }
function dashboardMetrics(list) {
  const today=todayISO(),month=today.slice(0,7),active=list.filter(s=>!s.convertedId);
  const sum=items=>items.reduce((value,s)=>value+(Number(s.total)||0),0);
  const daily=active.filter(s=>dayKey(s.date)===today);
  const dailyClients=new Set(daily.map(s=>String(s.client||'').trim().toLowerCase()).filter(Boolean)).size;
  return {active,daily,html:'<div class="kpis dashboard-kpis">'+[
    ['Faturado hoje',sum(daily),'today-total'],['Documentos de hoje',daily.length,'today-count'],
    ['Clientes de hoje',dailyClients,'today-clients'],
    ['Faturado no mês',sum(active.filter(s=>dayKey(s.date).startsWith(month))),'month-total'],['Total faturado',sum(active),'all-total']
  ].map(([label,value,key])=>'<div class="kpi"><span>'+label+'</span><strong data-kpi="'+key+'">'+(key==='today-count'||key==='today-clients'?value:fmtMoney(value))+'</strong></div>').join('')+'</div>'};
}
function dashboardTable(list) {
  return '<div class="table-wrap"><table class="invoice-summary-table"><thead><tr><th>Data</th><th>Documento</th><th>Cliente</th><th>Emitido por</th><th>Total</th><th class="invoice-actions">Ações</th></tr></thead><tbody>'+list.map(s=>'<tr data-document="'+esc(s.id)+'" tabindex="0"><td>'+fmtDate(s.date)+'</td><td>'+esc(s.number)+'</td><td>'+esc(s.client||'Consumidor final')+'</td><td>'+esc(issuedByLabel(s.operator))+'</td><td class="dashboard-value">'+fmtMoney(s.total)+'</td><td class="invoice-actions"><button type="button" class="btn small">Pré-visualizar</button></td></tr>').join('')+'</tbody></table></div>';
}
function bindDashboardDocuments(container) {
  container.querySelectorAll('[data-preview-all-invoices]').forEach(button=>button.onclick=openAllInvoicePreviews);
  container.querySelectorAll('[data-document]').forEach(row=>{row.title='Consultar detalhes da faturação';row.onclick=e=>{if(e.target.closest('button,input,a'))return;openSaleDetail(row.dataset.document,false);};row.querySelectorAll('button').forEach(button=>{button.onclick=e=>{e.stopPropagation();openSaleDetail(row.dataset.document);};});row.onkeydown=e=>{if(e.key==='Enter' && e.target===row) {e.preventDefault();row.click();}};});
}
function adminOperatorSummary() {
  if(currentRole()!=='admin')return '';
  const rows=new Map();appUsers().filter(u=>u.role!=='admin').forEach(u=>rows.set(u.email.toLowerCase(),{email:u.email,count:0,total:0}));
  sales.filter(s=>!s.convertedId).forEach(s=>{const key=String(s.operator||'').toLowerCase();if(!key)return;const row=rows.get(key)||{email:s.operator,count:0,total:0};row.count++;row.total+=Number(s.total)||0;rows.set(key,row);});
  return '<details class="operator-summary panel"><summary>Atividade por operador</summary><div class="table-wrap"><table><thead><tr><th>Utilizador</th><th>Modo atribuído</th><th>Documentos emitidos</th><th>Total dos documentos</th></tr></thead><tbody>'+[...rows.values()].map(row=>'<tr><td>'+esc(userNameOf(row.email))+'</td><td>'+esc(userModeOf(row.email)==='venda'?'Vendedor':userModeOf(row.email)==='faturacao'?'Faturador':'Modo global')+'</td><td>'+row.count+'</td><td class="dashboard-value">'+fmtMoney(row.total)+'</td></tr>').join('')+'</tbody></table></div></details>';
}
function renderBillingDashboard(container,list) {
  const metrics=dashboardMetrics(list),{active,daily}=metrics,byUser=new Map(),products=new Map();
  active.forEach(s=>{const key=String(s.operator||'').toLowerCase();const row=byUser.get(key)||{operator:s.operator,count:0,total:0,today:0};row.count++;row.total+=Number(s.total)||0;if(dayKey(s.date)===todayISO()) row.today+=Number(s.total)||0;byUser.set(key,row);});
  daily.forEach(s=>(s.items||[]).forEach(item=>{const key=normName(item.desc)+'|'+(item.unit||'');const row=products.get(key)||{name:item.desc,qty:0,unit:item.unit,total:0};row.qty+=Number(item.qty)||0;row.total+=Number(item.total)||0;products.set(key,row);}));
  if(currentRole()==='admin') {
    const me=String(currentUser||'').toLowerCase();
    appUsers().forEach(u=>{
      const email=String(u.email||'').toLowerCase();
      if(!email || email===me || u.role==='admin') return;
      if(!byUser.has(email)) byUser.set(email,{operator:u.email,count:0,total:0,today:0});
    });
  }
  const productRows=[...products.values()].sort((a,b)=>b.total-a.total);
  container.innerHTML='<div class="panel-head"><div><h1>Painel Geral</h1><p class="hint">'+(currentRole()==='admin'?'Faturação de todos os utilizadores':'A sua faturação e atividade')+'</p></div><button type="button" class="btn primary" data-new-billing>Nova faturação</button></div>'
    +metrics.html
    +'<div class="dashboard-grid'+(currentRole()==='admin'?'':' dashboard-grid-single')+'"><section class="panel"><h3>Produtos faturados hoje</h3>'+(productRows.length?'<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Quantidade</th><th>Total</th></tr></thead><tbody>'+productRows.map(row=>'<tr><td>'+esc(row.name)+'</td><td>'+esc(row.qty+' '+String(row.unit||'').toLowerCase())+'</td><td class="dashboard-value">'+fmtMoney(row.total)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="hint">Ainda não há produtos faturados hoje.</p>')+'</section>'
    +'</div>'
    +'<section class="panel"><div class="panel-head"><h3>Últimas faturações</h3><button type="button" class="btn small" data-all-billing>Ver todas as faturas ('+list.length+')</button></div>'+(list.length?dashboardTable(list.slice(0,12)):'<p class="hint">Ainda não há documentos. Use «Nova faturação» para começar.</p>')+'</section>';
  container.insertAdjacentHTML('beforeend',adminOperatorSummary());
  container.querySelector('[data-new-billing]').onclick=()=>{goViewNow('sales');setSaleKind('cotacao');};
  container.querySelector('[data-all-billing]').onclick=()=>openAllInvoicePreviews();
  bindDashboardDocuments(container);
}
function applyBillingMode() {
  const active = billingMode();
  const changed = document.body.classList.contains('billing-mode') !== active;
  document.body.classList.toggle('billing-mode', active);
  if(changed && active && $('sNumber') && /^(VD|FT|FP) \d{4}\/\d+$/.test($('sNumber').value.trim())) $('sNumber').value=nextSaleNumber('cotacao');
  ['sPaid','sPay','sIva','sIvaMotive','sLoc','sType'].forEach(id => {
    const el=$(id); if(!el) return;
    const field = el.closest('.combo')?.parentElement || el.parentElement;
    field.style.display=active?'none':'';
  });
  document.querySelectorAll('.nav-btn[data-view="sales"]').forEach(el => {
    const text=el.querySelector('.nav-label');
    if(text) text.textContent=active?'Faturação':'Vender';
  });
  document.querySelectorAll('.nav-btn[data-view="pays"] .nav-label').forEach(el => { el.textContent=active?'Faturação emitida':'Pagamentos'; });
  applySidebar();
  [['#featSell strong','Faturação'],['#featSell small','Emitir e consultar faturas'],['#saleListPanel h3','Faturas emitidas'],['#calcPanel .calc-note','Cálculos independentes da faturação.']].forEach(([selector,label])=>{
    const el=document.querySelector(selector); if(!el) return;
    let text=[...el.childNodes].find(n=>n.nodeType===3);
    if(!text) { text=document.createTextNode(''); el.prepend(text); }
    if(el.dataset.billingNormal==null) el.dataset.billingNormal=text.textContent;
    text.textContent=active?label:el.dataset.billingNormal;
  });
  if($('filterSale')) { $('filterSale').disabled=active; if(active) $('filterSale').value=''; }
  ['stBillingMode','stMarginOn','stMargin','stMarginScope','stOrigin','stUseLoja','btnSaveStockCfg'].forEach(id=>{if($(id)) $(id).disabled=currentRole()!=='admin';});
  if(active) { if($('sLoc')) $('sLoc').value='armazem'; if($('sType')) $('sType').value='cotacao'; }
  if(active) {
    if($('prodPaneStock')) $('prodPaneStock').style.display='block';
    ['prodPaneMoves','prodPaneTrans','stockModal','transModal','exitStockModal'].forEach(id=>{if($(id)) $(id).style.display='none';});
  }
  ['stOrigin','stUseLoja'].forEach(id=>{if($(id)) $(id).parentElement.style.display=active?'none':'';});
  ['pFMin','pFLoja','pFArm'].forEach(id=>{if($(id)) $(id).parentElement.style.display=active?'none':'';});
  if($('pFReason')) { $('pFReason').style.display=active?'none':''; $('pFReason').previousElementSibling.style.display=active?'none':''; }
  const priceLabel=$('pFPrice')?.previousElementSibling;if(priceLabel) priceLabel.textContent=active?'Preço unit.':'Preço de Venda Final';
  document.querySelectorAll('#view-sales .page-head h1, #saleFormTitle').forEach(el => {
    let label=el.querySelector('.billing-title');
    if(!label) {
      label=document.createElement('span'); label.className='billing-title';
      const text=[...el.childNodes].filter(n=>n.nodeType===3);
      label.dataset.normalTitle=text.map(n=>n.textContent).join('');
      text.forEach(n=>n.remove()); el.appendChild(label);
    }
    label.textContent=active?' Faturação':label.dataset.normalTitle;
  });
  const issuedNav=document.querySelector('.nav-btn[data-view="issued"]');
  if(issuedNav) issuedNav.hidden=active || currentRole()!=='admin';
  if($('issuedReport')) {
    if(currentRole()==='admin') {
      const list=dashboardSales();
      $('issuedReport').innerHTML='<div class="page-head"><h1>Faturação emitida</h1><button type="button" class="btn primary" data-preview-all-invoices '+(!list.length?'disabled':'')+'>Ver todas as faturas ('+list.length+')</button></div>'+dashboardMetrics(list).html+dashboardTable(list);
      bindDashboardDocuments($('issuedReport'));
    } else {
      $('issuedReport').innerHTML='';
      if($('view-issued').style.display!=='none') { $('view-issued').style.display='none';$('view-dashboard').style.display='block';document.querySelectorAll('.nav-btn').forEach(button=>button.classList.toggle('active',button.dataset.view==='dashboard')); }
    }
  }
  const finance=$('view-pays');
  if(finance) {
    let report=$('billingReport');
    if(!report) { report=document.createElement('div'); report.id='billingReport'; finance.appendChild(report); }
    report.hidden=!active;
    if(active) {
      const all=dashboardSales();
      const isAdmin=currentRole()==='admin';
      let list=all, bar='';
      if(isAdmin) {
        const prev=$('reportOperator')?String($('reportOperator').value||'').toLowerCase():'';
        const seen=new Set(), ops=[];
        all.forEach(s=>{const key=String(s.operator||'').toLowerCase();if(!key||seen.has(key))return;seen.add(key);ops.push({key:key,name:operatorNameOf(s.operator)});});
        appUsers().forEach(u=>{const key=String(u.email||'').toLowerCase();if(!key||u.role==='admin'||seen.has(key))return;seen.add(key);ops.push({key:key,name:operatorNameOf(u.email)});});
        ops.sort((a,b)=>a.name.localeCompare(b.name));
        const sel=ops.some(x=>x.key===prev)?prev:'';
        list=sel?all.filter(s=>String(s.operator||'').toLowerCase()===sel):all;
        const total=list.reduce((value,s)=>value+(Number(s.total)||0),0);
        bar='<div class="operator-bar no-print"><div class="operator-filter"><label for="reportOperator">Filtrar por operador</label><select id="reportOperator"><option value="">Todos os operadores</option>'+ops.map(x=>'<option value="'+esc(x.key)+'"'+(x.key===sel?' selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select></div><div class="operator-stats"><strong>'+list.length+'</strong> documento(s) · Total facturado: <strong>'+MZN(total)+'</strong>'+(sel?' · '+esc(operatorNameOf(sel)):'')+'</div></div>';
      }
      report.innerHTML='<div class="page-head"><h1>Faturação emitida</h1><button type="button" class="btn primary" data-preview-all-invoices '+(!all.length?'disabled':'')+'>Ver todas as faturas ('+all.length+')</button></div>'+bar+dashboardMetrics(list).html+dashboardTable(list);
      bindDashboardDocuments(report);
      if($('reportOperator')) $('reportOperator').onchange=()=>applyBillingMode();
    }
  }
  let dashboard=$('billingDashboard');
  if(!dashboard && $('view-dashboard')) { dashboard=document.createElement('div'); dashboard.id='billingDashboard'; $('view-dashboard').appendChild(dashboard); }
  if(dashboard) {dashboard.hidden=!active;if(active) renderBillingDashboard(dashboard,dashboardSales());}
}
/* Modo por utilizador: o administrador define, em Utilizadores, se a conta
   trabalha em Venda ou em Faturação. Sem definição, herda o modo global. */
let _usersModeRaw = null, _usersModeMap = {};
function userModeOf(email) {
  try {
    const e = String(email || currentUser || '').toLowerCase();
    if(authorizedProfile && String(authorizedProfile.email).toLowerCase()===e)return authorizedProfile.mode||'';
    const raw = localStorage.getItem('dec_users') || '[]';
    if (raw !== _usersModeRaw) {
      _usersModeRaw = raw;
      _usersModeMap = {};
      const parsed = JSON.parse(raw);
      (Array.isArray(parsed) ? parsed : Object.values(parsed || {})).forEach(u => {
        if (!u || !u.email) return;
        if (u.mode === 'faturacao' || u.mode === 'venda') _usersModeMap[String(u.email).toLowerCase()] = u.mode;
      });
    }
    return _usersModeMap[e] || '';
  } catch (_) { return ''; }
}
let _billingMemo = { key: '', value: false };
function billingMode() {
  const globalMode = stockCfg().billingMode === true;
  const role = currentRole();
  const mode = role === 'admin' ? '' : userModeOf(currentUser);
  const key = (globalMode ? '1' : '0') + '|' + role + '|' + mode;
  if (_billingMemo.key === key) return _billingMemo.value;
  let value = globalMode;
  if (role !== 'admin') {
    if (mode === 'faturacao') value = true;
    else if (mode === 'venda') value = false;
  }
  _billingMemo = { key: key, value: value };
  return value;
}
let stockConfigRaw, stockConfigCache;
function stockCfg() {
  const defaults={marginOn:0,margin:0,scope:'global',origin:'armazem',useLoja:0};
  try {const raw=localStorage.getItem('dec_stockcfg');if(raw!==stockConfigRaw || !stockConfigCache){stockConfigCache=Object.assign({},defaults,JSON.parse(raw)||{});stockConfigRaw=raw;}return {...stockConfigCache};}
  catch (_) {return defaults;}
}
/* botão X que apaga a pesquisa de produtos de uma vez */
function syncProdX() {
  const sp = $('searchProd'), x = $('btnClearProd');
  if (x) x.style.display = (sp && String(sp.value || '').length) ? '' : 'none';
}
/* mostra todos os produtos citados numa notificação (não só o primeiro) */
function syncCiteBar() {
  const bar = $('prodCiteBar');
  if (!bar) return;
  const n = citedFilter ? citedFilter.size : 0;
  bar.style.display = n ? '' : 'none';
  if ($('prodCiteCount')) $('prodCiteCount').textContent = n ? n + ' produto(s) citados na notificação' : '';
}
function clearCited() { citedFilter = null; syncCiteBar(); }
function openCitedProducts(ids) {
  const set = new Set((ids || []).filter(Boolean));
  if (!set.size) return;
  citedFilter = set;
  const sp = $('searchProd'); if (sp) sp.value = '';
  goView('products');
  const tab = $('tabProdStock'); if (tab) tab.click();
  prodLimit = Math.max(prodLimit, set.size);
  renderProducts();
  syncCiteBar();
}
function renderProducts() {
  syncProdX();
  const q = (($('searchProd').value || '').toLowerCase());
  const tb = $('prodTable').querySelector('tbody'); tb.innerHTML = '';
  const sl = $('stockList');
  if (sl) sl.innerHTML = stock.map(s => `<option value="${esc(s.name)}">`).join('');
  const cfg = stockCfg();
  const isAdmin = currentRole() === 'admin';
  if ($('btnAddProd')) $('btnAddProd').style.display = isAdmin ? '' : 'none';
  if ($('btnStockExp')) $('btnStockExp').style.display = isAdmin ? '' : 'none';
  if ($('btnStockImp')) $('btnStockImp').style.display = isAdmin ? '' : 'none';
  if ($('btnOpenTrans')) $('btnOpenTrans').style.display = (isAdmin || currentRole() === 'opt') ? '' : 'none';
  const pfmode = ($('filterProd') || {}).value || 'todos';
  const pSort = productSort(pfmode);
  const list0 = stock
    .filter(s => !q || (s.name || '').toLowerCase().includes(q) || (s.unit || '').toLowerCase().includes(q) || (s.sku || '').toLowerCase().includes(q) || (s.cat || '').toLowerCase().includes(q))
    .filter(s => productFilter(s, pfmode));
  const list = (citedFilter && citedFilter.size ? list0.filter(s => citedFilter.has(s.id)) : list0)
    .sort(pSort || ((a, b) => (a.name || '').localeCompare(b.name || '')));
  syncCiteBar();
  lastProdList = list;
  list.slice(0, prodLimit).forEach(s => {
    const min = Number(s.min) || 0, margin = cfg.marginOn ? (cfg.scope === 'global' ? Number(cfg.margin) || 0 : (s.margin != null ? Number(s.margin) : 0)) : (s.margin != null ? Number(s.margin) : 0);
    const cost = Number(s.cost) || 0;
    const sug = Math.round(cost * (1 + margin / 100) * 100) / 100;
    const low = min > 0 && stockAvail(s) <= min;
    const disp = stockTotal(s);
    const tr = document.createElement('tr');
    tr.dataset.pid = s.id;
    if (low) tr.className = 'low';
    if (prodSelected.has(s.id)) tr.classList.add('active');
    tr.innerHTML = `<td><input type="checkbox" class="psel" ${prodSelected.has(s.id) ? 'checked' : ''} /></td><td>${esc(s.sku || '—')}</td><td data-pid="${s.id}" title="${esc(s.name)}">${esc(s.name)}${low ? (isAdmin ? '<span class="low-badge">CRÍTICO</span>' : '<button type="button" class="low-badge low-report" title="Reportar esta situação ao administrador">CRÍTICO</button>') : ''}</td><td>${esc(s.cat || '')}</td><td>${esc(s.unit || '')}</td><td style="text-align:right"><strong>${Number(s.qLoja) || 0}</strong></td><td style="text-align:right"><strong>${Number(s.qArm) || 0}</strong></td><td style="text-align:right"><strong>${disp}</strong></td><td style="text-align:right">${MZN(s.price)}</td><td>${isAdmin ? `<input type="number" class="mini-inp mn" value="${min}" step="any" title="Stock mínimo">` : esc(String(min))}</td><td class="col-act">${isAdmin ? `<button type="button" class="row-del" title="Eliminar">${ICO_DEL}</button>` : ''}</td>`;
    const crit = tr.querySelector('.low-report');
    if (crit) crit.onclick = (e) => { e.stopPropagation(); reportProductSituation(s.id); };
    const cb = tr.querySelector('.psel');
    cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) prodSelected.add(s.id); else prodSelected.delete(s.id); renderProdBulk(); };
    const mg = tr.querySelector('.mg');
    if (mg) mg.onchange = (e) => { e.stopPropagation(); s.margin = Number(e.target.value) || 0; s.price = Math.round(cost * (1 + s.margin / 100) * 100) / 100; s.updatedAt = Date.now(); pushQueue({ type: 'stock', payload: { ...s } }); persist(); renderAll(); };
    const mn = tr.querySelector('.mn');
    if (mn) {
      mn.onchange = (e) => { e.stopPropagation(); if (currentRole() !== 'admin') return; s.min = Number(e.target.value) || 0; s.updatedAt = Date.now(); pushQueue({ type: 'stock', payload: { ...s } }); persist(); renderAll(); };
      mn.onclick = (e) => e.stopPropagation();
    }
    if (mg) mg.onclick = (e) => e.stopPropagation();
    const openEdit = () => openProdEditor(s);
    tr.onclick = (e) => { if (e.target.closest('input,button')) return; if (currentRole() !== 'admin') { sellDirect(s.name); return; } openEdit(); };
    const rdel = tr.querySelector('.row-del');
    if (rdel) {
      rdel.onclick = async (e) => {
        e.stopPropagation();
        if (currentRole() !== 'admin') return toast('Eliminar produto: acesso Administrador.', 'error');
        if (!await confirmDlg('Remover produto?', `"${s.name}" sai do cadastro. (Faturas e Kardex mantêm-se.)`)) return;
        pushQueue({ type: 'delete-stock', payload: { id: s.id } });
        stock = stock.filter(x => x.id !== s.id);
        prodSelected.delete(s.id);
        persist(); renderAll(); toast('Produto removido.', 'success');
      };
    }
    tb.appendChild(tr);
  });
  const more = list.length - Math.min(prodLimit, list.length);
  if (more > 0) {
    const trm = document.createElement('tr');
    trm.innerHTML = `<td colspan="11" style="text-align:center"><button type="button" class="btn small">Mostrar mais (${more} restantes)</button></td>`;
    trm.querySelector('button').onclick = (e) => { e.stopPropagation(); prodLimit += 500; renderProducts(); };
    tb.appendChild(trm);
  }
  renderProdBulk();
  renderKardex();
}
function renderProdBulk() {
  const bar = $('prodBulkBar'); if (!bar) return;
  const rows=[...document.querySelectorAll('#prodTable tbody tr[data-pid]')];
  const visible=new Set(rows.map(row=>row.dataset.pid));
  prodSelected=new Set([...prodSelected].filter(id=>visible.has(id)));
  const show = prodSelected.size > 0 && currentRole() === 'admin';
  bar.classList.toggle('show', show);
  if ($('prodSelCount')) $('prodSelCount').textContent = prodSelected.size + ' selecionado(s)';
  const all = $('prodCheckAll'); if (all) {all.checked=rows.length>0 && rows.every(row=>prodSelected.has(row.dataset.pid));all.indeterminate=prodSelected.size>0&&!all.checked;}
  document.querySelectorAll('#prodTable tbody tr').forEach(tr => tr.classList.toggle('active', prodSelected.has(tr.dataset.pid)));
}
$('searchProd').oninput = () => { clearCited(); prodLimit = 200; renderProducts(); };
if ($('btnClearProd')) $('btnClearProd').onclick = () => {
  const sp = $('searchProd'); if (!sp) return;
  sp.value = ''; prodLimit = 200; renderProducts(); sp.focus();
};
if ($('btnCiteClear')) $('btnCiteClear').onclick = () => { clearCited(); prodLimit = 200; renderProducts(); };
if ($('filterProd')) $('filterProd').onchange = () => { prodLimit = 200; renderProducts(); };
$('btnCancelProd').onclick = () => closeProdEditor();
if ($('btnAddProd')) $('btnAddProd').onclick = () => {
  if (currentRole() !== 'admin') return toast('Cadastro de produtos: acesso Administrador.', 'error');
  editingProdId = 'NEW';
  if ($('prodModalTitle')) $('prodModalTitle').textContent = 'Adicionar Novo Produto';
  ['pFName', 'pFSku', 'pFCat', 'pFUnit', 'pFPrice', 'pFMin', 'pFLoja', 'pFArm'].forEach(id => { if ($(id)) $(id).value = id === 'pFMin' ? 0 : ''; });
  if ($('pFReason')) $('pFReason').value = '';
  $('prodModal').style.display = 'flex';
  setTimeout(() => $('pFName') && $('pFName').focus(), 50);
};
$('btnSaveProd').onclick = () => {
  if (currentRole() !== 'admin') return toast('Cadastro de produtos: acesso Administrador.', 'error');
  const nm = ($('pFName').value || '').trim().toUpperCase();
  if (!nm) return toast('Nome é obrigatório.', 'warning');
  const dupe = stock.find(x => x.name.toLowerCase() === nm.toLowerCase() && x.id !== editingProdId);
  if (dupe) {
    if (window.Swal) Swal.fire({ icon: 'warning', title: 'Produto já cadastrado', text: 'Utilize a edição para alterar o preço ou o stock.' });
    else toast('Produto já cadastrado. Utilize a edição para alterar o preço ou o stock.', 'warning');
    return;
  }
  const unit = ($('pFUnit').value || '').trim().toUpperCase();
  const sku = ($('pFSku') ? $('pFSku').value : '').trim().toUpperCase();
  const cat = ($('pFCat') ? $('pFCat').value : '').trim();
  const price = Number($('pFPrice').value) || 0;
  const costField = $('pFCost'), marginField = $('pFMargin');
  const cur = editingProdId !== 'NEW' ? stock.find(x => x.id === editingProdId) : null;
  const cost = costField ? (Number(costField.value) || 0) : (cur ? (Number(cur.cost) || 0) : price);
  const margin = marginField ? (Number(marginField.value) || 0) : (cur ? (Number(cur.margin) || 0) : 0);
  const min = Number($('pFMin').value) || 0;
  const qLoja = billingMode() ? Number(cur?.qLoja)||0 : Math.max(0, Number($('pFLoja').value) || 0), qArm = billingMode() ? Number(cur?.qArm)||0 : Math.max(0, Number($('pFArm').value) || 0);
  const reason = $('pFReason') ? $('pFReason').value : '';
  if (editingProdId === 'NEW') {
    const s = { id: uid(), name: nm, sku, cat, unit, qLoja, qArm, cost, price: price || Math.round(cost * (1 + margin / 100) * 100) / 100, margin, min, updatedAt: Date.now(), createdAt: Date.now() };
    stock.push(s);
    pushQueue({ type: 'stock', payload: { ...s } });
    if (qLoja + qArm > 0) {
      const mv = { id: uid(), productId: s.id, name: nm, date: todayISO(), type: 'entrada', qty: qLoja + qArm, after: qLoja + qArm, loc: qArm >= qLoja ? 'armazem' : 'loja', ref: 'CADASTRO', reason: 'Stock inicial', ts: Date.now() };
      movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
    }
    toast('Produto criado.', 'success');
  } else {
    const s = stock.find(x => x.id === editingProdId); if (!s) return;
    const qtyChanged = (Number(s.qLoja) || 0) !== qLoja || (Number(s.qArm) || 0) !== qArm;
    if (qtyChanged && !reason) return toast('Alterou quantidades: indique o motivo auditável.', 'warning');
    const oldTot = stockTotal(s);
    Object.assign(s, { name: nm, sku, cat, unit, price, cost, margin, min, qLoja, qArm, updatedAt: Date.now() });
    if (qtyChanged) {
      const mv = { id: uid(), productId: s.id, name: nm, date: todayISO(), type: stockTotal(s) >= oldTot ? 'entrada' : 'saida', qty: stockTotal(s) - oldTot, after: stockTotal(s), loc: 'loja', ref: 'AJUSTE-CAD', reason: reason, ts: Date.now() };
      movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
    }
    if (unit && !units.includes(unit)) { units.push(unit); pushQueue({ type: 'settings', payload: { key: 'units', list: units } }); renderPayUnits(); }
    pushQueue({ type: 'stock', payload: { ...s } });
    toast('Produto atualizado.', 'success');
  }
  closeProdEditor();
  persist(); renderAll();
};
/* ---------- transferências internas Loja ↔ Armazém ---------- */
function nextGtiNumber() {
  const y = new Date().getFullYear();
  const n = transfers.filter(t => String(t.number || '').indexOf('GTI ' + y) === 0).length + 1;
  return 'GTI ' + y + '/' + String(n).padStart(3, '0');
}
function openTrans(productId) {
  if (billingMode()) return;
  if (productId) { const s = stock.find(x => x.id === productId); if (s) $('tProd').value = s.name; }
  else $('tProd').value = '';
  $('tQty').value = ''; $('tNotes').value = '';
  // Pré-seleciona origem onde há stock (evita "insuficiente" com stock na outra localização)
  try {
    const nm = ($('tProd').value || '').trim();
    const s = nm ? stock.find(x => (x.name || '').toLowerCase() === nm.toLowerCase()) : null;
    if (s) {
      const L = Number(s.qLoja) || 0, A = Number(s.qArm) || 0;
      if (A > 0 && L <= 0) { $('tFrom').value = 'armazem'; $('tTo').value = 'loja'; }
      else if (L > 0 && A <= 0) { $('tFrom').value = 'loja'; $('tTo').value = 'armazem'; }
    }
  } catch (_) {}
  updateTransHint();
  $('transModal').style.display = 'flex';
}
function updateTransHint() {
  const h = $('transStockHint'); if (!h) return;
  const nm = ($('tProd').value || '').trim();
  const s = nm ? stock.find(x => (x.name || '').toLowerCase() === nm.toLowerCase()) : null;
  h.textContent = s ? ('Disponível — Loja: ' + (Number(s.qLoja) || 0) + ' · Armazém: ' + (Number(s.qArm) || 0)) : 'Indique o produto para ver o stock.';
}
$('btnOpenTrans').onclick = () => openTrans(null);
if ($('tProd')) $('tProd').addEventListener('input', updateTransHint);
if ($('tFrom')) $('tFrom').onchange = () => { if ($('tTo')) $('tTo').value = $('tFrom').value === 'armazem' ? 'loja' : 'armazem'; updateTransHint(); };
if ($('tTo')) $('tTo').onchange = () => { if ($('tFrom')) $('tFrom').value = $('tTo').value === 'armazem' ? 'loja' : 'armazem'; updateTransHint(); };
$('btnCancelTrans').onclick = () => { $('transModal').style.display = 'none'; };
$('btnDoTrans').onclick = () => {
  if (currentRole() === 'op') return toast('Transferências: acesso do nível Caixa com Transferências.', 'error');
  const nm = ($('tProd').value || '').trim().toUpperCase();
  if (!nm) return toast('Indique o produto.', 'warning');
  const from = $('tFrom').value === 'armazem' ? 'armazem' : 'loja';
  const to = $('tTo').value === 'armazem' ? 'armazem' : 'loja';
  if (from === to) return toast('Origem e destino devem ser diferentes.', 'warning');
  const qty = Number($('tQty').value) || 0;
  if (qty <= 0) return toast('Indique a quantidade.', 'warning');
  const s = stock.find(x => (x.name || '').toLowerCase() === nm.toLowerCase());
  const have = s ? (from === 'armazem' ? Number(s.qArm) || 0 : Number(s.qLoja) || 0) : 0;
  if (!s) return toast('Produto não encontrado.', 'error');
  if (have < qty) {
    const L = Number(s.qLoja) || 0, A = Number(s.qArm) || 0;
    return toast('Stock insuficiente na origem (' + (from === 'armazem' ? 'Armazém' : 'Loja') + ' tem ' + have + '). O produto tem Loja: ' + L + ' · Armazém: ' + A + ' — troque a origem.', 'error');
  }
  if (from === 'armazem') { s.qArm = have - qty; s.qLoja = (Number(s.qLoja) || 0) + qty; }
  else { s.qLoja = have - qty; s.qArm = (Number(s.qArm) || 0) + qty; }
  s.updatedAt = Date.now();
  pushQueue({ type: 'stock', payload: { ...s } });
  const t = { id: uid(), number: nextGtiNumber(), date: todayISO(), productId: s.id, name: nm, unit: s.unit || '', qty, from, to, notes: ($('tNotes').value || '').trim(), operator: currentUser, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  transfers.push(t); pushQueue({ type: 'transfer', payload: { ...t } });
  const lbl = (from === 'armazem' ? 'Armazém' : 'Loja') + '→' + (to === 'armazem' ? 'Armazém' : 'Loja');
  [['saida', -qty, from], ['entrada', qty, to]].forEach(([tp, q2, lc]) => {
    const mv = { id: uid(), productId: s.id, name: nm, date: todayISO(), type: tp, qty: q2, after: lc === 'armazem' ? s.qArm : s.qLoja, loc: lc, ref: t.number, reason: 'Transferência ' + lbl, ts: Date.now() };
    movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
  });
  $('transModal').style.display = 'none';
  persist(); renderAll();
  toast('Transferência ' + t.number + ' concluída.', 'success');
  if (window.jspdf) gtiPdf(t);
};
function renderTrans() {
  const tb = $('transTable').querySelector('tbody'); tb.innerHTML = '';
  const list = transfers.filter(t=>currentRole()==='admin'||String(t.operator||'').toLowerCase()===String(currentUser||'').toLowerCase()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $('transCount').textContent = '(' + list.length + ')';
  list.forEach(t => {
    const tr = document.createElement('tr');
    const lbl = (t.from === 'armazem' ? 'Armazém' : 'Loja') + ' → ' + (t.to === 'armazem' ? 'Armazém' : 'Loja');
    tr.innerHTML = `<td>${fmtDate(t.date)}</td><td>${esc(t.number)}</td><td class="wrap">${esc(t.name)}</td><td style="text-align:right">${t.qty} ${esc(t.unit || '')}</td><td>${lbl}</td><td class="col-act"><button type="button" class="row-edit det" title="Ver movimento">Ver</button> <button type="button" class="row-edit gti" title="Guia (PDF)">${ICO_TRUCK}</button></td>`;
    if (tr.querySelector('.det')) tr.querySelector('.det').onclick = (e) => { e.stopPropagation(); openTransDetail(t.id); };
    if (tr.querySelector('.gti')) tr.querySelector('.gti').onclick = (e) => { e.stopPropagation(); if (window.jspdf) gtiPdf(t); else toast('PDF indisponível.', 'error'); };
    tr.style.cursor = 'pointer'; tr.title = 'Ver movimento';
    tr.onclick = () => openTransDetail(t.id);
    tb.appendChild(tr);
  });
}
function gtiPdf(t) {
  // GTI: sem valor comercial, origem/destino, assinaturas
  const doc = docNew();
  const lbl = (v) => v === 'armazem' ? 'Armazém' : 'Loja';
  let y = docHeader(doc, 'GUIA DE TRANSFERÊNCIA (GTI)', t.number || '', fmtDate(t.date), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Origem', lines: [
      'Local de saída: ' + lbl(t.from),
      'Responsável: ' + userNameOf(currentUser)
    ] },
    { title: 'Destino', lines: [
      'Local de entrada: ' + lbl(t.to),
      'Tipo: transferência interna'
    ] },
    { title: 'Detalhes', lines: [
      'Emissão: ' + fmtDate(t.date),
      t.notes ? 'Notas: ' + t.notes : 'Notas: —'
    ] }
  ]);
  y = docBanner(doc, y, 'Movimentação interna de stock — documento sem valor comercial.', ACCENT);
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { halign: 'center', cellWidth: 18, fontStyle: 'bold' },
      2: { halign: 'center', cellWidth: 14, textColor: CMUT, fontSize: 7.8 },
      3: { cellWidth: 'auto' },
      4: { halign: 'center', cellWidth: 24 },
      5: { halign: 'center', cellWidth: 24 }
    },
    head: [['#', 'Qtd', 'Un.', 'Designação do Produto', 'Origem', 'Destino']],
    body: [[1, t.qty, t.unit || '', t.name, lbl(t.from), lbl(t.to)]],
    didDrawPage: docFootSetup(doc, String(t.id || '').slice(-6).toUpperCase(), t.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DE VOLUMES', value: String(Number(t.qty) || 0), big: true, color: CORP }
  ]);
  docSignatures(doc, 'Entreguei (Origem)', 'Recebi (Destino)');
  pdfSave(doc, safeName(t.number));
}
function renderKardex() {
  const sel = $('kardexProd');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os produtos</option>' + stock.map(s => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const nm = cur ? ((stock.find(x => x.id === cur) || {}).name || '') : '';
  const tb = $('moveTable').querySelector('tbody'); tb.innerHTML = '';
  const list = movements.filter(canSeeMovement).filter(m => !cur || m.name === nm).sort((a, b) => String(a.date + (a.ts || 0)).localeCompare(String(b.date + (b.ts || 0))));
  $('moveCount').textContent = '(' + list.length + ' movimento(s))';
  list.forEach(m => {
    const tr = document.createElement('tr');
    const mvVal = Number(m.qty) < 0 && m.type !== 'transferencia' ? moveValue(m) : 0;
    tr.innerHTML = `<td>${fmtDate(m.date)}</td><td style="text-align:right">${m.qty > 0 ? '+' : ''}${m.qty}</td>`
      + `<td style="text-align:right" title="Valor ao preço de venda">${mvVal ? MZN(mvVal) : '—'}</td>`
      + `<td class="wrap">${esc(m.name)}</td><td>${!m.loc || m.loc === 'loja' ? 'Loja' : m.loc === 'armazem' ? 'Armazém' : '↔'}</td>`
      + `<td>${m.type === 'entrada' ? 'Entrada' : m.type === 'transferencia' ? 'Transferência' : (m.reasonKey ? 'Saída Direta / Ajuste' : 'Saída')}</td>`
      + `<td style="text-align:right">${m.after}</td><td>${esc(m.ref || '')}</td><td>${esc(m.reason || '')}</td>`;
    tr.style.cursor = 'pointer'; tr.title = 'Ver movimento e abrir documento';
    tr.onclick = () => openMoveDoc(m);
    tb.appendChild(tr);
  });
}
async function openMoveDoc(m) {
  if (!m) return;
  const ref = String(m.ref || '');
  const showVal = m.type !== 'transferencia';
  const uPrice = showVal ? moveUnitPrice(m) : 0, val = showVal ? moveValue(m) : 0;
  const detail = `<p style="text-align:left"><strong>${esc(m.name)}</strong> — ${m.qty > 0 ? '+' : ''}${m.qty}</p>`
    + `<p class="hint" style="text-align:left">${moveKind(m)} · ${m.loc === 'armazem' ? 'Armazém' : m.loc === 'loja' ? 'Loja' : '—'} · Stock após: ${m.after}<br>Ref: ${esc(ref || '—')} · ${fmtDate(m.date)}${m.ts ? ' ' + fmtTime(m.ts) : ''}`
    + `${showVal ? `<br>Valor: <strong>${MZN(val)}</strong>${uPrice ? ' · Preço unitário: ' + MZN(uPrice) : ''}` : ''}`
    + `${m.reason ? '<br>Motivo: ' + esc(m.reason) : ''}${m.by ? '<br>Declarado por: ' + esc(userNameOf(m.by)) : ''}</p>`;
  let target = null;
  const goSaleNum = (num) => { goViewNow('sales'); if ($('searchSale')) { $('searchSale').value = num; try { renderSales(); } catch (_) {} } };
  if (/^(VD|FP|COT) /.test(ref)) {
    const s = sales.find(x => x.number === ref);
    if (s) target = { label: 'Abrir ' + ref, fn: () => goSaleNum(ref) };
  } else if (/^FT /.test(ref)) {
    const s = sales.find(x => x.number === ref);
    if (s) target = { label: 'Abrir ' + ref + ' (venda)', fn: () => goSaleNum(ref) };
    else { const inv = invoices.find(x => x.number === ref); if (inv) target = { label: 'Abrir ' + ref + ' (compra)', fn: () => goToSupplier(inv.supplierId) }; }
  } else if (/^GTI /.test(ref)) {
    const t = transfers.find(x => x.number === ref);
    if (t) target = { label: 'Abrir ' + ref, fn: () => openTransDetail(t.id) };
  } else if (/^REC /.test(ref)) {
    const rc = receipts.find(x => x.number === ref);
    const sid = rc && rc.allocations && rc.allocations[0] && rc.allocations[0].saleId;
    const s = sid && sales.find(x => x.id === sid);
    if (s) target = { label: 'Abrir fatura ' + s.number, fn: () => goSaleNum(s.number) };
  } else if (/^NC /.test(ref)) {
    target = { label: 'Ver notas de crédito', fn: () => goViewNow('sales') };
  }
  if (!target) {
    if (window.Swal) Swal.fire({ title: 'Movimento', html: detail, confirmButtonText: 'Fechar' });
    else toast('Movimento: ' + m.name + ' ' + m.qty, 'info');
    return;
  }
  if (window.Swal) { const r = await Swal.fire({ title: 'Movimento', html: detail, showCancelButton: true, confirmButtonText: target.label, cancelButtonText: 'Fechar' }); if (r && r.isConfirmed) target.fn(); }
  else target.fn();
}
/* ---------- saída direta de stock (sem venda) ---------- */
const EXIT_REASONS = {
  montra: 'Saída para Montra / Exposição',
  avulso: 'Converter para Venda Avulso / Fracionado',
  quebra: 'Quebra / Avaria / Danificado',
  consumo: 'Consumo Interno / Amostra',
  acerto: 'Ajuste de Inventário / Acerto a Menos'
};
function nextExitNumber() {
  const y = new Date().getFullYear();
  const n = movements.filter(m => String(m.ref || '').indexOf('SD ' + y) === 0).length + 1;
  return 'SD ' + y + '/' + String(n).padStart(3, '0');
}
function exitSelProduct() {
  const el = $('exProd'); if (!el) return null;
  const raw = String(el.value || '').trim();
  if (!raw) return null;
  return stock.find(s => String(s.id) === raw) || stock.find(s => (s.name || '').toLowerCase() === raw.toLowerCase()) || null;
}
function syncExitInfo() {
  const s = exitSelProduct(), el = $('exInfo'); if (!el) return;
  const arm = ($('exLoc') || {}).value === 'armazem';
  const had = s ? (arm ? (Number(s.qArm) || 0) : (Number(s.qLoja) || 0)) : 0;
  const qty = Math.abs(Number(($('exQty') || {}).value) || 0);
  const left = had - qty;
  const unit = s && s.unit ? ' ' + s.unit : '';
  const price = s ? (Number(s.price) || 0) : 0;
  const value = Math.round(qty * price * 100) / 100;
  if ($('exHad')) $('exHad').textContent = (s ? had : 0) + unit;
  if ($('exOut')) $('exOut').textContent = '−' + qty + unit;
  if ($('exLeft')) $('exLeft').textContent = left + unit;
  if ($('exLeftBox')) $('exLeftBox').classList.toggle('neg', left < 0);
  if ($('exValue')) $('exValue').textContent = MZN(value);
  /* Linha pedida: cada valor no seu lugar — Qtd · Produto · Preço · Total. */
  if ($('exLineQty')) $('exLineQty').textContent = (s ? qty : 0) + unit;
  if ($('exLineProd')) $('exLineProd').textContent = s ? (s.name || '—') : '—';
  if ($('exLinePrice')) $('exLinePrice').textContent = s ? MZN(price) : '—';
  if ($('exLineTotal')) $('exLineTotal').textContent = MZN(value);
  if ($('exValueInfo')) $('exValueInfo').textContent = s
    ? 'Preço de venda: ' + MZN(price) + (s.unit ? ' / ' + s.unit : '') + ' · Valor da saída = ' + qty + ' × ' + MZN(price) + '.'
    : 'Escolha um produto para calcular o valor da saída.';
  if (!s) { el.textContent = stock.length ? 'Escolha um produto.' : 'Sem produtos no cadastro. Crie um produto primeiro.'; el.style.color = ''; return; }
  const otherLbl = arm ? 'Loja' : 'Armazém';
  const otherQty = arm ? (Number(s.qLoja) || 0) : (Number(s.qArm) || 0);
  el.textContent = 'Loja: ' + (Number(s.qLoja) || 0) + ' · Armazém: ' + (Number(s.qArm) || 0)
    + ' · ' + (arm ? 'Armazém' : 'Loja') + ': ' + had + unit
    + ' · Fica com: ' + left + unit
    + (qty > had ? ' — stock insuficiente (faltam ' + (qty - had) + unit + ')' : '')
    + (otherQty > 0 && had <= 0 ? ' · O ' + otherLbl + ' tem ' + otherQty + unit : '');
  el.style.color = qty > had ? '#b91c1c' : '';
}
function onExitProductChange() {
  const s = exitSelProduct();
  if (s) {
    const arm = ($('exLoc') || {}).value === 'armazem';
    const cur = arm ? (Number(s.qArm) || 0) : (Number(s.qLoja) || 0);
    if (!(cur > 0)) {
      if (!arm && (Number(s.qArm) || 0) > 0) $('exLoc').value = 'armazem';
      else if (arm && (Number(s.qLoja) || 0) > 0) $('exLoc').value = 'loja';
    }
  }
  syncExitInfo();
}
function pickExitStock(s) {
  const el = $('exProd'); if (!el || !s) return;
  el.value = s.name || '';
  paintClear(el);
  closeSugg();
  onExitProductChange();
  const q = $('exQty');
  if (q) { q.focus(); try { q.select(); } catch (_) {} }
}
function exitProdFocus(e) {
  const t = e.target;
  if (!t || t.id !== 'exProd') {
    if (t && t.closest && t.closest('#suggPortal')) return;
    const openBox = $('suggPortal');
    if (openBox && openBox._anchor && openBox._anchor.id === 'exProd') closeSugg();
    return;
  }
  const box = $('suggPortal');
  if (box) {
    if (box._anchor === t) return;
    closeSugg();
  }
  showStockSuggestions(t, true, pickExitStock, true);
}
function onExitProdKey(e) {
  if (!e.target || e.target.id !== 'exProd') return;
  if (e.key === 'Escape') { closeSugg(); return; }
  const box = $('suggPortal');
  if (box && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
    const items = [...box.querySelectorAll('.sugg-item')];
    if (items.length) {
      let hi = items.findIndex(x => x.classList.contains('hi'));
      if (e.key === 'Enter' && hi < 0) { closeSugg(); }
      else {
        e.preventDefault();
        if (e.key === 'Enter') { (items[hi] || items[0]).click(); return; }
        hi = e.key === 'ArrowDown' ? hi + 1 : hi - 1;
        if (hi < 0 || hi >= items.length) hi = e.key === 'ArrowDown' ? 0 : items.length - 1;
        items.forEach(x => x.classList.remove('hi'));
        items[hi].classList.add('hi');
        if (items[hi].scrollIntoView) { try { items[hi].scrollIntoView({ block: 'nearest' }); } catch (_) {} }
        return;
      }
    }
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    closeSugg();
    const q = $('exQty');
    if (q) { q.focus(); try { q.select(); } catch (_) {} }
  }
}
function openExitStock(prodId) {
  if (!stock.length) return toast('Sem produtos no cadastro.', 'warning');
  const sorted = stock.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sel = $('exProd');
  /* Abre com o produto indicado; caso contrário escolhe o primeiro que tem
     stock. O campo é uma pesquisa: ao clicar mostra só produtos com stock. */
  const pick = (prodId && stock.find(s => s.id === prodId))
    || sorted.find(s => stockTotal(s) > 0)
    || null;
  closeSugg();
  if (sel) {
    sel.value = pick ? (pick.name || '') : '';
    paintClear(sel);
  }
  $('exQty').value = ''; $('exNotes').value = ''; $('exReason').value = '';
  const s0 = exitSelProduct();
  $('exLoc').value = s0 && (Number(s0.qLoja) || 0) > 0 ? 'loja' : (s0 && (Number(s0.qArm) || 0) > 0 ? 'armazem' : 'loja');
  syncExitInfo();
  $('exitStockModal').style.display = 'flex';
  setTimeout(() => { try { $('exQty').focus(); } catch (_) {} }, 30);
}
function saveExitStock() {
  const s = exitSelProduct();
  if (!s) return toast('Escolha um produto.', 'warning');
  const qty = Math.abs(Number($('exQty').value) || 0);
  if (!(qty > 0)) return toast('Indique a quantidade a dar baixa.', 'warning');
  const key = $('exReason').value;
  if (!EXIT_REASONS[key]) return toast('O motivo é obrigatório.', 'warning');
  const loc = $('exLoc').value === 'armazem' ? 'armazem' : 'loja';
  const cur = loc === 'armazem' ? (Number(s.qArm) || 0) : (Number(s.qLoja) || 0);
  if (qty > cur) return toast('Stock insuficiente no ' + (loc === 'armazem' ? 'armazém' : 'loja') + ' (existe ' + cur + ').', 'error');
  const label = EXIT_REASONS[key];
  const notes = ($('exNotes').value || '').trim();
  const price = Number(s.price) || 0;
  const total = Math.round(qty * price * 100) / 100;
  if (loc === 'armazem') s.qArm = cur - qty; else s.qLoja = cur - qty;
  s.updatedAt = Date.now();
  const mv = {
    id: uid(), productId: s.id, name: s.name, date: todayISO(), type: 'saida', qty: -qty,
    after: loc === 'armazem' ? s.qArm : s.qLoja, loc, ref: nextExitNumber(),
    price, total, value: total, unit: s.unit || '', notes,
    reason: 'Saída Direta / Ajuste — ' + label + (notes ? ' · ' + notes : ''),
    reasonKey: key, by: currentUser, operator: currentUser, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now()
  };
  movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
  pushQueue({ type: 'stock', payload: { ...s } });
  let loss = null;
  if (key === 'quebra' || key === 'consumo') {
    const unitCost = Number(s.cost) || Number(s.price) || 0;
    loss = {
      id: uid(), productId: s.id, name: s.name, date: mv.date, loc, qty, unitCost,
      total: Math.round(unitCost * qty * 100) / 100, reason: label, notes, by: currentUser, operator: currentUser,
      ts: mv.ts, createdAt: Date.now(), updatedAt: Date.now()
    };
    stockLosses.push(loss); pushQueue({ type: 'loss', payload: { ...loss } });
  }
  persist(); renderAll();
  closeSugg();
  $('exitStockModal').style.display = 'none';
  toast('Saída registada: −' + qty + (s.unit ? ' ' + s.unit : '') + ' (' + label + ') · Valor ' + MZN(total) + '.' + (loss ? ' Perda ao custo: ' + MZN(loss.total) + '.' : ''), 'success');
  if ($('infoModal').style.display === 'flex' && /^Produto/.test($('infoTitle').textContent)) openProductDetail(s.id);
}
function renderLosses() {
  const tb = $('lossTable') ? $('lossTable').querySelector('tbody') : null; if (!tb) return;
  const list = stockLosses.slice().sort((a, b) => String(b.date + (b.ts || 0)).localeCompare(String(a.date + (a.ts || 0))));
  tb.innerHTML = '';
  list.forEach(l => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + fmtDate(l.date) + '</td><td><strong>' + esc(l.name) + '</strong></td><td>' + (l.loc === 'armazem' ? 'Armazém' : 'Loja') + '</td>'
      + '<td style="text-align:right"><strong>−' + (Number(l.qty) || 0) + '</strong></td>'
      + '<td>' + esc(l.reason || '—') + (l.by ? ' <span class="hint">· ' + esc(userNameOf(l.by)) + '</span>' : '') + '</td>'
      + '<td style="text-align:right"><strong>' + MZN(Number(l.total) || 0) + '</strong></td>';
    tb.appendChild(tr);
  });
  if (!list.length) tb.innerHTML = '<tr><td colspan="6" class="hint">Sem perdas registadas.</td></tr>';
  if ($('lossCount')) $('lossCount').textContent = '(' + list.length + ')';
  if ($('despLoss')) $('despLoss').textContent = MZN(list.reduce((a, l) => a + (Number(l.total) || 0), 0));
}
if ($('btnCancelExitStock')) $('btnCancelExitStock').onclick = () => { closeSugg(); $('exitStockModal').style.display = 'none'; };
if ($('btnSaveExitStock')) $('btnSaveExitStock').onclick = saveExitStock;
if ($('exProd')) {
  $('exProd').onchange = onExitProductChange;
  $('exProd').oninput = (e) => {
    paintClear(e.target);
    const s = exitSelProduct();
    if (s) onExitProductChange(); else syncExitInfo();
    showStockSuggestions(e.target, false, pickExitStock, true);
  };
  $('exProd').addEventListener('keydown', onExitProdKey);
  document.addEventListener('focusin', exitProdFocus);
  document.addEventListener('click', exitProdFocus);
}
if ($('exProdClear')) $('exProdClear').onclick = (e) => {
  e.stopPropagation();
  const el = $('exProd'); if (!el) return;
  el.value = ''; paintClear(el); syncExitInfo(); closeSugg();
  el.focus();
  showStockSuggestions(el, true, pickExitStock, true);
};
if ($('exLoc')) $('exLoc').onchange = syncExitInfo;
if ($('exQty')) { $('exQty').oninput = syncExitInfo; $('exQty').onchange = syncExitInfo; }
if ($('exitStockModal')) $('exitStockModal').addEventListener('click', (e) => { if (e.target === $('exitStockModal')) { closeSugg(); $('exitStockModal').style.display = 'none'; } });
if ($('btnStockExit')) $('btnStockExit').onclick = () => openExitStock(null);
if ($('btnExitStockTop')) $('btnExitStockTop').onclick = () => openExitStock(null);
if ($('btnExitStockMoves')) $('btnExitStockMoves').onclick = () => openExitStock(null);
$('kardexProd').onchange = renderKardex;
$('btnAdjust').onclick = () => { $('adjModal').style.display = 'flex'; };
$('btnCancelAdj').onclick = () => { $('adjModal').style.display = 'none'; };
$('btnSaveAdj').onclick = () => {
  if (currentRole() === 'op') return toast('Ajustes: acesso do nível Caixa com Transferências.', 'error');
  const nm = ($('aProd').value || '').trim().toUpperCase();
  if (!nm) return toast('Indique o produto.', 'warning');
  const qty = Number($('aQty').value) || 0;
  if (qty <= 0) return toast('Indique a quantidade.', 'warning');
  const dir = $('aType').value === 'entrada' ? +1 : -1;
  const loc = ($('aLoc') || {}).value === 'armazem' ? 'armazem' : 'loja';
  const reason = $('aReason').value, notes = $('aNotes').value.trim();
  let s = findStock(nm);
  if (!s) {
    if (dir < 0) return toast('Produto não existe para dar saída.', 'error');
    s = { id: uid(), name: nm, unit: '', qLoja: 0, qArm: 0, cost: 0, price: 0, margin: 0, min: 0, updatedAt: Date.now() };
    stock.push(s);
  }
  if (s.qLoja == null) s.qLoja = 0;
  if (s.qArm == null) s.qArm = 0;
  if (loc === 'armazem') s.qArm = Math.max(0, s.qArm + dir * qty);
  else s.qLoja = Math.max(0, s.qLoja + dir * qty);
  s.updatedAt = Date.now();
  pushQueue({ type: 'stock', payload: { ...s } });
  const mv = { id: uid(), productId: s.id, name: nm, date: todayISO(), type: dir > 0 ? 'entrada' : 'saida', qty: dir * qty, after: loc === 'armazem' ? s.qArm : s.qLoja, loc, ref: '', reason: reason + (notes ? ' — ' + notes : ''), ts: Date.now() };
  movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
  $('aQty').value = ''; $('aNotes').value = '';
  $('adjModal').style.display = 'none';
  persist(); renderAll();
  toast('Ajuste aplicado: ' + nm + ' (' + (loc === 'armazem' ? 'Armazém' : 'Loja') + ') → ' + (loc === 'armazem' ? s.qArm : s.qLoja) + '.', 'success');
};
$('searchStock').oninput = renderStock;
if ($('filterStock')) $('filterStock').onchange = renderStock;
if ($('btnStockRecalc')) $('btnStockRecalc').onclick = () => rebuildStock();
$('btnStockImp').onclick = () => $('fileStock').click();
$('fileStock').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Contagem_de_Stock') || wb.worksheets[0];
    if (!ws) throw new Error('Folha não encontrada.');
    let added = 0, upd = 0, dup = 0;
    const seen = new Set();
    // Deteta formato: exportação própria (SKU|Nome|Categoria|Unidade|Loja|Armazém|Preço|Custo|Margem|Mín)
    // ou legado Contagem_de_Stock (Produto|Preço|Quantidade).
    let fullFmt = false;
    try {
      const h1 = String(xlsVal(ws.getRow(1).getCell(1)) || '').toLowerCase();
      const h2 = String(xlsVal(ws.getRow(1).getCell(2)) || '').toLowerCase();
      fullFmt = h1.indexOf('sku') !== -1 || h2.indexOf('nome') !== -1;
    } catch (_) {}
    ws.eachRow((row, n) => {
      if (fullFmt) {
        if (n <= 1) return;
        const name = String(xlsVal(row.getCell(2)) || '').trim().toUpperCase();
        if (!name) return;
        if (seen.has(name.toLowerCase())) { dup++; return; }
        seen.add(name.toLowerCase());
        const rec = { sku: String(xlsVal(row.getCell(1)) || '').trim().toUpperCase(), cat: String(xlsVal(row.getCell(3)) || '').trim(), unit: String(xlsVal(row.getCell(4)) || '').trim().toUpperCase(), qLoja: Math.max(0, toNum(xlsVal(row.getCell(5)))), qArm: Math.max(0, toNum(xlsVal(row.getCell(6)))), price: toNum(xlsVal(row.getCell(7))), cost: toNum(xlsVal(row.getCell(8))), margin: toNum(xlsVal(row.getCell(9))), min: toNum(xlsVal(row.getCell(10))) || 0, updatedAt: Date.now() };
        if (rec.cost <= 0) rec.cost = rec.price;
        let s = findStock(name);
        if (s) { Object.assign(s, rec); upd++; }
        else { s = { id: uid(), name, createdAt: Date.now(), ...rec }; stock.push(s); added++; }
        pushQueue({ type: 'stock', payload: { ...s } });
        return;
      }
      const name = String(xlsVal(row.getCell(1)) || '').trim().toUpperCase();
      if (!name || (n === 1 && /^produto$/i.test(name))) return;
      if (seen.has(name.toLowerCase())) { dup++; return; }
      seen.add(name.toLowerCase());
      const price = toNum(xlsVal(row.getCell(2))), qty = Math.max(0, toNum(xlsVal(row.getCell(3))));
      let s = findStock(name);
      let delta = qty;
      if (s) { delta = qty - (Number(s.qArm) || 0); s.qArm = qty; s.price = price; if (!Number(s.cost)) s.cost = price; s.updatedAt = Date.now(); upd++; }
      else { s = { id: uid(), name, unit: '', qLoja: 0, qArm: qty, price, cost: price, margin: 0, min: 0, updatedAt: Date.now() }; stock.push(s); added++; }
      pushQueue({ type: 'stock', payload: { ...s } });
      if (delta !== 0) {
        const mv = { id: uid(), productId: s.id, name, date: todayISO(), type: delta > 0 ? 'entrada' : 'saida', qty: delta, after: Number(s.qArm) || 0, loc: 'armazem', ref: 'IMPORT', reason: 'Contagem de stock', ts: Date.now() };
        movements.push(mv); pushQueue({ type: 'move', payload: { ...mv } });
      }
    });
    dedupeStock(true);
    persist(); renderAll();
    toast('Produtos importados: ' + added + ' novos, ' + upd + ' atualizados' + (dup ? ', ' + dup + ' duplicados bloqueados' : '') + '.', dup ? 'warning' : 'success');
    if (dup && window.Swal) Swal.fire({ icon: 'warning', title: 'Produto já cadastrado', text: dup + ' linha(s) duplicada(s) bloqueada(s). Utilize a edição para alterar o preço ou o stock.' });
  } catch (err) { toast('Falha ao importar: ' + (err && err.message), 'error'); }
};

/* ---------- modal genérico de detalhe ---------- */
let reopenStockAfterInfo = false;
let markedPreview=null;
let saleCopyCount=1;
let previewZoom=1;
const PREVIEW_ZOOM_MIN=.4,PREVIEW_ZOOM_MAX=3;
function openInfo(title, html) {
  $('markedPreviewNav')?.remove();
  delete $('infoModal').dataset.saleId;
  $('infoModal').classList.remove('sale-document-modal','notification-modal');
  if ($('btnPdfInfo')) $('btnPdfInfo').hidden = true;
  if ($('btnPrintInfo')) $('btnPrintInfo').hidden = false;
  $('infoTitle').textContent = title;
  $('infoBody').querySelectorAll('.document-preview-stage').forEach(el=>el._observer?.disconnect());
  $('infoBody').innerHTML = html;
  $('infoModal').style.display = 'flex';
}
function closeInfo() {
  markedPreview=null;
  saleCopyCount=1;
  previewZoom=1;
  $('infoModal').style.display = 'none';
  if (reopenStockAfterInfo) {
    reopenStockAfterInfo = false;
    const sm = $('stockModal');
    if (sm) { sm.style.display = 'flex'; try { renderStock(); } catch (_) {} }
  }
}
function detBadge(text, cls) { return `<span class="det-badge ${cls || ''}">${text}</span>`; }
function detMeta(rows) {
  return `<div class="det-meta">` + rows.map(r => `<span><i>${esc(r[0])}</i><b>${r[1]}</b></span>`).join('') + `</div>`;
}
function detKpis(items) {
  return `<div class="det-kpis">` + items.map(k => `<div class="det-kpi ${k.cls || ''}"><span>${esc(k.label)}</span><strong>${k.value}</strong></div>`).join('') + `</div>`;
}
function openSaleDetail(id, preview = true, fromMarked = false) {
  if(!fromMarked) markedPreview=null;
  const s = sales.find(x => x.id === id); if (!s) return;
  if(!canSeeSale(s)) return toast('Este documento pertence a outro utilizador.','error');
  const nc = ncs.filter(n => n.saleId === id).reduce((a, n) => a + (Number(n.total) || 0), 0);
  const falta = Math.max(saleBalance(s), 0);
  const st = saleStatus(s);
  const stCls = st === 'Pago' ? 'ok' : (st === 'Parcial' ? 'warn' : (st === 'Pendente' ? 'bad' : 'gray'));
  const rows = (s.items || []).map((p, ix) => `<tr><td>${ix + 1}</td><td class="n">${esc(fmtQty(p))}</td><td>${esc(p.desc)}</td><td class="n">${MZN(p.price)}</td><td class="n"><strong>${MZN(p.total)}</strong></td></tr>`).join('')
    || '<tr><td colspan="5" class="hint">Sem linhas.</td></tr>';
  const pays = (s.payments || []).map(p => `<li><span>${fmtDate(p.date)}</span><em>${esc(p.method || '')}${p.doc ? ' · ' + esc(p.doc) : ''}</em><strong>${MZN(p.amount)}</strong></li>`).join('')
    || '<li class="hint">Sem pagamentos registados.</li>';
  openInfo('Venda ' + s.number,
    `<div class="det-top"><div class="det-id"><strong>${esc(s.client || 'Balcão')}</strong>`
    + detBadge(esc(saleKindName(s.type)), s.type === 'credito' ? 'warn' : (s.type === 'cotacao' ? 'gray' : 'ok'))
    + detBadge(esc(st), stCls) + `</div><div class="det-date">${fmtDate(s.date)} ${esc(s.time || '')}</div></div>`
    + detMeta([
      ['Local de saída', s.loc === 'loja' ? 'Loja' : 'Armazém'],
      ['Operador', esc(issuedByLabel(s.operator))],
      ['Guia de remessa', s.grNumber ? esc(s.grNumber) : '—'],
      ['Valor entregue', s.received != null ? MZN(s.received) : '—'],
      ['Troco', Number(s.change) > 0 ? MZN(s.change) : '—'],
      ['Observações', s.notes ? esc(s.notes) : '—']
    ])
    + `<div class="det-items"><table><thead><tr><th>#</th><th>Qtd</th><th>Produto</th><th>Preço</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + detKpis([
      { label: 'Total', value: MZN(s.total) },
      { label: 'Recebido', value: MZN(Number(s.received) || Number(s.paid) || 0), cls: 'ok' },
      { label: 'Troco', value: MZN(Number(s.change) || 0), cls: Number(s.change) > 0 ? 'warn' : '' },
      { label: 'Notas de crédito', value: MZN(nc), cls: nc > 0 ? 'warn' : '' },
      { label: 'Em falta', value: MZN(falta), cls: falta > 0 ? 'bad' : 'ok' }
    ])
    + `<h4 class="det-h">Pagamentos</h4><ul class="det-pays">${pays}</ul>`);
  if(!preview) {
    $('infoTitle').textContent=(billingMode()?'Detalhes da faturação ':'Detalhes da venda ')+s.number;
    if(s.billingOnly || billingMode()) $('infoBody').innerHTML=detMeta([['Documento',esc(s.number)],['Cliente',esc(s.client || 'Consumidor final')],['Data',fmtDate(s.date)],['Emitido por',esc(issuedByLabel(s.operator))],['Observações',esc(s.notes || '—')]])+'<div class="det-items"><table><thead><tr><th>#</th><th>Qtd</th><th>Produto</th><th>Preço</th><th>Total</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+detKpis([{label:'Total',value:MZN(s.total)}]);
    const actions=document.createElement('div');actions.className='panel-actions';
    const button=document.createElement('button');button.type='button';button.className='btn primary';button.textContent='Pré-visualizar documento';button.onclick=()=>openSaleDetail(s.id);actions.appendChild(button);$('infoBody').appendChild(actions);
    $('btnPrintInfo').hidden=true;
    return;
  }
  const details = $('infoBody').innerHTML;
  const alreadyIssued = Number(s.printCount) > 0;
  const copyOptions = alreadyIssued
    ? '<option value="1">1 · Duplicata</option>'
    : '<option value="1">1 · Original</option><option value="2">2 · Original + Duplicata</option>';
  saleCopyCount = 1;
  $('infoTitle').textContent = 'Documento ' + s.number;
  $('infoBody').innerHTML = '<div class="document-workspace"><div class="document-preview-card"><button type="button" class="preview-zoom" id="previewZoomBadge" title="Ctrl + roda do rato amplia · clique para ajustar">Ajustar</button><div class="document-preview-stage">' + saleDocumentHtml(s) + '</div></div><aside class="document-inspector"><h3>Informações do documento</h3><span class="document-copy">' + (alreadyIssued?'Duplicata':'Original') + '</span>' + detMeta([['Cliente',esc(s.client || 'Consumidor final')],['Data',fmtDate(s.date)],['Emitido por',esc(issuedByLabel(s.operator))],['Pagamento',esc(saleStatus(s))],['Total',MZN(s.total)]]) + '<div class="document-printer"><span>Impressora</span><b id="docPrinterName">A detetar…</b></div>' + '<label class="document-copies" for="saleCopies"><span>Cópias a imprimir</span><select id="saleCopies"' + (alreadyIssued?' disabled':'') + '>' + copyOptions + '</select></label>' + (alreadyIssued?'<p class="hint">O Original já saiu — esta emissão é a Duplicata. Para imprimir Original + Duplicata de uma vez, faça-o antes da primeira impressão/download.</p>':'<p class="hint">Pode imprimir o Original e a Duplicata juntos, antes da primeira saída.</p>') + '<p class="hint">Ctrl + roda do rato amplia a pré-visualização.</p>' + (invoiceIssues(s).length?'<details class="document-issues"><summary>Histórico de saídas ('+invoiceIssues(s).length+')</summary><ul>'+invoiceIssues(s).slice().reverse().map(issue=>'<li>'+esc(issue.format==='pdf'?'PDF':'Impressão')+' · '+esc(issue.copy)+'<small>'+esc(fmtDateTime(issue.at))+'</small></li>').join('')+'</ul></details>':'') + (s.billingOnly || billingMode() ? '' : '<details><summary>Pagamentos e detalhes</summary>' + details + '</details>') + '</aside></div>';
  if ($('saleCopies')) { $('saleCopies').value = '1'; $('saleCopies').onchange = () => { saleCopyCount = Number($('saleCopies').value) === 2 ? 2 : 1; }; }
  fillPreviewPrinter();
  requestAnimationFrame(() => {
    const stage=$('infoBody').querySelector('.document-preview-stage'), doc=stage?.querySelector('.sale-document');
    if(!doc) return;
    previewZoom=1;
    const card=stage.closest('.document-preview-card'), badge=$('previewZoomBadge');
    const apply=()=>{
      const scale=(stage._baseScale||1)*previewZoom;
      doc.style.zoom=String(scale);
      const wide=(stage._docWidth||794)*scale > stage.clientWidth+1;
      doc.style.left=wide?'0':'50%';
      doc.style.transform=wide?'none':'translateX(-50%)';
      if(badge) {
        badge.textContent=previewZoom===1?'Ajustar':Math.round(scale*100)+'%';
        badge.classList.toggle('is-zoomed',previewZoom!==1);
        badge.title=previewZoom===1?'Ctrl + roda do rato para ampliar':'Clique para repor o tamanho da folha';
      }
    };
    const fit=()=>{
      /* Mede sempre com a folha em tamanho real e a partir do cartão (não da
         área com scroll), para as barras não alterarem a escala. */
      doc.style.zoom='1';
      const cs=card?getComputedStyle(card):null;
      const availW=card?card.clientWidth-(parseFloat(cs.paddingLeft)||0)-(parseFloat(cs.paddingRight)||0):stage.clientWidth;
      const availH=card?card.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0):stage.clientHeight;
      stage._docWidth=doc.offsetWidth||794;
      stage._baseScale=Math.min(availW/stage._docWidth,(availH||stage.clientHeight)/doc.scrollHeight,1);
      apply();
    };
    if(window.ResizeObserver) { const observer=new ResizeObserver(fit);observer.observe(card||stage);stage._observer=observer; }
    if(badge) badge.onclick=()=>{previewZoom=1;fit();};
    if(card && !card._wheelZoom) {
      card._wheelZoom=e=>{
        if(!e.ctrlKey) return;
        e.preventDefault();
        previewZoom=Math.min(PREVIEW_ZOOM_MAX,Math.max(PREVIEW_ZOOM_MIN,previewZoom*(e.deltaY<0?1.12:1/1.12)));
        apply();
      };
      card.addEventListener('wheel',card._wheelZoom,{passive:false});
    }
    fit();
  });
  $('infoModal').dataset.saleId = s.id;
  $('infoModal').classList.add('sale-document-modal');
  if ($('btnPdfInfo')) $('btnPdfInfo').hidden = false;
  renderMarkedPreviewNav(s.id);
}
async function fillPreviewPrinter() {
  const el = $('docPrinterName');
  if (!el) return;
  try {
    const list = window.api && window.api.listPrinters ? await window.api.listPrinters() : [];
    const physical = (list || []).filter(p => p && p.name && !/(pdf|onenote|fax|xps|virtual|print to)/i.test(p.name));
    const pick = physical.find(p => p.isDefault) || physical[0];
    if (el.isConnected) el.textContent = pick ? (pick.displayName || pick.name) : 'Nenhuma impressora ligada';
  } catch (_) { if (el.isConnected) el.textContent = '—'; }
}
function openAllInvoicePreviews() {
  const ids=dashboardSales().map(s=>s.id);
  if(!ids.length) return toast('Ainda não há documentos emitidos.','info');
  markedPreview={ids,index:0,label:'Documento'};
  openSaleDetail(ids[0],true,true);
}
if($('btnPreviewAllInvoices')) $('btnPreviewAllInvoices').onclick=openAllInvoicePreviews;
function renderMarkedPreviewNav(id) {
  if(!markedPreview)return;
  markedPreview.index=markedPreview.ids.indexOf(id);
  if(markedPreview.index<0){markedPreview=null;return;}
  const nav=document.createElement('div');nav.id='markedPreviewNav';nav.className='marked-preview-nav';nav.setAttribute('aria-label','Documentos marcados');
  const previous=document.createElement('button');previous.type='button';previous.className='btn marked-preview-arrow previous';previous.setAttribute('aria-label','Documento marcado anterior');previous.title='Documento anterior';previous.innerHTML='<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';previous.disabled=markedPreview.index===0;
  const count=document.createElement('span');count.setAttribute('aria-live','polite');count.textContent=(markedPreview.label||'Marcado')+' '+(markedPreview.index+1)+' de '+markedPreview.ids.length;
  const next=document.createElement('button');next.type='button';next.className='btn marked-preview-arrow next';next.setAttribute('aria-label','Próximo documento marcado');next.title='Próximo documento';next.innerHTML='<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';next.disabled=markedPreview.index===markedPreview.ids.length-1;
  previous.onclick=()=>openSaleDetail(markedPreview.ids[markedPreview.index-1],true,true);
  next.onclick=()=>openSaleDetail(markedPreview.ids[markedPreview.index+1],true,true);
  nav.append(previous,count,next);$('infoBody').querySelector('.document-preview-card').appendChild(nav);
}
/* ---------- vendas e créditos (debitam stock) ---------- */
const saleBalance = (s) => (Number(s.total) || 0) - (Number(s.paid) || 0) - (Number(s.ncTotal) || 0);
const saleStatus = (s) => s.billingOnly ? (s.billingPaymentStatus || 'Não informado') : s.type === 'cotacao' ? (s.status || 'Pendente') : (saleBalance(s) <= 0 ? 'Pago' : ((Number(s.paid) || 0) > 0 ? 'Parcial' : 'Pendente'));
const saleKindName = (t) => billingMode() ? 'Proforma' : saleKind({ type: t }) === 'credito' ? 'Crédito' : saleKind({ type: t }) === 'cotacao' ? 'Proforma' : 'Venda';
function nextSaleNumber(kind) {
  kind = kind || 'venda';
  const pfx = billingMode() ? 'PF' : kind === 'credito' ? 'FT' : kind === 'cotacao' ? 'FP' : 'VD';
  const y = new Date().getFullYear();
  const previous = pfx === 'PF' ? Number(load('dec_billing_seq_' + y, 0)) || 0 : 0;
  const n = Math.max(previous, ...sales.filter(s => String(s.number || '').startsWith(pfx + ' ' + y + '/')).map(s => Number(String(s.number).split('/').pop()) || 0), 0) + 1;
  return pfx + ' ' + y + '/' + String(n).padStart(3, '0');
}
function recordSaleIssue(s,format) {
  const issue={id:uid(),at:Date.now(),operator:currentUser,format,copy:Number(s.printCount)>0?'Duplicata':'Original'};
  const own=String(s.operator||'').toLowerCase()===String(currentUser||'').toLowerCase();
  if(currentRole()!=='admin' && !own){s.printEvents={...(s.printEvents||{}),[issue.id]:issue};s.printCount=Math.max(Number(s.printCount)||0,invoiceIssues(s).length);pushQueue({type:'sale-print-event',payload:{...issue,saleId:s.id}});}
  else {s.issues=[...Object.values(s.issues||{}),issue];s.printCount=(Number(s.printCount)||0)+1;s.updatedAt=issue.at;pushQueue({type:'sale',payload:{...s}});}
  persist();if($('infoModal').dataset.saleId===s.id)openSaleDetail(s.id,true,!!markedPreview);
}

async function billingNumber(proposed) {
  const year=new Date().getFullYear(), prefix='PF '+year+'/';
  const input=String(proposed||'').trim();
  if(input && !new RegExp('^(PF|VD|FT|FP) '+year+'/\\d+$').test(input)) {
    if(sales.some(s=>String(s.number||'').toLowerCase()===input.toLowerCase())) throw new Error('Este número de fatura já existe.');
    return input;
  }
  const requested=input.startsWith(prefix) ? Number(input.slice(prefix.length)) : 0;
  if(!Number.isSafeInteger(requested) || requested<0) throw new Error('Número de fatura inválido.');
  const floor=Math.max(Number(nextSaleNumber('cotacao').split('/').pop())-1,requested-1);
  let number=floor+1;
  if(isOnline() && rdb && cloudUid()) {
    const result=await cloudRef('sequences/billing/'+year).transaction(current=>Math.max(Number(current)||0,floor)+1);
    if(!result.committed) throw new Error('Não foi possível reservar o número da fatura. Tente novamente.');
    number=Number(result.snapshot.val());
  }
  save('dec_billing_seq_'+year,Math.max(number,Number(load('dec_billing_seq_'+year,0))||0));
  return prefix+String(number).padStart(3,'0');
}
function stockQty(nm, loc) {
  const s = stock.find(x => (x.name || '').toLowerCase() === String(nm || '').toLowerCase());
  if (!s) return 0;
  if (loc === 'armazem') return Number(s.qArm) || 0;
  if (loc === 'loja') return Number(s.qLoja) || 0;
  return stockTotal(s);
}
function reserveStock(nm, qty) { /* conceito de reserva removido por regra de negócio */ }
function releaseReserve(nm, qty) { /* conceito de reserva removido por regra de negócio */ }
function resetSaleForm() {
  delete $('sClient').dataset.clientId;
  $('sDate').value = fmtDate(todayISO()); $('sNumber').value = nextSaleNumber($('sType') ? $('sType').value : 'venda');
  $('sBillingPaid').value='Não paga'; $('sClient').value = ''; $('sType').value = 'venda'; $('sPaid').value = ''; $('sPay').value = lastPayMethod() || ''; $('sNotes').value = '';
  if ($('sIva')) { $('sIva').dataset.touched = ''; }
  applyTaxDefaults();
  if ($('sIvaMotive') && tax.exempt) $('sIvaMotive').value = '';
  const scfg = stockCfg();
  if ($('sLoc')) $('sLoc').value = scfg.origin === 'loja' && scfg.useLoja ? 'loja' : 'armazem';
  lastDraftSig = '';
  draftFresh = false;
  if ($('cliAvailHint')) $('cliAvailHint').textContent = '';
  document.querySelectorAll('#saleTypeCards .type-card').forEach(c => c.classList.toggle('active', c.dataset.kind === 'venda'));
  saleGrand = 0;
  saleIssue('');
  resetSaleRows();
  updateSaleChange();
}
function lastPayMethod() { try { return localStorage.getItem('dec_lastpay') || ''; } catch (_) { return ''; } }
function rememberPayMethod(pm) { try { if (pm) localStorage.setItem('dec_lastpay', pm); } catch (_) {} }
$('btnSaveSale').onclick = async () => {
  saleIssue('');
  const rawItems = readItems('saleRows');
  if (!rawItems.length) { saleIssue('Adicione pelo menos 1 produto à venda.'); return toast('Adicione pelo menos 1 produto.', 'warning'); }
  const semProduto = rawItems.filter(p => !p.desc);
  if (semProduto.length) {
    saleIssue('Indique o produto em todas as linhas da venda.');
    toast('Indique o produto em todas as linhas.', 'warning');
    const bad = [...$('saleRows').querySelectorAll('.prod-row')].find(r => {
      const d = (r.querySelector('.p-desc').value || '').trim();
      const q = Number(r.querySelector('.p-qty').value) || 0;
      const pr = Number(r.querySelector('.p-price').value) || 0;
      return (q || pr) && !d;
    });
    if (bad) { const f = bad.querySelector('.p-desc'); f.focus(); }
    return;
  }
  /* Nunca criar venda (nem crédito/cotação) com quantidade zero ou negativa. */
  const semQtd = rawItems.filter(p => !(Number(p.qty) > 0));
  if (semQtd.length) {
    const nomes = semQtd.map(p => p.desc || 'linha sem produto').join(' · ');
    saleIssue('Quantidade inválida: ' + nomes + '. A quantidade tem de ser maior que zero.');
    toast('A quantidade tem de ser maior que zero.', 'error');
    const bad = [...$('saleRows').querySelectorAll('.prod-row')].find(r => {
      const d = (r.querySelector('.p-desc').value || '').trim();
      const q = Number(r.querySelector('.p-qty').value) || 0;
      const pr = Number(r.querySelector('.p-price').value) || 0;
      return (d || pr) && !(q > 0);
    });
    if (bad) { const q = bad.querySelector('.p-qty'); q.focus(); try { q.select(); } catch (_) {} }
    return;
  }
  const date = parseBRDate($('sDate').value);
  if (!date) { saleIssue('Data inválida. Escreva DD-MM-AAAA (ex.: 23-10-2026).'); return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning'); }
  const type = billingMode() ? 'cotacao' : $('sType').value;
  const items = rawItems.map(p => ({ ...p, cost: stockCost(p.desc) }));
  const total = items.reduce((a2, p) => a2 + p.total, 0);
  const rawPaid = $('sPaid').value === '' ? null : parseMoney($('sPaid').value);
  const received = type === 'cotacao' ? 0 : (rawPaid == null ? (type === 'venda' ? total : 0) : Math.max(0, rawPaid));
  const change = type === 'venda' ? Math.max(0, Math.round((received - total) * 100) / 100) : 0;
  let paid = type === 'cotacao' ? 0 : Math.min(received, total);
  const pm = $('sPay').value.trim() || 'Numerário';
  rememberPayMethod(pm);
  if (!payMethods.includes(pm)) { payMethods.push(pm); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); }
  let uCh = false;
  items.forEach(p => { if (p.unit && !units.includes(p.unit)) { units.push(p.unit); uCh = true; } });
  if (uCh) pushQueue({ type: 'settings', payload: { key: 'units', list: units } });
  renderPayUnits();
  const clientName = $('sClient').value.trim();
  const chosenClient=clients.find(c=>c.id===$('sClient').dataset.clientId && clientNameKey(c.name)===clientNameKey(clientName));
  const client = chosenClient || (clientName ? findClientByName(clientName) : null);
  if (type === 'credito') {
    if (!client) { saleIssue('Venda a crédito exige um cliente registado. Crie o cliente em Clientes e volte a tentar.'); return toast('Venda a crédito exige cliente registado. Crie em Clientes.', 'error'); }
  }
  const doSave = async () => {
    const ivaMode = $('sIva').value, ivaMotive = $('sIvaMotive').value.trim();
    if (!billingMode() && ivaMode === 'isento' && !ivaMotive) { saleIssue('Se escolheu «Isento de IVA», indique a fundamentação legal.'); return toast('Indique a fundamentação legal da isenção.', 'warning'); }
    const loc = billingMode() || ($('sLoc') || {}).value === 'armazem' ? 'armazem' : 'loja';
    const tNow = new Date();
    const timeStr = String(tNow.getHours()).padStart(2, '0') + ':' + String(tNow.getMinutes()).padStart(2, '0');
    const billingOnly=billingMode();
    let number=$('sNumber').value.trim() || nextSaleNumber(type);
    if(billingOnly) { try { number=await billingNumber(number); } catch(error) { saleIssue(error.message); toast(error.message,'error'); return; } }
    const s = { billingOnly, billingPaymentStatus:billingOnly ? $('sBillingPaid').value : null, id: uid(), number, date, time: timeStr, client: clientName, clientId: client ? client.id : null, type, loc, items, total, paid, received, change, payMethod: pm, notes: $('sNotes').value.trim(), iva: billingOnly ? null : ivaMode, ivaMotive: billingOnly ? '' : ivaMotive, status: type === 'cotacao' ? 'Pendente' : null, convertedId: null, payments: [], hash: '', prevHash: '', operator: currentUser, createdAt: Date.now(), updatedAt: Date.now() };
    s.prevHash = lastSaleHash();
    s.hash = await sha256hex(s.number + '|' + s.date + '|' + s.time + '|' + s.total + '|' + s.prevHash);
    sales.push(s); pushQueue({ type: 'sale', payload: { ...s } });
    if (paid > 0 && type !== 'cotacao') {
      if (type === 'credito') {
        const rc0 = { id: uid(), number: nextReciboNumber(), clientId: s.clientId, client: s.client, date, total: paid, method: pm, allocations: [{ saleId: s.id, number: s.number, amount: paid }], hash: '', prevHash: '', ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
        rc0.prevHash = lastRcHash();
        rc0.hash = await sha256hex(rc0.number + '|' + rc0.date + '|' + rc0.total + '|' + rc0.prevHash);
        s.payments = [{ date, amount: paid, method: pm, doc: rc0.number }];
        receipts.push(rc0); pushQueue({ type: 'receipt', payload: { ...rc0 } });
        pushQueue({ type: 'sale', payload: { ...s } });
      } else {
        s.payments = [{ date, amount: paid, method: pm, doc: null }];
        pushQueue({ type: 'sale', payload: { ...s } });
      }
    }
    if (type !== 'cotacao') {
      stockApply(items, -1, true, s.number, loc);
      // Reserva para FT (entrega agendada): aloca imediatamente sobre o disponível
      if (type === 'credito') items.forEach(p => reserveStock(p.desc, p.qty));
      if (paid > 0) cashAdd(date, 'entrada', type === 'credito' ? 'Amortização de crédito' : 'Venda a pronto', paid, pm, s.number, clientName, true);
      if (loc === 'armazem' && !s.grNumber) {
        s.grNumber = nextGrNumber(); s.grFrom = 'Armazém'; s.updatedAt = Date.now();
        pushQueue({ type: 'sale', payload: { ...s } });
      }
    } else {
      // Proforma aprovada reserva stock sem abater físico
      items.forEach(p => reserveStock(p.desc, p.qty));
    }
    saleIssue('');
    const download=$('saleDownload').checked, print=$('salePrint').checked;
    resetSaleForm(); renderAll();
    if(print) await printSaleDocument(s, saleCopyCount);
    else if(download) await salePdf(s, saleCopyCount);
    toast(s.billingOnly ? 'Fatura registada: ' + s.number : (type === 'cotacao' ? 'Cotação registada (sem abater stock).' : (type === 'credito' ? 'Fatura a crédito registada. Stock debitado (' + (loc === 'armazem' ? 'Armazém' : 'Loja') + ').' : 'Venda registada. Stock debitado (' + (loc === 'armazem' ? 'Armazém' : 'Loja') + ').') + (loc === 'armazem' && type !== 'cotacao' ? ' GR ' + s.grNumber + ' emitida (recolha no Armazém).' : '')), 'success');
  };
  if (type === 'cotacao') return await doSave();
  const locNow = ($('sLoc') || {}).value === 'armazem' ? 'armazem' : 'loja';
  const falta = items.filter(p => stockQty(p.desc, locNow) < p.qty);
  // Sem stock não vende: bloqueio rígido, sem bypass (aviso abreviado com "Ver mais")
  if (falta.length) {
    const other = locNow === 'armazem' ? 'loja' : 'armazem';
    const otherOk = falta.every(p => stockQty(p.desc, other) >= p.qty);
    saleIssue('Falta stock no ' + (locNow === 'armazem' ? 'Armazém' : 'Loja') + ': ' + falta.map(p => p.desc + ' (pede ' + p.qty + ')').join(' · ')
      + (otherOk ? '\nHá stock suficiente na ' + (other === 'armazem' ? 'Armazém' : 'Loja') + ' — use «Vender da ' + (other === 'armazem' ? 'Armazém' : 'Loja') + '».' : '\nDê entrada de stock antes de vender.'));
    if (!stockBlockAlert(falta, locNow, 'venda')) toast(`Sem stock — venda bloqueada (${falta.length} item(ns)).`, 'error');
    return;
  }
  return await doSave();
};
let saleSaving = false;
const saveSaleHandler = $('btnSaveSale').onclick;
$('btnSaveSale').onclick = async () => {
  if (saleSaving) return;
  saleSaving = true; $('btnSaveSale').disabled = true;
  try { return await saveSaleHandler(); }
  finally { saleSaving = false; $('btnSaveSale').disabled = false; }
};
let saleSelected = new Set();
function renderSaleBulk() {
  const bar = $('saleBulkBar'); if (!bar) return;
  const rows=[...document.querySelectorAll('#saleTable tbody tr[data-sid]')];
  const visible=new Set(rows.map(row=>row.dataset.sid));
  saleSelected=new Set([...saleSelected].filter(id=>visible.has(id)));
  bar.classList.toggle('show', saleSelected.size > 0);
  if ($('saleSelCount')) $('saleSelCount').textContent = saleSelected.size + ' selecionada(s)';
  const all = $('saleCheckAll'); if (all) {all.checked=rows.length>0 && rows.every(row=>saleSelected.has(row.dataset.sid));all.indeterminate=saleSelected.size>0&&!all.checked;}
  if ($('btnSaleDelSel')) $('btnSaleDelSel').style.display = currentRole() === 'admin' ? '' : 'none';
  document.querySelectorAll('#saleTable tbody tr').forEach(tr => tr.classList.toggle('active', saleSelected.has(tr.dataset.sid)));
}
if ($('saleCheckAll')) $('saleCheckAll').onchange = (e) => {
  document.querySelectorAll('#saleTable tbody .ssel').forEach(cb => {
    const id = cb.closest('tr').dataset.sid;
    if (e.target.checked) saleSelected.add(id); else saleSelected.delete(id);
    cb.checked = e.target.checked;
  });
  document.querySelectorAll('#saleTable tbody tr').forEach(tr => tr.classList.toggle('active', saleSelected.has(tr.dataset.sid)));
  renderSaleBulk();
};
if ($('btnSalePdfSel')) $('btnSalePdfSel').onclick = () => {
  const ids=[...saleSelected].filter(id=>sales.some(s=>s.id===id && canSeeSale(s)));
  if(!ids.length)return;
  markedPreview={ids,index:0};openSaleDetail(ids[0],true,true);
};
if ($('btnSaleGuiaSel')) $('btnSaleGuiaSel').onclick = () => {
  [...saleSelected].forEach((id, ix) => { const s = sales.find(x => x.id === id); const own = s && String(s.operator || '').toLowerCase() === String(currentUser || '').toLowerCase(); if (s && (currentRole() === 'admin' || own) && s.type !== 'cotacao') setTimeout(() => emitGuia(s.id), ix * 400); });
};
if ($('btnSaleDelSel')) $('btnSaleDelSel').onclick = async () => {
  if (currentRole() !== 'admin') return toast('Remover vendas: acesso Administrador.', 'error');
  if (!saleSelected.size) return;
  const blocked = [...saleSelected].filter(id => {
    const s = sales.find(x => x.id === id);
    return s && ((s.payments || []).some(p => p.doc && p.doc.indexOf('REC') === 0) || ncs.some(n => n.saleId === s.id));
  });
  if (blocked.length) return toast(blocked.length + ' venda(s) têm recibos/NC. Emita NC em vez de apagar.', 'error');
  if (!await confirmDlg('Remover vendas?', saleSelected.size + ' documento(s) serão apagados e o stock reposto.')) return;
  const ops = [];
  [...saleSelected].forEach(id => {
    const s = sales.find(x => x.id === id); if (!s) return;
    ops.push({ type: 'delete-sale', payload: { id } });
    if (!s.billingOnly && s.type !== 'cotacao') stockApply(s.items, +1, true, s.number, s.loc || 'loja');
  });
  sales = sales.filter(x => !saleSelected.has(x.id));
  saleSelected.clear();
  pushQueueBulk(ops);
  persist(); renderAll(); toast('Vendas removidas, stock reposto.', 'success');
};
function renderSales() {
  const opSel = $('filterOperator'), opBar = $('operatorBar');
  const operatorFilterOn = billingMode() && currentRole() === 'admin';
  if (opBar) opBar.style.display = operatorFilterOn ? '' : 'none';
  if (opSel && !operatorFilterOn) opSel.value = '';
  if (opSel && operatorFilterOn) {
    const seen = new Set(), rows = [];
    sales.forEach(s => {
      if (!canSeeSale(s)) return;
      const key = String(s.operator || '').toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key); rows.push({ key: key, name: operatorNameOf(s.operator) });
    });
    /* Inclui operadores sem documentos (0 facturado) para se poder filtrar por todos. */
    appUsers().forEach(u => {
      const key = String(u.email || '').toLowerCase();
      if (!key || u.role === 'admin' || seen.has(key)) return;
      seen.add(key); rows.push({ key: key, name: operatorNameOf(u.email) });
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const keep = String(opSel.value || '').toLowerCase();
    opSel.innerHTML = '<option value="">Todos os operadores</option>' + rows.map(x => '<option value="' + esc(x.key) + '">' + esc(x.name) + '</option>').join('');
    opSel.value = rows.some(x => x.key === keep) ? keep : '';
  }
  const op = opSel ? String(opSel.value || '').toLowerCase() : '';
  const f = $('filterSale').value, q = (($('searchSale').value || '').toLowerCase());
  const tb = $('saleTable').querySelector('tbody'); tb.innerHTML = '';
  const isAdmin = currentRole() === 'admin';
  const me = String(currentUser || '').toLowerCase();
  const list = [...sales].sort((a, b) => b.createdAt - a.createdAt).filter(s => {
    if (!canSeeSale(s)) return false;
    if (op && String(s.operator || '').toLowerCase() !== op) return false;   // conta normal só vê os seus documentos
    if ((f === 'venda' || f === 'credito' || f === 'cotacao') && s.type !== f) return false;
    if (f === 'divida' && saleBalance(s) <= 0) return false;
    if (q && ((s.number || '') + ' ' + (s.client || '')).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  $('saleCount').textContent = '(' + list.length + ')';
  if ($('operatorStats')) {
    const total = list.reduce((value, s) => value + (Number(s.total) || 0), 0);
    $('operatorStats').innerHTML = '<strong>' + list.length + '</strong> documento(s) · Total facturado: <strong>' + MZN(total) + '</strong>' + (op ? ' · ' + esc(userNameOf(op)) : '');
  }
  list.forEach(s => {
    const falta = saleBalance(s);
    const recv = Number(s.received) || Number(s.paid) || 0;
    const troco = Number(s.change) || 0;
    const own = String(s.operator || '').toLowerCase() === me;
    const tr = document.createElement('tr');
    tr.dataset.sid = s.id;
    if (saleSelected.has(s.id)) tr.classList.add('active');
    tr.innerHTML = `<td><input type="checkbox" class="ssel" ${saleSelected.has(s.id) ? 'checked' : ''} /></td><td>${fmtDate(s.date)}</td><td>${esc(s.number)}</td><td>${esc(s.client || '—')}</td><td>${saleKindName(s.type)}${s.type === 'cotacao' && s.convertedId ? ' (convertida)' : ''}</td><td style="text-align:right"><strong>${MZN(s.total)}</strong></td><td style="text-align:right">${MZN(recv)}${troco > 0 ? '<br><span class="hint">troco ' + MZN(troco) + '</span>' : ''}</td><td style="text-align:right" title="${falta < 0 ? 'Pago a mais: ' + MZN(-falta) : ''}"><strong>${MZN(Math.max(falta, 0))}</strong></td><td>${saleStatus(s)}</td><td>${esc(issuedByLabel(s.operator))}</td><td class="col-act"><button type="button" class="row-edit spdf" title="Pré-visualizar documento">Pré-visualizar</button>${((isAdmin || own) && s.type === 'credito' && falta > 0) ? ' <button type="button" class="row-del amort" title="Amortizar (recibo)">' + ICO_CASH + '</button>' : ''}${((isAdmin || own) && s.type === 'cotacao' && !s.convertedId) ? ' <button type="button" class="row-edit conv" title="Converter em venda">' + ICO_SWAP + '</button>' : ''}${((isAdmin || own) && s.type !== 'cotacao') ? ' <button type="button" class="row-edit ncb" title="Nota de Crédito">' + ICO_UNDO + '</button>' : ''}${((isAdmin || own) && s.type !== 'cotacao') ? ' <button type="button" class="row-edit guia" title="Guia de Remessa">' + ICO_TRUCK + '</button>' : ''}${isAdmin ? ' <button type="button" class="row-del sdel" title="Remover">' + ICO_DEL + '</button>' : ''}</td>`;
    tr.querySelector('.ssel').onclick = (e) => { e.stopPropagation(); if (e.target.checked) saleSelected.add(s.id); else saleSelected.delete(s.id); renderSaleBulk(); };
    tr.querySelector('.ssel').onchange = () => renderSaleBulk();
    tr.onclick = (e) => { if (e.target.closest('input,button')) return; openSaleDetail(s.id,false); };
    tr.style.cursor = 'pointer';
    tr.querySelector('.spdf').onclick = () => openSaleDetail(s.id);
    const peerReadOnly=currentRole()!=='admin' && String(s.operator||'').toLowerCase()!==String(currentUser||'').toLowerCase();if(peerReadOnly)tr.querySelectorAll('.amort,.conv,.ncb,.guia,.sdel').forEach(button=>{button.hidden=true;button.disabled=true;});
    const am = tr.querySelector('.amort');
    if (am) am.onclick = () => amortize(s.id);
    const cv = tr.querySelector('.conv');
    if (cv) cv.onclick = () => convertQuote(s.id);
    const nb = tr.querySelector('.ncb');
    if (nb) nb.onclick = () => openNc(s.id);
    const gu = tr.querySelector('.guia');
    if (gu) gu.onclick = () => emitGuia(s.id);
    const sdel = tr.querySelector('.sdel');
    if (sdel) sdel.onclick = async () => {
      if (currentRole() !== 'admin') return toast('Remover vendas: acesso Administrador.', 'error');
      if ((s.payments || []).some(p => p.doc && p.doc.indexOf('REC') === 0) || ncs.some(n => n.saleId === s.id)) return toast('Tem recibos/NC associados. Emita uma Nota de Crédito em vez de apagar.', 'error');
      if (!await confirmDlg('Remover venda?', `O documento "${s.number}" será apagado e as quantidades devolvidas ao stock.`)) return;
      pushQueue({ type: 'delete-sale', payload: { id: s.id } });
      if (!s.billingOnly && s.type !== 'cotacao') stockApply(s.items, +1, true, s.number, s.loc || 'loja');
      sales = sales.filter(x => x.id !== s.id);
      persist(); renderAll(); toast('Venda removida, stock reposto.', 'success');
    };
    tb.appendChild(tr);
  });
  renderSaleBulk();
}
let ncSelected = new Set();
function renderNcBulk() {
  const bar = $('ncBulkBar'); if (!bar) return;
  bar.classList.toggle('show', ncSelected.size > 0);
  if ($('ncSelCount')) $('ncSelCount').textContent = ncSelected.size + ' selecionada(s)';
  if ($('btnNcDelSel')) $('btnNcDelSel').style.display = currentRole() === 'admin' ? '' : 'none';
  document.querySelectorAll('#ncTable tbody tr').forEach(tr => tr.classList.toggle('active', ncSelected.has(tr.dataset.nid)));
}
if ($('ncCheckAll')) $('ncCheckAll').onchange = (e) => {
  document.querySelectorAll('#ncTable tbody .nsel').forEach(cb => {
    const id = cb.closest('tr').dataset.nid;
    if (e.target.checked) ncSelected.add(id); else ncSelected.delete(id);
    cb.checked = e.target.checked;
  });
  document.querySelectorAll('#ncTable tbody tr').forEach(tr => tr.classList.toggle('active', ncSelected.has(tr.dataset.nid)));
  renderNcBulk();
};
if ($('btnNcDelSel')) $('btnNcDelSel').onclick = async () => {
  if (currentRole() !== 'admin') return toast('Remover NC: acesso Administrador.', 'error');
  if (!ncSelected.size) return;
  if (!await confirmDlg('Remover NCs?', ncSelected.size + ' nota(s) serão anuladas (stock reduzido, dívida reposta).')) return;
  [...ncSelected].forEach(id => {
    const n = ncs.find(x => x.id === id); if (!n) return;
    const so = sales.find(x => x.id === n.saleId);
    if (so) { so.ncTotal = Math.max(0, (Number(so.ncTotal) || 0) - n.total); so.updatedAt = Date.now(); pushQueue({ type: 'sale', payload: { ...so } }); }
    n.items.forEach(p => {
      const st = stock.find(x => (x.name || '').toLowerCase() === (p.desc || '').toLowerCase());
      if (st) { st.qArm = Math.max(0, (Number(st.qArm) || 0) - (Number(p.qty) || 0)); st.updatedAt = Date.now(); pushQueue({ type: 'stock', payload: { ...st } }); }
    });
    pushQueue({ type: 'delete-nc', payload: { id } });
  });
  ncs = ncs.filter(x => !ncSelected.has(x.id));
  ncSelected.clear();
  persist(); renderAll(); toast('NCs anuladas.', 'success');
};
function renderNc() {
  const tb = $('ncTable').querySelector('tbody'); tb.innerHTML = '';
  const isAdmin = currentRole() === 'admin';
  const me = String(currentUser || '').toLowerCase();
  const list = [...ncs].sort((a, b) => b.createdAt - a.createdAt)
    .filter(n => isAdmin || String(n.operator || '').toLowerCase() === me);   // conta normal só vê as suas NC
  $('ncCount').textContent = '(' + list.length + ')';
  list.forEach(n => {
    const s = sales.find(x => x.id === n.saleId);
    const tr = document.createElement('tr');
    tr.dataset.nid = n.id;
    if (ncSelected.has(n.id)) tr.classList.add('active');
    tr.innerHTML = `<td><input type="checkbox" class="nsel" ${ncSelected.has(n.id) ? 'checked' : ''} /></td><td>${fmtDate(n.date)}</td><td>${esc(n.number)}</td><td>${esc(s ? s.number : '—')}</td><td>${esc(n.client || '—')}</td><td style="text-align:right"><strong>${MZN(n.total)}</strong></td><td>${esc(n.motive || '')}</td><td>${esc(userNameOf(n.operator))}</td><td class="col-act"><button type="button" class="row-edit" title="PDF">${ICO_PDF}</button>${isAdmin ? ' <button type="button" class="row-del" title="Remover NC">' + ICO_DEL + '</button>' : ''}</td>`;
    tr.querySelector('.nsel').onclick = (e) => { e.stopPropagation(); if (e.target.checked) ncSelected.add(n.id); else ncSelected.delete(n.id); renderNcBulk(); };
    tr.onclick = (e) => { if (e.target.closest('input,button')) return; openNcDetail(n.id); };
    tr.style.cursor = 'pointer';
    tr.querySelector('.row-edit').onclick = () => ncPdf(n);
    const ndel = tr.querySelector('.row-del');
    if (ndel) ndel.onclick = async () => {
      if (currentRole() !== 'admin') return toast('Remover NC: acesso Administrador.', 'error');
      if (!await confirmDlg('Remover NC?', `Anular "${n.number}"? O stock será reduzido de novo e a dívida reposta.`)) return;
      const so = sales.find(x => x.id === n.saleId);
      if (so) { so.ncTotal = Math.max(0, (Number(so.ncTotal) || 0) - n.total); so.updatedAt = Date.now(); pushQueue({ type: 'sale', payload: { ...so } }); }
      n.items.forEach(p => {
        const st = stock.find(x => (x.name || '').toLowerCase() === (p.desc || '').toLowerCase());
        if (st) { st.qArm = Math.max(0, (Number(st.qArm) || 0) - (Number(p.qty) || 0)); st.updatedAt = Date.now(); pushQueue({ type: 'stock', payload: { ...st } }); }
      });
      pushQueue({ type: 'delete-nc', payload: { id: n.id } });
      ncs = ncs.filter(x => x.id !== n.id);
      persist(); renderAll(); toast('NC anulada.', 'success');
    };
    tb.appendChild(tr);
  });
  renderNcBulk();
}
function openNcDetail(id) {
  const n = ncs.find(x => x.id === id); if (!n) return;
  const s = sales.find(x => x.id === n.saleId);
  const rows = (n.items || []).map((p, ix) => `<tr><td>${ix + 1}</td><td class="n">${esc(fmtQty(p))}</td><td>${esc(p.desc)}</td><td class="n">${MZN(p.price)}</td><td class="n"><strong>${MZN(p.total)}</strong></td></tr>`).join('')
    || '<tr><td colspan="5" class="hint">Sem linhas.</td></tr>';
  openInfo('Nota de Crédito ' + n.number,
    `<div class="det-top"><div class="det-id"><strong>${esc(n.client || '—')}</strong>`
    + detBadge('Nota de crédito', 'warn') + `</div><div class="det-date">${fmtDate(n.date)}</div></div>`
    + detMeta([
      ['Fatura de origem', s ? esc(s.number) : '—'],
      ['Motivo', n.motive ? esc(n.motive) : '—'],
      ['Emitida por', esc(userNameOf(n.operator))],
      ['Nº de linhas', String((n.items || []).length)]
    ])
    + `<div class="det-items"><table><thead><tr><th>#</th><th>Qtd</th><th>Produto</th><th>Preço</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + detKpis([{ label: 'Total da nota de crédito', value: MZN(n.total), cls: 'warn' }]));
}
function ncPdf(n) {
  const doc = docNew();
  const s = sales.find(x => x.id === n.saleId);
  docStamp(doc, 'NOTA DE CRÉDITO');
  let y = docHeader(doc, 'NOTA DE CRÉDITO (NC)', n.number, fmtDate(n.date), pdfTimeNow());
  const cl = (typeof findClientByName === 'function') ? findClientByName(n.client || '') : (s ? findClientByName(s.client || '') : null);
  y = docMeta(doc, y, [
    { title: 'Adquirente', lines: [
      String(n.client || '—'),
      cl && cl.nuit ? 'NUIT: ' + cl.nuit : '',
      (cl && cl.address) || ''
    ] },
    { title: 'Detalhes do documento', lines: [
      'Emissão: ' + fmtDate(n.date),
      'Documento de origem: ' + (s ? s.number : '—'),
      'Motivo: ' + (n.motive || '—'),
      'Operador: ' + userNameOf(n.operator)
    ] }
  ]);
  y = docBanner(doc, y, 'Documento de retificação — repõe o stock devolvido e abate a dívida do cliente.', 'warn');
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { halign: 'center', cellWidth: 16, fontStyle: 'bold' },
      2: { halign: 'center', cellWidth: 12, textColor: CMUT, fontSize: 7.8 },
      3: { cellWidth: 'auto' },
      4: { halign: 'right', cellWidth: 26 },
      5: { halign: 'right', cellWidth: 26, fontStyle: 'bold' }
    },
    head: [['#', 'Qtd', 'Un.', 'Designação do Produto', 'Preço Unit. (MT)', 'Total (MT)']],
    body: n.items.map((p, ix) => [ix + 1, fmtQty(p), p.unit || '', p.desc, MZN(p.price), MZN(p.total)]),
    didDrawPage: docFootSetup(doc, (n.hash || '').slice(0, 6).toUpperCase(), n.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DA NOTA DE CRÉDITO', value: MZN(n.total), big: true, color: CWARN }
  ]);
  y = docNotes(doc, y, 'Observações', [
    'A nota de crédito retifica o documento ' + (s ? s.number : '—') + ' e serve de comprovativo da devolução.',
    'O valor é abatido à conta corrente do cliente.'
  ]);
  docSignatures(doc, 'O Cliente', 'O Responsável');
  pdfSave(doc, safeName(n.number));
}
function setSaleKind(k) {
  if (calcOpen) calcHideOnly();
  if (billingMode()) k = 'cotacao';
  if ($('sType')) $('sType').value = k;
  document.querySelectorAll('#saleTypeCards .type-card').forEach(c => c.classList.toggle('active', c.dataset.kind === k));
  const cur = $('sNumber').value.trim();
  if (!cur || /^(VD|FT|FP|COT) \d{4}\/\d+$/.test(cur)) $('sNumber').value = nextSaleNumber(k);
  if ($('saleChoiceWrap')) $('saleChoiceWrap').style.display = 'none';
  $('saleFormPanel').style.display = 'block';
  if ($('saleItemsPanel')) $('saleItemsPanel').style.display = 'flex';
  else $('saleFormPanel').style.display = 'block';
  ['saleListPanel', 'saleNcPanel'].forEach(id => { const p = $(id); if (p) p.style.display = 'none'; });
  if ($('saleBar')) $('saleBar').style.display = 'flex';
  const titles = { venda: 'Nova Venda a Pronto', credito: 'Nova Venda a Crédito', cotacao: 'Nova Proforma' };
  if ($('saleFormTitle')) $('saleFormTitle').textContent = billingMode() ? 'Nova Faturação' : (titles[k] || 'Nova Venda');
  if ($('saleKindBadge')) $('saleKindBadge').textContent = k === 'venda' ? '[F2]' : k === 'credito' ? '[F3]' : '[F4]';
  if ($('sPay') && !$('sPay').value) $('sPay').value = lastPayMethod() || '';
  applyTaxDefaults();
  if (typeof refreshCliHint === 'function') refreshCliHint();
}
function applyTaxDefaults() {
  try {
    const t = (typeof tax !== 'undefined' && tax) || {};
    if ($('sIva') && !$('sIva').dataset.touched) $('sIva').value = (t.mode === 'add' ? 'incl' : 'incl');
    if ($('sIvaMotive') && !$('sIvaMotive').value && t.exempt) $('sIvaMotive').placeholder = t.exempt;
    if ($('sIva')) {
      const r = Number(t.vat);
      const opt = $('sIva').querySelector('option[value="incl"]');
      if (opt) opt.textContent = 'IVA ' + (isNaN(r) ? 16 : r) + '% incluído';
    }
  } catch (_) {}
}
/* ---------- conformidade: hash, NUIT, empresa, papel ---------- */
async function sha256hex(str) {
  try {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      const b = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
function lastSaleHash() {
  const ds = sales.filter(s => s.hash);
  if (!ds.length) return 'GENESIS';
  ds.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ds[0].hash;
}
function lastRcHash() {
  if (!receipts.length) return 'GENESIS';
  const ds = [...receipts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ds[0].hash || 'GENESIS';
}
function lastNcHash() {
  if (!ncs.length) return 'GENESIS';
  const ds = [...ncs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ds[0].hash || 'GENESIS';
}
function checkNuit(nuit) {
  const s = String(nuit || '').trim();
  if (!/^\d{9}$/.test(s)) return { ok: false, msg: 'NUIT deve ter exatamente 9 dígitos.' };
  const d = s.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += d[i] * (9 - i);
  const chk = (11 - (sum % 11)) % 11 % 10;
  if (chk !== d[8]) return { ok: true, warn: 'Dígito de controlo do NUIT não confere — confirme o número.' };
  return { ok: true };
}
function warnNuit(nuit, quem) {
  if (!nuit) return true;
  const r = checkNuit(nuit);
  if (!r.ok) toast('NUIT suspeito (' + quem + '): ' + r.msg, 'warning');
  else if (r.warn) toast('Atenção (' + quem + '): ' + r.warn, 'warning');
  return true;
}
/* ---------- nomes de operadores ---------- */
function userNameOf(email) {
  const u = appUsers().find(x => (x.email || '').toLowerCase() === String(email || '').toLowerCase());
  return (u && u.name) || email || '—';
}
/* Nos filtros por operador, a conta com sessão iniciada aparece como "Eu". */
function operatorNameOf(email) {
  const key = String(email || '').toLowerCase();
  if (key && key === String(currentUser || '').toLowerCase()) return 'Eu';
  return userNameOf(email);
}
function canSeeSale(s) {
  if(!s)return false;if(currentRole()==='admin')return true;
  return (s.billingOnly===true)===billingMode();
}
function issuedByLabel(operator) {return String(operator||'').toLowerCase()===String(currentUser||'').toLowerCase()?'Mim':userNameOf(operator);}
function invoiceIssues(s) {return [...Object.values(s.issues||{}),...Object.values(s.printEvents||{})].filter((issue,index,list)=>list.findIndex(item=>item.id===issue.id)===index);}

function canSeeMovement(m) {
  if(currentRole()==='admin') return true;
  const owner=m.operator||m.by;
  if(owner) return String(owner).toLowerCase()===String(currentUser||'').toLowerCase();
  const related=sales.find(s=>s.number===m.ref);
  return !!related && canSeeSale(related);
}
/* Nome do operador na barra superior (nunca o email, quando há nome) */
function renderTopUser() {
  const el = $('userInfoTop'); if (!el) return;
  const role = currentRole();
  el.textContent = displayNameOf(currentUser);
  el.title = currentUser || 'Operador';
  const badge = $('roleTopBadge');
  if (badge) {
    badge.textContent = role === 'admin' ? 'Admin' : billingMode() ? 'Facturador' : 'Operador';
    badge.className = 'role-top-badge ' + (role === 'admin' ? 'is-admin' : 'is-op');
    badge.title = roleLabel(role);
    badge.style.display = '';
  }
}
/* Nome a mostrar na barra superior (nunca o email completo) */
function displayNameOf(email) {
  const n = userNameOf(email);
  if (n && n !== email) return n;
  const local = String(email || '').split('@')[0].trim();
  if (!local) return 'Operador';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
/* dropdowns de pagamento: focar seleciona tudo para trocar rápido */
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || !t.classList) return;
  if (t.parentElement && t.parentElement.classList && t.parentElement.classList.contains('combo')) {
    try { t.select(); } catch (_) {}
  }
});
function currentRole() {
  if(window.FIREBASE_CONFIG) {if(authorizedProfile && auth?.currentUser?.uid===authorizedProfile.uid)return authorizedProfile.admin===true?'admin':authorizedProfile.role==='opt'?'opt':'op';
    if(isOnline())return 'op';
    const cached=load('dec_authorized_profiles',{})[String(currentUser||'').toLowerCase()];return cached?.active===true && typeof cached.admin==='boolean'?(cached.admin?'admin':cached.role==='opt'?'opt':'op'):'op';}
  return load(LS.role,'op');
}
function roleLabel(role) {
  if (role === 'admin') return 'Administrador';
  return billingMode() ? 'Facturador' : 'Vendedor';
}
/* Nível do utilizador: o registo da conta manda (evita entrar como administrador por engano) */
function roleForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  try {
    const u = appUsers().find(x => String(x.email || '').toLowerCase() === e);
    if (u && u.role) return u.role;
  } catch (_) {}
  return 'op';
}
function applyRole() {
  applyBillingMode();
  const role = currentRole();
  const isAdmin = role === 'admin';
  const isOp = role === 'op' || role === 'opt';
  document.querySelectorAll('.nav-btn[data-view="suppliers"],#featSup').forEach(el=>el.hidden=!isAdmin);
  document.body.classList.toggle('role-op', role === 'op');
  document.body.classList.toggle('role-opt', role === 'opt');
  const sel = $('roleSel'); if (sel) { sel.value = role; sel.disabled = !!window.FIREBASE_CONFIG || isOp; }
  // Sincronização: operação exclusiva do administrador (o operador só reporta)
  const sb = $('syncBox'); if (sb) sb.style.display = isAdmin ? '' : 'none';
  if ($('btnClearReadNotifs')) $('btnClearReadNotifs').style.display = '';
  if (!isAdmin) { ['queueCount', 'syncStatus', 'diagOut'].forEach(id => { if ($(id)) $(id).textContent = ''; }); }
  // Caixa: empresa e IVA só leitura; sem stock/margens/backup
  ['coName', 'coNuit', 'coAddr', 'coCity', 'coPhone', 'coEmail', 'coVat'].forEach(id => { if ($(id)) $(id).readOnly = isOp; });
  if ($('btnSaveCompany')) $('btnSaveCompany').disabled = isOp;
  ['txVat', 'txMode', 'txExempt'].forEach(id => { if ($(id)) $(id).disabled = isOp; });
  if ($('btnSaveTax')) $('btnSaveTax').disabled = isOp;
  // Produtos/Stock: Exportar e Importar só admin; transferência para admin e operador com transferências
  if ($('btnAddProd')) $('btnAddProd').style.display = isAdmin ? '' : 'none';
  ['btnStockExp', 'btnStockImp', 'btnXls', 'btnXlsImp'].forEach(id => { if ($(id)) $(id).style.display = isAdmin ? '' : 'none'; });
  if ($('btnOpenTrans')) $('btnOpenTrans').style.display = (isAdmin || role === 'opt') ? '' : 'none';
  // Abas e painéis exclusivos do administrador
  const adminOnly = ['empresa', 'iva', 'stock', 'backup', 'users', 'limpeza'];
  document.querySelectorAll('.set-tabs [data-set]').forEach(b => {
    if (adminOnly.indexOf(b.dataset.set) !== -1) b.style.display = isAdmin ? '' : 'none';
  });
  const curTab = document.querySelector('.set-tabs [data-set].active');
  let activeKey = curTab ? curTab.dataset.set : 'empresa';
  if (!isAdmin && adminOnly.indexOf(activeKey) !== -1) {
    const sec = document.querySelector('.set-tabs [data-set="sec"]') || document.querySelector('.set-tabs [data-set]');
    if (sec) { sec.classList.add('active'); curTab && curTab.classList.remove('active'); activeKey = sec.dataset.set; }
  }
  document.querySelectorAll('[data-setpane]').forEach(p => {
    const k = p.dataset.setpane;
    if (!isAdmin && adminOnly.indexOf(k) !== -1) { p.style.display = 'none'; return; }
    p.style.display = (k === activeKey) ? '' : 'none';
  });
  ['btnAddCli','btnEditCli','btnDelCli'].forEach(id=>{if($(id))$(id).hidden=!isAdmin;});
  const notice = $('settingsRoleNotice');
  if (notice) {
    if (isAdmin) { notice.style.display = 'none'; notice.innerHTML = ''; }
    else {
      notice.style.display = 'none';notice.innerHTML='';
      const adminEmails = appUsers().filter(u => String(u.role || '') === 'admin').map(u => String(u.email || '')).filter(Boolean);
      notice.innerHTML = '<strong>Está ligado como ' + esc(displayNameOf(currentUser)) + ' — ' + esc(roleLabel(role)) + '.</strong>'
        + ' A criação de contas, utilizadores e configurações da empresa é feita pelo Administrador.'
        + (adminEmails.length ? ' Conta(s) administrador: ' + esc(adminEmails.join(', ')) + '.' : '')
        + ' <button type="button" class="btn small" id="btnRoleSwitch">Mudar de conta</button>';
      const sw = $('btnRoleSwitch');
      if (sw) sw.onclick = () => { if ($('btnLogout')) $('btnLogout').click(); };
    }
  }
  if(notice && !isAdmin){notice.innerHTML='';notice.hidden=true;}else if(notice)notice.hidden=false;
  try { renderTopUser(); } catch (_) {}
  renderDash();
  renderSystemBackupStatus();
}
/* ---------- utilizadores (admin; espelho local + sync) ---------- */
function appUsers() {
  try {
    const raw = JSON.parse(localStorage.getItem('dec_users'));
    if (Array.isArray(raw)) return raw.filter(x => x && x.email);
    if (raw && typeof raw === 'object') {
      /* Contas importadas da nuvem podem chegar como mapa { chave: conta }. */
      const arr = Object.values(raw).filter(x => x && x.email);
      saveUsers(arr);
      return arr;
    }
    return [];
  } catch (_) { return []; }
}
function saveUsers(u) {
  const arr = Array.isArray(u) ? u : (u && typeof u === 'object' ? Object.values(u) : []);
  try { localStorage.setItem('dec_users', JSON.stringify(arr.filter(x => x && x.email))); } catch (_) {}
}
/* Garante que a conta online (email) existe na lista local:
   assim o Nome do operador aparece na barra, nos documentos e nas listas. */
function ensureLocalUser(email, name, role) {
  try {
    const e = String(email || '').trim(); if (!e) return;
    const users = appUsers();
    const i = users.findIndex(x => String(x.email || '').toLowerCase() === e.toLowerCase());
    if (i === -1) {
      users.push({ email: e, name: String(name || '').trim(), role: role || 'op', active: true, updatedAt: Date.now(), createdAt: Date.now() });
      saveUsers(users);
    } else {
      let ch = false;
      if (name && !users[i].name) { users[i].name = String(name).trim(); ch = true; }
      if (role && !users[i].role) { users[i].role = role; ch = true; }
      if (ch) { users[i].updatedAt = Date.now(); saveUsers(users); }
    }
    if(authorizedProfile && authorizedProfile.email.toLowerCase()===e.toLowerCase()){const local=appUsers();const at=local.findIndex(u=>u.email.toLowerCase()===e.toLowerCase());if(at>=0){local[at]={...local[at],...authorizedProfile};saveUsers(local);}}
  } catch (_) {}
}
let editingUserEmail = null;
function userLabel(u) { return (u && (u.name || '').trim()) || (u && u.email) || '—'; }
function resetUserForm() {
  editingUserEmail = null;
  if ($('uName')) $('uName').value = '';
  if ($('uEmail')) $('uEmail').value = '';
  if ($('uPin')) $('uPin').value = '';
  if ($('uPassword')) $('uPassword').value = '';
  if ($('uPassword')) $('uPassword').disabled = false;
  if ($('userFormStatus')) $('userFormStatus').textContent = 'Novo utilizador';
  if ($('uRole')) $('uRole').value = 'op';
  if ($('uMode')) $('uMode').value = '';
  if ($('uEmail')) $('uEmail').readOnly = false;
  if ($('btnAddUser')) $('btnAddUser').textContent = 'Criar utilizador';
  if ($('btnCancelUser')) $('btnCancelUser').style.display = 'none';
}
function editUser(email) {
  const u = appUsers().find(x => (x.email || '').toLowerCase() === String(email || '').toLowerCase());
  if (!u) return;
  editingUserEmail = u.email;
  $('uName').value = u.name || '';
  $('uEmail').value = u.email;
  $('uEmail').readOnly = true;
  if ($('uPassword')) { $('uPassword').value=''; $('uPassword').disabled=true; }
  if ($('userFormStatus')) $('userFormStatus').textContent = 'A editar: ' + u.email + ' — altere o nível ou o modo e guarde as alterações.';
  $('uPin').value = '';
  $('uRole').value = u.role || 'op';
  if ($('uMode')) $('uMode').value = u.mode || '';
  if ($('btnAddUser')) $('btnAddUser').textContent = 'Guardar alterações';
  if ($('btnCancelUser')) $('btnCancelUser').style.display = '';
  try { $('setUsersPanel').scrollIntoView({block:'start',behavior:'smooth'}); } catch (_) {}
  toast('A editar ' + userLabel(u) + '. Preencha o PIN para o alterar.', 'success');
}
function renderUsers() {
  const tb = $('userTable') ? $('userTable').querySelector('tbody') : null; if (!tb) return;
  tb.innerHTML = '';
  const rn = (r) => r === 'admin' ? 'Administrador' : r === 'opt' ? 'Operador com Transferências' : 'Operador de Caixa';
  const me = String(currentUser || '').toLowerCase();
  const list = appUsers().slice().sort((a, b) => String(userLabel(a)).localeCompare(String(userLabel(b))));
  list.forEach(u => {
    const tr = document.createElement('tr');
    const isMe = String(u.email || '').toLowerCase() === me;
    tr.innerHTML = `<td><strong>${esc(userLabel(u))}</strong>${isMe ? ' <span class="hint">(você)</span>' : ''}</td>`
      + `<td>${esc(u.email)}</td><td>${esc(rn(u.role))}</td><td>${u.mode === 'faturacao' ? 'Faturador' : u.mode === 'venda' ? 'Vendedor' : 'Global'}</td>`
      + `<td class="col-act"><button type="button" class="row-edit ued" title="Editar">${ICO_EDIT}</button> <button type="button" class="row-del udel" title="Remover">${ICO_DEL}</button></td>`;
    tr.querySelector('.ued').onclick = () => editUser(u.email);
    tr.querySelector('.udel').onclick = async () => {
      if (isMe) return toast('Não pode remover a conta com que está ligado.', 'warning');
      if (!await confirmDlg('Remover utilizador?', userLabel(u) + ' — ' + u.email)) return;
      try {if(!u.uid)throw Error('Perfil sem UID Firebase.');await accountAccess.update(u.uid,{active:false});}catch(error){return toast('Não foi possível desativar: '+error.message,'error');}
      saveUsers(appUsers().filter(x => x.email !== u.email));
      pushQueue({ type: 'delete-user', payload: { id: u.email } });
      pushUsersMap();
      if (editingUserEmail === u.email) resetUserForm();
      renderUsers();
    };
    tb.appendChild(tr);
  });
  if (!list.length) tb.innerHTML = '<tr><td colspan="5" class="hint">Sem contas. Crie a primeira conta de administrador.</td></tr>';
}
function pushUsersMap() {
  const usersMap = {};
  appUsers().forEach(x => { usersMap[fbKey(x.email)] = { email: x.email, name: x.name || '', uid:x.uid||'', admin:x.admin===true, role: x.admin===true?'admin':x.role==='opt'?'opt':'op', mode: x.mode || '', active:x.active!==false, pinHash: x.pinHash || '', updatedAt: Date.now() }; });
  if (currentRole() !== 'admin') return;
  pushQueue({ type: 'settings', payload: { key: 'users', list: usersMap } });
  if (window.FIREBASE_WORKSPACE) {
    const members = {};
    appUsers().forEach(user => { members[cloudEmailKey(user.email)] = { email: String(user.email).trim().toLowerCase(), uid:user.uid||'', admin:user.admin===true, role:user.admin===true?'admin':user.role==='opt'?'opt':'op', active: user.active !== false }; });
    pushQueue({ type: 'members', payload: { members } });
  }
}
/* Traz para o terminal as contas criadas noutros aparelhos (mapa users no Firebase) */
async function importCloudUsers() {
  if (currentRole() !== 'admin') return toast('Acesso Administrador.', 'error');
  if (!rdb || !cloudUid()) return toast('Sem ligação à nuvem. Entre com email/palavra-passe.', 'warning');
  try {
    const snap = await cloudRef('settings/users').once('value');
    const val = snap && snap.val();
    const list = (val && val.list) || val || {};
    const incoming = Object.keys(list).map(k => list[k]).filter(x => x && x.email);
    if (!incoming.length) return toast('Nenhuma conta encontrada na nuvem.', 'warning');
    const local = appUsers();
    let added = 0, upd = 0;
    incoming.forEach(x => {
      const i = local.findIndex(l => (l.email || '').toLowerCase() === String(x.email).toLowerCase());
      if (i === -1) { local.push({ uid:x.uid||'',admin:x.admin===true,email: x.email, name: x.name || '', role: x.admin===true?'admin':x.role==='opt'?'opt':'op', mode: x.mode || '', pinHash: x.pinHash || '', active: true, createdAt: Date.now(), updatedAt: Date.now(), cloud: true }); added++; }
      else { local[i]={...local[i],...x,uid:x.uid||local[i].uid||'',mode:x.mode ?? '',active:x.active!==false}; upd++; }
    });
    saveUsers(local); renderUsers();
    toast('Contas da nuvem: ' + added + ' novas, ' + upd + ' atualizadas.', 'success');
  } catch (e) {
    toast('Falha ao ler contas da nuvem: ' + ((e && (e.code || e.message)) || e), 'error');
  }
}
function renderCompany() {
  const c = company || {};
  if ($('coName')) $('coName').value = c.name || '';
  if ($('coNuit')) $('coNuit').value = c.nuit || '';
  if ($('coAddr')) $('coAddr').value = c.address || '';
  if ($('coCity')) $('coCity').value = c.city || '';
  if ($('coPhone')) $('coPhone').value = c.phone || '';
  if ($('coEmail')) $('coEmail').value = c.email || '';
  if ($('coDocLang')) $('coDocLang').value = c.docLang === 'pt' ? 'pt' : 'en';
  if ($('coDocModel')) $('coDocModel').value = Number(c.docModel) === 1 ? '1' : '2';
  if ($('coVat')) $('coVat').value = c.vat != null ? c.vat : 16;
}
function renderTax() {
  if (!$('txVat')) return;
  $('txVat').value = tax.vat != null ? tax.vat : 16;
  $('txMode').value = tax.mode || 'incl';
  $('txExempt').value = tax.exempt || '';
}
$('btnSaveTax').onclick = () => {
  if (currentRole() !== 'admin') return toast('Acesso restrito ao Administrador (só leitura).', 'error');
  tax = { vat: Number($('txVat').value) || 0, mode: $('txMode').value === 'add' ? 'add' : 'incl', exempt: $('txExempt').value.trim(), updatedAt: Date.now() };
  save(LS.tax, tax);
  pushQueue({ type: 'settings', payload: { key: 'tax', list: tax } });
  toast('Impostos guardados e aplicados às vendas.', 'success');
};
$('btnSaveCompany').onclick = () => {
  if (currentRole() !== 'admin') return toast('Acesso restrito ao Administrador (só leitura).', 'error');
  if (!warnNuit($('coNuit').value.trim(), 'empresa')) return;
  company = { name: $('coName').value.trim(), nuit: $('coNuit').value.trim(), address: $('coAddr').value.trim(), city: $('coCity').value.trim(), phone: $('coPhone').value.trim(), email: $('coEmail').value.trim(), docLang: $('coDocLang') && $('coDocLang').value === 'pt' ? 'pt' : 'en', docModel: $('coDocModel') && $('coDocModel').value === '1' ? 1 : 2, vat: Number($('coVat').value) || 0, updatedAt: Date.now() };
  save(LS.company, company);
  pushQueue({ type: 'settings', payload: { key: 'company', list: company } });
  toast('Dados da empresa guardados.', 'success');
};
$('roleSel').onchange = (e) => {
  if(window.FIREBASE_CONFIG){e.target.value=currentRole();return;}
  save(LS.role, e.target.value);
  pushQueue({ type: 'settings', payload: { key: 'role', list: e.target.value } });
  applyRole();
  toast(e.target.value === 'admin' ? 'Modo Administrador ativo (acesso total).' : e.target.value === 'opt' ? 'Operador com Transferências ativo.' : 'Modo Operador de Caixa ativo.', 'success');
};
$('filterSale').onchange = renderSales;
$('searchSale').oninput = renderSales;
if ($('filterOperator')) $('filterOperator').onchange = renderSales;
$('sType').onchange = () => { saleIssue(''); setSaleKind($('sType').value); updateSaleChange(); };
if ($('sPaid')) {
  $('sPaid').addEventListener('input', () => { saleIssue(''); updateSaleChange(); });
  $('sPaid').addEventListener('change', updateSaleChange);
}
function refreshCliHint() {
  const el = $('cliAvailHint'); if (!el) return;
  if ($('sType').value !== 'credito') { el.textContent = ''; return; }
  const c = findClientByName($('sClient').value.trim());
  el.textContent = c ? ('Em dívida: ' + MZN(clientBalance(c.id))) : 'Indique um cliente registado.';
}
$('sClient').addEventListener('input', refreshCliHint);
async function amortize(id) {
  const s = sales.find(x => x.id === id); if (!s) return;
  const falta = saleBalance(s);
  if (falta <= 0) return toast('Este crédito já está pago.', 'success');
  let amt = NaN;
  if (window.Swal) {
    const r = await Swal.fire({ title: 'Amortizar ' + s.number, text: 'Em falta: ' + MZN(falta), input: 'number', inputValue: falta, inputAttributes: { min: 0, step: '0.01' }, showCancelButton: true, confirmButtonText: 'Registar', cancelButtonText: 'Cancelar' });
    if (!r || !r.isConfirmed) return;
    amt = Number(r.value);
  } else {
    amt = Number(prompt('Valor a amortizar (em falta ' + falta + '):', falta));
  }
  if (!amt || amt <= 0) return;
  if (amt > falta) return toast('Valor superior à dívida (' + MZN(falta) + ').', 'warning');
  s.paid = (Number(s.paid) || 0) + amt;
  s.payments = s.payments || [];
  const rc = { id: uid(), number: nextReciboNumber(), clientId: s.clientId || null, client: s.client || '', date: todayISO(), total: amt, method: s.payMethod, allocations: [{ saleId: s.id, number: s.number, amount: amt }], hash: '', prevHash: '', ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  rc.prevHash = lastRcHash();
  rc.hash = await sha256hex(rc.number + '|' + rc.date + '|' + rc.total + '|' + rc.prevHash);
  s.payments.push({ date: todayISO(), amount: amt, method: s.payMethod, doc: rc.number });
  s.updatedAt = Date.now();
  pushQueue({ type: 'sale', payload: { ...s } });
  receipts.push(rc); pushQueue({ type: 'receipt', payload: { ...rc } });
  cashAdd(todayISO(), 'entrada', 'Amortização de crédito', amt, s.payMethod, rc.number, s.client || '', true);
  persist(); renderAll();
  toast('Pagamento de ' + MZN(amt) + ' registado.' + (saleBalance(s) <= 0 ? ' Crédito liquidado!' : ''), 'success');
  if (window.Swal) {
    const r2 = await Swal.fire({ title: 'Gerar recibo?', text: 'Recibo ' + rc.number + ' — ' + MZN(amt), showCancelButton: true, confirmButtonText: 'Sim, gerar', cancelButtonText: 'Não' });
    if (r2 && r2.isConfirmed && window.jspdf) reciboPdfRc(rc);
  }
}
async function convertQuote(id) {
  if (billingMode() || sales.find(s=>s.id===id)?.billingOnly) return toast('Documento de faturação sem stock.', 'warning');
  const q = sales.find(x => x.id === id); if (!q || q.type !== 'cotacao' || q.convertedId) return;
  let kind = 'venda';
  if (window.Swal) {
    const r = await Swal.fire({ title: 'Converter ' + q.number, text: 'Converter cotação em:', input: 'select', inputOptions: { venda: 'Venda a Dinheiro (VD)', credito: 'Venda a Crédito (FT)' }, inputValue: 'venda', showCancelButton: true, confirmButtonText: 'Converter', cancelButtonText: 'Cancelar' });
    if (!r || !r.isConfirmed) return;
    kind = r.value || 'venda';
  }
  const ct = new Date();
  const faltaC = (q.items || []).filter(p => stockQty(p.desc, 'armazem') < (Number(p.qty) || 0));
  if (faltaC.length) {
    if (!stockBlockAlert(faltaC, 'armazem', 'conversão')) toast(`Sem stock — conversão bloqueada (${faltaC.length} item(ns)).`, 'error');
    return;
  }
  const s = { id: uid(), number: nextSaleNumber(kind), date: todayISO(), time: String(ct.getHours()).padStart(2, '0') + ':' + String(ct.getMinutes()).padStart(2, '0'), client: q.client, clientId: q.clientId || null, type: kind, items: q.items.map(p => ({ ...p, cost: stockCost(p.desc) })), total: q.total, paid: kind === 'venda' ? q.total : 0, payMethod: q.payMethod || 'Numerário', notes: 'Convertida de ' + q.number, iva: q.iva || 'incl', ivaMotive: q.ivaMotive || '', payments: [], hash: '', prevHash: '', createdAt: Date.now(), updatedAt: Date.now() };
  s.prevHash = lastSaleHash();
  s.hash = await sha256hex(s.number + '|' + s.date + '|' + s.time + '|' + s.total + '|' + s.prevHash);
  if (s.paid > 0) s.payments = [{ date: s.date, amount: s.paid, method: s.payMethod, doc: null }];
  sales.push(s); pushQueue({ type: 'sale', payload: { ...s } });
  s.loc = 'armazem';
  stockApply(s.items, -1, true, s.number, 'armazem');
  if (s.paid > 0) cashAdd(s.date, 'entrada', 'Venda a pronto', s.paid, s.payMethod, s.number, s.client, true);
  q.status = 'Convertida'; q.convertedId = s.id; q.updatedAt = Date.now();
  pushQueue({ type: 'sale', payload: { ...q } });
  persist(); renderAll();
  toast('Cotação convertida em ' + s.number + '.', 'success');
}
function reciboPdf(s, pay) {
  reciboPdfRc({ number: pay.doc || 'REC', client: s.client || '', date: pay.date, total: pay.amount, method: pay.method, allocations: [{ saleId: s.id, number: s.number, amount: pay.amount }], hash: s.hash || '' });
}
/* ---------- notas de crédito (devolução de cliente) ---------- */
let ncSaleId = null;
function openNc(saleId) {
  const s = sales.find(x => x.id === saleId); if (!s || s.type === 'cotacao') return;
  ncSaleId = saleId;
  $('ncSaleInfo').textContent = s.number + ' — ' + (s.client || '—') + ' — Total ' + MZN(s.total);
  $('ncDate').value = fmtDate(todayISO());
  const box = $('ncRows'); box.innerHTML = '';
  s.items.forEach(p => {
    const d = document.createElement('div'); d.className = 'prod-row';
    d.innerHTML = `<div><input class="p-desc" value="${esc(p.desc)}" readonly></div><div class="qty-wrap"><input class="p-qty" type="number" min="0" max="${p.qty}" step="any" value="0"><span class="qty-div"></span><input class="p-unit" value="${esc(p.unit || '')}" readonly></div><div><input class="p-price" type="number" value="${p.price}" readonly></div><div class="prod-total">${MZN(0)}</div><div></div>`;
    d.querySelector('.p-qty').oninput = () => {
      let q = Number(d.querySelector('.p-qty').value) || 0;
      if (q > p.qty) { q = p.qty; d.querySelector('.p-qty').value = q; }
      d.querySelector('.prod-total').textContent = MZN(q * p.price);
      ncRecalc();
    };
    box.appendChild(d);
  });
  ncRecalc();
  $('ncModal').style.display = 'flex';
}
function ncRecalc() {
  let t = 0;
  document.querySelectorAll('#ncRows .prod-row').forEach(r => {
    t += (Number(r.querySelector('.p-qty').value) || 0) * (Number(r.querySelector('.p-price').value) || 0);
  });
  $('ncTotal').textContent = MZN(t);
  return t;
}
$('btnCancelNc').onclick = () => { $('ncModal').style.display = 'none'; };
$('btnSaveNc').onclick = async () => {
  const s = sales.find(x => x.id === ncSaleId); if (!s) return;
  const date = parseBRDate($('ncDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const items = [];
  document.querySelectorAll('#ncRows .prod-row').forEach(r => {
    const desc = r.querySelector('.p-desc').value, qty = Number(r.querySelector('.p-qty').value) || 0;
    const price = Number(r.querySelector('.p-price').value) || 0, unit = r.querySelector('.p-unit').value;
    if (qty > 0) items.push({ desc, qty, unit, price, total: qty * price });
  });
  if (!items.length) return toast('Indique as quantidades a devolver.', 'warning');
  const total = items.reduce((a, p) => a + p.total, 0);
  const y = new Date().getFullYear();
  const n = ncs.filter(x => String(x.number || '').indexOf('NC ' + y) === 0).length + 1;
  const nc = { id: uid(), number: 'NC ' + y + '/' + String(n).padStart(3, '0'), saleId: s.id, clientId: s.clientId || null, client: s.client || '', date, items, total, motive: $('ncMotive').value, notes: '', hash: '', prevHash: '', operator: currentUser, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  nc.prevHash = lastNcHash();
  nc.hash = await sha256hex(nc.number + '|' + nc.date + '|' + nc.total + '|' + nc.prevHash);
  ncs.push(nc); pushQueue({ type: 'nc', payload: { ...nc } });
  s.ncTotal = (Number(s.ncTotal) || 0) + total; s.updatedAt = Date.now();
  pushQueue({ type: 'sale', payload: { ...s } });
  stockApply(items, +1, true, nc.number, 'armazem');
  $('ncModal').style.display = 'none';
  persist(); renderAll();
  toast('Nota de crédito ' + nc.number + ' emitida. Stock reposto.', 'success');
};
/* ---------- recibos de cliente (RC) ---------- */
let rcClientId = null;
function nextReciboNumber() {
  const y = new Date().getFullYear();
  let n = 0;
  const scan = (arr) => arr.forEach(o => { if (String(o.doc || '').indexOf('REC ' + y) === 0) n++; });
  sales.forEach(s => scan(s.payments || []));
  receipts.forEach(r => { if (String(r.number || '').indexOf('REC ' + y) === 0) n++; });
  return 'REC ' + y + '/' + String(n + 1).padStart(3, '0');
}
function openRc(clientId) {
  const c = clients.find(x => x.id === clientId); if (!c) return;
  rcClientId = clientId;
  renderRcPend();
  $('rcDate').value = fmtDate(todayISO()); $('rcAmount').value = ''; $('rcMethod').value = 'Numerário';
  $('rcModal').style.display = 'flex';
}
function rcPending(clientId) {
  const c = clients.find(x => x.id === clientId); if (!c) return [];
  const nm = (c.name || '').toLowerCase();
  return sales.filter(s => s.type === 'credito' && saleBalance(s) > 0 && (s.clientId === clientId || ((s.client || '').toLowerCase() === nm && !s.clientId)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
function renderRcPend() {
  const c = clients.find(x => x.id === rcClientId);
  const box = $('rcPend');
  if (!c) { box.innerHTML = ''; return; }
  const pend = rcPending(rcClientId);
  $('rcClientInfo').textContent = c.name + ' — em dívida: ' + MZN(clientBalance(rcClientId));
  $('rcPreview').textContent = pend.length ? 'Serão abatidas (mais antigas primeiro): ' + pend.map(s => s.number + ' (' + MZN(saleBalance(s)) + ')').join(' · ') : 'Sem faturas pendentes.';
}
$('btnCancelRc').onclick = () => { $('rcModal').style.display = 'none'; };
$('rcAmount').oninput = () => {
  const v = parseMoney($('rcAmount').value);
  $('rcPreview').textContent = v > 0 ? 'A distribuir ' + MZN(v) + ' pelas faturas mais antigas.' : '—';
};
$('btnSaveRc').onclick = async () => {
  const c = clients.find(x => x.id === rcClientId); if (!c) return;
  const date = parseBRDate($('rcDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  let left = parseMoney($('rcAmount').value);
  if (left <= 0) return toast('Indique o valor recebido.', 'warning');
  const method = $('rcMethod').value.trim() || 'Numerário';
  if (!payMethods.includes(method)) { payMethods.push(method); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); renderPayUnits(); }
  const allocations = [];
  const touched = [];
  rcPending(rcClientId).forEach(s => {
    if (left <= 0) return;
    const take = Math.min(saleBalance(s), left);
    if (take <= 0) return;
    const amt = Math.round(take * 100) / 100;
    s.paid = (Number(s.paid) || 0) + amt;
    s.payments = s.payments || [];
    s.payments.push({ date, amount: amt, method, doc: null });
    touched.push(s);
    left = Math.round((left - amt) * 100) / 100;
    allocations.push({ saleId: s.id, number: s.number, amount: amt });
    s.updatedAt = Date.now();
  });
  if (!allocations.length) return toast('Nada a amortizar.', 'warning');
  const rc = { id: uid(), number: nextReciboNumber(), clientId: c.id, client: c.name, date, total: allocations.reduce((a, x) => a + x.amount, 0), method, allocations, hash: '', prevHash: '', ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  rc.prevHash = lastRcHash();
  rc.hash = await sha256hex(rc.number + '|' + rc.date + '|' + rc.total + '|' + rc.prevHash);
  touched.forEach(s => { const p = (s.payments || []).find(pp => !pp.doc); if (p) p.doc = rc.number; pushQueue({ type: 'sale', payload: { ...s } }); });
  receipts.push(rc); pushQueue({ type: 'receipt', payload: { ...rc } });
  cashAdd(date, 'entrada', 'Amortização de crédito', rc.total, method, rc.number, c.name, true);
  $('rcModal').style.display = 'none';
  persist(); renderAll();
  toast('Recibo ' + rc.number + ' de ' + MZN(rc.total) + ' registado.', 'success');
  if (window.jspdf) reciboPdfRc(rc);
};
function reciboPdfRc(rc) {
  const doc = docNew();
  let y = docHeader(doc, 'RECIBO (RC)', rc.number, fmtDate(rc.date), pdfTimeNow());
  const cl = (typeof findClientByName === 'function') ? findClientByName(rc.client || '') : null;
  y = docMeta(doc, y, [
    { title: 'Recebido de', lines: [
      String(rc.client || '—'),
      cl && cl.nuit ? 'NUIT: ' + cl.nuit : '',
      cl && cl.phone ? 'Contacto: ' + cl.phone : ''
    ] },
    { title: 'Detalhes do pagamento', lines: [
      'Data: ' + fmtDate(rc.date),
      'Via: ' + (rc.method || '—'),
      'Operador: ' + userNameOf(rc.operator || currentUser),
      (rc.allocations || []).length + ' fatura(s) amortizada(s)'
    ] }
  ]);
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 10 },
      1: { cellWidth: 'auto' },
      2: { halign: 'right', cellWidth: 34, fontStyle: 'bold' }
    },
    head: [['#', 'Fatura amortizada', 'Valor (MT)']],
    body: (rc.allocations || []).map((a, ix) => [ix + 1, a.number, MZN(a.amount)]),
    didDrawPage: docFootSetup(doc, (rc.hash || '').slice(0, 6).toUpperCase(), rc.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL RECEBIDO', value: MZN(rc.total), big: true, color: COK }
  ]);
  y = docNotes(doc, y, 'Observações', [
    'O presente recibo serve de quitação das faturas acima identificadas.',
    'O valor foi lançado na conta corrente do cliente e na caixa do dia.'
  ]);
  docSignatures(doc, 'O Responsável', 'O Cliente');
  pdfSave(doc, safeName(rc.number));
}
function nextGrNumber() {
  const y = new Date().getFullYear();
  const n = sales.filter(s => String(s.grNumber || '').indexOf('GR ' + y) === 0).length + 1;
  return 'GR ' + y + '/' + String(n).padStart(3, '0');
}
let guiaSaleId = null;
function emitGuia(id) {
  if (billingMode() || sales.find(s=>s.id===id)?.billingOnly) return;
  const s = sales.find(x => x.id === id); if (!s || s.type === 'cotacao') return;
  guiaSaleId = id;
  const cl = (typeof findClientByName === 'function') ? findClientByName(s.client || '') : null;
  $('grFrom').value = s.grFrom || ((company || {}).city || '');
  $('grTo').value = s.grTo || ((cl && cl.address) || '');
  $('guiaModal').style.display = 'flex';
}
$('btnCancelGuia').onclick = () => { $('guiaModal').style.display = 'none'; };
$('btnDoGuia').onclick = () => {
  const s = sales.find(x => x.id === guiaSaleId); if (!s) return;
  s.grFrom = ($('grFrom').value || '').trim();
  s.grTo = ($('grTo').value || '').trim();
  if (!s.grNumber) s.grNumber = nextGrNumber();
  // Saída física confirmada: liberta reserva (sai do Reservado, físico já abatido na venda)
  (s.items || []).forEach(p => releaseReserve(p.desc, p.qty));
  s.updatedAt = Date.now();
  pushQueue({ type: 'sale', payload: { ...s } });
  persist(); renderAll();
  $('guiaModal').style.display = 'none';
  if (window.jspdf) guiaPdf(s);
};
function guiaPdf(s) {
  // Guia de Remessa: emitente + destinatário, SKU, volumes, transporte e assinaturas
  const doc = docNew();
  const co = (typeof company !== 'undefined' && company) || {};
  docStamp(doc, 'GUIA DE REMESSA');
  let y = docHeader(doc, 'GUIA DE REMESSA (GR)', s.grNumber || '', fmtDate(s.date), s.time || pdfTimeNow());
  const cl = (typeof findClientByName === 'function') ? findClientByName(s.client || '') : null;
  y = docMeta(doc, y, [
    { title: 'Emitente / Carga', lines: [
      String(co.name || '—'),
      co.nuit ? 'NUIT: ' + co.nuit : '',
      'Local de carga: ' + (s.grFrom || 'Armazém')
    ] },
    { title: 'Destinatário / Descarga', lines: [
      String(s.client || '—'),
      cl && cl.nuit ? 'NUIT: ' + cl.nuit : '',
      'Local de descarga: ' + (s.grTo || '—')
    ] }
  ]);
  y = docBanner(doc, y, 'Documento de transporte — acompanha a mercadoria e não serve de fatura. Ref. ' + s.number + '.', ACCENT);
  let totQ = 0;
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { cellWidth: 26, fontSize: 7.8, textColor: CMUT },
      2: { halign: 'center', cellWidth: 15, fontStyle: 'bold' },
      3: { halign: 'center', cellWidth: 13, textColor: CMUT, fontSize: 7.8 },
      4: { cellWidth: 'auto' }
    },
    head: [['#', 'Código (SKU)', 'Qtd', 'Un.', 'Designação do Produto']],
    body: s.items.map((p, ix) => { totQ += Number(p.qty) || 0; return [ix + 1, stockSku(p.desc), Number(p.qty) || 0, p.unit || '', p.desc]; }),
    didDrawPage: docFootSetup(doc, (s.hash || '').slice(0, 6).toUpperCase(), s.grNumber || s.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DE VOLUMES', value: String(totQ), big: true, color: CORP }
  ]);
  y = docNotes(doc, y, 'Transporte', [
    'Transportador: ______________________________     Matrícula: ____________',
    'Volumes / paletes: ' + totQ + '     Documento de carga: ' + s.number
  ]);
  docSignatures(doc, 'Entreguei (Motorista / Fiel)', 'Recebi (Cliente / Conferente)');
  pdfSave(doc, safeName(s.grNumber || 'guia'));
}
/* ---------- PDFs comerciais (padrão corporativo) ---------- */
const CORP = [30, 41, 59], CGRAY = [248, 250, 252], CLINE = [226, 232, 240], CMUT = [100, 116, 139];
const ACCENT = [37, 99, 235], CBAD = [220, 38, 38], COK = [22, 163, 74], CWARN = [217, 119, 6];
const PDF_M = 14, PDF_W = 210 - PDF_M * 2;
function docNew() { const { jsPDF } = window.jspdf; return new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' }); }
function safeName(v) { return String(v || 'documento').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'documento'; }
function pdfSave(doc, filename) {
  const name = safeName(filename);
  try { dl(doc.output('blob'), name + '.pdf'); }
  catch (e1) {
    try { doc.save(name + '.pdf'); }
    catch (e2) { toast('Falha ao gerar PDF: ' + ((e2 && e2.message) || e2), 'error'); throw e2; }
  }
}
function pdfNow() { const d = new Date(); return d.toLocaleDateString('pt-MZ') + ' ' + d.toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit' }); }
function pdfTimeNow() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function pdfInitials(nm) {
  const w = String(nm || 'D').trim().split(/\s+/).filter(Boolean);
  return (((w[0] || 'D')[0] || 'D') + (w.length > 1 ? (w[w.length - 1][0] || '') : '')).toUpperCase();
}
/* Cabeçalho padrão: marca + empresa (esquerda) · identificação do documento (direita) */
function docHeader(doc, title, number, dateStr, timeStr) {
  const M = PDF_M, RW = PDF_W;
  const c = (typeof company !== 'undefined' && company) || {};
  doc.setFillColor(...ACCENT); doc.roundedRect(M, 12, 15, 15, 3, 3, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 255, 255);
  doc.text(pdfInitials(c.name), M + 7.5, 21.6, { align: 'center' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...CORP);
  doc.text(String(c.name || 'MINHA EMPRESA').toUpperCase(), M + 19, 18.4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...CMUT);
  doc.text(['NUIT: ' + (c.nuit || '—'), c.address, c.city].filter(Boolean).join('  ·  '), M + 19, 23);
  doc.text([c.phone, c.email].filter(Boolean).join('  ·  ') || '—', M + 19, 27);
  const bw = 78, bx = M + RW - bw, by = 12, bh = 20;
  doc.setFillColor(...CORP); doc.roundedRect(bx, by, bw, bh, 2, 2, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(255, 255, 255);
  doc.text(String(title), bx + bw / 2, by + 7.6, { align: 'center' });
  doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.25);
  doc.line(bx + 12, by + 10.2, bx + bw - 12, by + 10.2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...CGRAY);
  doc.text(String(number || ''), bx + bw / 2, by + 14.6, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(203, 213, 225);
  doc.text([dateStr, timeStr].filter(Boolean).join('  ·  '), bx + bw / 2, by + 18.4, { align: 'center' });
  doc.setFillColor(...ACCENT); doc.rect(M, 34, RW, 0.8, 'F');
  return 41;
}
/* Bloco de partes (1 a 3 colunas): título curto + linhas */
function docMeta(doc, y, blocks) {
  const M = PDF_M, RW = PDF_W;
  const cols = (blocks || []).filter(Boolean);
  if (!cols.length) return y;
  const gap = 4, w = (RW - gap * (cols.length - 1)) / cols.length;
  let maxLines = 0;
  cols.forEach(b => { maxLines = Math.max(maxLines, (b.lines || []).filter(Boolean).length); });
  const h = 11.5 + maxLines * 4.6;
  doc.setFillColor(...CGRAY); doc.setDrawColor(...CLINE); doc.setLineWidth(0.2);
  doc.roundedRect(M, y, RW, h, 1.6, 1.6, 'FD');
  cols.forEach((b, i) => {
    const x = M + i * (w + gap);
    if (i) { doc.setDrawColor(...CLINE); doc.line(x - gap / 2, y + 3, x - gap / 2, y + h - 3); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); doc.setTextColor(...CMUT);
    doc.text(String(b.title || '').toUpperCase(), x + 4, y + 5.6);
    doc.setFillColor(...ACCENT); doc.rect(x + 4, y + 6.6, 9, 0.5, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.6); doc.setTextColor(...CORP);
    (b.lines || []).filter(Boolean).forEach((t, j) => doc.text(String(t), x + 4, y + 11.4 + j * 4.6));
  });
  return y + h + 4.5;
}
/* Tabela de artigos padrão */
function docItems(doc, y, opts) {
  doc.autoTable(Object.assign({
    startY: y, margin: { left: PDF_M, right: PDF_M },
    styles: TBL.styles, headStyles: TBL.headStyles,
    alternateRowStyles: { fillColor: [250, 251, 253] },
    footStyles: TBLFOOT
  }, opts || {}));
  return (doc.lastAutoTable && typeof doc.lastAutoTable.finalY === 'number') ? doc.lastAutoTable.finalY : y;
}
/* Painel de totais alinhado à direita */
function docTotals(doc, y, rows) {
  const w = 86, x = PDF_M + PDF_W - w;
  const rs = (rows || []).filter(Boolean);
  if (!rs.length) return y;
  const lh = 6.4, pad = 3.4;
  const h = pad * 2 + rs.length * lh;
  doc.setFillColor(248, 250, 252); doc.setDrawColor(...CLINE); doc.setLineWidth(0.2);
  doc.roundedRect(x, y, w, h, 1.8, 1.8, 'FD');
  doc.setFillColor(...ACCENT); doc.rect(x, y, 0.9, h, 'F');
  rs.forEach((r, i) => {
    const top = y + pad + lh * i;
    if (r.rule) { doc.setDrawColor(...CLINE); doc.line(x + 3, top + 0.4, x + w - 3, top + 0.4); }
    doc.setFont('helvetica', r.big ? 'bold' : 'normal');
    doc.setFontSize(r.big ? 11.5 : 8.6);
    doc.setTextColor(...(r.color || CORP));
    doc.text(String(r.label), x + 4.5, top + 4.4);
    doc.setFont('helvetica', 'bold');
    doc.text(String(r.value), x + w - 4.5, top + 4.4, { align: 'right' });
  });
  return y + h + 4;
}
/* Faixa de estado / aviso legal */
function docBanner(doc, y, text, kind) {
  const col = kind === 'bad' ? CBAD : kind === 'ok' ? COK : kind === 'warn' ? CWARN : ACCENT;
  doc.setFillColor(col[0], col[1], col[2]);
  doc.roundedRect(PDF_M, y, PDF_W, 8, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255);
  doc.text(String(text), PDF_M + 4, y + 5.4);
  return y + 11;
}
/* Caixa de notas / condições */
function docNotes(doc, y, title, lines) {
  const ls = (lines || []).filter(Boolean);
  if (!ls.length) return y;
  const h = 8 + ls.length * 4.2;
  doc.setFillColor(255, 255, 255); doc.setDrawColor(...CLINE); doc.setLineWidth(0.2);
  doc.roundedRect(PDF_M, y, PDF_W, h, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); doc.setTextColor(...CMUT);
  doc.text(String(title || 'Notas').toUpperCase(), PDF_M + 4, y + 5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(...CMUT);
  ls.forEach((t, i) => doc.text(String(t), PDF_M + 4, y + 9.2 + i * 4.2));
  return y + h + 4;
}
/* Marca de água discreta (ex.: PROFORMA) */
function docStamp(doc, text) {
  if (!text) return;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(46); doc.setTextColor(237, 241, 247);
  doc.text(String(text), 105, 180, { align: 'center', angle: 32 });
}
/* Bloco de informações simples (compatível com o padrão antigo) */
function docClientBand(doc, y, lines, title) {
  return docMeta(doc, y, [{ title: title || 'Detalhes', lines: lines || [] }]);
}
function docFootSetup(doc, hash, meta) {
  const M = PDF_M, RW = PDF_W;
  return (d) => {
    const pn = (d && d.pageNumber) || 1;
    doc.setDrawColor(...CLINE); doc.setLineWidth(0.2);
    doc.line(M, 286, M + RW, 286);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...CMUT);
    doc.text('Processado por computador · DeccApp Gestão' + (meta ? '  ·  ' + meta : ''), M, 291);
    doc.text('Hash: ' + (hash || '————'), M + RW / 2, 291, { align: 'center' });
    doc.text('Página ' + pn, M + RW, 291, { align: 'right' });
    doc.text('Obrigado pela sua preferência!', M + RW, 295, { align: 'right' });
    doc.setFontSize(6.8);
    doc.text('Documento gerado eletronicamente — válido sem assinatura quando emitido por computador.', M, 295);
  };
}
const TBL = {
  styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 3, textColor: [30, 41, 59], fillColor: [255, 255, 255], lineColor: [226, 232, 240], lineWidth: 0.1 },
  headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', fontSize: 8.5 }
};
const TBLFOOT = { fillColor: [248, 250, 252], textColor: [30, 41, 59], fontStyle: 'bold', fontSize: 9 };
function stockSku(nm) { try { const s = (typeof stock !== 'undefined' ? stock : []).find(x => (x.name || '').toLowerCase() === String(nm || '').toLowerCase()); return (s && s.sku) || '—'; } catch (_) { return '—'; } }
function docSignatures(doc, leftLabel, rightLabel, opts) {
  const M = PDF_M, RW = PDF_W;
  let yy = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 200) + 20;
  if (yy > 236) { doc.addPage(); yy = 46; }
  const extra = (opts && opts.lines) || 'Data: ____/____/________     Doc/BI: __________________';
  doc.setDrawColor(...CLINE); doc.setLineWidth(0.3);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4); doc.setTextColor(...CMUT);
  doc.line(M, yy, M + 70, yy); doc.line(M + RW - 70, yy, M + RW, yy);
  doc.text(String(leftLabel), M + 35, yy + 5, { align: 'center' });
  doc.text(String(rightLabel), M + RW - 35, yy + 5, { align: 'center' });
  doc.setFontSize(7.2);
  doc.text(extra, M, yy + 11.5);
  doc.text(extra, M + RW - 80, yy + 11.5);
  return yy + 16;
}
function ivaLines(total, mode, vatRate) {
  const r = Number(vatRate) || 0;
  if (mode === 'isento' || r <= 0) return { base: total, iva: 0, label: 'ISENTO' };
  const base = Math.round((total / (1 + r / 100)) * 100) / 100;
  return { base, iva: Math.round((total - base) * 100) / 100, label: 'IVA ' + r + '%' };
}
async function savePdfFile(blob, name) {
  /* Grava na pasta Transferências sem caixa de diálogo (igual a um download). */
  if (window.api && typeof window.api.saveDocumentPdf === 'function') {
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      const res = await window.api.saveDocumentPdf(name, data);
      if (res && res.path) { toast('PDF guardado: ' + res.path, 'success'); return true; }
    } catch (_) {}
  }
  dl(blob, name.endsWith('.pdf') ? name : name + '.pdf');
  return true;
}
async function saveSalePdfCopy(s, copy) {
  if(!canSeeSale(s)) return toast('Este documento pertence a outro utilizador.','error');
  const name = safeName(s.number + (copy ? ' ' + copy : '')) + '.pdf';
  try {
    const blob = salePdfBlob ? await salePdfBlob(s, copy) : null;
    if (blob) return await savePdfFile(blob, name);
  } catch (_) {}
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Gerador de PDF não disponível.', 'error'); return false; }
  try { pdfSave(buildSalePdf(s), safeName(s.number + (copy ? ' ' + copy : ''))); return true; }
  catch (e) { toast('Não foi possível gerar o documento: ' + e.message, 'error'); return false; }
}
function salePdf(s, copies) {
  return (async () => {
    let saved = 0;
    for (const index of saleCopyList(s, copies)) {
      const copy = saleCopyName((company || {}).docLang === 'pt' ? 'pt' : 'en', index);
      if (await saveSalePdfCopy(s, copy)) saved++;
    }
    if (saved) recordSaleIssue(s, 'pdf');
  })();
}

/* ---------- exports ---------- */
const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
$('btnPrint').onclick = () => {
  if (!currentSup) return;
  const rows = withBalances(currentSup.id);
  printDocumentHtml('<h2>Extrato de conta — ' + esc(currentSup.name) + '</h2><table><thead><tr><th>Data</th><th>Documento</th><th>Total</th><th>Pago</th><th>Saldo</th></tr></thead><tbody>' + rows.map(r => '<tr><td>' + fmtDate(r.date) + '</td><td>' + esc(r.number) + '</td><td>' + MZN(r.total) + '</td><td>' + MZN(r.paid) + '</td><td>' + MZN(r.newBalance) + '</td></tr>').join('') + '</tbody></table><p>Saldo em dívida: <strong>' + MZN(supEffective(currentSup.id)) + '</strong></p>');
};
$('btnPrintDash').onclick = () => {
  if (!dashRecentRows.length) return toast('Sem movimentos para imprimir.', 'warning');
  printDocumentHtml('<h2>Últimos movimentos</h2><table><thead><tr><th>Data</th><th>Tipo</th><th>Documento</th><th>Detalhe</th><th>Total</th></tr></thead><tbody>' + dashRecentRows.map(r => '<tr>' + [r.date,r.kind,r.doc,r.detail,r.total].map(v => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
};
function pdfFor(sup, rows, title) {
  const doc = docNew();
  const totF = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const totP = rows.reduce((s, r) => s + (Number(r.paid) || 0), 0);
  const saldo = sup ? supEffective(sup.id) : totF - totP;
  const period = rows.length ? (fmtDate(rows[0].date) + '  a  ' + fmtDate(rows[rows.length - 1].date)) : '—';
  let y = docHeader(doc, sup ? 'EXTRATO DE CONTA (FORNECEDOR)' : 'RESUMO GERAL DE CONTAS',
    sup ? String(sup.name || '') : 'Todos os fornecedores', 'Período: ' + period, pdfNow());
  y = docMeta(doc, y, [
    { title: sup ? 'Fornecedor' : 'Âmbito', lines: sup
      ? [String(sup.name || '—'), sup.nuit ? 'NUIT: ' + sup.nuit : '', sup.bank ? 'Conta bancária: ' + sup.bank : '', [sup.phone, sup.email].filter(Boolean).join(' · ')]
      : ['Todas as contas de fornecedores', 'Documentos: ' + rows.length] },
    { title: 'Detalhes do extrato', lines: [
      'Período: ' + period,
      'Faturas: ' + rows.length,
      'Emitido em: ' + pdfNow(),
      'Saldo em dívida: ' + MZN(saldo)
    ] }
  ]);
  y = docItems(doc, y, {
    columnStyles: {
      0: { cellWidth: 17, textColor: CMUT },
      1: { cellWidth: 22, fontStyle: 'bold', fontSize: 7.6 },
      2: { halign: 'center', cellWidth: 11, fontSize: 7.4, textColor: CMUT },
      3: { cellWidth: 'auto', fontSize: 7.4 },
      4: { halign: 'right', cellWidth: 19, fontSize: 7.4 },
      5: { halign: 'right', cellWidth: 22 },
      6: { halign: 'right', cellWidth: 22 },
      7: { halign: 'right', cellWidth: 24, fontStyle: 'bold' }
    },
    head: [['Data', 'Fatura', 'Qtd', 'Designação do Produto', 'P. Unit (MT)', 'Total (MT)', 'Pago (MT)', 'Saldo (MT)']],
    body: rows.map(r => [
      fmtDate(r.date), r.number,
      r.items.map(p => fmtQty(p)).join('\n'),
      r.items.map(p => p.desc).join('\n'),
      r.items.map(p => MZN(p.price)).join('\n'),
      MZN(r.total), MZN(r.paid), MZN(r.newBalance)
    ]),
    didDrawPage: docFootSetup(doc, '', 'Extrato de conta')
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL FATURADO', value: MZN(totF) },
    { label: 'TOTAL PAGO', value: MZN(totP), color: COK },
    { label: 'SALDO EM DÍVIDA', value: MZN(saldo), big: true, rule: true, color: saldo > 0 ? CBAD : COK }
  ]);
  y = docNotes(doc, y, 'Observações', [
    'Valores em Meticais (MT). O saldo em dívida considera todos os pagamentos e créditos registados.',
    saldo > 0 ? 'Encontra-se por liquidar ' + MZN(saldo) + '.' : 'Conta regularizada — sem valores em falta.'
  ]);
  docSignatures(doc, 'O Fornecedor', 'O Responsável');
  pdfSave(doc, safeName(title));
}
$('btnPdf').onclick = () => { if (currentSup) pdfFor(currentSup, withBalances(currentSup.id), 'Extrato - ' + currentSup.name); };
/* Últimos movimentos: exporta exatamente a lista que está no ecrã */
async function dashXls() {
  if (!dashRecentRows.length) return toast('Sem movimentos para exportar.', 'warning');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Movimentos');
  const thin = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
  ws.columns = [{ width: 12 }, { width: 34 }, { width: 18 }, { width: 42 }, { width: 18 }];
  const t = ws.addRow(['Últimos movimentos', '', '', '', '']);
  t.font = { bold: true, size: 13 };
  const head = ws.addRow(['Data', 'Tipo', 'Documento', 'Detalhe', 'Total']);
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle' };
  head.eachCell(c => { c.border = thin; });
  dashRecentRows.forEach(r => {
    const row = ws.addRow([r.date, r.kind, r.doc, r.detail, r.total]);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell(c => { c.border = thin; });
  });
  const buf = await wb.xlsx.writeBuffer();
  dl(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ultimos_movimentos.xlsx');
}
function dashPdf() {
  if (!dashRecentRows.length) return toast('Sem movimentos para exportar.', 'warning');
  if (!window.jspdf || !window.jspdf.jsPDF) return toast('Gerador de PDF não disponível.', 'error');
  const doc = docNew();
  let y = docHeader(doc, 'Últimos Movimentos', 'PAINEL GERAL', pdfNow(), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Emitido por', lines: [userNameOf(currentUser), currentRole() === 'admin' ? 'Administrador' : 'Operador'] },
    { title: 'Registos', lines: [dashRecentRows.length + ' movimento(s)', 'Lista do painel (mais recentes)'] }
  ]);
  y = docItems(doc, y, {
    styles: Object.assign({}, TBL.styles, { fontSize: 8 }),
    head: [['Data', 'Tipo', 'Documento', 'Detalhe', 'Total']],
    body: dashRecentRows.map(r => [r.date, r.kind, r.doc, r.detail, r.total]),
    columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 36 }, 2: { cellWidth: 24 }, 3: { cellWidth: 'auto' }, 4: { cellWidth: 24, halign: 'right' } },
    didDrawPage: docFootSetup(doc, '', 'Últimos movimentos')
  });
  docSignatures(doc, 'O Responsável', 'O Operador');
  pdfSave(doc, 'ultimos_movimentos');
}
$('btnPdfDash').onclick = () => dashPdf();
async function xlsFor(sup, rows, fname) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Historico');
  const thin = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
  ws.columns = [{ width: 12 }, { width: 14 }, { width: 15 }, { width: 10 }, { width: 38 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 18 }, { width: 15 }, { width: 22 }];
  ws.addRow([sup ? sup.name : 'Resumo geral', '', '', '', '', '', '', '', '', '', '', '']);
  const head = ws.addRow(['Data', 'Nº Fatura', 'Saldo Antigo', 'Qtd', 'Designação do Produto', 'Preço Unit.', 'Total Prod.', 'Total Fatura', 'Saldo Total', 'Forma Pagamento', 'Novo Saldo', 'Notas']);
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'middle' };
  head.eachCell(c => { c.border = thin; });
  rows.forEach((r) => {
    const row = ws.addRow([fmtDate(r.date), r.number, Number(r.oldBalance), r.items.map(p => fmtQty(p)).join('\n'), r.items.map(p => p.desc).join('\n'), r.items.map(p => p.price).join('\n'), r.items.map(p => p.total).join('\n'), Number(r.total), Number(r.totalBalance), r.payMethod, Number(r.newBalance), r.notes]);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell(c => { c.border = thin; });
    [3, 8, 9, 11].forEach(n => { const c = row.getCell(n); if (typeof c.value === 'number') c.numFmt = '#,##0.00'; });
  });
  const buf = await wb.xlsx.writeBuffer(); dl(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname);
}
$('btnXls').onclick = () => { if (currentSup) xlsFor(currentSup, withBalances(currentSup.id), 'extrato_' + currentSup.name.replace(/\s+/g, '_') + '.xlsx'); };
$('btnXlsDash').onclick = () => dashXls();
/* ---------- backup integral, separado das exportações Excel ---------- */
let systemBackupBusy=false;
function systemCollections() {
  return {[LS.sup]:suppliers,[LS.inv]:invoices,[LS.stock]:stock,[LS.sales]:sales,[LS.cli]:clients,[LS.suppay]:supPayments,dec_supadj:supAdjustments,dec_losses:stockLosses,[LS.moves]:movements,[LS.cashdays]:cashDays,[LS.cashmoves]:cashMoves,[LS.receipts]:receipts,[LS.ncs]:ncs,[LS.porders]:porders,[LS.supret]:supReturns,[LS.transfers]:transfers,[LS.drafts]:drafts,[LS.notifs]:notifs,dec_chat:chatMsgs};
}
function systemIsEmpty() {
  return Object.entries(systemCollections()).every(([key,records])=>{
    if(!Array.isArray(records)||records.length) return false;
    const stored=localStorage.getItem(key);if(stored===null) return true;
    try {const values=JSON.parse(stored);return Array.isArray(values)&&values.length===0;} catch(error) {return false;}
  });
}
function systemBackupAdmin() {return $('app')?.style.display==='flex' && currentRole()==='admin';}
function canRestoreSystem() {
  if(!systemIsEmpty()) return false;
  if($('app')?.style.display==='flex') return currentRole()==='admin';
  return !load(LS.pin,null) && appUsers().length===0;
}
function renderSystemBackupStatus() {
  const empty=systemIsEmpty(),admin=systemBackupAdmin();
  if($('restoreFirstBox')) $('restoreFirstBox').hidden=!(empty && !load(LS.pin,null) && appUsers().length===0);
  if($('systemRestoreStatus')) $('systemRestoreStatus').textContent=empty?'Este sistema está vazio e pode receber um backup completo.':'Este sistema já tem registos. A importação completa só está disponível num sistema vazio.';
  if($('btnExportSystem')) $('btnExportSystem').disabled=systemBackupBusy||!admin;
  if($('btnRestoreSystem')) $('btnRestoreSystem').disabled=systemBackupBusy||!admin||!empty;
  if($('btnRestoreFirst')) $('btnRestoreFirst').disabled=systemBackupBusy||!canRestoreSystem();
  const last=load('dec_last_system_backup',null);
  if($('systemBackupLast')) $('systemBackupLast').textContent=last?'Última exportação: '+fmtDateTime(last.at)+' · '+last.filename:'Ainda não foi exportado um backup completo neste dispositivo.';
}
function collectSystemBackupEntries() {
  const api=window.DecAppSystemBackup;if(!api) throw new Error('O módulo de backup não foi carregado. Reinicie a aplicação.');
  const entries=api.storageEntries(localStorage);
  const state={...systemCollections(),[LS.queue]:[...syncInFlight,...queue],[LS.pay]:payMethods,[LS.units]:units,[LS.company]:company,[LS.tax]:tax,dec_stockcfg:stockCfg(),dec_users:appUsers(),[LS.notifSeen]:notifSeen,dec_notif_del:notifDeleted,dec_chat_seen:chatSeen,dec_chat_del:chatDeleted,dec_notif_user_state:notifUserState()};
  Object.entries(state).forEach(([key,value])=>{entries[key]=JSON.stringify(value);});
  return entries;
}
async function exportSystemBackup() {
  if(!systemBackupAdmin()) return toast('Backup completo: acesso Administrador.','warning');
  if(systemBackupBusy) return;
  systemBackupBusy=true;renderSystemBackupStatus();
  try {
    if(saleDirty() && saleSignature()!==lastDraftSig) saveSaleDraft(undefined,{silent:true});
    const backup=await window.DecAppSystemBackup.create(collectSystemBackupEntries(),{company:company.name,exportedBy:currentUser,cloudUid:cloudUid()});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const filename='deccapp-backup-completo-'+stamp+'.json';
    dl(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}),filename);
    save('dec_last_system_backup',{at:Date.now(),filename});
    toast('Backup completo exportado.','success');
  } catch(error) {toast('Não foi possível exportar: '+error.message,'error');}
  finally {systemBackupBusy=false;renderSystemBackupStatus();}
}
function chooseSystemBackup() {
  if(systemBackupBusy) return;
  if(!canRestoreSystem()) return toast('A importação completa exige um sistema vazio e acesso de administrador.','warning');
  $('fileSystemBackup').click();
}
async function importSystemBackup(file) {
  if(!file || systemBackupBusy) return;
  if(!canRestoreSystem()) return toast('A importação completa só é permitida num sistema vazio.','warning');
  systemBackupBusy=true;renderSystemBackupStatus();
  try {
    if(file.size>50*1024*1024) throw new Error('O ficheiro de backup é demasiado grande.');
    const api=window.DecAppSystemBackup;if(!api) throw new Error('O módulo de backup não foi carregado. Reinicie a aplicação.');
    const backup=await api.parse(await file.text()),info=api.summary(backup);
    const message=info.company+' · Backup de '+fmtDateTime(Date.parse(info.createdAt))+' · '+info.records+' registo(s), '+info.documents+' documento(s), '+info.clients+' cliente(s), '+info.products+' produto(s) e '+info.users+' utilizador(es). Os dados e acessos deste ficheiro serão restaurados.';
    let confirmed;
    if(window.Swal) {const result=await Swal.fire({title:'Restaurar backup completo?',text:message,icon:'question',showCancelButton:true,confirmButtonText:'Restaurar backup',cancelButtonText:'Cancelar'});confirmed=result.isConfirmed;}
    else confirmed=confirm('Restaurar backup completo?\n'+message);
    if(!confirmed) return;
    if(!canRestoreSystem()) throw new Error('O sistema recebeu novos registos. A restauração foi cancelada.');
    if(isSyncing) throw new Error('Aguarde o fim da sincronização e volte a importar.');
    systemRestoreInProgress=true;stopDataWatch();stopChatWatch();
    if(auth?.currentUser) await auth.signOut();
    await api.restore(localStorage,backup,{canRestore:canRestoreSystem});
    try {sessionStorage.setItem('dec_restore_notice',JSON.stringify({company:info.company,at:Date.now()}));} catch(error) {}
    location.reload();
  } catch(error) {
    systemRestoreInProgress=false;
    toast('Não foi possível importar: '+error.message,'error');
    if($('app')?.style.display==='flex') {try {startDataWatch();startChatWatch();}catch(watchError){}}
  } finally {systemBackupBusy=false;renderSystemBackupStatus();}
}
if($('btnExportSystem')) $('btnExportSystem').onclick=exportSystemBackup;
if($('btnRestoreSystem')) $('btnRestoreSystem').onclick=chooseSystemBackup;
if($('btnRestoreFirst')) $('btnRestoreFirst').onclick=chooseSystemBackup;
if($('fileSystemBackup')) $('fileSystemBackup').onchange=event=>{const file=event.target.files?.[0];event.target.value='';return importSystemBackup(file);};

/* ---------- exportar/importar Excel ---------- */
async function xlsAll(supIds) {
  const thin = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
  const list = (supIds && supIds.length) ? suppliers.filter(s => supIds.includes(s.id)) : suppliers;
  if (!list.length) return toast('Nenhum fornecedor para exportar.', 'warning');
  const ids = list.map(s => s.id);
  const invs = invoices.filter(i => ids.includes(i.supplierId)).sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fornecedores');
  ws.columns = [{ width: 16 }, { width: 32 }, { width: 16 }, { width: 26 }, { width: 26 }, { width: 16 }, { width: 24 }];
  const h1 = ws.addRow(['ID', 'Nome', 'Telefone', 'Email', 'Endereço', 'NUIT', 'Conta Bancária']);
  h1.font = { bold: true }; h1.alignment = { wrapText: true, vertical: 'middle' }; h1.eachCell(c => { c.border = thin; });
  list.forEach(s => {
    const r = ws.addRow([s.id, s.name, s.phone || '', s.email || '', s.address || '', s.nuit || '', s.bank || '']);
    r.eachCell(c => { c.border = thin; });
  });
  const wi = wb.addWorksheet('Faturas');
  wi.columns = [{ width: 14 }, { width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 36 }, { width: 15 }, { width: 13 }, { width: 18 }, { width: 24 }, { width: 10 }];
  const h2 = wi.addRow(['ID', 'ID Fornecedor', 'Fornecedor', 'Data', 'Nº Fatura', 'Qtd', 'Designação do Produto', 'Preço Unit.', 'Valor Pago', 'Forma Pagamento', 'Notas', 'Unid.']);
  h2.font = { bold: true }; h2.alignment = { wrapText: true, vertical: 'middle' }; h2.eachCell(c => { c.border = thin; });
  invs.forEach(i => {
    const r = wi.addRow([i.id, i.supplierId, supName(i.supplierId), fmtDate(i.date), i.number, i.items.map(p => fmtQty(p)).join('\n'), i.items.map(p => p.desc).join('\n'), i.items.map(p => p.price).join('\n'), Number(i.paid) || 0, i.payMethod, i.notes || '', i.items.map(p => p.unit || '').join('\n')]);
    r.alignment = { wrapText: true, vertical: 'top' };
    r.eachCell(c => { c.border = thin; });
    r.getCell(9).numFmt = '#,##0.00';
  });
  const wk = wb.addWorksheet('Stock');
  wk.columns = [{ width: 34 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }];
  const h3 = wk.addRow(['Nome', 'Unidade', 'Loja', 'Armazém', 'Total', 'Preço', 'Custo', 'Margem', 'Mín']);
  h3.font = { bold: true }; h3.eachCell(c => { c.border = thin; });
  stock.forEach(s => {
    const r = wk.addRow([s.name, s.unit || '', Number(s.qLoja) || 0, Number(s.qArm) || 0, stockTotal(s), Number(s.price) || 0, Number(s.cost) || 0, Number(s.margin != null ? s.margin : 0), Number(s.min) || 0]);
    r.eachCell(c => { c.border = thin; }); r.getCell(6).numFmt = '#,##0.00'; r.getCell(7).numFmt = '#,##0.00';
  });
  const wc = wb.addWorksheet('Config');
  wc.columns = [{ width: 14 }, { width: 30 }];
  const h4 = wc.addRow(['Tipo', 'Valor']);
  h4.font = { bold: true }; h4.eachCell(c => { c.border = thin; });
  payMethods.forEach(v => { const r = wc.addRow(['Pagamento', v]); r.eachCell(c => { c.border = thin; }); });
  units.forEach(v => { const r = wc.addRow(['Unidade', v]); r.eachCell(c => { c.border = thin; }); });
  const wv = wb.addWorksheet('Vendas');
  wv.columns = [{ width: 14 }, { width: 12 }, { width: 14 }, { width: 24 }, { width: 12 }, { width: 10 }, { width: 36 }, { width: 14 }, { width: 13 }, { width: 18 }, { width: 24 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 20 }, { width: 16 }, { width: 14 }];
  const h5 = wv.addRow(['ID', 'Data', 'Doc', 'Cliente', 'Tipo', 'Qtd', 'Designação do Produto', 'Preço Unit.', 'Valor Recebido', 'Forma Pagamento', 'Notas', 'Pagamentos', 'ClienteID', 'Estado']);
  h5.font = { bold: true }; h5.eachCell(c => { c.border = thin; });
  sales.forEach(x => {
    const pg = (x.payments || []).map(p => fmtDate(p.date) + ':' + p.amount + ' ' + (p.method || '')).join('; ');
    const r = wv.addRow([x.id, fmtDate(x.date), x.number, x.client || '', x.type, x.items.map(p => fmtQty(p)).join('\n'), x.items.map(p => p.desc).join('\n'), x.items.map(p => p.price).join('\n'), Number(x.paid) || 0, x.payMethod, x.notes || '', pg, x.clientId || '', x.status || '', x.time || '', x.iva || 'incl', x.ivaMotive || '', x.hash || '', x.grNumber || '']);
    r.alignment = { wrapText: true, vertical: 'top' };
    r.eachCell(c => { c.border = thin; });
    r.getCell(9).numFmt = '#,##0.00';
  });
  const wcl = wb.addWorksheet('Clientes');
  wcl.columns = [{ width: 14 }, { width: 30 }, { width: 14 }, { width: 16 }, { width: 24 }, { width: 24 }, { width: 12 }, { width: 12 }];
  const hc = wcl.addRow(['ID', 'Nome', 'NUIT', 'Telefone', 'Email', 'Morada', 'Tipo', 'Prazo']);
  hc.font = { bold: true }; hc.eachCell(c => { c.border = thin; });
  clients.forEach(c => { const r = wcl.addRow([c.id, c.name, c.nuit || '', c.phone || '', c.email || '', c.address || '', c.ctype || '', Number(c.payTerm) || 0]); r.eachCell(x => { x.border = thin; }); });
  const wsp = wb.addWorksheet('PagFornecedor');
  wsp.columns = [{ width: 14 }, { width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 13 }, { width: 18 }, { width: 24 }];
  const hp = wsp.addRow(['ID', 'ID Fornecedor', 'Fornecedor', 'Data', 'Doc', 'Valor', 'Forma', 'Notas']);
  hp.font = { bold: true }; hp.eachCell(c => { c.border = thin; });
  supPayments.forEach(p => { const r = wsp.addRow([p.id, p.supplierId, supName(p.supplierId), p.date, p.number, Number(p.amount) || 0, p.method, p.notes || '']); r.eachCell(c => { c.border = thin; }); r.getCell(6).numFmt = '#,##0.00'; });
  const wcd = wb.addWorksheet('CaixaDias');
  wcd.columns = [{ width: 12 }, { width: 12 }, { width: 12 }];
  const hd = wcd.addRow(['Data', 'Troco Inicial', 'Fechada']);
  hd.font = { bold: true }; hd.eachCell(c => { c.border = thin; });
  cashDays.forEach(d => { const r = wcd.addRow([d.date, Number(d.open) || 0, d.closed ? 'SIM' : '']); r.eachCell(c => { c.border = thin; }); });
  const wcm = wb.addWorksheet('CaixaMovs');
  wcm.columns = [{ width: 14 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 22 }, { width: 13 }, { width: 16 }, { width: 16 }, { width: 24 }];
  const hm = wcm.addRow(['ID', 'Dia', 'Hora', 'Tipo', 'Categoria', 'Valor', 'Forma', 'Ref', 'Notas']);
  hm.font = { bold: true }; hm.eachCell(c => { c.border = thin; });
  cashMoves.forEach(m => { const r = wcm.addRow([m.id, m.day, m.time, m.type, m.category, Number(m.amount) || 0, m.method, m.ref || '', m.notes || '']); r.eachCell(c => { c.border = thin; }); r.getCell(6).numFmt = '#,##0.00'; });
  const wkx = wb.addWorksheet('Kardex');
  wkx.columns = [{ width: 14 }, { width: 30 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 24 }];
  const hk = wkx.addRow(['ID', 'Produto', 'Data', 'Tipo', 'Qtd', 'Stock após', 'Ref', 'Motivo']);
  hk.font = { bold: true }; hk.eachCell(c => { c.border = thin; });
  movements.forEach(m => { const r = wkx.addRow([m.id, m.name, m.date, m.type, m.qty, m.after, m.ref || '', m.reason || '']); r.eachCell(c => { c.border = thin; }); });
  const wr = wb.addWorksheet('Recibos');
  wr.columns = [{ width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 13 }, { width: 18 }, { width: 40 }];
  const hr = wr.addRow(['ID', 'Cliente', 'Data', 'Recibo', 'Total', 'Forma', 'Alocações']);
  hr.font = { bold: true }; hr.eachCell(c => { c.border = thin; });
  receipts.forEach(r => {
    const al = (r.allocations || []).map(a => a.number + ':' + a.amount).join('; ');
    const row = wr.addRow([r.id, r.client || '', r.date, r.number, Number(r.total) || 0, r.method, al]);
    row.eachCell(c => { c.border = thin; }); row.getCell(5).numFmt = '#,##0.00';
  });
  const wn = wb.addWorksheet('NotasCredito');
  wn.columns = [{ width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 36 }, { width: 14 }, { width: 13 }, { width: 20 }];
  const hn = wn.addRow(['ID', 'Cliente', 'Data', 'NC', 'Fatura Origem', 'Qtd', 'Designação', 'Preço', 'Total', 'Motivo']);
  hn.font = { bold: true }; hn.eachCell(c => { c.border = thin; });
  ncs.forEach(n => {
    const row = wn.addRow([n.id, n.client || '', n.date, n.number, (sales.find(x => x.id === n.saleId) || {}).number || '', n.items.map(p => fmtQty(p)).join('\n'), n.items.map(p => p.desc).join('\n'), n.items.map(p => p.price).join('\n'), Number(n.total) || 0, n.motive || '']);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell(c => { c.border = thin; }); row.getCell(9).numFmt = '#,##0.00';
  });
  const wo = wb.addWorksheet('OrdensCompra');
  wo.columns = [{ width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 36 }, { width: 14 }, { width: 12 }, { width: 24 }];
  const ho = wo.addRow(['ID', 'Fornecedor', 'Data', 'Ordem', 'Qtd', 'Designação', 'Preço', 'Estado', 'Notas']);
  ho.font = { bold: true }; ho.eachCell(c => { c.border = thin; });
  porders.forEach(o => {
    const row = wo.addRow([o.id, supName(o.supplierId), o.date, o.number, o.items.map(p => fmtQty(p)).join('\n'), o.items.map(p => p.desc).join('\n'), o.items.map(p => p.price).join('\n'), o.status, o.notes || '']);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell(c => { c.border = thin; });
  });
  const wd = wb.addWorksheet('DevFornecedor');
  wd.columns = [{ width: 14 }, { width: 24 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 36 }, { width: 14 }, { width: 13 }, { width: 20 }];
  const hdd = wd.addRow(['ID', 'Fornecedor', 'Data', 'ND', 'Qtd', 'Designação', 'Preço', 'Total', 'Motivo']);
  hdd.font = { bold: true }; hdd.eachCell(c => { c.border = thin; });
  supReturns.forEach(r => {
    const row = wd.addRow([r.id, supName(r.supplierId), r.date, r.number, r.items.map(p => fmtQty(p)).join('\n'), r.items.map(p => p.desc).join('\n'), r.items.map(p => p.price).join('\n'), Number(r.total) || 0, r.motive || '']);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell(c => { c.border = thin; }); row.getCell(8).numFmt = '#,##0.00';
  });
  const wt = wb.addWorksheet('Transferencias');
  wt.columns = [{ width: 14 }, { width: 30 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 24 }];
  const ht = wt.addRow(['ID', 'Produto', 'Data', 'GTI', 'Qtd', 'De', 'Para', 'Notas']);
  ht.font = { bold: true }; ht.eachCell(c => { c.border = thin; });
  transfers.forEach(t => {
    const row = wt.addRow([t.id, t.name, t.date, t.number, Number(t.qty) || 0, t.from, t.to, t.notes || '']);
    row.eachCell(c => { c.border = thin; });
  });
  const buf = await wb.xlsx.writeBuffer();
  const fname = list.length === 1 ? 'extrato_backup_' + list[0].name.replace(/\s+/g, '_') + '.xlsx' : 'deccapp_backup_completo.xlsx';
  dl(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname);
  toast('Backup exportado (' + list.length + ' fornecedor(es)).', 'success');
}
$('btnXlsAll').onclick = () => {
  if (!suppliers.length) return toast('Nenhum fornecedor para exportar.', 'warning');
  const box = $('expList'); box.innerHTML = '';
  suppliers.forEach(s => {
    const lb = document.createElement('label');
    lb.innerHTML = `<input type="checkbox" value="${s.id}" checked /> ${esc(s.name)}`;
    box.appendChild(lb);
  });
  $('expAll').checked = true;
  $('expModal').style.display = 'flex';
};
$('expAll').onchange = (e) => { $('expList').querySelectorAll('input').forEach(i => { i.checked = e.target.checked; }); };
$('btnCancelExp').onclick = () => { $('expModal').style.display = 'none'; };
$('btnDoExp').onclick = async () => {
  const ids = [...$('expList').querySelectorAll('input:checked')].map(i => i.value);
  if (!ids.length) return toast('Selecione pelo menos 1 fornecedor.', 'warning');
  $('expModal').style.display = 'none';
  await xlsAll(ids);
};
$('btnXlsAllImp').onclick = () => $('fileXlsAll').click();
$('fileXlsAll').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Fornecedores') || wb.worksheets[0];
    const wi = wb.getWorksheet('Faturas') || wb.worksheets[1];
    let supNew = 0, supUpd = 0, invNew = 0, invUpd = 0;
    const str = (row, n) => String(xlsVal(row.getCell(n)) || '').trim();
    const idMap = {};
    if (ws) ws.eachRow((row, n) => {
      if (n <= 1) return;
      const fid = str(row, 1), name = str(row, 2);
      if (!name) return;
      let s = (fid && suppliers.find(x => x.id === fid)) || suppliers.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
      if (s) { Object.assign(s, { name, phone: str(row, 3), email: str(row, 4), address: str(row, 5), nuit: str(row, 6), bank: str(row, 7), updatedAt: Date.now() }); pushQueue({ type: 'supplier', payload: { ...s } }); supUpd++; }
      else { s = { id: fid || uid(), name, phone: str(row, 3), email: str(row, 4), address: str(row, 5), nuit: str(row, 6), bank: str(row, 7), createdAt: Date.now(), updatedAt: Date.now() }; suppliers.push(s); pushQueue({ type: 'supplier', payload: { ...s } }); supNew++; }
      if (fid) idMap[fid] = s.id;
    });
    if (wi) wi.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), fSupId = str(row, 2), nm = str(row, 3);
      let supId = (fSupId && (idMap[fSupId] || (suppliers.find(x => x.id === fSupId) || {}).id)) || null;
      if (!supId && nm) {
        let s = suppliers.find(x => (x.name || '').toLowerCase() === nm.toLowerCase());
        if (!s) { s = { id: uid(), name: nm, phone: '', email: '', address: '', nuit: '', createdAt: Date.now(), updatedAt: Date.now() }; suppliers.push(s); pushQueue({ type: 'supplier', payload: { ...s } }); supNew++; }
        supId = s.id;
      }
      const num = str(row, 5), date = xlsDate(row.getCell(4));
      if (!supId || !num || !date) return;
      const descs = String(xlsVal(row.getCell(7)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(8)) ?? '').split('\n');
      const unis = String(xlsVal(row.getCell(12)) ?? '').split('\n');
      const items = [];
      const m = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        const unit = ((unis[i] || '').trim() || qq.unit).toUpperCase();
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit, price, total: qq.qty * price });
      }
      if (!items.length) return;
      const total = items.reduce((s2, p) => s2 + p.total, 0);
      const paid = Math.max(toNum(xlsVal(row.getCell(9))) || 0, 0);
      const payMethod = str(row, 10) || 'Numerário', notes = str(row, 11);
      let inv = (iid && invoices.find(x => x.id === iid)) || invoices.find(x => x.supplierId === supId && (x.number || '').toLowerCase() === num.toLowerCase());
      if (!payMethods.includes(payMethod)) { payMethods.push(payMethod); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); }
      let uCh2 = false;
      items.forEach(p => { if (p.unit && !units.includes(p.unit)) { units.push(p.unit); uCh2 = true; } });
      if (uCh2) pushQueue({ type: 'settings', payload: { key: 'units', list: units } });
      if (inv) { stockApply(inv.items, -1, true, inv.number, 'armazem'); Object.assign(inv, { supplierId: supId, date, number: num, items, total, paid, payMethod, notes, updatedAt: Date.now() }); stockApply(inv.items, +1, true, inv.number, 'armazem'); pushQueue({ type: 'invoice', payload: { ...inv } }); invUpd++; }
      else { inv = { id: iid || uid(), supplierId: supId, date, number: num, loc: 'armazem', items, total, paid, payMethod, notes, createdAt: Date.now(), updatedAt: Date.now() }; invoices.push(inv); pushQueue({ type: 'invoice', payload: { ...inv } }); stockApply(inv.items, +1, true, inv.number, 'armazem'); invNew++; }
    });
    const wc2 = wb.getWorksheet('Config');
    if (wc2) wc2.eachRow((row, n) => {
      if (n <= 1) return;
      const t = str(row, 1).toLowerCase(), v = str(row, 2);
      if (!v) return;
      if (t.indexOf('pag') === 0 && !payMethods.includes(v)) { payMethods.push(v); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); }
      else if (t.indexOf('uni') === 0 && !units.includes(v.toUpperCase())) { units.push(v.toUpperCase()); pushQueue({ type: 'settings', payload: { key: 'units', list: units } }); }
    });
    renderPayUnits();
    const wv2 = wb.getWorksheet('Vendas');
    if (wv2) wv2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), date = xlsDate(row.getCell(2)), num = str(row, 3);
      if (!num || !date) return;
      const t5 = str(row, 5).toLowerCase();
      const client = str(row, 4), type = (t5.indexOf('cot') === 0 || t5.indexOf('fp') === 0 || t5.indexOf('prof') === 0) ? 'cotacao' : t5.indexOf('cred') === 0 ? 'credito' : 'venda';
      const descs = String(xlsVal(row.getCell(7)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(8)) ?? '').split('\n');
      const items = [];
      const m2 = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m2; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit: qq.unit, price, total: qq.qty * price });
      }
      if (!items.length) return;
      const total = items.reduce((a2, p) => a2 + p.total, 0);
      const paid = Math.max(toNum(xlsVal(row.getCell(9))) || 0, 0);
      const payments = String(xlsVal(row.getCell(12)) || '').split(';').map(s2 => {
        const mm = s2.trim().match(/^(\d{2}-\d{2}-\d{4}):([\d.,]+)\s*(.*)$/);
        if (!mm) return null;
        return { date: mm[1].slice(6) + '-' + mm[1].slice(3, 5) + '-' + mm[1].slice(0, 2), amount: toNum(mm[2]), method: (mm[3] || '').trim() };
      }).filter(Boolean);
      const rec = { date, number: num, client, type, items, total, paid, payMethod: str(row, 10) || 'Numerário', notes: str(row, 11), payments, time: str(row, 15), iva: str(row, 16) || 'incl', ivaMotive: str(row, 17), hash: str(row, 18), prevHash: '', grNumber: str(row, 19) || null, updatedAt: Date.now() };
      const cidImp = str(row, 13), sttImp = str(row, 14);
      if (cidImp) rec.clientId = cidImp;
      if (sttImp) rec.status = sttImp;
      let sv = (iid && sales.find(x => x.id === iid)) || sales.find(x => (x.number || '').toLowerCase() === num.toLowerCase());
      if (sv) Object.assign(sv, rec);
      else { sv = { id: iid || uid(), createdAt: Date.now(), ...rec }; sales.push(sv); }
      pushQueue({ type: 'sale', payload: { ...sv } });
    });
    const wst2 = wb.getWorksheet('Stock');
    if (wst2) { const seenSt = new Set(); wst2.eachRow((row, n) => {
      if (n <= 1) return;
      const name = str(row, 1).toUpperCase();
      if (!name) return;
      if (seenSt.has(name.toLowerCase())) return;
      seenSt.add(name.toLowerCase());
      const price = toNum(xlsVal(row.getCell(6))), cost = toNum(xlsVal(row.getCell(7)));
      let s = findStock(name);
      const rec = { unit: str(row, 2).toUpperCase(), qLoja: Math.max(0, toNum(xlsVal(row.getCell(3)))), qArm: Math.max(0, toNum(xlsVal(row.getCell(4)))), price, cost: cost > 0 ? cost : price, margin: toNum(xlsVal(row.getCell(8))) || 0, min: toNum(xlsVal(row.getCell(9))) || 0, updatedAt: Date.now() };
      if (s) { Object.assign(s, rec); delete s.qty; }
      else { s = { id: uid(), name, createdAt: Date.now(), ...rec }; stock.push(s); }
      pushQueue({ type: 'stock', payload: { ...s } });
    }); }
    const wcl2 = wb.getWorksheet('Clientes');
    const cliHasLimite = wcl2 && String(xlsVal(wcl2.getRow(1).getCell(7)) || '').toLowerCase() === 'limite';
    if (wcl2) wcl2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), name = str(row, 2);
      if (!name) return;
      let c = (iid && clients.find(x => x.id === iid)) || findClientByName(name);
      const rec = cliHasLimite
        ? { name, nuit: str(row, 3), phone: str(row, 4), email: str(row, 5), address: str(row, 6), creditLimit: 0, ctype: str(row, 8), payTerm: toNum(xlsVal(row.getCell(9))), updatedAt: Date.now() }
        : { name, nuit: str(row, 3), phone: str(row, 4), email: str(row, 5), address: str(row, 6), creditLimit: 0, ctype: str(row, 7), payTerm: toNum(xlsVal(row.getCell(8))), updatedAt: Date.now() };
      if (c) Object.assign(c, rec);
      else { c = { id: iid || uid(), createdAt: Date.now(), ...rec }; clients.push(c); }
      pushQueue({ type: 'client', payload: { ...c } });
    });
    const wsp2 = wb.getWorksheet('PagFornecedor');
    if (wsp2) wsp2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), fSupId = str(row, 2), nm = str(row, 3), date = xlsDate(row.getCell(4));
      const amount = toNum(xlsVal(row.getCell(6)));
      if (!date || amount <= 0) return;
      let supId = (fSupId && (idMap[fSupId] || (suppliers.find(x => x.id === fSupId) || {}).id)) || null;
      if (!supId && nm) { const s = suppliers.find(x => (x.name || '').toLowerCase() === nm.toLowerCase()); if (s) supId = s.id; }
      if (!supId) return;
      let p = (iid && supPayments.find(x => x.id === iid)) || null;
      const rec = { supplierId: supId, number: str(row, 5) || nextSupPayNumber(), date, amount, method: str(row, 7) || 'Numerário', notes: str(row, 8), ts: Date.now(), updatedAt: Date.now() };
      if (p) Object.assign(p, rec);
      else { p = { id: iid || uid(), createdAt: Date.now(), ...rec }; supPayments.push(p); }
      pushQueue({ type: 'suppay', payload: { ...p } });
    });
    const wcd2 = wb.getWorksheet('CaixaDias');
    if (wcd2) wcd2.eachRow((row, n) => {
      if (n <= 1) return;
      const date = xlsDate(row.getCell(1));
      if (!date) return;
      let d = cashDays.find(x => x.date === date);
      const rec = { open: toNum(xlsVal(row.getCell(2))), closed: String(xlsVal(row.getCell(3)) || '').toUpperCase() === 'SIM', updatedAt: Date.now() };
      if (d) Object.assign(d, rec);
      else { d = { id: date, date, createdAt: Date.now(), ...rec }; cashDays.push(d); }
      pushQueue({ type: 'cashday', payload: { ...d } });
    });
    const wcm2 = wb.getWorksheet('CaixaMovs');
    if (wcm2) wcm2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), day = xlsDate(row.getCell(2));
      const amount = toNum(xlsVal(row.getCell(6)));
      if (!day || amount <= 0) return;
      const rec = { day, time: str(row, 3) || '00:00', type: str(row, 4).toLowerCase().indexOf('sa') === 0 ? 'saida' : 'entrada', category: str(row, 5), amount, method: str(row, 7) || 'Numerário', ref: str(row, 8), notes: str(row, 9), auto: false, ts: Date.now(), updatedAt: Date.now() };
      let m = (iid && cashMoves.find(x => x.id === iid)) || null;
      if (m) Object.assign(m, rec);
      else { m = { id: iid || uid(), createdAt: Date.now(), ...rec }; cashMoves.push(m); }
      pushQueue({ type: 'cashmove', payload: { ...m } });
    });
    const wkx2 = wb.getWorksheet('Kardex');
    if (wkx2) wkx2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), name = str(row, 2).toUpperCase(), date = xlsDate(row.getCell(3));
      if (!iid || !name || !date) return;
      if (movements.some(x => x.id === iid)) return;
      const mv = { id: iid, name, date, type: str(row, 4).toLowerCase().indexOf('sa') === 0 ? 'saida' : 'entrada', qty: toNum(xlsVal(row.getCell(5))), after: toNum(xlsVal(row.getCell(6))), ref: str(row, 7), reason: str(row, 8), ts: Date.now() };
      movements.push(mv);
      pushQueue({ type: 'move', payload: { ...mv } });
    });
    const wr2 = wb.getWorksheet('Recibos');
    if (wr2) wr2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), date = xlsDate(row.getCell(3)), num = str(row, 4);
      if (!iid || !num || !date) return;
      if (receipts.some(x => x.id === iid)) return;
      const allocations = String(xlsVal(row.getCell(7)) || '').split(';').map(s2 => {
        const mm = s2.trim().match(/^(.*?):([\d.,]+)$/);
        if (!mm) return null;
        const sn = mm[1].trim(), sv = sales.find(x => (x.number || '') === sn);
        return { saleId: sv ? sv.id : null, number: sn, amount: toNum(mm[2]) };
      }).filter(Boolean);
      receipts.push({ id: iid, client: str(row, 2), date, number: num, total: toNum(xlsVal(row.getCell(5))), method: str(row, 6), allocations, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
      pushQueue({ type: 'receipt', payload: { ...receipts[receipts.length - 1] } });
    });
    const wn2 = wb.getWorksheet('NotasCredito');
    if (wn2) wn2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), date = xlsDate(row.getCell(3)), num = str(row, 4);
      if (!iid || !num || !date) return;
      if (ncs.some(x => x.id === iid)) return;
      const descs = String(xlsVal(row.getCell(7)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(8)) ?? '').split('\n');
      const items = [];
      const m3 = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m3; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit: qq.unit, price, total: qq.qty * price });
      }
      const sv = sales.find(x => (x.number || '') === str(row, 5));
      ncs.push({ id: iid, number: num, saleId: sv ? sv.id : null, clientId: null, client: str(row, 2), date, items, total: toNum(xlsVal(row.getCell(9))), motive: str(row, 10), ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
      pushQueue({ type: 'nc', payload: { ...ncs[ncs.length - 1] } });
    });
    const wo2 = wb.getWorksheet('OrdensCompra');
    if (wo2) wo2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), date = xlsDate(row.getCell(3)), num = str(row, 4);
      if (!iid || !num || !date) return;
      if (porders.some(x => x.id === iid)) return;
      const nm = str(row, 2);
      let supId = null;
      const s = suppliers.find(x => (x.name || '').toLowerCase() === nm.toLowerCase());
      if (s) supId = s.id;
      if (!supId) return;
      const descs = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(5)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(7)) ?? '').split('\n');
      const items = [];
      const m4 = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m4; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit: qq.unit, price, total: qq.qty * price });
      }
      porders.push({ id: iid, supplierId: supId, number: num, date, items, total: items.reduce((a, p) => a + p.total, 0), status: str(row, 8) || 'Pendente', notes: str(row, 9), createdAt: Date.now(), updatedAt: Date.now() });
      pushQueue({ type: 'porder', payload: { ...porders[porders.length - 1] } });
    });
    const wd2 = wb.getWorksheet('DevFornecedor');
    if (wd2) wd2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), date = xlsDate(row.getCell(3)), num = str(row, 4);
      if (!iid || !num || !date) return;
      if (supReturns.some(x => x.id === iid)) return;
      const nm = str(row, 2);
      const s = suppliers.find(x => (x.name || '').toLowerCase() === nm.toLowerCase());
      if (!s) return;
      const descs = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(5)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(7)) ?? '').split('\n');
      const items = [];
      const m5 = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m5; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit: qq.unit, price, total: qq.qty * price });
      }
      supReturns.push({ id: iid, supplierId: s.id, number: num, date, items, total: toNum(xlsVal(row.getCell(8))), motive: str(row, 9), ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
      pushQueue({ type: 'supreturn', payload: { ...supReturns[supReturns.length - 1] } });
    });
    const wt2 = wb.getWorksheet('Transferencias');
    if (wt2) wt2.eachRow((row, n) => {
      if (n <= 1) return;
      const iid = str(row, 1), name = str(row, 2).toUpperCase(), date = xlsDate(row.getCell(3));
      const qty = toNum(xlsVal(row.getCell(5)));
      if (!iid || !name || !date || qty <= 0) return;
      if (transfers.some(x => x.id === iid)) return;
      const from = str(row, 6).toLowerCase().indexOf('arm') === 0 ? 'armazem' : 'loja';
      const to = str(row, 7).toLowerCase().indexOf('arm') === 0 ? 'armazem' : 'loja';
      if (from === to) return;
      const t = { id: iid, number: str(row, 4), date, productId: null, name, unit: '', qty, from, to, notes: str(row, 8), ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
      const s = stock.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
      if (s) {
        t.productId = s.id; t.unit = s.unit || '';
        if (from === 'armazem') { s.qArm = Math.max(0, (Number(s.qArm) || 0) - qty); s.qLoja = (Number(s.qLoja) || 0) + qty; }
        else { s.qLoja = Math.max(0, (Number(s.qLoja) || 0) - qty); s.qArm = (Number(s.qArm) || 0) + qty; }
        s.updatedAt = Date.now();
        pushQueue({ type: 'stock', payload: { ...s } });
      }
      transfers.push(t); pushQueue({ type: 'transfer', payload: { ...t } });
    });
    dedupeStock(true);
    persist(); renderAll(); if (currentSup) renderDetail();
    toast('Importação completa: ' + (supNew + supUpd) + ' fornecedores (' + supNew + ' novos), ' + (invNew + invUpd) + ' faturas (' + invNew + ' novas).', 'success');
  } catch (err) { toast('Falha ao importar: ' + (err && err.message), 'error'); }
};
/* ---------- importar Excel (mesmo formato do export) ---------- */
const xlsVal = (c) => { const v = c && c.value; if (v && typeof v === 'object' && 'result' in v) return v.result; return v; };
const toNum = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim(); if (!s) return 0;
  if (s.indexOf('.') !== -1 && s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};
const splitQty = (v) => {
  const s = String(v ?? '').trim();
  const qty = toNum(s);
  const unit = s.replace(/^[\d\s.,\-]+/, '').trim().toUpperCase().slice(0, 6);
  return { qty, unit };
};
const xlsDate = (c) => {
  const v = xlsVal(c);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
};
$('btnXlsImp').onclick = () => { if (currentSup) $('fileXls').click(); };
$('fileXls').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f || !currentSup) return;
  try {
    const buf = await f.arrayBuffer();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Historico') || wb.worksheets[0];
    if (!ws) throw new Error('Folha "Historico" não encontrada.');
    const existing = new Set(invoicesFor(currentSup.id).map(i => (i.number || '').toLowerCase()));
    let added = 0, skipped = 0;
    ws.eachRow((row, n) => {
      if (n <= 2) return; // título + cabeçalho
      const num = String(xlsVal(row.getCell(2)) || '').trim();
      const date = xlsDate(row.getCell(1));
      if (!num || !date || xlsVal(row.getCell(7)) === 'TOTAIS:') return; // ignora linhas vazias/totais
      if (existing.has(num.toLowerCase())) { skipped++; return; }
      const descs = String(xlsVal(row.getCell(5)) ?? '').split('\n');
      const qtys = String(xlsVal(row.getCell(4)) ?? '').split('\n');
      const prices = String(xlsVal(row.getCell(6)) ?? '').split('\n');
      const items = [];
      const m = Math.max(descs.length, qtys.length, prices.length);
      for (let i = 0; i < m; i++) {
        const desc = (descs[i] || '').trim().toUpperCase(), qq = splitQty(qtys[i]), price = toNum(prices[i]);
        if (desc || qq.qty || price) items.push({ desc, qty: qq.qty, unit: qq.unit, price, total: qq.qty * price });
      }
      if (!items.length) return;
      const total = items.reduce((s, p) => s + p.total, 0);
      const paid = Math.max((toNum(xlsVal(row.getCell(9))) - toNum(xlsVal(row.getCell(11)))) || 0, 0);
      const inv = { id: uid(), supplierId: currentSup.id, date, number: num, items, total, paid, payMethod: String(xlsVal(row.getCell(10)) || 'Numerário'), notes: String(xlsVal(row.getCell(12)) || ''), createdAt: Date.now(), updatedAt: Date.now() };
      if (!payMethods.includes(inv.payMethod)) { payMethods.push(inv.payMethod); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); }
      let uCh = false;
      inv.items.forEach(p => { if (p.unit && !units.includes(p.unit)) { units.push(p.unit); uCh = true; } });
      if (uCh) pushQueue({ type: 'settings', payload: { key: 'units', list: units } });
      invoices.push(inv); pushQueue({ type: 'invoice', payload: inv }); stockApply(inv.items, +1, true, inv.number, 'armazem'); existing.add(num.toLowerCase()); added++;
    });
    persist(); renderAll(); renderDetail();
    toast(added + ' fatura(s) importada(s)' + (skipped ? ', ' + skipped + ' ignorada(s) (números já existentes).' : '.'), added ? 'success' : 'warning');
  } catch (err) { toast('Falha ao importar: ' + (err && err.message), 'error'); }
};

/* ---------- pagamentos: pendências por fatura ---------- */
let currentPaySup = null, payInvId = null;
function supInvExtra(invId) { return supPayments.filter(p => p.invoiceId === invId && !p.initial).reduce((s, p) => s + (Number(p.amount) || 0), 0); }
/* Crédito disponível no fornecedor antes desta fatura (ex.: pagamento a mais numa fatura anterior) */
function supCreditBefore(inv, row) {
  if (!row) row = withBalances(inv.supplierId).find(r => r.id === inv.id);
  return row ? Math.max(0, -(Number(row.oldBalance) || 0)) : 0;
}
function supInvRemaining(inv, row) {
  const own = Math.max(0, (Number(inv.total) || 0) - (Number(inv.paid) || 0) - supInvExtra(inv.id));
  return Math.max(0, own - supCreditBefore(inv, row));
}
/* Fatura está coberta (paga) quando não falta nada */
const supInvPaid = (inv, row) => supInvRemaining(inv, row) <= 0;
function renderPays() {
  const q = (($('searchPaySup').value || '').toLowerCase()), tb = $('paySupTable').querySelector('tbody');
  tb.innerHTML = '';
  const list = suppliers.filter(s => supEffective(s.id) > 0 && (!q || (s.name || '').toLowerCase().includes(q))).sort((a, b) => supEffective(b.id) - supEffective(a.id));
  const dc = $('payDebtCount'); if (dc) dc.textContent = list.length ? '(' + list.length + ')' : '';
  list.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${esc(s.name)}</strong></td><td style="text-align:right"><strong>${MZN(supEffective(s.id))}</strong></td><td><button class="btn small">Ver pendências →</button></td>`;
    tr.querySelector('button').onclick = (e) => { e.stopPropagation(); openPays(s.id); };
    tr.onclick = () => openPays(s.id);
    tr.style.cursor = 'pointer';
    tb.appendChild(tr);
  });
  renderPayMoves();
  renderExpenses();
  renderFinances();
  renderRend();
}
/* ---------- separadores de Pagamentos: Pagamentos · Despesas · Movimentos · Finanças ---------- */
let payTab = 'pag';
const PAY_TAB_IDS = { pag: 'payTabPag', desp: 'payTabDesp', mov: 'payTabMov', fin: 'payTabFin', rend: 'payTabRend' };
function setPayTab(t) {
  if (!PAY_TAB_IDS[t]) t = 'pag';
  payTab = t;
  document.querySelectorAll('#payTabs button').forEach(b => b.classList.toggle('active', b.dataset.pt === t));
  Object.keys(PAY_TAB_IDS).forEach(k => { const el = $(PAY_TAB_IDS[k]); if (el) el.style.display = k === t ? '' : 'none'; });
  if (t === 'desp') renderExpenses();
  else if (t === 'mov') renderPayMoves();
  else if (t === 'fin') { if ($('finMonthBox')) $('finMonthBox').open = false; renderFinances(); }
  else if (t === 'rend') renderRend();
}
if ($('payTabs')) $('payTabs').onclick = (e) => {
  const b = e.target && e.target.closest ? e.target.closest('button[data-pt]') : null;
  if (b) setPayTab(b.dataset.pt);
};
function expenseItems() {
  const q = (($('searchDesp') || {}).value || '').toLowerCase();
  return cashMoves.filter(m => !m.auto && m.type === 'saida')
    .filter(m => !q || [m.category, m.notes, m.method, m.ref].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(b.day + (b.ts || 0)).localeCompare(String(a.day + (a.ts || 0))));
}
function renderExpenses() {
  const tb = $('despTable') ? $('despTable').querySelector('tbody') : null; if (!tb) return;
  const list = expenseItems();
  tb.innerHTML = '';
  list.slice(0, 200).forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + fmtDate(m.day) + '</td><td><strong>' + esc(m.category || 'Despesa') + '</strong></td><td>' + esc(m.notes || m.ref || '—') + '</td><td>' + esc(m.method || '') + '</td>'
      + '<td style="text-align:right"><strong>' + MZN(Number(m.amount) || 0) + '</strong></td>'
      + '<td class="col-act"><button type="button" class="row-del" title="Remover despesa">' + ICO_DEL + '</button></td>';
    const del = tr.querySelector('.row-del');
    del.style.display = currentRole() === 'admin' ? '' : 'none';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!await confirmDlg('Remover despesa?', fmtDate(m.day) + ' — ' + (m.category || 'Despesa') + ' · ' + MZN(Number(m.amount) || 0))) return;
      cashMoves = cashMoves.filter(x => x.id !== m.id);
      pushQueue({ type: 'delete-cashmove', payload: { id: m.id } });
      persist(); renderAll(); toast('Despesa removida.', 'success');
    };
    tb.appendChild(tr);
  });
  if (!list.length) tb.innerHTML = '<tr><td colspan="6" class="hint">Sem despesas registadas.</td></tr>';
  const total = list.reduce((a, m) => a + (Number(m.amount) || 0), 0);
  if ($('despTotal')) $('despTotal').textContent = MZN(total);
  if ($('despN')) $('despN').textContent = String(list.length);
  if ($('despCount')) $('despCount').textContent = '(' + list.length + ')';
  const byCat = {};
  list.forEach(m => { const c = m.category || 'Despesa'; byCat[c] = (byCat[c] || 0) + (Number(m.amount) || 0); });
  const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0];
  if ($('despTop')) $('despTop').textContent = top ? top + ' (' + MZN(byCat[top]) + ')' : '—';
  renderLosses();
}
function renderFinances() {
  if (!$('finIn')) return;
  const tin = cashMoves.filter(m => m.type === 'entrada').reduce((a, m) => a + (Number(m.amount) || 0), 0);
  const tout = cashMoves.filter(m => m.type === 'saida').reduce((a, m) => a + (Number(m.amount) || 0), 0);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('finIn', MZN(tin)); set('finOut', MZN(tout)); set('finBal', MZN(tin - tout));
  set('finProfit', MZN(profitReport(sales.filter(s => saleKind(s) !== 'cotacao')).gross));
  set('finLoss', MZN(stockLosses.reduce((a, l) => a + (Number(l.total) || 0), 0)));
  set('finSales', MZN(sales.filter(s => saleKind(s) !== 'cotacao').reduce((a, s) => a + (Number(s.total) || 0), 0)));
  set('finSup', MZN(supPayments.reduce((a, p) => a + (Number(p.amount) || 0), 0)));
  set('finDesp', MZN(cashMoves.filter(m => !m.auto && m.type === 'saida').reduce((a, m) => a + (Number(m.amount) || 0), 0)));
  set('finDebt', MZN(suppliers.reduce((a, s) => a + Math.max(supEffective(s.id), 0), 0)));
  set('finCashSales', MZN(sales.filter(s => saleKind(s) === 'venda').reduce((a, s) => a + (Number(s.total) || 0), 0)));
  set('finCreditSales', MZN(sales.filter(s => saleKind(s) === 'credito').reduce((a, s) => a + (Number(s.total) || 0), 0)));
  set('finRecv', MZN(cashMoves.filter(m => m.auto && m.type === 'entrada').reduce((a, m) => a + (Number(m.amount) || 0), 0)));
  set('finRecvOpen', MZN(clients.reduce((a, c) => a + Math.max(clientBalance(c.id), 0), 0)));
  const mt = $('finMonthTable') ? $('finMonthTable').querySelector('tbody') : null;
  if (mt) {
    mt.innerHTML = '';
    const by = {};
    cashMoves.forEach(m => {
      const k = dayKey(m.day).slice(0, 7) || '—';
      by[k] = by[k] || { in: 0, out: 0 };
      if (m.type === 'entrada') by[k].in += Number(m.amount) || 0; else by[k].out += Number(m.amount) || 0;
    });
    const keys = Object.keys(by).sort().reverse();
    keys.forEach(k => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><strong>' + esc(k) + '</strong></td><td style="text-align:right">' + MZN(by[k].in) + '</td><td style="text-align:right">' + MZN(by[k].out) + '</td><td style="text-align:right"><strong>' + MZN(by[k].in - by[k].out) + '</strong></td>';
      mt.appendChild(tr);
    });
    if (!keys.length) mt.innerHTML = '<tr><td colspan="4" class="hint">Sem movimentos.</td></tr>';
  }
  const ct = $('finCatTable') ? $('finCatTable').querySelector('tbody') : null;
  if (ct) {
    ct.innerHTML = '';
    const by = {};
    cashMoves.filter(m => !m.auto && m.type === 'saida').forEach(m => {
      const c = m.category || 'Despesa';
      by[c] = by[c] || { n: 0, t: 0 }; by[c].n++; by[c].t += Number(m.amount) || 0;
    });
    const keys = Object.keys(by).sort((a, b) => by[b].t - by[a].t);
    keys.forEach(k => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(k) + '</td><td style="text-align:right">' + by[k].n + '</td><td style="text-align:right"><strong>' + MZN(by[k].t) + '</strong></td>';
      ct.appendChild(tr);
    });
    if (!keys.length) ct.innerHTML = '<tr><td colspan="3" class="hint">Sem despesas.</td></tr>';
  }
}
/* ---------- rendimento diário por produto (KPI por item) ---------- */
let rendRows = [];
const rendKey = (nm) => String(nm || '').trim().toUpperCase();
function revenueRows(day) {
  const by = {};
  const prodOf = (nm) => stock.find(x => rendKey(x.name) === rendKey(nm));
  const add = (desc, qty, total, costUnit) => {
    const k = rendKey(desc); if (!k) return;
    const p = prodOf(desc) || {};
    if (!by[k]) by[k] = { name: String(desc || '').trim(), sku: p.sku || '—', cat: p.cat || 'Sem categoria', unit: p.unit || '', qty: 0, total: 0, cost: 0 };
    by[k].qty += Number(qty) || 0;
    by[k].total += Number(total) || 0;
    by[k].cost += (Number(costUnit) || 0) * (Number(qty) || 0);
  };
  sales.filter(s => { const k = saleKind(s); return canSeeSale(s) && (k === 'venda' || k === 'credito') && dayKey(s.date) === dayKey(day); })
    .forEach(s => (s.items || []).forEach(it => {
      const p = prodOf(it.desc);
      const cu = it.cost != null ? Number(it.cost) : (p ? (Number(p.cost) || 0) : 0);
      add(it.desc, it.qty, it.total, cu);
    }));
  /* devoluções do próprio dia (notas de crédito) abatem ao rendimento */
  ncs.filter(n => dayKey(n.date) === dayKey(day) && (currentRole()==='admin' || String(n.operator||'').toLowerCase()===String(currentUser||'').toLowerCase()))
    .forEach(n => (n.items || []).forEach(it => {
      const p = prodOf(it.desc);
      const cu = p ? (Number(p.cost) || 0) : 0;
      add(it.desc, -(Number(it.qty) || 0), -(Number(it.total) || 0), cu);
    }));
  return Object.values(by).filter(r => r.qty || r.total);
}
function rendDay() {
  const el = $('rendDate');
  if (el && !el.value) el.value = todayISO();
  return (el && el.value) || todayISO();
}
function rendSorted() {
  const sort = (($('rendSort') || {}).value) || 'qty';
  return rendRows.slice().sort((a, b) => {
    if (sort === 'total') return b.total - a.total;
    if (sort === 'profit') return (b.total - b.cost) - (a.total - a.cost);
    return b.qty - a.qty;
  });
}
function renderRend() {
  const tb = $('rendTable') ? $('rendTable').querySelector('tbody') : null; if (!tb) return;
  const day = rendDay();
  rendRows = revenueRows(day);
  const sorted = rendSorted();
  const isAdmin = currentRole() === 'admin';
  tb.innerHTML = '';
  sorted.forEach(r => {
    const avg = r.qty ? r.total / r.qty : 0;
    const profit = r.total - r.cost;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + esc(r.sku || '—') + '</td><td><strong>' + esc(r.name) + '</strong></td><td>' + esc(r.cat || '—') + '</td>'
      + '<td style="text-align:right"><strong>' + esc(String(r.qty)) + '</strong></td>'
      + '<td style="text-align:right">' + MZN(avg) + '</td>'
      + '<td style="text-align:right"><strong>' + MZN(r.total) + '</strong></td>'
      + '<td class="col-cost" style="text-align:right">' + MZN(r.cost) + '</td>'
      + '<td class="col-cost" style="text-align:right"><strong>' + MZN(profit) + '</strong></td>';
    tb.appendChild(tr);
  });
  if (!sorted.length) tb.innerHTML = '<tr><td colspan="' + (isAdmin ? 8 : 6) + '" class="hint">Sem vendas neste dia.</td></tr>';
  const tq = rendRows.reduce((a, r) => a + r.qty, 0);
  const tf = rendRows.reduce((a, r) => a + r.total, 0);
  const tc = rendRows.reduce((a, r) => a + r.cost, 0);
  if ($('rendTotal')) $('rendTotal').textContent = MZN(tf);
  if ($('rendQty')) $('rendQty').textContent = String(tq);
  if ($('rendN')) $('rendN').textContent = String(rendRows.length);
  if ($('rendProfit')) $('rendProfit').textContent = MZN(tf - tc);
  if ($('rendProfitKpi')) $('rendProfitKpi').style.display = isAdmin ? '' : 'none';
  const tab = $('rendTable');
  if (tab) tab.querySelectorAll('th.col-cost').forEach(th => { th.style.display = isAdmin ? '' : 'none'; });
  tb.querySelectorAll('td.col-cost').forEach(td => { td.style.display = isAdmin ? '' : 'none'; });
  if ($('rendHint')) $('rendHint').textContent = isAdmin
    ? 'Custo e lucro calculados com o custo atual de cada produto. Notas de crédito do dia são abatidas.'
    : 'Apenas quantidades e faturação (custos reservados ao administrador).';
}
async function rendXls() {
  const day = rendDay();
  rendRows = revenueRows(day);
  if (!rendRows.length) return toast('Sem vendas nesse dia.', 'warning');
  if (typeof ExcelJS === 'undefined') return toast('Exportação Excel não disponível.', 'error');
  const isAdmin = currentRole() === 'admin';
  const thin = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rendimento');
  ws.columns = [{ width: 14 }, { width: 34 }, { width: 20 }, { width: 10 }, { width: 16 }, { width: 18 }, { width: 16 }, { width: 16 }];
  const t = ws.addRow(['Rendimento por produto — ' + fmtDate(day)]); t.font = { bold: true, size: 13 };
  ws.mergeCells('A1:H1');
  const head = ws.addRow(isAdmin
    ? ['SKU', 'Produto', 'Categoria', 'Qtd', 'Preço Médio', 'Total Faturado', 'Custo', 'Lucro Bruto']
    : ['SKU', 'Produto', 'Categoria', 'Qtd', 'Preço Médio', 'Total Faturado']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; c.border = thin; });
  rendSorted().forEach(r => {
    const row = ws.addRow(isAdmin
      ? [r.sku || '—', r.name, r.cat || '—', r.qty, (r.qty ? r.total / r.qty : 0), r.total, r.cost, r.total - r.cost]
      : [r.sku || '—', r.name, r.cat || '—', r.qty, (r.qty ? r.total / r.qty : 0), r.total]);
    row.eachCell(c => { c.border = thin; });
    [5, 6, 7, 8].forEach(ix => { const c = row.getCell(ix); if (c) c.numFmt = '#,##0.00'; });
  });
  const tq = rendRows.reduce((a, r) => a + r.qty, 0), tf = rendRows.reduce((a, r) => a + r.total, 0), tc = rendRows.reduce((a, r) => a + r.cost, 0);
  const foot = ws.addRow(isAdmin ? ['', 'TOTAL', '', tq, '', tf, tc, tf - tc] : ['', 'TOTAL', '', tq, '', tf]);
  foot.font = { bold: true };
  foot.eachCell(c => { c.border = thin; });
  const buf = await wb.xlsx.writeBuffer();
  dl(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'rendimento_' + day + '.xlsx');
}

function rendPdf() {
  const day = rendDay();
  rendRows = revenueRows(day);
  if (!rendRows.length) return toast('Sem vendas nesse dia.', 'warning');
  if (!window.jspdf || !window.jspdf.jsPDF) return toast('Gerador de PDF não disponível.', 'error');
  const isAdmin = currentRole() === 'admin';
  const doc = docNew();
  const tq = rendRows.reduce((a, r) => a + r.qty, 0), tf = rendRows.reduce((a, r) => a + r.total, 0), tc = rendRows.reduce((a, r) => a + r.cost, 0);
  let y = docHeader(doc, 'RENDIMENTO POR PRODUTO', 'Faturação diária — ' + fmtDate(day), pdfNow(), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Emitido por', lines: [userNameOf(currentUser), isAdmin ? 'Administrador' : 'Operador', 'Data: ' + pdfNow()] },
    { title: 'Resumo do dia', lines: [rendRows.length + ' produto(s) faturado(s)', 'Unidades: ' + tq, 'Faturação: ' + MZN(tf), isAdmin ? 'Lucro bruto: ' + MZN(tf - tc) : ''] }
  ]);
  const body = rendSorted().map(r => isAdmin
    ? [r.sku || '—', r.name, r.cat || '—', String(r.qty), MZN(r.qty ? r.total / r.qty : 0), MZN(r.total), MZN(r.cost), MZN(r.total - r.cost)]
    : [r.sku || '—', r.name, r.cat || '—', String(r.qty), MZN(r.qty ? r.total / r.qty : 0), MZN(r.total)]);
  y = docItems(doc, y, {
    styles: Object.assign({}, TBL.styles, { fontSize: 8 }),
    head: [isAdmin
      ? ['SKU', 'Produto', 'Categoria', 'Qtd', 'Preço Médio', 'Total Faturado', 'Custo', 'Lucro']
      : ['SKU', 'Produto', 'Categoria', 'Qtd', 'Preço Médio', 'Total Faturado']],
    body,
    columnStyles: isAdmin
      ? { 0: { cellWidth: 17 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 26 }, 3: { halign: 'right', cellWidth: 13 }, 4: { halign: 'right', cellWidth: 22 }, 5: { halign: 'right', cellWidth: 24, fontStyle: 'bold' }, 6: { halign: 'right', cellWidth: 20 }, 7: { halign: 'right', cellWidth: 20, fontStyle: 'bold' } }
      : { 0: { cellWidth: 20 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 32 }, 3: { halign: 'right', cellWidth: 16 }, 4: { halign: 'right', cellWidth: 26 }, 5: { halign: 'right', cellWidth: 28, fontStyle: 'bold' } },
    foot: [[{ content: 'Faturação do dia: ' + MZN(tf) + '   ·   Unidades: ' + tq, colSpan: isAdmin ? 8 : 6, styles: { halign: 'right', fontStyle: 'bold' } }]],
    didDrawPage: docFootSetup(doc, '', 'Rendimento por produto')
  });
  y = docTotals(doc, y + 3, [
    { label: 'FATURAÇÃO DO DIA', value: MZN(tf), color: COK },
    ...(isAdmin ? [{ label: 'LUCRO BRUTO', value: MZN(tf - tc), big: true, rule: true, color: tf - tc >= 0 ? COK : CBAD }] : [])
  ]);
  docSignatures(doc, 'O Responsável', 'A Direção');
  pdfSave(doc, 'rendimento_' + day);
}
if ($('rendDate')) { $('rendDate').onchange = renderRend; }
if ($('rendSort')) { $('rendSort').onchange = renderRend; }
if ($('btnRendXls')) $('btnRendXls').onclick = () => rendXls();
if ($('btnRendPdf')) $('btnRendPdf').onclick = () => rendPdf();
if ($('searchDesp')) $('searchDesp').oninput = renderExpenses;
if ($('btnNewDesp')) $('btnNewDesp').onclick = () => openMov('despesa');
$('searchPaySup').oninput = renderPays;
function openPays(id) {
  currentPaySup = suppliers.find(s => s.id === id); if (!currentPaySup) return;
  $('paySupList').style.display = 'none';
  $('payDetail').style.display = 'block';
  renderPayDetail(); renderPays();
}
$('btnBackPay').onclick = () => { currentPaySup = null; $('payDetail').style.display = 'none'; $('paySupList').style.display = 'block'; renderPays(); };
function renderPayDetail() {
  const s = currentPaySup; if (!s) return;
  $('paySupName').textContent = s.name;
  $('paySupDebt').textContent = 'Em dívida: ' + MZN(supEffective(s.id));
  const tb = $('payInvTable').querySelector('tbody'); tb.innerHTML = '';
  const rows = withBalances(s.id);
  const pend = rows.filter(r => supInvRemaining(r, r) > 0);
  // faturas cobertas pelo crédito que sobrou de pagamentos anteriores aparecem como PAGAS
  const covered = rows.filter(r => supInvRemaining(r, r) <= 0 && Math.max(0, -(Number(r.oldBalance) || 0)) > 0);
  const renderRow = (r, coveredByCredit) => {
    const extra = supInvExtra(r.id), falta = supInvRemaining(r, r);
    const tr = document.createElement('tr');
    if (coveredByCredit) tr.className = 'inv-paid';
    tr.innerHTML = `<td>${fmtDate(r.date)}</td><td>${esc(r.number)}</td><td style="text-align:right">${MZN(r.total)}</td><td style="text-align:right">${MZN(r.paid)}</td><td style="text-align:right">${MZN(extra)}</td><td style="text-align:right"><strong>${MZN(falta)}</strong></td>`
      + `<td>${falta > 0 ? '<span class="det-badge bad">Pendente</span>' : (coveredByCredit ? '<span class="det-badge ok">Pago (crédito)</span>' : '<span class="det-badge ok">Pago</span>')}</td>`
      + `<td class="col-act">${falta > 0 ? '<button type="button" class="btn small pay" title="Pagar esta fatura">Pagar</button> ' : ''}<button type="button" class="row-edit pdf" title="PDF">${ICO_PDF}</button></td>`;
    tr.style.cursor = 'pointer';
    tr.onclick = () => { document.querySelectorAll('#payInvTable tbody tr').forEach(x => x.classList.remove('active')); tr.classList.add('active'); openInvView(r.id); };
    const payB = tr.querySelector('.pay');
    if (payB) payB.onclick = (e) => { e.stopPropagation(); openPayInv(r.id); };
    tr.querySelector('.pdf').onclick = (e) => { e.stopPropagation(); supInvPdf(s, r); };
    tb.appendChild(tr);
  };
  pend.forEach(r => renderRow(r, false));
  covered.slice(0, 12).forEach(r => renderRow(r, true));
  if (!pend.length && !covered.length) tb.innerHTML = '<tr><td colspan="8" class="hint">Sem pendências.</td></tr>';
}
function openPayInv(invId) {
  const inv = invoices.find(i => i.id === invId); if (!inv) return;
  payInvId = invId;
  const falta = supInvRemaining(inv);
  $('payInvInfo').textContent = inv.number + ' — em falta: ' + MZN(falta) + '  •  Total: ' + MZN(inv.total);
  $('piDate').value = fmtDate(todayISO()); $('piAmount').value = fmtMoney(falta); $('piMethod').value = lastPayMethod() || 'Numerário'; $('piNotes').value = '';
  $('payInvModal').style.display = 'flex';
  setTimeout(() => { if ($('piAmount')) $('piAmount').select(); }, 50);
}
$('btnCancelPayInv').onclick = () => { $('payInvModal').style.display = 'none'; };
$('btnSavePayInv').onclick = () => {
  const inv = invoices.find(i => i.id === payInvId); if (!inv) return;
  const date = parseBRDate($('piDate').value);
  if (!date) return toast('Data inválida. Use o formato DD-MM-AAAA.', 'warning');
  const falta = supInvRemaining(inv);
  let amount = parseMoney($('piAmount').value);
  if (amount <= 0) return toast('Indique o valor.', 'warning');
  if (amount > falta) amount = falta;
  const sup = suppliers.find(x => x.id === inv.supplierId);
  const method = $('piMethod').value.trim() || 'Numerário';
  if (!payMethods.includes(method)) { payMethods.push(method); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); renderPayUnits(); }
  const p = { id: uid(), supplierId: inv.supplierId, invoiceId: inv.id, number: nextSupPayNumber(), date, amount, method, notes: $('piNotes').value.trim(), ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  supPayments.push(p); pushQueue({ type: 'suppay', payload: { ...p } });
  cashAdd(date, 'saida', 'Pagamento a fornecedor', amount, method, p.number, (sup ? sup.name : '') + ' — ' + inv.number, true);
  $('payInvModal').style.display = 'none';
  persist(); renderAll(); renderPayDetail();
  toast(falta - amount <= 0 ? 'Fatura ' + inv.number + ' zerada! ✓' : 'Pagamento de ' + MZN(amount) + ' registado.', 'success');
};
function openInvView(invId) {
  const inv = invoices.find(i => i.id === invId); if (!inv) return;
  const sup = suppliers.find(x => x.id === inv.supplierId) || {};
  const row = withBalances(inv.supplierId).find(r => r.id === inv.id);
  const credit = supCreditBefore(inv, row), falta = supInvRemaining(inv, row);
  $('invViewTitle').textContent = 'Fatura ' + inv.number;
  $('invViewBody').innerHTML = `<p><strong>${esc(sup.name || '')}</strong> `
    + (falta <= 0 ? '<span class="det-badge ok">Paga</span>' : '<span class="det-badge bad">Pendente</span>')
    + `<br><span class="hint">${esc(sup.phone || '')} · ${esc(sup.email || '')}</span></p>`
    + `<p class="hint">Data: ${fmtDate(inv.date)} · Pagamento: ${esc(inv.payMethod || '')}${credit > 0 ? ' · Crédito anterior aplicado: ' + MZN(credit) : ''}</p>`
    + `<table><thead><tr><th>Qtd</th><th>Produto</th><th>Preço</th><th>Total</th></tr></thead><tbody>`
    + inv.items.map(p => `<tr><td class="n">${esc(fmtQty(p))}</td><td>${esc(p.desc)}</td><td class="n">${MZN(p.price)}</td><td class="n">${MZN(p.total)}</td></tr>`).join('')
    + `</tbody></table>`
    + `<p style="text-align:right">Total: <strong>${MZN(inv.total)}</strong><br>Pago (registo): ${MZN(inv.paid)}<br>Pagamentos: ${MZN(supInvExtra(inv.id))}${credit > 0 ? '<br>Crédito aplicado: ' + MZN(credit) : ''}<br>Em falta: <strong>${MZN(falta)}</strong></p>`;
  $('invViewModal').dataset.invid = invId;
  $('invViewModal').style.display = 'flex';
}
$('btnCloseInfo').onclick = () => { closeInfo(); };
if ($('btnPdfInfo')) $('btnPdfInfo').onclick = () => {
  const s = sales.find(x => x.id === $('infoModal').dataset.saleId);
  if (s) salePdf(s, saleCopyCount);
};
$('btnPrintInfo').onclick = () => {
  const sale = sales.find(s => s.id === $('infoModal').dataset.saleId);
  if (sale) return printSaleDocument(sale, saleCopyCount);
  printDocumentHtml('<h2>' + esc($('infoTitle').textContent) + '</h2>' + $('infoBody').innerHTML);
};
$('btnCloseInvView').onclick = () => { $('invViewModal').style.display = 'none'; };
$('btnPrintInvView').onclick = () => {
  const inv = invoices.find(i => i.id === $('invViewModal').dataset.invid); if (!inv) return;
  printDocumentHtml('<h2>Fatura ' + esc(inv.number) + '</h2>' + $('invViewBody').innerHTML);
};
$('btnPdfInvView').onclick = () => {
  const inv = invoices.find(i => i.id === $('invViewModal').dataset.invid); if (!inv) return;
  const sup = suppliers.find(x => x.id === inv.supplierId) || {};
  supInvPdf(sup, inv);
};
function pagPdf(p) {
  const doc = docNew();
  const sup = suppliers.find(x => x.id === p.supplierId) || {};
  const inv = (p.invoiceId && invoices.find(i => i.id === p.invoiceId)) || null;
  let y = docHeader(doc, 'RECIBO DE PAGAMENTO (PAG)', p.number, fmtDate(p.date), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Beneficiário', lines: [
      String(sup.name || '—'),
      sup.nuit ? 'NUIT: ' + sup.nuit : '',
      sup.bank ? 'Conta bancária: ' + sup.bank : '',
      sup.phone ? 'Contacto: ' + sup.phone : ''
    ] },
    { title: 'Detalhes do pagamento', lines: [
      'Data: ' + fmtDate(p.date),
      'Via: ' + (p.method || '—'),
      'Fatura: ' + (inv ? inv.number + '  (' + MZN(inv.total) + ')' : 'Pagamento geral'),
      'Operador: ' + userNameOf(p.operator || currentUser)
    ] }
  ]);
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 10 },
      1: { cellWidth: 'auto' },
      2: { halign: 'right', cellWidth: 34, fontStyle: 'bold' }
    },
    head: [['#', 'Descrição', 'Valor (MT)']],
    body: [[1, 'Pagamento ' + p.number + (inv ? '   ·   Fatura ' + inv.number : ''), MZN(p.amount)]],
    didDrawPage: docFootSetup(doc, '', p.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL PAGO', value: MZN(p.amount), big: true, color: COK }
  ]);
  y = docNotes(doc, y, 'Observações', [
    p.notes ? 'Notas: ' + p.notes : 'Pagamento registado no saldo do fornecedor e na caixa do dia.',
    'O presente comprovativo serve de quitação do valor acima indicado.'
  ]);
  docSignatures(doc, 'O Fornecedor', 'O Responsável');
  pdfSave(doc, safeName(p.number));
}
function supInvPdf(sup, inv) {
  const row = withBalances(inv.supplierId).find(r => r.id === inv.id);
  const extra = supInvExtra(inv.id), falta = supInvRemaining(inv, row), credit = supCreditBefore(inv, row);
  const doc = docNew();
  let y = docHeader(doc, 'FATURA DE COMPRA (FC)', inv.number, fmtDate(inv.date), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Fornecedor', lines: [
      String((sup || {}).name || '—'),
      (sup || {}).nuit ? 'NUIT: ' + sup.nuit : '',
      (sup || {}).bank ? 'Conta bancária: ' + sup.bank : '',
      (sup || {}).phone || ''
    ] },
    { title: 'Detalhes do documento', lines: [
      'Emissão: ' + fmtDate(inv.date),
      'Local de entrada: ' + (inv.loc === 'loja' ? 'Loja' : 'Armazém'),
      'Forma de pagamento: ' + (inv.payMethod || '—'),
      'Estado: ' + (falta <= 0 ? 'PAGA' : 'PENDENTE')
    ] }
  ]);
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { halign: 'center', cellWidth: 16, fontStyle: 'bold' },
      2: { halign: 'center', cellWidth: 12, textColor: CMUT, fontSize: 7.8 },
      3: { cellWidth: 'auto' },
      4: { halign: 'right', cellWidth: 26 },
      5: { halign: 'right', cellWidth: 26, fontStyle: 'bold' }
    },
    head: [['#', 'Qtd', 'Un.', 'Designação do Produto', 'Preço Unit. (MT)', 'Total (MT)']],
    body: inv.items.map((p, ix) => [ix + 1, fmtQty(p), p.unit || '', p.desc, MZN(p.price), MZN(p.total)]),
    didDrawPage: docFootSetup(doc, '', inv.number)
  });
  const estado = [];
  estado.push({ label: 'TOTAL DA FATURA', value: MZN(inv.total), big: true, rule: true });
  estado.push({ label: 'PAGO (REGISTO)', value: MZN(inv.paid) });
  estado.push({ label: 'PAGAMENTOS (PAG)', value: MZN(extra) });
  if (credit > 0) estado.push({ label: 'CRÉDITO APLICADO', value: MZN(credit), color: COK });
  estado.push({ label: 'EM FALTA', value: MZN(falta), color: falta > 0 ? CBAD : COK });
  y = docTotals(doc, y + 3, estado);
  y = docBanner(doc, y, falta <= 0 ? 'ESTADO: PAGA — não existe saldo em falta nesta fatura.' : 'ESTADO: PENDENTE — falta liquidar ' + MZN(falta) + '.', falta <= 0 ? 'ok' : 'bad');
  pdfSave(doc, safeName(inv.number));
}

/* ---------- PDFs de fornecedor: OC (encomenda) e ND (devolução) ---------- */
function ocPdf(o) {
  const sup = suppliers.find(x => x.id === o.supplierId) || {};
  const doc = docNew();
  let y = docHeader(doc, 'ORDEM DE COMPRA (OC)', o.number, fmtDate(o.date), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Fornecedor', lines: [
      String(sup.name || '—'),
      sup.nuit ? 'NUIT: ' + sup.nuit : '',
      sup.phone ? 'Contacto: ' + sup.phone : '',
      sup.address || ''
    ] },
    { title: 'Detalhes da encomenda', lines: [
      'Emissão: ' + fmtDate(o.date),
      'Estado: ' + (o.status || 'Pendente'),
      'Operador: ' + userNameOf(currentUser),
      o.notes ? 'Notas: ' + o.notes : 'Notas: —'
    ] }
  ]);
  y = docBanner(doc, y, 'Documento de encomenda — não serve de fatura nem constitui dívida enquanto não for recebida.', ACCENT);
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { halign: 'center', cellWidth: 16, fontStyle: 'bold' },
      2: { halign: 'center', cellWidth: 12, textColor: CMUT, fontSize: 7.8 },
      3: { cellWidth: 'auto' },
      4: { halign: 'right', cellWidth: 26 },
      5: { halign: 'right', cellWidth: 26, fontStyle: 'bold' }
    },
    head: [['#', 'Qtd', 'Un.', 'Designação do Produto', 'Preço Unit. (MT)', 'Total (MT)']],
    body: (o.items || []).map((p, ix) => [ix + 1, fmtQty(p), p.unit || '', p.desc, MZN(p.price), MZN(p.total)]),
    didDrawPage: docFootSetup(doc, '', o.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DA ENCOMENDA', value: MZN(o.total), big: true, color: CORP }
  ]);
  y = docNotes(doc, y, 'Condições', [
    'Prazo de entrega e preços a confirmar pelo fornecedor.',
    'A mercadoria será recebida no Armazém e a fatura lançada na conta corrente do fornecedor.'
  ]);
  docSignatures(doc, 'Elaborado por', 'Aceitação do Fornecedor');
  pdfSave(doc, safeName(o.number));
}
function ndPdf(r) {
  const sup = suppliers.find(x => x.id === r.supplierId) || {};
  const doc = docNew();
  docStamp(doc, 'DEVOLUÇÃO');
  let y = docHeader(doc, 'DEVOLUÇÃO / NOTA DE DÉBITO (ND)', r.number, fmtDate(r.date), pdfTimeNow());
  y = docMeta(doc, y, [
    { title: 'Fornecedor', lines: [
      String(sup.name || '—'),
      sup.nuit ? 'NUIT: ' + sup.nuit : '',
      sup.phone ? 'Contacto: ' + sup.phone : ''
    ] },
    { title: 'Detalhes da devolução', lines: [
      'Data: ' + fmtDate(r.date),
      'Motivo: ' + (r.motive || '—'),
      'Operador: ' + userNameOf(r.operator || currentUser)
    ] }
  ]);
  y = docBanner(doc, y, 'Devolução de mercadoria — reduz o stock e abate a dívida ao fornecedor.', 'warn');
  y = docItems(doc, y, {
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { halign: 'center', cellWidth: 16, fontStyle: 'bold' },
      2: { halign: 'center', cellWidth: 12, textColor: CMUT, fontSize: 7.8 },
      3: { cellWidth: 'auto' },
      4: { halign: 'right', cellWidth: 26 },
      5: { halign: 'right', cellWidth: 26, fontStyle: 'bold' }
    },
    head: [['#', 'Qtd', 'Un.', 'Designação do Produto', 'Preço Unit. (MT)', 'Total (MT)']],
    body: (r.items || []).map((p, ix) => [ix + 1, fmtQty(p), p.unit || '', p.desc, MZN(p.price), MZN(p.total)]),
    didDrawPage: docFootSetup(doc, '', r.number)
  });
  y = docTotals(doc, y + 3, [
    { label: 'TOTAL DEVOLVIDO', value: MZN(r.total), big: true, color: CWARN }
  ]);
  y = docNotes(doc, y, 'Observações', [
    'Mercadoria devolvida ao fornecedor; o valor é abatido ao saldo em dívida.',
    'Motivo registado: ' + (r.motive || '—') + '.'
  ]);
  docSignatures(doc, 'Entreguei (Responsável)', 'Recebi (Fornecedor)');
  pdfSave(doc, safeName(r.number));
}

/* ---------- dia financeiro (resumo em Pagamentos) ---------- */
let payMovesFilter = 'todos';
let payPeriod = 'todos';
function renderCash() {
  if ($('cashDay') && !$('cashDay').value) $('cashDay').value = todayISO();
  const day = ($('cashDay') || {}).value || todayISO();
  const t = cashTotals(day);
  const info = $('payDayInfo');
  if (info) info.textContent = 'Dia ' + fmtDate(day) + ' — ' + (t.closed ? 'FECHADO' : 'ABERTO') + ' · Troco ' + MZN(t.open) + ' · Entradas ' + MZN(t.tin) + ' · Saídas ' + MZN(t.tout) + ' · Saldo ' + MZN(t.bal);
  const debt = suppliers.reduce((s, x) => s + Math.max(supEffective(x.id), 0), 0);
  const recv = clients.reduce((s, x) => s + Math.max(clientBalance(x.id), 0), 0);
  const today = todayISO();
  let tin = 0, tout = 0;
  cashMoves.forEach(m => { if (m.day !== today) return; if (m.type === 'entrada') tin += Number(m.amount) || 0; else tout += Number(m.amount) || 0; });
  const set = (id, v) => { const el = $(id); if (el) el.textContent = MZN(v); };
  set('payKpiDebt', debt); set('payKpiRecv', recv); set('payKpiIn', tin); set('payKpiOut', tout);
  [['payKpiDebt', 'pagamentos', 'Em dívida: fornecedores por pagar'], ['payKpiRecv', 'recebimentos', 'A receber: créditos de clientes'], ['payKpiIn', 'entradas', 'Entradas de hoje'], ['payKpiOut', 'saidas', 'Saídas de hoje']].forEach(([id, f, tip]) => {
    const st = $(id); const card = st && st.closest ? st.closest('.kpi') : null;
    if (card && !card.dataset.payf) { card.dataset.payf = f; card.classList.add('kpi-click'); card.title = tip + ' — clique para filtrar'; card.onclick = () => setPayMovesFilter(payMovesFilter === f ? 'todos' : f); }
  });
  document.querySelectorAll('#payKpis .kpi').forEach(c => c.classList.toggle('active', !!c.dataset.payf && c.dataset.payf === payMovesFilter));
  try { renderPayMoves(); } catch (_) {}
}
function setPayMovesFilter(f) {
  payMovesFilter = f;
  const map = { pagamentos: 'pagamentos', recebimentos: 'recebimentos', vendas: 'vendas', despesas: 'despesas' };
  const tab = f === 'todos' ? 'todos' : (map[f] || '');
  document.querySelectorAll('#payMovesTabs button').forEach(b => b.classList.toggle('active', tab !== '' && b.dataset.pf === tab));
  document.querySelectorAll('#payKpis .kpi').forEach(c => c.classList.toggle('active', !!c.dataset.payf && c.dataset.payf === f));
  renderPayMoves();
}
/* Movimentos unificados: PAG + REC + VD/FT + despesas manuais */
function payMoveItems() {
  const out = [];
  supPayments.forEach(p => out.push({ key: 'pp:' + p.id, date: p.date, ts: p.ts || 0, type: 'PAG', doc: p.number, detail: supName(p.supplierId), amount: -(Number(p.amount) || 0), info: (p.method || '') + (p.initial ? ' · inicial' : ''), kind: 'pagamentos', pp: p }));
  const payNums = new Set(supPayments.map(p => p.number));
  cashMoves.filter(m => m.auto && m.type === 'saida' && m.category === 'Pagamento a fornecedor' && !payNums.has(m.ref)).forEach(m => {
    const inv = invoices.find(x => x.number === m.ref) || null;
    out.push({ key: 'cm:' + m.id, date: m.day, ts: m.ts || 0, type: 'PAG', doc: m.ref || '', detail: m.notes || '', amount: -(Number(m.amount) || 0), info: m.method || '', kind: 'pagamentos', pinv: inv, cm: m });
  });
  receipts.forEach(r => out.push({ key: 'rc:' + r.id, date: r.date, ts: r.ts || 0, type: 'REC', doc: r.number, detail: r.client || '', amount: Number(r.total) || 0, info: r.method || '', kind: 'recebimentos', rcp: r }));
  sales.filter(s => saleKind(s) === 'venda').forEach(s => out.push({ key: 'sd:' + s.id, date: s.date, ts: s.createdAt || 0, type: 'VD', doc: s.number, detail: s.client || 'balcão', amount: Number(s.total) || 0, info: (s.payMethod || '') + (s.operator ? ' · ' + userNameOf(s.operator) : ''), kind: 'vendas', sale: s }));
  sales.filter(s => saleKind(s) === 'credito').forEach(s => out.push({ key: 'sd:' + s.id, date: s.date, ts: s.createdAt || 0, type: 'FT', doc: s.number, detail: (s.client || '') + ' · em falta ' + MZN(saleBalance(s)), amount: Number(s.total) || 0, info: userNameOf(s.operator), kind: 'vendas', sale: s }));
  cashMoves.filter(m => !m.auto).forEach(m => out.push({ key: 'cm:' + m.id, date: m.day, ts: m.ts || 0, type: m.type === 'entrada' ? 'ENT' : 'DESP', doc: m.ref || '', detail: (m.category || '') + (m.notes ? ' · ' + m.notes : ''), amount: m.type === 'entrada' ? Number(m.amount) || 0 : -(Number(m.amount) || 0), info: m.method || '', kind: 'despesas', cmId: m.id, cm: m }));
  return out.sort((a, b) => String(b.date + (b.ts || 0)).localeCompare(String(a.date + (a.ts || 0))));
}
/* seleção em lote de movimentos (Pagamentos) */
let payMovSelected = new Set();
let payMovMap = {};
function payMovBulkUpdate() {
  const bar = $('payMovBulk');
  const n = payMovSelected.size;
  if (bar) bar.classList.toggle('show', n > 0);
  if ($('payMovSelCount')) $('payMovSelCount').textContent = n + ' selecionado(s)';
  let tin = 0, tout = 0;
  const byType = {};
  payMovSelected.forEach(k => { const it = payMovMap[k]; if (!it) return; const tn = movTypeName(it); byType[tn] = (byType[tn] || 0) + 1; if (it.amount > 0) tin += it.amount; else tout += -it.amount; });
  if ($('payMovSelInfo')) $('payMovSelInfo').textContent = n
    ? (Object.keys(byType).sort().map(t => t + ' ' + byType[t]).join(' · ') + ' | Entradas ' + MZN(tin) + ' · Saídas ' + MZN(tout) + ' · Saldo ' + MZN(tin - tout))
    : '';
  const all = $('payMovCheckAll');
  if (all) { const tot = Object.keys(payMovMap).length; all.checked = n > 0 && n >= tot; all.indeterminate = n > 0 && n < tot; }
}
async function payMovZerar() {
  if (currentRole() !== 'admin') return toast('Zerar transações: acesso Administrador.', 'error');
  if (!payMovSelected.size) return openWipeModal();
  if (!await confirmDlg('Zerar transações?', payMovSelected.size + ' movimento(s) serão apagados. Esta ação não pode ser anulada.')) return;
  const ops = [];
  let n = 0;
  [...payMovSelected].forEach(k => {
    const it = payMovMap[k]; if (!it) return;
    if (it.pp) {
      ops.push({ type: 'delete-suppay', payload: { id: it.pp.id } });
      supPayments = supPayments.filter(x => x.id !== it.pp.id);
      // remove também o movimento de caixa automático associado, se existir
      cashMoves.filter(m => m.auto && m.ref === it.pp.number).forEach(m => { ops.push({ type: 'delete-cashmove', payload: { id: m.id } }); });
      cashMoves = cashMoves.filter(m => !(m.auto && m.ref === it.pp.number));
      const inv = invoices.find(x => x.id === it.pp.invoiceId);
      if (inv && it.pp.initial && (Number(inv.paid) || 0) > 0) { inv.paid = Math.max(0, (Number(inv.paid) || 0) - (Number(it.pp.amount) || 0)); inv.updatedAt = Date.now(); ops.push({ type: 'invoice', payload: { ...inv } }); }
      n++;
    } else if (it.cm) {
      ops.push({ type: 'delete-cashmove', payload: { id: it.cm.id } });
      cashMoves = cashMoves.filter(x => x.id !== it.cm.id);
      n++;
    } else if (it.rcp) {
      const rc = it.rcp;
      (rc.allocations || []).forEach(al => {
        const s = sales.find(x => x.id === al.saleId); if (!s) return;
        s.paid = Math.max(0, (Number(s.paid) || 0) - (Number(al.amount) || 0));
        s.payments = (s.payments || []).filter(p => !(p.doc === rc.number && Number(p.amount) === Number(al.amount)));
        s.updatedAt = Date.now();
        ops.push({ type: 'sale', payload: { ...s } });
      });
      cashMoves.filter(m => m.auto && m.ref === rc.number).forEach(m => { ops.push({ type: 'delete-cashmove', payload: { id: m.id } }); });
      cashMoves = cashMoves.filter(m => !(m.auto && m.ref === rc.number));
      ops.push({ type: 'delete-receipt', payload: { id: rc.id } });
      receipts = receipts.filter(x => x.id !== rc.id);
      n++;
    } else if (it.sale) {
      const s = it.sale;
      if ((s.payments || []).some(p => p.doc && String(p.doc).indexOf('REC') === 0) || ncs.some(x => x.saleId === s.id)) { toast('Venda ' + s.number + ' tem recibos/NC — emita Nota de Crédito.', 'warning'); return; }
      ops.push({ type: 'delete-sale', payload: { id: s.id } });
      if (saleKind(s) !== 'cotacao') stockApply(s.items, +1, true, s.number, s.loc || 'loja');
      // remove o dinheiro automático da venda para o resumo financeiro não ficar com valores órfãos
      cashMoves.filter(m => m.auto && String(m.ref || '') === String(s.number)).forEach(m => { ops.push({ type: 'delete-cashmove', payload: { id: m.id } }); });
      cashMoves = cashMoves.filter(m => !(m.auto && String(m.ref || '') === String(s.number)));
      sales = sales.filter(x => x.id !== s.id);
      n++;
    }
  });
  payMovSelected.clear();
  if (ops.length) pushQueueBulk(ops);
  persist(); renderAll();
  toast(n + ' transação(ões) zeradas.', 'success');
}
/* Detalhe de um movimento (Pagamentos → Todos os Movimentos) */
let movDetailIt = null;
function movDetail(it) {
  if (!it) return;
  const L = [];
  const line = (k, v) => { if (v !== '' && v != null) L.push('<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>'); };
  line('Data', fmtDate(it.date) + (it.cm && it.cm.time ? '   ' + it.cm.time : ''));
  line('Tipo', movTypeName(it));
  line('Documento', it.doc || '—');
  line('Detalhe', it.detail || '—');
  line('Valor', MZN(Math.abs(it.amount)) + (it.amount < 0 ? '   (saída)' : '   (entrada)'));
  line('Forma', it.info || '—');
  if (it.pp) {
    line('Fornecedor', supName(it.pp.supplierId));
    const inv = invoices.find(i => i.id === it.pp.invoiceId);
    line('Fatura', inv ? inv.number + '   (' + MZN(inv.total) + ')' : 'Pagamento geral (a conta)');
    line('Notas', it.pp.notes || '—');
    line('Registado', fmtDateTime(it.pp.createdAt || it.pp.ts));
    line('Operador', userNameOf(it.pp.operator || currentUser));
  }
  if (it.pinv) { line('Fatura de compra', it.pinv.number + '   (' + MZN(it.pinv.total) + ')'); line('Fornecedor', supName(it.pinv.supplierId)); line('Estado', Number(it.pinv.paid) >= Number(it.pinv.total) ? 'Paga' : 'Pendente'); }
  if (it.rcp) {
    line('Cliente', it.rcp.client || '—');
    (it.rcp.allocations || []).forEach(a => line('Amortiza ' + a.number, MZN(a.amount)));
    line('Operador', userNameOf(it.rcp.operator || currentUser));
  }
  if (it.sale) {
    line('Cliente', it.sale.client || 'balcão');
    line('Estado', saleStatus(it.sale));
    line('Recebido', MZN(it.sale.paid));
    line('Em falta', MZN(Math.max(Number(it.sale.total) - Number(it.sale.paid), 0)));
    (it.sale.items || []).slice(0, 12).forEach(p => line(fmtQty(p), p.desc + ' — ' + MZN(p.total)));
  }
  if (it.cm) {
    line('Categoria', it.cm.category || '—');
    line('Motivo', it.cm.reason || '—');
    line('Notas', it.cm.notes || '—');
    line('Dia de caixa', fmtDate(it.cm.day));
    line('Operador', userNameOf(it.cm.operator || currentUser));
  }
  movDetailIt = it;
  const can = !!(it.sale || it.rcp || it.pp || it.pinv);
  openInfo('Movimento ' + (it.doc || movTypeName(it)), '<div class="det-items"><table>' + L.join('') + '</table></div>' +
    (can ? '<div style="margin-top:10px"><button type="button" class="btn small" id="movActs">Abrir documento</button></div>' : ''));
  const b = $('infoBody') && $('infoBody').querySelector('#movActs');
  if (b) b.onclick = () => movOpenSource();
}
function movOpenSource() {
  const it = movDetailIt; if (!it) return;
  /* Abrir diretamente o documento de origem, não apenas a lista onde ele vive. */
  if (it.sale) { closeInfo(); goViewNow('sales'); openSaleDetail(it.sale.id); return; }
  if (it.rcp) {
    const sid = it.rcp.allocations && it.rcp.allocations[0] && it.rcp.allocations[0].saleId;
    const s = sid && sales.find(x => x.id === sid);
    closeInfo();
    if (s) { goViewNow('sales'); openSaleDetail(s.id); }
    else { goViewNow('sales'); if ($('searchSale')) { $('searchSale').value = it.rcp.client || ''; try { renderSales(); } catch (_) {} } }
    return;
  }
  if (it.pp) {
    const inv = it.pp.invoiceId && invoices.find(x => x.id === it.pp.invoiceId);
    closeInfo();
    if (inv) { openInvView(inv.id); return; }
    goViewNow('pays');
    if ($('searchPaySup')) { $('searchPaySup').value = supName(it.pp.supplierId); try { renderPays(); } catch (_) {} }
    return;
  }
  if (it.pinv) { closeInfo(); openInvView(it.pinv.id); return; }
}
function payMovCsv() {
  const sel = Object.keys(payMovMap).filter(k => payMovSelected.has(k)).map(k => payMovMap[k]);
  if (!sel.length) return toast('Selecione pelo menos um movimento.', 'warning');
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = ['Data;Tipo;Doc;Detalhe;Valor;Info'];
  sel.forEach(it => lines.push([fmtDate(it.date), movTypeName(it), it.doc, it.detail, (it.amount < 0 ? '-' : '') + Math.abs(it.amount).toFixed(2), it.info].map(cell).join(';')));
  const sorted = [lines[0], ...lines.slice(1).sort()];
  dl(new Blob(['\ufeff' + sorted.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'movimentos_selecionados_' + todayISO() + '.csv');
  toast(sel.length + ' movimento(s) exportados.', 'success');
}
function renderPayMoves() {
  const tb = $('payMovesTable'); if (!tb) return;
  const bd = tb.querySelector('tbody'); bd.innerHTML = '';
  payMovMap = {};
  const q = (($('searchPayMoves') || {}).value || '').toLowerCase();
  const f = payMovesFilter;
  if ($('payPeriodDate') && !$('payPeriodDate').value) $('payPeriodDate').value = todayISO();
  const ref = (($('payPeriodDate') || {}).value || todayISO()).slice(0, 10);
  const inPeriod = (dt) => {
    const d = String(dt || '').slice(0, 10);
    if (payPeriod === 'dia') return d === ref;
    if (payPeriod === 'semana') {
      const r = new Date(ref + 'T12:00:00');
      if (isNaN(r)) return true;
      const mon = new Date(r); mon.setDate(r.getDate() - ((r.getDay() + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const f2 = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      return d >= f2(mon) && d <= f2(sun);
    }
    if (payPeriod === 'mes') return d.slice(0, 7) === ref.slice(0, 7);
    if (payPeriod === 'ano') return d.slice(0, 4) === ref.slice(0, 4);
    return true;
  };
  const match = (it) => {
    if (f === 'pagamentos') return it.kind === 'pagamentos';
    if (f === 'recebimentos') return it.kind === 'recebimentos';
    if (f === 'vendas') return it.kind === 'vendas';
    if (f === 'despesas') return it.kind === 'despesas';
    if (f === 'entradas') return it.amount > 0;
    if (f === 'saidas') return it.amount < 0;
    return true;
  };
  const list = payMoveItems().filter(match).filter(it => inPeriod(it.date)).filter(it => !q || ((it.doc + ' ' + it.detail + ' ' + it.type).toLowerCase().includes(q)));
  $('payMovesCount').textContent = '(' + list.length + ')';
  list.slice(0, 120).forEach(it => {
    payMovMap[it.key] = it;
    const tr = document.createElement('tr');
    const acts = '<button type="button" class="row-edit det" title="Ver detalhes do movimento">Ver</button>' + (it.sale ? '' : it.rcp ? ' <button type="button" class="row-edit pdf" data-k="rcp" title="Recibo PDF">PDF</button>' : it.pp ? ' <button type="button" class="row-edit pdf" data-k="pag" title="Comprovativo PDF">PDF</button>' : it.pinv ? ' <button type="button" class="row-edit pdf" data-k="pinv" title="Fatura PDF">PDF</button>' : '');
    const on = payMovSelected.has(it.key);
    if (on) tr.classList.add('active');
    tr.innerHTML = `<td class="col-sel"><input type="checkbox" class="pmov"${on ? ' checked' : ''} /></td><td>${fmtDate(it.date)}</td><td><strong>${esc(movTypeName(it))}</strong></td><td>${esc(it.doc)}</td><td>${esc(it.detail)}</td><td style="text-align:right"><strong>${(it.amount < 0 ? '−' : '') + MZN(Math.abs(it.amount))}</strong></td><td>${esc(it.info)}</td><td class="col-act">${acts}</td>`;
    tr.querySelector('.pmov').onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) payMovSelected.add(it.key); else payMovSelected.delete(it.key);
      tr.classList.toggle('active', e.target.checked);
      payMovBulkUpdate();
    };
    const det = tr.querySelector('.det');
    if (det) det.onclick = (e) => {
      e.stopPropagation();
      /* Num pagamento, «Ver» abre primeiro a fatura de origem. O detalhe do
         movimento continua acessível pelo PDF/comprovativo. */
      if (it.pp && it.pp.invoiceId) {
        const inv = invoices.find(x => x.id === it.pp.invoiceId);
        if (inv) { try { openInvView(inv.id); return; } catch (_) {} }
      }
      movDetail(it);
    };
    const pdf = tr.querySelector('.pdf');
    if (pdf) pdf.onclick = (e) => {
      e.stopPropagation();
      const k = pdf.dataset.k;
      if (k === 'sale' && it.sale) salePdf(it.sale);
      else if (k === 'rcp' && it.rcp) reciboPdfRc(it.rcp);
      else if (k === 'pag' && it.pp) pagPdf(it.pp);
      else if (k === 'pinv' && it.pinv) { const sp = suppliers.find(x => x.id === it.pinv.supplierId) || {}; supInvPdf(sp, it.pinv); }
    };
    if (it.sale) { tr.style.cursor = 'pointer'; tr.title = 'Abrir venda'; tr.onclick = () => { goViewNow('sales'); try { openSaleDetail(it.sale.id); } catch (_) { if ($('searchSale')) { $('searchSale').value = it.doc; renderSales(); } } }; }
    else if (it.rcp) {
      tr.style.cursor = 'pointer'; tr.title = 'Abrir fatura do recibo';
      tr.onclick = () => {
        const sid = it.rcp.allocations && it.rcp.allocations[0] && it.rcp.allocations[0].saleId;
        const s = sid && sales.find(x => x.id === sid);
        goViewNow('sales');
        if (s) { try { openSaleDetail(s.id); return; } catch (_) {} }
        if ($('searchSale')) { $('searchSale').value = it.rcp.client || ''; try { renderSales(); } catch (_) {} }
      };
    }
    else if (it.pp) {
      tr.style.cursor = 'pointer'; tr.title = it.pp.invoiceId ? 'Abrir a fatura que originou este pagamento' : 'Ver detalhes do movimento';
      tr.onclick = () => {
        const inv = it.pp.invoiceId && invoices.find(x => x.id === it.pp.invoiceId);
        if (inv) { try { openInvView(inv.id); return; } catch (_) {} }
        movDetail(it);
      };
    }
    else if (it.pinv) { tr.style.cursor = 'pointer'; tr.title = 'Abrir fatura de compra'; tr.onclick = () => { try { openInvView(it.pinv.id); } catch (_) { movDetail(it); } }; }
    else { tr.style.cursor = 'pointer'; tr.title = 'Ver detalhes do movimento'; tr.onclick = () => movDetail(it); }
    bd.appendChild(tr);
  });
  if (!bd.children.length) bd.innerHTML = '<tr><td colspan="8" class="hint">Sem movimentos para este filtro.</td></tr>';
  Object.keys(payMovSelected).forEach(k => { if (!payMovMap[k]) payMovSelected.delete(k); });
  payMovBulkUpdate();
}
if ($('payMovCheckAll')) $('payMovCheckAll').onclick = (e) => {
  if (e.target.checked) Object.keys(payMovMap).forEach(k => payMovSelected.add(k));
  else payMovSelected.clear();
  renderPayMoves();
};
if ($('btnPayMovClear')) $('btnPayMovClear').onclick = () => { payMovSelected.clear(); renderPayMoves(); };
if ($('btnPayMovZerar')) $('btnPayMovZerar').onclick = () => payMovZerar();
if ($('btnPayMovCsv')) $('btnPayMovCsv').onclick = () => payMovCsv();
$('cashDay').onchange = renderCash;
$('btnCashOpen').onclick = async () => {
  const day = ($('cashDay') || {}).value || todayISO();
  let amt = 0;
  if (window.Swal) {
    const r = await Swal.fire({ title: 'Abrir dia — troco inicial', input: 'number', inputValue: 0, inputAttributes: { min: 0, step: '0.01' }, showCancelButton: true, confirmButtonText: 'Abrir', cancelButtonText: 'Cancelar' });
    if (!r || !r.isConfirmed) return;
    amt = Number(r.value) || 0;
  }
  let d = cashDayGet(day, false);
  if (d && d.closed) { d.closed = false; d.open = amt; d.updatedAt = Date.now(); pushQueue({ type: 'cashday', payload: { ...d } }); toast('Dia reaberto.', 'success'); }
  else if (d) { d.open = amt; d.updatedAt = Date.now(); pushQueue({ type: 'cashday', payload: { ...d } }); toast('Troco inicial atualizado.', 'success'); }
  else { d = { id: day, date: day, open: amt, closed: false, updatedAt: Date.now() }; cashDays.push(d); pushQueue({ type: 'cashday', payload: { ...d } }); toast('Dia aberto com ' + MZN(amt) + '.', 'success'); }
  persist(); renderAll();
};
$('btnCashClose').onclick = async () => {
  const day = $('cashDay').value || todayISO();
  const d = cashDayGet(day);
  if (!d) return;
  const t = cashTotals(day);
  let counted = null;
  if (window.Swal) {
    const r = await Swal.fire({ title: 'Fecho de caixa — contagem cega', html: 'Contagem física do dinheiro em caixa (sem ver o esperado):', input: 'number', inputAttributes: { min: 0, step: '0.01' }, showCancelButton: true, confirmButtonText: 'Fechar', cancelButtonText: 'Cancelar' });
    if (!r || !r.isConfirmed) return;
    counted = (r.value === '' || r.value == null) ? null : Number(r.value);
  }
  d.counted = counted;
  d.diff = counted != null && !isNaN(counted) ? Math.round((counted - t.bal) * 100) / 100 : null;
  d.closed = true; d.updatedAt = Date.now();
  pushQueue({ type: 'cashday', payload: { ...d } });
  persist(); renderAll();
  toast('Caixa fechada. Saldo: ' + MZN(t.bal) + (d.diff ? ' · Quebra: ' + MZN(d.diff) : ''), 'success');
};
$('btnSaveMove').onclick = () => {
  const day = $('cashDay').value || todayISO();
  const type = $('mType').value, cat = $('mCat').value.trim() || (type === 'entrada' ? 'Entrada manual' : 'Despesa');
  const amount = parseMoney($('mAmount').value);
  if (amount <= 0) return toast('Indique o valor.', 'warning');
  const method = $('mMethod').value.trim() || 'Numerário';
  if (!payMethods.includes(method)) { payMethods.push(method); pushQueue({ type: 'settings', payload: { key: 'payMethods', list: payMethods } }); renderPayUnits(); }
  if (cashAdd(day, type, cat, amount, method, '', $('mNotes').value.trim(), false)) {
    $('mAmount').value = ''; $('mNotes').value = '';
    $('movModal').style.display = 'none';
    toast('Movimento registado.', 'success');
  }
};
/* ---------- menu + modal de movimento ---------- */
if ($('btnMovMenu')) $('btnMovMenu').onclick = (e) => { e.stopPropagation(); const m = $('movMenu'); if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none'; };
document.addEventListener('click', (e) => { const m = $('movMenu'); if (m && m.style.display !== 'none' && (!e.target.closest || !e.target.closest('.menu-wrap'))) m.style.display = 'none'; });
document.querySelectorAll('#movMenu button').forEach(b => b.onclick = () => { $('movMenu').style.display = 'none'; openMov(b.dataset.mov); });
if ($('btnCancelMov')) $('btnCancelMov').onclick = () => { $('movModal').style.display = 'none'; };

function openMov(mode) {
  if (mode === 'despesa') {
    $('movTitle').textContent = 'Despesa / Movimento manual';
    $('movPayBox').style.display = 'none'; $('movDespBox').style.display = 'block';
    $('btnSaveMove').style.display = '';
    if ($('mAmount')) $('mAmount').value = ''; if ($('mNotes')) $('mNotes').value = '';
  } else {
    $('movTitle').textContent = 'Pagamento a fornecedor';
    $('movPayBox').style.display = 'block'; $('movDespBox').style.display = 'none';
    $('btnSaveMove').style.display = 'none';
    if ($('movSup')) $('movSup').value = '';
    renderMovSupList('');
  }
  $('movModal').style.display = 'flex';
}
function renderMovSupList(q) {
  const tb = $('movInvTable'); if (!tb) return;
  const bd = tb.querySelector('tbody'); bd.innerHTML = '';
  q = (q || '').toLowerCase().trim();
  const sups = suppliers.filter(s => !q || (s.name || '').toLowerCase().includes(q)).slice(0, 6);
  if (!q) { bd.innerHTML = '<tr><td colspan="4" class="hint">Pesquise o fornecedor acima.</td></tr>'; return; }
  if (!sups.length) { bd.innerHTML = '<tr><td colspan="4" class="hint">Nenhum fornecedor encontrado.</td></tr>'; return; }
  sups.forEach(s => {
    withBalances(s.id).filter(r => supInvRemaining(r) > 0).forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(s.name)}<br><span class="hint">${esc(r.number)}</span></td><td style="text-align:right">${MZN(r.total)}</td><td style="text-align:right"><strong>${MZN(supInvRemaining(r))}</strong></td><td class="col-act"><button type="button" class="btn small">Pagar</button></td>`;
      tr.querySelector('button').onclick = () => { $('movModal').style.display = 'none'; openPayInv(r.id); };
      bd.appendChild(tr);
    });
  });
  if (!bd.children.length) bd.innerHTML = '<tr><td colspan="4" class="hint">Sem faturas em falta para esta pesquisa.</td></tr>';
}
if ($('movSup')) $('movSup').addEventListener('input', (e) => renderMovSupList(e.target.value));
document.querySelectorAll('#payMovesTabs button').forEach(b => b.onclick = () => setPayMovesFilter(b.dataset.pf));
document.querySelectorAll('#payPeriodTabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#payPeriodTabs button').forEach(x => x.classList.toggle('active', x === b));
  payPeriod = b.dataset.pp; renderPayMoves();
});
if ($('payPeriodDate')) $('payPeriodDate').addEventListener('change', renderPayMoves);
if ($('searchPayMoves')) $('searchPayMoves').addEventListener('input', renderPayMoves);
$('btnCashPdf').onclick = () => {
  const day = $('cashDay').value || todayISO();
  const t = cashTotals(day);
  const ms = cashMoves.filter(m => m.day === day).sort((a, b) => String(a.time + (a.ts || 0)).localeCompare(String(b.time + (b.ts || 0))));
  const doc = docNew();
  const dd = cashDayGet(day, false);
  let y = docHeader(doc, 'FECHO DE CAIXA (PDF-CX)', 'Dia ' + fmtDate(day), pdfNow(), '');
  y = docMeta(doc, y, [
    { title: 'Resumo do dia', lines: [
      'Troco inicial: ' + MZN(t.open),
      'Entradas: ' + MZN(t.tin),
      'Saídas: ' + MZN(t.tout),
      'Saldo esperado: ' + MZN(t.bal)
    ] },
    { title: 'Conferência', lines: [
      'Estado: ' + (t.closed ? 'FECHADO' : 'ABERTO'),
      (dd && dd.counted != null) ? 'Contagem física: ' + MZN(dd.counted) : 'Contagem física: —',
      (dd && dd.counted != null) ? 'Quebra / diferença: ' + MZN(dd.diff || 0) : 'Quebra / diferença: —',
      'Operador: ' + userNameOf(currentUser)
    ] }
  ]);
  y = docBanner(doc, y, t.closed ? 'Caixa do dia fechada.' : 'Caixa do dia ainda aberto — documento provisório.', t.closed ? 'ok' : 'warn');
  y = docItems(doc, y, {
    columnStyles: {
      0: { cellWidth: 15, textColor: CMUT },
      1: { cellWidth: 20, fontStyle: 'bold' },
      2: { cellWidth: 'auto' },
      3: { halign: 'right', cellWidth: 26, fontStyle: 'bold' },
      4: { cellWidth: 26, textColor: CMUT },
      5: { cellWidth: 'auto', textColor: CMUT, fontSize: 7.6 }
    },
    head: [['Hora', 'Tipo', 'Categoria', 'Valor (MT)', 'Forma', 'Referência']],
    body: ms.map(m => [m.time || '', m.type === 'entrada' ? 'Entrada' : 'Saída', m.category, MZN(m.amount), m.method, m.ref || '']),
    didDrawPage: docFootSetup(doc, '', 'Caixa ' + fmtDate(day))
  });
  y = docTotals(doc, y + 3, [
    { label: 'ENTRADAS', value: MZN(t.tin), color: COK },
    { label: 'SAÍDAS', value: MZN(t.tout), color: CBAD },
    { label: 'SALDO ESPERADO', value: MZN(t.bal), big: true, rule: true },
    (dd && dd.counted != null) ? { label: 'SALDO CONTADO', value: MZN(dd.counted) } : null,
    (dd && dd.counted != null) ? { label: 'QUEBRA', value: MZN(dd.diff || 0), color: (Number(dd.diff) || 0) === 0 ? COK : CBAD } : null
  ]);
  docSignatures(doc, 'O Operador de Caixa', 'O Responsável / Gerência');
  pdfSave(doc, safeName('fecho_' + day));
};

/* ---------- sync ---------- */
let lastSyncError = '';
/* Tempo real: um único listener para TODOS os dados do terminal.
   Qualquer alteração feita noutro aparelho entra aqui e redesenha a app
   no mesmo instante (stock, vendas, caixa, compras, notificações, etc.). */
let dataWatchRef = null, dataWatchUID = null, dataWatchTimer = null;
let dataWatchPending = null, lastCloudSig = '', realtimeActive = false;
let mergePushOps = [];
let syncInFlight = [];
/* Erros permanentes: os dados nunca poderão ser gravados tal como estão */
const isInvalidKeyErr = (m) => /invalid key|invalid path|contains an invalid/i.test(String(m || ''));
function renderQueue() {
  $('queueCount').textContent = queue.length;
  const st = $('syncStatus');
  if (st) {
    if (!queue.length) st.textContent = 'Estado: sincronizado ✓' + (realtimeActive ? ' · tempo real ativo' : '');
    else {
      let extra = lastSyncError ? ' — último erro: ' + lastSyncError : '';
      if (isInvalidKeyErr(lastSyncError)) extra += '  →  toque em «Sincronizar agora»: a fila é reparada automaticamente.';
      else if (!cloudUid()) extra += '  →  entre com Email e Palavra-passe (a entrada por PIN não sincroniza).';
      else if (/permission_denied|sem permissão/i.test(lastSyncError)) extra += '  →  publique as Rules (ficheiro regras-firebase.json) no Firebase Console → Realtime Database → Rules → Publish.';
      st.textContent = 'Estado: ' + queue.length + ' pendente(s)' + extra;
    }
  }
  try { updateNotifBadge(); } catch (_) {}
}
$('btnSync').onclick = () => syncNow();
$('btnDiag').onclick = async () => {
  const out = $('diagOut');
  if (!isOnline()) { out.textContent = 'Sem internet.'; return; }
  if (!rdb) { out.textContent = 'Firebase não inicializado (falta internet no arranque?).'; return; }
  if (!cloudUid()) { out.textContent = 'Sem sessão online: entra com Email e Palavra-passe (a entrada por PIN não sincroniza).'; return; }
  out.textContent = 'A testar escrita e leitura…';
  try {
    await cloudRef('_health').set({ at: Date.now() });
    const s = await cloudRef('_health').get();
    await cloudRef('_health').remove();
    if (!s.val()) { out.textContent = 'Falha na leitura após escrita.'; return; }
    // Permissões dos dois nós usados pela app: users/{uid} e users_meta/{uid}
    let meta = 'OK';
    try {
      const ses = load(LS.ses, {});
      const uid = (ses && ses.uid) || cloudUid();
      await accountAccess.authorize(auth.currentUser);
    } catch (e2) { meta = String((e2 && (e2.code || e2.message)) || e2); }
    out.textContent = 'users/' + cloudUid() + ': OK.  users_meta/' + (((load(LS.ses, {}) || {}).uid) || cloudUid()) + ': ' + meta
      + (meta === 'OK' ? '' : '  → Publica as Rules (regras-firebase.json) no console Firebase → Realtime Database → Rules.');
    toast('Diagnóstico: users OK · users_meta ' + meta, meta === 'OK' ? 'success' : 'error');
  } catch (e) {
    const msg = String((e && (e.code || e.message)) || e);
    out.textContent = 'FALHOU: ' + msg + (msg.indexOf('PERMISSION_DENIED') !== -1 ? ' → Troca as Rules no console Firebase e faz Publish.' : '');
    toast('Diagnóstico falhou: ' + msg, 'error');
  }
};
let isSyncing = false, syncAgain = false;
async function syncNow(silent) {
  if(systemRestoreInProgress) return;
  if (currentRole() !== 'admin') silent = true;   // o operador nunca vê mensagens de sincronização
  renderQueue();
  if (!isOnline() || !rdb || !cloudUid() || !queue.length) return;
  if (isSyncing) { syncAgain = true; return; } // sem corridas: 1 ciclo de cada vez
  isSyncing = true;
  let droppedTotal = 0;
  try {
    do {
      syncAgain = false;
      if (queue.length > 500) compactQueue();
      const rest = [];
      lastSyncError = '';
      const batch = queue; queue = [];
      syncInFlight = batch.slice();
      const U = cloudDataUid();
      // Ops que nunca poderão ser gravados com a sessão atual (evita fila presa para sempre)
      const permanent = (op) => {
        const P = op.payload || {};
        if (op.type === 'usermeta' && String(P.uid || '') !== String(cloudUid() || '')) return 'perfil de outro utilizador (users_meta/' + (P.uid || '?') + ')';
        return '';
      };
      // Converte op → [caminho, valor] (null = remover). Desconhecidos são descartados.
      const toPath = (op) => {
        const P = op.payload || {};
        switch (op.type) {
          case 'supplier': return ['users/' + U + '/suppliers/' + P.id, P];
          case 'invoice': return ['users/' + U + '/invoices/' + P.id, P];
          case 'delete-supplier': return ['users/' + U + '/suppliers/' + P.id, null];
          case 'delete-invoice': return ['users/' + U + '/invoices/' + P.id, null];
          case 'stock': return ['users/' + U + '/stock/' + P.id, P];
          case 'delete-stock': return ['users/' + U + '/stock/' + P.id, null];
          case 'settings': {
            // O mapa de utilizadores é um objeto com chaves derivadas de emails:
            // normaliza-as para chaves válidas do Firebase (sem . # $ / [ ]).
            if (P.key === 'users' && P.list && typeof P.list === 'object' && !Array.isArray(P.list)) {
              const l = {};
              Object.entries(P.list).forEach(([k, v]) => { l[fbKey((v && v.email) || k)] = v; });
              return ['users/' + U + '/settings/users', { list: l }];
            }
            return ['users/' + U + '/settings/' + P.key, { list: P.list }];
          }
          case 'members': return ['companyMembers/' + U, P.members];
          case 'sale-print-event': return ['users/'+U+'/sales/'+P.saleId+'/printEvents/'+P.id,P];
          case 'sale': return ['users/' + U + '/sales/' + P.id, P];
          case 'delete-sale': return ['users/' + U + '/sales/' + P.id, null];
          case 'client': return ['users/' + U + '/clients/' + P.id, P];
          case 'delete-client': return ['users/' + U + '/clients/' + P.id, null];
          case 'suppay': return ['users/' + U + '/suppay/' + P.id, P];
          case 'delete-suppay': return ['users/' + U + '/suppay/' + P.id, null];
          case 'move': return ['users/' + U + '/moves/' + P.id, P];
          case 'cashday': return ['users/' + U + '/cashdays/' + P.id, P];
          case 'cashmove': return ['users/' + U + '/cashmoves/' + P.id, P];
          case 'delete-cashmove': return ['users/' + U + '/cashmoves/' + P.id, null];
          case 'receipt': return ['users/' + U + '/receipts/' + P.id, P];
          case 'nc': return ['users/' + U + '/ncs/' + P.id, P];
          case 'delete-nc': return ['users/' + U + '/ncs/' + P.id, null];
          case 'porder': return ['users/' + U + '/porders/' + P.id, P];
          case 'delete-porder': return ['users/' + U + '/porders/' + P.id, null];
          case 'supreturn': return ['users/' + U + '/supret/' + P.id, P];
          case 'delete-supreturn': return ['users/' + U + '/supret/' + P.id, null];
          case 'supadj': return ['users/' + U + '/supadj/' + P.id, P];
          case 'delete-supadj': return ['users/' + U + '/supadj/' + P.id, null];
          case 'loss': return ['users/' + U + '/losses/' + P.id, P];
          case 'delete-loss': return ['users/' + U + '/losses/' + P.id, null];
          case 'transfer': return ['users/' + U + '/transfers/' + P.id, P];
          case 'delete-transfer': return ['users/' + U + '/transfers/' + P.id, null];
          case 'delete-move': return ['users/' + U + '/moves/' + P.id, null];
          case 'delete-cashday': return ['users/' + U + '/cashdays/' + P.id, null];
          case 'delete-receipt': return ['users/' + U + '/receipts/' + P.id, null];
          case 'draft': return ['users/' + U + '/drafts/' + P.id, P];
          case 'delete-draft': return ['users/' + U + '/drafts/' + P.id, null];
          case 'notif': return ['users/' + U + '/notifs/' + P.id, P];
          case 'delete-notif': return ['users/' + U + '/notifs/' + P.id, null];
          case 'notif-state': {
            if(!P.user || !P.id || !['deleted','seen'].includes(P.field)) return null;
            return ['users/'+U+'/notifState/'+fbKey(P.user)+'/'+P.field+'/'+fbKey(P.id),P.id];
          }
          case 'chat': return [cloudChatPath(P.id), P];
          case 'delete-chat': return [cloudChatPath(P.id), null];
          case 'chat-user': return ['users/' + U + '/chat/' + P.id, P];
          case 'delete-chat-user': return ['users/' + U + '/chat/' + P.id, null];
          case 'user': return ['users/' + U + '/team/' + fbKey(P.email || P.id), P];
          case 'delete-user': return ['users/' + U + '/team/' + fbKey(P.id || P.email), null];
          case 'usermeta': return null;
          case 'syncreq': return ['users/' + U + '/syncreq/' + fbKey(P.email), { by: P.by, at: P.at || Date.now() }];
          case 'delete-syncreq': return ['users/' + U + '/syncreq/' + fbKey(P.email), null];
          default: return null;
        }
      };
      // Multi-path em lotes de 200: 4000 ops saem em ~20 escritas em vez de 4000
      const CHUNK = 200;
      const invalidKey = isInvalidKeyErr;
      const permErr = (m) => /permission_denied|permission denied/i.test(String(m || ''));
      let dropped = 0;
      const dropPermanent = (batchIn) => batchIn.filter(op => {
        const why = permanent(op);
        if (!why) return true;
        dropped++;
        lastSyncError = why;
        return false;
      });      const valid = dropPermanent(batch);
      for (let i = 0; i < valid.length; i += CHUNK) {
        const slice = valid.slice(i, i + CHUNK);
        const obj = {};
        slice.forEach(op => { const t = toPath(op); if (t) obj[t[0]] = t[1]; });
        if (!Object.keys(obj).length) continue;
        try {
          /* As regras fecham a raiz do banco: o envio em lote só pode acontecer
             dentro de users/{U}. users_meta e companyMembers vão um a um. */
          const underU = {}, outside = [], base = 'users/' + U + '/';
          Object.keys(obj).forEach(p => {
            if (p.indexOf(base) === 0) underU[p.slice(base.length)] = obj[p];
            else outside.push([p, obj[p]]);
          });
          if (Object.keys(underU).length) await rdb.ref('users/' + U).update(underU);
          for (const pair of outside) await rdb.ref(pair[0]).set(pair[1]);
        }
        catch (e) {
          const msg = (e && (e.code || e.message)) || 'erro desconhecido';
          lastSyncError = msg;
          // Uma única operação inválida não pode bloquear a fila inteira:
          // reenvia uma a uma e descarta só as que são impossíveis de gravar.
          let isolated = false;
          const restBefore = rest.length, dropBefore = dropped;
          for (const op of slice) {
            const t = toPath(op);
            if (!t) continue;
            try { await rdb.ref(t[0]).set(t[1]); isolated = true; }
            catch (e2) {
              const m2 = (e2 && (e2.code || e2.message)) || 'erro desconhecido';
              if (invalidKey(m2)) { dropped++; lastSyncError = m2; }
              else if (op.type === 'members' && permErr(m2)) {
                /* As regras publicadas ainda não incluem companyMembers:
                   não repetir sem parar (volta a tentar no próximo arranque). */
                dropped++;
                lastSyncError = 'regras do Firebase antigas: publique regras-firebase.json para partilhar com outras contas';
              } else rest.push(op);
            }
          }
          const allWritten = isolated && rest.length === restBefore && dropped === dropBefore;
          if (allWritten) lastSyncError = '';   // falhou em lote mas gravou tudo uma a uma
          else if (!isolated && permErr(msg)) lastSyncError = 'sem permissão para gravar. Falhou em: ' + Object.keys(obj).join(', ');
          else if (!isolated) lastSyncError = msg;
        }
      }
      if (dropped) lastSyncError = 'ignorados ' + dropped + ' registo(s) — ' + (lastSyncError || 'incompatíveis com a nuvem');
      droppedTotal += dropped;
      queue = rest.concat(queue); persist(); renderQueue();
    } while (syncAgain && queue.length && isOnline() && rdb && cloudUid());
  } finally { isSyncing = false; syncInFlight = []; renderQueue(); }
  if (!silent) {
    if (queue.length) toast('Não sincronizado (' + queue.length + ' pendentes). Erro: ' + (lastSyncError || 'desconhecido'), 'error');
    else if (droppedTotal) toast('Sincronização concluída — ' + droppedTotal + ' registo(s) ignorado(s): ' + lastSyncError, 'warning');
    else toast('Sincronização concluída.', 'success');
  }
}
/* Junta uma coleção da nuvem com o que ainda está por enviar neste terminal.
   - o que está na nuvem manda (inclui registos apagados noutro aparelho);
   - operações ainda na fila (ou a meio de envio) nunca são perdidas;
   - se o registo local pendente for mais recente, ele fica visível já. */
function mergeCloudCollection(cloud, cloudKey, arr, upTypes, delTypes) {
  const cObj = cloud[cloudKey] || {};
  const pending = queue.concat(syncInFlight);
  const up = new Set(), del = new Set();
  pending.forEach(op => {
    const id = op && op.payload && op.payload.id;
    if (!id) return;
    if ((upTypes || []).indexOf(op.type) !== -1) up.add(id);
    if ((delTypes || []).indexOf(op.type) !== -1) del.add(id);
  });
  const localById = Object.fromEntries((arr || []).filter(x => x && x.id).map(x => [x.id, x]));
  const out = [];
  const seen = new Set();
  Object.values(cObj).forEach(v => {
    if (!v || !v.id || del.has(v.id)) return;
    const l = localById[v.id];
    const lt = Number(l && (l.updatedAt || l.ts)) || 0;
    const ct = Number(v.updatedAt || v.ts) || 0;
    /* O registo mais recente manda, mesmo que a alteração local ainda não
       tenha entrado na fila. Sem isto, a nuvem podia apagar quantidades de
       stock acabadas de lançar neste terminal. */
    const useLocal = !!l && (lt > ct || (lt === ct && up.has(v.id)));
    out.push(useLocal ? l : v);
    if (useLocal && upTypes && upTypes.length && !up.has(v.id)) {
      mergePushOps.push({ type: upTypes[0], payload: { ...l } });
    }
    seen.add(v.id);
  });
  // Escritas locais que ainda não chegaram à nuvem (ex.: offline / a enviar)
  up.forEach(id => {
    if (seen.has(id) || del.has(id)) return;
    if (localById[id]) { out.push(localById[id]); seen.add(id); }
  });
  return out;
}
/* O chat pode chegar por dois caminhos (teamchat e users/{uid}/chat).
   A união evita que um snapshot de users/{uid} apague mensagens recebidas
   pelo teamchat, sem perder as atualizações mais recentes. */
function mergeChatCloud(cloudChat, arr) {
  const by = new Map();
  (arr || []).forEach(m => { if (m && m.id && !chatGone(m.id)) by.set(m.id, m); });
  Object.values(cloudChat || {}).forEach(v => {
    if (!v || !v.id || chatGone(v.id)) return;
    const old = by.get(v.id);
    if (!old) { by.set(v.id, v); return; }
    const vt = Number(v.updatedAt || v.ts) || 0;
    const ot = Number(old.updatedAt || old.ts) || 0;
    if (vt >= ot) by.set(v.id, { ...old, ...v });
  });
  return [...by.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}
function cloudSignature(cloud) {
  try { return JSON.stringify(cloud || {}); } catch (_) { return ''; }
}
function operatorQueries() {
  const email=String(auth.currentUser.email).toLowerCase(),queries={};
  ['stock','clients'].forEach(key=>queries[key]=cloudRef(key));
  queries.sales=cloudRef('sales').orderByChild('billingOnly').equalTo(billingMode());
  ['drafts','cashmoves','receipts','ncs','moves','transfers','losses'].forEach(key=>queries[key]=cloudRef(key).orderByChild('operator').equalTo(email));
  queries.notifs=cloudRef('notifs').orderByChild('to').equalTo(email);
  ['company','tax','stockcfg','payMethods','units'].forEach(key=>queries['settings/'+key]=cloudRef('settings/'+key));
  queries.team=rdb.ref('directory/'+window.FIREBASE_WORKSPACE);
  return queries;
}
function operatorSnapshot(entries){const cloud={};entries.forEach(([path,value])=>{if(path.startsWith('settings/')){cloud.settings||={};cloud.settings[path.slice(9)]=value||{};}else cloud[path]=value||{};});return cloud;}
async function pullOperatorData(){const entries=await Promise.all(Object.entries(operatorQueries()).map(async([key,ref])=>[key,(await ref.get()).val()]));await applyCloudData(operatorSnapshot(entries));}
async function pullFromCloud() {
  if (!isOnline() || !rdb || !cloudUid() || (window.FIREBASE_CONFIG && !authorizedProfile)) return;
  try {
    if(currentRole()!=='admin'){await pullOperatorData();startDataWatch();return;}
    const snap = await cloudRef('').get();
    await applyCloudData(snap.val() || {});
    startDataWatch();
  } catch (e) { console.warn('pull falhou', e); }
}
async function applyCloudData(cloudIn) {
  if(systemRestoreInProgress) return false;
  const cloud = cloudIn || {};
  const sig = cloudSignature(cloud);
  if (sig === lastCloudSig) return false;
  lastCloudSig = sig;
  mergePushOps = [];
  suppliers = mergeCloudCollection(cloud, 'suppliers', suppliers, ['supplier'], ['delete-supplier']);
  invoices = mergeCloudCollection(cloud, 'invoices', invoices, ['invoice'], ['delete-invoice']);
  const cSet = cloud.settings || {};
  if(cloud.notifState && typeof cloud.notifState==='object') {
    const users=notifUserState();
    Object.entries(cloud.notifState).forEach(([user,state])=>{
      if(!state || typeof state!=='object') return;
      users[user] ||= {};
      ['seen','deleted'].forEach(field=>{users[user][field]={...(users[user][field]||{}),...(state[field]||{})};});
    });
    save('dec_notif_user_state',users);
  }
  ['payMethods', 'units'].forEach(k => {
    const raw = cSet[k];
    const rList = raw ? (Array.isArray(raw.list) ? raw.list : Object.values(raw)) : [];
    const cur = k === 'payMethods' ? payMethods : units;
    let changed = false;
    rList.map(v => String(v).trim()).filter(Boolean).forEach(v => { if (!cur.includes(v)) { cur.push(v); changed = true; } });
    if (changed) save(k === 'payMethods' ? LS.pay : LS.units, cur);
  });
  if (cSet.company && cSet.company.list && typeof cSet.company.list === 'object' && !Array.isArray(cSet.company.list)) {
    const rc = cSet.company.list;
    if ((rc.updatedAt || 0) > (company.updatedAt || 0)) { company = { ...company, ...rc }; save(LS.company, company); renderCompany(); }
  }
  if (cSet.tax && cSet.tax.list && typeof cSet.tax.list === 'object' && !Array.isArray(cSet.tax.list)) {
    const rt = cSet.tax.list;
    if ((rt.updatedAt || 0) > (tax.updatedAt || 0)) { tax = { ...tax, ...rt }; save(LS.tax, tax); renderTax(); }
  }
  if (cSet.stockcfg && cSet.stockcfg.list && typeof cSet.stockcfg.list === 'object') {
    try { const remote = cSet.stockcfg.list; if ((remote.updatedAt || 0) >= (stockCfg().updatedAt || 0)) localStorage.setItem('dec_stockcfg', JSON.stringify(remote)); renderStockCfg(); } catch (_) {}
  }
  stock = mergeCloudCollection(cloud, 'stock', stock, ['stock'], ['delete-stock']);
  renderPayUnits();
  sales = mergeCloudCollection(cloud, 'sales', sales, ['sale'], ['delete-sale']);
  sales.forEach(s=>{if(s.printEvents)s.printCount=Math.max(Number(s.printCount)||0,invoiceIssues(s).length);});
  clients = mergeCloudCollection(cloud, 'clients', clients, ['client'], ['delete-client']);
  supPayments = mergeCloudCollection(cloud, 'suppay', supPayments, ['suppay'], ['delete-suppay']);
  movements = mergeCloudCollection(cloud, 'moves', movements, ['move'], ['delete-move']);
  cashDays = mergeCloudCollection(cloud, 'cashdays', cashDays, ['cashday'], ['delete-cashday']);
  cashMoves = mergeCloudCollection(cloud, 'cashmoves', cashMoves, ['cashmove'], ['delete-cashmove']);
  receipts = mergeCloudCollection(cloud, 'receipts', receipts, ['receipt'], ['delete-receipt']);
  ncs = mergeCloudCollection(cloud, 'ncs', ncs, ['nc'], ['delete-nc']);
  porders = mergeCloudCollection(cloud, 'porders', porders, ['porder'], ['delete-porder']);
  supReturns = mergeCloudCollection(cloud, 'supret', supReturns, ['supreturn'], ['delete-supreturn']);
  supAdjustments = mergeCloudCollection(cloud, 'supadj', supAdjustments, ['supadj'], ['delete-supadj']);
  stockLosses = mergeCloudCollection(cloud, 'losses', stockLosses, ['loss'], ['delete-loss']);
  transfers = mergeCloudCollection(cloud, 'transfers', transfers, ['transfer'], ['delete-transfer']);
  // Equipa/níveis (nó team no Realtime): o nível do Realtime manda sobre o local
  try {
    const team = cloud.team || {};
    const users = appUsers();
    let changed = false;
    const upsert = (t) => {
      if (!t || !t.email) return;
      const u = users.find(x => String(x.email || '').toLowerCase() === String(t.email).toLowerCase());
      if (!u) {
        users.push({ uid:t.uid||'',admin:t.admin===true,email: t.email, name: t.name || '', role: t.admin===true?'admin':t.role==='opt'?'opt':'op', mode: t.mode || '', pinHash: t.pinHash || '', active: true, updatedAt: t.updatedAt || Date.now() });
        changed = true;
        return;
      }
      if(t.uid && u.uid!==t.uid){u.uid=t.uid;u.admin=t.admin===true;u.active=t.active!==false;changed=true;}
      if (t.role && u.role !== t.role) { u.role = t.role; changed = true; }
      if (t.mode === 'venda' || t.mode === 'faturacao' || t.mode === '') {
        if ((u.mode || '') !== t.mode) { u.mode = t.mode; changed = true; }
      }
      if (t.name && u.name !== t.name) { u.name = t.name; changed = true; }
      if (t.pinHash && u.pinHash !== t.pinHash) { u.pinHash = t.pinHash; changed = true; }
    };
    Object.values(team).forEach(upsert);
    // Mapa settings/users (trava RBAC dentro do tenant): também manda
    const su = (cSet.users && cSet.users.list) || {};
    Object.values(su).forEach(upsert);
    if (changed) saveUsers(users);
  } catch (_) {}
  // O nível definido pelo administrador manda sobre o que está guardado neste terminal
  try {
    const me = appUsers().find(x => String(x.email || '').toLowerCase() === String(currentUser || '').toLowerCase());
    if (me && me.role && load(LS.role, '') !== me.role) { save(LS.role, me.role); applyRole(); }
  } catch (_) {}
  drafts = mergeCloudCollection(cloud, 'drafts', drafts, ['draft'], ['delete-draft']);
  notifs = mergeCloudCollection(cloud, 'notifs', notifs, ['notif'], ['delete-notif']).filter(n => !notifDeleted.includes(n.id));
  chatMsgs = mergeChatCloud(cloud.chat, chatMsgs).filter(m => !chatGone(m.id));
  if (mergePushOps.length) { const ops = mergePushOps; mergePushOps = []; pushQueueBulk(ops); }
  normalizeStock();
  // Pedido do administrador para este utilizador carregar os dados
  if (currentRole() !== 'admin') await checkSyncRequest(cloud);
  if (currentSup) currentSup = suppliers.find(record => record.id === currentSup.id) || null;
  if (currentCli) currentCli = clients.find(record => record.id === currentCli.id) || null;
  if (currentPaySup) currentPaySup = suppliers.find(record => record.id === currentPaySup.id) || null;
  persist(); renderAll();
  try { startChatWatch(); } catch (_) {}
  return true;
}
/* Listener de tempo real: recebe o nó users/{uid} completo e aplica de imediato. */
function stopDataWatch() {
  operatorWatchRefs.forEach(ref=>{try{ref.off();}catch(_){}});operatorWatchRefs=[];
  if (dataWatchTimer) { clearTimeout(dataWatchTimer); dataWatchTimer = null; }
  if (dataWatchRef) { try { dataWatchRef.off(); } catch (_) {} }
  dataWatchRef = null; dataWatchUID = null; dataWatchPending = null; realtimeActive = false; lastCloudSig = '';
  renderQueue();
}
function startDataWatch() {
  if(systemRestoreInProgress) return;
  if (!isOnline() || !rdb || !cloudUid()) return;
  const uid = cloudDataUid();
  if(currentRole()!=='admin') {
    const watchKey=uid+'|'+auth.currentUser.email;
    if(dataWatchUID===watchKey && operatorWatchRefs.length)return;
    stopDataWatch();dataWatchUID=watchKey;
    const values=new Map(),queries=Object.entries(operatorQueries());
    queries.forEach(([key,ref])=>{operatorWatchRefs.push(ref);ref.on('value',snapshot=>{
      if(dataWatchUID!==watchKey)return;values.set(key,snapshot.val());if(values.size!==queries.length)return;
      if(dataWatchTimer)clearTimeout(dataWatchTimer);dataWatchTimer=setTimeout(()=>{dataWatchTimer=null;applyCloudData(operatorSnapshot([...values])).catch(error=>console.warn('Dados do operador indisponíveis',error.code));},80);
    },error=>{realtimeActive=false;console.warn('Acesso limitado: '+key,error.code);});});return;
  }
  if (dataWatchRef && dataWatchUID === uid) return;
  stopDataWatch();
  dataWatchUID = uid;
  dataWatchRef = rdb.ref('users/' + uid);
  dataWatchRef.on('value', (snap) => {
    if (dataWatchUID !== uid) return;
    realtimeActive = true;
    renderQueue();
    dataWatchPending = snap.val() || {};
    if (dataWatchTimer) return;
    dataWatchTimer = setTimeout(() => {
      dataWatchTimer = null;
      const cloud = dataWatchPending || {};
      applyCloudData(cloud).catch((e) => console.warn('tempo real falhou', e));
    }, 80);
  }, (err) => {
    realtimeActive = false;
    if (dataWatchRef) dataWatchRef.off();
    dataWatchRef = null; dataWatchUID = null;
    renderQueue();
    console.warn('tempo real indisponível', err);
    try { if (currentRole() === 'admin') toast('Tempo real sem permissão. Publique as regras do Firebase.', 'warning'); } catch (_) {}
  });
}

/* ---------- Chat da equipa (só na janela flutuante do topo) ---------- */
function chatGone(id) { return !!id && chatDeleted.indexOf(id) !== -1; }
function chatList() { return chatMsgs.filter(m => !chatGone(m.id)).slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0)); }
function chatMine(m) { return String((m && m.from) || '').toLowerCase() === String(currentUser || '').toLowerCase(); }
const CHAT_ALL = 'todos';
function chatToOf(m) { return String((m && m.to) || CHAT_ALL).toLowerCase(); }
function chatThread(m, who) {
  const to = chatToOf(m), from = String((m && m.from) || '').toLowerCase();
  const me = String(currentUser || '').toLowerCase(), w = String(who || CHAT_ALL).toLowerCase();
  if (w === CHAT_ALL) return to === CHAT_ALL;
  return (from === me && to === w) || (from === w && to === me);
}
function chatRoleOf(email) {
  const em = String(email || '').toLowerCase();
  if (em === String(currentUser || '').toLowerCase()) return currentRole() === 'admin' ? 'Administrador' : 'Operador';
  const u = appUsers().find(x => String(x.email || '').toLowerCase() === em);
  return u && u.role === 'admin' ? 'Administrador' : 'Operador';
}
function chatRecipients() {
  const me = String(currentUser || '').toLowerCase(), seen = {}, out = [];
  appUsers().forEach(u => {
    const em = String(u.email || '').toLowerCase();
    if (!em || em === me || seen[em]) return;
    seen[em] = 1;
    out.push({ email: em, name: userNameOf(em), role: String(u.role || '') });
  });
  chatList().forEach(m => {
    const other = chatMine(m) ? chatToOf(m) : String(m.from || '').toLowerCase();
    if (!other || other === CHAT_ALL || other === me || seen[other]) return;
    seen[other] = 1;
    out.push({ email: other, name: userNameOf(other), role: '' });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function defaultChatPeer() {
  const people = chatRecipients();
  const saved = String(load('dec_chat_to', '') || '').toLowerCase();
  if (saved === CHAT_ALL || people.some(p => p.email === saved)) return saved;
  // operador abre diretamente a conversa com o administrador, se existir
  if (currentRole() !== 'admin') {
    const adm = people.find(p => p.role === 'admin');
    if (adm) return adm.email;
  }
  return CHAT_ALL;
}
function chatPeerKey() {
  const sel = $('chatTo');
  return String((sel && sel.value) || defaultChatPeer()).toLowerCase();
}
function renderChatTo() {
  const sel = $('chatTo'); if (!sel) return;
  const cur = sel.value ? String(sel.value).toLowerCase() : defaultChatPeer();
  const people = chatRecipients();
  const pop = $('chatPopup');
  const open = !!pop && pop.style.display !== 'none' && pop.style.display !== '';
  const count = (who) => (open && who === cur) ? 0 : chatUnreadFor(who);
  const tag = (base, n) => base + (n ? ' (' + (n > 9 ? '9+' : n) + ')' : '');
  sel.innerHTML = '<option value="' + CHAT_ALL + '">' + esc(tag('Equipa — todos', count(CHAT_ALL))) + '</option>'
    + people.map(p => '<option value="' + esc(p.email) + '">' + esc(tag(p.name + (p.role === 'admin' ? ' · admin' : ''), count(p.email))) + '</option>').join('');
  sel.value = (cur === CHAT_ALL || people.some(p => p.email === cur)) ? cur : CHAT_ALL;
  renderChatRecipientMenu();
}
function renderChatRecipientMenu() {
  const sel=$('chatTo'); if(!sel) return;
  sel.hidden=true;
  let trigger=$('chatRecipientButton');
  if(!trigger) {
    trigger=document.createElement('button');trigger.id='chatRecipientButton';trigger.type='button';trigger.className='btn chat-recipient-button';trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');sel.after(trigger);
    const label=document.querySelector('label[for="chatTo"]');if(label) label.htmlFor=trigger.id;
    trigger.onclick=()=>{
      const previous=$('chatRecipientMenu');if(previous){previous.remove();trigger.setAttribute('aria-expanded','false');return;}
      const menu=document.createElement('div');menu.id='chatRecipientMenu';menu.setAttribute('role','menu');
      [...sel.options].forEach(option=>{const b=document.createElement('button');b.type='button';b.textContent=option.textContent;b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',String(option.selected));b.onclick=()=>{sel.value=option.value;menu.remove();trigger.setAttribute('aria-expanded','false');sel.dispatchEvent(new Event('change',{bubbles:true}));renderChatRecipientMenu();trigger.focus();};menu.appendChild(b);});
      document.body.appendChild(menu);const r=trigger.getBoundingClientRect();menu.style.width=Math.min(Math.max(r.width,240),innerWidth-24)+'px';menu.style.left=Math.max(12,Math.min(r.left,innerWidth-menu.offsetWidth-12))+'px';menu.style.top=Math.min(r.bottom+6,innerHeight-menu.offsetHeight-12)+'px';trigger.setAttribute('aria-expanded','true');menu.querySelector('button[aria-checked="true"]')?.focus();
    };
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('#chatRecipientMenu,#chatRecipientButton')){$('chatRecipientMenu')?.remove();trigger.setAttribute('aria-expanded','false');}});
    document.addEventListener('keydown',e=>{const menu=$('chatRecipientMenu');if(!menu)return;if(e.key==='Escape'){menu.remove();trigger.setAttribute('aria-expanded','false');trigger.focus();}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const items=[...menu.querySelectorAll('button')],i=items.indexOf(document.activeElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}});
    window.addEventListener('resize',()=>{$('chatRecipientMenu')?.remove();trigger.setAttribute('aria-expanded','false');});
  }
  trigger.textContent=(sel.selectedOptions[0]?.textContent||'Escolher destinatário')+' ▾';
}
function chatUnreadFor(who) {
  const me = String(currentUser || '').toLowerCase(), w = String(who || CHAT_ALL).toLowerCase();
  return chatMsgs.filter(m => {
    if (chatGone(m.id) || chatMine(m) || chatSeen.indexOf(m.id) !== -1) return false;
    const to = chatToOf(m), from = String(m.from || '').toLowerCase();
    if (w === CHAT_ALL) return to === CHAT_ALL;
    return to === me && from === w;
  }).length;
}
function chatUnread() {
  const me = String(currentUser || '').toLowerCase();
  return chatMsgs.filter(m => !chatGone(m.id) && !chatMine(m) && chatSeen.indexOf(m.id) === -1
    && (chatToOf(m) === CHAT_ALL || chatToOf(m) === me)).length;
}
function chatPopupOpen() {
  const p = $('chatPopup');
  return !!p && p.style.display !== 'none' && p.style.display !== '';
}
/* A janela do chat é sempre um overlay do body, por baixo do botão do topo.
   Assim nunca fica presa dentro de um painel com scroll/corte. */
function positionChatPopup() {
  const p = $('chatPopup'), b = $('btnTopChat');
  if (!p || !b) return;
  try { if (p.parentElement !== document.body) document.body.appendChild(p); } catch (_) {}
  const r = b.getBoundingClientRect();
  const vw = Math.max(280, window.innerWidth || 0);
  const vh = Math.max(320, window.innerHeight || 0);
  const width = Math.min(360, vw - 16);
  const right = Math.max(8, vw - r.right);
  const top = Math.max(8, r.bottom + 8);
  p.style.position = 'fixed';
  p.style.left = 'auto';
  p.style.right = right + 'px';
  p.style.top = top + 'px';
  p.style.bottom = 'auto';
  p.style.width = width + 'px';
  p.style.maxHeight = Math.max(160, vh - top - 16) + 'px';
  p.style.zIndex = '10060';
}
/* Funde mensagens recebidas (nuvem/outro separador) sem duplicar. */
function chatApplyCloudMessage(m) {
  if (!m || !m.id || chatGone(m.id)) return false;
  const by = new Map(chatMsgs.map(x => [x.id, x]));
  const old = by.get(m.id);
  let changed = false;
  if (!old) { by.set(m.id, m); changed = true; }
  else if (String(old.text || '') !== String(m.text || '') || (Number(m.updatedAt) || 0) > (Number(old.updatedAt) || 0)) {
    by.set(m.id, { ...old, ...m });
    changed = true;
  }
  if (!changed) return false;
  chatMsgs = [...by.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  save('dec_chat', chatMsgs);
  updateChatBadge();
  if (!chatMine(m) && !chatPopupOpen() && Math.abs(Date.now() - (Number(m.ts) || 0)) < 15000) { try { beep(1); } catch (_) {} }
  if (chatPopupOpen()) { try { renderChat(); } catch (_) {} }
  return true;
}
/* Envia para a conversa global da equipa; se as regras antigas bloquearem,
   guarda também no nó do utilizador (compatibilidade com versões anteriores). */
async function chatCloudSend(m) {
  if (!m || !m.id) return;
  if (!rdb || !cloudUid() || !isOnline()) { pushQueue({ type: 'chat', payload: { ...m } }); return; }
  try { await rdb.ref(cloudChatPath(m.id)).set({ ...m }); return; }
  catch (_) { chatCloudDenied = true; }
  try { await rdb.ref('users/' + cloudDataUid() + '/chat/' + m.id).set({ ...m }); chatFallbackOk = true; }
  catch (_) { pushQueue({ type: 'chat', payload: { ...m } }); }
}
async function chatCloudDelete(id) {
  if (!id) return;
  const U = cloudDataUid();
  let ok = false;
  if (rdb && U && isOnline()) {
    try { await rdb.ref(cloudChatPath(id)).remove(); ok = true; } catch (_) {}
    try { await rdb.ref('users/' + U + '/chat/' + id).remove(); ok = true; } catch (_) {}
  }
  if (!ok) {
    pushQueue({ type: 'delete-chat', payload: { id } });
    pushQueue({ type: 'delete-chat-user', payload: { id } });
  }
}
/* O operador não sincroniza stock/vendas, mas o chat tem de sair. Envia só as ops de chat. */
async function syncChatQueue() {
  if (!rdb || !cloudUid() || !isOnline()) return;
  const ops = queue.filter(isChatOp);
  if (!ops.length) return;
  const U = cloudDataUid();
  const done = [];
  for (const op of ops) {
    const P = op.payload || {};
    try {
      if (op.type === 'chat') {
        try { await rdb.ref(cloudChatPath(P.id)).set(P); }
        catch (_) { await rdb.ref('users/' + U + '/chat/' + P.id).set(P); chatFallbackOk = true; }
      } else if (op.type === 'chat-user') {
        await rdb.ref('users/' + U + '/chat/' + P.id).set(P); chatFallbackOk = true;
      } else if (op.type === 'delete-chat') {
        try { await rdb.ref(cloudChatPath(P.id)).remove(); }
        catch (_) { await rdb.ref('users/' + U + '/chat/' + P.id).remove(); }
      } else if (op.type === 'delete-chat-user') {
        await rdb.ref('users/' + U + '/chat/' + P.id).remove();
      }
      done.push(op);
    } catch (_) { /* fica na fila para nova tentativa */ }
  }
  if (done.length) {
    queue = queue.filter(o => done.indexOf(o) === -1);
    persist(); renderQueue();
  }
}
function stopChatWatch() {
  chatWatchRefs.forEach(x => { try { x.ref.off(x.ev, x.fn); } catch (_) {} });
  chatWatchRefs = [];
  chatWatchUID = null;
}
/* Escuta em tempo real: teamchat (todas as contas) + nó antigo do utilizador. */
function startChatWatch() {
  if(systemRestoreInProgress) return;
  if (!rdb || !isOnline() || !cloudUid()) return;
  const uid = cloudDataUid();
  const me = String(currentUser || '').toLowerCase();
  const watchKey = uid + '|' + me;
  if (chatWatchUID === watchKey && chatWatchRefs.length) return;
  stopChatWatch();
  chatWatchUID = watchKey;
  chatCloudDenied = false;
  chatFallbackOk = false;
  chatWarned = false;
  const onMsg = (snap, fallback) => {
    if(systemRestoreInProgress) return;
    if (fallback) chatFallbackOk = true;
    try { chatApplyCloudMessage(snap && snap.val()); } catch (_) {}
  };
  const onDel = (snap) => {
    if(systemRestoreInProgress) return;
    const id = snap && snap.key; if (!id) return;
    const before = chatMsgs.length;
    chatMsgs = chatMsgs.filter(x => x.id !== id);
    if (chatMsgs.length !== before) {
      save('dec_chat', chatMsgs);
      updateChatBadge();
      if (chatPopupOpen()) { try { renderChat(); } catch (_) {} }
    }
  };
  const attach = (ref, label) => {
    const fn = (snap) => onMsg(snap, label === 'users');
    ['child_added', 'child_changed'].forEach(ev => {
      ref.on(ev, fn, (err) => {
        chatCloudDenied = true;
        if (!chatWarned) {
          chatWarned = true;
          try { console.warn('chat: Firebase recusou /teamchat. Publique regras-firebase.json para falar entre contas. Detalhe: ' + ((err && err.message) || err)); } catch (_) {}
        }
      });
      chatWatchRefs.push({ ref, ev, fn });
    });
    ref.on('child_removed', onDel);
    chatWatchRefs.push({ ref, ev: 'child_removed', fn: onDel });
  };
  /* Só carrega o que interessa: equipa, mensagens recebidas e as minhas enviadas.
     Evita descarregar conversas diretas de outras pessoas. */
  const addQuery = (child, value, label) => {
    if (!value) return;
    try { attach(rdb.ref('teamchat').orderByChild(child).equalTo(value), label); } catch (_) {}
  };
  /* A conversa da equipa e as mensagens diretas vivem no teamchat, por isso
     qualquer conta autenticada as recebe em tempo real. O nó users/{U}/chat
     continua ligado como reserva (contas antigas / PIN local). */
  const authEmail = String((auth && auth.currentUser && auth.currentUser.email) || '').toLowerCase();
  addQuery('to', CHAT_ALL, 'team');
  if (authEmail) { addQuery('to', authEmail, 'dm-in'); addQuery('from', authEmail, 'dm-out'); }
  if (me && me !== authEmail) addQuery('to', me, 'dm-in');
  attach(rdb.ref('users/' + uid + '/chat'), 'users');
  chatFallbackOk = true;   // nó do próprio utilizador: sempre permitido pelas regras
}
function updateChatBadge() {
  const b = $('chatBadge');
  const n = chatUnread();
  if (b) {
    b.style.display = n ? '' : 'none';
    b.textContent = n > 9 ? '9+' : String(n);
  }
  const btn = $('btnTopChat');
  if (btn) {
    btn.classList.toggle('has-unread', n > 0);
    btn.title = n ? 'Chat — ' + n + ' mensagem(ns) nova(s)' : 'Chat com a equipa';
    btn.setAttribute('aria-label', n ? 'Chat, ' + n + ' novas mensagens' : 'Chat com a equipa');
  }
  const sig = $('chatSignal');
  if (sig) sig.style.display = n ? '' : 'none';
}
const CHAT_RULES_TEXT = "{\n  \"rules\": {\n    \".read\": false,\n    \".write\": false,\n    \"users\": {\n      \"$uid\": {\n        \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users_meta').child(auth.uid).child('admin').val() === true\",\n        \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users_meta').child(auth.uid).child('admin').val() === true\",\n        \"stock\": {\n          \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\",\n          \"$id\": {\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.exists() && newData.exists() && newData.child('name').val() === data.child('name').val() && newData.child('price').val() === data.child('price').val() && newData.child('qLoja').isNumber() && newData.child('qLoja').val() >= 0 && newData.child('qArm').isNumber() && newData.child('qArm').val() >= 0\"\n          }\n        },\n        \"clients\": {\n          \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n        },\n        \"sales\": {\n          \".indexOn\": [\n            \"operator\",\n            \"billingOnly\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'billingOnly' && query.equalTo === (root.child('users_meta').child(auth.uid).child('mode').val() === 'faturacao' || (root.child('users_meta').child(auth.uid).child('mode').val() !== 'venda' && root.child('users_meta').child(auth.uid).child('mode').val() !== 'faturacao' && root.child('users').child($uid).child('settings/stockcfg/list/billingMode').val() === true))\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && (data.child('billingOnly').val() === true) === (root.child('users_meta').child(auth.uid).child('mode').val() === 'faturacao' || (root.child('users_meta').child(auth.uid).child('mode').val() !== 'venda' && root.child('users_meta').child(auth.uid).child('mode').val() !== 'faturacao' && root.child('users').child($uid).child('settings/stockcfg/list/billingMode').val() === true))\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && (newData.child('billingOnly').val() === true) === (root.child('users_meta').child(auth.uid).child('mode').val() === 'faturacao' || (root.child('users_meta').child(auth.uid).child('mode').val() !== 'venda' && root.child('users_meta').child(auth.uid).child('mode').val() !== 'faturacao' && root.child('users').child($uid).child('settings/stockcfg/list/billingMode').val() === true)) && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\",\n            \"printEvents\": {\n              \"$event\": {\n                \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users').child($uid).child('sales').child($id).exists() && (root.child('users').child($uid).child('sales').child($id).child('billingOnly').val() === true) === (root.child('users_meta').child(auth.uid).child('mode').val() === 'faturacao' || (root.child('users_meta').child(auth.uid).child('mode').val() !== 'venda' && root.child('users_meta').child(auth.uid).child('mode').val() !== 'faturacao' && root.child('users').child($uid).child('settings/stockcfg/list/billingMode').val() === true)) && !data.exists() && newData.exists() && newData.child('operator').val() === auth.token.email\",\n                \".validate\": \"newData.hasChildren(['id','saleId','operator','at','format','copy']) && newData.child('id').val() === $event && newData.child('saleId').val() === $id && newData.child('at').isNumber() && (newData.child('format').val() === 'pdf' || newData.child('format').val() === 'print') && (newData.child('copy').val() === 'Original' || newData.child('copy').val() === 'Duplicata')\"\n              }\n            }\n          }\n        },\n        \"drafts\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"cashmoves\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"receipts\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"ncs\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"moves\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"transfers\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"losses\": {\n          \".indexOn\": [\n            \"operator\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'operator' && query.equalTo === auth.token.email\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && data.child('operator').val() === auth.token.email\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('operator').val() === auth.token.email && (!data.exists() || data.child('operator').val() === auth.token.email)\"\n          }\n        },\n        \"settings\": {\n          \"company\": {\n            \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n          },\n          \"tax\": {\n            \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n          },\n          \"stockcfg\": {\n            \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n          },\n          \"payMethods\": {\n            \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n          },\n          \"units\": {\n            \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\"\n          }\n        },\n        \"notifs\": {\n          \".indexOn\": [\n            \"to\"\n          ],\n          \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && query.orderByChild === 'to' && (query.equalTo === auth.token.email || query.equalTo === 'todos')\",\n          \"$id\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && (data.child('to').val() === auth.token.email || data.child('to').val() === 'todos')\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && newData.exists() && newData.child('from').val() === auth.token.email && (!data.exists() || data.child('from').val() === auth.token.email)\"\n          }\n        },\n        \"notifState\": {\n          \"$user\": {\n            \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && $user === root.child('users_meta').child(auth.uid).child('userKey').val()\",\n            \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && $user === root.child('users_meta').child(auth.uid).child('userKey').val()\"\n          }\n        },\n        \"sequences\": {\n          \"billing\": {\n            \"$year\": {\n              \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\",\n              \".write\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\",\n              \".validate\": \"newData.isNumber() && ((!data.exists() && newData.val() >= 1) || newData.val() > data.val())\"\n            }\n          }\n        }\n      }\n    },\n    \"users_meta\": {\n      \"$uid\": {\n        \".read\": \"auth != null && (auth.uid === $uid || ((auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean()) && root.child('users_meta').child(auth.uid).child('admin').val() === true && data.child('workspaceId').val() === root.child('users_meta').child(auth.uid).child('workspaceId').val()))\",\n        \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean()) && root.child('users_meta').child(auth.uid).child('admin').val() === true && newData.exists() && newData.child('workspaceId').val() === root.child('users_meta').child(auth.uid).child('workspaceId').val() && (!data.exists() || data.child('workspaceId').val() === root.child('users_meta').child(auth.uid).child('workspaceId').val())\",\n        \".validate\": \"newData.hasChildren(['uid','email','admin','role','active','workspaceId']) && newData.child('uid').val() === $uid && newData.child('email').isString() && newData.child('admin').isBoolean() && newData.child('active').isBoolean() && ((newData.child('admin').val() === true && newData.child('role').val() === 'admin') || (newData.child('admin').val() === false && (newData.child('role').val() === 'op' || newData.child('role').val() === 'opt'))) && (!newData.child('mode').exists() || newData.child('mode').val() === '' || newData.child('mode').val() === 'venda' || newData.child('mode').val() === 'faturacao')\"\n      }\n    },\n    \"companyMembers\": {\n      \"$uid\": {\n        \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users_meta').child(auth.uid).child('admin').val() === true\",\n        \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users_meta').child(auth.uid).child('admin').val() === true\"\n      }\n    },\n    \"directory\": {\n      \"$uid\": {\n        \".read\": \"auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid\",\n        \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean() && root.child('users_meta').child(auth.uid).child('workspaceId').val() === $uid) && root.child('users_meta').child(auth.uid).child('admin').val() === true\"\n      }\n    },\n    \"teamchat\": {\n      \".indexOn\": [\n        \"to\",\n        \"from\",\n        \"ts\"\n      ],\n      \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean()) && ((query.orderByChild === 'to' && (query.equalTo === 'todos' || query.equalTo === auth.token.email)) || (query.orderByChild === 'from' && query.equalTo === auth.token.email))\",\n      \"$msg\": {\n        \".read\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean()) && (data.child('to').val() === 'todos' || data.child('to').val() === auth.token.email || data.child('from').val() === auth.token.email)\",\n        \".write\": \"(auth != null && root.child('users_meta').child(auth.uid).child('active').val() === true && root.child('users_meta').child(auth.uid).child('admin').isBoolean()) && ((!data.exists() && newData.exists() && newData.child('from').val() === auth.token.email) || (data.exists() && data.child('from').val() === auth.token.email && (!newData.exists() || newData.child('from').val() === data.child('from').val())) || (root.child('users_meta').child(auth.uid).child('admin').val() === true && data.exists() && !newData.exists()))\",\n        \".validate\": \"newData.hasChildren(['id','from','to','text','ts']) && newData.child('id').val() === $msg && newData.child('text').isString() && newData.child('text').val().length <= 500 && newData.child('ts').isNumber()\"\n      }\n    }\n  }\n}";
function copyChatRules() {
  const done = () => toast('Regras copiadas. Cole em Firebase Console → Realtime Database → Regras → Publicar.', 'success');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(CHAT_RULES_TEXT).then(done).catch(() => {});
      return;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = CHAT_RULES_TEXT; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
  } catch (_) { toast('Abra o ficheiro regras-firebase.json na pasta da aplicação e copie o conteúdo.', 'info'); }
}
function renderChat() {
  const body = $('chatBody'); if (!body) return;
  renderChatTo();
  const who = chatPeerKey();
  const list = chatList().filter(m => chatThread(m, who));
  const isAdmin = currentRole() === 'admin';
  body.innerHTML = '';
  if (!list.length) body.innerHTML = '<p class="chat-empty">' + (who === CHAT_ALL
    ? 'Sem mensagens da equipa. Escreva a primeira.'
    : 'Sem mensagens com ' + esc(userNameOf(who)) + '. Escreva a primeira.') + '</p>';
  let previousDay='';
  list.slice(-300).forEach(m => {
    const day=dayKey(new Date(Number(m.ts)||Date.now()).toISOString());
    if(day!==previousDay){const separator=document.createElement('div');separator.className='chat-day';separator.textContent=day===todayISO()?'Hoje':fmtDate(day);body.appendChild(separator);previousDay=day;}
    const d = document.createElement('div');
    d.className = 'chat-msg' + (chatMine(m) ? ' mine' : '');
    d.innerHTML = (who===CHAT_ALL && !chatMine(m)?'<span class="cm-meta">'+esc(m.name || userNameOf(m.from))+'</span>':'') + '<span class="cm-text">'+esc(m.text || '')+'</span><time class="cm-time" title="'+esc(fmtDateTime(m.ts))+'">'+esc(fmtTime(m.ts))+'</time>';
    if (isAdmin) {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'cm-del'; x.title = 'Apagar mensagem'; x.textContent = '✕';
      x.onclick = (e) => { e.stopPropagation(); deleteChatMsg(m); };
      d.appendChild(x);
    }
    body.appendChild(d);
  });
  requestAnimationFrame(()=>{const messages=[...body.querySelectorAll('.chat-msg')].slice(-5);const height=messages.reduce((total,message)=>total+(message.offsetHeight||64),0)+Math.max(0,messages.length-1)*12+54;body.style.height=Math.max(260,Math.min(420,height))+'px';body.scrollTop=body.scrollHeight;});
  if ($('btnChatClear')) $('btnChatClear').style.display = (isAdmin && list.length) ? '' : 'none';
  if ($('chatWho')) $('chatWho').textContent = who === CHAT_ALL
    ? 'Equipa · ' + (isAdmin ? 'Administrador' : 'Operador')
    : userNameOf(who) + ' · ' + chatRoleOf(who);
  const net = $('chatNet');
  if (net) {
    const online = !!(rdb && cloudUid() && isOnline());
    const rulesBtn = '<button type="button" class="btn small" id="btnChatRules" title="Copiar as regras do Firebase">Copiar regras</button>';
    if (!online) {
      net.innerHTML = '<span>Sem sessão de email — as mensagens ficam neste terminal.</span>';
      net.classList.add('off');
    } else if (chatCloudDenied && chatFallbackOk) {
      net.innerHTML = '<span>Ligação limitada</span>';
      net.classList.add('off');
    } else if (chatCloudDenied) {
      net.innerHTML = '<span>Não foi possível ligar ao chat. Tente novamente.</span>';
      net.classList.add('off');
    } else {
      net.textContent = '● Ligado';
      net.classList.remove('off');
    }
    const rb = $('btnChatRules');
    if (rb) rb.onclick = (e) => { e.stopPropagation(); copyChatRules(); };
  }
  const pop = $('chatPopup');
  if (pop && pop.style.display !== 'none' && pop.style.display !== '') { positionChatPopup(); markChatSeen(who); }
  updateChatBadge();
}
function markChatSeen(who) {
  const sel = String(who || chatPeerKey()).toLowerCase();
  let ch = false;
  chatMsgs.forEach(m => {
    if (chatSeen.indexOf(m.id) !== -1 || chatMine(m)) return;
    if (chatThread(m, sel)) { chatSeen.push(m.id); ch = true; }
  });
  if (chatSeen.length > 800) chatSeen = chatSeen.slice(-800);
  if (ch) save('dec_chat_seen', chatSeen);
  updateChatBadge();
}
function sendChat() {
  const inp = $('chatInput'); if (!inp) return;
  const text = String(inp.value || '').trim();
  if (!text) return;
  const who = chatPeerKey();
  const m = { id: 'ch-' + uid(), from: String(currentUser || '').toLowerCase(), to: who, name: userNameOf(currentUser), text: text, ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  chatMsgs.push(m);
  chatSeen.push(m.id);
  save('dec_chat_seen', chatSeen);
  save('dec_chat_to', who);
  save('dec_chat', chatMsgs);
  chatCloudSend(m);
  inp.value = '';
  syncChatSend();
  renderChat();
}
function deleteChatMsg(m) {
  if (currentRole() !== 'admin') return toast('Só o administrador pode apagar o chat.', 'warning');
  if (!m) return;
  if (chatDeleted.indexOf(m.id) === -1) chatDeleted.push(m.id);
  if (chatDeleted.length > 1000) chatDeleted = chatDeleted.slice(-1000);
  chatMsgs = chatMsgs.filter(x => x.id !== m.id);
  save('dec_chat', chatMsgs);
  save('dec_chat_del', chatDeleted);
  chatCloudDelete(m.id);
  renderChat();
}
async function clearChat() {
  if (currentRole() !== 'admin') return toast('Só o administrador pode apagar o chat.', 'warning');
  const who = chatPeerKey();
  const list = chatList().filter(m => chatThread(m, who));
  if (!list.length) return toast('Esta conversa já está vazia.', 'info');
  const label = who === CHAT_ALL ? 'a conversa da equipa' : 'a conversa com ' + userNameOf(who);
  if (!await confirmDlg('Limpar chat?', 'Todas as ' + list.length + ' mensagem(ns) de ' + label + ' serão apagadas para todos.')) return;
  list.forEach(m => {
    if (chatDeleted.indexOf(m.id) === -1) chatDeleted.push(m.id);
    chatCloudDelete(m.id);
  });
  chatMsgs = chatMsgs.filter(m => !list.some(x => x.id === m.id));
  save('dec_chat', chatMsgs);
  save('dec_chat_del', chatDeleted);
  renderChat();
  toast('Chat limpo.', 'success');
}
if ($('btnTopChat')) $('btnTopChat').onclick = (e) => {
  e.stopPropagation();
  const p = $('chatPopup'); if (!p) return;
  const isOpen = p.style.display !== 'none' && p.style.display !== '';
  if (isOpen) { p.style.display = 'none'; return; }
  try { if (p.parentElement !== document.body) document.body.appendChild(p); } catch (_) {}
  p.style.display = 'flex';
  positionChatPopup();
  try { startChatWatch(); } catch (_) {}
  renderChat();
  setTimeout(() => { positionChatPopup(); try { $('chatInput').focus(); } catch (_) {} }, 30);
};
if ($('btnChatClose')) $('btnChatClose').onclick = () => { $('chatPopup').style.display = 'none'; $('chatRecipientMenu')?.remove(); $('chatRecipientButton')?.setAttribute('aria-expanded','false'); };
window.addEventListener('resize', () => { if (chatPopupOpen()) positionChatPopup(); });
if ($('chatTo')) $('chatTo').onchange = () => {
  save('dec_chat_to', chatPeerKey());
  renderChat();
  setTimeout(() => { try { $('chatInput').focus(); } catch (_) {} }, 20);
};
const emojiPicker=$('chatEmojiPicker');
if(emojiPicker) {
  ['😀','😊','😂','😍','👍','👏','🙌','🙏','❤️','🎉','✅','📦','🧾','💰','📌','🤝','👋','🤔','😅','🚀','⚠️','❓','💡','👌'].forEach(emoji=>{
    const button=document.createElement('button');button.type='button';button.textContent=emoji;button.setAttribute('aria-label','Inserir '+emoji);
    button.onclick=()=>{const input=$('chatInput'),start=input.selectionStart??input.value.length,end=input.selectionEnd??start;if(input.value.length-(end-start)+emoji.length>input.maxLength)return;input.setRangeText(emoji,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();emojiPicker.hidden=true;$('btnChatEmoji').setAttribute('aria-expanded','false');};emojiPicker.appendChild(button);
  });
  $('btnChatEmoji').onclick=()=>{emojiPicker.hidden=!emojiPicker.hidden;$('btnChatEmoji').setAttribute('aria-expanded',String(!emojiPicker.hidden));if(!emojiPicker.hidden)emojiPicker.querySelector('button').focus();};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!emojiPicker.hidden){emojiPicker.hidden=true;$('btnChatEmoji').setAttribute('aria-expanded','false');$('btnChatEmoji').focus();}});
}
function syncChatSend() {if($('btnChatSend')) $('btnChatSend').disabled=!String($('chatInput')?.value||'').trim();}
if($('chatInput')) $('chatInput').addEventListener('input',syncChatSend);
syncChatSend();
if ($('btnChatSend')) $('btnChatSend').onclick = sendChat;
if ($('chatInput')) $('chatInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
};
if ($('btnChatClear')) $('btnChatClear').onclick = clearChat;
document.addEventListener('click', (e) => {
  const p = $('chatPopup'); if (!p || p.style.display === 'none' || p.style.display === '') return;
  if (e.target && e.target.closest && (e.target.closest('#chatPopup') || e.target.closest('#btnTopChat'))) return;
  p.style.display = 'none';
});
/* Outro separador/janela do mesmo computador: atualiza o chat sem esperar pela nuvem. */
window.addEventListener('storage', (e) => {
  if (!e || (e.key !== 'dec_chat' && e.key !== 'dec_chat_seen')) return;
  try {
    if (e.key === 'dec_chat') chatMsgs = load('dec_chat', []);
    if (e.key === 'dec_chat_seen') chatSeen = load('dec_chat_seen', []);
    updateChatBadge();
    if (chatPopupOpen()) renderChat();
  } catch (_) {}
});

/* ---------- boot ---------- */
function renderPinStatus() { const el = $('pinStatus'); if (el) el.textContent = load(LS.pin, null) ? 'definido' : 'por definir'; }
/* Uma interação comum, incluindo formulários criados dinamicamente. */
function enhanceEntryFields(root=document) {
  root.querySelectorAll('input.search:not([type]),input.search[type="text"]').forEach(input=>{input.type='search';});
  root.querySelectorAll('label:not([for])').forEach(label=>{
    let field=label.nextElementSibling;
    if(field && !field.matches('input,select,textarea')) field=field.querySelector('input,select,textarea');
    if(field?.id && !label.querySelector('input,select,textarea')) label.htmlFor=field.id;
  });
}
enhanceEntryFields();
document.addEventListener('focusin',e=>{
  const field=e.target;if(!field.matches('input,select,textarea'))return;
  const group=field.closest('.combo,.qty-wrap,.inp-wrap');if(group)group.classList.add('entry-focused');
});
document.addEventListener('focusout',e=>{
  const field=e.target;if(!field.matches('input,select,textarea'))return;
  field.classList.add('entry-touched');
  const group=field.closest('.combo,.qty-wrap,.inp-wrap');if(group && !group.contains(e.relatedTarget))group.classList.remove('entry-focused');
});
document.addEventListener('invalid',e=>{if(e.target.matches('input,select,textarea'))e.target.classList.add('entry-touched');},true);
function syncSaleWorkspace() {
  const view=$('view-sales'), form=$('saleFormPanel'), calc=$('calcPanel');
  const visible=el=>el && el.style.display!=='none';
  document.body.classList.toggle('sale-form-open',visible(view) && (visible(form)||visible(calc)));
}
if(window.MutationObserver) {
  const workspaceObserver=new MutationObserver(syncSaleWorkspace);
  ['view-sales','saleFormPanel','calcPanel'].forEach(id=>{if($(id))workspaceObserver.observe($(id),{attributes:true,attributeFilter:['style']});});
}
syncSaleWorkspace();
// Durante a seleção, o corpo da linha marca registos em vez de executar ações individuais.
document.addEventListener('click',e=>{
  const row=e.target.closest('table.selection-enabled tbody tr');if(!row)return;
  const checkbox=row.querySelector('input[type="checkbox"]');if(!checkbox || e.target===checkbox)return;
  e.preventDefault();e.stopImmediatePropagation();checkbox.click();
},true);
document.addEventListener('keydown',e=>{
  const row=e.target.closest('table.selection-enabled tbody tr');if(!row || e.target.matches('input[type="checkbox"]'))return;
  if(e.key==='Enter' || e.key===' '){e.preventDefault();e.stopImmediatePropagation();row.querySelector('input[type="checkbox"]')?.click();}
},true);
// Cada lista controla a sua seleção e revela ações apenas após marcar registos.
document.querySelectorAll('[data-selection-table]').forEach(button=>{
  button.onclick=e=>{
    e.stopPropagation();
    const table=$(button.dataset.selectionTable);if(!table)return;
    const active=table.classList.toggle('selection-enabled');
    button.setAttribute('aria-pressed',String(active));button.textContent=active?'Cancelar seleção':'Selecionar';
    if(!active){
      const sets={saleTable:saleSelected,prodTable:prodSelected,ncTable:ncSelected,payMovesTable:payMovSelected};sets[table.id]?.clear();
      table.querySelectorAll('input[type="checkbox"]').forEach(cb=>{cb.checked=false;cb.indeterminate=false;});
      const update={saleTable:renderSaleBulk,prodTable:renderProdBulk,ncTable:renderNcBulk,payMovesTable:payMovBulkUpdate};update[table.id]?.();
    }
  };
});
function renderAll() { renderDash(); renderSales(); renderNc(); renderSup(); renderCli(); renderClients(); renderStock(); renderProducts(); renderTrans(); renderCash(); renderPays(); renderQueue(); renderPinStatus(); renderPayUnits(); renderCompany(); renderTax(); renderStockCfg(); renderUsers(); renderDraftBadge(); renderTopUser(); updateNotifBadge(); updateChatBadge(); if ($('view-notifs') && $('view-notifs').style.display !== 'none') renderNotifs(); if ($('chatPopup') && $('chatPopup').style.display !== 'none' && $('chatPopup').style.display !== '') renderChat(); applyRole(); if (currentSup) renderDetail(); if (currentCli) renderCliDetail(); if (currentPaySup) renderPayDetail(); }
netUI(); if (queue.length > 500) compactQueue(); renderQueue(); renderPinStatus(); renderPayUnits(); renderCompany(); renderTax(); renderStockCfg(); renderUsers(); applyRole(); normalizeStock();
if ($('finMonthBox')) $('finMonthBox').open = false;
/* Painel «Ao vivo»: relógio e movimentos do dia atualizados a cada 15 segundos */
const liveTicker = setInterval(() => {
  try {
    if (!currentUser) return;
    if (!$('view-dashboard') || $('view-dashboard').style.display === 'none') return;
    renderLive();
  } catch (_) {}
}, 15000);
if (liveTicker && typeof liveTicker.unref === 'function') liveTicker.unref();
try { window.__decLiveTicker = liveTicker; } catch (_) {}
/* Recupera filas offline e listeners cancelados sem reiniciar a aplicação. */
function recoverRealtime() {
  if (systemRestoreInProgress || !rdb || !cloudUid() || !isOnline()) return;
  startDataWatch(); startChatWatch();
  if (queue.length && !isSyncing) syncNow(true);
}
const realtimeRecovery = setInterval(recoverRealtime, 5000);
if (realtimeRecovery && typeof realtimeRecovery.unref === 'function') realtimeRecovery.unref();
window.addEventListener('focus', recoverRealtime);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recoverRealtime(); });
/* Rede: de 60 em 60 segundos verifica a nuvem (recebe stock real e pedidos do administrador) */
if (rdb) setInterval(() => {
  try {
    if (currentUser && $('view-dashboard') && $('view-dashboard').style.display !== 'none') renderLive();
    if (!isOnline() || !cloudUid()) return;
    if ($('loginScreen') && $('loginScreen').style.display !== 'none') return;
    pullFromCloud();
    maybeSyncReport();
  } catch (_) {}
}, 60000);
$('saleFormPanel').style.display = 'none'; if ($('saleItemsPanel')) $('saleItemsPanel').style.display = 'none';
function openStock() { if(billingMode()) return; renderStock(); $('stockModal').style.display = 'flex'; if ($('searchStock')) { $('searchStock').value = ''; renderStock(); setTimeout(() => $('searchStock').focus(), 50); } }
function sellDirect(name) {
  goViewNow('sales');
  setSaleKind('venda');
  const row = document.querySelector('#saleRows .prod-row');
  if (row && name) {
    const s = stock.find(x => (x.name || '').toLowerCase() === String(name).toLowerCase());
    if (s) pickStock(row, s);
    else row.querySelector('.p-desc').value = name;
    recalcForm('saleRows');
  }
}
function closeStock() { $('stockModal').style.display = 'none'; if ($('searchStock')) $('searchStock').value = ''; }
$('btnCloseStock').onclick = closeStock;
if ($('btnBackSales')) $('btnBackSales').onclick = () => {
  const choosing = $('saleChoiceWrap') && $('saleChoiceWrap').style.display !== 'none';
  if (choosing) goView('dashboard'); else showSaleChoice();
};
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => goView('dashboard'));
if ($('btnCloseTransDetail')) $('btnCloseTransDetail').onclick = () => { $('transDetailModal').style.display = 'none'; };
if ($('btnPdfTransDetail')) $('btnPdfTransDetail').onclick = () => {
  const t = transfers.find(x => x.id === $('transDetailModal').dataset.tid);
  if (t && window.jspdf) gtiPdf(t);
};
if ($('sIva')) $('sIva').onchange = (e) => { e.target.dataset.touched = '1'; };
document.querySelectorAll('#saleTypeCards .type-card').forEach(c => {
  c.onclick = () => { setSaleKind(c.dataset.kind); };
  c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSaleKind(c.dataset.kind); } };
});
$('btnCloseStock').onclick = closeStock;
$('stockModal').addEventListener('click', (e) => { if (e.target === $('stockModal')) closeStock(); });
// Abas de configurações
document.querySelectorAll('[data-set]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-set]').forEach(x => x.classList.toggle('active', x === b));
  const k = b.dataset.set;
  document.querySelectorAll('[data-setpane]').forEach(p => { p.style.display = p.dataset.setpane === k ? '' : 'none'; });
});
if ($('btnSaveStockCfg')) $('btnSaveStockCfg').onclick = async () => {
  if (currentRole() !== 'admin') return toast('Acesso Administrador.', 'error');
  const previousBillingMode=billingMode();
  const cfg = { billingMode: $('stBillingMode').value === '1', marginOn: $('stMarginOn').value === '1' ? 1 : 0, margin: Number($('stMargin').value) || 0, scope: $('stMarginScope').value, origin: $('stOrigin').value === 'loja' ? 'loja' : 'armazem', useLoja: $('stUseLoja').value === '1' ? 1 : 0, updatedAt: Date.now() };
  try {
    localStorage.setItem('dec_stockcfg', JSON.stringify(cfg));
    const cur = stockCfg();
    if (cur.useLoja && $('sLoc')) { /* mantém escolha do operador */ }
    else if ($('sLoc')) $('sLoc').value = 'armazem';
  } catch (_) {}
  pushQueue({ type: 'settings', payload: { key: 'stockcfg', list: cfg } });
  if ($('sNumber')) $('sNumber').value = nextSaleNumber(cfg.billingMode ? 'cotacao' : 'venda');
  persist();
  if(previousBillingMode!==cfg.billingMode) { await logoutAndReload(); return; }
  renderAll(); toast('Configuração de stock guardada.', 'success');
};
if($('stBillingMode')) $('stBillingMode').onchange=()=>{if(currentRole()==='admin') return $('btnSaveStockCfg').onclick();};
function renderStockCfg() {
  const c = stockCfg();
  if ($('stBillingMode')) $('stBillingMode').value = c.billingMode ? '1' : '0';
  if ($('stMarginOn')) $('stMarginOn').value = c.marginOn ? '1' : '0';
  if ($('stMargin')) $('stMargin').value = c.margin || 0;
  if ($('stMarginScope')) $('stMarginScope').value = c.scope || 'global';
  if ($('stOrigin')) $('stOrigin').value = c.origin || 'armazem';
  if ($('stUseLoja')) $('stUseLoja').value = c.useLoja ? '1' : '0';
}
// Sub-abas de produtos
const prodTab = (k) => {
  [['tabProdStock', 'prodPaneStock'], ['tabProdMoves', 'prodPaneMoves'], ['tabProdTrans', 'prodPaneTrans']].forEach(([b, p]) => {
    if ($(b)) $(b).classList.toggle('active', b === k);
    if ($(p)) $(p).style.display = p === k.replace('tabProd', 'prodPane') ? 'block' : 'none';
  });
};
if ($('tabProdStock')) $('tabProdStock').onclick = () => prodTab('tabProdStock');
if ($('tabProdMoves')) $('tabProdMoves').onclick = () => prodTab('tabProdMoves');
if ($('tabProdTrans')) $('tabProdTrans').onclick = () => prodTab('tabProdTrans');
if ($('prodCheckAll')) $('prodCheckAll').onchange = (e) => {
  if (e.target.checked) lastProdList.forEach(s => prodSelected.add(s.id));
  else lastProdList.forEach(s => prodSelected.delete(s.id));
  renderProducts();
};
if ($('btnBulkDel')) $('btnBulkDel').onclick = async () => {
  if (currentRole() !== 'admin') return toast('Eliminar: acesso Administrador.', 'error');
  if (!prodSelected.size) return;
  const n = prodSelected.size;
  if (!await confirmDlg('Eliminar selecionados?', n + ' produto(s) serão removidos.')) return;
  toast('A eliminar ' + n + ' produto(s)…', 'info');
  const ops = [...prodSelected].map(id => ({ type: 'delete-stock', payload: { id } }));
  stock = stock.filter(s => !prodSelected.has(s.id));
  prodSelected.clear();
  pushQueueBulk(ops);
  persist(); renderAll();
  toast(n + ' produto(s) eliminados.', 'success');
};
if ($('btnBulkAdj')) $('btnBulkAdj').onclick = () => { const id = [...prodSelected][0]; const s = stock.find(x => x.id === id); if (s) { $('aProd').value = s.name; $('adjModal').style.display = 'flex'; } };
if ($('btnBulkPmp')) $('btnBulkPmp').onclick = () => {
  prodSelected.forEach(id => {
    const s = stock.find(x => x.id === id); if (!s) return;
    const m = s.margin != null ? Number(s.margin) : 0;
    s.price = Math.round((Number(s.cost) || 0) * (1 + m / 100) * 100) / 100;
    s.updatedAt = Date.now(); pushQueue({ type: 'stock', payload: { ...s } });
  });
  persist(); renderAll(); toast('PMP recalculado.', 'success');
};
if ($('btnBulkKar')) $('btnBulkKar').onclick = () => { const id = [...prodSelected][0]; if (id) { $('kardexProd').value = id; prodTab('tabProdMoves'); renderKardex(); } };
if ($('btnBulkZero')) $('btnBulkZero').onclick = async () => {
  if (currentRole() === 'op') return toast('Zerar stock: acesso do nível Caixa com Transferências.', 'error');
  if (!prodSelected.size) return;
  if (!await confirmDlg('Zerar stock?', prodSelected.size + ' produto(s) ficam com Loja = 0 e Armazém = 0. O Kardex regista a saída.')) return;
  toast('A zerar stock…', 'info');
  const ops = [];
  prodSelected.forEach(id => {
    const s = stock.find(x => x.id === id); if (!s) return;
    const tot = stockTotal(s);
    if (tot > 0) {
      const mv = { id: uid(), productId: s.id, name: s.name, date: todayISO(), type: 'saida', qty: -tot, after: 0, loc: (Number(s.qArm) || 0) >= (Number(s.qLoja) || 0) ? 'armazem' : 'loja', ref: 'ZERAR', reason: 'Zerar stock', ts: Date.now() };
      movements.push(mv); ops.push({ type: 'move', payload: { ...mv } });
    }
    s.qLoja = 0; s.qArm = 0; s.updatedAt = Date.now();
    ops.push({ type: 'stock', payload: { ...s } });
  });
  prodSelected.clear();
  pushQueueBulk(ops);
  persist(); renderAll();
  toast('Stock zerado.', 'success');
};
if ($('btnStockExp')) $('btnStockExp').onclick = async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Produtos');
  ws.columns = [{ width: 16 }, { width: 34 }, { width: 16 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }];
  const h = ws.addRow(['SKU', 'Nome', 'Categoria', 'Unidade', 'Loja', 'Armazém', 'Preço', 'Custo', 'Margem', 'Mín']);
  h.font = { bold: true };
  stock.forEach(s => ws.addRow([s.sku || '', s.name, s.cat || '', s.unit || '', Number(s.qLoja) || 0, Number(s.qArm) || 0, Number(s.price) || 0, Number(s.cost) || 0, Number(s.margin != null ? s.margin : 0), Number(s.min) || 0]));
  const buf = await wb.xlsx.writeBuffer(); dl(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'EXCEL-STK_produtos.xlsx');
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ['supModal', 'expModal', 'stockModal', 'adjModal', 'cliModal', 'ncModal', 'rcModal', 'ocModal', 'supRetModal', 'payInvModal', 'invViewModal', 'prodModal', 'guiaModal', 'movModal', 'transModal', 'transDetailModal', 'exitStockModal'].forEach(id => { const m = $(id); if (m) m.style.display = 'none'; }); closeSugg(); editingProdId = null; reopenStockAfterProd = false; if ($('infoModal').style.display !== 'none') closeInfo(); if ($('invModal').style.display !== 'none') closeInvModal(); return; }
  if ((e.key === 'F2' || e.key === 'F3' || e.key === 'F4') && $('app') && $('app').style.display !== 'none') {
    e.preventDefault();
    const kind = e.key === 'F2' ? 'venda' : e.key === 'F3' ? 'credito' : 'cotacao';
    guardSaleDraft(() => { goViewNow('sales', false); setSaleKind(kind); });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's' && $('app').style.display !== 'none') {
    e.preventDefault();
    openStock();
  }
});
if($('btnAddUser'))$('btnAddUser').onclick=async()=>{
  if(!accountAccess || !auth?.currentUser || !isOnline())return toast('Entre com email e palavra-passe e ligue à internet para gerir contas.','error');
  const button=$('btnAddUser');button.disabled=true;
  try {
    await accountAccess.requireAdmin();
    const email=$('uEmail').value.trim().toLowerCase(),name=$('uName').value.trim(),role=$('uRole').value,pin=$('uPin').value.trim(),mode=$('uMode')?$('uMode').value:'';
    if(pin && !/^\d{4,6}$/.test(pin))throw Error('PIN: 4–6 dígitos numéricos.');
    const pinHash=pin?bcrypt.hashSync(pin,10):'';let profile;
    if(editingUserEmail){const existing=appUsers().find(u=>u.email.toLowerCase()===editingUserEmail.toLowerCase());const changes={name,role,mode,admin:role==='admin',...(pin?{pinHash}: {})};profile=existing?.uid ? await accountAccess.update(existing.uid,changes) : await accountAccess.updateByEmail(editingUserEmail,changes);}
    else profile=await accountAccess.create({email,password:$('uPassword').value,name,role,pinHash,mode});

    const users=appUsers().filter(u=>u.email.toLowerCase()!==profile.email.toLowerCase());users.push(profile);saveUsers(users);pushUsersMap();resetUserForm();renderUsers();toast('Conta Firebase autorizada: '+profile.email,'success');
  } catch(error){toast('Conta não criada/atualizada: '+error.message,'error');}
  finally{button.disabled=false;if($('uPassword'))$('uPassword').value='';}
};

if ($('uPin')) $('uPin').addEventListener('input', (e) => { e.target.value = String(e.target.value || '').replace(/\D/g, '').slice(0, 6); });
if ($('btnCancelUser')) $('btnCancelUser').onclick = () => resetUserForm();
if ($('btnImportUsers')) $('btnImportUsers').onclick = () => importCloudUsers();
if ($('btnReporHist')) $('btnReporHist').onclick = async () => {
  if (currentRole() !== 'admin') return toast('Acesso Administrador.', 'error');
  toast('A recarregar históricos…', 'info');
  await pullFromCloud();
  normalizeStock(); persist(); renderAll();
  toast('Históricos repostos: ' + sales.length + ' vendas, ' + invoices.length + ' compras.', 'success');
};
/* ---------- Limpeza do administrador: notificações dos vendedores ---------- */
function setCleanStatus(msg) { const el = $('cleanStatus'); if (el) el.textContent = msg; }
function cleanSellerNotifications(all) {
  if (currentRole() !== 'admin') return toast('Limpeza: acesso Administrador.', 'error');
  const adminEmails = new Set(appUsers().filter(u => (u.role || '') === 'admin').map(u => String(u.email || '').toLowerCase()));
  const me = String(currentUser || '').toLowerCase();
  const targets = notifs.filter(n => {
    if (all) return true;
    const from = String(n.from || '').toLowerCase(), to = String(n.to || '').toLowerCase();
    const sellerFrom = from && from !== me && !adminEmails.has(from);
    const sellerTo = to && to !== 'admin' && to !== 'all' && !adminEmails.has(to);
    return !!(sellerFrom || sellerTo);
  });
  let sysCount = 0;
  if (all) { try { sysCount = sysAlerts().length; } catch (_) {} }
  if (!targets.length && !sysCount) {
    const msg = 'Não há notificações de vendedores para apagar.';
    setCleanStatus(msg); return toast(msg, 'info');
  }
  const ids = targets.map(n => n.id).filter(Boolean);
  ids.forEach(notifTombstone);
  const drop = new Set(ids);
  notifs = notifs.filter(n => !drop.has(n.id));
  if (all) {
    try {
      sysAlerts().forEach(a => { if (a && a.id) { notifTombstone(a.id); seenAdd(a.id); } });
    } catch (_) {}
  }
  notifCloudDelete(ids);
  persist(); updateNotifBadge();
  if ($('view-notifs') && $('view-notifs').style.display !== 'none') { try { renderNotifs(); } catch (_) {} }
  const msg = ids.length + ' notificação(ões) apagada(s).';
  setCleanStatus(msg); toast(msg, 'success');
}
if ($('btnCleanSellerNotifs')) $('btnCleanSellerNotifs').onclick = () => cleanSellerNotifications(false);
if ($('btnCleanAllNotifs')) $('btnCleanAllNotifs').onclick = () => cleanSellerNotifications(true);
if ($('btnCleanMoves')) $('btnCleanMoves').onclick = () => { setCleanStatus('Escolha as categorias a zerar…'); openWipeModal(); };
/* ---------- Zerar movimentos por categoria (exclusivo do administrador) ---------- */
function wipeOptions() {
  const sum = (arr) => arr.reduce((a, x) => a + (Number(x.total != null ? x.total : x.amount) || 0), 0);
  const sVd = sales.filter(s => saleKind(s) === 'venda');
  const sFt = sales.filter(s => saleKind(s) === 'credito');
  const sFp = sales.filter(s => saleKind(s) === 'cotacao');
  const cashIn = cashMoves.filter(m => m.type === 'entrada');
  const cashOut = cashMoves.filter(m => m.type === 'saida');
  const manualOut = cashMoves.filter(m => !m.auto && m.type === 'saida');
  const lossTotal = stockLosses.reduce((a, l) => a + (Number(l.total) || 0), 0);
  return [
    { group: 'Vendas e clientes', key: 'sales_vd', label: 'Vendas a pronto (VD)', n: sVd.length, hint: sVd.length + ' documento(s) · ' + MZN(sum(sVd)) + ' · repõe o stock e remove o dinheiro associado' },
    { group: 'Vendas e clientes', key: 'sales_ft', label: 'Vendas a crédito (FT)', n: sFt.length, hint: sFt.length + ' documento(s) · ' + MZN(sum(sFt)) + ' · repõe o stock; recibos e NC associados também saem' },
    { group: 'Vendas e clientes', key: 'sales_fp', label: 'Proformas (FP)', n: sFp.length, hint: sFp.length + ' documento(s) · não mexe no stock nem no dinheiro' },
    { group: 'Vendas e clientes', key: 'receipts', label: 'Recebimentos de clientes', n: receipts.length, hint: receipts.length + ' recibo(s) · ' + MZN(sum(receipts)) + ' · remove as entradas automáticas e reduz o valor pago das vendas' },
    { group: 'Vendas e clientes', key: 'ncs', label: 'Notas de crédito (NC)', n: ncs.length, hint: ncs.length + ' nota(s) · ' + MZN(sum(ncs)) + ' · retira o stock que tinha sido devolvido' },
    { group: 'Compras e fornecedores', key: 'invoices', label: 'Faturas de compra', n: invoices.length, hint: invoices.length + ' fatura(s) · ' + MZN(sum(invoices)) },
    { group: 'Compras e fornecedores', key: 'suppays', label: 'Pagamentos a fornecedores', n: supPayments.length, hint: supPayments.length + ' pagamento(s) · ' + MZN(sum(supPayments)) + ' · remove as saídas de caixa associadas' },
    { group: 'Compras e fornecedores', key: 'supreturns', label: 'Devoluções a fornecedores', n: supReturns.length, hint: supReturns.length + ' documento(s) · ' + MZN(sum(supReturns)) },
    { group: 'Compras e fornecedores', key: 'porders', label: 'Ordens de compra (OC)', n: porders.length, hint: porders.length + ' encomenda(s)' },
    { group: 'Compras e fornecedores', key: 'supadj', label: 'Ajustes de saldo de fornecedores', n: supAdjustments.length, hint: supAdjustments.length + ' ajuste(s) · o saldo volta a refletir os documentos' },
    { group: 'Caixa e despesas', key: 'cash_all', label: 'Todo o caixa — entradas e saídas', n: cashMoves.length + cashDays.length, hint: cashMoves.length + ' movimento(s) · entradas ' + MZN(sum(cashIn)) + ' · saídas ' + MZN(sum(cashOut)) + ' · zera «Recebido de clientes», «Resumo total» e «Resumo por mês»' },
    { group: 'Caixa e despesas', key: 'expenses', label: 'Despesas e saídas manuais', n: manualOut.length, hint: manualOut.length + ' saída(s) · ' + MZN(sum(manualOut)) },
    { group: 'Caixa e despesas', key: 'losses', label: 'Perdas de stock (quebras/consumo)', n: stockLosses.length, hint: stockLosses.length + ' perda(s) · ' + MZN(lossTotal) },
    { group: 'Stock e histórico', key: 'transfers', label: 'Transferências internas (GTI)', n: transfers.length, hint: transfers.length + ' guia(s) · repõe as quantidades nos locais de origem' },
    { group: 'Stock e histórico', key: 'moves', label: 'Kardex — movimentos de stock', n: movements.length, hint: movements.length + ' movimento(s) · apaga só o histórico, não altera as quantidades' },
    { group: 'Outros', key: 'drafts', label: 'Rascunhos por terminar', n: drafts.length, hint: drafts.length + ' rascunho(s)' }
  ];
}
function wipeSelectedKeys() {
  return [...document.querySelectorAll('#wipeRows .wipe-cb:checked')].map(c => c.dataset.key);
}
function wipeSync() {
  const all = [...document.querySelectorAll('#wipeRows .wipe-cb:not(:disabled)')];
  const st = !!($('wipeStock') && $('wipeStock').checked);
  if ($('wipeAll')) $('wipeAll').checked = !!(all.length && all.every(c => c.checked) && st);
  const n = all.filter(c => c.checked).length;
  if ($('wipeSummary')) $('wipeSummary').textContent = (n || st)
    ? 'Selecionado: ' + n + ' categoria(s)' + (st ? ' + quantidades de stock' : '') + '.'
    : 'Nada selecionado. Escolha o que apagar.';
}
function wipeRender() {
  const box = $('wipeRows'); if (!box) return;
  box.innerHTML = '';
  let lastGroup = '';
  wipeOptions().forEach(o => {
    if (o.group !== lastGroup) {
      lastGroup = o.group;
      const g = document.createElement('div');
      g.className = 'wipe-group';
      g.textContent = o.group;
      box.appendChild(g);
    }
    const lb = document.createElement('label');
    lb.className = 'wipe-row';
    lb.innerHTML = '<input type="checkbox" class="wipe-cb" data-key="' + esc(o.key) + '"' + (o.n ? '' : ' disabled') + ' />'
      + '<span><strong>' + esc(o.label) + ' (' + o.n + ')</strong><small>' + esc(o.hint) + '</small></span>';
    const cb = lb.querySelector('input');
    if (cb) cb.onchange = wipeSync;
    box.appendChild(lb);
  });
  if ($('wipeStock')) { $('wipeStock').checked = false; $('wipeStock').onchange = wipeSync; }
  if ($('wipeAll')) { $('wipeAll').checked = false; $('wipeAll').onchange = () => {
    const on = !!$('wipeAll').checked;
    document.querySelectorAll('#wipeRows .wipe-cb:not(:disabled)').forEach(c => { c.checked = on; });
    if ($('wipeStock')) $('wipeStock').checked = on;
    wipeSync();
  }; }
  wipeSync();
}
function openWipeModal() {
  if (currentRole() !== 'admin') return toast('Zerar movimentos: acesso Administrador.', 'error');
  wipeRender();
  if ($('wipeModal')) $('wipeModal').style.display = 'flex';
}
function wipeApply(sel, stockQty) {
  const ops = [];
  const del = (type, id) => { if (id) ops.push({ type, payload: { id } }); };
  const delCash = (ref) => {
    if (sel.has('cash_all') || !ref) return;
    const gone = cashMoves.filter(m => m.auto && String(m.ref || '') === String(ref));
    if (!gone.length) return;
    gone.forEach(m => del('delete-cashmove', m.id));
    cashMoves = cashMoves.filter(m => !(m.auto && String(m.ref || '') === String(ref)));
  };
  const rmSale = (s) => {
    receipts.filter(r => (r.allocations || []).some(a => a.saleId === s.id)).forEach(r => {
      del('delete-receipt', r.id);
      delCash(r.number);
    });
    receipts = receipts.filter(r => !(r.allocations || []).some(a => a.saleId === s.id));
    ncs.filter(n => n.saleId === s.id).forEach(n => {
      del('delete-nc', n.id);
      if (!stockQty) stockApply(n.items || [], -1, true, n.number, 'armazem');
    });
    ncs = ncs.filter(n => n.saleId !== s.id);
    del('delete-sale', s.id);
    if (!stockQty && saleKind(s) !== 'cotacao') stockApply(s.items || [], +1, true, s.number, s.loc || 'loja');
    delCash(s.number);
    sales = sales.filter(x => x.id !== s.id);
  };
  if (sel.has('sales_vd')) sales.filter(s => saleKind(s) === 'venda').forEach(rmSale);
  if (sel.has('sales_ft')) sales.filter(s => saleKind(s) === 'credito').forEach(rmSale);
  if (sel.has('sales_fp')) {
    sales.filter(s => saleKind(s) === 'cotacao').forEach(s => del('delete-sale', s.id));
    sales = sales.filter(s => saleKind(s) !== 'cotacao');
  }
  if (sel.has('receipts')) {
    receipts.slice().forEach(r => {
      (r.allocations || []).forEach(al => {
        const s = sales.find(x => x.id === al.saleId); if (!s) return;
        s.paid = Math.max(0, (Number(s.paid) || 0) - (Number(al.amount) || 0));
        s.payments = (s.payments || []).filter(p => !(p.doc === r.number && Number(p.amount) === Number(al.amount)));
        s.updatedAt = Date.now();
        ops.push({ type: 'sale', payload: { ...s } });
      });
      del('delete-receipt', r.id);
      delCash(r.number);
    });
    receipts = [];
  }
  if (sel.has('ncs')) {
    ncs.slice().forEach(n => {
      del('delete-nc', n.id);
      if (!stockQty) stockApply(n.items || [], -1, true, n.number, 'armazem');
    });
    ncs = [];
  }
  if (sel.has('invoices')) { invoices.forEach(i => del('delete-invoice', i.id)); invoices = []; }
  if (sel.has('suppays')) {
    supPayments.slice().forEach(p => {
      del('delete-suppay', p.id);
      delCash(p.number);
      const inv = invoices.find(x => x.id === p.invoiceId);
      if (inv && p.initial && (Number(inv.paid) || 0) > 0) {
        inv.paid = Math.max(0, (Number(inv.paid) || 0) - (Number(p.amount) || 0));
        inv.updatedAt = Date.now();
        ops.push({ type: 'invoice', payload: { ...inv } });
      }
    });
    supPayments = [];
  }
  if (sel.has('supreturns')) { supReturns.forEach(r => del('delete-supreturn', r.id)); supReturns = []; }
  if (sel.has('porders')) { porders.forEach(o => del('delete-porder', o.id)); porders = []; }
  if (sel.has('supadj')) { supAdjustments.forEach(a => del('delete-supadj', a.id)); supAdjustments = []; }
  if (sel.has('expenses')) {
    cashMoves.filter(m => !m.auto && m.type === 'saida').forEach(m => del('delete-cashmove', m.id));
    cashMoves = cashMoves.filter(m => !(!m.auto && m.type === 'saida'));
  }
  if (sel.has('losses')) { stockLosses.forEach(l => del('delete-loss', l.id)); stockLosses = []; }
  if (sel.has('transfers')) {
    transfers.slice().forEach(t => {
      const legs = movements.filter(m => String(m.ref || '') === String(t.number || ''));
      if (!stockQty) {
        legs.forEach(m => {
          const s = findStock(m.name); if (!s) return;
          const q = Number(m.qty) || 0;
          const field = m.loc === 'armazem' ? 'qArm' : 'qLoja';
          s[field] = Math.max(0, (Number(s[field]) || 0) - q);
          s.updatedAt = Date.now();
          ops.push({ type: 'stock', payload: { ...s } });
        });
      }
      const ids = new Set(legs.map(m => m.id));
      legs.forEach(m => del('delete-move', m.id));
      if (ids.size) movements = movements.filter(m => !ids.has(m.id));
      del('delete-transfer', t.id);
    });
    transfers = [];
  }
  if (sel.has('moves')) { movements.forEach(m => del('delete-move', m.id)); movements = []; }
  if (sel.has('cash_all')) {
    cashMoves.forEach(m => del('delete-cashmove', m.id));
    cashMoves = [];
    cashDays.forEach(d => del('delete-cashday', d.id));
    cashDays = [];
  }
  if (sel.has('drafts')) { drafts.forEach(d => del('delete-draft', d.id)); drafts = []; }
  if (stockQty) {
    stock.forEach(s => {
      const lq = Number(s.qLoja) || 0, aq = Number(s.qArm) || 0;
      s.qLoja = 0; s.qArm = 0; s.updatedAt = Date.now();
      ops.push({ type: 'stock', payload: { ...s } });
      if (!sel.has('moves')) {
        if (lq > 0) {
          const mv = { id: uid(), productId: s.id, name: s.name, date: todayISO(), type: 'saida', qty: -lq, after: 0, loc: 'loja', ref: 'ZERAR', reason: 'Zerar stock', ts: Date.now() };
          movements.push(mv); ops.push({ type: 'move', payload: { ...mv } });
        }
        if (aq > 0) {
          const mv = { id: uid(), productId: s.id, name: s.name, date: todayISO(), type: 'saida', qty: -aq, after: 0, loc: 'armazem', ref: 'ZERAR', reason: 'Zerar stock', ts: Date.now() };
          movements.push(mv); ops.push({ type: 'move', payload: { ...mv } });
        }
      }
    });
  }
  if (ops.length) pushQueueBulk(ops);
  persist(); renderAll();
  return sel.size + (stockQty ? 1 : 0);
}
async function wipeRun() {
  if (currentRole() !== 'admin') return toast('Zerar movimentos: acesso Administrador.', 'error');
  const sel = new Set(wipeSelectedKeys());
  const stockQty = !!($('wipeStock') && $('wipeStock').checked);
  if (!sel.size && !stockQty) return toast('Escolha pelo menos uma categoria para zerar.', 'warning');
  const labels = wipeOptions().filter(o => sel.has(o.key)).map(o => o.label);
  if (stockQty) labels.push('quantidades de stock');
  if (!await confirmDlg('Zerar selecionados?', 'Vai apagar: ' + labels.join(', ') + '. As categorias não marcadas ficam intactas. Continuar?')) return;
  if (!await confirmDlg('Confirmar de novo?', 'Esta ação não pode ser anulada. Apagar mesmo?')) return;
  const n = wipeApply(sel, stockQty);
  if ($('wipeModal')) $('wipeModal').style.display = 'none';
  toast(n + ' categoria(s) zerada(s).', 'success');
}
if ($('btnZeroMoves')) $('btnZeroMoves').onclick = () => openWipeModal();
if ($('btnPayWipeCats')) $('btnPayWipeCats').onclick = () => openWipeModal();
if ($('wipeAll')) $('wipeAll').onchange = () => {
  const on = !!$('wipeAll').checked;
  document.querySelectorAll('#wipeRows .wipe-cb:not(:disabled)').forEach(c => { c.checked = on; });
  if ($('wipeStock')) $('wipeStock').checked = on;
  wipeSync();
};
if ($('wipeStock')) $('wipeStock').onchange = wipeSync;
if ($('btnWipeGo')) $('btnWipeGo').onclick = () => wipeRun();
if ($('btnWipeCancel')) $('btnWipeCancel').onclick = () => { $('wipeModal').style.display = 'none'; };
if ($('wipeModal')) $('wipeModal').addEventListener('click', (e) => { if (e.target === $('wipeModal')) $('wipeModal').style.display = 'none'; });
if ($('btnSaftMz')) $('btnSaftMz').onclick = () => {
  if (currentRole() !== 'admin') return toast('Acesso Administrador.', 'error');
  const y = new Date().getFullYear();
  const lines = ['SAFT-MZ;DeccApp;1.0;' + y, 'EMPRESA;' + ((company || {}).name || '') + ';NUIT:' + ((company || {}).nuit || '')];
  sales.forEach(s => lines.push(['VD-FT', s.number, s.date, s.client || '', (Number(s.total) || 0).toFixed(2), s.hash || ''].join(';')));
  invoices.forEach(i => lines.push(['FC', i.number, i.date, supName(i.supplierId), (Number(i.total) || 0).toFixed(2), ''].join(';')));
  receipts.forEach(r => lines.push(['RC', r.number, r.date, r.client || '', (Number(r.total) || 0).toFixed(2), r.hash || ''].join(';')));
  ncs.forEach(n => lines.push(['NC', n.number, n.date, n.client || '', (Number(n.total) || 0).toFixed(2), n.hash || ''].join(';')));
  dl(new Blob([lines.join('\n')], { type: 'text/plain' }), 'SAFT-MZ_' + y + '.txt');
  toast('SAFT-MZ exportado (' + (lines.length - 2) + ' docs).', 'success');
};
(function init() {
  const ses = load(LS.ses, null);
  renderFirstRun();
  try {
    const storedTheme=localStorage.getItem('dec_theme');
    const th = ['sistema','claro','escuro'].includes(storedTheme)?storedTheme:'sistema';
    const systemTheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const syncAppearance = () => { document.body.dataset.appearance = document.body.dataset.theme === 'escuro' || (document.body.dataset.theme === 'sistema' && systemTheme && systemTheme.matches) ? 'dark' : 'light'; };
    document.body.dataset.theme = th;
    syncAppearance();
    const syncDensity=()=>{
      const stored=localStorage.getItem('dec_density');
      const density=['auto','comfortable','compact'].includes(stored)?stored:'auto';
      document.body.dataset.density=density==='auto'?(innerHeight<850 || innerWidth<1440?'compact':'comfortable'):density;
      if($('densitySel')) $('densitySel').value=density;
    };
    syncDensity();window.addEventListener('resize',syncDensity);
    if($('densitySel')) $('densitySel').onchange=e=>{localStorage.setItem('dec_density',e.target.value);syncDensity();};
    if (systemTheme && systemTheme.addEventListener) systemTheme.addEventListener('change', syncAppearance);
    if ($('themeSel')) { $('themeSel').value = th; $('themeSel').onchange = (e) => { try { localStorage.setItem('dec_theme', e.target.value); } catch (_) {} document.body.dataset.theme = e.target.value; syncAppearance(); }; }
  } catch (_) { document.body.dataset.theme = 'sistema'; }
  // Se já havia sessão e (online ou PIN existe), entra direto? Pede sempre login por segurança, mas mostra modo certo.
  let restored=false;
  try {restored=!!sessionStorage.getItem('dec_restore_notice');sessionStorage.removeItem('dec_restore_notice');}catch(error){}
  if(restored && $('restoreLoginNotice')) {$('restoreLoginNotice').hidden=false;$('restoreLoginNotice').textContent='Backup restaurado. Entre com um PIN ou com a conta do sistema original.';}
  if (restored && (load(LS.pin,null)||appUsers().some(user=>user.pinHash)) || !isOnline()) showLoginTab('offline');
  else if (ses && ses.email) { $('loginEmail').value = ses.email; }
  $('fDate').value = fmtDate(todayISO()); resetProdRows(); resetSaleForm();
})();
})();

