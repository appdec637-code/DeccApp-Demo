(function(root) {
'use strict';
const FORMAT='decapp-system-backup', VERSION=1;
const COLLECTIONS=['dec_suppliers','dec_invoices','dec_stock','dec_sales','dec_clients','dec_suppay','dec_supadj','dec_losses','dec_moves','dec_cashdays','dec_cashmoves','dec_receipts','dec_ncs','dec_porders','dec_supret','dec_transfers','dec_drafts','dec_notifs','dec_chat'];
const LISTS=['dec_queue','dec_paymethods','dec_units','dec_notif_seen','dec_notif_del','dec_chat_seen','dec_chat_del'];
const OBJECTS=['dec_company','dec_tax','dec_stockcfg','dec_notif_user_state'];
const EXCLUDED=new Set(['dec_session','dec_role','dec_syncreq','dec_syncrep','dec_restore_notice']);
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const isObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const allowed=key=>/^dec_[A-Za-z0-9_-]+$/.test(key) && key.length<=200 && !EXCLUDED.has(key);
function storageEntries(storage,includeTransient=false) {
  const entries=Object.create(null);
  for(let i=0;i<storage.length;i++) {
    const key=storage.key(i);
    if(key && key.startsWith('dec_') && (includeTransient || allowed(key))) entries[key]=storage.getItem(key);
  }
  return entries;
}
function readJson(entries,key) {
  if(!own(entries,key)) throw new Error('Backup incompleto: falta '+key+'.');
  try {return JSON.parse(entries[key]);} catch(error) {throw new Error('Dados inválidos no backup: '+key+'.');}
}
function validateEntries(entries) {
  if(!isObject(entries)) throw new Error('O ficheiro não contém os dados do sistema.');
  Object.entries(entries).forEach(([key,value])=>{if(!allowed(key) || typeof value!=='string') throw new Error('O backup contém uma chave inválida: '+key+'.');});
  [...COLLECTIONS,...LISTS].forEach(key=>{
    const list=readJson(entries,key);
    if(!Array.isArray(list)) throw new Error('A lista '+key+' está inválida.');
    if(COLLECTIONS.includes(key) && list.some(value=>!isObject(value))) throw new Error('Há registos inválidos em '+key+'.');
  });
  OBJECTS.forEach(key=>{if(!isObject(readJson(entries,key))) throw new Error('A configuração '+key+' está inválida.');});
  const users=readJson(entries,'dec_users');
  if(!Array.isArray(users) && !isObject(users)) throw new Error('Os utilizadores do backup estão inválidos.');
  if(Object.values(users).some(user=>!isObject(user) || !user.email || !['admin','op','opt'].includes(user.role))) throw new Error('Há utilizadores inválidos no backup.');
  for(const key of Object.keys(entries).filter(key=>key.startsWith('dec_billing_seq_'))) {
    const value=readJson(entries,key);if(!Number.isSafeInteger(value)||value<0) throw new Error('A numeração do backup está inválida.');
  }
  if(own(entries,'dec_pin')) {const pin=readJson(entries,'dec_pin');if(pin!==null && typeof pin!=='string') throw new Error('O PIN do backup está inválido.');}
  return entries;
}
function isEmpty(storage) {
  return COLLECTIONS.every(key=>{const raw=storage.getItem(key);if(raw===null) return true;try{const value=JSON.parse(raw);return Array.isArray(value)&&value.length===0;}catch(error){return false;}});
}
function canonical(backup) {
  const entries=Object.fromEntries(Object.keys(backup.entries).sort().map(key=>[key,backup.entries[key]]));
  return JSON.stringify({format:backup.format,version:backup.version,createdAt:backup.createdAt,source:backup.source,entries});
}
async function digest(value) {
  if(!root.crypto?.subtle || !root.TextEncoder) throw new Error('A verificação do backup não está disponível neste dispositivo.');
  const bytes=await root.crypto.subtle.digest('SHA-256',new root.TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function create(entries,source={}) {
  const clean=Object.fromEntries(Object.entries(entries).filter(([key])=>allowed(key)));
  validateEntries(clean);
  const backup={format:FORMAT,version:VERSION,createdAt:new Date().toISOString(),source:{company:String(source.company||''),exportedBy:String(source.exportedBy||''),cloudUid:source.cloudUid||null},entries:clean};
  backup.checksum={algorithm:'SHA-256',value:await digest(canonical(backup))};
  return backup;
}
async function verify(backup) {
  if(!isObject(backup) || backup.format!==FORMAT) throw new Error('Escolha um ficheiro de backup completo da DeccApp (.json).');
  if(backup.version!==VERSION) throw new Error('Esta versão de backup não é suportada.');
  if(typeof backup.createdAt!=='string' || !Number.isFinite(Date.parse(backup.createdAt)) || !isObject(backup.source)) throw new Error('O cabeçalho do backup está inválido.');
  validateEntries(backup.entries);
  if(backup.checksum?.algorithm!=='SHA-256' || !/^[a-f0-9]{64}$/.test(backup.checksum.value||'') || await digest(canonical(backup))!==backup.checksum.value) throw new Error('O ficheiro está incompleto ou foi alterado. Não foi importado.');
  return backup;
}
async function parse(text) {
  if(typeof text!=='string'||text.length>50*1024*1024) throw new Error('O ficheiro de backup é demasiado grande.');
  let backup;try{backup=JSON.parse(text);}catch(error){throw new Error('O ficheiro não é um backup JSON válido.');}
  return verify(backup);
}
function summary(backup) {
  const count=key=>readJson(backup.entries,key).length;
  return {company:readJson(backup.entries,'dec_company').name||backup.source.company||'Empresa',createdAt:backup.createdAt,products:count('dec_stock'),clients:count('dec_clients'),suppliers:count('dec_suppliers'),documents:count('dec_sales')+count('dec_invoices')+count('dec_receipts')+count('dec_ncs'),drafts:count('dec_drafts'),users:Object.values(readJson(backup.entries,'dec_users')).length,records:COLLECTIONS.reduce((total,key)=>total+count(key),0)};
}
async function restore(storage,backup,{canRestore=()=>true}={}) {
  await verify(backup);
  if(!canRestore() || !isEmpty(storage)) throw new Error('A restauração só é permitida num sistema vazio, sem registos.');
  const previous=storageEntries(storage,true);
  try {
    Object.keys(previous).forEach(key=>storage.removeItem(key));
    Object.entries(backup.entries).forEach(([key,value])=>storage.setItem(key,value));
    Object.entries(backup.entries).forEach(([key,value])=>{if(storage.getItem(key)!==value) throw new Error('Não foi possível verificar os dados restaurados.');});
  } catch(error) {
    try {
      Object.keys(storageEntries(storage,true)).forEach(key=>storage.removeItem(key));
      Object.entries(previous).forEach(([key,value])=>storage.setItem(key,value));
    } catch(rollbackError) {throw new Error('Não foi possível restaurar o sistema nem repor a configuração anterior. Guarde o ficheiro de backup e tente num sistema vazio.');}
    throw new Error('Não foi possível restaurar o backup. A configuração anterior foi mantida. '+error.message);
  }
  return summary(backup);
}
const api={create,parse,verify,restore,summary,isEmpty,storageEntries,COLLECTIONS,LISTS,OBJECTS};
root.DecAppSystemBackup=api;
if(typeof module!=='undefined' && module.exports) module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
