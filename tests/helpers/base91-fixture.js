// Trusted generated fixture, independent of submitted files.
export const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
export function encode91(text){
 const bytes=Buffer.from(text),out=[];let buffer=0,bits=0;
 for(const byte of bytes){buffer|=byte<<bits;bits+=8;if(bits>13){let value=buffer&8191;if(value>88){buffer>>=13;bits-=13;}else{value=buffer&16383;buffer>>=14;bits-=14;}out.push(alphabet[value%91],alphabet[Math.floor(value/91)]);}}
 if(bits){out.push(alphabet[buffer%91]);if(bits>7||buffer>90)out.push(alphabet[Math.floor(buffer/91)]);}return out.join('');
}
export function base91Fixture({before='',after='',text=['hello','✓']}={}){
 return `function run(){${before}
 var namespace=globalThis,TextDecoderAlias=namespace.TextDecoder,Uint8ArrayAlias=namespace.Uint8Array,BufferAlias=namespace.Buffer,StringAlias=namespace.String||String,ArrayAlias=namespace.Array||Array;
 var utf8Fallback=(function(){var t=new ArrayAlias(128),n=StringAlias.fromCodePoint||StringAlias.fromCharCode,e=[];return function(g){var r,i,o=g.length;e.length=0;for(var a=0;a<o;)(i=g[a++])<=127?r=i:i<=223?r=(31&i)<<6|63&g[a++]:i<=239?r=(15&i)<<12|(63&g[a++])<<6|63&g[a++]:StringAlias.fromCodePoint?r=(7&i)<<18|(63&g[a++])<<12|(63&g[a++])<<6|63&g[a++]:(r=63,a+=3),e.push(t[r]||(t[r]=n(r)));return e.join('');};})();
 function text(t){return void 0!==TextDecoderAlias&&TextDecoderAlias?new TextDecoderAlias().decode(new Uint8ArrayAlias(t)):void 0!==BufferAlias&&BufferAlias?BufferAlias.from(t).toString('utf-8'):utf8Fallback(t);}
 function decode(t){for(var n=''+(t||''),e=n.length,g=[],r=0,i=0,o=-1,a=0;a<e;a++){var c=${JSON.stringify(alphabet)}.indexOf(n[a]);if(-1!==c)if(o<0)o=c;else{r|=(o+=91*c)<<i,i+=(8191&o)>88?13:14;do{g.push(255&r),r>>=8,i-=8;}while(i>7);o=-1;}}return o>-1&&g.push(255&(r|o<<i)),text(g);}
 var cache={},table=${JSON.stringify(text.map(encode91))};function d(i){return void 0===cache[i]?cache[i]=decode(table[i]):cache[i];}
 ${after}return [d(0),d(1)];}var result=run();`;
}
