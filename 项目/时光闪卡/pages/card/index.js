const store=require('../../lib/store');
const {surface,dimensions,sources,cardFace}=require('../../lib/art');
const {createCardRenderer}=require('../../lib/holo');
const {report}=require('../../lib/files');
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
const settingsKey='candy.holo.display';
const ticksPerUnit={depth:10,glow:20};

function lightSetting(key,ticks){
  const depth=key==='depth';
  const rounded=Number.isFinite(ticks)?Math.round(ticks):(depth?0:3);
  const tick=clamp(rounded,depth?-30:0,depth?30:20)||0;
  return {[key+'Tick']:tick,[key]:tick/ticksPerUnit[key]};
}

Page({
  data:{ready:false,depth:0,glow:.15,adjust:false,motion:false,flat:false},
  onLoad(query){this.cardId=query.id;this.studioPreview=query.studio==='1';},
  async onReady(){
    try{
      const detail=await (this.studioPreview?store.readStudio():store.readCard(this.cardId));
      const card=this.studioPreview?detail.cards.find(c=>c.id===this.cardId):detail.card;
      if(!card){wx.navigateBack();return;}
      const win=wx.getWindowInfo(),ratio=dimensions(card.ratio);
      const width=Math.min(win.windowWidth-12,(win.windowHeight*.67)*ratio);
      const prefs=wx.getStorageSync(settingsKey)||{};
      const depth=lightSetting('depth',(prefs.depth??0)*ticksPerUnit.depth);
      const glow=lightSetting('glow',(prefs.glow??.15)*ticksPerUnit.glow);
      await new Promise(ok=>this.setData({card,width,height:width/ratio,canDownloadCards:detail.who.canDownloadCards,...depth,...glow},ok));
      if((prefs.depth!=null && prefs.depth!==depth.depth)||(prefs.glow!=null && prefs.glow!==glow.glow)){
        wx.setStorageSync(settingsKey,{depth:depth.depth,glow:glow.glow});
      }
      wx.setNavigationBarTitle({title:card.name});
      this.x=this.y=this.tx=this.ty=this.face=0;
      this.s=await surface(this,'#original');
      await Promise.all(sources(this.data.card).map(src=>this.s.load(src)));
      if(this.disposed)return;
      const result=await new Promise(ok=>wx.createSelectorQuery().in(this).select('#viewer').fields({node:true},ok).exec());
      if(this.disposed)return;
      this.canvas=result.node;
      this.holoRenderer=createCardRenderer(this.canvas,this.s,this.data.card);
      this.holoRenderer.draw(-3,-8,.95,this.data.depth,this.data.glow);
      this.x=-3;this.y=-8;this.setData({ready:true});this.requestPose();
    }catch(e){
      if(this.disposed)return;
      if(e.status===404){wx.navigateBack();return;}
      if(this.s && sources(this.data.card).every(src=>this.s.images.has(src))){
        const {ctx,w,h,images}=this.s;ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2,h/2);
        cardFace(ctx,images,this.data.card,w,h,true);ctx.restore();
        this.setData({flat:true,ready:true});
        wx.showToast({title:'当前设备使用静态卡面',icon:'none'});
      }else report(e);
    }
  },
  onShow(){this.visible=true;if(this.holoRenderer)this.requestPose();},
  onHide(){this.visible=false;this.touch=null;this.stopMotion();
    if(this.frame!=null){this.canvas.cancelAnimationFrame(this.frame);this.frame=null;}
  },
  onUnload(){this.disposed=true;this.onHide();if(this.holoRenderer)this.holoRenderer.dispose();},
  requestPose(){
    if(!this.holoRenderer||!this.visible||this.frame!=null)return;
    const draw=()=>{
      this.frame=null;if(!this.visible)return;
      this.x+=(this.tx-this.x)*.18;this.y+=(this.ty-this.y)*.18;
      const more=Math.abs(this.tx-this.x)+Math.abs(this.ty-this.y)>.08;
      if(!more){this.x=this.tx;this.y=this.ty;}
      this.holoRenderer.draw(this.x,this.y,.95,this.data.depth,this.data.glow);
      if(more)this.frame=this.canvas.requestAnimationFrame(draw);
    };
    this.frame=this.canvas.requestAnimationFrame(draw);
  },
  start(e){
    if(!this.holoRenderer||this.touch)return;
    const p=e.changedTouches[0];this.touch={id:p.identifier,x:p.clientX,y:p.clientY,rx:this.x,ry:this.y,moved:false};
  },
  move(e){
    const s=this.touch,p=e.changedTouches[0];if(!s||p.identifier!==s.id)return;
    const dx=p.clientX-s.x,dy=p.clientY-s.y;
    if(Math.hypot(dx,dy)>5)s.moved=true;
    if(s.moved){this.tx=clamp(s.rx-dy*.33,-48,48);this.ty=s.ry+dx*.62;this.requestPose();}
  },
  end(e){
    if(!this.touch||this.touch.id!==e.changedTouches[0].identifier)return;
    const tap=!this.touch.moved;this.touch=null;
    if(tap)this.flip();else this.rest();
  },
  cancel(){this.touch=null;this.rest();},
  rest(){this.face=Math.round(this.ty/180)*180;this.tx=0;this.ty=this.face;this.requestPose();},
  flip(){this.face=Math.round(this.ty/180)*180+180;this.tx=0;this.ty=this.face;this.requestPose();},
  adjust(){this.setData({adjust:!this.data.adjust});},
  tune(e){const k=e.currentTarget.dataset.key;
    this.setData(lightSetting(k,Number(e.detail.value)));this.requestPose();
    if(e.type==='change')wx.setStorageSync(settingsKey,{depth:this.data.depth,glow:this.data.glow});
  },
  toggleMotion(){
    if(this.listening || this.startingMotion){this.stopMotion();return;}
    this.startingMotion=true;
    wx.startDeviceMotionListening({interval:'game',success:()=>{
      if(!this.startingMotion||!this.visible){wx.stopDeviceMotionListening();return;}
      this.startingMotion=false;this.listening=true;this.origin=null;
      this.sensor=v=>{
        if(!this.origin)this.origin=v;
        if(this.touch)return;
        this.tx=clamp((v.beta-this.origin.beta)*.65,-35,35);
        this.ty=this.face+clamp((v.gamma-this.origin.gamma)*.75,-38,38);this.requestPose();
      };
      wx.onDeviceMotionChange(this.sensor);this.setData({motion:true});
    },fail:()=>{this.startingMotion=false;wx.showToast({title:'感应不可用，可拖动卡面',icon:'none'});}});
  },
  stopMotion(){
    this.startingMotion=false;
    if(!this.listening)return;
    this.listening=false;wx.offDeviceMotionChange(this.sensor);wx.stopDeviceMotionListening();
    if(!this.disposed)this.setData({motion:false});this.tx=0;this.ty=this.face;
    if(this.visible)this.requestPose();
  },
  async shareCardFile(){
    if(!wx.canIUse('shareFileMessage')){
      wx.showToast({title:'当前微信版本无法发送文件',icon:'none'});
      return;
    }
    this.setData({sharingFile:true});
    try{
      const filePath=await store.downloadCard(this.cardId);
      if(this.disposed)return;
      const fileName=this.data.card.name.replace(/[<>:"/\\|?*]/g,'_')+'-互动闪卡.html';
      await wx.shareFileMessage({filePath,fileName});
    }catch(e){
      if(!this.disposed&&!e.errMsg?.includes('cancel'))report(e.message?e:Error('文件发送失败，请重试'));
    }finally{
      if(!this.disposed)this.setData({sharingFile:false});
    }
  },
  exportCard(){wx.canvasToTempFilePath({canvas:this.s.canvas,fileType:'png',success:r=>wx.previewImage({urls:[r.tempFilePath]}),fail:report},this);}
});
