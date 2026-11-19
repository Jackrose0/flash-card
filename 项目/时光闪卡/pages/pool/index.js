const store=require('../../lib/store');
const {ask,report}=require('../../lib/files');
Page({
  onLoad(query){this.poolId=query.id;},
  async onShow(){
    let db;try{db=await store.read();}catch(e){report(e);return;}
    if(db.who.role!=='owner'){wx.switchTab({url:'/pages/album/index'});return;}
    const pool=db.pools.find(p=>p.id===this.poolId);
    if(!pool){wx.navigateBack();return;}
    const included=new Set(pool.entries.map(e=>e.id));
    const members=db.cards.filter(c=>included.has(c.id));
    const tiers=new Set(members.map(c=>c.special));
    const status=!members.length?'卡池暂无卡片':tiers.size===1?'当前仅有'+(members[0].special?'稀有':'普通')+'闪卡，实际抽取概率为 100%':'';
    this.setData({name:pool.name,normalRate:String((10000-pool.rareRate)/100),rareRate:String(pool.rareRate/100),status,
      cards:db.cards.map(c=>({...c,included:included.has(c.id)}))});
  },
  async update(action,data){
    try{await store.api('/pools/'+this.poolId+'/'+action,'POST',data);await this.onShow();return true;}
    catch(e){report(e);return false;}
  },
  async rename(){const name=await ask('卡池名称',this.data.name);if(name)await this.update('name',{name});},
  async toggle(e){if(!await this.update('member',{card:e.currentTarget.dataset.id,included:e.detail.value}))await this.onShow();},
  rateInput(e){
    const field=e.currentTarget.dataset.field,value=e.detail.value;
    const patch={[field]:value};
    if(value!==''&&Number(value)>=0&&Number(value)<=100)
      patch[field==='rareRate'?'normalRate':'rareRate']=String((10000-Math.round(Number(value)*100))/100);
    this.setData(patch);
  },
  async saveRates(){
    const {normalRate,rareRate}=this.data;
    if(![normalRate,rareRate].every(s=>/^\d{1,3}(\.\d{1,2})?$/.test(s)&&Number(s)<=100)){
      report(Error('概率须为 0 到 100%，最多两位小数'));return;
    }
    if(await this.update('rates',{normalRate:Math.round(Number(normalRate)*100),rareRate:Math.round(Number(rareRate)*100)}))wx.showToast({title:'概率已更新'});
  },
  remove(){
    wx.showModal({title:'删除「'+this.data.name+'」？',content:'玩家已抽到的卡会保留。',confirmText:'删除',success:async r=>{
      if(!r.confirm)return;
      try{await store.api('/pools/'+this.poolId,'DELETE');wx.navigateBack();}catch(e){report(e);}
    }});
  }
});
