const dbs=require('../../lib/store');
const {choose,keep,drop,ask,report}=require('../../lib/files');
const blank={ratio:'5x7',name:'',color:'#F5DFE3',special:false,frame:'',background:'',back:''};
const statusNames={draft:'草稿',pending:'待审核',approved:'已通过',returned:'已退回'};
Page({
  data:{section:'',sectionTitle:'',roleName:'',ratios:dbs.ratios,draft:blank,subjects:[],previews:[],created:[],working:false,colorText:blank.color,
    pools:[],poolIndex:0,frameIndex:0,bgIndex:0},
  async onShow(){
    let db;try{db=await dbs.readStudio();}catch(e){this.setData({who:null});report(e);return;}
    this.db=db;const who=db.who;dbs.syncNav(this);
    const owner=who.role==='owner';
    const sections=[
      {id:'制卡', title:'合成闪卡', icon:'✦', tint:'rose'},
      {id:'素材', title:'卡片素材', icon:'▧', tint:'blue'},
      {id:'卡池', title:'卡池与概率', icon:'◫', tint:'green'},
      {id:'审核', title:'投稿审核', icon:'✓', tint:'green'},
      {id:'权限', title:'用户权限', icon:'◇', tint:'gold'}
    ].slice(0,owner?5:3);
    const section=sections.find(entry=>entry.id===this.data.section);
    const pools=[{id:'',name:'暂不入池',types:[]},...db.submissionPools];
    const poolIndex=Math.max(0,pools.findIndex(p=>p.id===this.targetPool));
    this.targetPool=pools[poolIndex].id;
    const cardById=new Map(db.cards.map(card=>[card.id,card]));
    const pendingPools=owner?db.pools.filter(p=>p.status==='pending')
      .map(p=>({...p,ratesText:dbs.ratesText(p.types),cards:p.entries.map(entry=>({
        ...cardById.get(entry.id),tierName:p.types.find(t=>t.id===entry.tier).name
      }))})):[];
    const grouped=new Set(pendingPools.flatMap(p=>p.cards.map(card=>card.id)));
    const targets=new Map();
    if(owner)for(const pool of db.pools)for(const entry of pool.entries){
      if(cardById.get(entry.id).status==='pending'){
        if(!targets.has(entry.id))targets.set(entry.id,[]);
        targets.get(entry.id).push(pool.name+' / '+pool.types.find(t=>t.id===entry.tier).name);
      }
    }
    this.setData({who,sections,roleName:{owner:'店主',maker:'制卡员'}[who.role]||'', section:section?.id||'', sectionTitle:section?.title||'',
      profiles:db.profiles,pools,poolIndex,tiers:pools[poolIndex].types,poolDraft:['draft','returned'].includes(pools[poolIndex].status),
      tierIndex:0,poolList:db.pools.filter(p=>!owner||p.status!=='pending')
        .map(p=>({id:p.id,name:p.name,count:p.entries.length,statusName:statusNames[p.status]})),
      myCards:owner?[]:db.cards.filter(c=>c.author===who.id).map(c=>({...c,statusName:statusNames[c.status]})),
      pendingPools,pendingCards:owner?db.cards.filter(c=>db.reviewableCards.includes(c.id)&&!grouped.has(c.id))
        .map(c=>({...c,targetNames:(targets.get(c.id)||[]).join(' · ')})):[],
      reviewUsers:owner?db.profiles.filter(p=>p.role!=='owner'):[],
      groups:[{key:'packs',name:'卡包',rows:db.packs},{key:'frames',name:'上层卡框',rows:db.frames},{key:'backgrounds',name:'背景图',rows:db.backgrounds},{key:'backs',name:'卡背',rows:db.backs}]});
    if(owner)this.refreshReviewPools(cardById);
    this.refreshChoices(db);
  },
  async newPool(){
    const name=await ask('新增卡池','卡池名称');if(!name)return;
    try{
      const {id}=await dbs.api('/pools','POST',{name,draft:true});
      wx.navigateTo({url:'/pages/pool/index?id='+id});
    }catch(e){report(e);}
  },
  configure(e){wx.navigateTo({url:'/pages/pool/index?id='+e.currentTarget.dataset.id});},
  refreshChoices(db){
    const draft=this.data.draft;
    const frames=[{name:'无边框',src:''},...db.frames.filter(f=>f.ratio===draft.ratio)];
    const backgrounds=[{name:'纯色',src:''},...db.backgrounds];
    const backs=[{name:'默认卡背',src:''},...db.backs.filter(b=>b.ratio===draft.ratio)];
    const fi=this.frameSet?Math.max(0,frames.findIndex(f=>f.src===draft.frame)):Math.min(1,frames.length-1);
    const bi=Math.max(0,backgrounds.findIndex(f=>f.src===draft.background));
    const backIndex=Math.max(0,backs.findIndex(b=>b.src===draft.back));
    this.setData({frames,backgrounds,backs,frameIndex:fi,bgIndex:bi,backIndex,'draft.frame':frames[fi].src,'draft.background':backgrounds[bi].src,'draft.back':backs[backIndex].src});this.preview();
  },
  section(e){
    if(this.data.working)return;
    const {section,title}=e.currentTarget.dataset;
    this.setData({section,sectionTitle:title});
    wx.pageScrollTo({scrollTop:0,duration:0});
  },
  hub(){
    if(this.data.working)return;
    this.setData({section:'',sectionTitle:''});
    wx.pageScrollTo({scrollTop:0,duration:0});
  },
  ratio(e){this.frameSet=false;this.setData({'draft.ratio':e.currentTarget.dataset.value});this.refreshChoices(this.db);},
  frame(e){const i=+e.detail.value;this.frameSet=true;this.setData({frameIndex:i,'draft.frame':this.data.frames[i].src});this.preview();},
  background(e){const i=+e.detail.value;this.setData({bgIndex:i,'draft.background':this.data.backgrounds[i].src});this.preview();},
  back(e){const i=+e.detail.value;this.setData({backIndex:i,'draft.back':this.data.backs[i].src});this.preview();},
  color(e){const v=e.detail.value.trim();this.setData({colorText:v});if(/^#[0-9a-f]{6}$/i.test(v)){this.setData({'draft.color':v});this.preview();}},
  pool(e){
    const i=+e.detail.value,pool=this.data.pools[i];this.targetPool=pool.id;
    this.setData({poolIndex:i,tiers:pool.types,tierIndex:0,poolDraft:['draft','returned'].includes(pool.status)});
  },
  tier(e){this.setData({tierIndex:Number(e.detail.value)});},
  special(e){this.setData({'draft.special':e.detail.value});this.preview();},
  preview(){this.setData({previews:this.data.subjects.map(s=>({...this.data.draft,...s}))});},
  async chooseSubjects(){try{
    const paths=await choose(9);const subjects=this.data.subjects.slice();
    for(const subject of paths)subjects.push({key:dbs.id(),subject,name:'闪卡 '+(subjects.length+1)});
    this.setData({subjects});this.preview();
  }catch(e){report(e);}},
  rename(e){const i=e.currentTarget.dataset.index;this.setData({['subjects['+i+'].name']:e.detail.value.trim()||'闪卡'});this.preview();},
  removeSubject(e){this.setData({subjects:this.data.subjects.filter((_,i)=>i!==e.currentTarget.dataset.index)});this.preview();},
  async publish(){
    if(this.data.working||!this.data.subjects.length)return;
    if(!this.data.draft.background&&!/^#[0-9a-f]{6}$/i.test(this.data.colorText)){report(Error('请输入六位十六进制颜色，如 #F5DFE3'));return;}
    this.setData({working:true});const files=[],created=[],settings={...this.data.draft},poolId=this.targetPool;
    try{
      for(const row of this.data.subjects){
        const subject=await keep(row.subject);files.push(subject);
        created.push({name:row.name,subject});
      }
      const result=await dbs.api('/cards','POST',{...settings,frame:dbs.wireSrc(settings.frame),background:dbs.wireSrc(settings.background),
        back:dbs.wireSrc(settings.back),items:created,pool:poolId||'',tier:this.data.tiers[this.data.tierIndex]?.id});
      this.setData({created:result.cards,subjects:[],previews:[]});await this.onShow();
      wx.showToast({title:this.data.poolDraft?'已保存到卡池草稿':this.data.who.role==='owner'?'卡片已生成':'已提交审核'});
    }catch(e){await Promise.all(files.map(src=>drop(src).catch(()=>{})));report(e);}finally{this.setData({working:false});}
  },
  async addResource(e){
    if(this.data.working)return;
    this.setData({working:true});let src='';
    try{
      const kind=e.currentTarget.dataset.kind,paths=await choose(1);if(!paths.length)return;
      const name=await ask({frames:'上层卡框名称',backgrounds:'背景图名称',packs:'卡包名称',backs:'卡背名称'}[kind]);if(!name)return;
      let ratio='';
      if(kind==='frames'||kind==='backs'){
        const info=await new Promise((ok,fail)=>wx.getImageInfo({src:paths[0],success:ok,fail}));
        const r=info.width/info.height;ratio=dbs.ratios.reduce((best,v)=>{
          const [a,b]=v.split('x'),[c,d]=best.split('x');return Math.abs(Math.log(r*b/a))<Math.abs(Math.log(r*d/c))?v:best;
        });
      }
      src=await keep(paths[0]);await dbs.api('/resources','POST',{kind,name,src,ratio});
      this.onShow();
    }catch(err){if(src)await drop(src).catch(()=>{});report(err);}finally{this.setData({working:false});}
  },
  removeResource(e){
    const {id}=e.currentTarget.dataset;
    wx.showModal({title:'删除这个素材？',content:'已生成的卡片会保留原样。',success:async r=>{
      if(!r.confirm)return;
      try{await dbs.api('/resources/'+id,'DELETE');await this.onShow();}catch(err){report(err);}
    }});
  },
  async grant(e){
    try{await dbs.api('/users/'+e.currentTarget.dataset.id+'/role','POST',{role:e.detail.value?'maker':'user'});}
    catch(err){report(err);}
    await this.onShow();
  },
  async grantDownload(e){
    const {id}=e.currentTarget.dataset;
    try{await dbs.api('/users/'+id+'/card-file-access','POST',{enabled:e.detail.value});}
    catch(err){report(err);}
    await this.onShow();
  },
  async review(e){
    const {kind,id,approved}=e.currentTarget.dataset;
    const entry=this.db[kind].find(item=>item.id===id);
    const reason=approved?'':await new Promise(resolve=>wx.showModal({
      title:'退回投稿',editable:true,placeholderText:'退回原因（选填）',confirmText:'退回',
      success:r=>resolve(r.confirm?r.content??'':null),fail:()=>resolve(null)
    }));
    if(reason===null)return;
    try {
      await dbs.api('/'+kind+'/'+id+'/review','POST',{approved,reviewKey:entry.review_key,reason});
      await this.onShow();
    }catch(e){report(e);}
  },
  refreshReviewPools(cardById=new Map(this.db.cards.map(card=>[card.id,card]))){
    const limits=this.reviewLimits??=new Map();
    this.setData({reviewPools:this.db.pools.filter(p=>p.status==='approved').map(p=>{
      const limit=limits.get(p.id)||0;
      const entries=limit?p.entries.filter(entry=>cardById.get(entry.id).status==='approved'):[];
      return {id:p.id,name:p.name,listed:p.listed,ratesText:dbs.ratesText(p.types,p.actualRates),open:!!limit,more:entries.length>limit,
        cards:entries.slice(0,limit).map(entry=>({id:entry.id,listed:entry.listed,name:cardById.get(entry.id).name}))};
    })});
  },
  reviewMembers(e){
    const {pool,more}=e.currentTarget.dataset;
    const current=this.reviewLimits.get(pool)||0;
    this.reviewLimits.set(pool,more?current+24:current?0:24);
    this.refreshReviewPools();
  },
  async listing(e){
    const {pool,card}=e.currentTarget.dataset;
    const target=this.db.pools.find(p=>p.id===pool);
    const item=card?target.entries.find(entry=>entry.id===card):target,listed=!item.listed;
    try{
      const {actualRates}=await dbs.api('/pools/'+pool+'/'+(card?'card-listing':'listing'),'POST',{listed,card});
      item.listed=listed;
      target.actualRates=actualRates;
      this.refreshReviewPools();
      wx.showToast({title:listed?'已上架':'已下架'});
    }catch(err){report(err);}
  },
  changeBan(e){
    const profile=this.db.profiles.find(p=>p.id===e.currentTarget.dataset.id),banned=!profile.banned;
    const save=async()=>{
      try{
        await dbs.api('/users/'+profile.id+'/ban','POST',{banned});
        profile.banned=banned;
        this.setData({reviewUsers:this.db.profiles.filter(p=>p.role!=='owner')});
        wx.showToast({title:banned?'已封禁':'已解封'});
      }catch(err){report(err);}
    };
    if(!banned)save();
    else wx.showModal({title:'封禁「'+profile.name+'」？',content:'该账号将无法抽卡或投稿。',success:r=>{if(r.confirm)save();}});
  },
  async resubmit(e){
    const {id,name}=e.currentTarget.dataset;
    const revised=await ask('卡片名称',name);
    if(!revised)return;
    try{await dbs.api('/cards/'+id+'/resubmit','POST',{name:revised});await this.onShow();}catch(e){report(e);}
  },
  detail(e){wx.navigateTo({url:'/pages/card/index?studio=1&id='+encodeURIComponent(e.currentTarget.dataset.id)});}
});
