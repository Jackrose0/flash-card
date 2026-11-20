const {dimensions,cardFace}=require('./art');
const palette=['#ff5488','#ff9c5f','#ffdc5b','#55dbab','#59c3ff','#967cf8','#f578d2'];
const clamp=n=>Math.max(0,Math.min(1,n));
const ease=n=>n*n*(3-2*n);
const revealDelay=30;
const revealDuration=count=>1510+Math.max(0,count-1)*revealDelay;
// 包图中顶部压纹下沿的左端、右端和高度，按原图宽高归一化。
const packSeals={
  kanto:[.044,.960,.064],
  gen2:[.079,.919,.070], gen3:[.076,.925,.060], gen4:[.084,.916,.060],
  gen5:[.077,.925,.062], gen6:[.081,.918,.064], gen7:[.080,.919,.061],
  gen8:[.069,.929,.065], gen9:[.086,.914,.064]
};

function resultGrid(w,h,top,count){
  const width=Math.min(w-24,860),height=Math.max(1,h-top-18);
  const gap=Math.min(14,Math.max(6,w*.025));
  let best;
  for(let columns=2;columns<=Math.min(count,5);columns++){
    const rows=Math.ceil(count/columns);
    const cellWidth=(width-(columns-1)*gap)/columns;
    const cellHeight=(height-(rows-1)*gap)/rows;
    const size=Math.min(cellWidth,cellHeight*5/7);
    if(!best||size>best.size)best={rows,cellWidth,cellHeight,size};
  }
  const {rows,cellWidth,cellHeight}=best;
  const poses=[];
  for(let row=0;row<rows;row++){
    const inRow=Math.ceil((row+1)*count/rows)-Math.ceil(row*count/rows);
    for(let column=0;column<inRow;column++){
      poses.push({x:(column-(inRow-1)/2)*(cellWidth+gap),
        y:top+(row+.5)*cellHeight+row*gap-h/2,w:cellWidth,h:cellHeight});
    }
  }
  return poses;
}

function render(surface,model,now){
  const {ctx,w,h,images}=surface,{pack,p,dir,openAt,cards}=model;
  const t=now/1000,elapsed=openAt===null?-1:(now-openAt)/1000;
  const packArt=images.get(pack.src||'/assets/'+pack.id+'-pack.png');
  const ratio=pack.custom&&packArt?packArt.width/packArt.height:1/1.414;
  const bw=Math.min(w*.65,h*.764*ratio,280),bh=bw/ratio;
  const bx=(w-bw)/2,by=(h-bh)/2+7+(p||elapsed>=0?0:Math.sin(t*1.5)*2);
  const [left,right,sealY]=(!pack.custom&&packSeals[pack.id])||[.012,.990,.071];
  const sealWidth=(right-left)*bw;
  const sealX=u=>left*bw+sealWidth*(dir>0?u:1-u);
  const cutY=x=>{const u=x/bw;return bh*(sealY+.002*Math.sin(u*86)+.0012*Math.sin(u*179));};
  ctx.clearRect(0,0,w,h);
  ctx.save();ctx.translate(bx+bw*.5,by+bh+10);ctx.scale(1,.13);
  const shadow=ctx.createRadialGradient(0,0,0,0,0,bw*.4);shadow.addColorStop(0,'rgba(67,43,63,'+(.22*(1-clamp(elapsed*3)))+')');shadow.addColorStop(1,'rgba(67,43,63,0)');
  ctx.fillStyle=shadow;ctx.fillRect(-bw*.4,-bw*.4,bw*.8,bw*.8);ctx.restore();
  if(p>0 && elapsed>=0 && elapsed<.3){
    ctx.save();ctx.translate(bx,by);
    ctx.globalAlpha=(1-clamp(elapsed/.3))**2;
    const unit=bw/100;
    for(let i=0;i<28;i++){
      const l=i/28,r=Math.min(p,(i+1)/28);
      if(l>=r)break;
      const head=Math.min(136,(now-openAt)*.42+12);
      const edge=(root,d)=>{
        const x=sealX(root),sway=Math.min(1,d/6)*(Math.sin(d*.46-t*8+root*5)+.5*Math.sin(d*.19-t*4));
        return [x+((x/bw-.5)/.55*d+dir*sway)*unit,cutY(x)-d*unit];
      };
      const [x,y]=edge((l+r)/2,0);
      const color=palette[i%7],gradient=ctx.createLinearGradient(x,y,x,y-25*unit);gradient.addColorStop(0,'#fff5cf');gradient.addColorStop(.65,color);
      ctx.fillStyle=gradient;ctx.beginPath();ctx.moveTo(...edge(l,0));const steps=Math.ceil(head/3);
      for(let j=1;j<=steps;j++)ctx.lineTo(...edge(l,head*j/steps));
      for(let j=steps;j>=0;j--)ctx.lineTo(...edge(r,head*j/steps));
      ctx.closePath();ctx.fill();ctx.lineWidth=.25*unit;ctx.strokeStyle='#fff2dc';ctx.stroke();
      const d=(t*(22+i%4*3)+i*11)%63;if(i%2===0&&d>0&&d<head){const [x,y]=edge((l+r)/2,d);ctx.fillStyle='white';ctx.beginPath();ctx.arc(x,y,.5*unit,0,Math.PI*2);ctx.fill();}
    }ctx.restore();
  }
  model.targets=[];
  if(cards.length){
    const grid=cards.length>3?resultGrid(w,h,model.resultTop,cards.length):null;
    const center=(cards.length-1)/2;
    const poses=cards.map((card,i)=>{
      const since=elapsed-i*revealDelay/1000,shot=clamp(since/.21),u=clamp((since-.21)/1.25);
      const spread=ease(clamp((u-.48)/.52)),ring=Math.sin(Math.min(1,u/.35)*Math.PI/2)*(1-spread);
      const a=((i-center)*2.09+Math.PI*2.1)*(1-u)**2+Math.PI*.5-(i-center)*.55;
      const cell=grid?.[i];
      const lx=cell?cell.x:cards.length===1?0:[-.225,.225,0][i]*w;
      const ly=cell?cell.y:cards.length<3?0:[-.198,-.198,.227][i]*h;
      const ratio=dimensions(card.ratio),fw=Math.min(cell?.w??w*.39,(cell?.h??h*.39)*ratio),fh=fw/ratio;
      const s=1+(Math.min(bw*.78/fw,bh*.72/fh)-1)*(1-ease(u));
      const x=w/2+Math.cos(a)*w*.31*ring+lx*spread;
      const y=h/2+(.045-.246*(1-(1-shot)**2))*h*(1-ease(u))+Math.sin(a)*w*.072*ring+ly*spread;
      const angle=(cell||cards.length===1?0:[-.075,.075,-.035][i])*spread-.15*Math.cos(a)*ring;
      const flip=model.flips[i];let f=ease(clamp((u-.38)/.4));
      if(flip)f=flip.from+(flip.to-flip.from)*ease(clamp((now-flip.at)/420));
      return {i,card,x,y,w:fw*s,h:fh*s,angle,f,z:ring*Math.sin(a)*5-i*.015};
    }).sort((a,b)=>a.z-b.z);
    for(const o of poses){
      ctx.save();ctx.translate(o.x,o.y);ctx.rotate(o.angle);ctx.scale(Math.max(.018,Math.abs(Math.cos(o.f*Math.PI))),1);
      cardFace(ctx,images,o.card,o.w,o.h,o.f>=.5,.45+.4*Math.sin(t*2+o.i));ctx.restore();
      model.targets.push(o);
    }
  }
  if(packArt && elapsed<.8){
    ctx.save();ctx.translate(bx,by);
    if(!p){ctx.drawImage(packArt,0,0,bw,bh);}
    else{
      const start=dir>0?0:bw,end=bw-start,tip=sealX(p),yt=cutY(tip);
      const startY=cutY(sealX(0)),segments=Math.ceil(70*p);
      const trace=reverse=>{
        for(let j=0;j<=segments;j++){
          const x=sealX(p*(reverse?1-j/segments:j/segments));
          ctx.lineTo(x,cutY(x));
        }
      };
      ctx.save();
      if(elapsed>=0){ctx.translate(bw*.11*elapsed,bh*(1.6*elapsed+4*elapsed*elapsed));ctx.rotate(.28*elapsed);}
      ctx.beginPath();
      if(p===1)ctx.moveTo(end,yt);
      else{ctx.moveTo(tip,0);ctx.lineTo(end,0);}
      ctx.lineTo(end,bh);ctx.lineTo(start,bh);ctx.lineTo(start,startY);trace(false);ctx.closePath();
      ctx.clip();ctx.drawImage(packArt,0,0,bw,bh);
      ctx.beginPath();trace(false);ctx.lineWidth=bw*.005;ctx.strokeStyle='#fff1d9';ctx.stroke();ctx.restore();
      ctx.save();ctx.translate(tip+Math.max(0,elapsed)*dir*bw*.7,yt-Math.max(0,elapsed)*bh*1.8);
      ctx.rotate(dir*(.032+p*.15+Math.max(0,elapsed)*2));ctx.translate(-tip,-yt);
      ctx.beginPath();ctx.moveTo(start,0);
      if(p===1){ctx.lineTo(end,0);ctx.lineTo(end,yt);}
      else ctx.lineTo(tip,0);
      trace(true);ctx.lineTo(start,startY);ctx.closePath();ctx.clip();ctx.drawImage(packArt,0,0,bw,bh);ctx.restore();
    }ctx.restore();
  }
  return {bx,by,bw,bh,sealLeft:bx+left*bw,sealRight:bx+right*bw,sealY:by+sealY*bh};
}
module.exports={render,revealDuration};
