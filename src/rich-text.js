import sanitize from 'sanitize-html';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeLink(value) {
 const url=String(value??'').trim();
 return /^(https?:\/\/|mailto:)/i.test(url)&&!/[\u0000-\u0020\u007f<>"'\\]/.test(url)?url:'';
}
export const safeImage = value => /^\/uploads\/[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp)$/.test(value||'') ? value : '';
const palette=['#223047','#3568dc','#23845b','#c75448','#ad6519','#8056b3'];
const size=/^(?:\d{1,4}(?:\.\d{1,2})?)(?:px|pt|em|rem|%)$/;
const color=/^(?:#[\da-f]{3,8}|(?:rgb|rgba)\([\d.,%\s]+\)|[a-z]{1,20})$/i;
const styles={
 color:[color], 'background-color':[color], 'font-size':[size],
 'font-family':[/^[\w\s,'"\u3400-\u9fff-]{1,200}$/],
 'text-align':[/^(left|center|right|justify)$/], 'line-height':[/^(?:[1-3](?:\.\d{1,2})?|normal|\d{1,3}(?:px|pt|%))$/],
 'font-weight':[/^(bold|normal|[1-9]00)$/], 'font-style':[/^(italic|normal)$/],
 'text-decoration':[/^(underline|line-through|underline line-through|none)$/],
 'vertical-align':[/^(sub|super|baseline|top|middle|bottom)$/],
 width:[size],height:[size], 'max-width':[/^100%$/],
 'padding-left':[/^\d{1,3}(?:px|pt)$/], 'margin-left':[/^(?:auto|\d{1,3}(?:px|pt))$/], 'margin-right':[/^(?:auto|\d{1,3}(?:px|pt))$/],
 display:[/^block$/],float:[/^(left|right|none)$/],
 'border-collapse':[/^(collapse|separate)$/], 'border-width':[/^[0-9]{1,2}px$/], 'border-style':[/^(solid|dashed|dotted|none)$/], 'border-color':[color],
 'list-style-type':[/^(disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)$/]
};
const options={
 allowedTags:['p','br','div','span','strong','b','em','i','u','s','del','sub','sup','h1','h2','h3','h4','h5','h6','ol','ul','li','blockquote','hr','a','img','table','thead','tbody','tfoot','tr','td','th','caption','colgroup','col'],
 allowedAttributes:{'*':['style'],a:['href','target','rel'],img:['src','alt','title','width','height'],td:['colspan','rowspan'],th:['colspan','rowspan','scope'],table:['border'],col:['span']},
 allowedStyles:{'*':styles},allowedSchemes:['http','https','mailto'],allowedSchemesByTag:{img:[]},allowProtocolRelative:false,
 transformTags:{
 b:'strong',i:'em',del:'s',strike:'s',font:(tag,attrs)=>({tagName:'span',attribs:{style:attrs.color?`color:${attrs.color}`:''}}),
 span:(tag,attrs)=>({tagName:tag,attribs:{...attrs,style:`${attrs.style||''}${/^rt-color-[0-5]$/.test(attrs.class||'')?`;color:${palette[Number(attrs.class.slice(-1))]}`:''}`}}),
 a:(tag,attrs)=>({tagName:tag,attribs:safeLink(attrs.href)?{href:safeLink(attrs.href),target:'_blank',rel:'noopener noreferrer'}:{}}),
 img:(tag,attrs)=>({tagName:tag,attribs:{...attrs,src:safeImage(attrs.src)}})
 },
 exclusiveFilter:frame=>frame.tag==='img'&&!safeImage(frame.attribs.src),
 nonTextTags:['script','style','textarea','option','iframe','object','svg','math','template','noscript','title','xmp','plaintext']
};
export function sanitizeHTML(value){
 const source=String(value??'').replace(/\r\n?/g,'\n');
 if(!/<\/?[a-z][\w:-]*[\s/>]/i.test(source))return `<p>${escapeHTML(source).replace(/\n/g,'<br>')}</p>`;
 const clean=sanitize(source,options).replace(/<(br|hr|img|col)([^>]*?)\s*\/>/g,'<$1$2>');
 return /<[a-z]/.test(clean)?clean:`<p>${clean}</p>`;
}
export function plainText(value){
 const html=sanitizeHTML(value).replace(/<br\s*\/?\s*>/g,'\n').replace(/<\/(p|div|h[1-6]|li|ol|ul|blockquote|tr|table)>/g,'\n').replace(/<\/(td|th)>/g,'\t');
 // 解析器负责实体解码，避免二次解码把历史纯文本中的 &lt; 变成标签。
 let text='';sanitize(html,{allowedTags:[],textFilter:value=>{text+=value;return value;},parser:{decodeEntities:true}});
 return text.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi,(m,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'}[k]??String.fromCodePoint(k[1]==='x'?parseInt(k.slice(2),16):Number(k.slice(1))))).replace(/\n{3,}/g,'\n\n').trim();
}
export const hasText=value=>plainText(value).replace(/[\s\u200b-\u200d\ufeff]/g,'').length>0;
export const hasContent=value=>hasText(value)||/<img\s/.test(sanitizeHTML(value));
