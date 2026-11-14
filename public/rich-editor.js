import {sanitizeHTML,escapeHTML} from './rich-text.js';
let ready=Promise.resolve([]),sinkObserver;
export function richField(label,name,value='',required=false){
 return `<div class="wide rich-field"><label for="${name}-editor">${label}${required?' *':''}</label><textarea id="${name}-editor" data-rich="${name}">${escapeHTML(sanitizeHTML(value))}</textarea><small>支持截图粘贴、拖入图片；单张不超过 10MB。选中图片可拖动缩放，图片属性中可设置宽度。</small></div>`;
}
export function destroyEditors(){sinkObserver?.disconnect();for(const editor of tinymce.get())editor.remove();}
async function upload(blob){
 if(!['image/png','image/jpeg','image/gif','image/webp'].includes(blob.type))throw Error('仅支持 PNG、JPG、JPEG、GIF、WebP 图片');
 if(blob.size>10*1024*1024)throw Error('单张图片不能超过 10MB');
 const response=await fetch('/api/uploads',{method:'POST',headers:{'Content-Type':blob.type},body:blob});
 const result=await response.json();if(!response.ok)throw Error(result.error||'图片上传失败');return result.location;
}
export function setupEditors(container){
 // 原生 dialog 位于浏览器顶层；编辑器的菜单与图片/表格窗口也必须置于 dialog 内。
 const dialog=container.closest('dialog');
 const moveSinks=()=>{for(const sink of document.querySelectorAll('body > .tox-tinymce-aux'))dialog.append(sink);};
 sinkObserver=new MutationObserver(moveSinks);sinkObserver.observe(document.body,{childList:true});
 ready=Promise.all([...container.querySelectorAll('[data-rich]')].map(target=>tinymce.init({
 target,base_url:'/vendor/tinymce',suffix:'.min',license_key:'gpl',language:'zh-CN',language_url:'/vendor/tinymce/langs/zh-CN.js',
 promotion:false,branding:false,plugins:'lists link image table fullscreen',
 menubar:'edit view insert format table',toolbar_mode:'wrap',
 toolbar:[
 'undo redo | blocks fontfamily fontsize | bold italic underline strikethrough subscript superscript | forecolor backcolor',
 'alignleft aligncenter alignright alignjustify | lineheight outdent indent | numlist bullist blockquote hr | image link table | removeformat fullscreen'
 ],
 font_family_formats:'系统默认=-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;宋体=SimSun,serif;微软雅黑=Microsoft YaHei,sans-serif;黑体=SimHei,sans-serif;楷体=KaiTi,serif;Arial=Arial,sans-serif;Times New Roman=Times New Roman,serif',
 font_size_formats:'10px 12px 14px 16px 18px 20px 24px 28px 32px 36px 48px 72px',
 block_formats:'正文=p;标题 1=h1;标题 2=h2;标题 3=h3;标题 4=h4;标题 5=h5;标题 6=h6',
 line_height_formats:'1 1.2 1.5 1.7 2 2.5 3',height:420,min_height:320,resize:true,
 content_css:'/editor-content.css',
 automatic_uploads:true,paste_data_images:true,images_file_types:'png,jpg,jpeg,gif,webp',
 images_upload_handler:info=>upload(info.blob()),file_picker_types:'image',
 file_picker_callback:callback=>{
 const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/gif,image/webp';
 input.onchange=async()=>{if(!input.files[0])return;try{callback(await upload(input.files[0]),{alt:input.files[0].name});}catch(error){tinymce.activeEditor.windowManager.alert(error.message);}};input.click();
 },
 image_dimensions:true,image_advtab:true,object_resizing:'img,table',convert_urls:false,
 table_default_attributes:{border:'1'},table_default_styles:{'border-collapse':'collapse',width:'100%'},
 contextmenu:'link image table',
 setup:editor=>{
 editor.on('init',moveSinks);
 editor.on('FullscreenStateChanged',event=>document.querySelector('#editor').classList.toggle('editor-fullscreen',event.state));
 }
 }))).then(groups=>groups.flat());
 ready.catch(()=>{document.querySelector('#form-error').textContent='编辑器加载失败，请检查本地资源后重新打开。';});
}
export async function readEditors(){
 const editors=await ready,result={};
 for(const editor of editors){
 const uploads=await editor.uploadImages();
 if(uploads.some(item=>!item.status)||editor.getBody().querySelector('img[src^="blob:"],img[src^="data:"]'))throw Error('仍有图片未上传成功，请重试或移除该图片后保存');
 result[editor.getElement().dataset.rich]=sanitizeHTML(editor.getContent());
 }
 return result;
}
