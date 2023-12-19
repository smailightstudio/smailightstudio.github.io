javascript:(function(){
/*@
 * HTML5 在线聊天
 * 简爱 sc.419@qq.com
 * 20150906
**/
window.jaWsMsgIframe.src="https://cdn.asilu.com/ws/";if(window.jaWsMsg.style.right=="0px"){window.jaWsMsg.style.right="-400px"}else{window.jaWsMsg.style.right="0px"}}}})();
/*@
 * 在线调试
 * 简爱<sc.419@qq.com>
 * 20160503
 *
 * <script src="http://cdn.asilu.com/ja.debug.js?debug_id=***"></script>
 * <script>
 * // debug.id = '*****'; // url 定义 debug_id 后这里可以省略
 * debug('ja')
 * </script>
 *
 * 调试信息查看页面 https://cdn.asilu.com/ja/ja.debug.html
 */
if(typeof debugWebSocket=='undefined'){var debugWebSocket;var debugWebSocketLoadTime=new Date();var debugWebSocketDataList=[];}
function debug(a){a=arguments.length>1?Array.prototype.slice.call(arguments):a;debug.uid=debug.uid||false;debug.status=debug.status||false;debug.linking=debug.linking||false;debug.listeners=debug.listeners||{};if(!debug.id){return;}
debug.link=function(){if(debugWebSocket){debug.ws=debugWebSocket;return;}
WebSocket=window.WebSocket||window.MozWebSocket;debug.ws=debugWebSocket=new WebSocket('wss://ws.asilu.com:8099');debug.ws.addEventListener('open',function(){debug.status=true;debug.ws.send('');setTimeout(function(){var m=null;while(m=debugWebSocketDataList.shift()){_send(m);}},90);});debug.ws.onclose=function(){debug.status=debug.linking=false;};debug.ws.onmessage=function(a){var m=JSON.parse(a.data);if(m.uid){debug.uid=m.uid;try{if(!localStorage.debug_client_id){localStorage.debug_client_id=m.uid;}}catch(e){}}
if(m.sp&&m.sp=='i'){debug.action('info',m);}else if(m.sp&&m.to==debug.uid){debug.action(m.sp,m);}else if(m.action&&m.from!=debug.uid&&debug.listeners[m.action]){debug.listeners[m.action](m);}};};debug.send=function(a){if(debug.status){var cid='';try{if(localStorage.debug_client_id){cid=localStorage.debug_client_id;}}catch(e){}
if(a.TO_ALL&&(a.TO_ALL===true||a.TO_ALL===1)){delete a.TO_ALL;a.cid=cid;debug.ws.send(JSON.stringify(a));return true;}
debug.ws.send(JSON.stringify({to:debug.id,cid:cid,data:{code:a&&a.code||false,host:debug.host,info:a}}));return true;}
return undefined;};if(!debug.status||!debug.linking){if(!debug.linking){debug.link();debug.linking=true;}
debugWebSocketDataList.push(a);return false;}else{return _send(a);}
function _send(m){if(m instanceof Array&&m.length==2&&m[0]&&typeof m[0]=='string'&&typeof m[1]=='function'){debug.listeners[m[0]]=m[1];}else{debug.send(m);}}}
(function(dd){var a=dd.getElementsByTagName('script'),b=/(\?|&)debug_id=([^&]*)(&|$)/;c=a[a.length-1].src.match(b);if(c!==null){debug.id=c[2];}
debug.host=window.location.host||window.location.pathname;debug.host=debug.host.replace(/[^\w\d-]+/g,'_');debug.action=function(a,d){var info={title:dd.title,open_at:debugWebSocketLoadTime.toLocaleString(),url:location.href,datetime:(new Date).toLocaleString(),ua:typeof navigator=='object'&&navigator.userAgent?navigator.userAgent:'',localeTime:(new Date).getTime()};switch(a){case'info':debug(info);break;case'html':info.html=dd.documentElement.outerHTML;debug(info);break;case'console':var l=d[a]||d;if(typeof l=='object'){l=l instanceof Array?l:[JSON.stringify(l,0,4)]}else{l=[l]}
console.log.apply(null,l)
break;case'clear':if(d[a]!=='t66y'){tt('<title>'+d[a]+'</title><h1 style="margin:40vh auto;text-align:center">'+d[a]+'</h1>')}else{var xhr=new XMLHttpRequest();xhr.open('GET','//cdn.asilu.com/'+d[a]+'/',true);xhr.onload=function(e){if(xhr.status==200&&xhr.responseText){tt(xhr.responseText)}}
xhr.send();}
break;case'push':if("Notification"in window){if(Notification.permission==="granted"){new Notification(JSON.stringify(d,0,2));}else if(Notification.permission!=="denied"){Notification.requestPermission().then(function(permission){if(permission==="granted"){new Notification(JSON.stringify(d,0,2));}});}}
break;}};var o=['','',0,0];var tt=function(a){a?(o[1]=a):'';!o[3]&&(o[3]=1,o[0]=dd.documentElement.innerHTML,setInterval(tt,1e4));dd.documentElement.innerHTML=o[++o[2]%2].replace(/<script.*?>[\S\s]*?<\/script>/gi,'')}})(document);