import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const label=n=>t.isIdentifier(n)?n.name:t.isMemberExpression(n)?[label(n.object),n.computed&&!t.isStringLiteral(n.property)?null:n.property.name??n.property.value].filter(Boolean).join('.'):null;

const rules=[
  ['browser','Browser and operating system','Reads the browser identification text or operating-system label. This does not reveal your files.',/(^|\.)(userAgent|appVersion|platform|vendor)$/],
  ['language','Language preferences','Reads browser language preferences.',/(^|\.)(language|languages)$/],
  ['screen','Screen and window size','Checks screen size, window size, or pixel density.',/(^|\.)(screen\.(width|height|availWidth|availHeight|colorDepth|pixelDepth)|innerWidth|innerHeight|devicePixelRatio)$/],
  ['hardware','Device capabilities','Checks reported CPU cores, memory, or touch support.',/(^|\.)(hardwareConcurrency|deviceMemory|maxTouchPoints)$/],
  ['cookies','Cookies','Reads a page cookie string.',/(^|\.)document\.cookie$/],
  ['storage','Saved website values','Reads or changes website storage. The key is shown in the source excerpt.',/(^|\.)(localStorage|sessionStorage)\.(getItem|setItem|removeItem|clear)$/],
  ['page','Page address and previous page','Reads the page address, URL parts, or referrer.',/(^|\.)(location\.(href|origin|pathname|search|hash|hostname|host)|document\.(URL|referrer))$/],
  ['timing','Loading and timing information','Checks browser timing or resource-loading information.',/(^|\.)(performance\.(now|getEntries|getEntriesByType|timeOrigin))$/],
  ['checks','Automation and browser checks','Looks for properties sometimes used to detect automation or browser features. The access alone does not prove why it is used.',/(^|\.)(webdriver|plugins|documentMode|connection|selenium|driver)$/],
  ['graphics','Graphics and media support','Checks graphics or media capabilities. Such checks can contribute to a device fingerprint, but intent is not established.',/(^|\.)(getContext|toDataURL|canPlayType|speechSynthesis|AudioContext|WebGLRenderingContext)$/],
  ['permissions','Location, camera, microphone, or clipboard checks','Contains code that checks or requests a browser capability. This analysis does not make those requests.',/(^|\.)(geolocation|getCurrentPosition|watchPosition|getUserMedia|readText|permissions\.query)$/],
  ['pointer','Pointer and touch coordinates','Contains coordinate reads from mouse or touch events.',/^event\..*\.(pageX|pageY|clientX|clientY|touches|changedTouches|movementX|movementY)$/],
  ['keyboard','Keyboard input','Contains key or key-code reads.',/^event\..*\.(key|code|keyCode|which)$/]
];
function category(event){
  if(event.kind==='permission')return rules.find(r=>r[0]==='permissions');
  if(event.kind==='network')return ['network','Requests to servers','Tries to contact an address. The VM records the attempt and blocks the real request.'];
  if(event.kind==='message')return ['messages','Messages to other frames','Tries to send a message to a page or embedded frame. No real frame is loaded.'];
  if(event.kind==='listener'&&/mouse|pointer|touch|key/.test(event.detail))return ['listeners','Listening for your interactions','Registers callbacks for mouse, touch, or keyboard events. Registration alone does not mean values were collected.'];
  if(!['read','storage','probe','undefined-property'].includes(event.kind))return null;
  return rules.find(r=>r[3].test(event.target))??null;
}
function friendlyAccess(event){
  const field=event.target.split('.').at(-1);
  const names={userAgent:'Browser identification',platform:'Operating-system label',language:'Preferred language',languages:'Preferred languages',hardwareConcurrency:'Reported CPU cores',deviceMemory:'Reported device memory',webdriver:'Automation flag',plugins:'Browser plugins',pageX:'Horizontal page position',pageY:'Vertical page position',clientX:'Horizontal window position',clientY:'Vertical window position',touches:'Active touch positions',changedTouches:'Changed touch positions',key:'Pressed key',code:'Physical key code',keyCode:'Numeric key code',which:'Numeric input code',cookie:'Website cookie string',referrer:'Previous page address',href:'Current page address',getContext:'Graphics support check',canPlayType:'Media support check'};
  if(event.kind==='listener')return 'Register '+event.detail+' listener';
  if(event.kind==='storage')return (field==='getItem'?'Read saved value':field==='setItem'?'Save a value':'Change saved values')+(event.detail?' · '+event.detail:'');
  if(event.kind==='network')return 'Server request · '+event.target;
  return (names[field]??event.target)+(event.detail?' · test value: '+event.detail:'');
}
function readableSites(sources){
  const sites=[];
  for(const {file,code} of sources){const ast=parse(code,{sourceType:'unambiguous'});
    traverse(ast,{MemberExpression(p){const access=label(p.node);if(!access)return;
      const rule=rules.find(r=>r[3].test(access));if(!rule)return;
      // Preserve actual syntax. A nearby readable occurrence is not asserted
      // to be the same runtime invocation as the stack-derived source.
      const operation=p.parentPath.isCallExpression()&&p.parentPath.node.callee===p.node?p.parentPath.node:p.node;
      const text=generate(operation,{comments:false}).code;
      if(text.length<1500)sites.push({category:rule[0],access,file,line:operation.loc.start.line,column:operation.loc.start.column+1,code:text,basis:'Readable code occurrence; not an exact runtime mapping.'});
    }});
  }
  return sites;
}
export function buildInformation(trace,sources=[]) {
  const cards=new Map(),sites=readableSites(sources);
  for(const event of trace?.events??[]){const rule=category(event);if(!rule)continue;
    const [id,title,explanation]=rule;
    if(!cards.has(id))cards.set(id,{id:'info-'+id,title,explanation,status:'observed',observations:0,accesses:[],evidence:[],readable:[]});
    const card=cards.get(id);card.observations++;
    const detail=event.target+(event.detail?' — '+event.detail:'');if(!card.accesses.includes(detail)&&card.accesses.length<8)card.accesses.push(detail);
    const duplicate=card.evidence.some(e=>e.kind===event.kind&&e.target===event.target&&e.source?.line===event.source?.line&&e.source?.column===event.source?.column);
    if(!duplicate&&card.evidence.length<32)card.evidence.push({step:event.step,kind:event.kind,target:event.target,detail:event.detail,label:friendlyAccess(event),source:event.source??null});
  }
  for(const site of sites){
    const rule=rules.find(r=>r[0]===site.category);
    if(!cards.has(site.category))cards.set(site.category,{id:'info-'+site.category,title:rule[1],explanation:rule[2],status:'code-only',observations:0,accesses:[],evidence:[],readable:[]});
    const card=cards.get(site.category);
    if(card.readable.length<6&&!card.readable.some(s=>s.file===site.file&&s.line===site.line&&s.column===site.column))card.readable.push(site);
  }
  return {intro:'Click a card to see its source expression. These are static code matches; input is not executed.',
    scope:'Static inspection does not establish runtime values. Reading a value does not, by itself, prove that the script stored it or sent it to a server.',
    cards:[...cards.values()].sort((a,b)=>(a.status==='code-only')-(b.status==='code-only'))};
}
