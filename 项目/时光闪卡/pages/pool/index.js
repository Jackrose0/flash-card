const store=require('../../lib/store');
const {ask,report,choose,keep,drop}=require('../../lib/files');
Page({
  onLoad(query){this.poolId=query.id;},
  async onShow(){
    let db;try{db=await store.readStudio();}catch(e){report(e);return;}
    const pool=db.pools.find(p=>p.id===this.poolId);
    if(!pool){wx.navigateBack();return;}
    const included=new Map(pool.entries.map(e=>[e.id,e.tier]));
    const owner=db.who.role==='owner';
    const editable=pool.status!=='pending'&&(owner||pool.status!=='approved');
    const packs=[{name:'默认卡包',src:''},...db.packs];
    if(pool.pack_src&&!packs.some(pack=>pack.src===pool.pack_src))packs.push({name:'当前卡包',src:pool.pack_src});
    this.types=pool.types;
    this.setData({name:pool.name,cardsPerPack:String(pool.cardsPerPack),types:pool.types.map(t=>({...t,percent:String(t.rate/100)})),
      typeNames:pool.types.map(t=>t.name),actualRatesText:store.ratesText(pool.types,pool.actualRates),
      editable,own:pool.author===db.who.id,memberCount:pool.entries.length,reviewReason:pool.review_reason,
      reviewState:pool.status,reviewLabel:{draft:'草稿',pending:'待审核',approved:'已通过',returned:'已退回'}[pool.status],
      canWithdraw:pool.status==='pending'||!owner&&pool.status==='approved',
      pack:pool.pack,packs,packIndex:Math.max(0,packs.findIndex(pack=>pack.src===pool.pack_src)),
      cards:db.cards.map(c=>({...c,included:included.has(c.id),
        typeIndex:Math.max(0,pool.types.findIndex(t=>t.id===(included.get(c.id)||(c.special?'rare':'normal')))),
        canAssign:editable&&(owner||c.author===db.who.id)&&
          (c.status==='approved'||pool.status!=='approved'&&c.author===pool.author)}))
        .filter(c=>c.included||c.canAssign)});
  },
  async update(action,data){
    try{await store.api('/pools/'+this.poolId+'/'+action,'POST',data);await this.onShow();return true;}
    catch(e){report(e);return false;}
  },
  async rename(){const name=await ask('卡池名称',this.data.name);if(name)await this.update('name',{name});},
  async changePack(e){await this.update('pack',{src:store.wireSrc(this.data.packs[e.detail.value].src)});},
  async uploadCover(){
    let src;
    try{
      const [file]=await choose(1);
      if(!file)return;
      src=await keep(file);
      if(!await this.update('pack',{upload:src}))await drop(src);
    }catch(err){report(err);}
  },
  testPool(){wx.navigateTo({url:'/pages/open/index?preview=1&pool='+encodeURIComponent(this.poolId)});},
  async submit(){if(await this.update('submit',{}))wx.showToast({title:'已提交审核'});},
  withdraw(){
    if(this.data.reviewState!=='approved'){this.update('withdraw',{});return;}
    wx.showModal({title:'撤回卡池？',content:'撤回后需重新提交审核，审核期间暂停抽卡。',
      success:r=>{if(r.confirm)this.update('withdraw',{});}});
  },
  toggle(e){
    const {index}=e.currentTarget.dataset;
    return this.assign(index,e.detail.value,this.data.cards[index].typeIndex);
  },
  changeType(e){
    const {index}=e.currentTarget.dataset,typeIndex=Number(e.detail.value);
    if(this.data.cards[index].included)return this.assign(index,true,typeIndex);
    this.setData({['cards['+index+'].typeIndex']:typeIndex});
  },
  async assign(index,included,typeIndex){
    const card=this.data.cards[index],prefix='cards['+index+']';
    const previous=card.included,previousType=card.typeIndex;
    this.setData({memberSaving:true,[prefix+'.included']:included,[prefix+'.typeIndex']:typeIndex});
    try{
      const {actualRates}=await store.api('/pools/'+this.poolId+'/member','POST',
        {card:card.id,included,tier:this.types[typeIndex].id});
      const patch={actualRatesText:store.ratesText(this.types,actualRates),memberCount:this.data.memberCount+Number(included)-Number(previous)};
      if(!included&&!card.canAssign)patch.cards=this.data.cards.filter(item=>item.id!==card.id);
      this.setData(patch);
    }catch(err){
      this.setData({[prefix+'.included']:previous,[prefix+'.typeIndex']:previousType});report(err);
    }finally{
      this.setData({memberSaving:false});
    }
  },
  configInput(e){
    const {index,field}=e.currentTarget.dataset;
    this.setData({[index===undefined?field:'types['+index+'].'+field]:e.detail.value});
  },
  addType(){this.setData({types:[...this.data.types,{id:'t-'+store.id(),name:'',percent:'0'}]});},
  removeType(e){this.setData({types:this.data.types.filter((_,i)=>i!==e.currentTarget.dataset.index)});},
  async saveConfig(){
    const {types,cardsPerPack}=this.data;
    if(await this.update('config',{cardsPerPack:Number(cardsPerPack),types:types.map(t=>({
      id:t.id,name:t.name,rate:t.percent.trim()===''?null:Math.round(Number(t.percent)*100)
    }))}))wx.showToast({title:'配置已保存'});
  },
  remove(){
    wx.showModal({title:'删除「'+this.data.name+'」？',content:'玩家已抽到的卡会保留。',confirmText:'删除',success:async r=>{
      if(!r.confirm)return;
      try{await store.api('/pools/'+this.poolId,'DELETE');wx.navigateBack();}catch(e){report(e);}
    }});
  }
});
