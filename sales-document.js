function createSaleDocumentTools(deps) {
const { $, MZN, esc, fmtDate, findClientByName, ivaLines, saleBalance, docNew, toast } = deps;
let documentPrinting = false;
/* Documento comercial A4: modelo partilhado pela pré-visualização, impressão e PDF. */
function amountInWords(value) {
  const ones = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove','dez','onze','doze','treze','catorze','quinze','dezasseis','dezassete','dezoito','dezanove'];
  const tens = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
  const hundreds = ['','cento','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];
  function words(n) {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' e ' + words(n % 10) : '');
    if (n === 100) return 'cem';
    if (n < 1000) return hundreds[Math.floor(n / 100)] + (n % 100 ? ' e ' + words(n % 100) : '');
    for (const [scale, singular, plural] of [[1e12,'bilião','biliões'],[1e9,'mil milhões','mil milhões'],[1e6,'milhão','milhões'],[1000,'mil','mil']]) {
      if (n >= scale) {
        const count = Math.floor(n / scale), rest = n % scale;
        const prefix = scale === 1000 && count === 1 ? 'mil' : (scale === 1e9 && count === 1 ? 'mil milhões' : words(count) + ' ' + (count === 1 ? singular : plural));
        return prefix + (rest ? (rest < 100 || rest % 100 === 0 ? ' e ' : ' ') + words(rest) : '');
      }
    }
  }
  const cents = Math.round(Math.abs(Number(value) || 0) * 100);
  const integer = Math.floor(cents / 100), fraction = cents % 100;
  return (Number(value) < 0 ? 'menos ' : '') + words(integer) + (integer >= 1e6 && integer % 1e6 === 0 ? ' de' : '') + (integer === 1 ? ' metical' : ' meticais') + (fraction ? ' e ' + words(fraction) + (fraction === 1 ? ' centavo' : ' centavos') : '');
}
/* Mesmo extenso em inglês, para o documento em inglês. */
function amountInWordsEn(value) {
  const ones = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  function words(n) {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + words(n % 100) : '');
    for (const [scale, label] of [[1e12,'trillion'],[1e9,'billion'],[1e6,'million'],[1000,'thousand']]) {
      if (n >= scale) {
        const count = Math.floor(n / scale), rest = n % scale;
        return words(count) + ' ' + label + (rest ? (rest < 100 ? ' and ' : ' ') + words(rest) : '');
      }
    }
  }
  const cents = Math.round(Math.abs(Number(value) || 0) * 100);
  const integer = Math.floor(cents / 100), fraction = cents % 100;
  return (Number(value) < 0 ? 'minus ' : '') + words(integer) + (integer === 1 ? ' metical' : ' meticais') + (fraction ? ' and ' + words(fraction) + (fraction === 1 ? ' cent' : ' cents') : '');
}
function saleDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || '');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return m[3] + '-' + months[Number(m[2]) - 1] + '-' + m[1].slice(2);
}
function saleDocumentModel(s, copyOverride) {
  const {company, clients, tax} = deps.getState();
  const co = company || {};
  const pt = co.docLang === 'pt';
  const model = Number(co.docModel) === 1 ? 1 : 2;
  const client = (s.clientId ? clients.find(c => c.id === s.clientId) : null) || findClientByName(s.client || '') || {};
  const quantities = new Map();
  const amount = value => (Number(value) || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const lines = (s.items || []).map((p,i) => {
    const rawUnit = String(p.unit || '').trim().toUpperCase();
    const unit = ({SACO:'SC',SACOS:'SC',CAIXA:'CX',CAIXAS:'CX',EMBALAGEM:'EMB',EMBALAGENS:'EMB',UNIDADE:'UN',UNIDADES:'UN',UND:'UN',UNID:'UN'})[rawUnit] || rawUnit;
    quantities.set(unit,(quantities.get(unit) || 0) + (Number(p.qty) || 0));
    const desc = String(p.desc || '').toLocaleLowerCase('pt').replace(/(^|\s)(\p{L})/gu, (_,space,c)=>space+c.toLocaleUpperCase('pt'));
    const qty = String(Number(p.qty) || 0) + (unit ? ' ' + unit.toLowerCase() : '');
    return model === 2
      ? [String(i+1),qty,desc,amount(p.price),unit,amount(p.total)]
      : [String(i+1),desc,qty,amount(p.price),unit,amount(p.total)];
  });
  const totalQty = [...quantities.values()].reduce((sum, qty) => sum + qty, 0);
  const companyParts = {
    address: co.address || '',
    city: co.city || '',
    nuit: co.nuit ? String(co.nuit).replace(/\D/g,'').replace(/(\d{3})(?=\d)/g,'$1 ') : '',
    contacts: [co.phone, co.email].filter(Boolean).join(' · ')
  };
  const clientParts = {
    name: client.name || s.client || '—',
    address: client.address || s.clientAddress || '',
    phone: client.phone || s.clientPhone || ''
  };
  /* Total das quantidades: só faz sentido quando as unidades são as mesmas.
     Caixas iguais -> "10 cx"; mistura simples (cx/un) -> só o número;
     mistura com sacos/embalagens ou embalagens na descrição -> fica em branco. */
  const unitList = [...quantities.keys()].filter(Boolean);
  const qtyNumber = String(Number(totalQty.toFixed(4)));
  const packagingInDesc = (s.items || []).some(p => /\d\s*[x×]\s*\d+\s*(pcs?|pc|un|und|unid|unidades?|pacotes?|sacos?)\b/i.test(String(p.desc || '')));
  const countableMix = unitList.every(u => u === 'CX' || u === 'UN');
  const qtyTotal = !unitList.length
    ? qtyNumber
    : unitList.length === 1
      ? qtyNumber + ' ' + unitList[0].toLowerCase()
      : (countableMix && !packagingInDesc ? qtyNumber : '');
  const qtyHeader = pt ? 'Quantidade' : 'Quantity';
  const headers = model === 2
    ? [pt ? 'N.º' : 'No.',qtyHeader,pt ? 'Descrição dos produtos' : 'Product description',pt ? 'Preço unit.' : 'Rate',pt ? 'Un.' : 'Per',pt ? 'Valor' : 'Amount']
    : [pt ? 'N.º' : 'No.',pt ? 'Descrição dos produtos' : 'Product description',qtyHeader,pt ? 'Preço unit.' : 'Rate',pt ? 'Un.' : 'Per',pt ? 'Valor' : 'Amount'];
  return {
    title: 'PROFORMA',
    copy: copyOverride || (Number(s.printCount) > 0 ? (pt ? 'Duplicata' : 'Duplicate') : 'Original'),
    lang: pt ? 'pt' : 'en',
    model,
    headers,
    labels: {
      invoice: pt ? 'N.º da Fatura' : 'Invoice No.',
      date: pt ? 'Data' : 'Dated',
      client: pt ? 'Cliente:' : 'Customer:',
      words: pt ? 'Valor por extenso' : 'Amount Chargeable (in words)',
      total: 'Total',
      notes: pt ? 'Observações:' : 'Notes:',
      by: pt ? 'Por' : 'For',
      signature: pt ? 'Assinatura autorizada' : 'Authorized signature'
    },
    company: [co.name || 'Empresa',companyParts.address,companyParts.city,companyParts.nuit,companyParts.contacts].filter(Boolean),
    companyParts,
    client: [clientParts.name,[clientParts.address,clientParts.phone].filter(Boolean).join(' - ')].filter(Boolean),
    clientParts,
    number: String(s.number || ''), date: saleDate(s.date), lines,
    quantities: qtyTotal,
    total: amount(s.total), words: (pt ? amountInWords(s.total) : amountInWordsEn(s.total)).replace(/^./, char => char.toUpperCase()),
    tax: '',
    payment: '',
    notes: s.notes || '',
    footer: 'Este é um documento para contabilidade interna.'
  };
}
function saleDocumentHtml(s, copy) {
  const m = saleDocumentModel(s, copy);
  const numIdx = m.model === 2 ? [1,3,4,5] : [2,3,4,5];
  const widths = m.model === 2 ? [3.5,10.5,53,12,5,16] : [3.5,53,10.5,12,5,16];
  const totalCells = m.model === 2
    ? `<td></td><td class="sd-num">${esc(m.quantities)}</td><td class="sd-total-label" style="text-align:right">Total</td><td></td><td></td><td class="sd-num">${esc(m.total)}</td>`
    : `<td></td><td class="sd-total-label" style="text-align:right">Total</td><td class="sd-num">${esc(m.quantities)}</td><td></td><td></td><td class="sd-num">${esc(m.total)}</td>`;
  return `<article class="sale-document sd-model-${m.model}" aria-label="Pré-visualização do documento ${esc(m.number)}">
    <div class="sd-meta"><span class="sd-meta-left"><span class="sd-meta-label">${esc(m.labels.invoice)}</span><b>${esc(m.number)}</b></span><i>(${esc(m.copy)})</i><span>${esc(m.labels.date)} <b>${esc(m.date)}</b></span></div>
    <header class="sd-company"><h2>${esc(m.company[0])}</h2>${m.companyParts.address?`<div>${esc(m.companyParts.address)}</div>`:''}${m.companyParts.city?`<div>${esc(m.companyParts.city)}</div>`:''}${m.companyParts.nuit?`<div class="sd-nuit">${esc(m.companyParts.nuit)}</div>`:''}${m.companyParts.contacts?`<div>${esc(m.companyParts.contacts)}</div>`:''}<h1>${esc(m.title)}</h1></header>
    <div class="sd-client"><span class="sd-client-label">${esc(m.labels.client)}</span><div class="sd-client-details"><strong>${esc(m.clientParts.name)}</strong>${(m.clientParts.address||m.clientParts.phone)?`<div>${m.clientParts.address?`<span class="sd-client-addr">${esc(m.clientParts.address)}</span>`:''}${m.clientParts.address&&m.clientParts.phone?' - ':''}${esc(m.clientParts.phone)}</div>`:''}</div></div>
    <table class="sd-table"><colgroup>${widths.map(w=>`<col style="width:${w}%">`).join('')}</colgroup>
      <thead><tr>${m.headers.map((h,i)=>`<th class="${numIdx.includes(i) ? 'sd-num' : ''}">${h}</th>`).join('')}</tr></thead>
      <tbody>${m.lines.map(r=>`<tr>${r.map((v,i)=>`<td class="${numIdx.includes(i) ? 'sd-num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}<tr class="sd-space" aria-hidden="true">${'<td></td>'.repeat(6)}</tr></tbody>
      <tfoot><tr>${totalCells}</tr></tfoot>
    </table>
    <div class="sd-words">${esc(m.labels.words)}<br><strong>${esc(m.words)}</strong></div>
    ${m.notes ? '<div class="sd-conditions">' + esc(m.labels.notes) + ' ' + esc(m.notes) + '</div>' : ''}
    <div class="sd-signature"><strong>${esc(m.labels.by)} ${esc(m.company[0])}</strong><div class="sd-signature-space" aria-label="Espaço para assinatura"></div><div class="sd-signature-label">${esc(m.labels.signature)}</div></div>
    <footer>${esc(m.footer)}</footer>
  </article>`;
}
function preparePrint(html, sale) {
  $('printInv').innerHTML = html;
  document.body.classList.add('print-inv');
  document.body.classList.toggle('print-sale-document', sale);
  return () => document.body.classList.remove('print-inv','print-sale-document');
}
async function printDocumentHtml(html, sale = false) {
  if(documentPrinting) return false;
  documentPrinting=true;
  const cleanup = preparePrint(html, sale);
  const done = () => { cleanup(); documentPrinting=false; };
  if(window.api && typeof window.api.printDocument === 'function') {
    try {
      const result=await window.api.printDocument();
      if(!result.success && !/cancel/i.test(result.reason||'')) toast(result.reason||'Não foi possível imprimir o documento.','error');
      return result.success===true;
    } catch(error) { toast('Não foi possível imprimir o documento.','error'); return false; }
    finally {done();}
  }
  window.addEventListener('afterprint', done, {once:true});
  try { window.print(); return true; } catch(e) { done(); toast('Não foi possível abrir a impressão.', 'error'); return false; }
}
/* PDF gerado pelo Chromium com o mesmo CSS da pré-visualização/impressão. */
async function salePdfBlob(s, copy) {
  if(!(window.api && typeof window.api.printDocumentPdf === 'function')) return null;
  if(documentPrinting) return null;
  documentPrinting=true;
  const cleanup = preparePrint(saleDocumentHtml(s, copy), true);
  try {
    const data = await window.api.printDocumentPdf();
    return data ? new Blob([data], {type:'application/pdf'}) : null;
  } finally { cleanup(); documentPrinting=false; }
}
/* Cópias: 0 = Original, 1 = Duplicata. Por omissão imprime só a cópia actual. */
function saleCopyName(lang, index) {
  const pt = lang === 'pt';
  return index ? (pt ? 'Duplicata' : 'Duplicate') : 'Original';
}
function saleCopyList(s, copies) {
  /* Depois de o Original sair, só resta a Duplicata: nunca duas cópias. */
  if(Number(copies) === 2 && !(Number(s.printCount) > 0)) return [0, 1];
  return [Number(s.printCount) > 0 ? 1 : 0];
}
async function printSaleDocument(s, copies) {
  /* Cada cópia é guardada em PDF e impressa a partir do mesmo HTML. */
  const lang = (deps.getState().company || {}).docLang === 'pt' ? 'pt' : 'en';
  let ok = true;
  for(const index of saleCopyList(s, copies)) {
    const copy = saleCopyName(lang, index);
    const html = saleDocumentHtml(s, copy);
    try { if(deps.saveSalePdf) await deps.saveSalePdf(s, copy); } catch (_) {}
    if(!await printDocumentHtml(html, true)) { ok = false; break; }
    if(deps.markIssued) deps.markIssued(s);
  }
  return ok;
}
function buildSalePdf(s) {
  const m = saleDocumentModel(s), doc = docNew();
  const left = 14, width = 182;
  const m2 = m.model === 2;
  const descIdx = m2 ? 2 : 1, qtyIdx = m2 ? 1 : 2;
  const widths = m2 ? [6,19,96,22,9,30] : [6,96,19,22,9,30];
  const xs = [left]; widths.forEach(w => xs.push(xs[xs.length - 1] + w));
  function textLine(text,x,y,size=10,bold=false,options) {
    doc.setFont('helvetica',bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(0); doc.text(Array.isArray(text) ? text.map(String) : String(text),x,y,options);
  }
  function header() {
    textLine(m.labels.invoice + ' ',left,15,9);
    const numberX=left+doc.getTextWidth(m.labels.invoice + ' ');
    textLine(m.number,numberX,15,9,true);
    doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.text('(' + m.copy + ')',105,15,{align:'center'});
    doc.setFont('helvetica','bold');doc.setFontSize(9);
    const dateWidth=doc.getTextWidth(m.date);
    textLine(m.labels.date + ' ',196-dateWidth,15,9,false,{align:'right'});
    textLine(m.date,196,15,9,true,{align:'right'});
    let y = 24;
    m.company.forEach((v,i)=> { doc.setFontSize(i ? 9 : 11); const lines=doc.splitTextToSize(v,150); textLine(lines,105,y,i ? 9 : 11,!i,{align:'center'}); y += lines.length*4.3; });
    textLine(m.title,105,y+3,12,true,{align:'center'});
    y += 10;
    textLine(m.labels.client,left,y,10);
    const clientX=left+doc.getTextWidth(m.labels.client)+2;
    textLine(m.clientParts.name,clientX,y,10,true); y+=4.3;
    const clientLine=[m.clientParts.address,m.clientParts.phone].filter(Boolean).join(' - ');
    if(clientLine) { textLine(doc.splitTextToSize(clientLine,width-(clientX-left)),clientX,y,10); y+=4.3; }
    return Math.max(65,y+3);
  }
  const tableStart = header();
  const colStyles = {};
  widths.forEach((w,i)=>{ colStyles[i]={cellWidth:w}; });
  colStyles[descIdx] = {...colStyles[descIdx],fontStyle:'bold',fontSize:10.5};
  colStyles[qtyIdx] = {...colStyles[qtyIdx],halign:'right',fontStyle:'bold'};
  colStyles[3] = {cellWidth:22,halign:'right'};
  colStyles[4] = {cellWidth:9,halign:'center'};
  colStyles[5] = {cellWidth:30,halign:'right',fontStyle:'bold',fontSize:10};
  doc.autoTable({
    startY: tableStart, margin:{left,right:14,top:tableStart,bottom:85}, theme:'grid',
    head:[m.headers],body:m.lines,
    styles:{font:'helvetica',fontSize:10,cellPadding:{top:0.35,bottom:0.35,left:1,right:1},lineColor:0,lineWidth:0.2,textColor:0,overflow:'linebreak'},
    headStyles:{fillColor:255,textColor:0,fontStyle:'normal',fontSize:9,halign:'center',cellPadding:{top:1.6,bottom:1.6,left:0.5,right:0.5},lineColor:0,lineWidth:0.2},
    bodyStyles:{fillColor:255,lineWidth:{top:0,bottom:0,left:0.2,right:0.2}}, alternateRowStyles:{fillColor:255},
    columnStyles:colStyles,
    didParseCell: data => {
      if(data.section!=='body' || ![3,5].includes(data.column.index)) return;
      doc.setFont('helvetica',data.column.index===5?'bold':'normal');
      const available=(data.column.index===5?38:22)-3;
      const text=String(data.cell.raw);
      let size=data.cell.styles.fontSize;
      doc.setFontSize(size);
      while(size>6 && doc.getTextWidth(text)>available) {size-=.25;doc.setFontSize(size);}
      data.cell.styles.fontSize=size;
    },
    didDrawCell: data => {
      if(data.section==='body' && data.row.index===0) {doc.setDrawColor(0);doc.setLineWidth(.2);doc.line(data.cell.x,data.cell.y,data.cell.x+data.cell.width,data.cell.y);}
    },
    didDrawPage: data => { if(data.pageNumber > 1) header(); }
  });
  let y = Math.max(doc.lastAutoTable.finalY,212);
  if(y > 229) { doc.addPage(); header(); y=212; }
  const end = doc.lastAutoTable.finalY;
  if(end < y && doc.getNumberOfPages() === doc.lastAutoTable.pageNumber) {
    doc.setDrawColor(0); doc.setLineWidth(.2);
    for(const x of xs) doc.line(x,end,x,y);
  }
  doc.setDrawColor(0); doc.setLineWidth(.2);
  const quantityLines = m.quantities ? doc.splitTextToSize(m.quantities,18) : [];
  const totalHeight = Math.max(8,quantityLines.length*3.5+4);
  doc.rect(left,y,width,totalHeight);
  for(const x of xs.slice(1,-1)) doc.line(x,y,x,y+totalHeight);
  textLine(m.labels.total,xs[descIdx + 1] - 2,y+5.5,10,false,{align:'right'});
  if(quantityLines.length) textLine(quantityLines,xs[qtyIdx + 1] - 2,y+5,8,true,{align:'right'});
  doc.setFont('helvetica','bold');doc.setFontSize(10);
  const totalFont=Math.min(10,10*34/Math.max(34,doc.getTextWidth(m.total)));
  textLine(m.total,194,y+5.5,totalFont,true,{align:'right'});
  y+=totalHeight+5;
  const addWrapped=(value,bold=false,size=8)=> { doc.setFontSize(size); const ls=doc.splitTextToSize(String(value),width); if(y+ls.length*3.8>281){doc.addPage(); y=20;} textLine(ls,left,y,size,bold); y+=ls.length*3.8+1; };
  addWrapped(m.labels.words,false,8);
  addWrapped(m.words,true,9);
  if(m.tax) addWrapped(m.tax); if(m.payment) addWrapped(m.payment);
  if(m.notes) addWrapped(m.labels.notes + ' ' + m.notes);
  doc.setFont('helvetica','bold'); doc.setFontSize(9);
  const signatureCompany = doc.splitTextToSize(m.labels.by + ' ' + m.company[0],112);
  const signatureHeight = signatureCompany.length * 4 + 39;
  if(y + signatureHeight > 280) {doc.addPage();y=24;}
  y+=6; textLine(signatureCompany,196,y,9,true,{align:'right'});
  y+=signatureCompany.length*4+12;
  y+=5;
  textLine(m.labels.signature,196,y,9,false,{align:'right'});
  y+=10;
  textLine(m.footer,105,y,9,false,{align:'center'});
  doc.setDrawColor(0); doc.setLineWidth(.15);
  doc.line(105-doc.getTextWidth(m.footer)/2,y+1,105+doc.getTextWidth(m.footer)/2,y+1);
  return doc;
}

return { printDocumentHtml, saleDocumentHtml, saleDocumentModel, buildSalePdf, printSaleDocument, amountInWords, amountInWordsEn, salePdfBlob, saleCopyName, saleCopyList };
}
