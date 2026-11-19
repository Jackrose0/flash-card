const dbs=require('../../lib/store');
const {choose,keep,drop,ask,report}=require('../../lib/files');
const blank={ratio:'5x7',name:'',color:'#F5DFE3',special:false,frame:'',background:''};
Page({
  data:{section:'',sectionTitle:'',roleName:'',ratios:dbs.ratios,draft:blank,subjects:[],previews:[],created:[],working:false,colorText:blank.color,
    pools:[],poolIndex:0,frameIndex:0,bgIndex:0},
  async onShow(){
    let db;try{db=await dbs.read();}catch(e){report(e);return;}
    this.db=db;const who=db.who;dbs.syncNav(this);
    if(who.role==='user'){wx.switchTab({url:'/pages/album/index'});return;}
    const sections=[
      {id:'制卡', title:'合成闪卡', icon:'✦', tint:'rose'},
      {id:'素材', title:'卡片素材', icon:'▧', tint:'blue'},
      {id:'卡池', title:'卡池与概率', icon:'◫', tint:'green'},
      {id:'权限', title:'用户权限', icon:'◇', tint:'gold'}
    ].slice(0,who.role==='owner'?4:2);
    const section=sections.find(entry=>entry.id===this.data.section);
    const pools=[{id:'',name:'暂不入池'},...db.pools];
    const poolIndex=Math.max(0,pools.findIndex(p=>p.id===this.targetPool));
    this.setData({who,sections,roleName:who.role==='owner'?'店主':'制卡员', section:section?.id||'', sectionTitle:section?.title||'',
      profiles:db.profiles,pools,poolIndex,poolList:db.pools.map(p=>({id:p.id,name:p.name,count:p.entries.length})),
      groups:[{key:'frames',name:'上层框',rows:db.frames},{key:'backgrounds',name:'背景',rows:db.backgrounds}]});
    this.refreshChoices(db);
  },
  async newPool(){
    const name=await ask('新增卡池','卡池名称');if(!name)return;
    try{
      const {id}=await dbs.api('/pools','POST',{name});
      wx.navigateTo({url:'/pages/pool/index?id='+id});
    }catch(e){report(e);}
  },
  configure(e){wx.navigateTo({url:'/pages/pool/index?id='+e.currentTarget.dataset.id});},
  refreshChoices(db){
    const draft=this.data.draft;
    const frames=[{name:'无边框',src:''},...db.frames.filter(f=>f.ratio===draft.ratio)];
    const backgrounds=[{name:'纯色',src:''},...db.backgrounds];
    const fi=this.frameSet?Math.max(0,frames.findIndex(f=>f.src===draft.frame)):Math.min(1,frames.length-1);
    const bi=Math.max(0,backgrounds.findIndex(f=>f.src===draft.background));
    this.setData({frames,backgrounds,frameIndex:fi,bgIndex:bi,'draft.frame':frames[fi].src,'draft.background':backgrounds[bi].src});this.preview();
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
  color(e){const v=e.detail.value.trim();this.setData({colorText:v});if(/^#[0-9a-f]{6}$/i.test(v)){this.setData({'draft.color':v});this.preview();}},
  pool(e){const i=+e.detail.value;this.targetPool=this.data.pools[i].id;this.setData({poolIndex:i});},
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
      const result=await dbs.api('/cards','POST',{...settings,frame:dbs.wireSrc(settings.frame),background:dbs.wireSrc(settings.background),items:created,pool:poolId||''});
      this.setData({created:result.cards,subjects:[],previews:[]});await this.onShow();wx.showToast({title:poolId?'已加入卡池':'卡片已生成'});
    }catch(e){await Promise.all(files.map(src=>drop(src).catch(()=>{})));report(e);}finally{this.setData({working:false});}
  },
  async addResource(e){
    if(this.data.working)return;
    this.setData({working:true});let src='';
    try{
      const kind=e.currentTarget.dataset.kind,paths=await choose(1);if(!paths.length)return;
      const name=await ask(kind==='frames'?'边框名称':'背景名称');if(!name)return;
      let ratio='';
      if(kind==='frames'){
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
  detail(e){wx.navigateTo({url:'/pages/card/index?id='+e.currentTarget.dataset.id});}
});
