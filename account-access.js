/* Contas Firebase: o perfil autorizado é obrigatório e só administradores o gerem. */
(function(root){
'use strict';
function createFirebaseAccountAccess({firebase,auth,database,config,workspaceId,keyForEmail}) {
  const emailKey=email=>String(email||'').trim().toLowerCase().replace(/[%.$#[\]/]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  async function authorize(user) {
    if(!user?.uid || !user.email) throw Error('Entre com uma conta Firebase válida.');
    const snapshot=await database.ref('users_meta/'+user.uid).get(),p=snapshot.val();
    if(!p || p.active!==true || typeof p.admin!=='boolean' || p.uid!==user.uid || p.workspaceId!==workspaceId || String(p.email||'').toLowerCase()!==user.email.toLowerCase()) throw Error('Conta sem autorização no Firebase. Peça ao administrador para criar ou ativar o perfil.');
    return {...p,role:p.admin===true?'admin':p.role==='opt'?'opt':'op'};
  }
  async function requireAdmin(){const p=await authorize(auth.currentUser);if(p.admin!==true)throw Error('Apenas administradores podem gerir contas.');return p;}
  async function writeProfile(profile) {
    const key=keyForEmail(profile.email),updates={};profile.userKey=key;
    updates['users_meta/'+profile.uid]=profile;
    updates['companyMembers/'+workspaceId+'/'+emailKey(profile.email)]={uid:profile.uid,email:profile.email,admin:profile.admin,role:profile.role,mode:profile.mode||'',active:profile.active};
    updates['users/'+workspaceId+'/team/'+key]=profile;
    updates['users/'+workspaceId+'/settings/users/list/'+key]=profile;
    updates['directory/'+workspaceId+'/'+profile.uid]={uid:profile.uid,email:profile.email,name:profile.name,role:profile.role,mode:profile.mode||'',admin:profile.admin,active:profile.active};
    await database.ref().update(updates);
  }
  async function create({email,password,name,role='op',pinHash='',mode=''}) {
    await requireAdmin();email=String(email||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Indique um email válido.');
    if(typeof password!=='string'||password.length<6)throw Error('A palavra-passe deve ter pelo menos 6 caracteres.');
    if(!['','venda','faturacao'].includes(mode))throw Error('Modo de trabalho inválido.');
    if(!['admin','op','opt'].includes(role))throw Error('Perfil inválido.');
    const secondary=firebase.initializeApp(config,'account-provision-'+Date.now()+'-'+Math.random().toString(36).slice(2));let created,isNew=false;
    try {
      const secondaryAuth=secondary.auth();
      if(secondaryAuth.setPersistence)await secondaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      let credential;try{credential=await secondaryAuth.createUserWithEmailAndPassword(email,password);isNew=true;}catch(error){if(error.code!=='auth/email-already-in-use')throw error;credential=await secondaryAuth.signInWithEmailAndPassword(email,password);}created=credential.user;
      if(name && created.updateProfile)await created.updateProfile({displayName:name});
      const profile={uid:created.uid,email,name:String(name||'').trim(),admin:role==='admin',role,mode,active:true,workspaceId,pinHash,createdAt:Date.now(),updatedAt:Date.now()};
      await writeProfile(profile);return profile;
    } catch(error) {
      if(created && isNew){try{await created.delete();}catch(_){throw Error('A conta Auth foi criada, mas o perfil não foi autorizado. A conta permanece bloqueada; verifique as regras do Firebase.');}}
      throw error;
    } finally {await secondary.delete();}
  }
  async function update(uid,changes) {
    await requireAdmin();const snapshot=await database.ref('users_meta/'+uid).get(),before=snapshot.val();
    if(!before || before.workspaceId!==workspaceId)throw Error('Esta conta precisa de um perfil Firebase válido antes de ser editada.');
    if(uid===auth.currentUser.uid && (changes.active===false || changes.admin===false))throw Error('Não pode remover o seu próprio acesso de administrador.');
    if(changes.mode!==undefined && !['','venda','faturacao'].includes(changes.mode))throw Error('Modo de trabalho inválido.');
    const profile={...before,...changes,uid:before.uid,email:before.email,workspaceId,updatedAt:Date.now()};
    profile.admin=profile.admin===true;profile.role=profile.admin?'admin':profile.role==='opt'?'opt':'op';await writeProfile(profile);return profile;
  }
  async function updateByEmail(email,changes) {
    await requireAdmin();
    email=String(email||'').trim().toLowerCase();
    const member=(await database.ref('companyMembers/'+workspaceId+'/'+emailKey(email)).get()).val();
    let uid=member && String(member.email||'').toLowerCase()===email ? member.uid : null;
    if(!uid) {
      const directory=(await database.ref('directory/'+workspaceId).get()).val() || {};
      const matches=Object.values(directory).filter(p=>p && String(p.email||'').toLowerCase()===email && p.uid);
      if(matches.length===1)uid=matches[0].uid;
    }
    if(!uid)throw Error('Perfil Firebase não encontrado para '+email+'. Importe as contas da nuvem ou autorize esta conta antes de editar.');
    const profile=(await database.ref('users_meta/'+uid).get()).val();
    if(!profile || String(profile.email||'').toLowerCase()!==email)throw Error('O perfil Firebase não corresponde ao email selecionado. Importe novamente as contas.');
    return update(uid,changes);
  }
  return {authorize,requireAdmin,create,update,updateByEmail};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createFirebaseAccountAccess};
else root.createFirebaseAccountAccess=createFirebaseAccountAccess;
})(typeof window!=='undefined'?window:globalThis);
