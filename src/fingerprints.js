import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {createHash} from 'node:crypto';
const traverse=traverseModule.default??traverseModule;
// These are evidence categories, not claims about a script's intention.
export const fingerprintCategories=[
 ['canvas','Canvas drawing and image output','Drawing commands and reading rendered pixels can contribute to a graphics fingerprint.',/\.(getContext|toDataURL|toBlob|getImageData|measureText|fillText|strokeText|fillRect|drawImage)$/],
 ['webgl','WebGL and graphics-card capabilities','Queries or uses 3D rendering, GPU parameters, extensions, and shader output.',/\.(getParameter|getExtension|getSupportedExtensions|readPixels|createShader|shaderSource|compileShader|getShaderPrecisionFormat|getContext)$/],
 ['audio','Audio processing and voices','Audio processing output, sample rate, or available speech voices can vary across devices.',/(^|\.)(AudioContext|webkitAudioContext|OfflineAudioContext|webkitOfflineAudioContext|createOscillator|createAnalyser|createDynamicsCompressor|createBuffer|startRendering|getFloatFrequencyData|getByteFrequencyData|sampleRate|getVoices)$/],
 ['fonts','Fonts and text measurements','Font availability or text dimensions may reveal installed rendering capabilities.',/\.(fonts|check|measureText|font|offsetWidth|offsetHeight)$/],
 ['mouse','Mouse and pointer activity','Coordinates, buttons, pressure, movement, or timing of pointer events.',/\.(clientX|clientY|pageX|pageY|screenX|screenY|movementX|movementY|button|buttons|pressure|pointerType|isTrusted)$/],
 ['touch','Touch input','Touch positions, number of contacts, and touch-device capabilities.',/\.(touches|changedTouches|targetTouches|maxTouchPoints|radiusX|radiusY|force)$/],
 ['keyboard','Keyboard input','Key values, physical key codes, and modifier keys.',/\.(key|code|keyCode|charCode|which|altKey|ctrlKey|metaKey|shiftKey)$/],
 ['display','Screen and window dimensions','Resolution, available screen size, color depth, zoom indicators, and orientation.',/(^|\.)(screen\.(width|height|availWidth|availHeight|availLeft|availTop|colorDepth|pixelDepth|orientation)|innerWidth|innerHeight|outerWidth|outerHeight|devicePixelRatio|matchMedia)$/],
 ['browser','Browser and operating system','Browser identification strings and client hints.',/(^|\.)(userAgent|appVersion|appName|platform|vendor|product|productSub|userAgentData|getHighEntropyValues)$/],
 ['language','Languages','Language preferences configured in the browser.',/\.(language|languages)$/],
 ['timezone','Timezone and clock','Timezone, locale settings, and timezone offsets.',/(^|\.)(getTimezoneOffset|resolvedOptions|DateTimeFormat|timeZone)$/],
 ['hardware','CPU, memory, and device capabilities','Reported processor count and approximate memory. These are browser reports, not access to files.',/\.(hardwareConcurrency|deviceMemory|memory|totalJSHeapSize|usedJSHeapSize|jsHeapSizeLimit)$/],
 ['plugins','Plugins and MIME types','Lists or checks browser plugins and supported MIME types.',/\.(plugins|mimeTypes)$/],
 ['cookies','Cookies','Reads, checks, or changes website cookie data.',/\.(cookie|cookieEnabled)$/],
 ['storage','Website storage','Local/session storage and IndexedDB. Access does not imply a saved identifier.',/(^|\.)(localStorage|sessionStorage|indexedDB)(\.(getItem|setItem|removeItem|clear|open|deleteDatabase))?$/],
 ['page','Page address and referrer','Current address, previous page, and page state.',/(^|\.)(location\.(href|origin|pathname|search|hash|hostname|host|protocol)|document\.(URL|documentURI|referrer|visibilityState|hidden|title))$/],
 ['timing','Performance and event timing','Loading timings, high-resolution timers, or event timestamps.',/(^|\.)(performance\.(now|getEntries|getEntriesByType|getEntriesByName|timeOrigin|timing|navigation)|timeStamp)$/],
 ['automation','Automation and browser environment checks','Properties sometimes associated with automation, plus environment feature checks.',/(^|\.)(webdriver|selenium|__webdriver_script_fn|callPhantom|_phantom|domAutomation|domAutomationController|documentMode)$/],
 ['connection','Connection characteristics','Connection type, speed estimate, data-saving settings, or online state.',/\.(connection|mozConnection|webkitConnection|effectiveType|downlink|rtt|saveData|onLine)$/],
 ['webrtc','WebRTC and ICE candidates','Peer connections and candidate addresses. Presence alone does not prove an address was obtained.',/(^|\.)(RTCPeerConnection|webkitRTCPeerConnection|mozRTCPeerConnection|createOffer|createDataChannel|setLocalDescription|onicecandidate|candidate)$/],
 ['media','Media formats and devices','Audio/video support or lists of media devices.',/\.(canPlayType|isTypeSupported|enumerateDevices|mediaDevices|mediaCapabilities|decodingInfo)$/],
 ['battery','Battery status','Battery level, charging state, or estimates.',/\.(getBattery|charging|chargingTime|dischargingTime)$/],
 ['location','Location requests','Geolocation permission and position requests.',/\.(geolocation|getCurrentPosition|watchPosition)$/],
 ['camera-microphone','Camera and microphone requests','Contains media-capture API calls. Static analysis does not execute these calls.',/\.(getUserMedia|getDisplayMedia)$/],
 ['clipboard','Clipboard','Checks or requests clipboard data. The simulation uses a denying stub.',/\.(clipboard|readText)$/],
 ['permissions','Permission state','Queries browser permission state.',/\.permissions\.query$/],
 ['sensors','Motion and orientation sensors','Sensor constructors or motion/orientation event fields.',/(^|\.)(Accelerometer|Gyroscope|Magnetometer|AbsoluteOrientationSensor|RelativeOrientationSensor|acceleration|accelerationIncludingGravity|rotationRate|alpha|beta|gamma)$/],
 ['network','Network requests','Outbound request or connection sites; a call site alone does not establish the data sent.',/(^|\.)(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)$/],
 ['messages','Messages between frames','Messages exchanged with embedded pages.',/\.postMessage$/]
].map(([id,title,explanation,pattern])=>({id,title,explanation,pattern}));
const member=n=>t.isIdentifier(n)?n.name:t.isMemberExpression(n)||t.isOptionalMemberExpression(n)?[member(n.object),!n.computed&&t.isIdentifier(n.property)?n.property.name:t.isStringLiteral(n.property)?n.property.value:'[computed]'].join('.'):t.isCallExpression(n)?member(n.callee)+'()':'';
function matches(access,node){
 return fingerprintCategories.filter(c=>{
   if(!c.pattern.test(access))return false;
   // getContext distinguishes 2D from WebGL by its literal argument.
   if(access.endsWith('.getContext')){const arg=node?.arguments?.[0];if(t.isStringLiteral(arg))return c.id==='webgl'?/webgl|experimental-webgl/.test(arg.value):arg.value==='2d';}
   // Avoid generic check() methods being reported as font probes.
   if(c.id==='fonts'&&access.endsWith('.check'))return /\.fonts\.check$/.test(access);
   return true;
 });
}
function excerpt(sourceLines,node,file){
 const start=node.loc.start.line,end=node.loc.end.line;
 const rows=sourceLines.slice(start-1,end);
 const truncated=rows.length>80||rows.join('\n').length>16000;
 const shown=rows.slice(0,80).join('\n').slice(0,16000);
 return {file,line:start,column:node.loc.start.column+1,endLine:end,endColumn:node.loc.end.column+1,
   code:shown,numberedCode:shown.split('\n').map((text,i)=>`${start+i}: ${text}`).join('\n'),truncated,
   basis:'Exact lines in the complete cleaned file. Static recognition does not prove execution or collection.'};
}
function operation(p){
 if(p.isCallExpression()||p.isNewExpression()||p.isOptionalCallExpression())return /\.(getCurrentPosition|watchPosition|getUserMedia|getDisplayMedia|readText|query)$/.test(member(p.node.callee))?'request':'call';
 if(p.parentPath.isAssignmentExpression()&&p.parentPath.node.left===p.node)return 'write';
 if(p.parentPath.isUpdateExpression())return 'read-and-write';
 if(p.parentPath.isUnaryExpression({operator:'typeof'}))return 'feature-check';
 return 'read-or-reference';
}
export function buildFingerprints(code,trace,{file='src/full-human-readable.js',input='',browserTrace}={}){
 const ast=parse(code,{sourceType:'unambiguous'}),sourceLines=code.split('\n'),findings=[],unresolved=[];let members=0;
 const seen=new Set();
 function record(p,node,access){
   const categories=matches(access,node);if(!categories.length)return;
   const key=node.start+':'+access;if(seen.has(key))return;seen.add(key);
   const root=access.split('.')[0],binding=p.scope.getBinding(root);
   const explicit=/^(navigator|screen|document|window|globalThis|performance|location|localStorage|sessionStorage|indexedDB|Intl)\./.test(access)||!binding&&/^(AudioContext|OfflineAudioContext|RTCPeerConnection|fetch|XMLHttpRequest|WebSocket|EventSource)$/.test(access);
   findings.push({id:'fp-'+(findings.length+1),categories:categories.map(c=>c.id),access,operation:operation(p),
     confidence:explicit&&!binding?'recognized-browser-api':'possible-signal-by-property-name',
     explanation:explicit&&!binding?'Recognized browser API syntax. Execution and transmission are not inferred.':'Receiver may be an alias or an unrelated object. Check the surrounding code.',
     source:excerpt(sourceLines,node,file)});
 }
 traverse(ast,{
   'CallExpression|OptionalCallExpression|NewExpression'(p){record(p,p.node,member(p.node.callee));
     const event=p.node.arguments?.[0];if(member(p.node.callee).endsWith('.addEventListener')&&t.isStringLiteral(event)&&/mouse|pointer|touch|key|deviceorientation|devicemotion/.test(event.value)){
       const cat=/touch/.test(event.value)?'touch':/key/.test(event.value)?'keyboard':/device/.test(event.value)?'sensors':'mouse';
       findings.push({id:'fp-'+(findings.length+1),categories:[cat],access:member(p.node.callee)+'('+JSON.stringify(event.value)+')',operation:'register-listener',confidence:'recognized-event-registration',explanation:'Registers a handler. This does not prove the handler reads or saves event data.',source:excerpt(sourceLines,p.node,file)});
     }
   },
   'MemberExpression|OptionalMemberExpression'(p){members++;const access=member(p.node);
     if(p.node.computed&&!t.isStringLiteral(p.node.property)&&!t.isNumericLiteral(p.node.property))unresolved.push({file,line:p.node.loc.start.line,column:p.node.loc.start.column+1,access,reason:'Computed property cannot be identified by this inventory.'});
     if((p.parentPath.isCallExpression()||p.parentPath.isNewExpression()||p.parentPath.isOptionalCallExpression())&&p.parentPath.node.callee===p.node)return;
     record(p,p.node,access);
   },
   ReferencedIdentifier(p){if(p.parentPath.isMemberExpression()||p.parentPath.isOptionalMemberExpression()||p.parentPath.isCallExpression()||p.parentPath.isNewExpression())return;record(p,p.node,p.node.name);}
 });
 const observations=[];
 for(const event of trace?.events??[]){const categories=matches(event.target??'',null).map(c=>c.id);
   if(event.kind==='network'&&!categories.includes('network'))categories.push('network');
   if(event.kind==='message'&&!categories.includes('messages'))categories.push('messages');
   if(event.kind==='listener'&&/mouse|pointer|touch|key|deviceorientation|devicemotion/.test(event.detail??''))categories.push(/touch/.test(event.detail)?'touch':/key/.test(event.detail)?'keyboard':/device/.test(event.detail)?'sensors':'mouse');
   if(!categories.length)continue;
   observations.push({id:'observed-'+(observations.length+1),categories:[...new Set(categories)],step:event.step,kind:event.kind,access:event.target,detail:event.detail,source:event.source??null,
     basis:'Observed in a bounded simulation with invented values. Runtime source is separate from cleaned-source findings.'});
 }
 const inventory={version:1,inputSha256:createHash('sha256').update(input).digest('hex'),cleanedSha256:createHash('sha256').update(code).digest('hex'),
   scope:'All recognized occurrences in the complete cleaned program and all matching events retained by this run. Reads, listeners, writes, and requests are evidence of different operations; none establishes that a value was transmitted.',
   coverage:{staticMemberSites:members,recognizedSites:findings.length,unresolvedComputedSites:unresolved.length,traceRun:!!trace,traceEvents:trace?.events?.length??0,traceDropped:trace?.dropped??0,traceErrors:trace?.errors??[],
     limits:['Property-name matches can be unrelated objects.','Aliases, encrypted keys, arbitrary VM bytecode, and code fetched later can hide additional signals.','Static analysis does not provide runtime GPU, canvas, audio, device, or network results.','No data-flow proof links reads to outbound payloads. Not detected does not mean absent.']},
   categories:fingerprintCategories.map(({pattern,...category})=>({...category,staticSites:findings.filter(f=>f.categories.includes(category.id)).length,observedEvents:observations.filter(f=>f.categories.includes(category.id)).length,
     status:observations.some(f=>f.categories.includes(category.id))?'observed-in-simulation':findings.some(f=>f.categories.includes(category.id))?'found-in-code':'not-detected'})),findings,observations,unresolved};
 const browserObservations=[];
 for(const e of browserTrace?.events??[]){const categories=matches(e.target??'',null).map(c=>c.id);
   if(['request','request-body','websocket-send','response','response-body','websocket-receive'].includes(e.kind))categories.push('network');
   if(e.kind==='storage')categories.push('storage');
   if(!categories.length)continue;
   browserObservations.push({id:'browser-'+(browserObservations.length+1),categories:[...new Set(categories)],step:e.step,kind:e.kind,access:e.target,data:e.data,source:e.source??null,
     basis:'Observed in the real analysis browser with instrumentation. This is separate from the synthetic QuickJS run and from static matches.'});
 }
 inventory.browserObservations=browserObservations;
 inventory.coverage.browser={run:!!browserTrace,events:browserTrace?.events.length??0,dropped:browserTrace?.dropped??0,errors:browserTrace?.errors??[],internet:browserTrace?.internet??false};
 for(const category of inventory.categories){category.browserEvents=browserObservations.filter(e=>e.categories.includes(category.id)).length;if(category.browserEvents)category.status='observed-in-browser';}
 // A reading artifact, never a runnable copy of submitted operations.
 const lines=['// Fingerprint evidence. Excerpts are strings; importing this file does not run the submitted program.',
   '// Each source.line refers to the named source file. readingFile.line refers to this evidence file.','export const findings = ['];
 for(const finding of findings){finding.readingFile={file:'src/fingerprint-collection.js',line:lines.length+1};
   lines.push('  {','    id: '+JSON.stringify(finding.id)+',','    access: '+JSON.stringify(finding.access)+',','    categories: '+JSON.stringify(finding.categories)+',','    operation: '+JSON.stringify(finding.operation)+',','    confidence: '+JSON.stringify(finding.confidence)+',',
     '    sourceFile: '+JSON.stringify(finding.source.file)+',','    sourceLine: '+finding.source.line+',','    sourceColumn: '+finding.source.column+',','    sourceLines: [');
   for(const [i,row] of finding.source.code.split('\n').entries())lines.push('      '+JSON.stringify(`${finding.source.line+i}: ${row}`)+',');
   lines.push('    ],','    truncated: '+finding.source.truncated, '  },');
 }
 lines.push('];','export const observations = [');
 for(const observation of observations){observation.readingFile={file:'src/fingerprint-collection.js',line:lines.length+1};lines.push('  '+JSON.stringify(observation)+',');}
 lines.push('];','export const browserObservations = [');
 for(const observation of browserObservations){observation.readingFile={file:'src/fingerprint-collection.js',line:lines.length+1};lines.push('  '+JSON.stringify(observation)+',');}
 lines.push('];','export default { findings, observations, browserObservations };','');
 return {inventory,code:lines.join('\n')};
}
