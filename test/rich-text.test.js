import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeHTML,plainText,hasText,safeLink} from '../public/rich-text.js';

test('富文本白名单保留支持的格式、安全样式和安全链接',()=>{
 const html='<h2>目标</h2><p><b>加粗</b><i>斜体</i><u>下划线</u><del>删除</del><br><font color="#3568dc">蓝色</font></p><ol><li>一</li></ol><ul><li>二</li></ul><a href="https://example.com/?a=1&amp;b=2">链接</a>';
 const clean=sanitizeHTML(html);
 assert.match(clean,/<strong>加粗<\/strong><em>斜体<\/em><u>下划线<\/u><s>删除<\/s>/);
 assert.match(clean,/<span style="color:#3568dc">蓝色<\/span>/);
 assert.match(clean,/<ol><li>一<\/li><\/ol><ul><li>二<\/li><\/ul>/);
 assert.match(clean,/href="https:\/\/example.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
 assert.equal(sanitizeHTML(clean),clean);
 for(const href of ['http://example.com','https://example.com','mailto:a@example.com'])assert.equal(safeLink(href),href);
});

test('过滤脚本、事件、外部资源、危险链接及任意外部样式',()=>{
 const attacks=[
  '<p onclick="alert(1)" style="background:url(https://example.com)">正文<img src=x onerror=alert(1)><script>alert(1)</script></p>',
  '<svg><a xlink:href="javascript:alert(1)">攻击</a></svg><math><mtext>攻击</mtext></math>',
  '<iframe src="https://example.com"></iframe><object data=x>攻击</object><style>body{display:none}</style>',
  '<a href="java&#x73;cript:alert(1)" onmouseover="alert(1)">链接</a><a href="data:text/html,x">数据</a>',
  '<a href="&#106;avascript&colon;alert(1)">链接</a><a href="https://example.com&#10;evil">换行</a>',
  '<span class="other" style="position:fixed;color:red">文字</span><input autofocus onfocus=alert(1)>',
  '<p title="a > b" onmouseover=alert(1)>文字</p><!-- 注释 --><template><img src=x></template>',
 ];
 for(const attack of attacks){const clean=sanitizeHTML(attack);assert.doesNotMatch(clean,/script|onerror|onclick|onmouseover|onfocus|autofocus|src=|position:|background:|javascript|data:|<svg|<math|<iframe|<object|<input|<template|<!--/i);assert.equal(sanitizeHTML(clean),clean);}
 assert.equal(sanitizeHTML('<span style="color: #c75448; font-size:99px">红色</span>'),'<span style="color:#c75448;font-size:99px">红色</span>');
 for(const href of ['javascript:alert(1)','data:text/html,x','//example.com','ftp://example.com','https://example.com\nfoo'])assert.equal(safeLink(href),'');
});

test('旧纯文本保留换行及特殊字符；摘要、搜索、CSV 使用纯文本',()=>{
 const old='第一行 & 交付\n第二行 < 3，字符 &lt;';
 const html=sanitizeHTML(old);
 assert.equal(plainText(html),old);assert.equal(sanitizeHTML(html),html);
 assert.equal(plainText('<h2>季度目标</h2><p><strong>交付</strong> &amp; 复盘</p><ul><li>行动一</li><li>行动二</li></ul>'),'季度目标\n交付 & 复盘\n行动一\n行动二');
 for(const empty of ['', '<p><br></p>','<div>&nbsp; \u200b</div>','<script>alert(1)</script>'])assert.equal(hasText(empty),false);
 assert.equal(hasText('<p><strong>目标</strong></p>'),true);
});

test('图文、标题、段落、表格及旧颜色数据可安全往返',()=>{
 const image='/uploads/12345678-1234-1234-1234-123456789abc.png';
 const html=`<h1>标题</h1><p style="text-align:justify;line-height:1.5;padding-left:40px"><span style="font-family:微软雅黑;font-size:24px;color:rgb(12, 34, 56);background-color:#ffee00">样式<sub>下标</sub><sup>上标</sup></span></p><blockquote>引用</blockquote><hr><p style="text-align:center"><img src="${image}" width="320" style="width:320px;display:block;margin-left:auto;margin-right:auto" alt="截图"></p><table style="border-collapse:collapse;width:100%" border="1"><tbody><tr><th>列一</th><td colspan="2">内容</td></tr></tbody></table>`;
 const clean=sanitizeHTML(html);
 for(const fragment of ['<h1>标题</h1>','text-align:justify','line-height:1.5','padding-left:40px','font-family:微软雅黑','font-size:24px','background-color:#ffee00','<sub>下标</sub>','<sup>上标</sup>','<blockquote>引用</blockquote>','<hr>',`src="${image}"`,'width="320"','margin-left:auto','<table','colspan="2"'])assert.ok(clean.includes(fragment),fragment);
 assert.equal(sanitizeHTML(clean),clean);
 assert.equal(sanitizeHTML('<span class="rt-color-4">旧橙色</span>'),'<span style="color:#ad6519">旧橙色</span>');
 assert.doesNotMatch(plainText(clean),/<|uploads\/|style=/);
 assert.match(plainText(clean),/列一\t内容/);
});

test('图片来源和 CSS 白名单阻断远程请求、路径穿越及活动内容',()=>{
 for(const src of ['data:image/png;base64,AAAA','blob:http://localhost/id','https://example.com/image.png','//example.com/i.png','/uploads/../workbench.json','/uploads/%2e%2e/test.png','javascript:alert(1)'])assert.doesNotMatch(sanitizeHTML(`<img src="${src}">`),/<img/);
 const html='<p style="position:fixed;z-index:999;background-image:url(https://example.com/a);color:expression(alert(1));font-family:url(evil);width:calc(100%);text-align:center" onclick="alert(1)">正文</p><img src="/uploads/12345678-1234-1234-1234-123456789abc.png" onerror="alert(1)"><svg><script>alert(1)</script></svg><a href="jav&#x61;script:alert(1)">链接</a>';
 const clean=sanitizeHTML(html);assert.doesNotMatch(clean,/position|z-index|url\(|expression|calc|onclick|onerror|<svg|<script|javascript/);assert.match(clean,/text-align:center/);
 assert.equal(sanitizeHTML(clean),clean);
});
