window.studio=function studio(root,db,{section,api,escape:e,toast,route,face,downloadCard}){
  const pages=[
    {id:'make',name:'合成闪卡',icon:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z'},
    {id:'resources',name:'卡片素材',icon:'M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M15 9h.01'},
    {id:'pools',name:'卡池与概率',icon:'M4 5h16v14H4z M8 15v-2 M12 15v-5 M16 15V8'},
    {id:'roles',name:'用户权限',icon:'M12 3l7 3v5c0 4-2.7 7.2-7 10-4.3-2.8-7-6-7-10V6l7-3z M9 12l2 2 4-4'}
  ].slice(0,db.who.role==='owner'?4:2);
  const page=pages.find(item=>item.id===section);
  const head=(name,back=false)=>`<div class="page-head studio-head"><div>${back?'<a class="studio-back" href="#studio">‹ 管理</a>':''}<h1>${name}</h1></div></div>`;
  if(!page){
    root.innerHTML=head('管理')+`<nav class="studio-menu" aria-label="管理功能">${pages.map(item=>`<a class="studio-entry" href="#studio/${item.id}"><span class="studio-entry-icon ${item.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${item.icon}"/></svg></span><span>${item.name}</span><span class="studio-entry-arrow" aria-hidden="true">›</span></a>`).join('')}</nav>`;
    return ()=>{};
  }

  const options=(xs,key='id')=>xs.map(x=>`<option value="${e(x[key])}">${e(x.name)}</option>`).join('');
  const field=(label,content)=>`<label>${label}${content}</label>`;
  const input=(name,attrs='')=>`<input name="${name}" ${attrs}>`;
  const select=(name,html)=>`<select name="${name}">${html}</select>`;
  const submit=(name,attrs='')=>`<button type="submit" class="pill" ${attrs}>${name}</button>`;
  const ratios='<option value="5x7">竖版 5:7</option><option value="7x5">横版 7:5</option><option value="1x1">方形 1:1</option>';
  const imageFile='type="file" accept="image/png,image/jpeg,image/webp"';
  const backs=db.backs||[];

  function makePage(){
    return `<div class="make-workbench">
      <form id="make-form" class="studio-card make-fields" data-act="make">
        <label class="studio-upload">中层图片（1–200 张）<span class="studio-upload-action"><span aria-hidden="true">＋</span><span class="studio-upload-text">选择图片</span></span>${input('items',imageFile+' multiple aria-label="中层图片"')}</label>
        <div class="form-row">${field('卡片比例',select('ratio',ratios))}${field('上层卡框',select('frame',''))}</div>
        <div class="form-row">${field('背景图片',select('background','<option value="">纯色背景</option>'+options(db.backgrounds,'src')))}${field('底色',input('color','type="color" value="#dfcbef"'))}</div>
        <div class="form-row">${field('卡背',select('back',''))}${field('加入卡池',select('pool','<option value="">暂不分配</option>'+options(db.pools)))}</div>
        <label class="studio-check"><input type="checkbox" name="special">稀有闪卡</label>
        ${submit('合成闪卡','disabled')}
      </form>
      <section class="studio-card composition-pane" aria-labelledby="composition-heading">
        <div class="composition-head"><h2 id="composition-heading">合成预览</h2><span class="composition-count" role="status"></span></div>
        <div class="make-previews" id="make-previews"></div>
      </section>
    </div>`;
  }
  function resourcesPage(){
    const materials=(title,rows)=>`<section class="material-group"><h2>${title}</h2>${rows.map(r=>`<div class="listrow"><img loading="lazy" src="${e(r.src)}" alt=""><span>${e(r.name)}${r.ratio?`<small>${e(r.ratio.replace('x',':'))}</small>`:''}</span>${r.id?`<button type="button" class="soft tiny danger" data-remove="${e(r.id)}">删除</button>`:''}</div>`).join('')||'<p class="studio-status">暂无素材</p>'}</section>`;
    const defaultBack={name:'默认渐变',src:'/h5/back-default.webp'};
    return `<div class="studio-resource-layout"><div class="studio-card studio-body">
      <form data-act="resource">${field('类型',select('kind','<option value="frames">卡框</option><option value="backgrounds">背景</option><option value="backs">卡背</option>'))}${field('名称',input('name','required maxlength="80"'))}${field('素材比例',select('ratio',ratios))}${field('图片',input('file',imageFile+' required'))}${submit('添加素材')}</form>
      </div><div class="studio-card studio-body studio-materials">${materials('卡背',[defaultBack,...backs])}${materials('背景',db.backgrounds)}${materials('卡框',db.frames)}</div></div>`;
  }
  function poolsPage(){
    const percent=(name,value)=>input(name,`type="number" min="0" max="100" step=".01" required value="${value/100}"`);
    return `<div class="studio-card studio-body"><form data-act="pool">${field('新卡池名称',input('name','required maxlength="80"'))}${submit('创建卡池')}</form></div>
      ${db.pools.map(p=>`<details class="studio-card" data-key="pool-${e(p.id)}"><summary>${e(p.name)}<span class="chev" aria-hidden="true">›</span></summary><div class="studio-body">
        <form data-act="rename" data-id="${e(p.id)}">${field('卡池名称',input('name',`value="${e(p.name)}" required maxlength="80"`))}${submit('保存名称')}</form>
        <form data-act="rates" data-id="${e(p.id)}"><div class="form-row">${field('普通闪卡（%）',percent('normalRate',10000-p.rareRate))}${field('稀有闪卡（%）',percent('rareRate',p.rareRate))}</div>${submit('保存概率')}</form>
        <details class="studio-card" data-key="members-${e(p.id)}" data-members="${e(p.id)}"><summary>分配卡片<span class="count-pill">${p.entries.length} / ${db.cards.length}</span><span class="chev" aria-hidden="true">›</span></summary><div class="studio-body"></div></details>
        <button type="button" class="soft tiny danger remove-pool" data-delete-pool="${e(p.id)}">删除卡池</button>
      </div></details>`).join('')}`;
  }
  function rolesPage(){
    const profiles=db.profiles.filter(p=>p.role!=='owner');
    return `<section class="studio-card studio-body">${profiles.map(p=>`<div class="listrow profile-row">
      <span>${e(p.name)}<small>${e(p.id)}</small></span>
      <div class="profile-actions">
        <button type="button" class="soft tiny" data-user="${e(p.id)}" data-role="${p.role==='maker'?'user':'maker'}">${p.role==='maker'?'移除制卡权':'授予制卡权'}</button>
        <label class="profile-download"><input type="checkbox" data-download-user="${e(p.id)}" ${p.canDownloadCards?'checked':''} aria-label="${e(p.name)}的下载互动卡权限">下载互动卡</label>
      </div></div>`).join('')||'<p class="studio-status">暂无其他用户</p>'}</section>`;
  }
  const views={make:makePage,resources:resourcesPage,pools:poolsPage,roles:rolesPage};
  root.innerHTML=head(page.name,true)+`<div class="studio studio-layout">${views[page.id]()}</div>`;
  const panel=root.querySelector('.studio');
  const make=panel.querySelector('#make-form');
  const resource=panel.querySelector('[data-act=resource]');
  const subjects=[];
  const discardSubject=s=>URL.revokeObjectURL(s.src);
  let renderPreviews,closePreview=()=>{};

  if(resource){
    const {kind,ratio}=resource.elements;
    kind.onchange=()=>ratio.closest('label').hidden=kind.value==='backgrounds';
    kind.onchange();
  }
  if(make){
    const fields=make.elements,previews=panel.querySelector('#make-previews');
    const count=panel.querySelector('.composition-count'),button=make.querySelector('button[type=submit]'),pick=make.querySelector('.studio-upload-text');
    let interactive,activeStage,activeSubject,previewTimer;
    const selectedLayer=(name,cls)=>`<img class="${cls}" data-layer="${name}" loading="lazy" alt="" hidden>`;
    const subjectImage=(s,cls)=>s?`<img class="${cls}" src="${e(s.src)}" alt="" loading="lazy">`:'';
    const sample=(name,html,modifier='')=>`<figure class="layer-sample"><div class="layer-image ${modifier}">${html}</div><figcaption>${name}</figcaption></figure>`;
    function ratioChoices(){
      const ratio=fields.ratio.value;
      fields.frame.innerHTML='<option value="">无卡框</option>'+options(db.frames.filter(r=>r.ratio===ratio),'src');
      fields.back.innerHTML='<option value="">默认渐变</option>'+options(backs.filter(r=>r.ratio===ratio),'src');
    }
    function previewName(s){return (fields.special.checked?'✦ ':'')+s.name.trim();}
    function compose(s){
      return {name:s.name.trim(),subject:s.src,ratio:fields.ratio.value,color:fields.color.value,
        frame:fields.frame.value,background:fields.background.value,back:fields.back.value,special:fields.special.checked};
    }
    closePreview=()=>{
      clearTimeout(previewTimer);
      if(!interactive)return;
      interactive.dispose();
      activeStage.querySelector('.composition-viewport').remove();
      activeStage.removeAttribute('data-interactive');
      interactive=activeStage=activeSubject=null;
    };
    function openPreview(stage){
      if(stage===activeStage)return;
      closePreview();
      activeStage=stage;activeSubject=subjects[+stage.dataset.previewIndex];
      const viewport=document.createElement('div');
      viewport.className='composition-viewport viewer';
      viewport.innerHTML='<canvas aria-label="可转动的闪卡预览"></canvas>';
      stage.append(viewport);
      interactive=window.motion.viewer(viewport,compose(activeSubject),{preview:true,
        onReady:()=>stage.setAttribute('data-interactive',''),onError:err=>toast(err.message)});
    }
    function syncPreview(){
      if(!interactive)return;
      clearTimeout(previewTimer);
      previewTimer=setTimeout(()=>interactive.update(compose(activeSubject)),100);
    }
    function syncLayers(){
      const aspect=CardEngine.dimensions(fields.ratio.value);
      previews.style.setProperty('--ratio',aspect);
      previews.style.setProperty('--color',fields.color.value);
      previews.style.setProperty('--print-size',Math.min(9.5,9/aspect)+'cqw');
      for(const key of ['frame','background']){
        const src=fields[key].value;
        for(const layer of previews.querySelectorAll(`[data-layer="${key}"]`)){
          if(src&&layer.getAttribute('src')!==src)layer.src=src;
          layer.hidden=!src;
        }
      }
      previews.querySelectorAll('.composition-name').forEach((name,i)=>name.textContent=previewName(subjects[i]));
      syncPreview();
    }
    renderPreviews=()=>{
      const previous=activeSubject;
      closePreview();
      button.disabled=!subjects.length;
      pick.textContent=subjects.length?'继续添加':'选择图片';
      count.textContent=subjects.length?`${subjects.length} 张`:'';
      previews.toggleAttribute('data-multiple',subjects.length>1);
      previews.innerHTML=(subjects.length?subjects:[null]).map((s,i)=>`<article class="make-preview">
        <div class="composition-stage" ${s?`data-preview-index="${i}"`:''}><div class="card-face composition-card" role="img" aria-label="${s?'卡片合成效果':'图层合成效果'}">
          ${selectedLayer('background','bg')}${subjectImage(s,'subject')}${selectedLayer('frame','frame')}${s?'<span class="composition-name"></span>':''}
        </div></div>
        ${s?`<div class="composition-actions"><button type="button" class="soft tiny composition-flip">翻面</button>${db.who.canDownloadCards?`<button type="button" class="soft tiny download-card" data-download-index="${i}">下载互动卡</button>`:''}</div>`:''}
        <div class="composition-layers">
          ${sample('上层卡框',selectedLayer('frame','layer-art')+'<span class="layer-empty" aria-hidden="true">—</span>')}
          ${sample('中层图片',subjectImage(s,'layer-art')||'<span class="layer-empty" aria-hidden="true">—</span>')}
          ${sample('背景',selectedLayer('background','layer-art'),'layer-bg')}
        </div>
        ${s?`<div class="composition-edit">${field('卡片名称',`<input type="text" form="make-form" data-name-index="${i}" value="${e(s.name)}" required maxlength="18">`)}<button type="button" class="soft tiny danger" data-remove-index="${i}">移除</button></div>`:''}
      </article>`).join('');
      syncLayers();
      if(subjects.length)openPreview(previews.querySelector(`[data-preview-index="${Math.max(0,subjects.indexOf(previous))}"]`));
    };
    fields.items.onchange=()=>{
      const chosen=[...fields.items.files];
      const slots=200-subjects.length;
      for(const file of chosen.slice(0,slots)){
        const name=file.name.replace(/\.[^.]+$/,'').trim().slice(0,18)||'闪卡';
        subjects.push({file,name,src:URL.createObjectURL(file)});
      }
      fields.items.value='';
      if(chosen.length>slots)toast('每次最多合成 200 张');
      renderPreviews();
    };
    fields.ratio.onchange=()=>{ratioChoices();syncLayers();};
    fields.frame.onchange=fields.background.onchange=fields.back.onchange=fields.special.onchange=fields.color.oninput=syncLayers;
    previews.oninput=event=>{
      const index=event.target.dataset.nameIndex;
      if(index===undefined)return;
      const subject=subjects[+index];
      subject.name=event.target.value;
      event.target.closest('.make-preview').querySelector('.composition-name').textContent=previewName(subject);
      if(subject===activeSubject)syncPreview();
    };
    previews.onpointerdown=event=>{
      const stage=event.target.closest('[data-preview-index]');
      if(!stage||stage===activeStage||event.button!==0||event.target.closest('button'))return;
      openPreview(stage);interactive.begin(event);
    };
    previews.onclick=event=>{
      const download=event.target.closest('[data-download-index]');
      if(download){
        const subject=subjects[+download.dataset.downloadIndex],card=compose(subject);
        if(!card.name){
          toast('请输入卡片名称');
          download.closest('.make-preview').querySelector('[data-name-index]').focus();
          return;
        }
        downloadCard(download,card,subject.file);return;
      }
      const flip=event.target.closest('.composition-flip');
      if(flip){openPreview(flip.closest('.make-preview').querySelector('[data-preview-index]'));interactive.flip();return;}
      const button=event.target.closest('[data-remove-index]');
      if(!button)return;
      const index=+button.dataset.removeIndex;
      discardSubject(subjects.splice(index,1)[0]);
      renderPreviews();
      (previews.querySelector(`[data-remove-index="${Math.min(index,subjects.length-1)}"]`)||fields.items).focus({preventScroll:true});
    };
    ratioChoices();renderPreviews();
  }

  panel.addEventListener('toggle',event=>{
    const details=event.target;
    if(!details.open||!details.dataset.members||details.dataset.loaded)return;
    const pool=db.pools.find(p=>p.id===details.dataset.members),included=new Set(pool.entries.map(entry=>entry.id));
    const members=db.cards.filter(card=>included.has(card.id));
    const tiers=new Set(members.map(card=>card.special));
    const status=tiers.size===0?'卡池暂无卡片':tiers.size===1?`仅有${members[0].special?'稀有':'普通'}闪卡，实际抽取概率为 100%`:'';
    details.querySelector('.studio-body').innerHTML=`${status?`<p class="studio-status">${status}</p>`:''}<div class="member-grid">${db.cards.map(c=>`<label class="member" data-pool="${e(pool.id)}" data-member="${e(c.id)}">
      <input type="checkbox" ${included.has(c.id)?'checked':''} aria-label="${e(c.name)}">
      <span class="m-face">${face(c,true)}</span>${c.special?'<span class="m-rare">稀有</span>':''}<span class="m-check" aria-hidden="true">✓</span><span class="m-name">${e(c.name)}</span></label>`).join('')}</div>`;
    details.dataset.loaded='true';
  },true);

  async function upload(file){const data=new FormData();data.append('file',file);return (await api('uploads','POST',data)).src;}
  let saving=false;
  async function act(run,refresh=true){
    if(saving)return;
    saving=true;panel.inert=true;
    const open=new Set([...panel.querySelectorAll('details[open]')].map(d=>d.dataset.key));
    const hash=location.hash,scroll=root.scrollTop;
    try{
      const message=await run();
      if(!panel.isConnected)return;
      toast(typeof message==='string'?message:'已保存');
      if(refresh){
        await route();
        if(location.hash!==hash)return;
        for(const details of root.querySelectorAll('.studio details'))details.open=open.has(details.dataset.key);
        requestAnimationFrame(()=>{if(location.hash===hash)root.scrollTop=scroll;});
      }
    }catch(err){toast(err.message);}
    finally{saving=false;panel.inert=false;}
  }
  panel.onsubmit=event=>{
    event.preventDefault();
    const form=event.target,action=form.dataset.act,v=new FormData(form),data=Object.fromEntries(v);
    act(async()=>{
      switch(action){
      case 'pool':return api('pools','POST',{name:data.name});
      case 'rename':return api(`pools/${form.dataset.id}/name`,'POST',{name:data.name});
      case 'rates':return api(`pools/${form.dataset.id}/rates`,'POST',{normalRate:Math.round(Number(data.normalRate)*100),rareRate:Math.round(Number(data.rareRate)*100)});
      case 'resource':
      case 'make':{
        const uploaded=[];
        try{
          if(action==='resource'){
            const src=await upload(data.file);uploaded.push(src);
            return await api('resources','POST',{kind:data.kind,ratio:data.ratio,name:data.name,src});
          }
          const items=[];
          for(const s of subjects){
            const subject=await upload(s.file);uploaded.push(subject);
            items.push({name:s.name.trim(),subject});
          }
          const {cards}=await api('cards','POST',{ratio:data.ratio,color:data.color,frame:data.frame,background:data.background,back:data.back,pool:data.pool,special:v.has('special'),items});
          if(panel.isConnected){subjects.splice(0).forEach(discardSubject);renderPreviews();}
          return `已合成 ${cards.length} 张闪卡`;
        }catch(err){await Promise.allSettled(uploaded.map(src=>api('uploads/'+src.split('/').pop(),'DELETE')));throw err;}
      }
      }
    },action!=='make');
  };
  panel.oninput=event=>{
    const t=event.target;
    if(t.form?.dataset.act==='rates'&&t.validity.valid){
      t.form.elements[t.name==='rareRate'?'normalRate':'rareRate'].value=(10000-Math.round(t.valueAsNumber*100))/100;
    }
  };
  panel.onchange=event=>{
    const t=event.target;
    if(t.dataset.downloadUser){
      const enabled=t.checked;
      act(async()=>{
        try{await api(`users/${t.dataset.downloadUser}/card-file-access`,'POST',{enabled});}
        catch(err){t.checked=!enabled;throw err;}
      },false);
      return;
    }
    const member=t.closest('[data-member]');
    if(!member)return;
    const included=t.checked;
    act(async()=>{
      try{await api(`pools/${member.dataset.pool}/member`,'POST',{card:member.dataset.member,included});}
      catch(err){t.checked=!included;throw err;}
    });
  };
  panel.onclick=event=>{
    const b=event.target.closest('button');
    if(!b)return;
    if(b.dataset.deletePool){
      const pool=db.pools.find(p=>p.id===b.dataset.deletePool);
      if(confirm(`删除「${pool.name}」？玩家已抽到的卡会保留。`))act(()=>api('pools/'+pool.id,'DELETE'));
    }
    if(b.dataset.remove&&confirm('从素材库删除这项素材？'))act(()=>api('resources/'+b.dataset.remove,'DELETE'));
    if(b.dataset.user)act(()=>api(`users/${b.dataset.user}/role`,'POST',{role:b.dataset.role}));
  };
  return ()=>{closePreview();subjects.forEach(discardSubject);};
};
