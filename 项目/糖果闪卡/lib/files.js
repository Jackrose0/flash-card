const {api}=require('./store');
function choose(count){
  return new Promise((ok,fail)=>{
    const options={count,sourceType:['album','camera'],fail:e=>/cancel/i.test(e.errMsg)?ok([]):fail(Error('选图失败'))};
    if(wx.chooseMedia)wx.chooseMedia({...options,mediaType:['image'],success:r=>ok(r.tempFiles.map(f=>f.tempFilePath))});
    else wx.chooseImage({...options,success:r=>ok(r.tempFilePaths)});
  });
}
async function keep(path){return (await api('/uploads','POST',null,path)).src;}
async function drop(src){await api('/uploads/'+src.split('/').pop(),'DELETE');}
function ask(title,placeholder='名称'){
  return new Promise(ok=>wx.showModal({title,editable:true,placeholderText:placeholder,success:r=>ok(r.confirm?(r.content||'').trim():''),
    fail:()=>ok('')}));
}
function report(e){wx.showModal({title:'操作未完成',content:e.message||e.errMsg||'请重试',showCancel:false});}
module.exports={choose,keep,drop,ask,report};
