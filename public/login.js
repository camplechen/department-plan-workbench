const form=document.querySelector('#login-form'),error=document.querySelector('#login-error');
form.onsubmit=async event=>{
 event.preventDefault();const button=form.querySelector('button');button.disabled=true;error.textContent='';
 try {
  const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
  const result=await response.json();if(!response.ok)throw Error(result.error||'登录失败');
  form.reset();location.replace('/');
 }catch(reason){error.textContent=reason.message==='Failed to fetch'?'连接失败，请确认服务已启动后重试。':reason.message;}
 finally{button.disabled=false;}
};
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
