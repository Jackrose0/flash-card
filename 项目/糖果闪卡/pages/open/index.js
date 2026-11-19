const store=require('../../lib/store');
const {surface,sources}=require('../../lib/art');
const {render,revealDuration}=require('../../lib/scene');
const initialHint='按住卡包，向一侧撕开';
Page({
  data:{pack:store.packs[0],hint:initialHint,busy:false,ready:false,opened:false},
  onLoad(query){
    this.poolId=query.pool;
    const capsule=wx.getMenuButtonBoundingClientRect();
    this.setData({pack:store.randomPack(),top:capsule.top,barHeight:capsule.height});
  },
  back(){wx.navigateBack();},
  async onReady(){
    if(!this.poolId)return;
    try{
      const db=await store.read(),pool=db.pools.find(p=>p.id===this.poolId);
      if(!pool||!pool.entries.some(entry=>entry.chance>0))throw Error('这个卡池暂时没有卡片');
      this.setData({poolName:pool.name});
      this.s=await surface(this,'#scene');
      this.fixedPack=pool.pack;
      if(this.fixedPack)await this.s.load(this.fixedPack.src);
      else await Promise.all(store.packs.map(p=>this.s.load('/assets/'+p.id+'-pack.png')));
      this.reset(this.fixedPack||this.data.pack);
    }catch(e){wx.showModal({title:'卡包加载失败',content:e.message,showCancel:false});}
  },
  onShow(){this.visible=true;if(this.model)this.animate();},
  onHide(){this.visible=false;this.gesture=null;this.stop();},
  onUnload(){this.onHide();},
  stop(){if(this.raf!=null){this.s.canvas.cancelAnimationFrame(this.raf);this.raf=null;}},
  reset(pack,requestId=store.id()){
    this.requestId=requestId;
    this.stop();this.gesture=null;this.finish=null;this.loading=false;
    this.model={pack,p:0,dir:1,born:[],cards:[],flips:[],openAt:null,targets:[],resultTop:this.data.top+this.data.barHeight+14};
    this.setData({pack,hint:initialHint,ready:true,busy:false,opened:false});this.animate();
  },
  animate(){
    if(!this.visible||!this.s||!this.model||this.raf!=null)return;
    const loop=()=>{
      this.raf=null;if(!this.visible)return;
      const m=this.model,now=Date.now();
      if(this.finish){
        const u=Math.min(1,(now-this.finish.at)/this.finish.duration);
        m.p=this.finish.from+(1-this.finish.from)*u*u*(3-2*u);
        if(u===1){this.finish=null;this.open();}
      }
      this.bounds=render(this.s,m,now);
      if(m.openAt!==null && now-m.openAt>=revealDuration(m.cards.length) && !this.data.opened){
        this.setData({busy:false,opened:true,hint:'已获得 '+m.cards.length+' 张'});
      }
      if(!this.data.opened || m.flips.some(f=>f && now-f.at<450))
        this.raf=this.s.canvas.requestAnimationFrame(loop);
    };
    this.raf=this.s.canvas.requestAnimationFrame(loop);
  },
  point(e){
    const p=e.changedTouches[0];return {x:p.clientX-this.s.left,y:p.clientY-this.s.top,id:p.identifier};
  },
  start(e){
    if(!this.bounds||this.data.busy||this.gesture)return;
    const pt=this.point(e),b=this.bounds,m=this.model;
    if(this.data.opened){this.gesture={...pt,tap:true};return;}
    if(pt.x<b.bx-10||pt.x>b.bx+b.bw+10||pt.y<b.by-16||pt.y>b.by+b.bh+10)return;
    this.gesture={...pt,from:m.p};
  },
  move(e){
    const g=this.gesture;if(!g||g.tap||this.data.busy)return;
    const pt=this.point(e);if(pt.id!==g.id)return;
    const dx=pt.x-g.x,dy=pt.y-g.y,m=this.model;
    if(!m.p){if(Math.abs(dx)<8 || Math.abs(dx)<Math.abs(dy)*.5)return;m.dir=Math.sign(dx);}
    m.p=Math.max(m.p,Math.min(1,g.from+(g.from?Math.abs(dx):dx*m.dir)/(this.bounds.bw*.85)));
    if(m.p===1){this.gesture=null;this.open();}
  },
  cancel(){this.gesture=null;},
  end(e){
    const g=this.gesture;if(!g)return;
    const pt=this.point(e);if(pt.id!==g.id)return;
    this.gesture=null;
    if(g.tap){
      if(Math.hypot(pt.x-g.x,pt.y-g.y)>16)return;
      const hit=this.model.targets.slice().reverse().find(o=>{
        const dx=pt.x-o.x,dy=pt.y-o.y,c=Math.cos(o.angle),s=Math.sin(o.angle);
        return Math.abs(dx*c+dy*s)<o.w/2 && Math.abs(dy*c-dx*s)<o.h/2;
      });
      if(hit){const flip=this.model.flips[hit.i],now=Date.now();
        if(flip&&now-flip.at<420)return;
        const from=flip?flip.to:1;
        this.model.flips[hit.i]={at:now,from,to:1-from};this.animate();}
    }else if(this.model.p>.55)this.finishTear();
    else if(this.model.p)this.setData({hint:'继续横向撕开'});
  },
  action(){if(this.data.opened)this.reset(this.fixedPack||store.randomPack());else this.finishTear();},
  finishTear(){
    if(this.data.busy)return;this.setData({busy:true,hint:''});
    this.finish={at:Date.now(),from:this.model.p,duration:this.model.p?180:430};this.animate();
  },
  async open(){
    if(this.loading || this.model.openAt!==null)return;
    this.loading=true;this.setData({busy:true,hint:'正在拆包…'});
    let cards;
    try{
      cards=await store.draw(this.poolId,this.data.pack.id,this.requestId);
      await Promise.all(cards.flatMap(sources).map(src=>this.s.load(src)));
    }catch(e){
      this.reset(this.data.pack,this.requestId);
      wx.showModal({title:cards?'已收入卡册，卡面加载失败':'拆包失败',content:e.message,showCancel:false});return;
    }
    this.model.cards=cards;this.model.openAt=Date.now();this.loading=false;this.animate();
  }
});
