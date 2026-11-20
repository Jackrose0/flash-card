const store=require('../../lib/store');
const {surface,sources,inspectCard}=require('../../lib/art');
const {render,revealDuration}=require('../../lib/scene');
const initialHint='按住卡包，向一侧撕开';
Page({
  data:{pack:store.packs[0],hint:initialHint,busy:false,ready:false,opened:false},
  onLoad(query){
    this.poolId=query.pool;
    this.preview=query.preview==='1';
    this.lookRevision=0;
    const capsule=wx.getMenuButtonBoundingClientRect();
    this.setData({pack:store.randomPack(),top:capsule.top,barHeight:capsule.height});
  },
  back(){wx.navigateBack();},
  async onReady(){
    if(!this.poolId)return;
    try{
      const db=this.preview?null:await store.readHome();
      const pool=this.preview?await store.readTestPool(this.poolId):db.pools.find(p=>p.id===this.poolId);
      if(!pool)throw Error('这个卡池暂时没有可抽的卡');
      if(db){
        this.pendingKey='candy.draw.pending.'+db.who.id+'.'+this.poolId;
        this.pending=wx.getStorageSync(this.pendingKey)||null;
      }
      this.setData({poolName:pool.name,preview:this.preview,cardsPerPack:pool.cardsPerPack,drawCost:db?.drawCost||0,
        stardust:db?.stardust||0,checkedIn:db?.checkedIn||false,checkinReward:db?.checkinReward||0});
      this.s=await surface(this,'#scene');
      this.fixedPack=pool.pack;
      if(this.fixedPack)await this.s.load(this.fixedPack.src);
      else await Promise.all(store.packs.map(p=>this.s.load('/assets/'+p.id+'-pack.png')));
      if(!this.disposed)this.reset(this.fixedPack||store.packs.find(p=>p.id===this.pending?.skin)||this.data.pack);
    }catch(e){wx.showModal({title:'卡包加载失败',content:e.message,showCancel:false});}
  },
  onShow(){this.visible=true;if(this.model)this.animate();},
  onHide(){this.visible=false;this.gesture=null;this.stop();},
  onUnload(){this.disposed=true;this.lookRevision++;this.look=null;this.onHide();},
  stop(){if(this.raf!=null){this.s.canvas.cancelAnimationFrame(this.raf);this.raf=null;}},
  reset(pack){
    this.stop();this.gesture=null;this.finish=null;this.loading=false;
    this.model={pack,p:0,dir:1,cards:[],flips:[],openAt:null,targets:[],resultTop:this.data.top+this.data.barHeight+14};
    this.setData({pack,ready:true,busy:false,opened:false,canGoAlbum:false});this.refreshActions();this.animate();
  },
  refreshActions(message){
    const blocked=!this.preview&&!this.pending&&!this.response&&this.data.stardust<this.data.drawCost;
    this.setData({blocked,pending:!!this.pending,hasResponse:!!this.response,
      hint:message||(this.pending?'上次拆包结果未确认':blocked?'星尘不足 · 每发 '+this.data.drawCost+' 星尘':
        this.preview?'仅自己可见 · '+this.data.cardsPerPack+' 张/发':initialHint)});
  },
  clearPending(){
    if(this.pendingKey)wx.removeStorageSync(this.pendingKey);
    this.pending=null;
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
        this.setData({busy:false,opened:true,canGoAlbum:!this.preview,hint:(this.preview?'本次试抽 ':'已获得 ')+m.cards.length+' 张'});
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
    if(this.data.blocked||this.pending||this.response)return;
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
  action(){if(this.pending||this.response)this.open();else this.finishTear();},
  again(){this.response=null;this.reset(this.fixedPack||store.randomPack());},
  album(){wx.switchTab({url:'/pages/album/index'});},
  async checkin(){
    this.setData({checkingIn:true});
    try{this.setData(await store.api('/checkin','POST'));this.refreshActions();}
    catch(err){wx.showToast({title:err.message,icon:'none'});}
    finally{this.setData({checkingIn:false});}
  },
  finishTear(){
    if(this.data.busy||this.data.blocked||this.pending||this.response)return;
    this.setData({busy:true,hint:''});
    this.finish={at:Date.now(),from:this.model.p,duration:this.model.p?180:430};this.animate();
  },
  async open(){
    if(this.loading||this.model.openAt!==null||this.data.blocked)return;
    const resumeOnly=!!this.pending,requestId=this.pending?.requestId||store.id();
    const skin=this.pending?.skin||this.data.pack.id;
    this.loading=true;this.setData({busy:true,hint:resumeOnly?'正在找回结果…':'正在拆包…'});
    if(this.pendingKey&&!this.pending){
      this.pending={requestId,skin};wx.setStorageSync(this.pendingKey,this.pending);
    }
    try{
      this.response=this.response||await store.draw(this.poolId,skin,requestId,this.preview,resumeOnly);
      if(this.disposed)return;
      if(!this.preview)this.setData({stardust:this.response.stardust});
      await Promise.all(this.response.cards.flatMap(sources).map(src=>this.s.load(src)));
      if(this.disposed)return;
    }catch(e){
      if(!this.response&&e.status>=400&&e.status<500&&e.status!==408)this.clearPending();
      if(this.disposed)return;
      this.loading=false;this.model.p=0;
      if(Number.isFinite(e.stardust))this.setData({stardust:e.stardust,checkedIn:e.checkedIn});
      this.setData({busy:false,canGoAlbum:!!this.response&&!this.preview});
      this.refreshActions(this.response&&!this.preview?'已收入卡组，卡图加载失败':
        e.code==='insufficient_stardust'?'星尘不足 · 每发 '+this.data.drawCost+' 星尘':e.message);
      this.animate();return;
    }
    this.clearPending();
    this.model.p=1;this.model.cards=this.response.cards;this.model.openAt=Date.now();this.loading=false;this.animate();
  },
  async inspect(){
    const current=++this.lookRevision;
    await new Promise(resolve=>this.setData({inspecting:true,lookIndex:0,lookFront:true,lookName:'',lookTier:'',lookCount:this.model.cards.length},resolve));
    try{
      const look=await surface(this,'#inspectCanvas');
      if(current===this.lookRevision){this.look=look;this.showCard(0);}
    }catch(err){if(current===this.lookRevision){this.closeInspect();wx.showToast({title:err.message,icon:'none'});}}
  },
  closeInspect(){
    this.lookRevision++;
    this.look=null;this.lookCard=null;this.lookGesture=null;
    this.setData({inspecting:false},()=>this.animate());
  },
  async showCard(index){
    const current=++this.lookRevision;
    const cards=this.model.cards;
    const selected=(index+cards.length)%cards.length,card=cards[selected];
    this.lookCard=null;
    this.look.ctx.clearRect(0,0,this.look.w,this.look.h);
    this.setData({lookIndex:selected,lookName:card.name,lookTier:card.tierName||'',lookFront:true});
    try{
      await Promise.all(sources(card).map(src=>this.look.load(src)));
      if(current!==this.lookRevision)return;
      this.lookCard=card;inspectCard(this.look,card,this.data.lookFront);
      const full=store.fullCard(card);
      await Promise.all(sources(full).map(src=>this.look.load(src)));
      if(current===this.lookRevision){this.lookCard=full;inspectCard(this.look,full,this.data.lookFront);}
    }catch(e){if(current===this.lookRevision&&!this.lookCard)wx.showToast({title:'卡图加载失败',icon:'none'});}
  },
  previous(){if(this.look&&this.data.lookCount>1)this.showCard(this.data.lookIndex-1);},
  next(){if(this.look&&this.data.lookCount>1)this.showCard(this.data.lookIndex+1);},
  flipInspect(){
    const front=!this.data.lookFront;
    this.setData({lookFront:front});
    if(this.lookCard)inspectCard(this.look,this.lookCard,front);
  },
  startInspect(e){this.lookGesture=e.changedTouches[0];},
  endInspect(e){
    if(!this.lookGesture)return;
    const from=this.lookGesture,to=e.changedTouches[0];
    this.lookGesture=null;
    const dx=to.clientX-from.clientX,dy=to.clientY-from.clientY;
    if(Math.abs(dx)>35&&Math.abs(dx)>Math.abs(dy)){if(dx<0)this.next();else this.previous();}
    else if(Math.hypot(dx,dy)<12)this.flipInspect();
  },
  cancelInspect(){this.lookGesture=null;}
});
