// Adapted from holo-card (MIT). See HOLO-LICENSE.txt.
const {blit,cardLabel,cardFace}=require('./art');
const vertex = `uniform vec2 pose,fit; uniform float aspect; attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;vec3 v=vec3(position.x*cos(pose.y),position.y*aspect,-position.x*sin(pose.y));
float y=v.y*cos(pose.x)-v.z*sin(pose.x),z=v.y*sin(pose.x)+v.z*cos(pose.x);
gl_Position=vec4(v.x*fit.x,y/aspect*fit.y,0.,1.-z*.24);}`;
const fragment = `precision highp float;
varying vec2 uv; uniform sampler2D art,bg,uiTex,bloomNear,bloomWide,reverseTex; uniform float extracted, cardAspect; uniform vec2 view; uniform float depth, contourBrightness, power, glowPass, pixelWidth;
vec4 encodeHDR(vec3 c){float m=clamp(ceil(max(max(c.r,c.g),c.b)/64.*255.)/255.,1./255.,1.);return vec4(c/(64.*m),m);}
vec3 decodeHDR(vec4 c){return c.rgb*c.a*64.;}
vec2 extrema(vec4 values){
 return vec2(min(min(values.x,values.y),min(values.z,values.w)),max(max(values.x,values.y),max(values.z,values.w)));
}
vec2 structure(vec2 p,vec4 center){
 vec2 stepUV=vec2(1.,1./cardAspect)*max(.0032,pixelWidth*1.5);
 vec4 l=texture2D(art,p-vec2(stepUV.x,0.)), r=texture2D(art,p+vec2(stepUV.x,0.));
 vec4 t=texture2D(art,p+vec2(0.,stepUV.y)), b=texture2D(art,p-vec2(0.,stepUV.y));
 vec2 d=stepUV*.7071;
 vec4 ne=texture2D(art,p+d), sw=texture2D(art,p-d);
 vec4 se=texture2D(art,p+vec2(d.x,-d.y)), nw=texture2D(art,p+vec2(-d.x,d.y));
 vec2 axisAlpha=extrema(vec4(l.a,r.a,t.a,b.a)), diagonalAlpha=extrema(vec4(ne.a,sw.a,se.a,nw.a));
 float minAlpha=min(center.a,min(axisAlpha.x,diagonalAlpha.x));
 float maxAlpha=max(center.a,max(axisAlpha.y,diagonalAlpha.y));
 float silhouette=smoothstep(.07,.65,maxAlpha-minAlpha);
 vec3 lum=vec3(.2126,.7152,.0722);
 vec2 axisLight=extrema(vec4(dot(l.rgb,lum),dot(r.rgb,lum),dot(t.rgb,lum),dot(b.rgb,lum)));
 vec2 diagonalLight=extrema(vec4(dot(ne.rgb,lum),dot(sw.rgb,lum),dot(se.rgb,lum),dot(nw.rgb,lum)));
 float centerLight=dot(center.rgb,lum);
 // A dark stroke also counts at its center, where opposite samples can have the same brightness.
 float contrast=max(centerLight,max(axisLight.y,diagonalLight.y))-min(centerLight,min(axisLight.x,diagonalLight.x));
 return vec2(silhouette,smoothstep(.07,.32,contrast)*smoothstep(.7,.98,minAlpha));
}
vec3 rainbow(float t){return .52+.48*cos(6.28318*(t+vec3(0.,.33,.67)));}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float band(vec2 p){float f=p.x*.65+p.y*.4+view.x*1.9+view.y*.85;return pow(max(0.,1.-abs(fract(f+.16)-.5)*2.),3.);}
void main(){
 vec2 p=uv;
 vec2 edge=abs((p-.5)*vec2(1.,cardAspect))-(vec2(.5,cardAspect*.5)-vec2(.045));
 float edgeDistance=length(max(edge,0.))+min(max(edge.x,edge.y),0.)-.045;
 float cardMask=1.-smoothstep(-pixelWidth,pixelWidth,edgeDistance);
 // All printed elements share one physical edge. Only the subject and scenery shift.
 if(cardMask<=0.){gl_FragColor=glowPass>.5?encodeHDR(vec3(0.)):vec4(0.);return;}
 if(!gl_FrontFacing && glowPass<.5){gl_FragColor=texture2D(reverseTex,vec2(1.-p.x,p.y))*cardMask;return;}
 vec2 a=p-view*.06*depth;
 vec2 b=(p-.5)*.94+.5-view*.042;
 vec4 ch=texture2D(art,a);
 vec3 base=texture2D(bg,b).rgb*(1.-.14*texture2D(art,a+vec2(-.008,.011)-view*.015).a);
 vec4 printed=texture2D(uiTex,p);
 vec3 ui=printed.rgb;
 float um=printed.a;
 float phase=p.x*.62+p.y*.36+view.x*1.9+view.y*.8;
 vec3 spectrum=rainbow(phase*2.2);float light=band(p);
 float micro=pow(hash(floor(p*vec2(620.,868.))),28.);
 base=mix(base,base*(.64+spectrum*.7)+spectrum*.07,light*.48*power);
 float envelope=smoothstep(.025,.42,light);
 vec2 lines=envelope>0.&&contourBrightness>0.?structure(a,ch):vec2(0.);
 vec3 outlineColor=mix(vec3(.88,.92,1.),spectrum,.42);
 vec3 emission=(outlineColor*lines.x*5.4+(spectrum*.75+.25)*lines.y*2.2)
   *envelope*power*contourBrightness;
 vec2 cell=fract(p*vec2(24.,34.))-.5;float seed=hash(floor(p*vec2(24.,34.)));float star=pow(max(0.,1.-abs(cell.x)*18.),14.)*pow(max(0.,1.-abs(cell.y)*2.),6.)+pow(max(0.,1.-abs(cell.y)*18.),14.)*pow(max(0.,1.-abs(cell.x)*2.),6.);
 base+=spectrum*(star*step(.965,seed)*light*.65+micro*light*.12)*power*(1.-ch.a)*cardMask;
 base=mix(base,ch.rgb,ch.a);
 base=mix(base,ui,um);

 float glare=pow(max(0.,1.-length((p-vec2(.5+view.x,.6+view.y))*vec2(1.,.75))),5.);
 base+=vec3(glare*.12*power);

 // Concentric rounded border in card-width units, matching the CSS outer radius.
 // Outer radius .045, uniform inset .015, inner radius .030.
 vec2 corner=abs((p-.5)*vec2(1.,cardAspect))-(vec2(.485,cardAspect*.5-.015)-vec2(.030));
 float distanceToInner=length(max(corner,0.))+min(max(corner.x,corner.y),0.)-.030;
 float inside=1.-smoothstep(-pixelWidth,pixelWidth,distanceToInner);
 float rim=(1.-inside)*(1.-extracted);
 base=mix(base,mix(vec3(.76,.67,.32),spectrum*.5+.5,.35*power)+glare*.15,rim);
 emission*=(1.-um);
 if(glowPass>.5){gl_FragColor=encodeHDR(max(emission-vec3(1.),vec3(0.)));return;}
 vec3 bloom=decodeHDR(texture2D(bloomNear,uv))*.55+decodeHDR(texture2D(bloomWide,uv))*.8;
 bloom*=(1.-um)*lines.x*envelope;
 // Display mapping is applied AFTER the HDR light and two-scale bloom are composed.
 vec3 linear=pow(clamp(base,0.,1.),vec3(2.2));
 vec3 combined=1.-(1.-linear)*exp(-(emission*.38+bloom*.85));
 gl_FragColor=vec4(pow(clamp(combined,0.,1.),vec3(1./2.2))*cardMask,cardMask);
}`;
const blurFragment = `precision highp float; varying vec2 uv;uniform sampler2D source;uniform vec2 stepSize;
vec3 decodeHDR(vec4 c){return c.rgb*c.a*64.;}
vec4 encodeHDR(vec3 c){float m=clamp(ceil(max(max(c.r,c.g),c.b)/64.*255.)/255.,1./255.,1.);return vec4(c/(64.*m),m);}
void main(){vec3 c=vec3(0.);float total=0.;for(int i=-4;i<=4;i++){float f=float(i);float w=exp(-f*f/8.);c+=decodeHDR(texture2D(source,uv+stepSize*f))*w;total+=w;}gl_FragColor=encodeHDR(c/total);}`;
function createCardRenderer(canvas, surface, card) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders = [],
    programs = [],
    textures = [],
    frames = [];
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) || 'Shader error');
    shaders.push(shader);
    return shader;
  }
  function program(source) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, source));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Shader link error');
    programs.push(p);
    return p;
  }
  const scene = program(fragment),
    blur = program(blurFragment);
  function use(p) {
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const a = gl.getAttribLocation(p, 'position');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  }
  function texture(filter) {
    const t = gl.createTexture();
    textures.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const {ctx,w,h,images}=surface;
  const artWidth=surface.canvas.width,artHeight=surface.canvas.height;
  const cardAspect=artHeight/artWidth;
  // Upload one aligned layer at a time. Typed-array texture uploads use bottom-up rows.
  function upload(paint) {
    ctx.clearRect(0,0,w,h);ctx.save();paint();ctx.restore();
    const pixels=ctx.getImageData(0,0,artWidth,artHeight).data;
    const bytes=new Uint8Array(pixels.length),stride=artWidth*4;
    for(let y=0;y<artHeight;y++)bytes.set(pixels.subarray(y*stride,(y+1)*stride),(artHeight-1-y)*stride);
    const tex=texture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,artWidth,artHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    return tex;
  }
  const artTextures=[
    upload(()=>blit(ctx,images.get(card.subject),w*.12,h*.13,w*.76,h*.67,false)),
    upload(()=>{ctx.fillStyle=card.color;ctx.fillRect(0,0,w,h);
      if(card.background)blit(ctx,images.get(card.background),0,0,w,h,true);}),
    upload(()=>{if(card.frame)ctx.drawImage(images.get(card.frame),0,0,w,h);
      ctx.translate(w/2,h/2);cardLabel(ctx,card,w,h);}),
    upload(()=>{ctx.translate(w/2,h/2);cardFace(ctx,images,card,w,h,false);})
  ];
  // Keep the separate 2D surface ready for the original composite export.
  ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2,h/2);
  cardFace(ctx,images,card,w,h,true);ctx.restore();
  canvas.width=artWidth;canvas.height=artHeight;
  let fitX=.87,fitY=.87;
  function target(scale) {
    const w = Math.round(artWidth * scale),
      h = Math.round(artHeight * scale);
    const t = texture(gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    const f = gl.createFramebuffer();
    frames.push(f);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      t,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Bloom framebuffer unavailable');
    return { t, f, w, h };
  }
  const emission = target(0.5),
    temp = target(0.5),
    near = target(0.5),
    wideTemp = target(0.25),
    wide = target(0.25);
  const sceneU = {
    view: gl.getUniformLocation(scene, 'view'),
    power: gl.getUniformLocation(scene, 'power'),
    depth: gl.getUniformLocation(scene, 'depth'),
    contourBrightness: gl.getUniformLocation(scene, 'contourBrightness'),
    pass: gl.getUniformLocation(scene, 'glowPass'),
  };
  use(scene);
  const pose=gl.getUniformLocation(scene,'pose'),fit=gl.getUniformLocation(scene,'fit');
  gl.uniform1f(gl.getUniformLocation(scene,'aspect'),cardAspect);
  gl.uniform1f(gl.getUniformLocation(scene,'cardAspect'),cardAspect);
  gl.uniform1f(gl.getUniformLocation(scene, 'extracted'), 1);
  gl.uniform1i(gl.getUniformLocation(scene, 'reverseTex'), 5);
  gl.uniform1f(gl.getUniformLocation(scene, 'pixelWidth'), 1 / artWidth);
  ['art', 'bg', 'uiTex', 'bloomNear', 'bloomWide'].forEach((name, i) =>
    gl.uniform1i(gl.getUniformLocation(scene, name), i),
  );
  use(blur);
  gl.uniform1i(gl.getUniformLocation(blur, 'source'), 0);
  gl.uniform2f(gl.getUniformLocation(blur,'pose'),0,0);
  gl.uniform2f(gl.getUniformLocation(blur,'fit'),1,1);
  gl.uniform1f(gl.getUniformLocation(blur,'aspect'),1);
  const step = gl.getUniformLocation(blur, 'stepSize');
  function bind(t, unit = 0) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }
  function blurPass(src, dst, x, y) {
    use(blur);
    bind(src.t);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.uniform2f(step, x / src.w, y / src.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  return {
    resize(width,height,cardWidth) {
      if(canvas.width!==width)canvas.width=width;
      if(canvas.height!==height)canvas.height=height;
      fitX=cardWidth/width;
      fitY=cardWidth*cardAspect/height;
    },
    draw(x, y, strength, depth = 0, contourBrightness = 0.15) {
      const pitch=x*Math.PI/180,yaw=y*Math.PI/180;
      const sinPitch=Math.sin(pitch),cosPitch=Math.cos(pitch),sinYaw=Math.sin(yaw),cosYaw=Math.cos(yaw);
      // Project the four corners with the same perspective as the vertex shader.
      let projectedExtent=0;
      for(const side of [-1,1])for(const end of [-1,1]){
        const z=-side*sinYaw,vertical=end*cardAspect;
        const screenY=vertical*cosPitch-z*sinPitch;
        const perspective=1-.24*(vertical*sinPitch+z*cosPitch);
        projectedExtent=Math.max(projectedExtent,Math.max(Math.abs(cosYaw*fitX),Math.abs(screenY/cardAspect*fitY))/perspective);
      }
      const framing=.95/Math.max(.95,projectedExtent);
      use(scene);
      artTextures.forEach((t, i) => bind(t, i === 3 ? 5 : i));
      bind(near.t, 3);
      bind(wide.t, 4);
      gl.uniform2f(
        sceneU.view,
        sinYaw * 0.65,
        sinPitch * 0.65,
      );
      gl.uniform1f(sceneU.power, strength);
      gl.uniform1f(sceneU.depth, depth);
      gl.uniform1f(sceneU.contourBrightness, contourBrightness);
      gl.uniform2f(pose,0,0);gl.uniform2f(fit,1,1);
      gl.uniform1f(sceneU.pass, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, emission.f);
      gl.viewport(0, 0, emission.w, emission.h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      blurPass(emission, temp, 1.2, 0);
      blurPass(temp, near, 0, 1.2);
      blurPass(near, wideTemp, 5, 0);
      blurPass(wideTemp, wide, 0, 2.5);
      use(scene);
      artTextures.forEach((t, i) => bind(t, i === 3 ? 5 : i));
      bind(near.t, 3);
      bind(wide.t, 4);
      gl.uniform2f(pose,pitch,yaw);gl.uniform2f(fit,fitX*framing,fitY*framing);
      gl.uniform1f(sceneU.pass, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      frames.forEach((f) => gl.deleteFramebuffer(f));
      textures.forEach((t) => gl.deleteTexture(t));
      shaders.forEach((s) => gl.deleteShader(s));
      programs.forEach((p) => gl.deleteProgram(p));
      gl.deleteBuffer(buffer);
    },
  };
}


module.exports={createCardRenderer};
