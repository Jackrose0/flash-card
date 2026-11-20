function surface(page,selector){
  return new Promise((resolve,reject)=>wx.createSelectorQuery().in(page).select(selector)
    .fields({node:true,size:true,rect:true},res=>{
      if(!res||!res.node){reject(Error('画布初始化失败'));return;}
      const canvas=res.node, ctx=canvas.getContext('2d');
      const dpr=Math.min(2,wx.getWindowInfo().pixelRatio);
      canvas.width=Math.round(res.width*dpr);canvas.height=Math.round(res.height*dpr);
      ctx.scale(dpr,dpr);
      const images=new Map(), pending=new Map();
      function load(src){
        if(!src||images.has(src))return Promise.resolve();
        if(pending.has(src))return pending.get(src);
        const promise=new Promise((ok,fail)=>{
          const img=canvas.createImage();
          img.onload=()=>{images.set(src,img);pending.delete(src);ok();};
          img.onerror=()=>{pending.delete(src);fail(Error('素材读取失败，请重新选择图片'));};
          img.src=src;
        });pending.set(src,promise);return promise;
      }
      resolve({canvas,ctx,w:res.width,h:res.height,images,load,left:res.left,top:res.top});
    }).exec());
}
function dimensions(ratio){const [w,h]=ratio.split('x').map(Number);return w/h;}
function sources(c){return [c.background,c.subject,c.frame,c.back].filter(Boolean);}
function round(ctx,x,y,w,h,r){
  r=Math.min(r,w*.5,h*.5);ctx.beginPath();ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}
function blit(ctx,img,x,y,w,h,cover){
  if(!img)return;
  const s=(cover?Math.max:Math.min)(w/img.width,h/img.height);
  ctx.drawImage(img,x+(w-img.width*s)/2,y+(h-img.height*s)/2,img.width*s,img.height*s);
}
function cardLabel(ctx,c,w,h){
    if(c.dex){
      ctx.save();ctx.translate(-w/2,-h/2);ctx.scale(w/500,h/700);
      ctx.fillStyle='#faeac1';ctx.textAlign='center';ctx.font='bold 21px monospace';
      ctx.fillText('#'+String(c.dex).padStart(3,'0'),437,46);
      ctx.textAlign='right';ctx.font='italic 16px Georgia, serif';ctx.fillText(c.english,395,677);
      ctx.restore();
    }
    ctx.fillStyle='#fffaf0';ctx.font='bold '+Math.max(8,Math.min(w*.095,h*.09))+'px sans-serif';
    ctx.shadowColor='#604561';ctx.shadowBlur=3;ctx.fillText((c.special?'✦ ':'')+c.name,-w*.4,h*.41,w*.8);
}
function cardFace(ctx,images,c,w,h,front,glow=0){
  const x=-w/2,y=-h/2;
  ctx.save();round(ctx,x,y,w,h,Math.min(w,h)*.06);ctx.clip();
  ctx.fillStyle=front?c.color:'#9c7fba';ctx.fillRect(x,y,w,h);
  if(front){
    if(c.background)blit(ctx,images.get(c.background),x,y,w,h,true);
    blit(ctx,images.get(c.subject),x+w*.12,y+h*.13,w*.76,h*.67,false);
    if(c.frame&&images.has(c.frame))ctx.drawImage(images.get(c.frame),x,y,w,h);
    if(glow){const grad=ctx.createLinearGradient(x-w*.4+glow*w,y,x+w*.45+glow*w,y+h);
      grad.addColorStop(0,'rgba(255,255,255,0)');grad.addColorStop(.46,'rgba(168,255,242,.08)');
      grad.addColorStop(.52,'rgba(255,247,187,.36)');grad.addColorStop(.6,'rgba(238,169,248,.15)');
      grad.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=grad;ctx.fillRect(x,y,w,h);}
    cardLabel(ctx,c,w,h);
  } else if(c.back){
    blit(ctx,images.get(c.back),x,y,w,h,true);
  } else {
    const grad=ctx.createLinearGradient(x,y,w/2,h/2);grad.addColorStop(0,'#9b88cd');grad.addColorStop(.5,'#f1b7cf');grad.addColorStop(1,'#89cec3');
    ctx.fillStyle=grad;ctx.fillRect(x,y,w,h);
    ctx.strokeStyle='rgba(255,255,255,.48)';ctx.lineWidth=w*.012;
    for(let i=-h;i<w+h;i+=w*.15){ctx.beginPath();ctx.moveTo(x+i,y);ctx.lineTo(x+i-h,y+h);ctx.stroke();}
    ctx.strokeStyle='#fff5e9';ctx.lineWidth=w*.025;round(ctx,x+w*.055,y+h*.045,w*.89,h*.91,w*.05);ctx.stroke();
    ctx.fillStyle='#fff6e9';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold '+w*.35+'px sans-serif';ctx.fillText('✦',0,0);
  }
  ctx.restore();
}
function inspectCard({ctx,w,h,images},card,front){
  const ratio=dimensions(card.ratio);
  const width=Math.min(w*.9,h*.93*ratio,460);
  ctx.clearRect(0,0,w,h);
  ctx.save();ctx.translate(w/2,h/2);
  cardFace(ctx,images,card,width,width/ratio,front);
  ctx.restore();
}
module.exports={surface,dimensions,sources,cardFace,cardLabel,blit,inspectCard};
